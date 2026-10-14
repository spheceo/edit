//! Projects on disk plus the live revision every client and agent edits against.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use edit_core::{Project, Settings};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;

/// How often a project's previous version is kept, and how many are kept.
const HISTORY_EVERY_MS: u64 = 10 * 60 * 1000;
const HISTORY_KEEP: usize = 30;

pub struct Store {
    home: PathBuf,
    projects: Mutex<HashMap<String, Live>>,
    /// The project the UI opened last; agent tools default to it.
    active: Mutex<Option<String>>,
    events: broadcast::Sender<Value>,
}

#[derive(Clone)]
pub struct Live {
    pub rev: u64,
    pub project: Project,
}

#[derive(Serialize)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub modified_ms: u64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub duration_frames: i64,
    pub clips: usize,
    /// Why it can't be opened (its file is kept as it is).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

pub enum UpdateError {
    NotFound,
    Conflict(Box<Live>),
    Invalid(String),
}

impl Store {
    pub fn open(home: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(home.join("projects"))?;
        std::fs::create_dir_all(home.join("cache"))?;
        let (events, _) = broadcast::channel(256);
        Ok(Self {
            home,
            projects: Mutex::new(HashMap::new()),
            active: Mutex::new(None),
            events,
        })
    }

    pub fn cache_dir(&self) -> PathBuf {
        self.home.join("cache")
    }

    /// Edit's data folder (~/.edit).
    pub fn home(&self) -> &Path {
        &self.home
    }

    /// Where footage downloaded from Google Drive is kept, one folder per file (shared by projects).
    pub fn drive_dir(&self) -> PathBuf {
        self.home.join("media").join("drive")
    }

    /// Where footage uploaded from other devices is kept, per project.
    pub fn uploads_dir(&self, project: &str) -> PathBuf {
        self.home.join("media").join(project)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }

    pub fn emit(&self, event: Value) {
        let _ = self.events.send(event);
    }

    fn path(&self, id: &str) -> PathBuf {
        self.home.join("projects").join(format!("{id}.json"))
    }

    /// The project's agent chat, kept beside it (and deleted with it).
    pub fn chat_path(&self, id: &str) -> PathBuf {
        self.home.join("projects").join(format!("{id}.chat.json"))
    }

