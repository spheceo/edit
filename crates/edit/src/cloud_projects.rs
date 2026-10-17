//! Cloud projects: with cloud on (a relay token, Settings → Cloud), projects
//! are kept in Convex (Edit's `edit:` functions, through the relay:
//! `crate::cloud`), so a teammate can open one on their Mac and carry on where
//! someone else stopped. One machine edits a project at a time: it holds the
//! project's lock, a two-minute lease renewed every 45 s, and every write to a
//! cloud project goes through [`Cloud::may_write`] (`Store::commit`), which
//! refuses one another machine holds.
//!
//! What this machine knows lives in the data folder: `cloud.json` (the
//! setting: token, off, holder label; mode 600, it holds the token) and
//! `cloud/projects.json` (per cloud project: the cloud rev its copy is based
//! on, whether it has changes not pushed yet, and its lock token). A
//! background loop ([`start`]) pushes changes ~2 s after the last one (the
//! JSON uploaded, then `commitProject` with the base rev), renews and releases
//! locks, retries with backoff while offline, and watches a project someone
//! else holds so the editor refreshes when they let go. The editor and the
//! agent never wait on the network to save: saves land on disk and are queued.
//!
//! Locks ([`Lock`]): Unknown (not asked this session; the first write asks),
//! Provisional (a new project, or the cloud couldn't be reached: edits are
//! allowed and pushed once the lock is ours), Held, Elsewhere (read-only).
//! Losing the lock with unpushed changes (renewing says someone took over, a
//! commit is refused) or a commit refused as a `conflict` keeps this
//! machine's version as "<name> (conflicted copy)", on this machine only, and
//! takes the cloud's: nothing is overwritten either way.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use edit_core::Project;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::cloud::ConvexFailure;
use crate::server::App;
use crate::store::Store;

/// A push waits this long after the last change (more changes restart it).
const DEBOUNCE: Duration = Duration::from_secs(2);
/// A held lock is renewed this often (its lease lasts two minutes).
const RENEW_EVERY: Duration = Duration::from_secs(45);
/// An editor that hasn't said it's still open for this long has gone.
const VIEWER_TTL: Duration = Duration::from_secs(75);
/// A lock nobody here is using (no editor open, no write) is let go after this.
const IDLE_RELEASE: Duration = Duration::from_secs(60);
/// How often a project someone else holds is checked while it's open here.
const CHECK_EVERY: Duration = Duration::from_secs(10);
/// Retries after a failure wait 5 s, 10 s, 20 s… up to this.
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// Seconds a lock or status call may take; bodies get longer.
const QUICK: u64 = 15;
const SLOW: u64 = 180;
/// What a project is saved as when the cloud's version wins.
const CONFLICTED: &str = "(conflicted copy)";

const SETTINGS: &str = "cloud.json";
const STATE_DIR: &str = "cloud";
const STATE: &str = "projects.json";

/// Settings → Cloud, in `<home>/cloud.json`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Settings {
    /// The relay's cloud token (used when `EDIT_RELAY_TOKEN` isn't set).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    /// Cloud switched off (the token is kept).
    #[serde(default)]
    off: bool,
    /// How teammates see this machine ("<holder> is editing").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    holder: Option<String>,
}

/// What's kept on disk per cloud project.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Saved {
    /// The cloud rev this machine's copy is (or is based on); 0 before the
    /// first push.
    #[serde(default)]
    pub rev: u64,
    /// Changes made here that aren't in the cloud yet.
    #[serde(default)]
    pub dirty: bool,
    /// This machine's lock, when it holds it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

/// Who may edit a cloud project, as far as this machine knows.
#[derive(Clone, Debug, PartialEq)]
pub enum Lock {
    /// Not asked yet: the first write (or opening it) asks.
    Unknown,
    /// Edits allowed before the lock is ours: a project just made here, or
    /// the cloud couldn't be reached. Pushed once the lock is taken.
    Provisional,
    /// This machine's.
    Held,
    /// Someone else is editing: read-only here.
    Elsewhere { holder: String },
}

/// The next network job for a project.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// Take the cloud's version.
    Pull,
    /// Fetch the footage a pulled project needs (`cloud_media::ensure_local`).
    Media,
    Acquire,
    Push,
    Renew,
    Release,
    /// See whether whoever holds it has let go.
    Check,
}

/// What [`Cloud::may_write`] does with a write.
#[derive(Clone, Debug, PartialEq)]
pub enum Permission {
    Allow,
    Refuse(String),
    /// Take the lock first.
    Ask,
}

fn read_only(holder: &str) -> String {
    format!(
        "{holder} is editing this project, so it's read-only here until they close it (or you take over in the editor)."
    )
}

/// Something to tell the user about a project.
#[derive(Clone, Debug, PartialEq)]
pub enum Note {
    /// The cloud's version won; this machine's was kept as a copy.
    Conflict {
        message: String,
    },
    Error(String),
}

/// A cloud project's state on this machine.
#[derive(Debug)]
pub struct Entry {
    pub saved: Saved,
    pub lock: Lock,
    /// The network job running for it.
    busy: Option<Step>,
    /// Counts local writes, so a push knows whether more came in meanwhile.
    edits: u64,
    changed_at: Option<Instant>,
    renewed_at: Option<Instant>,
    checked_at: Option<Instant>,
    retry_at: Option<Instant>,
    failures: u32,
    offline: bool,
    /// The editor closed it: push now and let go.
    closing: bool,
    want_pull: bool,
    want_media: bool,
    /// UI clients with it open, and when they last said so.
    viewers: HashMap<String, Instant>,
    note: Option<Note>,
}

impl Entry {
    fn new(saved: Saved) -> Self {
        // A token from before a restart is renewed straight away (and if it
        // has gone, taken again: the same holder may).
        let lock = if saved.token.is_some() {
            Lock::Held
        } else {
            Lock::Unknown
        };
        Self {
            saved,
            lock,
            busy: None,
            edits: 0,
            changed_at: None,
            renewed_at: None,
            checked_at: None,
            retry_at: None,
            failures: 0,
            offline: false,
            closing: false,
            want_pull: false,
            want_media: false,
            viewers: HashMap::new(),
            note: None,
        }
    }

    /// A project made here (or moved to the cloud): pushed as rev 1.
    fn fresh() -> Self {
        let mut entry = Self::new(Saved {
            rev: 0,
            dirty: true,
            token: None,
        });
        entry.lock = Lock::Provisional;
        entry
    }

    fn watched(&self, now: Instant) -> bool {
        self.viewers
            .values()
            .any(|seen| now.saturating_duration_since(*seen) < VIEWER_TTL)
    }

    fn recently_changed(&self, now: Instant) -> bool {
        self.changed_at
            .is_some_and(|at| now.saturating_duration_since(at) < IDLE_RELEASE)
    }

    /// What to do next, if anything (the state machine's one decision).
    pub fn step(&self, now: Instant) -> Option<Step> {
        if self.busy.is_some() || self.retry_at.is_some_and(|at| now < at) {
            return None;
        }
        if self.want_pull {
            return Some(Step::Pull);
        }
        if self.want_media {
            return Some(Step::Media);
        }
        let watched = self.watched(now);
        let recent = self.recently_changed(now);
        match &self.lock {
            Lock::Held => {
                let settled = self.closing
                    || self
                        .changed_at
                        .is_none_or(|at| now.saturating_duration_since(at) >= DEBOUNCE);
                if self.saved.dirty && settled {
                    return Some(Step::Push);
                }
                if !self.saved.dirty && !watched && (self.closing || !recent) {
                    return Some(Step::Release);
                }
                let renew = self
                    .renewed_at
                    .is_none_or(|at| now.saturating_duration_since(at) >= RENEW_EVERY);
                renew.then_some(Step::Renew)
            }
            // A write asks for itself (`Cloud::may_write`); this is for
            // changes waiting to go and an editor open on it.
            Lock::Unknown | Lock::Provisional => {
                (self.saved.dirty || watched).then_some(Step::Acquire)
            }
            Lock::Elsewhere { .. } => {
                let due = self
                    .checked_at
                    .is_none_or(|at| now.saturating_duration_since(at) >= CHECK_EVERY);
                (watched && due).then_some(Step::Check)
            }
        }
    }

    /// Whether a write may go ahead (cloud on).
    pub fn permission(&self) -> Permission {
        match &self.lock {
            Lock::Held | Lock::Provisional => Permission::Allow,
            Lock::Elsewhere { holder } => Permission::Refuse(read_only(holder)),
            Lock::Unknown => Permission::Ask,
        }
    }

