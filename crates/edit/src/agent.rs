//! Edit's built-in agent: Codex through `codex app-server` (JSON-RPC 2.0 over
//! newline-delimited stdio), using the user's own `codex login`.
//!
//! Edit's MCP server is injected per thread (`/mcp?project=<id>`), so a chat
//! can only touch its own project, with its tools pre-approved. The user's
//! other MCP servers, apps and plugins are switched off and the sandbox is
//! read-only: the agent edits through Edit's tools and nothing else.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
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
    /// When the running turn started, to time it.
    #[serde(skip)]
    pub started: Option<std::time::Instant>,
    /// Turns restarted in a row after the model was at capacity.
    #[serde(skip)]
    pub retries: u32,
    /// The user pressed stop: nothing restarts on its own until they send again.
    #[serde(skip)]
    pub halted: bool,
    /// Identifies this work so queued steps and retries cannot revive an old run.
    #[serde(skip)]
    pub generation: u64,
    /// The full edit going on (or the last one), step by step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<Run>,
}

/// A full edit: the steps of `fulledit::STEPS`, each a turn of its own.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Run {
    /// "running", "done", "stopped" or "failed".
    pub state: String,
    #[serde(default)]
    pub notes: String,
    /// The step being worked on (0-based).
    pub current: usize,
    pub steps: Vec<RunStep>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct RunStep {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_ms: Option<u64>,
    #[serde(default)]
    pub tool_calls: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Chat {
    fn close_step(&mut self) {
        let Some(step) = self
            .run
            .as_mut()
            .and_then(|run| run.steps.get_mut(run.current))
        else {
            return;
        };
        let Some(from) = step.started_ms else {
            return;
        };
        if step.ended_ms.is_some() {
            return;
        }
        let end = now_ms();
        step.ended_ms = Some(end);
        step.tool_calls = self
            .entries
            .iter()
            .filter(|entry| entry.kind == "tool" && entry.at >= from && entry.at <= end)
            .count();
    }
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
    sending: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    next_generation: AtomicU64,
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
            sending: Mutex::new(HashMap::new()),
            next_generation: AtomicU64::new(1),
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
        let runtime = tokio::runtime::Handle::current();
        let codex = Codex::spawn(move |message| this.on_message(message, &runtime))?;
        codex
            .call(
                "initialize",
                json!({ "clientInfo": { "name": "edit", "title": "Edit", "version": env!("CARGO_PKG_VERSION") } }),
                Duration::from_secs(20),
            )
            .await?;
        codex.notify("initialized", Value::Null);
        // Threads from a previous process must be resumed before new turns.
        self.threads.lock().clear();
        *slot = Some(Arc::clone(&codex));
        Ok(codex)
    }

    // --- models ------------------------------------------------------------

    /// Cached models, refreshed in the background once a day (or now with `refresh`).
    pub async fn models(self: &Arc<Self>, refresh: bool) -> Result<Value, String> {
        let cached = self.models.lock().clone();
        match cached {
            Some(cache) if !refresh => {
                if now_ms().saturating_sub(cache.fetched_ms) > MODELS_TTL_MS {
                    let this = Arc::clone(self);
                    tokio::spawn(async move {
                        let _ = crate::guard::catch_async("refreshing models", this.fetch_models())
                            .await;
                    });
                }
                Ok(
                    json!({ "models": with_configured_effort(cache.models), "fetched_ms": cache.fetched_ms }),
                )
            }
            _ => {
                let cache = self.fetch_models().await?;
                Ok(
                    json!({ "models": with_configured_effort(cache.models), "fetched_ms": cache.fetched_ms }),
                )
            }
        }
    }

    async fn fetch_models(self: &Arc<Self>) -> Result<ModelCache, String> {
        if self.refreshing.swap(true, Ordering::AcqRel) {
            // Another refresh is in flight; serve what we have.
            if let Some(cache) = self.models.lock().clone() {
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
                for row in page
                    .get("data")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
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
                cursor = page
                    .get("nextCursor")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
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
            *self.models.lock() = Some(cache.clone());
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
        let mut chat: Chat = serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            // Never overwrite a chat we can't read: set it aside and start fresh.
            crate::diag::warn("agent", format!("agent chat {}: {error}", path.display()));
            let _ = std::fs::rename(
                &path,
                path.with_extension(format!("unreadable-{}", now_ms())),
            );
            Chat::default()
        });
        if chat.run.as_ref().is_some_and(|run| run.state == "running") {
            chat.close_step();
            chat.halted = true;
            for entry in chat
                .entries
                .iter_mut()
                .filter(|entry| entry.status.as_deref() == Some("running"))
            {
                entry.status = Some("stopped".to_owned());
            }
            if let Some(run) = chat.run.as_mut() {
                run.state = "failed".to_owned();
                if let Some(step) = run.steps.get_mut(run.current) {
                    step.error = Some("Edit restarted before the full edit finished.".to_owned());
                }
                let now = now_ms();
                chat.entries.push(Entry {
                    id: format!("run-{now}"),
                    kind: "assistant".to_owned(),
                    text: run_report(run),
                    at: now,
                    updated: now,
                    ..Entry::default()
                });
            }
            crate::diag::warn(
                "agent",
                format!("full edit of {project} interrupted by restart"),
            );
            if let Err(error) =
                crate::store::write_atomic(&path, &serde_json::to_vec(&chat).unwrap_or_default())
            {
                crate::diag::warn(
                    "agent",
                    format!("saving interrupted full edit of {project}: {error}"),
                );
            }
        }
        chat
    }

    fn with_chat<T>(&self, project: &str, edit: impl FnOnce(&mut Chat) -> T) -> T {
        let mut chats = self.chats.lock();
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
            json!({ "entries": chat.entries, "running": chat.running, "model": chat.model, "effort": chat.effort, "run": chat.run })
        })
    }

    pub fn reset(&self, project: &str) {
        let thread = self.with_chat(project, |chat| {
            let thread = chat.thread.take();
            *chat = Chat::default();
            thread
        });
        if let Some(thread) = thread {
            self.threads.lock().remove(&thread);
        }
        let _ = std::fs::remove_file(self.store.chat_path(project));
        self.emit(project, json!({ "event": "reset" }));
    }

    fn emit(&self, project: &str, event: Value) {
        let mut event = event;
        if let Some(fields) = event.as_object_mut() {
            fields.insert("type".to_owned(), json!("agent"));
            fields.insert("project".to_owned(), json!(project));
        }
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
        self.send_turn(project, text, model, effort, None).await
    }

    async fn send_turn(
        self: &Arc<Self>,
        project: &str,
        text: String,
        model: Option<String>,
        effort: Option<String>,
        generation: Option<u64>,
    ) -> Result<(), String> {
        self.store.get(project).ok_or("no such project")?;
        let sending = self
            .sending
            .lock()
            .entry(project.to_owned())
            .or_default()
            .clone();
        // A very short turn can complete before turn/start's reply is handled.
        // Queue its next step until that startup has released the slot.
        let _sending = sending.lock().await;

        let generation = self.with_chat(project, |chat| {
            if let Some(generation) = generation {
                if chat.generation != generation || chat.halted {
                    return Ok(None);
                }
            } else if chat.run.as_ref().is_some_and(|run| run.state == "running") {
                return Err("the full edit is still working; stop it or wait".to_owned());
            }
            if chat.running {
                return Err("the agent is still working; stop it or wait".to_owned());
            }
            if generation.is_none() {
                chat.generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
                chat.halted = false;
                chat.retries = 0;
            }
            chat.running = true;
            chat.started = Some(std::time::Instant::now());
            if let Some(run) = chat.run.as_mut().filter(|run| run.state == "running") {
                if let Some(step) = run.steps.get_mut(run.current) {
                    step.started_ms.get_or_insert_with(now_ms);
                }
            }
            Ok(Some(chat.generation))
        })?;
        let Some(generation) = generation else {
            return Ok(());
        };
        self.emit_run(project);
        self.emit(project, json!({ "event": "status", "running": true }));
        let result = self
            .prepare_turn(project, text, model, effort, generation)
            .await;
        if let Err(error) = &result {
            if self.with_chat(project, |chat| {
                chat.generation == generation && chat.running
            }) {
                self.finish(project, Some(error.clone()));
            }
        }
        result
    }

    async fn prepare_turn(
        self: &Arc<Self>,
        project: &str,
        text: String,
        model: Option<String>,
        effort: Option<String>,
        generation: u64,
    ) -> Result<(), String> {
        let live = self.store.get(project).ok_or("no such project")?;
        let codex = self.codex().await?;
        if !self.with_chat(project, |chat| {
            chat.generation == generation && !chat.halted
        }) {
            return Err("Stopped.".to_owned());
        }
        let (thread, known) = self.with_chat(project, |chat| {
            chat.model = model.clone().or(chat.model.take());
            chat.effort = effort.clone().or(chat.effort.take());
            (
                chat.thread.clone(),
                chat.thread
                    .as_ref()
                    .is_some_and(|thread| self.threads.lock().contains_key(thread)),
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
             Work in as few steps as you can: put edits you already know into one batch call (see WORK FAST). \
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
            .insert(thread.clone(), project.to_owned());
        let selection = self.with_chat(project, |chat| {
            if chat.generation != generation || chat.halted {
                return None;
            }
            chat.thread = Some(thread.clone());
            Some((chat.model.clone(), chat.effort.clone()))
        });
        let Some((model, effort)) = selection else {
            return Err("Stopped.".to_owned());
        };
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
        if let Some(fields) = params.as_object_mut() {
            if let Some(model) = model {
                fields.insert("model".to_owned(), json!(model));
            }
            if let Some(effort) = effort {
                fields.insert("effort".to_owned(), json!(effort));
            }
        }
        // Dispatch while holding the same lock as Stop, so cancellation cannot
        // land between the final check and writing the request to Codex.
        let request = self.with_chat(project, |chat| {
            if chat.generation != generation || chat.halted {
                return Err("Stopped.".to_owned());
            }
            codex.request("turn/start", params)
        })?;
        match codex
            .response("turn/start", request, Duration::from_secs(30))
            .await
        {
            Ok(turn) => {
                let id = turn
                    .pointer("/turn/id")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let stopped = self.with_chat(project, |chat| {
                    if chat.generation != generation || (chat.halted && chat.running) {
                        return true;
                    }
                    if chat.running {
                        chat.turn = id.clone();
                    }
                    false
                });
                // Stop can arrive before turn/start returns the turn id.
                if stopped {
                    if let Some(id) = id {
                        codex
                            .call(
                                "turn/interrupt",
                                json!({ "threadId": thread, "turnId": id }),
                                Duration::from_secs(15),
                            )
                            .await?;
                    }
                    return Err("Stopped.".to_owned());
                }
                self.save(project);
                Ok(())
            }
            Err(error) => Err(error),
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
        let thread = started
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .ok_or("Codex didn't start a thread")?
            .to_owned();
        let (done, answer) = tokio::sync::oneshot::channel();
        self.asks.lock().insert(
            thread.clone(),
            Ask {
                text: String::new(),
                done: Some(done),
            },
        );
        let mut params = json!({ "threadId": thread, "input": input, "model": model, "effort": effort, "approvalPolicy": "never" });
        if let (Some(schema), Some(fields)) = (schema, params.as_object_mut()) {
            fields.insert("outputSchema".to_owned(), schema);
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
        self.asks.lock().remove(&thread);
        result
    }

    /// Routes a notification to a one-off question; true when it was one.
    fn answer(&self, thread: &str, method: &str, params: &Value) -> bool {
        let mut asks = self.asks.lock();
        let Some(ask) = asks.get_mut(thread) else {
            return false;
        };
        match method {
            "item/completed"
                if params.pointer("/item/type").and_then(Value::as_str) == Some("agentMessage") =>
            {
                ask.text = params
                    .pointer("/item/text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
            }
            "turn/completed" => {
                let turn = &params["turn"];
                let result = match turn["status"].as_str() {
                    Some("failed") => Err(turn
                        .pointer("/error/message")
                        .and_then(Value::as_str)
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
        started
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "Codex didn't start a thread".to_owned())
    }

    pub async fn stop(self: &Arc<Self>, project: &str) -> Result<(), String> {
        // Stopping also ends a full edit, even between its steps.
        let generation = self.with_chat(project, |chat| {
            chat.halted = true;
            chat.generation
        });
        self.end_run(project, "stopped", None, generation);
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
        let started = self.with_chat(project, |chat| {
            if error.is_none() {
                chat.retries = 0;
            }
            chat.started.take()
        });
        if let Some(started) = started {
            crate::diag::record("agent", "agent turn", started.elapsed(), error.as_deref());
        }
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
    fn on_message(self: &Arc<Self>, message: Value, runtime: &tokio::runtime::Handle) {
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let params = message.get("params").unwrap_or(&Value::Null);
        // The process is gone: no turn of it will ever complete, so end them now.
        if method == EXITED {
            let running: Vec<(String, u64)> = self
                .chats
                .lock()
                .iter()
                .filter(|(_, chat)| {
                    chat.running || chat.run.as_ref().is_some_and(|run| run.state == "running")
                })
                .map(|(project, chat)| (project.clone(), chat.generation))
                .collect();
            for (project, generation) in running {
                self.with_chat(&project, |chat| chat.halted = true);
                let error = "Codex stopped unexpectedly; send your message again.".to_owned();
                self.finish(&project, Some(error.clone()));
                self.end_run(&project, "failed", Some(error), generation);
            }
            return;
        }
        let Some(thread) = params["threadId"].as_str() else {
            return;
        };
        if self.answer(thread, method, params) {
            return;
        }
        let Some(project) = self.threads.lock().get(thread).cloned() else {
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
                        let text = item
                            .pointer("/error/message")
                            .and_then(Value::as_str)
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
                    let message = params
                        .pointer("/error/message")
                        .and_then(Value::as_str)
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
                        turn.pointer("/error/message")
                            .and_then(Value::as_str)
                            .unwrap_or("The turn failed")
                            .to_owned(),
                    ),
                    Some("interrupted") => Some("Stopped.".to_owned()),
                    _ => None,
                };
                let (halted, generation) =
                    self.with_chat(&project, |chat| (chat.halted, chat.generation));
                if let Some(failure) = error
                    .as_deref()
                    .filter(|failure| busy_model(failure) && !halted)
                {
                    let tries = self.with_chat(&project, |chat| {
                        chat.retries += 1;
                        chat.retries
                    });
                    if tries <= MAX_RETRIES {
                        // Wait a little longer each time, then pick the work back up.
                        let wait = 20 * u64::from(tries);
                        self.finish(
                            &project,
                            Some(format!(
                                "{failure} Trying again in {wait} s ({tries} of {MAX_RETRIES})."
                            )),
                        );
                        let (this, failure) = (Arc::clone(self), failure.to_owned());
                        runtime.spawn(async move {
                            tokio::time::sleep(Duration::from_secs(wait)).await;
                            // The user may have sent something else, or stopped, meanwhile.
                            if this.with_chat(&project, |chat| chat.running || chat.halted || chat.generation != generation) {
                                return;
                            }
                            let text = format!(
                                "(Edit, automatically) Your last turn was cut off by an error (\"{failure}\") before you finished. Carry on from where you stopped: check get_project for what's already done, then finish the task."
                            );
                            if let Err(error) = this.send_turn(&project, text, None, None, Some(generation)).await {
                                crate::diag::warn("agent", format!("retrying the turn in {project}: {error}"));
                                this.end_run(&project, "failed", Some(error), generation);
                            }
                        });
                        return;
                    }
                }
                self.finish(&project, error.clone());
                self.next_step(&project, error, runtime);
            }
            _ => {}
        }
    }

    // --- full edit -----------------------------------------------------------

    /// Starts a full edit: every step of `fulledit::STEPS`, sent one after
    /// another as each turn finishes.
    pub async fn run_full_edit(
        self: &Arc<Self>,
        project: &str,
        notes: String,
        model: Option<String>,
        effort: Option<String>,
    ) -> Result<(), String> {
        let prompt = crate::fulledit::prompt(0, &notes).ok_or("no steps")?;
        let generation = {
            let sending = self
                .sending
                .lock()
                .entry(project.to_owned())
                .or_default()
                .clone();
            let _sending = sending
                .try_lock()
                .map_err(|_| "the agent is already starting a turn".to_owned())?;
            self.with_chat(project, |chat| {
                if chat.running || chat.run.as_ref().is_some_and(|run| run.state == "running") {
                    return Err("the agent is still working; stop it or wait".to_owned());
                }
                chat.generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
                chat.halted = false;
                chat.retries = 0;
                chat.run = Some(Run {
                    state: "running".to_owned(),
                    notes,
                    current: 0,
                    steps: crate::fulledit::STEPS
                        .iter()
                        .map(|(name, _)| RunStep {
                            name: (*name).to_owned(),
                            ..RunStep::default()
                        })
                        .collect(),
                });
                Ok(chat.generation)
            })?
        };
        self.start_step(project, prompt, model, effort, generation)
            .await
    }

    async fn start_step(
        self: &Arc<Self>,
        project: &str,
        prompt: String,
        model: Option<String>,
        effort: Option<String>,
        generation: u64,
    ) -> Result<(), String> {
        let sent = self
            .send_turn(project, prompt, model, effort, Some(generation))
            .await;
        if let Err(error) = &sent {
            self.end_run(project, "failed", Some(error.clone()), generation);
        }
        sent
    }

    /// After a turn of a full edit: the step is done, so the next one goes
    /// out; a failed or stopped turn ends the run there.
    fn next_step(
        self: &Arc<Self>,
        project: &str,
        error: Option<String>,
        runtime: &tokio::runtime::Handle,
    ) {
        let next = self.with_chat(project, |chat| {
            if chat.halted || !chat.run.as_ref().is_some_and(|run| run.state == "running") {
                return None;
            }
            chat.close_step();
            let run = chat.run.as_mut()?;
            let prompt = if error.is_none() {
                crate::fulledit::prompt(run.current + 1, &run.notes)
            } else {
                None
            };
            if prompt.is_some() {
                run.current += 1;
            }
            Some((chat.generation, prompt))
        });
        let Some((generation, prompt)) = next else {
            return;
        };
        match (error, prompt) {
            (Some(error), _) if error == "Stopped." => {
                self.end_run(project, "stopped", None, generation)
            }
            (Some(error), _) => self.end_run(project, "failed", Some(error), generation),
            (None, None) => self.end_run(project, "done", None, generation),
            (None, Some(prompt)) => {
                let (this, project) = (Arc::clone(self), project.to_owned());
                runtime.spawn(async move {
                    let _ = this
                        .start_step(&project, prompt, None, None, generation)
                        .await;
                });
            }
        }
    }

    /// Ends a full edit once and writes its report into the chat. A stale
    /// startup or retry must never end a newer run.
    fn end_run(&self, project: &str, state: &str, error: Option<String>, generation: u64) {
        let report = self.with_chat(project, |chat| {
            if chat.generation != generation
                || !chat.run.as_ref().is_some_and(|run| run.state == "running")
            {
                return None;
            }
            chat.close_step();
            chat.halted = true;
            let run = chat.run.as_mut()?;
            run.state = state.to_owned();
            if let Some(step) = run.steps.get_mut(run.current) {
                step.error = error.clone();
            }
            Some(run_report(run))
        });
        let Some(report) = report else {
            return;
        };
        self.upsert(
            project,
            Entry {
                id: format!("run-{}", now_ms()),
                kind: "assistant".to_owned(),
                text: report,
                ..Entry::default()
            },
        );
        if let Some(error) = error {
            crate::diag::warn("agent", format!("full edit of {project}: {state}: {error}"));
        } else {
            crate::diag::info("agent", format!("full edit of {project}: {state}"));
        }
        self.save(project);
        self.emit_run(project);
    }

    fn emit_run(&self, project: &str) {
        let run = self.with_chat(project, |chat| chat.run.clone());
        self.emit(project, json!({ "event": "run", "run": run }));
    }
}

/// A finished (or ended) full edit as a table: each step, how long it took
/// and how many tool calls it made.
fn run_report(run: &Run) -> String {
    let minutes = |ms: u64| {
        let seconds = ms / 1000;
        if seconds >= 3600 {
            format!("{} h {:02} min", seconds / 3600, seconds % 3600 / 60)
        } else {
            format!("{} min {:02} s", seconds / 60, seconds % 60)
        }
    };
    let heading = match run.state.as_str() {
        "done" => "**Full edit done.**",
        "stopped" => "**Full edit stopped.**",
        _ => "**Full edit stopped by an error.**",
    };
    let mut out = format!("{heading}\n\n| Step | Took | Tool calls |\n|---|---|---|\n");
    let mut total = 0;
    let mut calls = 0;
    for (index, step) in run.steps.iter().enumerate() {
        let took = match (step.started_ms, step.ended_ms) {
            (Some(start), Some(end)) => {
                total += end.saturating_sub(start);
                calls += step.tool_calls;
                minutes(end.saturating_sub(start))
            }
            _ => "—".to_owned(),
        };
        let failed = step
            .error
            .as_deref()
            .map(|error| format!(" (stopped: {error})"))
            .unwrap_or_default();
        out.push_str(&format!(
            "| {}. {}{failed} | {took} | {} |\n",
            index + 1,
            step.name,
            if step.ended_ms.is_some() {
                step.tool_calls.to_string()
            } else {
                "—".to_owned()
            }
        ));
    }
    out.push_str(&format!(
        "| **Total** | **{}** | **{calls}** |",
        minutes(total)
    ));
    out
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
type Request = (u64, tokio::sync::oneshot::Receiver<Result<Value, String>>);

/// How many times in a row a turn cut off by a busy model is restarted.
const MAX_RETRIES: u32 = 3;

/// A turn that failed because the model was busy (worth trying again), not
/// because of anything in the request.
fn busy_model(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    [
        "at capacity",
        "overloaded",
        "temporarily unavailable",
        "try again later",
        "server_error",
        "503",
    ]
    .iter()
    .any(|sign| error.contains(sign))
}

/// Sent to `on_message` (by Edit, not Codex) when Codex's output ends.
const EXITED: &str = "edit/codexExited";

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
            // Whatever happens reading, Codex is marked gone after, and its callers answered.
            let _ = crate::guard::catch("reading from Codex", || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    let Ok(message) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    let has_method = message.get("method").is_some();
                    match (message.get("id"), has_method) {
                        // Response to one of our requests.
                        (Some(id), false) => {
                            if let Some(reply) =
                                id.as_u64().and_then(|id| pending.lock().remove(&id))
                            {
                                let result = match message.get("error") {
                                    Some(error) => Err(error["message"]
                                        .as_str()
                                        .unwrap_or("Codex error")
                                        .to_owned()),
                                    None => {
                                        Ok(message.get("result").cloned().unwrap_or(Value::Null))
                                    }
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
            });
            alive.store(false, Ordering::Release);
            for (_, reply) in pending.lock().drain() {
                let _ = reply.send(Err("Codex stopped".to_owned()));
            }
            on_message(json!({ "method": EXITED }));
        });
        Ok(codex)
    }

    fn write(&self, message: &Value) {
        let mut stdin = self.stdin.lock();
        let _ = writeln!(stdin, "{message}");
        let _ = stdin.flush();
    }

    fn request(&self, method: &str, params: Value) -> Result<Request, String> {
        if !self.alive.load(Ordering::Acquire) {
            return Err("Codex stopped".to_owned());
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (reply, response) = tokio::sync::oneshot::channel();
        self.pending.lock().insert(id, reply);
        self.write(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        Ok((id, response))
    }

    async fn response(
        &self,
        method: &str,
        (id, response): Request,
        timeout: Duration,
    ) -> Result<Value, String> {
        match tokio::time::timeout(timeout, response).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Codex stopped".to_owned()),
            Err(_) => {
                self.pending.lock().remove(&id);
                Err(format!("Codex didn't answer {method} in time"))
            }
        }
    }

    async fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        self.response(method, self.request(method, params)?, timeout)
            .await
    }

    fn notify(&self, method: &str, params: Value) {
        let mut message = json!({ "jsonrpc": "2.0", "method": method });
        if let (false, Some(fields)) = (params.is_null(), message.as_object_mut()) {
            fields.insert("params".to_owned(), params);
        }
        self.write(&message);
    }
}

impl Drop for Codex {
    fn drop(&mut self) {
        let _ = self._child.lock().kill();
    }
}

/// The reasoning effort the user's Codex config sets (`model_reasoning_effort`
/// in ~/.codex/config.toml, before any [section]): Codex uses it whenever a
/// turn names none, so it, not the model list's own default, is the default.
fn configured_effort() -> Option<String> {
    let home = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".codex"))
        })?;
    let text = std::fs::read_to_string(home.join("config.toml")).ok()?;
    text.lines()
        .map(str::trim)
        .take_while(|line| !line.starts_with('['))
        .find_map(|line| {
            let (key, value) = line.split_once('=')?;
            (key.trim() == "model_reasoning_effort")
                .then(|| value.trim().trim_matches('"').to_owned())
        })
        .filter(|effort| !effort.is_empty())
}

/// Edit's own default thinking level: its edits are mostly the house style
/// applied again and again, which medium does as well as high in far less
/// time. The user can still pick another in the agent panel.
const DEFAULT_EFFORT: &str = "medium";

/// The models with the default each will really use: Edit's, else the one the
/// user's Codex config sets.
fn with_configured_effort(mut models: Vec<Model>) -> Vec<Model> {
    let configured = configured_effort();
    for model in &mut models {
        let effort = [Some(DEFAULT_EFFORT), configured.as_deref()]
            .into_iter()
            .flatten()
            .find(|effort| model.efforts.iter().any(|own| own == effort));
        if let Some(effort) = effort {
            model.default_effort = effort.to_owned();
        }
    }
    models
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Echo the outgoing RPCs without starting Codex or editing real projects.
    struct Fixture {
        agents: Arc<Agents>,
        codex: Arc<Codex>,
        requests: tokio::sync::mpsc::UnboundedReceiver<Value>,
        project: String,
        home: PathBuf,
    }

    impl Fixture {
        async fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let home = std::env::temp_dir().join(format!(
                "edit-agent-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let store = Arc::new(Store::open(home.clone()).unwrap());
            let project = store
                .create("Full edit test", edit_core::Settings::default())
                .unwrap()
                .project
                .id;
            let agents = Agents::new(store, home.clone(), 0);
            let mut child = Command::new("cat")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            let stdin = child.stdin.take().unwrap();
            let stdout = child.stdout.take().unwrap();
            let (send, requests) = tokio::sync::mpsc::unbounded_channel();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if send.send(serde_json::from_str(&line).unwrap()).is_err() {
                        break;
                    }
                }
            });
            let codex = Arc::new(Codex {
                stdin: Mutex::new(stdin),
                pending: Arc::new(Mutex::new(HashMap::new())),
                next: AtomicU64::new(1),
                alive: Arc::new(AtomicBool::new(true)),
                _child: Mutex::new(child),
            });
            *agents.codex.lock().await = Some(Arc::clone(&codex));
            agents.with_chat(&project, |chat| {
                chat.thread = Some("test-thread".to_owned())
            });
            agents
                .threads
                .lock()
                .insert("test-thread".to_owned(), project.clone());
            Self {
                agents,
                codex,
                requests,
                project,
                home,
            }
        }

        fn start(&self) -> tokio::task::JoinHandle<Result<(), String>> {
            let (agents, project) = (Arc::clone(&self.agents), self.project.clone());
            tokio::spawn(async move {
                agents
                    .run_full_edit(
                        &project,
                        "test notes".to_owned(),
                        Some("test-model".to_owned()),
                        Some("medium".to_owned()),
                    )
                    .await
            })
        }

        async fn request(&mut self, method: &str) -> Value {
            let request = tokio::time::timeout(Duration::from_secs(2), self.requests.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(request["method"], method);
            request
        }

        fn reply(&self, request: &Value, result: Result<Value, String>) {
            self.codex
                .pending
                .lock()
                .remove(&request["id"].as_u64().unwrap())
                .unwrap()
                .send(result)
                .unwrap();
        }

        fn complete(&self) {
            self.agents.on_message(json!({ "method": "turn/completed", "params": { "threadId": "test-thread", "turn": { "id": "test-turn", "status": "completed" } } }), &tokio::runtime::Handle::current());
        }

        fn run(&self) -> Run {
            self.agents
                .with_chat(&self.project, |chat| chat.run.clone().unwrap())
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let mut child = self.codex._child.lock();
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_dir_all(&self.home);
        }
    }

    #[tokio::test]
    async fn seven_steps_finish_even_when_completion_beats_the_start_reply() {
        let mut fixture = Fixture::new().await;
        let started = fixture.start();
        for index in 0..crate::fulledit::STEPS.len() {
            let request = fixture.request("turn/start").await;
            assert_eq!(request["params"]["threadId"], "test-thread");
            assert_eq!(request["params"]["model"], "test-model");
            assert_eq!(request["params"]["effort"], "medium");
            assert!(request["params"]["input"][0]["text"]
                .as_str()
                .unwrap()
                .contains("test notes"));
            fixture.reply(&request, Ok(json!({ "turn": { "id": "test-turn" } })));
            // No await: the reader can deliver completion before the sender
            // has handled the reply and released its startup lock.
            fixture.complete();
            assert_eq!(fixture.run().current, (index + 1).min(6));
        }
        started.await.unwrap().unwrap();
        assert_eq!(fixture.run().state, "done");
        assert!(fixture
            .run()
            .steps
            .iter()
            .all(|step| step.started_ms.is_some() && step.ended_ms.is_some()));
        let reports = fixture.agents.with_chat(&fixture.project, |chat| {
            chat.entries
                .iter()
                .filter(|entry| entry.text.starts_with("**Full edit done."))
                .count()
        });
        assert_eq!(reports, 1);
    }

    #[tokio::test]
    async fn stop_cancels_a_step_queued_between_turns() {
        let mut fixture = Fixture::new().await;
        let started = fixture.start();
        let request = fixture.request("turn/start").await;
        fixture.reply(&request, Ok(json!({ "turn": { "id": "test-turn" } })));
        started.await.unwrap().unwrap();
        let sending = fixture
            .agents
            .sending
            .lock()
            .get(&fixture.project)
            .unwrap()
            .clone();
        let guard = sending.lock().await;
        fixture.complete();
        fixture.agents.stop(&fixture.project).await.unwrap();
        drop(guard);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), fixture.requests.recv())
                .await
                .is_err()
        );
        let run = fixture.run();
        assert_eq!(run.state, "stopped");
        assert!(run.steps[1].started_ms.is_none());
        assert!(run.steps[1].ended_ms.is_none());
    }

    #[tokio::test]
    async fn stop_interrupts_a_turn_whose_id_arrives_late() {
        let mut fixture = Fixture::new().await;
        let started = fixture.start();
        let request = fixture.request("turn/start").await;
        fixture.agents.stop(&fixture.project).await.unwrap();
        fixture.reply(&request, Ok(json!({ "turn": { "id": "late-turn" } })));
        let interrupt = fixture.request("turn/interrupt").await;
        assert_eq!(interrupt["params"]["turnId"], "late-turn");
        fixture.reply(&interrupt, Ok(json!({})));
        assert_eq!(started.await.unwrap().unwrap_err(), "Stopped.");
        assert_eq!(fixture.run().state, "stopped");
        assert!(!fixture
            .agents
            .with_chat(&fixture.project, |chat| chat.running));
        let reports = fixture.agents.with_chat(&fixture.project, |chat| {
            chat.entries
                .iter()
                .filter(|entry| entry.text.starts_with("**Full edit stopped."))
                .count()
        });
        assert_eq!(reports, 1);
    }

    #[tokio::test]
    async fn stop_during_initialization_sends_no_turn() {
        let mut fixture = Fixture::new().await;
        let agents = Arc::clone(&fixture.agents);
        let guard = agents.codex.lock().await;
        let started = fixture.start();
        tokio::task::yield_now().await;
        assert!(fixture
            .agents
            .with_chat(&fixture.project, |chat| chat.running));
        fixture.agents.stop(&fixture.project).await.unwrap();
        drop(guard);
        assert_eq!(started.await.unwrap().unwrap_err(), "Stopped.");
        assert!(fixture.requests.try_recv().is_err());
        assert_eq!(fixture.run().state, "stopped");
    }

    #[tokio::test]
    async fn stale_step_cannot_start_or_fail_a_new_run() {
        let mut fixture = Fixture::new().await;
        let started = fixture.start();
        let request = fixture.request("turn/start").await;
        fixture.reply(&request, Ok(json!({ "turn": { "id": "test-turn" } })));
        started.await.unwrap().unwrap();
        let generation = fixture.agents.with_chat(&fixture.project, |chat| {
            chat.running = false;
            chat.turn = None;
            chat.generation
        });
        fixture.agents.stop(&fixture.project).await.unwrap();
        let newer = fixture.start();
        let request = fixture.request("turn/start").await;
        fixture.reply(&request, Ok(json!({ "turn": { "id": "test-turn" } })));
        newer.await.unwrap().unwrap();
        fixture
            .agents
            .start_step(&fixture.project, "stale".to_owned(), None, None, generation)
            .await
            .unwrap();
        fixture.agents.end_run(
            &fixture.project,
            "failed",
            Some("old error".to_owned()),
            generation,
        );
        assert_eq!(fixture.run().state, "running");
        assert_eq!(fixture.run().current, 0);
        assert!(fixture.requests.try_recv().is_err());
    }

    #[tokio::test]
    async fn process_exit_and_reload_end_the_run() {
        let mut fixture = Fixture::new().await;
        let started = fixture.start();
        let request = fixture.request("turn/start").await;
        fixture.reply(&request, Ok(json!({ "turn": { "id": "test-turn" } })));
        started.await.unwrap().unwrap();
        let reloaded = fixture.agents.load(&fixture.project);
        assert_eq!(reloaded.run.unwrap().state, "failed");
        assert!(reloaded
            .entries
            .last()
            .unwrap()
            .text
            .contains("Edit restarted"));
        // A retry wait has no active turn, but is still a running full edit.
        fixture
            .agents
            .with_chat(&fixture.project, |chat| chat.running = false);
        fixture.agents.on_message(
            json!({ "method": EXITED }),
            &tokio::runtime::Handle::current(),
        );
        assert_eq!(fixture.run().state, "failed");
        assert!(fixture.run().steps[0]
            .error
            .as_ref()
            .unwrap()
            .contains("unexpectedly"));
    }
}