    pub fn list(&self) -> Vec<ProjectSummary> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(self.home.join("projects")) else {
            return out;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let modified_ms = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |duration| duration.as_millis() as u64);
            let live = match self.load(id) {
                Ok(live) => live,
                // Shown, not hidden: a project that won't open must not look deleted.
                Err(Some(problem)) => {
                    let name = std::fs::read(&path)
                        .ok()
                        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                        .and_then(|value| value.get("name")?.as_str().map(str::to_owned))
                        .unwrap_or_else(|| id.to_owned());
                    out.push(ProjectSummary {
                        id: id.to_owned(),
                        name,
                        modified_ms,
                        width: 0,
                        height: 0,
                        fps: 0,
                        duration_frames: 0,
                        clips: 0,
                        problem: Some(problem),
                    });
                    continue;
                }
                Err(None) => continue,
            };
            out.push(ProjectSummary {
                id: live.project.id.clone(),
                name: live.project.name.clone(),
                modified_ms,
                width: live.project.settings.width,
                height: live.project.settings.height,
                fps: live.project.settings.fps,
                duration_frames: live.project.duration(),
                clips: live.project.clips.len(),
                problem: None,
            });
        }
        out.sort_by_key(|summary| std::cmp::Reverse(summary.modified_ms));
        out
    }

    pub fn get(&self, id: &str) -> Option<Live> {
        self.load(id).ok()
    }

    /// The project, or why not: `None` when there's no such project, else
    /// what's wrong with its file (which is left untouched).
    fn load(&self, id: &str) -> Result<Live, Option<String>> {
        if !valid_id(id) {
            return Err(None);
        }
        let mut projects = self.projects.lock();
        if let Some(live) = projects.get(id) {
            return Ok(live.clone());
        }
        let text = match std::fs::read_to_string(self.path(id)) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(None),
            Err(error) => return Err(Some(format!("can't read it: {error}"))),
        };
        let problem = match serde_json::from_str::<Project>(&text) {
            Ok(project) if project.id != id => format!("its file holds project {}", project.id),
            Ok(project) => match project.validate() {
                Ok(()) => {
                    let live = Live { rev: 1, project };
                    projects.insert(id.to_owned(), live.clone());
                    return Ok(live);
                }
                Err(error) => format!("it doesn't validate: {error}"),
            },
            Err(error) => format!("it can't be read: {error}"),
        };
        Err(Some(problem))
    }

    pub fn create(&self, name: &str, settings: Settings) -> Result<Live, String> {
        let id = format!("p{}-{}", now_ms(), next_file_id());
        let name = if name.trim().is_empty() {
            "Untitled"
        } else {
            name.trim()
        };
        let project = Project::new(id.clone(), name.to_owned(), settings);
        project.validate()?;
        self.write(&project).map_err(|error| error.to_string())?;
        let live = Live { rev: 1, project };
        self.projects.lock().insert(id, live.clone());
        Ok(live)
    }

    pub fn delete(&self, id: &str) -> bool {
        if !valid_id(id) {
            return false;
        }
        let mut projects = self.projects.lock();
        projects.remove(id);
        let mut active = self.active.lock();
        if active.as_deref() == Some(id) {
            *active = None;
        }
        // Kept aside rather than erased, so a deletion can be undone by hand.
        let bin = self.home.join("projects").join("deleted");
        let _ = std::fs::create_dir_all(&bin);
        let stamp = now_ms();
        let _ = std::fs::rename(
            self.chat_path(id),
            bin.join(format!("{id}-{stamp}.chat.json")),
        );
        std::fs::rename(self.path(id), bin.join(format!("{id}-{stamp}.json"))).is_ok()
    }

    /// Replaces the project if `base_rev` is current. `origin` lets clients skip their own echo.
    pub fn replace(
        &self,
        id: &str,
        base_rev: Option<u64>,
        mut project: Project,
        origin: &str,
    ) -> Result<Live, UpdateError> {
        let current = self.get(id).ok_or(UpdateError::NotFound)?;
        if base_rev.is_some_and(|rev| rev != current.rev) {
            return Err(UpdateError::Conflict(Box::new(current)));
        }
        project.id = id.to_owned();
        project.validate().map_err(UpdateError::Invalid)?;
        self.commit(id, current.rev, project, origin)
    }

    /// Read-modify-write used by agent tools and server-side edits.
    pub fn update<T>(
        &self,
        id: &str,
        origin: &str,
        edit: impl FnOnce(&mut Project) -> Result<T, String>,
    ) -> Result<(Live, T), String> {
        let current = self.get(id).ok_or_else(|| format!("no project {id}"))?;
        let mut project = current.project.clone();
        let value = edit(&mut project)?;
        project.id = id.to_owned();
        project.validate()?;
        let live = self
            .commit(id, current.rev, project, origin)
            .map_err(|error| match error {
                UpdateError::NotFound => "project was deleted while editing".to_owned(),
                UpdateError::Conflict(_) => "project changed while editing; retry".to_owned(),
                UpdateError::Invalid(error) => error,
            })?;
        Ok((live, value))
    }

    fn commit(
        &self,
        id: &str,
        rev: u64,
        project: Project,
        origin: &str,
    ) -> Result<Live, UpdateError> {
        let mut projects = self.projects.lock();
        // Another writer may have landed between read and commit.
        let current = projects.get(id).ok_or(UpdateError::NotFound)?;
        if current.rev != rev {
            return Err(UpdateError::Conflict(Box::new(current.clone())));
        }
        self.write(&project)
            .map_err(|error| UpdateError::Invalid(error.to_string()))?;
        let live = Live {
            rev: rev + 1,
            project,
        };
        projects.insert(id.to_owned(), live.clone());
        drop(projects);
        self.emit(json!({
            "type": "project",
            "id": id,
            "rev": live.rev,
            "origin": origin,
            "project": live.project,
        }));
        Ok(live)
    }

    fn write(&self, project: &Project) -> std::io::Result<()> {
        let path = self.path(&project.id);
        // A bad save (a bug, an agent gone wrong) can always be walked back.
        if let Err(error) = self.keep_history(&project.id, &path) {
            crate::diag::warn(
                "store",
                format!("keeping history for {}: {error}", project.id),
            );
        }
        write_atomic(&path, &serde_json::to_vec_pretty(project)?)
    }

    /// Copies the saved file to `projects/history/<id>/` before it's replaced,
    /// at most every `HISTORY_EVERY`, keeping the last `HISTORY_KEEP`.
    fn keep_history(&self, id: &str, path: &Path) -> std::io::Result<()> {
        if !path.is_file() {
            return Ok(());
        }
        let dir = self.home.join("projects").join("history").join(id);
        std::fs::create_dir_all(&dir)?;
        let mut kept: Vec<(u64, PathBuf)> = std::fs::read_dir(&dir)?
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                let stamp = path.file_stem()?.to_str()?.parse().ok()?;
                Some((stamp, path))
            })
            .collect();
        kept.sort_unstable();
        let now = now_ms();
        if kept
            .last()
            .is_some_and(|(stamp, _)| now.saturating_sub(*stamp) < HISTORY_EVERY_MS)
        {
            return Ok(());
        }
        std::fs::copy(path, dir.join(format!("{now}.json")))?;
        kept.push((now, PathBuf::new()));
        for (_, old) in kept.iter().take(kept.len().saturating_sub(HISTORY_KEEP)) {
            let _ = std::fs::remove_file(old);
        }
        Ok(())
    }

    pub fn set_active(&self, id: &str) {
        *self.active.lock() = Some(id.to_owned());
    }

    /// Explicit id, else the project the UI has open, else the most recent.
    pub fn resolve(&self, id: Option<&str>) -> Result<String, String> {
        if let Some(id) = id.filter(|id| !id.is_empty()) {
            return self
                .get(id)
                .map(|_| id.to_owned())
                .ok_or_else(|| format!("no project {id}"));
        }
        if let Some(id) = self.active.lock().clone() {
            return Ok(id);
        }
        self.list()
            .first()
            .map(|summary| summary.id.clone())
            .ok_or_else(|| "no projects yet; create one in the UI first".to_owned())
    }
}