    fn wrote(&mut self, now: Instant) {
        self.edits += 1;
        self.changed_at = Some(now);
        self.closing = false;
        self.saved.dirty = true;
    }

    fn acquired(&mut self, token: String, now: Instant) {
        self.saved.token = Some(token);
        self.lock = Lock::Held;
        self.renewed_at = Some(now);
        self.succeeded();
    }

    /// Someone else holds it (this machine's changes are dealt with first).
    fn elsewhere(&mut self, holder: String, now: Instant) {
        self.saved.token = None;
        self.lock = Lock::Elsewhere { holder };
        self.checked_at = Some(now);
        self.closing = false;
        self.succeeded();
    }

    /// The lock went (expired, or a commit was refused) but nobody else has
    /// it: take it again on the next step.
    fn forget_lock(&mut self) {
        self.saved.token = None;
        self.lock = Lock::Unknown;
    }

    fn released(&mut self) {
        self.saved.token = None;
        self.lock = Lock::Unknown;
        self.closing = false;
        self.renewed_at = None;
    }

    /// A push of the edits counted up to `edits` landed as cloud `rev`.
    fn pushed(&mut self, rev: u64, edits: u64) {
        self.saved.rev = rev;
        if self.edits == edits {
            self.saved.dirty = false;
        }
        self.note = None;
        self.succeeded();
    }

    fn succeeded(&mut self) {
        self.offline = false;
        self.failures = 0;
        self.retry_at = None;
    }

    /// The cloud couldn't be reached: carry on locally and try again later.
    fn unreachable(&mut self, now: Instant) {
        self.offline = true;
        self.back_off(now);
        if self.lock == Lock::Unknown {
            self.lock = Lock::Provisional;
        }
    }

    fn failed(&mut self, message: String, now: Instant) {
        self.note = Some(Note::Error(message));
        self.back_off(now);
    }

    fn back_off(&mut self, now: Instant) {
        self.failures = self.failures.saturating_add(1);
        let wait = Duration::from_secs(5)
            .saturating_mul(1 << self.failures.saturating_sub(1).min(8))
            .min(BACKOFF_MAX);
        self.retry_at = Some(now + wait);
    }

    /// What the UI shows: `sync` is one of off, synced, pending, syncing,
    /// offline, conflict, readonly, error.
    pub fn status(&self, on: bool) -> Value {
        let (lock, holder) = match &self.lock {
            Lock::Unknown => ("unknown", None),
            Lock::Provisional => ("provisional", None),
            Lock::Held => ("held", None),
            Lock::Elsewhere { holder } => ("elsewhere", Some(holder.clone())),
        };
        let pushing = matches!(self.busy, Some(Step::Push | Step::Pull));
        let sync = if !on {
            "off"
        } else if holder.is_some() {
            "readonly"
        } else if matches!(self.note, Some(Note::Conflict { .. })) {
            "conflict"
        } else if pushing {
            "syncing"
        } else if self.offline {
            "offline"
        } else if matches!(self.note, Some(Note::Error(_))) {
            "error"
        } else if self.saved.dirty {
            "pending"
        } else {
            "synced"
        };
        let message = match &self.note {
            Some(Note::Conflict { message } | Note::Error(message)) => Some(message.clone()),
            None => None,
        };
        json!({
            "cloud": true,
            "on": on,
            "lock": lock,
            "holder": holder,
            "sync": sync,
            "rev": self.saved.rev,
            "dirty": self.saved.dirty,
            "message": message,
        })
    }
}

/// Cloud projects on this machine (one per server, attached to its store).
pub struct Cloud {
    home: PathBuf,
    /// This machine's name, the default holder label.
    machine: String,
    settings: Mutex<Settings>,
    projects: Mutex<HashMap<String, Entry>>,
    wake: tokio::sync::Notify,
}

