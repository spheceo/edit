//! Edit's built-in agent: Codex through `codex app-server` (JSON-RPC 2.0 over
//! newline-delimited stdio), using the user's own `codex login`.
//!
//! Edit's MCP server is injected per thread (`/mcp?project=<id>`), so a chat
//! can only touch its own project, with its tools pre-approved. The user's
//! other MCP servers, apps and plugins are switched off and the sandbox is
//! read-only: the agent edits through Edit's tools and nothing else.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::store::{now_ms, Store};

/// How long a cached model list is trusted before a background refresh.
const MODELS_TTL_MS: u64 = 24 * 3600 * 1000;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Entry {
    pub id: String,
    /// "user", "assistant", "tool", "error" or "thinking".
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Full tool arguments / error, shown when a tool row is expanded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// When it appeared and last changed (ms), for "Worked for 12s".
    #[serde(default)]
    pub at: u64,
    #[serde(default)]
    pub updated: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Chat {
    #[serde(default)]
    pub thread: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub entries: Vec<Entry>,
    #[serde(skip)]
    pub turn: Option<String>,
    #[serde(skip)]
    pub running: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Model {
    pub id: String,
    pub name: String,
    pub description: String,
    pub default_effort: String,
    pub efforts: Vec<String>,
    pub is_default: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ModelCache {
    fetched_ms: u64,
    models: Vec<Model>,
}

pub struct Agents {
    store: Arc<Store>,
    port: u16,
    dir: PathBuf,
    codex: tokio::sync::Mutex<Option<Arc<Codex>>>,
    chats: Mutex<HashMap<String, Chat>>,
    /// Codex thread id → Edit project id.
    threads: Mutex<HashMap<String, String>>,
    models: Mutex<Option<ModelCache>>,
    refreshing: AtomicBool,
    /// One-off questions (see `ask`) by Codex thread id.
    asks: Mutex<HashMap<String, Ask>>,
}

/// A one-off question's answer as it streams in.
struct Ask {
    text: String,
    done: Option<tokio::sync::oneshot::Sender<Result<String, String>>>,
}

impl Agents {
    pub fn new(store: Arc<Store>, home: PathBuf, port: u16) -> Arc<Self> {
        let dir = home.join("agent");
        let _ = std::fs::create_dir_all(&dir);
        let models = std::fs::read(dir.join("models.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        Arc::new(Self {
            store,
            port,
            dir,
            codex: tokio::sync::Mutex::new(None),
            chats: Mutex::new(HashMap::new()),
            threads: Mutex::new(HashMap::new()),
            models: Mutex::new(models),
            refreshing: AtomicBool::new(false),
            asks: Mutex::new(HashMap::new()),
        })
    }

    /// Whether Codex is installed and logged in (cheap; no app-server needed).
    /// `state` is "missing", "logged_out" or "ready".
    pub fn status(&self) -> Value {
        let Some(binary) = find_codex() else {
            return json!({ "provider": "codex", "ready": false, "state": "missing",
                "error": "Codex isn't installed. Install it with `npm install -g @openai/codex`, then `codex login`." });
        };
        let version = Command::new(&binary)
            .arg("--version")
            .stdin(Stdio::null())
            .output()
            .ok()
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .filter(|version| !version.is_empty());
        let logged_in = Command::new(&binary)
            .args(["login", "status"])
            .stdin(Stdio::null())
            .output()
            .is_ok_and(|output| output.status.success());
        let path = binary.to_string_lossy();
        if !logged_in {
            return json!({ "provider": "codex", "ready": false, "state": "logged_out", "path": path, "version": version,
                "error": "Codex isn't logged in. Run `codex login` on the machine running Edit." });
        }
        json!({ "provider": "codex", "ready": true, "state": "ready", "path": path, "version": version })
    }

    async fn codex(self: &Arc<Self>) -> Result<Arc<Codex>, String> {
        let mut slot = self.codex.lock().await;
        if let Some(codex) = slot
            .as_ref()
            .filter(|codex| codex.alive.load(Ordering::Acquire))
        {
            return Ok(Arc::clone(codex));
        }
        let this = Arc::clone(self);
        let codex = Codex::spawn(move |message| this.on_message(message))?;
        codex
            .call(
                "initialize",
                json!({ "clientInfo": { "name": "edit", "title": "Edit", "version": env!("CARGO_PKG_VERSION") } }),
                Duration::from_secs(20),
            )
            .await?;
        codex.notify("initialized", Value::Null);
        // Threads from a previous process must be resumed before new turns.
        self.threads.lock().unwrap().clear();
        *slot = Some(Arc::clone(&codex));
        Ok(codex)
    }

    // --- models ------------------------------------------------------------

    /// Cached models, refreshed in the background once a day (or now with `refresh`).
    pub async fn models(self: &Arc<Self>, refresh: bool) -> Result<Value, String> {
        let cached = self.models.lock().unwrap().clone();
        match cached {
            Some(cache) if !refresh => {
                if now_ms().saturating_sub(cache.fetched_ms) > MODELS_TTL_MS {
                    let this = Arc::clone(self);
                    tokio::spawn(async move {
                        let _ = this.fetch_models().await;
                    });
                }
                Ok(json!({ "models": cache.models, "fetched_ms": cache.fetched_ms }))
            }
            _ => {
                let cache = self.fetch_models().await?;
                Ok(json!({ "models": cache.models, "fetched_ms": cache.fetched_ms }))
            }
        }
    }

    async fn fetch_models(self: &Arc<Self>) -> Result<ModelCache, String> {
        if self.refreshing.swap(true, Ordering::AcqRel) {
            // Another refresh is in flight; serve what we have.
            if let Some(cache) = self.models.lock().unwrap().clone() {
                return Ok(cache);
            }
        }
        let result = async {
            let codex = self.codex().await?;
            let mut models = Vec::new();
            let mut cursor: Option<String> = None;
            loop {
                let page = codex
                    .call(
                        "model/list",
                        json!({ "cursor": cursor }),
                        Duration::from_secs(30),
                    )
                    .await?;
                for row in page["data"].as_array().cloned().unwrap_or_default() {
                    if row["hidden"].as_bool().unwrap_or(false) {
                        continue;
                    }
                    models.push(Model {
                        id: row["id"].as_str().unwrap_or_default().to_owned(),
                        name: row["displayName"].as_str().unwrap_or_default().to_owned(),
                        description: row["description"].as_str().unwrap_or_default().to_owned(),
                        default_effort: row["defaultReasoningEffort"]
                            .as_str()
                            .unwrap_or("medium")
                            .to_owned(),
                        efforts: row["supportedReasoningEfforts"]
                            .as_array()
                            .map(|efforts| {
                                efforts
                                    .iter()
                                    .filter_map(|effort| {
                                        effort["reasoningEffort"].as_str().map(str::to_owned)
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                        is_default: row["isDefault"].as_bool().unwrap_or(false),
                    });
                }
                cursor = page["nextCursor"].as_str().map(str::to_owned);
                if cursor.is_none() {
                    break;
                }
            }
            let cache = ModelCache {
                fetched_ms: now_ms(),
                models,
            };
            let _ = std::fs::write(
                self.dir.join("models.json"),
                serde_json::to_vec_pretty(&cache).unwrap_or_default(),
            );
            *self.models.lock().unwrap() = Some(cache.clone());
            Ok(cache)
        }
        .await;
        self.refreshing.store(false, Ordering::Release);
        result
    }

    // --- chats -------------------------------------------------------------

    /// A project's chat from disk: beside the project, or where Edit used to keep chats.
    fn load(&self, project: &str) -> Chat {
        let path = self.store.chat_path(project);
        let old = self.dir.join("chats").join(format!("{project}.json"));
        if !path.exists() && old.exists() {
            let _ = std::fs::rename(&old, &path);
        }
        let Ok(bytes) = std::fs::read(&path) else {
            return Chat::default();
        };
        serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            // Never overwrite a chat we can't read: set it aside and start fresh.
            eprintln!("agent chat {}: {error}", path.display());
            let _ = std::fs::rename(
                &path,
                path.with_extension(format!("unreadable-{}", now_ms())),
            );
            Chat::default()
        })
    }

    fn with_chat<T>(&self, project: &str, edit: impl FnOnce(&mut Chat) -> T) -> T {
        let mut chats = self.chats.lock().unwrap();
        let chat = chats
            .entry(project.to_owned())
            .or_insert_with(|| self.load(project));
        edit(chat)
    }

    fn save(&self, project: &str) {
        let snapshot = self.with_chat(project, |chat| chat.clone());
        let _ = crate::store::write_atomic(
            &self.store.chat_path(project),
            &serde_json::to_vec(&snapshot).unwrap_or_default(),
        );
    }

    pub fn chat(&self, project: &str) -> Value {
        self.with_chat(project, |chat| {
            json!({ "entries": chat.entries, "running": chat.running, "model": chat.model, "effort": chat.effort })
        })
    }

    pub fn reset(&self, project: &str) {
        self.with_chat(project, |chat| *chat = Chat::default());
        let _ = std::fs::remove_file(self.store.chat_path(project));
        self.emit(project, json!({ "event": "reset" }));
    }

    fn emit(&self, project: &str, event: Value) {
        let mut event = event;
        event["type"] = json!("agent");
        event["project"] = json!(project);
        self.store.emit(event);
    }

    fn upsert(&self, project: &str, entry: Entry) {
        let now = now_ms();
        let entry = self.with_chat(project, |chat| {
            match chat
                .entries
                .iter_mut()
                .find(|existing| existing.id == entry.id)
            {
                Some(existing) => {
                    *existing = Entry {
                        at: existing.at,
                        updated: now,
                        ..entry
                    };
                    existing.clone()
                }
                None => {
                    let entry = Entry {
                        at: now,
                        updated: now,
                        ..entry
                    };
                    chat.entries.push(entry.clone());
                    entry
                }
            }
        });
        self.emit(project, json!({ "event": "entry", "entry": entry }));
    }

    /// Sends a message, starting or resuming the project's Codex thread.
    pub async fn send(
        self: &Arc<Self>,
        project: &str,
        text: String,
        model: Option<String>,
        effort: Option<String>,
    ) -> Result<(), String> {
        let live = self.store.get(project).ok_or("no such project")?;
        if self.with_chat(project, |chat| chat.running) {
            return Err("the agent is still working; stop it or wait".to_owned());
        }
        let codex = self.codex().await?;
        let (thread, known) = self.with_chat(project, |chat| {
            chat.model = model.clone().or(chat.model.take());
            chat.effort = effort.clone().or(chat.effort.take());
            (
                chat.thread.clone(),
                chat.thread
                    .as_ref()
                    .is_some_and(|thread| self.threads.lock().unwrap().contains_key(thread)),
            )
        });
        let workspace = self.dir.join("workspace");
        let _ = std::fs::create_dir_all(&workspace);
        let config = json!({
            "mcp_servers": { "edit": {
                "url": format!("http://127.0.0.1:{}/mcp?project={project}", self.port),
                "default_tools_approval_mode": "approve",
                "startup_timeout_sec": 15,
                // caption_speakers watches footage with a model: minutes, not seconds.
                "tool_timeout_sec": 900,
            } },
        });
        let instructions = format!(
            "You are the agent built into Edit, a video editor. The user is watching the editor while you work: every change you make through the `edit` tools appears live on their timeline and can be undone with ⌘Z. \
             Edit only through the `edit` tools; you have no shell or files. The project is \"{}\" ({}x{} at {} fps). \
             Call get_project before editing and read_transcript when speech matters. After visual changes, look at your work with render_frame or contact_sheet. \
             Keep replies short: say what you changed and where (timecodes).\n\n{}",
            live.project.name, live.project.settings.width, live.project.settings.height, live.project.settings.fps,
            // The model and house style, as every MCP client gets them.
            crate::mcp::INSTRUCTIONS
        );
        let thread = match (thread, known) {
            (Some(thread), true) => thread,
            (Some(thread), false) => {
                // Edit restarted: pick the conversation back up.
                match codex
                    .call(
                        "thread/resume",
                        json!({ "threadId": thread, "config": config, "developerInstructions": instructions }),
                        Duration::from_secs(30),
                    )
                    .await
                {
                    Ok(_) => thread,
                    Err(_) => self.start_thread(&codex, &config, &instructions, &workspace).await?,
                }
            }
            (None, _) => {
                self.start_thread(&codex, &config, &instructions, &workspace)
                    .await?
            }
        };
        self.threads
            .lock()
            .unwrap()
            .insert(thread.clone(), project.to_owned());
        let (model, effort) = self.with_chat(project, |chat| {
            chat.thread = Some(thread.clone());
            chat.running = true;
            (chat.model.clone(), chat.effort.clone())
        });
        self.upsert(
            project,
            Entry {
                id: format!("user-{}", now_ms()),
                kind: "user".to_owned(),
                text: text.clone(),
                ..Entry::default()
            },
        );
        self.save(project);
        self.emit(project, json!({ "event": "status", "running": true }));
        let mut params = json!({
            "threadId": thread,
            "input": [{ "type": "text", "text": text, "text_elements": [] }],
            "approvalPolicy": "never",
        });
        if let Some(model) = model {
            params["model"] = json!(model);
        }
        if let Some(effort) = effort {
            params["effort"] = json!(effort);
        }
        match codex
            .call("turn/start", params, Duration::from_secs(30))
            .await
        {
            Ok(turn) => {
                let id = turn["turn"]["id"].as_str().map(str::to_owned);
                self.with_chat(project, |chat| chat.turn = id);
                self.save(project);
                Ok(())
            }
            Err(error) => {
                self.finish(project, Some(error.clone()));
                Err(error)
            }
        }
    }

    /// Asks a model one question through Codex, outside any chat and with no
    /// tools: text, images (`localImage`) and sound (`localAudio`) in, its
    /// final answer out, held to `schema` (a JSON Schema) when given.
    pub async fn ask(
        self: &Arc<Self>,
        model: &str,
        effort: &str,
        instructions: &str,
        input: Vec<Value>,
        schema: Option<Value>,
        timeout: Duration,
    ) -> Result<String, String> {
        let codex = self.codex().await?;
        let workspace = self.dir.join("workspace");
        let _ = std::fs::create_dir_all(&workspace);
        let started = codex
            .call(
                "thread/start",
                json!({
                    "cwd": workspace.to_string_lossy(),
                    "approvalPolicy": "never",
                    "sandbox": "read-only",
                    "ephemeral": true,
                    "developerInstructions": instructions,
                    "serviceName": "edit",
                }),
                Duration::from_secs(30),
            )
            .await?;
        let thread = started["thread"]["id"]
            .as_str()
            .ok_or("Codex didn't start a thread")?
            .to_owned();
        let (done, answer) = tokio::sync::oneshot::channel();
        self.asks.lock().unwrap().insert(
            thread.clone(),
            Ask {
                text: String::new(),
                done: Some(done),
            },
        );
        let mut params = json!({ "threadId": thread, "input": input, "model": model, "effort": effort, "approvalPolicy": "never" });
        if let Some(schema) = schema {
            params["outputSchema"] = schema;
        }
        let result = match codex
            .call("turn/start", params, Duration::from_secs(60))
            .await
        {
            Ok(_) => match tokio::time::timeout(timeout, answer).await {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err("Codex stopped".to_owned()),
                Err(_) => Err(format!("{model} didn't answer in time")),
            },
            Err(error) => Err(error),
        };
        self.asks.lock().unwrap().remove(&thread);
        result
    }

    /// Routes a notification to a one-off question; true when it was one.
    fn answer(&self, thread: &str, method: &str, params: &Value) -> bool {
        let mut asks = self.asks.lock().unwrap();
        let Some(ask) = asks.get_mut(thread) else {
            return false;
        };
        match method {
            "item/completed" if params["item"]["type"] == "agentMessage" => {
                ask.text = params["item"]["text"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
            }
            "turn/completed" => {
                let turn = &params["turn"];
                let result = match turn["status"].as_str() {
                    Some("failed") => Err(turn["error"]["message"]
                        .as_str()
                        .unwrap_or("The model failed")
                        .to_owned()),
                    Some("interrupted") => Err("Stopped.".to_owned()),
                    _ => Ok(std::mem::take(&mut ask.text)),
                };
                if let Some(done) = ask.done.take() {
                    let _ = done.send(result);
                }
            }
            _ => {}
        }
        true
    }

    async fn start_thread(
        &self,
        codex: &Codex,
        config: &Value,
        instructions: &str,
        workspace: &std::path::Path,
    ) -> Result<String, String> {
        let started = codex
            .call(
                "thread/start",
                json!({
                    "cwd": workspace.to_string_lossy(),
                    "approvalPolicy": "never",
                    "sandbox": "read-only",
                    "config": config,
                    "developerInstructions": instructions,
                    "serviceName": "edit",
                }),
                Duration::from_secs(30),
            )
            .await?;
        started["thread"]["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "Codex didn't start a thread".to_owned())
    }

    pub async fn stop(self: &Arc<Self>, project: &str) -> Result<(), String> {
        let (thread, turn) =
            self.with_chat(project, |chat| (chat.thread.clone(), chat.turn.clone()));
        let (Some(thread), Some(turn)) = (thread, turn) else {
            return Ok(());
        };
        let codex = self.codex().await?;
        codex
            .call(
                "turn/interrupt",
                json!({ "threadId": thread, "turnId": turn }),
                Duration::from_secs(15),
            )
            .await
            .map(|_| ())
    }

    fn finish(&self, project: &str, error: Option<String>) {
        if let Some(message) = error {
            self.upsert(
                project,
                Entry {
                    id: format!("error-{}", now_ms()),
                    kind: "error".to_owned(),
                    text: message,
                    ..Entry::default()
                },
            );
        }
        let now = now_ms();
        self.with_chat(project, |chat| {
            chat.running = false;
            chat.turn = None;
            if let Some(last) = chat.entries.last_mut() {
                last.updated = last.updated.max(now);
            }
            // A turn that ended mid-tool leaves it unresolved; mark it.
            for entry in chat
                .entries
                .iter_mut()
                .filter(|entry| entry.status.as_deref() == Some("running"))
            {
                entry.status = Some("stopped".to_owned());
            }
        });
        self.save(project);
        self.emit(project, json!({ "event": "status", "running": false }));
    }

    /// Codex notifications, mapped onto the chat of the project their thread belongs to.
    fn on_message(&self, message: Value) {
        let method = message["method"].as_str().unwrap_or_default();
        let params = &message["params"];
        let Some(thread) = params["threadId"].as_str() else {
            return;
        };
        if self.answer(thread, method, params) {
            return;
        }
        let Some(project) = self.threads.lock().unwrap().get(thread).cloned() else {
            return;
        };
        match method {
            "item/agentMessage/delta" => {
                let (id, delta) = (
                    params["itemId"].as_str().unwrap_or_default(),
                    params["delta"].as_str().unwrap_or_default(),
                );
                self.with_chat(&project, |chat| {
                    if let Some(entry) = chat.entries.iter_mut().find(|entry| entry.id == id) {
                        entry.text.push_str(delta);
                    }
                });
                self.emit(
                    &project,
                    json!({ "event": "delta", "id": id, "text": delta }),
                );
            }
            "item/started" | "item/completed" => {
                let item = &params["item"];
                let id = item["id"].as_str().unwrap_or_default().to_owned();
                let done = method == "item/completed";
                match item["type"].as_str() {
                    Some("agentMessage") => {
                        let text = item["text"].as_str().unwrap_or_default().to_owned();
                        // Keep streamed text if the start event arrives empty.
                        let text = if done {
                            text
                        } else {
                            self.with_chat(&project, |chat| {
                                chat.entries
                                    .iter()
                                    .find(|entry| entry.id == id)
                                    .map(|entry| entry.text.clone())
                            })
                            .unwrap_or(text)
                        };
                        self.upsert(
                            &project,
                            Entry {
                                id,
                                kind: "assistant".to_owned(),
                                text,
                                ..Entry::default()
                            },
                        );
                    }
                    Some("mcpToolCall") => {
                        let status = match item["status"].as_str() {
                            Some("completed") => "done",
                            Some("failed") => "failed",
                            _ if done => "done",
                            _ => "running",
                        };
                        let text = item["error"]["message"]
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| summarize_args(&item["arguments"]));
                        let detail = serde_json::to_string_pretty(&item["arguments"]).ok();
                        self.upsert(
                            &project,
                            Entry {
                                id,
                                kind: "tool".to_owned(),
                                text,
                                tool: item["tool"].as_str().map(str::to_owned),
                                status: Some(status.to_owned()),
                                detail,
                                ..Entry::default()
                            },
                        );
                    }
                    Some("reasoning") => {
                        self.emit(&project, json!({ "event": "thinking", "active": !done }));
                    }
                    _ => {}
                }
                if done {
                    self.save(&project);
                }
            }
            "error" => {
                if !params["willRetry"].as_bool().unwrap_or(false) {
                    let message = params["error"]["message"]
                        .as_str()
                        .unwrap_or("Codex reported an error")
                        .to_owned();
                    self.upsert(
                        &project,
                        Entry {
                            id: format!("error-{}", now_ms()),
                            kind: "error".to_owned(),
                            text: message,
                            ..Entry::default()
                        },
                    );
                }
            }
            "turn/completed" => {
                let turn = &params["turn"];
                let error = match turn["status"].as_str() {
                    Some("failed") => Some(
                        turn["error"]["message"]
                            .as_str()
                            .unwrap_or("The turn failed")
                            .to_owned(),
                    ),
                    Some("interrupted") => Some("Stopped.".to_owned()),
                    _ => None,
                };
                self.finish(&project, error);
            }
            _ => {}
        }
    }
}

/// A one-line view of tool arguments for the chat ("text: Your title · start: 2").
fn summarize_args(arguments: &Value) -> String {
    let Some(object) = arguments.as_object() else {
        return String::new();
    };
    let text: Vec<String> = object
        .iter()
        .filter(|(key, _)| key.as_str() != "project_id")
        .map(|(key, value)| {
            let value = match value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            let value: String = value.chars().take(60).collect();
            format!("{key}: {value}")
        })
        .collect();
    let mut joined = text.join(" · ");
    if joined.chars().count() > 140 {
        joined = joined.chars().take(140).collect::<String>() + "…";
    }
    joined
}

/// MCP server names in the user's `~/.codex/config.toml` (`[mcp_servers.NAME]` tables).
fn user_mcp_servers() -> Vec<String> {
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))
        .unwrap_or_default();
    let Ok(config) = std::fs::read_to_string(home.join("config.toml")) else {
        return Vec::new();
    };
    let mut names: Vec<String> = config
        .lines()
        .filter_map(|line| {
            line.trim()
                .strip_prefix("[mcp_servers.")?
                .strip_suffix(']')
                .map(str::to_owned)
        })
        .map(|name| {
            name.split('.')
                .next()
                .unwrap_or_default()
                .trim_matches('"')
                .to_owned()
        })
        .filter(|name| !name.is_empty() && name != "edit")
        .collect();
    names.sort();
    names.dedup();
    names
}

/// A TOML key, quoted when it isn't a bare key (e.g. `computer-use` is fine, `a b` isn't).
fn toml_key(name: &str) -> String {
    if name
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        name.to_owned()
    } else {
        format!("\"{}\"", name.replace('"', "\\\""))
    }
}

fn find_codex() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let candidates = [
        PathBuf::from("codex"),
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
        home.join(".local/bin/codex"),
        home.join(".npm-global/bin/codex"),
    ];
    candidates.into_iter().find(|candidate| {
        Command::new(candidate)
            .arg("--version")
            .stdin(Stdio::null())
            .output()
            .is_ok_and(|output| output.status.success())
    })
}

// ---------------------------------------------------------------------------
// The app-server process.

type Reply = tokio::sync::oneshot::Sender<Result<Value, String>>;

struct Codex {
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, Reply>>>,
    next: AtomicU64,
    alive: Arc<AtomicBool>,
    _child: Mutex<Child>,
}

impl Codex {
    fn spawn(on_message: impl Fn(Value) + Send + 'static) -> Result<Arc<Self>, String> {
        let binary = find_codex().ok_or("Codex isn't installed")?;
        // Only Edit's tools: switch off the user's own MCP servers, apps and plugins
        // (overrides merge into their config, so each server is disabled by name).
        let mut args = vec![
            "app-server".to_owned(),
            "--disable".to_owned(),
            "apps".to_owned(),
            "--disable".to_owned(),
            "plugins".to_owned(),
        ];
        for name in user_mcp_servers() {
            args.push("-c".to_owned());
            args.push(format!("mcp_servers.{}.enabled=false", toml_key(&name)));
        }
        let mut child = Command::new(binary)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("couldn't start Codex: {error}"))?;
        let stdin = child.stdin.take().ok_or("Codex stdin")?;
        let stdout = child.stdout.take().ok_or("Codex stdout")?;
        let pending: Arc<Mutex<HashMap<u64, Reply>>> = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let codex = Arc::new(Self {
            stdin: Mutex::new(stdin),
            pending: Arc::clone(&pending),
            next: AtomicU64::new(1),
            alive: Arc::clone(&alive),
            _child: Mutex::new(child),
        });
        let writer = Arc::downgrade(&codex);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let has_method = message.get("method").is_some();
                match (message.get("id"), has_method) {
                    // Response to one of our requests.
                    (Some(id), false) => {
                        if let Some(reply) = id
                            .as_u64()
                            .and_then(|id| pending.lock().unwrap().remove(&id))
                        {
                            let result = match message.get("error") {
                                Some(error) => Err(error["message"]
                                    .as_str()
                                    .unwrap_or("Codex error")
                                    .to_owned()),
                                None => Ok(message["result"].clone()),
                            };
                            let _ = reply.send(result);
                        }
                    }
                    // A request from Codex (approvals, elicitations): Edit's
                    // tools are pre-approved and nothing else is allowed.
                    (Some(id), true) => {
                        if let Some(codex) = writer.upgrade() {
                            codex.write(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Edit only allows its own tools" } }));
                        }
                    }
                    (None, true) => on_message(message),
                    _ => {}
                }
            }
            alive.store(false, Ordering::Release);
            for (_, reply) in pending.lock().unwrap().drain() {
                let _ = reply.send(Err("Codex stopped".to_owned()));
            }
        });
        Ok(codex)
    }

    fn write(&self, message: &Value) {
        let mut stdin = self.stdin.lock().unwrap();
        let _ = writeln!(stdin, "{message}");
        let _ = stdin.flush();
    }

    async fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        if !self.alive.load(Ordering::Acquire) {
            return Err("Codex stopped".to_owned());
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (reply, response) = tokio::sync::oneshot::channel();
        self.pending.lock().unwrap().insert(id, reply);
        self.write(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        match tokio::time::timeout(timeout, response).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Codex stopped".to_owned()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("Codex didn't answer {method} in time"))
            }
        }
    }

    fn notify(&self, method: &str, params: Value) {
        let mut message = json!({ "jsonrpc": "2.0", "method": method });
        if !params.is_null() {
            message["params"] = params;
        }
        self.write(&message);
    }
}

impl Drop for Codex {
    fn drop(&mut self) {
        let _ = self._child.lock().map(|mut child| child.kill());
    }
}