/// Writes through a temporary file, so a crash mid-write leaves the old file whole.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{}-{}.tmp", std::process::id(), next_file_id()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn next_file_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_lost_quietly() {
        let dir = std::env::temp_dir().join(format!(
            "edit-store-safety-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let store = Store::open(dir.clone()).unwrap();
        // A file that won't parse is listed with why, not hidden, and left alone.
        let broken = dir.join("projects").join("p1-1.json");
        std::fs::write(&broken, br#"{"id": "p1-1", "name": "Old one", "clips": 7}"#).unwrap();
        let listed = store.list();
        let summary = listed.iter().find(|summary| summary.id == "p1-1").unwrap();
        assert_eq!(summary.name, "Old one");
        assert!(summary
            .problem
            .as_deref()
            .unwrap()
            .contains("can't be read"));
        assert!(store.get("p1-1").is_none());
        assert!(broken.is_file());

        // Saving keeps the previous version (once per interval).
        let live = store.create("kept", Settings::default()).unwrap();
        let id = live.project.id.clone();
        let mut renamed = live.project.clone();
        renamed.name = "renamed".into();
        store
            .replace(&id, Some(live.rev), renamed.clone(), "test")
            .ok()
            .unwrap();
        store.replace(&id, None, renamed, "test").ok().unwrap();
        let history: Vec<_> = std::fs::read_dir(dir.join("projects/history").join(&id))
            .unwrap()
            .collect();
        assert_eq!(history.len(), 1);

        // Deleting moves it aside.
        assert!(store.delete(&id));
        assert!(store.get(&id).is_none());
        let bin: Vec<String> = std::fs::read_dir(dir.join("projects/deleted"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(bin
            .iter()
            .any(|name| name.starts_with(&id) && name.ends_with(".json")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn stale_writer_gets_a_conflict_and_deleted_projects_stay_deleted() {
        let dir = std::env::temp_dir().join(format!(
            "edit-store-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let store = Store::open(dir.clone()).unwrap();
        let original = store.create("test", Settings::default()).unwrap();
        let newer = store
            .replace(
                &original.project.id,
                Some(original.rev),
                original.project.clone(),
                "test",
            )
            .ok()
            .unwrap();
        assert!(matches!(
            store.commit(
                &original.project.id,
                original.rev,
                original.project.clone(),
                "stale"
            ),
            Err(UpdateError::Conflict(_))
        ));
        assert!(store.delete(&original.project.id));
        assert!(matches!(
            store.commit(&original.project.id, newer.rev, newer.project, "late"),
            Err(UpdateError::NotFound)
        ));
        assert!(store.get(&original.project.id).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn simultaneous_project_creation_does_not_overwrite_projects() {
        let dir = std::env::temp_dir().join(format!(
            "edit-create-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let store = Store::open(dir.clone()).unwrap();
        let ids: std::collections::HashSet<_> = (0..100)
            .map(|_| {
                store
                    .create("test", Settings::default())
                    .unwrap()
                    .project
                    .id
            })
            .collect();
        assert_eq!(ids.len(), 100);
        assert_eq!(store.list().len(), 100);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