impl Cloud {
    /// Reads the setting and per-project state, and applies the token.
    pub fn open(home: &Path, machine: &str) -> Self {
        let settings = read_settings(home);
        apply(&settings);
        let saved: HashMap<String, Saved> = std::fs::read(home.join(STATE_DIR).join(STATE))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            home: home.to_path_buf(),
            machine: machine.to_owned(),
            settings: Mutex::new(settings),
            projects: Mutex::new(
                saved
                    .into_iter()
                    .map(|(id, saved)| (id, Entry::new(saved)))
                    .collect(),
            ),
            wake: tokio::sync::Notify::new(),
        }
    }

    /// Whether cloud is on (a token, not switched off).
    pub fn on(&self) -> bool {
        crate::cloud::enabled()
    }

    /// How teammates see this machine: `EDIT_CLOUD_HOLDER`, the setting, else
    /// its name. Stable across restarts, so this machine takes its own lock
    /// back after one.
    pub fn holder(&self) -> String {
        std::env::var("EDIT_CLOUD_HOLDER")
            .ok()
            .map(|holder| holder.trim().to_owned())
            .filter(|holder| !holder.is_empty())
            .or_else(|| self.settings.lock().holder.clone())
            .unwrap_or_else(|| self.machine.clone())
    }

    pub fn is_cloud(&self, id: &str) -> bool {
        self.projects.lock().contains_key(id)
    }

    /// The project's cloud status for the UI (`{cloud: false}` for a project
    /// only on this machine).
    pub fn status(&self, id: &str) -> Value {
        let on = self.on();
        match self.projects.lock().get(id) {
            Some(entry) => entry.status(on),
            None => json!({ "cloud": false, "on": on }),
        }
    }

    /// Every cloud project's status, by id.
    pub fn statuses(&self) -> Value {
        let on = self.on();
        Value::Object(
            self.projects
                .lock()
                .iter()
                .map(|(id, entry)| (id.clone(), entry.status(on)))
                .collect(),
        )
    }

    fn emit(&self, store: &Store, id: &str) {
        store.emit(json!({ "type": "cloud", "id": id, "status": self.status(id) }));
    }

    fn persist(&self) {
        let saved: HashMap<String, Saved> = self
            .projects
            .lock()
            .iter()
            .map(|(id, entry)| (id.clone(), entry.saved.clone()))
            .collect();
        let dir = self.home.join(STATE_DIR);
        let result = std::fs::create_dir_all(&dir)
            .map_err(|error| error.to_string())
            .and_then(|()| serde_json::to_vec_pretty(&saved).map_err(|error| error.to_string()))
            .and_then(|bytes| write_private(&dir.join(STATE), &bytes));
        if let Err(error) = result {
            crate::diag::warn("cloud", format!("saving cloud/{STATE}: {error}"));
        }
    }

    fn with<T>(&self, id: &str, change: impl FnOnce(&mut Entry) -> T) -> Option<T> {
        self.projects.lock().get_mut(id).map(change)
    }

    // -----------------------------------------------------------------------
    // The store's hooks (every write passes here).

    /// Whether this machine may change project `id` now. Only a cloud project
    /// someone else is editing is refused; one not asked about yet is asked
    /// (blocking, once: an agent or a background job editing a project the
    /// editor hasn't opened). Unreachable, it's allowed and queued.
    pub fn may_write(&self, store: &Store, id: &str) -> Result<(), String> {
        if !self.on() {
            return Ok(());
        }
        let started = Instant::now();
        loop {
            let mut projects = self.projects.lock();
            let Some(entry) = projects.get_mut(id) else {
                return Ok(());
            };
            match entry.permission() {
                Permission::Allow => return Ok(()),
                Permission::Refuse(why) => return Err(why),
                Permission::Ask if entry.busy.is_none() => {
                    entry.busy = Some(Step::Acquire);
                    break;
                }
                Permission::Ask => {
                    drop(projects);
                    if started.elapsed() > Duration::from_secs(QUICK + 5) {
                        return Err(
                            "still checking who's editing this project; try again".to_owned()
                        );
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }
        let result = blocking(|| self.claim_blocking(store, id));
        self.with(id, |entry| entry.busy = None);
        self.persist();
        self.emit(store, id);
        self.wake.notify_one();
        result
    }

    /// Takes the lock for a write (see `may_write`); a newer cloud version is
    /// taken first, so the write lands on it (and is retried by its caller).
    fn claim_blocking(&self, store: &Store, id: &str) -> Result<(), String> {
        let holder = self.holder();
        let now = Instant::now();
        match remote::acquire(id, &holder, false) {
            Ok(Acquired::Got(token)) => {
                self.with(id, |entry| entry.acquired(token, now));
                match remote::get(id) {
                    Ok(Some(meta)) if meta.rev > self.saved_rev(id) && !self.dirty(id) => {
                        let project = remote::download(&meta.body_url)?;
                        self.take(store, id, project, meta.rev)?;
                        self.with(id, |entry| entry.want_media = true);
                    }
                    // A newer version over changes made here: the loop's next
                    // push meets the conflict and keeps both.
                    _ => {}
                }
                Ok(())
            }
            Ok(Acquired::HeldBy(other)) => {
                let message = read_only(&other);
                let dirty = self.dirty(id);
                self.with(id, |entry| {
                    entry.elsewhere(other, now);
                    // Changes made here are kept as a copy by the loop.
                    entry.want_pull = dirty || entry.want_pull;
                });
                Err(message)
            }
            Err(ConvexFailure::Unreachable(_)) => {
                self.with(id, |entry| entry.unreachable(now));
                Ok(())
            }
            Err(failure) => Err(format!("couldn't take the project's cloud lock: {failure}")),
        }
    }

    /// A project was saved here.
    pub fn wrote(&self, id: &str) {
        let flipped = self
            .with(id, |entry| {
                let was = entry.saved.dirty;
                entry.wrote(Instant::now());
                !was
            })
            .unwrap_or(false);
        if flipped {
            self.persist();
        }
        self.wake.notify_one();
    }

    /// A project was made here: with cloud on it's a cloud project.
    pub fn created(&self, id: &str) {
        if !self.on() {
            return;
        }
        self.projects.lock().insert(id.to_owned(), Entry::fresh());
        self.persist();
        self.wake.notify_one();
    }

    fn saved_rev(&self, id: &str) -> u64 {
        self.with(id, |entry| entry.saved.rev).unwrap_or(0)
    }

    fn dirty(&self, id: &str) -> bool {
        self.with(id, |entry| entry.saved.dirty).unwrap_or(false)
    }

    /// Saves the cloud's `project` at `rev` as this machine's copy.
    fn take(&self, store: &Store, id: &str, project: Project, rev: u64) -> Result<(), String> {
        if project.id != id {
            return Err(format!(
                "the cloud's body for {id} holds project {}",
                project.id
            ));
        }
        store.put_from_cloud(project, "cloud")?;
        {
            let mut projects = self.projects.lock();
            let entry = projects
                .entry(id.to_owned())
                .or_insert_with(|| Entry::new(Saved::default()));
            entry.saved.rev = rev;
            entry.saved.dirty = false;
        }
        self.persist();
        Ok(())
    }

    // -----------------------------------------------------------------------
    // The UI's calls.

    /// The editor has `id` open (`client` says so every 30 s).
    pub fn viewing(&self, id: &str, client: &str) {
        self.with(id, |entry| {
            entry.viewers.insert(client.to_owned(), Instant::now());
            entry.closing = false;
        });
        self.wake.notify_one();
    }

    /// The editor closed `id`: push what's left and let the lock go.
    pub fn closed(&self, id: &str, client: &str) {
        self.with(id, |entry| {
            entry.viewers.remove(client);
            if entry.viewers.is_empty() {
                entry.closing = true;
            }
        });
        self.wake.notify_one();
    }

    /// Registers a project only on this machine as a cloud project, pushed
    /// as new.
    pub fn adopt(&self, id: &str) {
        self.projects
            .lock()
            .entry(id.to_owned())
            .or_insert_with(Entry::fresh);
        self.persist();
        self.wake.notify_one();
    }

    /// Forgets a project (deleted, or deleted from the cloud).
    pub fn forget(&self, id: &str) {
        self.projects.lock().remove(id);
        self.persist();
    }

    // -----------------------------------------------------------------------
    // Settings → Cloud.

    /// Settings → Cloud: on, where the token comes from, the holder label.
    pub fn settings_status(&self) -> Value {
        let settings = self.settings.lock().clone();
        let source = if crate::relay::env_token().is_some() {
            Some("env")
        } else if settings.token.is_some() {
            Some("saved")
        } else {
            None
        };
        json!({
            "on": self.on(),
            "off": settings.off,
            "token": source,
            "holder": self.holder(),
            "relay": crate::relay::url(),
        })
    }

    /// Changes the setting: `token` Some(None) forgets the saved token.
    pub fn set_settings(
        &self,
        token: Option<Option<String>>,
        off: Option<bool>,
        holder: Option<Option<String>>,
    ) -> Result<(), String> {
        let mut settings = self.settings.lock();
        let mut next = settings.clone();
        if let Some(token) = token {
            let token = token
                .map(|token| token.trim().to_owned())
                .filter(|token| !token.is_empty());
            if let Some(token) = &token {
                if token.len() > 512
                    || token
                        .chars()
                        .any(|ch| ch.is_control() || ch.is_whitespace())
                {
                    return Err(
                        "That doesn't look like a cloud token (one line, no spaces).".to_owned(),
                    );
                }
            }
            next.token = token;
        }
        if let Some(off) = off {
            next.off = off;
        }
        if let Some(holder) = holder {
            let holder = holder
                .map(|holder| holder.trim().to_owned())
                .filter(|holder| !holder.is_empty());
            if holder.as_ref().is_some_and(|holder| holder.len() > 100) {
                return Err("Keep the name under 100 characters.".to_owned());
            }
            next.holder = holder;
        }
        let bytes = serde_json::to_vec_pretty(&next).map_err(|error| error.to_string())?;
        write_private(&self.home.join(SETTINGS), &bytes)?;
        apply(&next);
        *settings = next;
        drop(settings);
        self.wake.notify_one();
        Ok(())
    }

    /// Whether the relay takes the token (blocking): None when it does, else why not.
    pub fn connection_problem(&self) -> Option<String> {
        if crate::relay::token().is_none() {
            return Some("No cloud token yet.".to_owned());
        }
        match crate::cloud::convex_call(
            "query",
            "edit:getProject",
            json!({ "projectId": "edit-connection-check" }),
            QUICK,
        ) {
            Ok(_) => None,
            Err(ConvexFailure::Unreachable(_)) => {
                Some("Can't reach Edit's relay (offline?).".to_owned())
            }
            Err(failure) => Some(failure.to_string()),
        }
    }
}

/// Uses the setting: its token (unless `EDIT_RELAY_TOKEN` is set) and on/off.
fn apply(settings: &Settings) {
    crate::relay::set_saved_token(settings.token.clone());
    crate::cloud::set_off(settings.off);
}

fn read_settings(home: &Path) -> Settings {
    std::fs::read(home.join(SETTINGS))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// The saved token for `edit cloud …` (no server running).
pub fn use_saved_token(home: &Path) {
    apply(&read_settings(home));
}

/// Writes `bytes` atomically, readable by this user only (it may hold the token).
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{}.tmp", std::process::id()));
    let tmp = PathBuf::from(tmp);
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.map_err(|error| format!("saving {}: {error}", path.display()))
}

/// Runs blocking network work from wherever the store is written (an async
/// handler or a job thread) without stalling the runtime.
fn blocking<T>(work: impl FnOnce() -> T) -> T {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(work)
        }
        _ => work(),
    }
}

/// What `commitProject` keeps beside a body, for listing without it (≤ 64 KB).
pub fn summary(project: &Project) -> Value {
    json!({
        "style": project.style,
        "durationFrames": project.duration(),
        "clips": project.clips.len(),
        "media": project.media.len(),
        "cloudMedia": project.media.iter().filter(|media| media.cloud.is_some()).count(),
        "fps": project.settings.fps,
        "width": project.settings.width,
        "height": project.settings.height,
        "subtitles": crate::subtitles::is_subtitled(project),
    })
}

fn conflicted_name(name: &str) -> String {
    format!("{name} {CONFLICTED}")
}

/// Convex through the relay, and the bodies Convex stores (blocking).
mod remote {
    use super::*;

    pub enum Acquired {
        Got(String),
        HeldBy(String),
    }

    pub enum Renewed {
        Yes,
        /// Gone: to `Some(holder)`, or expired with nobody holding it.
        Lost(Option<String>),
    }

    pub struct Meta {
        pub rev: u64,
        pub body_url: String,
        /// Who holds a live lease (expired ones are dropped).
        pub holder: Option<String>,
    }

    fn mutation(path: &str, args: Value, timeout: u64) -> Result<Value, ConvexFailure> {
        crate::cloud::convex_call("mutation", path, args, timeout)
    }

    pub fn acquire(id: &str, holder: &str, force: bool) -> Result<Acquired, ConvexFailure> {
        let answer = mutation(
            "edit:acquireLock",
            json!({ "projectId": id, "holder": holder, "force": force }),
            QUICK,
        )?;
        if answer["acquired"].as_bool() == Some(true) {
            let token = answer["token"].as_str().unwrap_or_default().to_owned();
            if token.is_empty() {
                return Err(ConvexFailure::Relay("acquireLock gave no token".to_owned()));
            }
            Ok(Acquired::Got(token))
        } else {
            Ok(Acquired::HeldBy(
                answer["heldBy"].as_str().unwrap_or("Someone").to_owned(),
            ))
        }
    }

