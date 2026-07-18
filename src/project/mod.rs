//! Project domain: versioned `.kuro` persistence, autosave/recovery, recent
//! projects, editor snapshots, and the editable sequence model.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::media::export::ExportSettings;

pub mod sequence;
pub use sequence::{EditTool, Sequence};

pub const PROJECT_VERSION: u32 = 3;
pub const MAX_HISTORY: usize = 100;
pub const DEFAULT_TIMELINE_HEIGHT: f32 = 340.0;
pub const MIN_TIMELINE_HEIGHT: f32 = 150.0;
pub const MAX_TIMELINE_HEIGHT: f32 = 520.0;

fn default_timeline_height() -> f32 {
    DEFAULT_TIMELINE_HEIGHT
}
pub const AUTOSAVE_DELAY: Duration = Duration::from_millis(700);

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ProjectSettings {
    pub aspect_width: u32,
    pub aspect_height: u32,
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            aspect_width: 16,
            aspect_height: 9,
            width: 1920,
            height: 1080,
            frame_rate: 30.0,
        }
    }
}

impl ProjectSettings {
    pub fn aspect_label(&self) -> String {
        format!("{}:{}", self.aspect_width, self.aspect_height)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct TranscriptWord {
    pub text: String,
    pub start_secs: f64,
    pub end_secs: f64,
}

impl TranscriptWord {
    /// A short fade at word boundaries keeps the playhead highlight from
    /// snapping between words while retaining exact sequence-time sync.
    pub fn highlight_strength(&self, sequence_time: f64) -> f32 {
        const FADE_SECS: f64 = 0.10;
        let fade_in = ((sequence_time - self.start_secs + FADE_SECS) / FADE_SECS).clamp(0.0, 1.0);
        let fade_out = ((self.end_secs + FADE_SECS - sequence_time) / FADE_SECS).clamp(0.0, 1.0);
        smoothstep(fade_in.min(fade_out)) as f32
    }

    pub fn contains(&self, sequence_time: f64) -> bool {
        sequence_time >= self.start_secs && sequence_time < self.end_secs
    }
}

fn smoothstep(value: f64) -> f64 {
    value * value * (3.0 - 2.0 * value)
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct Transcript {
    pub words: Vec<TranscriptWord>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub generated_unix_ms: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct MediaReference {
    pub id: u64,
    pub path: PathBuf,
    pub name: String,
    #[serde(default)]
    pub managed: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct EditorProjectState {
    pub current_time: f64,
    pub timeline_zoom: f32,
    #[serde(default = "default_timeline_height")]
    pub timeline_height: f32,
    pub tool: EditTool,
    pub export_settings: ExportSettings,
}

impl Default for EditorProjectState {
    fn default() -> Self {
        Self {
            current_time: 0.0,
            timeline_zoom: 1.0,
            timeline_height: DEFAULT_TIMELINE_HEIGHT,
            tool: EditTool::Select,
            export_settings: ExportSettings::default(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ProjectDocument {
    pub version: u32,
    pub name: String,
    pub modified_unix_ms: u64,
    pub settings: ProjectSettings,
    pub media: Vec<MediaReference>,
    pub active_media_id: Option<u64>,
    pub sequence: Option<Sequence>,
    #[serde(default)]
    pub transcript: Option<Transcript>,
    pub editor: EditorProjectState,
}

impl ProjectDocument {
    pub fn empty(name: String, settings: ProjectSettings) -> Self {
        Self {
            version: PROJECT_VERSION,
            name,
            modified_unix_ms: unix_millis(),
            settings,
            media: Vec::new(),
            active_media_id: None,
            sequence: None,
            transcript: None,
            editor: EditorProjectState::default(),
        }
    }

    pub fn active_media(&self) -> Option<&MediaReference> {
        let active = self.active_media_id?;
        self.media.iter().find(|media| media.id == active)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct RecentProject {
    pub name: String,
    pub path: PathBuf,
    pub opened_unix_ms: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct RecentProjectsFile {
    projects: Vec<RecentProject>,
}

#[derive(Clone, Debug)]
pub struct NewProjectDraft {
    pub name: String,
    pub directory: PathBuf,
    pub settings: ProjectSettings,
}

impl Default for NewProjectDraft {
    fn default() -> Self {
        Self {
            name: "Untitled Project".to_owned(),
            directory: default_project_directory(),
            settings: ProjectSettings::default(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ProjectSession {
    pub path: PathBuf,
    pub document: ProjectDocument,
    pub recovered: bool,
    pub dirty_since: Option<Instant>,
    pub last_signature: String,
    last_observed_signature: String,
}

impl ProjectSession {
    pub fn new(path: PathBuf, document: ProjectDocument) -> Result<Self, String> {
        let mut session = Self {
            path,
            document,
            recovered: false,
            dirty_since: None,
            last_signature: String::new(),
            last_observed_signature: String::new(),
        };
        session.save()?;
        session.last_signature = document_signature(&session.document)?;
        session.last_observed_signature = session.last_signature.clone();
        Ok(session)
    }

    pub fn open(path: PathBuf) -> Result<Self, String> {
        let main = read_document(&path);
        let recovery_path = recovery_path(&path);
        let recovery = read_document(&recovery_path);
        let (mut document, recovered) = match (main, recovery) {
            (Ok(main), Ok(recovery)) if recovery.modified_unix_ms > main.modified_unix_ms => {
                (recovery, true)
            }
            (Ok(main), _) => (main, false),
            (Err(_), Ok(recovery)) => (recovery, true),
            (Err(main_error), Err(_)) => return Err(main_error),
        };
        if document.version > PROJECT_VERSION {
            return Err(format!(
                "This project uses Kuro project format version {}, but this build supports up to version {}.",
                document.version, PROJECT_VERSION
            ));
        }
        if document.version < 2 {
            let legacy_media_id = document
                .active_media_id
                .or_else(|| document.media.first().map(|media| media.id))
                .unwrap_or(1);
            if let Some(sequence) = &mut document.sequence {
                for clip in &mut sequence.clips {
                    clip.media_id = legacy_media_id;
                }
            }
            document.version = PROJECT_VERSION;
        }
        if let Some(sequence) = &mut document.sequence {
            sequence.recompute_duration();
        }
        let last_signature = document_signature(&document)?;
        Ok(Self {
            path,
            document,
            recovered,
            dirty_since: None,
            last_observed_signature: last_signature.clone(),
            last_signature,
        })
    }

    pub fn observe_changes(&mut self) -> Result<(), String> {
        let signature = document_signature(&self.document)?;
        if signature != self.last_observed_signature {
            self.dirty_since = Some(Instant::now());
            self.last_observed_signature = signature;
        }
        Ok(())
    }

    pub fn autosave_if_due(&mut self) -> Result<bool, String> {
        if self
            .dirty_since
            .is_some_and(|changed| changed.elapsed() >= AUTOSAVE_DELAY)
        {
            self.save()?;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn save(&mut self) -> Result<(), String> {
        self.document.version = PROJECT_VERSION;
        self.document.modified_unix_ms = unix_millis();
        let json = serde_json::to_vec_pretty(&self.document)
            .map_err(|error| format!("Could not serialize the project: {error}"))?;
        atomic_write(&recovery_path(&self.path), &json)?;
        atomic_write(&self.path, &json)?;
        self.last_signature = document_signature(&self.document)?;
        self.last_observed_signature = self.last_signature.clone();
        self.dirty_since = None;
        self.recovered = false;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct EditorSnapshot {
    pub sequence: Option<Sequence>,
    pub current_time: f64,
    pub timeline_zoom: f32,
    pub timeline_height: f32,
    pub tool: EditTool,
    pub export_settings: ExportSettings,
}

pub fn project_path(directory: &Path, name: &str) -> PathBuf {
    let file_name = sanitize_project_name(name);
    directory.join(format!("{file_name}.kuro"))
}

pub fn default_project_directory() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Documents")
        .join("Kuro")
}

pub fn load_recent_projects() -> Vec<RecentProject> {
    let path = recent_projects_path();
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<RecentProjectsFile>(&bytes).ok())
        .map_or_else(Vec::new, |file| {
            file.projects
                .into_iter()
                .filter(|project| project.path.exists())
                .take(12)
                .collect()
        })
}

pub fn remember_recent_project(project: RecentProject) -> Result<Vec<RecentProject>, String> {
    let mut projects = load_recent_projects();
    projects.retain(|existing| existing.path != project.path);
    projects.insert(0, project);
    projects.truncate(12);
    let bytes = serde_json::to_vec_pretty(&RecentProjectsFile {
        projects: projects.clone(),
    })
    .map_err(|error| format!("Could not serialize recent projects: {error}"))?;
    atomic_write(&recent_projects_path(), &bytes)?;
    Ok(projects)
}

pub fn recent_entry(name: String, path: PathBuf) -> RecentProject {
    RecentProject {
        name,
        path,
        opened_unix_ms: unix_millis(),
    }
}

fn read_document(path: &Path) -> Result<ProjectDocument, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Could not read the Kuro project: {error}"))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The project path has no parent directory.".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let temporary = path.with_extension(format!(
        "{}.tmp",
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("kuro")
    ));
    let mut file = fs::File::create(&temporary)
        .map_err(|error| format!("Could not create {}: {error}", temporary.display()))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Could not write {}: {error}", temporary.display()))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("Could not replace {}: {error}", path.display()))
}

fn recovery_path(path: &Path) -> PathBuf {
    path.with_extension("kuro.recovery")
}

fn recent_projects_path() -> PathBuf {
    default_project_directory().join(".recent-projects.json")
}

fn sanitize_project_name(name: &str) -> String {
    let sanitized = name
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' => '-',
            other => other,
        })
        .collect::<String>();
    let sanitized = sanitized.trim().trim_matches('.');
    if sanitized.is_empty() {
        "Untitled Project".to_owned()
    } else {
        sanitized.to_owned()
    }
}

fn document_signature(document: &ProjectDocument) -> Result<String, String> {
    serde_json::to_string(document)
        .map_err(|error| format!("Could not inspect project changes: {error}"))
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::Sequence;
    use super::{
        atomic_write, project_path, recovery_path, ProjectDocument, ProjectSession, ProjectSettings,
    };

    #[test]
    fn legacy_media_references_remain_external() {
        let media: super::MediaReference = serde_json::from_str(
            r#"{"id":1,"path":"/Volumes/Footage/source.mov","name":"source.mov"}"#,
        )
        .expect("legacy media reference should load");
        assert!(!media.managed);
    }

    #[test]
    fn legacy_editor_state_defaults_timeline_height() {
        let document = ProjectDocument::empty("Legacy".to_owned(), ProjectSettings::default());
        let mut json = serde_json::to_value(document).expect("project should serialize");
        json["editor"]
            .as_object_mut()
            .expect("editor state should be an object")
            .remove("timeline_height");

        let loaded: ProjectDocument =
            serde_json::from_value(json).expect("legacy project should load");
        assert_eq!(
            loaded.editor.timeline_height,
            super::DEFAULT_TIMELINE_HEIGHT
        );
    }

    #[test]
    fn legacy_project_defaults_to_no_transcript() {
        let document = ProjectDocument::empty("Legacy".to_owned(), ProjectSettings::default());
        let mut json = serde_json::to_value(document).expect("project should serialize");
        json.as_object_mut()
            .expect("project should be an object")
            .remove("transcript");

        let loaded: ProjectDocument =
            serde_json::from_value(json).expect("legacy project should load");
        assert!(loaded.transcript.is_none());
    }

    #[test]
    fn transcript_word_highlight_fades_at_time_boundaries() {
        let word = super::TranscriptWord {
            text: "hello".to_owned(),
            start_secs: 1.0,
            end_secs: 1.5,
        };
        assert_eq!(word.highlight_strength(0.8), 0.0);
        assert!(word.highlight_strength(0.95) > 0.0);
        assert_eq!(word.highlight_strength(1.2), 1.0);
        assert!(word.highlight_strength(1.55) > 0.0);
        assert_eq!(word.highlight_strength(1.7), 0.0);
    }

    #[test]
    fn project_paths_are_sanitized_and_versioned_json_round_trips() {
        let directory =
            std::env::temp_dir().join(format!("kuro-project-test-{}", std::process::id()));
        let path = project_path(&directory, "My: Project/One");
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("My- Project-One.kuro")
        );
        let document = ProjectDocument::empty("Test".to_owned(), ProjectSettings::default());
        ProjectSession::new(path.clone(), document.clone()).expect("project should save");
        let loaded = ProjectSession::open(path.clone()).expect("project should reopen");
        assert_eq!(loaded.document.name, document.name);
        assert_eq!(loaded.document.settings, document.settings);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn recovery_copy_restores_newer_cut_and_gap_state() {
        let directory =
            std::env::temp_dir().join(format!("kuro-recovery-test-{}", std::process::id()));
        let path = project_path(&directory, "Recovery");
        let document = ProjectDocument::empty("Recovery".to_owned(), ProjectSettings::default());
        ProjectSession::new(path.clone(), document).expect("project should save");

        let mut recovered = ProjectSession::open(path.clone())
            .expect("project should open")
            .document;
        let mut sequence = Sequence::new(12.0);
        let removed = sequence.split_at(4.0, 30.0).expect("cut should succeed");
        assert!(sequence.delete(removed));
        recovered.sequence = Some(sequence);
        recovered.editor.current_time = 7.25;
        recovered.editor.timeline_zoom = 4.0;
        recovered.modified_unix_ms += 1;
        let bytes = serde_json::to_vec_pretty(&recovered).expect("recovery should serialize");
        atomic_write(&recovery_path(&path), &bytes).expect("recovery should write");

        let loaded = ProjectSession::open(path.clone()).expect("recovery should open");
        assert!(loaded.recovered);
        assert_eq!(loaded.document.editor.current_time, 7.25);
        assert_eq!(loaded.document.editor.timeline_zoom, 4.0);
        assert_eq!(loaded.document.sequence.unwrap().clips.len(), 1);
        let _ = std::fs::remove_dir_all(directory);
    }
}
