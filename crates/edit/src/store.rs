//! Projects on disk plus the live revision every client and agent edits against.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use edit_core::{Project, Settings};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;

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
            let Some(live) = self.get(id) else {
                continue;
            };
            let modified_ms = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |duration| duration.as_millis() as u64);
            out.push(ProjectSummary {
                id: live.project.id.clone(),
                name: live.project.name.clone(),
                modified_ms,
                width: live.project.settings.width,
                height: live.project.settings.height,
                fps: live.project.settings.fps,
                duration_frames: live.project.duration(),
                clips: live.project.clips.len(),
            });
        }
        out.sort_by_key(|summary| std::cmp::Reverse(summary.modified_ms));
        out
    }

    pub fn get(&self, id: &str) -> Option<Live> {
        if !valid_id(id) {
            return None;
        }
        let mut projects = self.projects.lock().unwrap();
        if let Some(live) = projects.get(id) {
            return Some(live.clone());
        }
        let text = std::fs::read_to_string(self.path(id)).ok()?;
        let project: Project = serde_json::from_str(&text).ok()?;
        if project.id != id || project.validate().is_err() {
            return None;
        }
        let live = Live { rev: 1, project };
        projects.insert(id.to_owned(), live.clone());
        Some(live)
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
        self.projects.lock().unwrap().insert(id, live.clone());
        Ok(live)
    }

    pub fn delete(&self, id: &str) -> bool {
        if !valid_id(id) {
            return false;
        }
        let mut projects = self.projects.lock().unwrap();
        projects.remove(id);
        let mut active = self.active.lock().unwrap();
        if active.as_deref() == Some(id) {
            *active = None;
        }
        let _ = std::fs::remove_file(self.chat_path(id));
        std::fs::remove_file(self.path(id)).is_ok()
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
        let mut projects = self.projects.lock().unwrap();
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
        write_atomic(
            &self.path(&project.id),
            &serde_json::to_vec_pretty(project)?,
        )
    }

    pub fn set_active(&self, id: &str) {
        *self.active.lock().unwrap() = Some(id.to_owned());
    }

    /// Explicit id, else the project the UI has open, else the most recent.
    pub fn resolve(&self, id: Option<&str>) -> Result<String, String> {
        if let Some(id) = id.filter(|id| !id.is_empty()) {
            return self
                .get(id)
                .map(|_| id.to_owned())
                .ok_or_else(|| format!("no project {id}"));
        }
        if let Some(id) = self.active.lock().unwrap().clone() {
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