    pub fn renew(id: &str, token: &str) -> Result<Renewed, ConvexFailure> {
        let answer = mutation(
            "edit:renewLock",
            json!({ "projectId": id, "lockToken": token }),
            QUICK,
        )?;
        if answer["renewed"].as_bool() == Some(true) {
            return Ok(Renewed::Yes);
        }
        let live = answer["until"]
            .as_u64()
            .is_some_and(|until| until > crate::store::now_ms());
        Ok(Renewed::Lost(
            answer["heldBy"]
                .as_str()
                .filter(|_| live)
                .map(str::to_owned),
        ))
    }

    pub fn release(id: &str, token: &str) -> Result<(), ConvexFailure> {
        mutation(
            "edit:releaseLock",
            json!({ "projectId": id, "lockToken": token }),
            QUICK,
        )
        .map(|_| ())
    }

    pub fn get(id: &str) -> Result<Option<Meta>, ConvexFailure> {
        let answer = crate::cloud::convex_call(
            "query",
            "edit:getProject",
            json!({ "projectId": id }),
            QUICK,
        )?;
        if answer.is_null() {
            return Ok(None);
        }
        let body_url = answer["bodyUrl"].as_str().unwrap_or_default().to_owned();
        Ok(Some(Meta {
            rev: answer["rev"].as_u64().unwrap_or(0),
            body_url,
            holder: live_holder(&answer["lock"]),
        }))
    }

    /// The holder of a lease that hasn't run out by this machine's clock.
    pub fn live_holder(lock: &Value) -> Option<String> {
        let until = lock["until"].as_u64()?;
        (until > crate::store::now_ms())
            .then(|| lock["holder"].as_str().map(str::to_owned))
            .flatten()
    }

    pub fn list() -> Result<Vec<Value>, ConvexFailure> {
        let answer = crate::cloud::convex_call("query", "edit:listProjects", json!({}), QUICK)?;
        Ok(answer.as_array().cloned().unwrap_or_default())
    }

    /// Whether there was a project to delete (its lock goes either way).
    pub fn delete(id: &str, token: Option<&str>) -> Result<bool, ConvexFailure> {
        let args = match token {
            Some(token) => json!({ "projectId": id, "lockToken": token }),
            None => json!({ "projectId": id }),
        };
        mutation("edit:deleteProject", args, QUICK)
            .map(|answer| answer["deleted"].as_bool().unwrap_or(false))
    }

    /// Uploads `project` and commits it as the rev after `base`: the new rev.
    pub fn push(
        project: &Project,
        base: u64,
        token: Option<&str>,
        holder: &str,
    ) -> Result<u64, ConvexFailure> {
        let body =
            serde_json::to_vec(project).map_err(|error| ConvexFailure::Relay(error.to_string()))?;
        let url = mutation("edit:uploadUrl", json!({}), QUICK)?;
        let url = url
            .as_str()
            .ok_or_else(|| ConvexFailure::Relay("uploadUrl gave no URL".to_owned()))?;
        let answer = http("POST", url, Some(&body), SLOW)?;
        let storage = serde_json::from_slice::<Value>(&answer)
            .ok()
            .and_then(|answer| answer["storageId"].as_str().map(str::to_owned))
            .ok_or_else(|| ConvexFailure::Relay("the upload gave no storage id".to_owned()))?;
        let mut args = json!({
            "projectId": project.id,
            "baseRev": base,
            "storageId": storage,
            "name": project.name,
            "summary": summary(project),
            "holder": holder,
            "bodySize": body.len(),
        });
        if let Some(token) = token {
            args["lockToken"] = json!(token);
        }
        let answer = mutation("edit:commitProject", args, QUICK)?;
        answer["rev"]
            .as_u64()
            .ok_or_else(|| ConvexFailure::Relay("commitProject gave no rev".to_owned()))
    }

    /// The project stored at `url` (a `getProject` body URL).
    pub fn download(url: &str) -> Result<Project, String> {
        let bytes = http("GET", url, None, SLOW).map_err(|failure| failure.to_string())?;
        serde_json::from_slice(&bytes).map_err(|error| format!("the cloud's project file: {error}"))
    }

    /// One request to Convex's storage; the answer's body. A request that
    /// gets nowhere is `Unreachable` (offline), like the relay's.
    fn http(
        method: &str,
        url: &str,
        body: Option<&[u8]>,
        timeout: u64,
    ) -> Result<Vec<u8>, ConvexFailure> {
        if !url.starts_with("https://") && !url.starts_with("http://") {
            return Err(ConvexFailure::Relay(format!("not a URL: {url:.60}")));
        }
        let timeout = timeout.to_string();
        let mut command = Command::new("curl");
        command
            .args([
                "-sS",
                "-X",
                method,
                "--max-time",
                &timeout,
                "--connect-timeout",
                "20",
            ])
            .args(["-w", "\n%{http_code}"]);
        if body.is_some() {
            command.args([
                "-H",
                "Content-Type: application/json",
                "--data-binary",
                "@-",
            ]);
        }
        let mut child = command
            .arg(url)
            .stdin(if body.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| ConvexFailure::Relay(format!("curl: {error}")))?;
        if let (Some(body), Some(mut stdin)) = (body, child.stdin.take()) {
            let _ = stdin.write_all(body);
        }
        let output = child
            .wait_with_output()
            .map_err(|error| ConvexFailure::Relay(format!("curl: {error}")))?;
        if !output.status.success() {
            return Err(ConvexFailure::Unreachable(format!(
                "could not reach the cloud: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        let text = output.stdout;
        let split = text.iter().rposition(|&byte| byte == b'\n').unwrap_or(0);
        let (answer, code) = text.split_at(split);
        let code = String::from_utf8_lossy(code).trim().to_owned();
        if code != "200" {
            return Err(ConvexFailure::Relay(format!(
                "cloud storage answered {code}: {}",
                String::from_utf8_lossy(answer)
                    .chars()
                    .take(200)
                    .collect::<String>()
            )));
        }
        Ok(answer.to_vec())
    }
}

use remote::{Acquired, Renewed};

// ---------------------------------------------------------------------------
// The loop.

static SERVER: OnceLock<(Arc<Cloud>, Arc<Store>)> = OnceLock::new();

/// Attaches cloud projects to the server's store and starts the loop.
pub fn start(app: App, cloud: Arc<Cloud>) {
    app.store.attach_cloud(Arc::clone(&cloud));
    let _ = SERVER.set((Arc::clone(&cloud), Arc::clone(&app.store)));
    if cloud.on() {
        crate::diag::info(
            "cloud",
            format!("cloud on as {} ({})", cloud.holder(), crate::relay::url()),
        );
    }
    tokio::spawn(async move {
        loop {
            if cloud.on() {
                let now = Instant::now();
                let due: Vec<(String, Step)> = {
                    let mut projects = cloud.projects.lock();
                    projects
                        .iter_mut()
                        .filter_map(|(id, entry)| {
                            let step = entry.step(now)?;
                            entry.busy = Some(step);
                            Some((id.clone(), step))
                        })
                        .collect()
                };
                for (id, step) in due {
                    let app = app.clone();
                    let cloud = Arc::clone(&cloud);
                    tokio::spawn(async move {
                        if matches!(step, Step::Push | Step::Pull) {
                            cloud.emit(&app.store, &id);
                        }
                        run(&app, &cloud, &id, step).await;
                        cloud.with(&id, |entry| entry.busy = None);
                        cloud.persist();
                        cloud.emit(&app.store, &id);
                        cloud.wake.notify_one();
                    });
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                _ = cloud.wake.notified() => {}
            }
        }
    });
}

async fn off_thread<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())
}

/// Runs one step for `id` (the entry is marked busy meanwhile).
async fn run(app: &App, cloud: &Arc<Cloud>, id: &str, step: Step) {
    let result = match step {
        Step::Pull => pull(app, cloud, id).await,
        Step::Media => {
            cloud.with(id, |entry| entry.want_media = false);
            crate::cloud_media::ensure_local(app, id).await
        }
        Step::Acquire => acquire(app, cloud, id, false).await,
        Step::Push => push(app, cloud, id).await,
        Step::Renew => renew(app, cloud, id).await,
        Step::Release => {
            release(cloud, id).await;
            Ok(())
        }
        Step::Check => check(app, cloud, id).await,
    };
    if let Err(error) = result {
        crate::diag::warn("cloud", format!("{step:?} {id}: {error}"));
        cloud.with(id, |entry| entry.failed(error, Instant::now()));
    }
}

/// Handles a failed call: offline is a retry, a refused lock is someone
/// else's turn, anything else an error.
async fn failure(
    app: &App,
    cloud: &Arc<Cloud>,
    id: &str,
    failure: ConvexFailure,
) -> Result<(), String> {
    if let ConvexFailure::Unreachable(_) = failure {
        cloud.with(id, |entry| entry.unreachable(Instant::now()));
        return Ok(());
    }
    match (failure.code(), &failure) {
        (Some("locked"), ConvexFailure::Function { data, .. }) => {
            let holder = data["heldBy"].as_str().map(str::to_owned);
            match holder.filter(|holder| *holder != cloud.holder()) {
                Some(holder) => Box::pin(lost(app, cloud, id, holder)).await,
                // Expired, or this holder's under another token: take it again.
                None => {
                    cloud.with(id, Entry::forget_lock);
                    Ok(())
                }
            }
        }
        (Some("conflict"), _) => Box::pin(conflict(app, cloud, id)).await,
        _ => Err(failure.to_string()),
    }
}

/// Takes the lock (`force`: from whoever has it), then catches up with the
/// cloud: a newer version is pulled (or, over changes made here, kept beside
/// them as a conflict).
async fn acquire(app: &App, cloud: &Arc<Cloud>, id: &str, force: bool) -> Result<(), String> {
    let holder = cloud.holder();
    let (task_id, task_holder) = (id.to_owned(), holder.clone());
    let acquired = off_thread(move || remote::acquire(&task_id, &task_holder, force)).await?;
    match acquired {
        Ok(Acquired::Got(token)) => {
            cloud.with(id, |entry| entry.acquired(token, Instant::now()));
            catch_up(app, cloud, id).await
        }
        Ok(Acquired::HeldBy(other)) if other == holder => Ok(()),
        Ok(Acquired::HeldBy(other)) => lost(app, cloud, id, other).await,
        Err(error) => failure(app, cloud, id, error).await,
    }
}

/// With the lock just taken: a newer cloud version comes here (a conflict
/// when there are changes here too); a project deleted from the cloud
/// stays on this machine only.
async fn catch_up(app: &App, cloud: &Arc<Cloud>, id: &str) -> Result<(), String> {
    let task_id = id.to_owned();
    let meta = match off_thread(move || remote::get(&task_id)).await? {
        Ok(meta) => meta,
        Err(error) => return failure(app, cloud, id, error).await,
    };
    let (rev, dirty) = (cloud.saved_rev(id), cloud.dirty(id));
    match meta {
        Some(meta) if meta.rev > rev && dirty => conflict(app, cloud, id).await,
        Some(meta) if meta.rev > rev => pull(app, cloud, id).await,
        Some(_) => Ok(()),
        // Deleted from the cloud by a teammate (it had been pushed): this
        // machine's copy stays, as a project here only.
        None if rev > 0 => {
            release(cloud, id).await;
            cloud.forget(id);
            crate::diag::info(
                "cloud",
                format!("{id} was deleted from the cloud; kept on this machine only"),
            );
            Ok(())
        }
        None => Ok(()),
    }
}

/// Takes the cloud's version (and the footage it needs here).
async fn pull(app: &App, cloud: &Arc<Cloud>, id: &str) -> Result<(), String> {
    cloud.with(id, |entry| entry.want_pull = false);
    let task_id = id.to_owned();
    let fetched = off_thread(move || -> Result<Option<(Project, u64)>, ConvexFailure> {
        let Some(meta) = remote::get(&task_id)? else {
            return Ok(None);
        };
        let project = remote::download(&meta.body_url).map_err(ConvexFailure::Relay)?;
        Ok(Some((project, meta.rev)))
    })
    .await?;
    let (project, rev) = match fetched {
        Ok(Some(found)) => found,
        Ok(None) => return Err("it isn't in the cloud any more".to_owned()),
        Err(error) => return failure(app, cloud, id, error).await,
    };
    // Changes made here since are kept, never overwritten.
    if cloud.dirty(id) {
        keep_copy(app, cloud, id, None)?;
    }
    let store = Arc::clone(&app.store);
    let (task_cloud, task_id) = (Arc::clone(cloud), id.to_owned());
    off_thread(move || task_cloud.take(&store, &task_id, project, rev)).await??;
    if let Err(error) = crate::cloud_media::ensure_local(app, id).await {
        crate::diag::warn("cloud", format!("fetching {id}'s footage: {error}"));
    }
    Ok(())
}

/// Keeps this machine's version of `id` as "<name> (conflicted copy)" (on
/// this machine only) and says so.
fn keep_copy(
    app: &App,
    cloud: &Arc<Cloud>,
    id: &str,
    took_over: Option<&str>,
) -> Result<(), String> {
    let Some(live) = app.store.get(id) else {
        return Ok(());
    };
    let name = conflicted_name(&live.project.name);
    let copy = app.store.create_copy(&live.project, &name)?;
    crate::diag::warn(
        "cloud",
        format!(
            "{id}: {}; this machine's changes kept as {} ({name})",
            took_over.map_or("a conflict".to_owned(), |holder| format!(
                "{holder} took over"
            )),
            copy.project.id
        ),
    );
    let message = match took_over {
        Some(holder) => format!(
            "{holder} took over “{}” before your last changes reached the cloud. They're kept as “{name}” on this Mac.",
            live.project.name
        ),
        None => format!(
            "“{}” was changed on another machine meanwhile, so the cloud's version is open. Your changes here are kept as “{name}” on this Mac.",
            live.project.name
        ),
    };
    cloud.with(id, |entry| {
        entry.saved.dirty = false;
        entry.note = Some(Note::Conflict {
            message: message.clone(),
        });
    });
    app.store.emit(json!({
        "type": "cloud-conflict",
        "id": id,
        "message": message,
        "copy": { "id": copy.project.id, "name": name },
    }));
    Ok(())
}

/// The cloud has moved on past this machine's base: keep ours as a copy,
/// take theirs.
async fn conflict(app: &App, cloud: &Arc<Cloud>, id: &str) -> Result<(), String> {
    if cloud.dirty(id) {
        keep_copy(app, cloud, id, None)?;
    }
    pull(app, cloud, id).await
}

/// Someone else has the lock: changes made here become a copy, the editor
/// goes read-only and shows their version.
async fn lost(app: &App, cloud: &Arc<Cloud>, id: &str, holder: String) -> Result<(), String> {
    let had_changes = cloud.dirty(id);
    if had_changes {
        keep_copy(app, cloud, id, Some(&holder))?;
    }
    cloud.with(id, |entry| entry.elsewhere(holder, Instant::now()));
    let task_id = id.to_owned();
    let newer = match off_thread(move || remote::get(&task_id)).await? {
        Ok(Some(meta)) => meta.rev > cloud.saved_rev(id),
        Ok(None) => false,
        Err(error) => return failure(app, cloud, id, error).await,
    };
    if had_changes || newer {
        pull(app, cloud, id).await?;
    }
    Ok(())
}

async fn push(app: &App, cloud: &Arc<Cloud>, id: &str) -> Result<(), String> {
    let Some(live) = app.store.get(id) else {
        cloud.forget(id);
        return Ok(());
    };
    let Some((base, token, edits)) = cloud.with(id, |entry| {
        (entry.saved.rev, entry.saved.token.clone(), entry.edits)
    }) else {
        return Ok(());
    };
    let holder = cloud.holder();
    let started = Instant::now();
    let pushed =
        off_thread(move || remote::push(&live.project, base, token.as_deref(), &holder)).await?;
    match pushed {
        Ok(rev) => {
            crate::diag::record("cloud", "cloud: push", started.elapsed(), None);
            cloud.with(id, |entry| entry.pushed(rev, edits));
            Ok(())
        }
        Err(error) => failure(app, cloud, id, error).await,
    }
}

async fn renew(app: &App, cloud: &Arc<Cloud>, id: &str) -> Result<(), String> {
    let Some(token) = cloud.with(id, |entry| entry.saved.token.clone()).flatten() else {
        cloud.with(id, Entry::forget_lock);
        return Ok(());
    };
    let task_id = id.to_owned();
    match off_thread(move || remote::renew(&task_id, &token)).await? {
        Ok(Renewed::Yes) => {
            cloud.with(id, |entry| {
                entry.renewed_at = Some(Instant::now());
                entry.succeeded();
            });
            Ok(())
        }
        Ok(Renewed::Lost(Some(holder))) if holder != cloud.holder() => {
            lost(app, cloud, id, holder).await
        }
        Ok(Renewed::Lost(_)) => {
            cloud.with(id, Entry::forget_lock);
            Ok(())
        }
        Err(error) => failure(app, cloud, id, error).await,
    }
}

async fn release(cloud: &Arc<Cloud>, id: &str) {
    let token = cloud.with(id, |entry| entry.saved.token.clone()).flatten();
    cloud.with(id, Entry::released);
    if let Some(token) = token {
        let task_id = id.to_owned();
        // Offline, the lease runs out by itself in two minutes.
        let _ = off_thread(move || remote::release(&task_id, &token)).await;
    }
}

/// Someone else holds it and it's open here: when they let go, take it
/// (with their latest version).
async fn check(app: &App, cloud: &Arc<Cloud>, id: &str) -> Result<(), String> {
    cloud.with(id, |entry| entry.checked_at = Some(Instant::now()));
    let task_id = id.to_owned();
    let meta = match off_thread(move || remote::get(&task_id)).await? {
        Ok(Some(meta)) => meta,
        Ok(None) => return Ok(()),
        Err(error) => return failure(app, cloud, id, error).await,
    };
    match meta.holder {
        Some(holder) if holder != cloud.holder() => {
            let newer = meta.rev > cloud.saved_rev(id);
            cloud.with(id, |entry| entry.lock = Lock::Elsewhere { holder });
            if newer {
                pull(app, cloud, id).await?;
            }
            Ok(())
        }
        _ => acquire(app, cloud, id, false).await,
    }
}

// ---------------------------------------------------------------------------
// Requests from the UI (server.rs).

/// Opens `id` in the editor for `client`: a project only in the cloud is
/// downloaded first; the lock is asked for (or who has it found out) before
/// answering, so the editor knows whether it's read-only. Offline answers at
/// once and edits are queued.
pub async fn open(app: &App, id: &str, client: &str) -> Result<Value, String> {
    let Some(cloud) = app.store.cloud().cloned() else {
        return Ok(json!({ "cloud": false, "on": false }));
    };
    if !cloud.on() {
        return Ok(cloud.status(id));
    }
    if app.store.get(id).is_none() {
        download(app, &cloud, id).await?;
    }
    cloud.viewing(id, client);
    let step = cloud.with(id, |entry| {
        // A new look: what was said last time has been seen.
        entry.note = None;
        if entry.busy.is_some() {
            return None;
        }
        let step = match entry.lock {
            Lock::Unknown | Lock::Provisional => Some(Step::Acquire),
            Lock::Elsewhere { .. } => Some(Step::Check),
            Lock::Held => None,
        };
        // A step about to run anyway goes now.
        entry.retry_at = None;
        entry.busy = step;
        step
    });
    if let Some(Some(step)) = step {
        run(app, &cloud, id, step).await;
        cloud.with(id, |entry| entry.busy = None);
        cloud.persist();
        cloud.emit(&app.store, id);
    }
    Ok(cloud.status(id))
}

/// A project only in the cloud, brought to this machine.
async fn download(app: &App, cloud: &Arc<Cloud>, id: &str) -> Result<(), String> {
    if !crate::store::valid_id(id) {
        return Err("no such project".to_owned());
    }
    cloud
        .projects
        .lock()
        .entry(id.to_owned())
        .or_insert_with(|| Entry::new(Saved::default()));
    let task_id = id.to_owned();
    let fetched = off_thread(move || -> Result<Option<(Project, u64)>, String> {
        let Some(meta) = remote::get(&task_id).map_err(|failure| failure.to_string())? else {
            return Ok(None);
        };
        Ok(Some((remote::download(&meta.body_url)?, meta.rev)))
    })
    .await?;
    let (project, rev) = match fetched {
        Ok(Some(found)) => found,
        Ok(None) => {
            cloud.forget(id);
            return Err("no such project".to_owned());
        }
        Err(error) => {
            cloud.forget(id);
            return Err(format!("Couldn't download it from the cloud: {error}"));
        }
    };
    let store = Arc::clone(&app.store);
    let (task_cloud, task_id) = (Arc::clone(cloud), id.to_owned());
    off_thread(move || task_cloud.take(&store, &task_id, project, rev)).await??;
    crate::diag::info(
        "cloud",
        format!("{id} downloaded from the cloud (rev {rev})"),
    );
    if let Err(error) = crate::cloud_media::ensure_local(app, id).await {
        crate::diag::warn("cloud", format!("fetching {id}'s footage: {error}"));
    }
    Ok(())
}

/// Takes the lock from whoever has it and shows their latest version.
pub async fn take_over(app: &App, id: &str) -> Result<Value, String> {
    let cloud = app.store.cloud().cloned().ok_or("cloud is off")?;
    if !cloud.on() || !cloud.is_cloud(id) {
        return Err("this isn't a cloud project".to_owned());
    }
    let mut waited = 0;
    while cloud
        .with(id, |entry| entry.busy.is_some())
        .unwrap_or(false)
        && waited < 300
    {
        tokio::time::sleep(Duration::from_millis(100)).await;
        waited += 1;
    }
    cloud.with(id, |entry| entry.busy = Some(Step::Acquire));
    let result = acquire(app, &cloud, id, true).await;
    cloud.with(id, |entry| entry.busy = None);
    cloud.persist();
    cloud.emit(&app.store, id);
    result?;
    Ok(cloud.status(id))
}

/// Moves a project only on this machine to the cloud (its footage isn't
/// moved by this).
pub async fn move_to_cloud(app: &App, id: &str) -> Result<Value, String> {
    let cloud = app.store.cloud().cloned().ok_or("cloud is off")?;
    if !cloud.on() {
        return Err("Turn cloud on first (Settings → Cloud).".to_owned());
    }
    if app.store.get(id).is_none() {
        return Err("no such project".to_owned());
    }
    cloud.adopt(id);
    cloud.emit(&app.store, id);
    Ok(cloud.status(id))
}

/// Deletes `id` from the cloud (before it's deleted here): refused while
/// someone else is editing it, or while the cloud can't be reached. Whether
/// the cloud had it.
pub async fn delete(app: &App, id: &str) -> Result<bool, String> {
    let Some(cloud) = app.store.cloud().cloned() else {
        return Ok(false);
    };
    let local = app.store.get(id).is_some();
    if !cloud.on() || !crate::store::valid_id(id) {
        cloud.forget(id);
        return Ok(false);
    }
    if local && !cloud.is_cloud(id) {
        return Ok(false);
    }
    let holder = cloud.holder();
    let token = cloud.with(id, |entry| entry.saved.token.clone()).flatten();
    let task_id = id.to_owned();
    let result = off_thread(move || -> Result<bool, ConvexFailure> {
        let token = match token {
            Some(token) => token,
            None => match remote::acquire(&task_id, &holder, false)? {
                Acquired::Got(token) => token,
                Acquired::HeldBy(other) => {
                    return Err(ConvexFailure::Function {
                        message: format!("{other} is editing it."),
                        code: Some("locked".to_owned()),
                        data: Value::Null,
                    })
                }
            },
        };
        remote::delete(&task_id, Some(&token))
    })
    .await?;
    match result {
        Ok(deleted) => {
            cloud.forget(id);
            crate::diag::info("cloud", format!("{id} deleted from the cloud"));
            Ok(deleted)
        }
        Err(ConvexFailure::Unreachable(_)) => Err(
            "Can't reach the cloud to delete it there too; try again when you're online."
                .to_owned(),
        ),
        Err(ConvexFailure::Function {
            message,
            code: Some(code),
            ..
        }) if code == "locked" => Err(format!("Can't delete it: {message}")),
        Err(error) => Err(error.to_string()),
    }
}

/// The cloud's projects for the home screen, with each one's lock (live
/// only), whether it's on this machine, and this machine's statuses.
pub async fn list(app: &App) -> Value {
    let Some(cloud) = app.store.cloud().cloned() else {
        return json!({ "on": false });
    };
    if !cloud.on() {
        return json!({ "on": false, "statuses": cloud.statuses() });
    }
    let holder = cloud.holder();
    let listed = off_thread(remote::list).await;
    let statuses = cloud.statuses();
    match listed {
        Ok(Ok(items)) => {
            let store = Arc::clone(&app.store);
            let projects: Vec<Value> = items
                .into_iter()
                .map(|item| {
                    let id = item["projectId"].as_str().unwrap_or_default().to_owned();
                    let holder_now = remote::live_holder(&item["lock"]);
                    json!({
                        "id": id,
                        "name": item["name"],
                        "rev": item["rev"],
                        "updated_ms": item["updatedAt"],
                        "updated_by": item["updatedBy"],
                        "summary": item["summary"],
                        "holder": holder_now,
                        "here": holder_now.as_deref() == Some(holder.as_str()),
                        "local": crate::store::valid_id(&id) && store.get(&id).is_some(),
                    })
                })
                .collect();
            json!({ "on": true, "holder": holder, "projects": projects, "statuses": statuses })
        }
        Ok(Err(error)) => json!({
            "on": true,
            "holder": holder,
            "offline": matches!(error, ConvexFailure::Unreachable(_)),
            "error": error.to_string(),
            "statuses": statuses,
        }),
        Err(error) => json!({ "on": true, "error": error, "statuses": statuses }),
    }
}

/// On the way out (the window closed, Ctrl-C): pushes what's left and lets
/// every lock go, so a teammate can open them straight away. Blocking, a
/// few seconds at most per project.
pub fn shutdown() {
    let Some((cloud, store)) = SERVER.get() else {
        return;
    };
    if !cloud.on() {
        return;
    }
    let held: Vec<(String, String, bool, u64)> = cloud
        .projects
        .lock()
        .iter()
        .filter_map(|(id, entry)| {
            let token = entry.saved.token.clone()?;
            Some((id.clone(), token, entry.saved.dirty, entry.saved.rev))
        })
        .collect();
    let holder = cloud.holder();
    for (id, token, dirty, base) in held {
        if dirty {
            if let Some(live) = store.get(&id) {
                let edits = cloud.with(&id, |entry| entry.edits).unwrap_or(0);
                match remote::push(&live.project, base, Some(&token), &holder) {
                    Ok(rev) => {
                        cloud.with(&id, |entry| entry.pushed(rev, edits));
                    }
                    // Left dirty: pushed (or kept as a conflict) next time.
                    Err(error) => {
                        crate::diag::warn("cloud", format!("pushing {id} on exit: {error}"))
                    }
                }
            }
        }
        let _ = remote::release(&id, &token);
        cloud.with(&id, Entry::released);
    }
    cloud.persist();
}

// ---------------------------------------------------------------------------
// HTTP routes (merged into `server::router`).

type Reply = Result<Json<Value>, (StatusCode, Json<Value>)>;

fn refuse(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": message.into() })))
}

pub fn routes() -> Router<App> {
    Router::new()
        .route("/api/cloud", get(get_settings).post(post_settings))
        .route("/api/cloud/projects", get(get_list))
        .route("/api/projects/{id}/cloud", get(get_status))
        .route("/api/projects/{id}/cloud/open", post(post_open))
        .route("/api/projects/{id}/cloud/close", post(post_close))
        .route("/api/projects/{id}/cloud/takeover", post(post_takeover))
        .route("/api/projects/{id}/cloud/upload", post(post_upload))
}

#[derive(Deserialize)]
struct Check {
    #[serde(default)]
    check: bool,
}

/// Settings → Cloud, and (`?check=true`) whether the relay takes the token.
async fn get_settings(State(app): State<App>, Query(query): Query<Check>) -> Reply {
    let cloud = app
        .store
        .cloud()
        .cloned()
        .ok_or_else(|| refuse(StatusCode::NOT_FOUND, "no cloud here"))?;
    Ok(Json(settings_reply(&cloud, query.check).await))
}

async fn settings_reply(cloud: &Arc<Cloud>, check: bool) -> Value {
    let mut answer = cloud.settings_status();
    if check && answer["token"].is_string() {
        let task_cloud = Arc::clone(cloud);
        let problem = off_thread(move || task_cloud.connection_problem())
            .await
            .unwrap_or_else(Some);
        answer["connected"] = json!(problem.is_none());
        answer["problem"] = json!(problem);
    }
    answer
}

/// A field that may be absent (unchanged) or null (cleared).
fn present<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
struct SettingsBody {
    #[serde(default, deserialize_with = "present")]
    token: Option<Option<String>>,
    off: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    holder: Option<Option<String>>,
}

async fn post_settings(State(app): State<App>, Json(body): Json<SettingsBody>) -> Reply {
    let cloud = app
        .store
        .cloud()
        .cloned()
        .ok_or_else(|| refuse(StatusCode::NOT_FOUND, "no cloud here"))?;
    let was_on = cloud.on();
    // Let go of this machine's locks while the old token still works.
    let going_off = body.off == Some(true) || matches!(body.token, Some(None));
    if was_on && going_off {
        release_all(&app).await;
    }
    cloud
        .set_settings(body.token, body.off, body.holder)
        .map_err(|error| refuse(StatusCode::BAD_REQUEST, error))?;
    crate::diag::info(
        "cloud",
        if cloud.on() {
            format!("cloud on as {}", cloud.holder())
        } else {
            "cloud off".to_owned()
        },
    );
    app.store
        .emit(json!({ "type": "cloud-settings", "on": cloud.on() }));
    Ok(Json(settings_reply(&cloud, true).await))
}

async fn get_list(State(app): State<App>) -> Json<Value> {
    Json(list(&app).await)
}

async fn get_status(State(app): State<App>, UrlPath(id): UrlPath<String>) -> Json<Value> {
    Json(match app.store.cloud() {
        Some(cloud) => cloud.status(&id),
        None => json!({ "cloud": false, "on": false }),
    })
}

#[derive(Deserialize)]
struct Client {
    #[serde(default)]
    client: String,
    /// Still open (every 30 s): nothing else is done.
    #[serde(default)]
    heartbeat: bool,
}

/// The editor opened `id` (and says so again every 30 s while it's open).
async fn post_open(
    State(app): State<App>,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<Client>,
) -> Reply {
    if body.heartbeat {
        if let Some(cloud) = app.store.cloud() {
            cloud.viewing(&id, &body.client);
            return Ok(Json(cloud.status(&id)));
        }
    }
    open(&app, &id, &body.client)
        .await
        .map(Json)
        .map_err(|error| refuse(StatusCode::NOT_FOUND, error))
}

async fn post_close(
    State(app): State<App>,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<Client>,
) -> Json<Value> {
    if let Some(cloud) = app.store.cloud() {
        cloud.closed(&id, &body.client);
    }
    Json(json!({ "ok": true }))
}

async fn post_takeover(State(app): State<App>, UrlPath(id): UrlPath<String>) -> Reply {
    take_over(&app, &id)
        .await
        .map(Json)
        .map_err(|error| refuse(StatusCode::CONFLICT, error))
}

async fn post_upload(State(app): State<App>, UrlPath(id): UrlPath<String>) -> Reply {
    move_to_cloud(&app, &id)
        .await
        .map(Json)
        .map_err(|error| refuse(StatusCode::BAD_REQUEST, error))
}

/// Lets go of every lock (cloud switched off).
pub async fn release_all(app: &App) {
    let Some(cloud) = app.store.cloud().cloned() else {
        return;
    };
    let held: Vec<String> = cloud
        .projects
        .lock()
        .iter()
        .filter(|(_, entry)| entry.saved.token.is_some())
        .map(|(id, _)| id.clone())
        .collect();
    for id in held {
        release(&cloud, &id).await;
    }
    cloud.persist();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(start: Instant, secs: u64) -> Instant {
        start + Duration::from_secs(secs)
    }

    #[test]
    fn a_new_project_takes_the_lock_then_pushes_after_a_pause() {
        let t0 = Instant::now();
        let mut entry = Entry::fresh();
        assert_eq!(entry.lock, Lock::Provisional);
        // New: dirty from the start, so the lock is asked for straight away.
        assert_eq!(entry.step(t0), Some(Step::Acquire));
        entry.acquired("token".into(), t0);
        entry.wrote(t0);
        // Edits keep coming: the push waits for a pause.
        assert_eq!(entry.step(at(t0, 1)), None);
        entry.wrote(at(t0, 1));
        assert_eq!(entry.step(at(t0, 2)), None);
        assert_eq!(entry.step(at(t0, 3)), Some(Step::Push));
        // A change during the push keeps it dirty for another.
        let edits = entry.edits;
        entry.wrote(at(t0, 3));
        entry.pushed(1, edits);
        assert!(entry.saved.dirty);
        assert_eq!(entry.saved.rev, 1);
        assert_eq!(entry.step(at(t0, 6)), Some(Step::Push));
        entry.pushed(2, entry.edits);
        assert!(!entry.saved.dirty);
        assert_eq!(entry.status(true)["sync"], "synced");
    }

    #[test]
    fn a_held_lock_is_renewed_while_used_and_let_go_when_idle() {
        let t0 = Instant::now();
        let mut entry = Entry::new(Saved::default());
        entry.viewers.insert("ui".into(), t0);
        assert_eq!(entry.step(t0), Some(Step::Acquire));
        entry.acquired("token".into(), t0);
        assert_eq!(entry.step(at(t0, 10)), None);
        entry.viewers.insert("ui".into(), at(t0, 30));
        assert_eq!(entry.step(at(t0, 45)), Some(Step::Renew));
        entry.renewed_at = Some(at(t0, 45));
        // The editor goes quiet (crashed, no close): let go once it's stale.
        assert_eq!(entry.step(at(t0, 90)), Some(Step::Renew));
        entry.renewed_at = Some(at(t0, 90));
        assert_eq!(entry.step(at(t0, 106)), Some(Step::Release));
        entry.released();
        assert_eq!(entry.lock, Lock::Unknown);
        assert_eq!(entry.saved.token, None);
        assert_eq!(entry.step(at(t0, 107)), None);
    }

    #[test]
    fn closing_pushes_at_once_then_releases() {
        let t0 = Instant::now();
        let mut entry = Entry::new(Saved {
            rev: 3,
            dirty: false,
            token: Some("t".into()),
        });
        entry.renewed_at = Some(t0);
        entry.viewers.insert("ui".into(), t0);
        entry.wrote(t0);
        entry.viewers.clear();
        entry.closing = true;
        // No waiting for the pause.
        assert_eq!(entry.step(t0), Some(Step::Push));
        entry.pushed(4, entry.edits);
        assert_eq!(entry.step(t0), Some(Step::Release));
        // Let go, it stays let go (the recent change doesn't take it again).
        let mut released = Entry::new(entry.saved.clone());
        released.changed_at = entry.changed_at;
        released.released();
        assert_eq!(released.step(at(t0, 1)), None);
        // An agent still writing keeps it.
        entry.wrote(at(t0, 1));
        assert!(!entry.closing);
        assert_eq!(entry.step(at(t0, 1)), None);
    }

    #[test]
    fn offline_edits_are_allowed_and_retried_with_backoff() {
        let t0 = Instant::now();
        let mut entry = Entry::new(Saved {
            rev: 2,
            dirty: false,
            token: None,
        });
        entry.wrote(t0);
        assert_eq!(entry.step(t0), Some(Step::Acquire));
        entry.unreachable(t0);
        // Unknown becomes provisional: edits go on, queued.
        assert_eq!(entry.lock, Lock::Provisional);
        assert_eq!(entry.status(true)["sync"], "offline");
        assert_eq!(entry.step(at(t0, 4)), None);
        assert_eq!(entry.step(at(t0, 5)), Some(Step::Acquire));
        entry.unreachable(at(t0, 5));
        assert_eq!(entry.step(at(t0, 14)), None);
        assert_eq!(entry.step(at(t0, 15)), Some(Step::Acquire));
        for _ in 0..10 {
            entry.unreachable(at(t0, 15));
        }
        assert_eq!(entry.retry_at, Some(at(t0, 15) + BACKOFF_MAX));
        entry.acquired("t".into(), at(t0, 100));
        assert!(!entry.offline);
        assert_eq!(entry.step(at(t0, 100)), Some(Step::Push));
    }

    #[test]
    fn someone_elses_lock_is_read_only_and_watched_while_open() {
        let t0 = Instant::now();
        let mut entry = Entry::new(Saved::default());
        entry.elsewhere("kenobi".into(), t0);
        let status = entry.status(true);
        assert_eq!(status["sync"], "readonly");
        assert_eq!(status["holder"], "kenobi");
        // Nobody here looking: left alone.
        assert_eq!(entry.step(at(t0, 30)), None);
        entry.viewers.insert("ui".into(), at(t0, 30));
        assert_eq!(entry.step(at(t0, 30)), Some(Step::Check));
        entry.checked_at = Some(at(t0, 30));
        assert_eq!(entry.step(at(t0, 35)), None);
        assert_eq!(entry.step(at(t0, 40)), Some(Step::Check));
        // A pull asked for goes first, whatever the lock.
        entry.want_pull = true;
        assert_eq!(entry.step(at(t0, 41)), Some(Step::Pull));
    }

    #[test]
    fn a_busy_entry_waits_and_cloud_off_says_so() {
        let t0 = Instant::now();
        let mut entry = Entry::fresh();
        entry.busy = Some(Step::Acquire);
        assert_eq!(entry.step(t0), None);
        assert_eq!(entry.status(false)["sync"], "off");
        entry.busy = Some(Step::Push);
        assert_eq!(entry.status(true)["sync"], "syncing");
        entry.busy = None;
        entry.note = Some(Note::Conflict {
            message: "kept".into(),
        });
        assert_eq!(entry.status(true)["sync"], "conflict");
        assert_eq!(entry.status(true)["message"], "kept");
        entry.pushed(1, entry.edits);
        assert_eq!(entry.status(true)["sync"], "synced");
    }

    #[test]
    fn a_token_from_before_a_restart_is_renewed_first() {
        let entry = Entry::new(Saved {
            rev: 5,
            dirty: false,
            token: Some("old".into()),
        });
        assert_eq!(entry.lock, Lock::Held);
        let mut entry = entry;
        entry.viewers.insert("ui".into(), Instant::now());
        assert_eq!(entry.step(Instant::now()), Some(Step::Renew));
    }

    #[test]
    fn settings_are_private_and_writes_follow_the_lock() {
        let home = std::env::temp_dir().join(format!(
            "edit-cloud-settings-{}-{}",
            std::process::id(),
            crate::store::now_ms()
        ));
        std::fs::create_dir_all(&home).unwrap();
        // The setting holds the token: this user only.
        let settings = Settings {
            token: Some("secret-token".into()),
            off: true,
            holder: Some("Sphe's Mac".into()),
        };
        write_private(
            &home.join(SETTINGS),
            &serde_json::to_vec(&settings).unwrap(),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(home.join(SETTINGS))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(read_settings(&home), settings);

        // Writes follow the lock: someone else's is refused, saying who.
        let mut entry = Entry::new(Saved::default());
        assert_eq!(entry.permission(), Permission::Ask);
        entry.elsewhere("kenobi".into(), Instant::now());
        match entry.permission() {
            Permission::Refuse(why) => assert!(why.starts_with("kenobi is editing"), "{why}"),
            other => panic!("{other:?}"),
        }
        entry.acquired("t".into(), Instant::now());
        assert_eq!(entry.permission(), Permission::Allow);
        assert_eq!(Entry::fresh().permission(), Permission::Allow);

        // What's kept per project survives a restart (no global settings
        // touched: `Cloud::open` isn't used here).
        let cloud = Cloud {
            home: home.clone(),
            machine: "kenobi".into(),
            settings: Mutex::new(settings),
            projects: Mutex::new(HashMap::new()),
            wake: tokio::sync::Notify::new(),
        };
        cloud.projects.lock().insert("p3-3".into(), Entry::fresh());
        cloud.wrote("p3-3");
        cloud.projects.lock().insert(
            "p4-4".into(),
            Entry::new(Saved {
                rev: 9,
                dirty: false,
                token: Some("lock".into()),
            }),
        );
        cloud.persist();
        let mode = std::fs::metadata(home.join(STATE_DIR).join(STATE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        let kept: HashMap<String, Saved> =
            serde_json::from_slice(&std::fs::read(home.join(STATE_DIR).join(STATE)).unwrap())
                .unwrap();
        assert!(kept["p3-3"].dirty);
        assert_eq!(kept["p4-4"].rev, 9);
        assert_eq!(Entry::new(kept["p4-4"].clone()).lock, Lock::Held);
        if std::env::var_os("EDIT_CLOUD_HOLDER").is_none() {
            assert_eq!(cloud.holder(), "Sphe's Mac");
        }
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn summaries_and_copies_read_well() {
        let project = Project::new("p1-1".into(), "Case".into(), edit_core::Settings::default());
        let summary = summary(&project);
        assert_eq!(summary["clips"], 0);
        assert_eq!(summary["fps"], project.settings.fps);
        assert!(summary.to_string().len() < 64 * 1024);
        assert_eq!(conflicted_name("Case"), "Case (conflicted copy)");
        assert_eq!(
            remote::live_holder(
                &json!({"holder": "kenobi", "until": crate::store::now_ms() + 60_000})
            ),
            Some("kenobi".to_owned())
        );
        assert_eq!(
            remote::live_holder(&json!({"holder": "kenobi", "until": 1})),
            None
        );
        assert_eq!(remote::live_holder(&Value::Null), None);
    }
}
