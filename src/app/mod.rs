//! Top-level editor coordinator. This module owns runtime state and connects the
//! project, media, and UI subsystems without putting their implementation details
//! in `main.rs`.

use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::mpsc::{self, Receiver},
    thread,
    time::Instant,
};

use eframe::egui::{self, ColorImage, Pos2, TextureHandle, TextureOptions};

use crate::{
    media::{
        audio::SequenceAudioOutput,
        export::{ExportJob, ExportResult, ExportSettings, SequenceFormat},
        playback::{DecodedFrame, PlaybackEngine},
        waveform::{Waveform, WaveformGenerator},
        VideoAsset,
    },
    native_menu::{NativeMenu, NativeMenuAction},
    project::{
        self,
        sequence::{
            ClipAudio, ClipColor, ClipId, ClipMotion, MediaId, SequenceClip,
        },
        EditTool, EditorProjectState, EditorSnapshot, MediaFolder, MediaReference, NewProjectDraft,
        ProjectDocument, ProjectSession, RecentProject, Sequence, DEFAULT_TIMELINE_HEIGHT,
        MAX_HISTORY, MAX_TIMELINE_HEIGHT, MIN_TIMELINE_HEIGHT,
    },
    ui::{self, timeline},
};

pub struct LibraryMedia {
    pub id: MediaId,
    pub folder_id: Option<u64>,
    pub asset: VideoAsset,
    pub thumbnail: Option<TextureHandle>,
}

#[derive(Clone, Copy, Default, Eq, PartialEq)]
pub enum PropertiesTab {
    #[default]
    Properties,
    Transcription,
}

pub struct ClipDrag {
    pub clip_id: ClipId,
    pub clip_ids: Vec<ClipId>,
    pub pointer_offset: f64,
    pub target_track: u8,
    pub valid_target: bool,
    original: Sequence,
}

pub struct TrimDrag {
    clip_id: ClipId,
    clip_ids: Vec<ClipId>,
    left: bool,
    original: Sequence,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GapLane {
    Video,
    Audio,
}

#[derive(Clone, Copy, Debug)]
pub struct TimelineGap {
    pub start: f64,
    pub end: f64,
    pub track: u8,
    pub lane: GapLane,
}

#[derive(Clone, Debug, PartialEq)]
pub enum TimelineDropSource {
    Library(MediaId),
    External(PathBuf),
}

#[derive(Clone, Debug)]
pub struct TimelineDropPreview {
    pub source: TimelineDropSource,
    pub name: String,
    pub source_duration: f64,
    pub timeline_start: f64,
    pub valid: bool,
}

#[derive(Clone, Debug)]
pub struct MarqueeSelection {
    pub start: Pos2,
    pub end: Pos2,
    /// Selection at the moment the marquee began (for shift-add).
    pub baseline: Vec<ClipId>,
}

impl MarqueeSelection {
    pub fn rect(&self) -> egui::Rect {
        egui::Rect::from_two_pos(self.start, self.end)
    }
}

struct ExternalMediaProbe {
    path: PathBuf,
    receiver: Receiver<Result<VideoAsset, String>>,
}

struct PendingExternalDrop {
    path: PathBuf,
    timeline_time: f64,
    snap_threshold: f64,
}

pub struct VideoEditor {
    native_menu: NativeMenu,
    pub media_library: Vec<LibraryMedia>,
    pub selected_media_id: Option<MediaId>,
    pub current_media_folder: Option<u64>,
    pub video: Option<VideoAsset>,
    pub current_time: f64,
    pub playing: bool,
    pub status: Option<String>,
    pub texture: Option<TextureHandle>,
    pub sequence: Option<Sequence>,
    pub tool: EditTool,
    pub waveform: Option<Waveform>,
    pub export_settings: ExportSettings,
    pub export_dialog_open: bool,
    pub export_job: Option<ExportJob>,
    pub export_destination: Option<PathBuf>,
    pub export_message: Option<String>,
    export_message_shown_at: Option<Instant>,
    pub properties_tab: PropertiesTab,
    pub media_info_clip: Option<ClipId>,
    pub timeline_zoom: f32,
    pub timeline_height: f32,
    pub show_project_panel: bool,
    pub show_properties_panel: bool,
    pub show_timeline: bool,
    pub timecode_editing: bool,
    pub timecode_input: String,
    pub timecode_select_all: bool,
    pub timecode_error: bool,
    pub project_session: Option<ProjectSession>,
    pub recent_projects: Vec<RecentProject>,
    pub new_project_dialog_open: bool,
    pub new_project_draft: NewProjectDraft,
    pub missing_media: Option<MediaReference>,
    missing_media_queue: VecDeque<MediaReference>,
    pub clip_drag: Option<ClipDrag>,
    pub trim_drag: Option<TrimDrag>,
    pub selected_gap: Option<TimelineGap>,
    pub marquee: Option<MarqueeSelection>,
    pub ruler_scrubbing: bool,
    pub timeline_drop_preview: Option<TimelineDropPreview>,
    external_media_probe: Option<ExternalMediaProbe>,
    external_media_asset: Option<VideoAsset>,
    pending_external_drop: Option<PendingExternalDrop>,
    playback: PlaybackEngine,
    preloaded_playback: Option<(ClipId, PlaybackEngine)>,
    sequence_audio: Option<SequenceAudioOutput>,
    sequence_audio_started: bool,
    waveform_generator: WaveformGenerator,
    waveforms: HashMap<MediaId, Waveform>,
    waveform_queue: VecDeque<MediaId>,
    waveform_media: Option<MediaId>,
    thumbnail_engine: PlaybackEngine,
    thumbnail_queue: VecDeque<MediaId>,
    thumbnail_media: Option<MediaId>,
    playback_origin: f64,
    playback_started: Instant,
    active_clip: Option<ClipId>,
    preserve_clock_on_start: bool,
    preview_source_time: Option<f64>,
    history: Vec<EditorSnapshot>,
    history_index: usize,
    history_transaction: Option<EditorSnapshot>,
}

impl VideoEditor {
    pub fn new() -> Self {
        Self {
            native_menu: NativeMenu::new(),
            media_library: Vec::new(),
            selected_media_id: None,
            current_media_folder: None,
            video: None,
            current_time: 0.0,
            playing: false,
            status: None,
            texture: None,
            sequence: None,
            tool: EditTool::Select,
            waveform: None,
            export_settings: ExportSettings::default(),
            export_dialog_open: false,
            export_job: None,
            export_destination: None,
            export_message: None,
            export_message_shown_at: None,
            properties_tab: PropertiesTab::default(),
            media_info_clip: None,
            timeline_zoom: 1.0,
            timeline_height: DEFAULT_TIMELINE_HEIGHT,
            show_project_panel: true,
            show_properties_panel: true,
            show_timeline: true,
            timecode_editing: false,
            timecode_input: String::new(),
            timecode_select_all: false,
            timecode_error: false,
            project_session: None,
            recent_projects: project::load_recent_projects(),
            new_project_dialog_open: false,
            new_project_draft: NewProjectDraft::default(),
            missing_media: None,
            missing_media_queue: VecDeque::new(),
            clip_drag: None,
            trim_drag: None,
            selected_gap: None,
            marquee: None,
            ruler_scrubbing: false,
            timeline_drop_preview: None,
            external_media_probe: None,
            external_media_asset: None,
            pending_external_drop: None,
            playback: PlaybackEngine::new(),
            preloaded_playback: None,
            sequence_audio: None,
            sequence_audio_started: false,
            waveform_generator: WaveformGenerator::new(),
            waveforms: HashMap::new(),
            waveform_queue: VecDeque::new(),
            waveform_media: None,
            thumbnail_engine: PlaybackEngine::new(),
            thumbnail_queue: VecDeque::new(),
            thumbnail_media: None,
            playback_origin: 0.0,
            playback_started: Instant::now(),
            active_clip: None,
            preserve_clock_on_start: false,
            preview_source_time: None,
            history: Vec::new(),
            history_index: 0,
            history_transaction: None,
        }
    }

    pub fn open_new_project_dialog(&mut self) {
        self.new_project_draft = NewProjectDraft::default();
        self.new_project_dialog_open = true;
        self.status = None;
    }

    pub fn close_project(&mut self, ctx: &egui::Context) {
        if self.project_session.is_none() {
            return;
        }
        if let Some(job) = self.export_job.take() {
            job.cancel();
        }
        self.save_project();
        self.reset_editor(ctx);
        self.project_session = None;
        self.new_project_dialog_open = false;
        self.history.clear();
        self.history_index = 0;
        self.history_transaction = None;
    }

    pub fn create_project(&mut self, ctx: &egui::Context) {
        let name = self.new_project_draft.name.trim().to_owned();
        if name.is_empty() {
            self.status = Some("Enter a project name.".to_owned());
            return;
        }
        let path = project::project_path(&self.new_project_draft.directory, &name);
        if path.exists() {
            self.status =
                Some("A project with that name already exists in this folder.".to_owned());
            return;
        }
        let settings = self.new_project_draft.settings.clone();
        if self.project_session.is_some() {
            if let Some(job) = self.export_job.take() {
                job.cancel();
            }
            self.save_project();
        }
        let document = ProjectDocument::empty(name, settings);
        match ProjectSession::new(path.clone(), document) {
            Ok(session) => {
                self.reset_editor(ctx);
                self.project_session = Some(session);
                self.new_project_dialog_open = false;
                self.remember_current_project();
                self.initialize_history();
            }
            Err(error) => self.status = Some(error),
        }
    }

    pub fn choose_project_directory(&mut self) {
        if let Some(directory) = rfd::FileDialog::new()
            .set_directory(&self.new_project_draft.directory)
            .pick_folder()
        {
            self.new_project_draft.directory = directory;
        }
    }

    pub fn open_project_picker(&mut self, ctx: &egui::Context) {
        if let Some(path) = rfd::FileDialog::new()
            .add_filter("Unclip project", &["unclip"])
            .set_directory(project::default_project_directory())
            .pick_file()
        {
            self.open_project_path(path, ctx);
        }
    }

    pub fn open_project_path(&mut self, path: PathBuf, ctx: &egui::Context) {
        match ProjectSession::open(path) {
            Ok(session) => {
                let recovered = session.recovered;
                let document = session.document.clone();
                self.reset_editor(ctx);
                self.current_time = document.editor.current_time;
                self.timeline_zoom = document.editor.timeline_zoom.clamp(1.0, 32.0);
                self.timeline_height = document
                    .editor
                    .timeline_height
                    .clamp(MIN_TIMELINE_HEIGHT, MAX_TIMELINE_HEIGHT);
                self.tool = document.editor.tool;
                self.export_settings = document.editor.export_settings.clone();
                self.sequence = document.sequence.clone();
                self.project_session = Some(session);
                self.missing_media = None;
                for media in &document.media {
                    if media.path.exists() {
                        if let Err(error) =
                            self.load_library_media(media.id, media.path.clone(), false, ctx)
                        {
                            self.status = Some(error);
                            self.queue_missing_media(media.clone());
                        }
                    } else {
                        self.queue_missing_media(media.clone());
                    }
                }
                self.selected_media_id = document
                    .active_media_id
                    .or_else(|| self.media_library.first().map(|media| media.id));
                if let Some(sequence) = &self.sequence {
                    for id in sequence.clips.iter().map(|clip| clip.media_id) {
                        if !self.waveform_queue.contains(&id)
                            && self.media_asset(id).is_some_and(|asset| asset.has_audio)
                        {
                            self.waveform_queue.push_back(id);
                        }
                    }
                }
                self.pump_waveform_queue(ctx);
                if self.missing_media.is_some() {
                    self.status =
                        Some("Some project media is offline. Relink it to continue.".to_owned());
                }
                self.current_time = self.current_time.clamp(0.0, self.duration());
                self.refresh_preview(ctx);
                if recovered && self.missing_media.is_none() {
                    self.status = Some("Recovered the latest autosaved project state.".to_owned());
                }
                self.remember_current_project();
                self.initialize_history();
            }
            Err(error) => self.status = Some(error),
        }
    }

    pub fn relink_missing_media(&mut self, ctx: &egui::Context) {
        let Some(missing) = self.missing_media.clone() else {
            return;
        };
        let selected = rfd::FileDialog::new()
            .add_filter("Video", &["mp4", "mov", "mkv", "avi", "webm", "m4v"])
            .set_file_name(&missing.name)
            .pick_file();
        let Some(path) = selected else { return };
        match self.load_library_media(missing.id, path.clone(), false, ctx) {
            Ok(()) => {
                let relinked_name = self
                    .media_asset(missing.id)
                    .map_or_else(|| missing.name.clone(), |video| video.name.clone());
                if let Some(session) = &mut self.project_session {
                    if let Some(media) = session
                        .document
                        .media
                        .iter_mut()
                        .find(|media| media.id == missing.id)
                    {
                        media.path = path;
                        media.name = relinked_name;
                    }
                    session.mark_dirty();
                }
                self.missing_media = self.missing_media_queue.pop_front();
                if self.missing_media.is_some() {
                    self.status =
                        Some("Another project media file still needs relinking.".to_owned());
                }
            }
            Err(error) => self.status = Some(error),
        }
    }

    fn load_library_media(
        &mut self,
        media_id: MediaId,
        path: PathBuf,
        add_reference: bool,
        ctx: &egui::Context,
    ) -> Result<(), String> {
        let mut video = VideoAsset::load(path)?;
        let (max_width, max_height) = preview_decode_budget(ctx);
        video.set_decode_budget(max_width, max_height);
        self.register_library_media(media_id, video, add_reference, ctx);
        Ok(())
    }

    fn register_library_media(
        &mut self,
        media_id: MediaId,
        video: VideoAsset,
        add_reference: bool,
        ctx: &egui::Context,
    ) {
        let first_media = self.media_library.is_empty();
        if first_media && self.sequence.is_none() {
            self.current_time = 0.0;
            self.sequence = Some(Sequence::empty());
            self.timeline_zoom = 1.0;
        }
        self.media_info_clip = None;
        self.timecode_editing = false;
        self.timecode_input.clear();
        self.timecode_select_all = false;
        self.timecode_error = false;
        self.clear_export_message();
        self.status = Some(format!(
            "{} × {}  ·  {:.2} fps{}",
            video.source_width,
            video.source_height,
            video.fps,
            if video.has_audio { "  ·  audio" } else { "" }
        ));
        if add_reference {
            if let Some(session) = &mut self.project_session {
                session.document.media.push(MediaReference {
                    id: media_id,
                    path: video.path.clone(),
                    name: video.name.clone(),
                    managed: false,
                    folder_id: self.current_media_folder,
                });
                session.document.active_media_id = Some(media_id);
            }
        }
        self.media_library.retain(|media| media.id != media_id);
        self.media_library.push(LibraryMedia {
            id: media_id,
            folder_id: self.project_session.as_ref().and_then(|session| {
                session
                    .document
                    .media
                    .iter()
                    .find(|media| media.id == media_id)
                    .and_then(|media| media.folder_id)
            }),
            asset: video.clone(),
            thumbnail: None,
        });
        self.selected_media_id = Some(media_id);
        self.thumbnail_queue.push_back(media_id);
        if first_media {
            self.video = Some(video);
            self.texture = None;
        }
        self.pump_thumbnail_queue(ctx);
    }

    fn next_media_id(&self) -> MediaId {
        self.project_session
            .as_ref()
            .and_then(|session| session.document.media.iter().map(|media| media.id).max())
            .unwrap_or(0)
            .saturating_add(1)
    }

    pub fn create_media_folder(&mut self) {
        let Some(session) = &mut self.project_session else {
            return;
        };
        let next_id = session
            .document
            .media_folders
            .iter()
            .map(|folder| folder.id)
            .max()
            .unwrap_or(0)
            .saturating_add(1);
        let siblings = session
            .document
            .media_folders
            .iter()
            .filter(|folder| folder.parent_id == self.current_media_folder)
            .count();
        let name = if siblings == 0 {
            "New folder".to_owned()
        } else {
            format!("New folder {}", siblings + 1)
        };
        session.document.media_folders.push(MediaFolder {
            id: next_id,
            name,
            parent_id: self.current_media_folder,
        });
        session.mark_dirty();
    }

    pub fn enter_media_folder(&mut self, folder_id: u64) {
        if self.project_session.as_ref().is_some_and(|session| {
            session
                .document
                .media_folders
                .iter()
                .any(|folder| folder.id == folder_id)
        }) {
            self.current_media_folder = Some(folder_id);
        }
    }

    pub fn leave_media_folder(&mut self) {
        self.current_media_folder = self.project_session.as_ref().and_then(|session| {
            self.current_media_folder.and_then(|current| {
                session
                    .document
                    .media_folders
                    .iter()
                    .find(|folder| folder.id == current)
                    .and_then(|folder| folder.parent_id)
            })
        });
    }

    pub fn current_media_folder_name(&self) -> Option<&str> {
        let current = self.current_media_folder?;
        self.project_session
            .as_ref()?
            .document
            .media_folders
            .iter()
            .find(|folder| folder.id == current)
            .map(|folder| folder.name.as_str())
    }

    fn queue_missing_media(&mut self, media: MediaReference) {
        if self.missing_media.is_none() {
            self.missing_media = Some(media);
        } else if !self
            .missing_media_queue
            .iter()
            .any(|queued| queued.id == media.id)
        {
            self.missing_media_queue.push_back(media);
        }
    }

    pub fn prepare_external_media_hover(&mut self, path: &PathBuf, ctx: &egui::Context) {
        if !supported_video_path(path) || !path.is_file() {
            return;
        }
        if self
            .media_library
            .iter()
            .any(|media| media.asset.path == *path)
            || self
                .external_media_asset
                .as_ref()
                .is_some_and(|asset| asset.path == *path)
            || self
                .external_media_probe
                .as_ref()
                .is_some_and(|probe| probe.path == *path)
        {
            return;
        }

        let probe_path = path.clone();
        let worker_path = probe_path.clone();
        let (sender, receiver) = mpsc::channel();
        let repaint = ctx.clone();
        thread::spawn(move || {
            let result = VideoAsset::load(worker_path);
            let _ = sender.send(result);
            repaint.request_repaint();
        });
        self.external_media_probe = Some(ExternalMediaProbe {
            path: probe_path,
            receiver,
        });
        self.external_media_asset = None;
    }

    pub fn external_media_preview(&self, path: &PathBuf) -> Option<(String, f64)> {
        if !supported_video_path(path) {
            return None;
        }
        if let Some(asset) = self
            .media_library
            .iter()
            .map(|media| &media.asset)
            .chain(self.external_media_asset.iter())
            .find(|asset| asset.path == *path)
        {
            return Some((asset.name.clone(), asset.duration));
        }
        Some((
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Video")
                .to_owned(),
            5.0,
        ))
    }

    pub fn placement_preview(
        &self,
        source_duration: f64,
        requested_time: f64,
        snap_threshold: f64,
    ) -> (f64, bool) {
        self.sequence.as_ref().map_or((0.0, true), |sequence| {
            sequence.preview_media_placement(
                requested_time,
                source_duration,
                self.frame_rate(),
                snap_threshold,
            )
        })
    }

    pub fn place_external_media(
        &mut self,
        path: PathBuf,
        timeline_time: f64,
        snap_threshold: f64,
        ctx: &egui::Context,
    ) {
        if !supported_video_path(&path) || !path.is_file() {
            self.status = Some("That file is not a supported video.".to_owned());
            return;
        }
        if let Some(id) = self
            .media_library
            .iter()
            .find(|media| media.asset.path == path)
            .map(|media| media.id)
        {
            self.insert_media_at(id, timeline_time, snap_threshold, ctx);
            return;
        }
        if self
            .external_media_asset
            .as_ref()
            .is_some_and(|asset| asset.path == path)
        {
            let mut asset = self
                .external_media_asset
                .take()
                .expect("the matching external media asset was just checked");
            let (max_width, max_height) = preview_decode_budget(ctx);
            asset.set_decode_budget(max_width, max_height);
            let id = self.next_media_id();
            self.register_library_media(id, asset, true, ctx);
            self.insert_media_at(id, timeline_time, snap_threshold, ctx);
            return;
        }
        self.pending_external_drop = Some(PendingExternalDrop {
            path: path.clone(),
            timeline_time,
            snap_threshold,
        });
        self.prepare_external_media_hover(&path, ctx);
        self.status = Some("Importing dropped video…".to_owned());
    }

    fn poll_external_media_probe(&mut self, ctx: &egui::Context) {
        let result = self
            .external_media_probe
            .as_ref()
            .and_then(|probe| probe.receiver.try_recv().ok());
        let Some(result) = result else { return };
        let Some(probe) = self.external_media_probe.take() else {
            return;
        };
        match result {
            Ok(asset) => {
                self.external_media_asset = Some(asset);
                if self
                    .pending_external_drop
                    .as_ref()
                    .is_some_and(|drop| drop.path == probe.path)
                {
                    let drop = self
                        .pending_external_drop
                        .take()
                        .expect("the matching pending drop was just checked");
                    self.place_external_media(
                        drop.path,
                        drop.timeline_time,
                        drop.snap_threshold,
                        ctx,
                    );
                }
            }
            Err(error) => {
                if self
                    .pending_external_drop
                    .as_ref()
                    .is_some_and(|drop| drop.path == probe.path)
                {
                    self.pending_external_drop = None;
                    self.status = Some(error);
                }
            }
        }
    }

    fn pump_thumbnail_queue(&mut self, ctx: &egui::Context) {
        if self.thumbnail_media.is_some() {
            return;
        }
        while let Some(id) = self.thumbnail_queue.pop_front() {
            let Some(media) = self.media_library.iter().find(|media| media.id == id) else {
                continue;
            };
            let mut thumbnail_asset = media.asset.clone();
            thumbnail_asset.set_decode_budget(320, 180);
            self.thumbnail_engine.request_preview(
                &thumbnail_asset,
                (media.asset.duration * 0.1).min(1.0),
                ctx,
            );
            self.thumbnail_media = Some(id);
            break;
        }
    }

    fn poll_thumbnail(&mut self, ctx: &egui::Context) {
        if let Some(frame) = self.thumbnail_engine.poll_preview() {
            if let Some(id) = self.thumbnail_media.take() {
                let image = ColorImage::from_rgb([frame.width, frame.height], &frame.rgb);
                if let Some(media) = self.media_library.iter_mut().find(|media| media.id == id) {
                    media.thumbnail = Some(ctx.load_texture(
                        format!("unclip-thumbnail-{id}"),
                        image,
                        TextureOptions::LINEAR,
                    ));
                }
            }
        }
        self.pump_thumbnail_queue(ctx);
    }

    pub fn media_asset(&self, id: MediaId) -> Option<&VideoAsset> {
        self.media_library
            .iter()
            .find(|media| media.id == id)
            .map(|media| &media.asset)
            .or(self.video.as_ref())
    }

    pub fn media_thumbnail(&self, id: MediaId) -> Option<&TextureHandle> {
        self.media_library
            .iter()
            .find(|media| media.id == id)
            .and_then(|media| media.thumbnail.as_ref())
    }

    pub fn media_waveform(&self, id: MediaId) -> Option<&Waveform> {
        self.waveforms.get(&id)
    }

    pub fn select_library_media(&mut self, id: MediaId) {
        self.selected_media_id = Some(id);
        if let Some(session) = &mut self.project_session {
            session.document.active_media_id = Some(id);
        }
    }

    pub fn delete_library_media(&mut self, id: MediaId, ctx: &egui::Context) {
        let Some(index) = self.media_library.iter().position(|media| media.id == id) else {
            return;
        };
        self.pause(ctx);
        let removed_path = self.media_library[index].asset.path.clone();
        self.media_library.remove(index);
        self.waveforms.remove(&id);
        self.waveform_queue.retain(|queued| *queued != id);
        self.thumbnail_queue.retain(|queued| *queued != id);
        let _ = self
            .sequence
            .as_mut()
            .is_some_and(|sequence| sequence.remove_media(id));

        let next_id = self.media_library.first().map(|media| media.id);
        if self.selected_media_id == Some(id) {
            self.selected_media_id = next_id;
        }
        if self
            .video
            .as_ref()
            .is_some_and(|video| video.path == removed_path)
        {
            self.video = next_id.and_then(|next| self.media_asset(next).cloned());
            self.texture = None;
        }
        if let Some(session) = &mut self.project_session {
            session.document.media.retain(|media| media.id != id);
            session.document.active_media_id = self.selected_media_id;
            session.mark_dirty();
        }
        self.current_time = self.current_time.clamp(0.0, self.duration());
        self.refresh_preview(ctx);
        // Media removal is intentionally not undoable: restoring only the timeline
        // snapshot would recreate references to footage no longer in the project bin.
        self.initialize_history();
        self.status =
            Some("Media removed from the project. The source file was not deleted.".to_owned());
    }

    pub fn insert_media_at(&mut self, id: MediaId, time: f64, snap: f64, ctx: &egui::Context) {
        let Some(asset) = self.media_asset(id).cloned() else {
            return;
        };
        let fps = self.frame_rate();
        let sequence = self.sequence.get_or_insert_with(Sequence::empty);
        if sequence
            .insert_media(id, time, asset.duration, fps, snap)
            .is_some()
        {
            self.record_history();
            if asset.has_audio && !self.waveforms.contains_key(&id) {
                self.waveform_queue.push_back(id);
                self.pump_waveform_queue(ctx);
            }
            self.refresh_preview(ctx);
        } else {
            self.status = Some("That clip would overlap another clip.".to_owned());
        }
    }

    fn pump_waveform_queue(&mut self, ctx: &egui::Context) {
        if self.waveform_media.is_some() {
            return;
        }
        while let Some(id) = self.waveform_queue.pop_front() {
            let Some((path, duration)) = self
                .media_asset(id)
                .map(|asset| (asset.path.clone(), asset.duration))
            else {
                continue;
            };
            self.waveform_generator
                .request(&path, duration, ctx.clone());
            self.waveform_media = Some(id);
            break;
        }
    }

    pub fn duplicate_clip(&mut self, id: ClipId, ctx: &egui::Context) -> Option<ClipId> {
        let fps = self.frame_rate();
        let (preferred, fallback) = {
            let sequence = self.sequence.as_ref()?;
            (sequence.clip(id)?.timeline_end, sequence.duration)
        };
        let duplicated = self.sequence.as_mut()?.duplicate(id)?;
        let placed = self
            .sequence
            .as_mut()?
            .move_clip(duplicated, preferred, fps, 0.0)
            .or_else(|| {
                self.sequence
                    .as_mut()?
                    .move_clip(duplicated, fallback, fps, 0.0)
            });
        if placed.is_none() {
            self.sequence.as_mut()?.delete(duplicated);
            return None;
        }
        self.record_history();
        self.refresh_preview(ctx);
        Some(duplicated)
    }

    pub fn begin_clip_drag(&mut self, id: ClipId, pointer_time: f64, duplicate: bool) {
        let Some(original) = self.sequence.clone() else {
            return;
        };
        let Some(clip) = original.clip(id) else {
            return;
        };
        let pointer_offset = pointer_time - clip.timeline_start;
        self.begin_history_transaction();
        let clip_id = if duplicate {
            self.sequence
                .as_mut()
                .and_then(|sequence| sequence.duplicate(id))
                .unwrap_or(id)
        } else {
            id
        };
        let clip_ids = if duplicate {
            vec![clip_id]
        } else if original.is_selected(id) {
            original.selected.clone()
        } else {
            vec![id]
        };
        self.clip_drag = Some(ClipDrag {
            clip_id,
            clip_ids,
            pointer_offset,
            target_track: clip.track(),
            valid_target: true,
            original,
        });
    }

    pub fn update_clip_drag(
        &mut self,
        pointer_time: f64,
        target_track: Option<u8>,
        snap: f64,
        ctx: &egui::Context,
    ) {
        let Some((id, ids, offset, original)) = self.clip_drag.as_ref().map(|drag| {
            (
                drag.clip_id,
                drag.clip_ids.clone(),
                drag.pointer_offset,
                drag.original.clone(),
            )
        }) else {
            return;
        };
        let Some(track) = target_track else {
            if let Some(drag) = self.clip_drag.as_mut() {
                drag.valid_target = false;
            }
            return;
        };
        self.sequence = Some(original);
        let fps = self.frame_rate();
        let moved = self
            .sequence
            .as_mut()
            .and_then(|sequence| {
                sequence.move_group_to_track(
                    &ids,
                    id,
                    (pointer_time - offset).max(0.0),
                    track,
                    fps,
                    snap,
                )
            })
            .is_some();
        if moved {
            self.refresh_preview(ctx);
        }
        if let Some(drag) = self.clip_drag.as_mut() {
            drag.target_track = track;
            drag.valid_target = moved;
        }
    }

    pub fn finish_clip_drag(&mut self) {
        let Some(drag) = self.clip_drag.take() else {
            return;
        };
        let invalid_drop = !drag.valid_target;
        let duplicate_still_overlaps = self
            .sequence
            .as_ref()
            .is_some_and(|sequence| sequence.has_overlaps());
        if invalid_drop || duplicate_still_overlaps {
            self.sequence = Some(drag.original);
        }
        self.commit_history_transaction();
    }

    pub fn begin_trim_drag(&mut self, id: ClipId, left: bool) {
        let Some(original) = self.sequence.clone() else {
            return;
        };
        let clip_ids = if original.is_selected(id) {
            original.selected.clone()
        } else {
            vec![id]
        };
        self.begin_history_transaction();
        self.trim_drag = Some(TrimDrag {
            clip_id: id,
            clip_ids,
            left,
            original,
        });
    }

    pub fn update_trim_drag(&mut self, requested: f64, snap: f64, ctx: &egui::Context) {
        let Some(drag) = self.trim_drag.as_ref() else {
            return;
        };
        let original = drag.original.clone();
        let Some(primary) = original.clip(drag.clip_id) else {
            return;
        };
        let delta = requested
            - if drag.left {
                primary.timeline_start
            } else {
                primary.timeline_end
            };
        let ids = drag.clip_ids.clone();
        let left = drag.left;
        self.sequence = Some(original.clone());
        let fps = self.frame_rate();
        let source_durations = ids
            .iter()
            .filter_map(|id| {
                original.clip(*id).and_then(|clip| {
                    self.media_asset(clip.media_id)
                        .map(|asset| (*id, asset.duration))
                })
            })
            .collect::<HashMap<_, _>>();
        let mut changed = false;
        if let Some(sequence) = &mut self.sequence {
            for id in ids {
                let Some(clip) = original.clip(id) else {
                    continue;
                };
                let edge = if left {
                    clip.timeline_start
                } else {
                    clip.timeline_end
                } + delta;
                let result = if left {
                    sequence.trim_left_snapped(id, edge, fps, snap)
                } else {
                    sequence.trim_right_snapped(
                        id,
                        edge,
                        fps,
                        source_durations
                            .get(&id)
                            .copied()
                            .unwrap_or(clip.source_out),
                        snap,
                    )
                };
                changed |= result.is_some();
            }
        }
        if changed {
            self.refresh_preview(ctx);
        }
    }

    pub fn finish_trim_drag(&mut self) {
        if self.trim_drag.take().is_some() {
            self.commit_history_transaction();
        }
    }

    pub fn set_clip_color(&mut self, id: ClipId, color: ClipColor) {
        if self
            .sequence
            .as_mut()
            .is_some_and(|sequence| sequence.set_color_for_selection(id, color))
        {
            self.record_history();
        }
    }

    fn reset_editor(&mut self, ctx: &egui::Context) {
        self.pause(ctx);
        self.video = None;
        self.media_library.clear();
        self.selected_media_id = None;
        self.current_media_folder = None;
        self.sequence = None;
        self.texture = None;
        self.waveform = None;
        self.waveforms.clear();
        self.waveform_queue.clear();
        self.waveform_media = None;
        self.thumbnail_queue.clear();
        self.thumbnail_media = None;
        self.external_media_probe = None;
        self.external_media_asset = None;
        self.pending_external_drop = None;
        self.timeline_drop_preview = None;
        self.current_time = 0.0;
        self.timeline_zoom = 1.0;
        self.timeline_height = DEFAULT_TIMELINE_HEIGHT;
        ctx.data_mut(|data| {
            data.remove::<egui::containers::panel::PanelState>(egui::Id::new("timeline"));
        });
        self.tool = EditTool::Select;
        self.export_settings = ExportSettings::default();
        self.export_destination = None;
        self.clear_export_message();
        self.properties_tab = PropertiesTab::default();
        self.missing_media = None;
        self.missing_media_queue.clear();
        self.marquee = None;
        self.ruler_scrubbing = false;
        self.status = None;
    }

    fn remember_current_project(&mut self) {
        let Some(session) = &self.project_session else {
            return;
        };
        if let Ok(recent) = project::remember_recent_project(project::recent_entry(
            session.document.name.clone(),
            session.path.clone(),
        )) {
            self.recent_projects = recent;
        }
    }

    fn snapshot(&self) -> EditorSnapshot {
        let mut sequence = self.sequence.clone();
        if let Some(sequence) = &mut sequence {
            sequence.clear_selection();
        }
        EditorSnapshot { sequence }
    }

    fn initialize_history(&mut self) {
        self.history.clear();
        self.history.push(self.snapshot());
        self.history_index = 0;
        self.history_transaction = None;
    }

    pub fn begin_history_transaction(&mut self) {
        if self.history_transaction.is_none() {
            self.history_transaction = Some(self.snapshot());
        }
    }

    pub fn commit_history_transaction(&mut self) {
        let Some(before) = self.history_transaction.take() else {
            return;
        };
        if self.snapshot() != before {
            self.record_history();
        }
    }

    fn record_history(&mut self) {
        let snapshot = self.snapshot();
        if self.history.get(self.history_index) == Some(&snapshot) {
            return;
        }
        self.history.truncate(self.history_index.saturating_add(1));
        self.history.push(snapshot);
        if self.history.len() > MAX_HISTORY {
            self.history.remove(0);
        }
        self.history_index = self.history.len().saturating_sub(1);
        if let Some(session) = &mut self.project_session {
            session.mark_dirty();
        }
    }

    fn apply_history_snapshot(&mut self, snapshot: EditorSnapshot, ctx: &egui::Context) {
        self.pause(ctx);
        let selected = self
            .sequence
            .as_ref()
            .map(|sequence| sequence.selected.clone())
            .unwrap_or_default();
        self.sequence = snapshot.sequence;
        if let Some(sequence) = &mut self.sequence {
            sequence.select_many(selected);
        }
        self.current_time = self.current_time.clamp(0.0, self.duration());
        if let Some(session) = &mut self.project_session {
            session.mark_dirty();
        }
        self.refresh_preview(ctx);
    }

    pub fn undo(&mut self, ctx: &egui::Context) {
        if self.history_index == 0 || self.history.is_empty() {
            return;
        }
        self.history_transaction = None;
        self.history_index -= 1;
        self.apply_history_snapshot(self.history[self.history_index].clone(), ctx);
    }

    pub fn can_undo(&self) -> bool {
        self.history_index > 0 && !self.history.is_empty()
    }

    pub fn redo(&mut self, ctx: &egui::Context) {
        if self.history_index + 1 >= self.history.len() {
            return;
        }
        self.history_transaction = None;
        self.history_index += 1;
        self.apply_history_snapshot(self.history[self.history_index].clone(), ctx);
    }

    pub fn can_redo(&self) -> bool {
        self.history_index + 1 < self.history.len()
    }

    fn sync_project_document(&mut self) {
        let editor = EditorProjectState {
            current_time: self.current_time,
            timeline_zoom: self.timeline_zoom,
            timeline_height: self.timeline_height,
            tool: self.tool,
            export_settings: self.export_settings.clone(),
        };
        let Some(session) = &mut self.project_session else {
            return;
        };
        session.document.sequence = self.sequence.clone();
        session.document.editor = editor;
        session.document.active_media_id = self.selected_media_id;
    }

    fn tick_project(&mut self) {
        if self.history_transaction.is_some()
            || !self
                .project_session
                .as_ref()
                .is_some_and(ProjectSession::autosave_due)
        {
            return;
        }
        self.sync_project_document();
        if let Some(session) = &mut self.project_session {
            if let Err(error) = session.save() {
                self.status = Some(format!("Project autosave failed: {error}"));
            }
        }
    }

    fn save_project(&mut self) {
        self.sync_project_document();
        if let Some(session) = &mut self.project_session {
            if let Err(error) = session.save() {
                self.status = Some(format!("Could not save project: {error}"));
            }
        }
    }

    pub fn import_video(&mut self, ctx: &egui::Context) {
        if self.export_job.is_some() {
            return;
        }
        let selected = rfd::FileDialog::new()
            .add_filter("Video", &["mp4", "mov", "mkv", "avi", "webm", "m4v"])
            .pick_files();
        let Some(paths) = selected else { return };

        self.pause(ctx);
        let mut imported = 0;
        for path in paths {
            let id = self.next_media_id();
            match self.load_library_media(id, path, true, ctx) {
                Ok(()) => imported += 1,
                Err(error) => self.status = Some(error),
            }
        }
        if imported > 0 {
            self.initialize_history();
            if let Some(session) = &mut self.project_session {
                session.mark_dirty();
            }
        }
    }

    pub fn toggle_playback(&mut self, ctx: &egui::Context) {
        if self.playing {
            self.pause(ctx);
            return;
        }
        if self.video.is_none() || self.sequence.is_none() {
            return;
        }
        if !self.ensure_media_available(ctx) {
            return;
        }
        let duration = self.duration();
        if self.current_time >= duration - 0.001 {
            self.current_time = 0.0;
        }
        self.playback_origin = self.current_time;
        self.playback_started = Instant::now();
        self.sequence_audio_started = false;
        let sequence_audio = match &self.sequence {
            Some(sequence)
                if sequence.clips.iter().any(|clip| {
                    self.media_asset(clip.media_id)
                        .is_some_and(|asset| asset.has_audio)
                }) =>
            {
                let sources = self
                    .media_library
                    .iter()
                    .map(|media| (media.id, media.asset.path.clone()))
                    .collect();
                match SequenceAudioOutput::prepare_sources(sources, sequence, self.current_time) {
                    Ok(audio) => Some(audio),
                    Err(error) => {
                        self.status = Some(error);
                        None
                    }
                }
            }
            _ => None,
        };
        self.sequence_audio = sequence_audio;
        self.playing = true;
        self.start_current_segment(ctx);
        if self
            .sequence
            .as_ref()
            .and_then(|sequence| sequence.clip_at(self.current_time))
            .is_none()
        {
            self.start_sequence_clock();
        }
        ctx.request_repaint();
    }

    pub fn selected_clip(&self) -> Option<&SequenceClip> {
        let sequence = self.sequence.as_ref()?;
        let id = sequence.primary_selected()?;
        sequence.clip(id)
    }

    pub fn selected_clip_mut(&mut self) -> Option<&mut SequenceClip> {
        let sequence = self.sequence.as_mut()?;
        let id = sequence.primary_selected()?;
        sequence.clips.iter_mut().find(|clip| clip.id == id)
    }

    pub fn update_selected_clip_motion(&mut self, motion: ClipMotion) {
        if let Some(clip) = self.selected_clip_mut() {
            clip.motion = motion;
        }
    }

    pub fn update_selected_clip_audio(&mut self, audio: ClipAudio) {
        if let Some(clip) = self.selected_clip_mut() {
            clip.audio = audio;
        }
    }

    pub fn pause(&mut self, ctx: &egui::Context) {
        if self.playing {
            self.update_clock();
        }
        self.playing = false;
        self.stop_all_playback();
        self.active_clip = None;
        self.refresh_preview(ctx);
    }

    fn ensure_media_available(&mut self, ctx: &egui::Context) -> bool {
        let Some(video) = self.video.as_ref() else {
            return false;
        };
        if video.path.is_file() {
            return true;
        }
        let missing = self
            .project_session
            .as_ref()
            .and_then(|session| session.document.active_media().cloned())
            .unwrap_or_else(|| MediaReference {
                id: 1,
                path: video.path.clone(),
                name: video.name.clone(),
                managed: false,
                folder_id: None,
            });
        self.playing = false;
        self.stop_all_playback();
        self.texture = None;
        self.missing_media = Some(missing);
        self.status = Some("Source media is unavailable. Relink it to continue.".to_owned());
        ctx.request_repaint();
        false
    }

    pub fn seek(&mut self, time: f64, ctx: &egui::Context) {
        if self.video.is_some() && !self.ensure_media_available(ctx) {
            return;
        }
        if self.playing {
            self.playing = false;
        }
        self.stop_all_playback();
        if self.video.is_none() || self.sequence.is_none() {
            self.current_time = 0.0;
            return;
        }
        self.active_clip = None;
        // Allow scrubbing into the empty runway past the last clip.
        let max_time = timeline::timeline_view_duration(self.duration());
        self.current_time = time.clamp(0.0, max_time);
        self.refresh_preview(ctx);
        ctx.request_repaint();
    }

    pub fn duration(&self) -> f64 {
        self.sequence
            .as_ref()
            .map_or(0.0, |sequence| sequence.duration)
    }

    pub fn timeline_interaction_duration(&self) -> f64 {
        self.history_transaction
            .as_ref()
            .and_then(|snapshot| snapshot.sequence.as_ref())
            .map_or_else(|| self.duration(), |sequence| sequence.duration)
    }

    pub fn frame_rate(&self) -> f64 {
        self.project_session
            .as_ref()
            .map(|session| session.document.settings.frame_rate)
            .or_else(|| self.video.as_ref().map(|video| video.fps))
            .unwrap_or(30.0)
    }

    pub fn sequence_format(&self) -> SequenceFormat {
        self.project_session.as_ref().map_or_else(
            || {
                self.video.as_ref().map_or(
                    SequenceFormat {
                        width: 1920,
                        height: 1080,
                        frame_rate: 30.0,
                    },
                    |video| SequenceFormat {
                        width: video.source_width,
                        height: video.source_height,
                        frame_rate: video.fps,
                    },
                )
            },
            |session| SequenceFormat {
                width: session.document.settings.width as usize,
                height: session.document.settings.height as usize,
                frame_rate: session.document.settings.frame_rate,
            },
        )
    }

    pub fn select_clip_only(&mut self, id: ClipId) {
        self.selected_gap = None;
        if let Some(sequence) = &mut self.sequence {
            sequence.select_only(id);
        }
    }

    pub fn toggle_clip_selection(&mut self, id: ClipId) {
        self.selected_gap = None;
        if let Some(sequence) = &mut self.sequence {
            sequence.toggle_select(id);
        }
    }

    pub fn select_clips(&mut self, ids: Vec<ClipId>) {
        self.selected_gap = None;
        if let Some(sequence) = &mut self.sequence {
            sequence.select_many(ids);
        }
    }

    pub fn clear_clip_selection(&mut self) {
        if let Some(sequence) = &mut self.sequence {
            sequence.clear_selection();
        }
    }

    pub fn select_gap(&mut self, gap: TimelineGap) {
        self.clear_clip_selection();
        self.selected_gap = Some(gap);
    }

    pub fn clear_gap_selection(&mut self) {
        self.selected_gap = None;
    }

    pub fn razor_cut(&mut self, time: f64, ctx: &egui::Context) {
        if self.video.is_none() {
            return;
        }
        let fps = self.frame_rate();
        if self.playing {
            self.pause(ctx);
        }
        if self
            .sequence
            .as_mut()
            .and_then(|sequence| sequence.split_at(time, fps))
            .is_some()
        {
            self.seek(time, ctx);
            self.record_history();
        }
    }

    pub fn delete_selected(&mut self, ctx: &egui::Context) {
        let deleted = self
            .sequence
            .as_mut()
            .is_some_and(Sequence::delete_selected);
        if deleted {
            if self.playing {
                self.playing = false;
                self.active_clip = None;
            }
            self.stop_all_playback();
            self.refresh_preview(ctx);
            self.record_history();
        }
    }

    pub fn ripple_delete_selected_gap(&mut self, ctx: &egui::Context) -> bool {
        let Some(gap) = self.selected_gap.take() else {
            return false;
        };
        use crate::project::sequence::ClipLane;
        let lane = match gap.lane {
            GapLane::Video => ClipLane::Video,
            GapLane::Audio => ClipLane::Audio,
        };
        let changed = self.sequence.as_mut().is_some_and(|sequence| {
            sequence.ripple_delete_gap(gap.start, gap.end, lane, gap.track)
        });
        if changed {
            self.stop_all_playback();
            self.refresh_preview(ctx);
            self.record_history();
        }
        changed
    }

    pub fn delete_clip(&mut self, id: ClipId, ctx: &egui::Context) {
        let deleted = self
            .sequence
            .as_mut()
            .is_some_and(|sequence| sequence.delete(id));
        if deleted {
            if self.playing {
                self.playing = false;
                self.active_clip = None;
            }
            self.stop_all_playback();
            if self.media_info_clip == Some(id) {
                self.media_info_clip = None;
            }
            self.refresh_preview(ctx);
            self.record_history();
        }
    }

    pub fn unlink_clip(&mut self, id: ClipId, ctx: &egui::Context) {
        use crate::project::sequence::ClipLane;
        let Some((media_id, lane)) = self
            .sequence
            .as_ref()
            .and_then(|sequence| sequence.clip(id).map(|clip| (clip.media_id, clip.lane)))
        else {
            return;
        };
        let has_audio = self
            .media_library
            .iter()
            .find(|media| media.id == media_id)
            .is_some_and(|media| media.asset.has_audio);
        if !has_audio || lane != ClipLane::Both {
            return;
        }
        if self
            .sequence
            .as_mut()
            .and_then(|sequence| sequence.unlink(id))
            .is_some()
        {
            if self.playing {
                self.playing = false;
                self.active_clip = None;
            }
            self.stop_all_playback();
            self.refresh_preview(ctx);
            self.record_history();
        }
    }

    pub fn link_selected_clips(&mut self, ctx: &egui::Context) {
        let linked = self
            .sequence
            .as_mut()
            .map(Sequence::link_selected)
            .unwrap_or_default();
        if linked.is_empty() {
            return;
        }
        if self.playing {
            self.playing = false;
            self.active_clip = None;
        }
        self.stop_all_playback();
        self.refresh_preview(ctx);
        self.record_history();
    }

    pub fn open_export(&mut self) {
        if self.video.is_some() && self.sequence.is_some() && self.export_job.is_none() {
            self.export_dialog_open = true;
        }
    }

    pub fn choose_export_destination(&mut self, ctx: &egui::Context) {
        let (Some(video), Some(sequence)) = (self.video.clone(), self.sequence.clone()) else {
            return;
        };
        if self.export_job.is_some() {
            return;
        }
        let default_name = video
            .path
            .file_stem()
            .and_then(|name| name.to_str())
            .map_or_else(
                || "Unclip Export.mp4".to_owned(),
                |name| format!("{name} - Unclip.mp4"),
            );
        let destination = rfd::FileDialog::new()
            .add_filter("MPEG-4 video", &["mp4"])
            .set_file_name(default_name)
            .save_file();
        let Some(mut destination) = destination else {
            return;
        };
        if destination.extension().is_none() {
            destination.set_extension("mp4");
        }
        if destination == video.path {
            self.show_export_message(
                "Choose a different file name so the source video is not overwritten.".to_owned(),
            );
            return;
        }
        self.pause(ctx);
        self.export_dialog_open = false;
        self.clear_export_message();
        self.export_destination = Some(destination.clone());
        self.export_job = Some(ExportJob::start(
            self.media_library
                .iter()
                .map(|media| (media.id, media.asset.clone()))
                .collect(),
            sequence,
            self.export_settings.clone(),
            self.sequence_format(),
            destination,
            ctx.clone(),
        ));
        ctx.request_repaint();
    }

    pub fn cancel_export(&mut self) {
        if let Some(job) = &self.export_job {
            job.cancel();
        }
    }

    pub fn show_export_message(&mut self, message: String) {
        self.export_message = Some(message);
        self.export_message_shown_at = Some(Instant::now());
    }

    pub fn clear_export_message(&mut self) {
        self.export_message = None;
        self.export_message_shown_at = None;
    }

    pub fn export_message_age(&self) -> Option<std::time::Duration> {
        self.export_message_shown_at
            .map(|shown_at| shown_at.elapsed())
    }








    fn poll_export(&mut self) {
        let result = self.export_job.as_ref().and_then(ExportJob::poll);
        if let Some(result) = result {
            self.export_job = None;
            self.show_export_message(match result {
                ExportResult::Finished(path) => format!(
                    "Exported to {}",
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("video")
                ),
                ExportResult::Cancelled => "Export cancelled".to_owned(),
                ExportResult::Failed(error) => format!("Export failed: {error}"),
            });
        }
    }

    fn refresh_preview(&mut self, ctx: &egui::Context) {
        let media_source = self
            .sequence
            .as_ref()
            .and_then(|sequence| sequence.media_source_at(self.current_time));
        self.preview_source_time = media_source.map(|(_, time)| time);
        if let Some((media_id, source_time)) = media_source {
            if let Some(video) = self.media_asset(media_id).cloned() {
                self.video = Some(video.clone());
                self.playback.request_preview(&video, source_time, ctx);
            }
        } else {
            self.playback.clear_preview();
            self.texture = None;
        }
    }

    fn start_current_segment(&mut self, ctx: &egui::Context) {
        let clip = self
            .sequence
            .as_ref()
            .and_then(|sequence| sequence.clip_at(self.current_time))
            .cloned();
        if let Some(clip) = clip {
            let source_time = clip.source_time(self.current_time);
            self.start_clip_decoder(clip.id, source_time, ctx);
        } else {
            self.preload_next_clip(ctx);
            self.texture = None;
        }
    }

    fn start_clip_decoder(&mut self, clip_id: ClipId, source_time: f64, ctx: &egui::Context) {
        let Some(media_id) = self
            .sequence
            .as_ref()
            .and_then(|sequence| sequence.clip(clip_id))
            .map(|clip| clip.media_id)
        else {
            return;
        };
        let Some(video) = self.media_asset(media_id).cloned() else {
            return;
        };
        // The preview fit must follow the clip that is about to become active,
        // including when its decoder was preloaded at a transition.
        self.video = Some(video.clone());
        if self
            .preloaded_playback
            .as_ref()
            .is_some_and(|(preloaded, _)| *preloaded == clip_id)
        {
            let (_, preloaded) = self
                .preloaded_playback
                .take()
                .expect("the matching preloaded clip was just checked");
            self.playback.stop();
            self.playback = preloaded;
            self.active_clip = Some(clip_id);
            self.preserve_clock_on_start = true;
            return;
        }
        self.preloaded_playback = None;
        self.preserve_clock_on_start = false;
        self.active_clip = Some(clip_id);
        match self.playback.start(&video, source_time, ctx) {
            Ok(()) => {}
            Err(error) => {
                self.status = Some(error);
                self.playing = false;
                self.active_clip = None;
                self.stop_all_playback();
                self.ensure_media_available(ctx);
            }
        }
    }

    fn prepare_upcoming_transition(&mut self, ctx: &egui::Context) {
        if !self.playing {
            self.preloaded_playback = None;
            return;
        }
        let upcoming = self.sequence.as_ref().and_then(|sequence| {
            let active = sequence.clip(self.active_clip?)?;
            if !active.contains(self.current_time) || active.timeline_end - self.current_time > 0.75
            {
                return None;
            }
            let next = sequence.clips.iter().find(|clip| {
                clip.lane.shows_video() && clip.timeline_start >= active.timeline_end - 0.000_001
            })?;
            let continuous = (active.timeline_end - next.timeline_start).abs() < 0.000_001
                && active.media_id == next.media_id
                && (active.source_out - next.source_in).abs() < 0.000_001;
            (!continuous).then(|| next.clone())
        });
        let Some(upcoming) = upcoming else {
            return;
        };
        if self
            .preloaded_playback
            .as_ref()
            .is_none_or(|(id, _)| *id != upcoming.id)
        {
            let Some(video) = self.media_asset(upcoming.media_id).cloned() else {
                return;
            };
            let mut playback = PlaybackEngine::new();
            match playback.start(&video, upcoming.source_in, ctx) {
                Ok(()) => {}
                Err(error) => {
                    self.status = Some(error);
                    self.ensure_media_available(ctx);
                    return;
                }
            }
            self.preloaded_playback = Some((upcoming.id, playback));
        }
        if let Some((_, playback)) = &mut self.preloaded_playback {
            playback.prebuffer_playback();
        }
    }

    fn preload_next_clip(&mut self, ctx: &egui::Context) {
        let upcoming = self.sequence.as_ref().and_then(|sequence| {
            sequence
                .clips
                .iter()
                .find(|clip| {
                    clip.lane.shows_video() && clip.timeline_start > self.current_time + 0.000_001
                })
                .cloned()
        });
        if upcoming.as_ref().map(|clip| clip.id) == self.active_clip {
            return;
        }
        if let Some(upcoming) = upcoming {
            self.start_clip_decoder(upcoming.id, upcoming.source_in, ctx);
            self.preserve_clock_on_start = true;
        } else {
            self.playback.stop();
            self.preloaded_playback = None;
            self.active_clip = None;
        }
    }

    fn update_clock(&mut self) {
        if !self.playing || !self.sequence_audio_started {
            return;
        }
        if self.sequence.is_none() {
            self.playing = false;
            return;
        }
        self.current_time = self.sequence_audio.as_ref().map_or_else(
            || self.playback_origin + self.playback_started.elapsed().as_secs_f64(),
            SequenceAudioOutput::timeline_time,
        );
        if self.current_time >= self.duration() {
            self.current_time = self.duration();
            self.playing = false;
            self.stop_all_playback();
            self.active_clip = None;
        }
    }

    fn sync_playback_segment(&mut self, ctx: &egui::Context) {
        if !self.playing {
            return;
        }
        let next = self
            .sequence
            .as_ref()
            .and_then(|sequence| sequence.clip_at(self.current_time))
            .cloned();
        if next.as_ref().map(|clip| clip.id) == self.active_clip {
            return;
        }

        if next.is_none() {
            self.texture = None;
            self.preload_next_clip(ctx);
            return;
        }

        let continuous = match (self.active_clip, next.as_ref(), self.sequence.as_ref()) {
            (Some(active), Some(next), Some(sequence)) => {
                sequence.clip(active).is_some_and(|old| {
                    (old.timeline_end - next.timeline_start).abs() < 0.000_001
                        && (old.source_out - next.source_in).abs() < 0.000_001
                })
            }
            _ => false,
        };
        if continuous {
            self.active_clip = next.map(|clip| clip.id);
            return;
        }
        self.start_current_segment(ctx);
    }

    fn update_frame(&mut self, ctx: &egui::Context) {
        let current_clip = self
            .sequence
            .as_ref()
            .and_then(|sequence| sequence.clip_at(self.current_time))
            .map(|clip| clip.id);
        let playing_active_clip = current_clip.is_some() && current_clip == self.active_clip;
        let frame = if self.playing && playing_active_clip {
            let interval = self
                .video
                .as_ref()
                .map_or(1.0 / 30.0, |video| 1.0 / video.fps);
            let source_clock = self
                .sequence
                .as_ref()
                .and_then(|sequence| sequence.source_time_at(self.current_time))
                .unwrap_or(self.current_time);
            let frame = self.playback.poll_playback(source_clock, interval);
            if self.playback.take_just_started() {
                if !self.preserve_clock_on_start && !self.sequence_audio_started {
                    self.playback_origin = self.current_time;
                    self.playback_started = Instant::now();
                    self.start_sequence_clock();
                }
                self.preserve_clock_on_start = false;
            }
            frame
        } else if !self.playing {
            self.playback.poll_preview()
        } else {
            self.playback.prebuffer_playback();
            None
        };
        if let Some(frame) = frame {
            let is_relevant = self.playing
                || self.video.as_ref().is_some_and(|video| {
                    self.preview_source_time.is_some_and(|requested| {
                        (frame.time - requested).abs() <= (2.0 / video.fps.max(1.0))
                    })
                });
            if is_relevant {
                self.upload_frame(ctx, frame);
            }
        }
    }

    fn upload_frame(&mut self, ctx: &egui::Context, frame: DecodedFrame) {
        let image = ColorImage::from_rgb([frame.width, frame.height], &frame.rgb);
        if let Some(texture) = &mut self.texture {
            texture.set(image, TextureOptions::LINEAR);
        } else {
            self.texture = Some(ctx.load_texture("unclip-video", image, TextureOptions::LINEAR));
        }
    }

    fn handle_shortcuts(&mut self, ctx: &egui::Context) {
        if self.timecode_editing || ctx.wants_keyboard_input() {
            return;
        }
        let command = ctx.input(|input| input.modifiers.command);
        if command && ctx.input(|input| input.key_pressed(egui::Key::Z)) {
            if ctx.input(|input| input.modifiers.shift) {
                self.redo(ctx);
            } else {
                self.undo(ctx);
            }
            return;
        }
        if command && ctx.input(|input| input.key_pressed(egui::Key::S)) {
            self.save_project();
            return;
        }
        if ctx.input(|input| input.key_pressed(egui::Key::Space)) {
            self.toggle_playback(ctx);
        }
        if ctx.input(|input| {
            input.key_pressed(egui::Key::Backspace) || input.key_pressed(egui::Key::Delete)
        }) {
            if !self.ripple_delete_selected_gap(ctx) {
                self.delete_selected(ctx);
            }
        }
        if ctx.input(|input| input.key_pressed(egui::Key::V)) {
            self.tool = EditTool::Select;
        }
        if ctx.input(|input| input.key_pressed(egui::Key::C)) {
            self.tool = EditTool::Razor;
        }
        let step = 1.0 / self.frame_rate().max(1.0);
        if ctx.input(|input| input.key_pressed(egui::Key::ArrowLeft)) {
            self.seek(self.current_time - step, ctx);
        }
        if ctx.input(|input| input.key_pressed(egui::Key::ArrowRight)) {
            self.seek(self.current_time + step, ctx);
        }
    }

    fn stop_all_playback(&mut self) {
        self.playback.stop();
        self.preloaded_playback = None;
        self.sequence_audio = None;
        self.sequence_audio_started = false;
        self.preserve_clock_on_start = false;
    }

    fn start_sequence_clock(&mut self) {
        if self.sequence_audio_started {
            return;
        }
        if let Some(audio) = &self.sequence_audio {
            if let Err(error) = audio.play() {
                self.status = Some(error);
                self.sequence_audio = None;
            }
        }
        self.playback_origin = self.current_time;
        self.playback_started = Instant::now();
        self.sequence_audio_started = true;
    }

    fn update_native_menu(&mut self, ctx: &egui::Context, frame: &eframe::Frame) {
        self.native_menu.attach_to_window(frame);
        let has_timeline_media = self
            .sequence
            .as_ref()
            .is_some_and(|sequence| !sequence.clips.is_empty());
        let workspace_open = self.project_session.is_some();
        self.native_menu.update_enabled(
            workspace_open,
            workspace_open && has_timeline_media && self.export_job.is_none(),
            self.can_undo(),
            self.can_redo(),
            has_timeline_media,
        );

        while let Some(action) = self.native_menu.poll() {
            match action {
                NativeMenuAction::NewProject => self.open_new_project_dialog(),
                NativeMenuAction::CloseProject => self.close_project(ctx),
                NativeMenuAction::Import => self.import_video(ctx),
                NativeMenuAction::Export => self.open_export(),
                NativeMenuAction::Undo => self.undo(ctx),
                NativeMenuAction::Redo => self.redo(ctx),
                NativeMenuAction::ZoomIn => {
                    self.timeline_zoom = (self.timeline_zoom * 1.35).clamp(1.0, 32.0);
                }
                NativeMenuAction::ZoomOut => {
                    self.timeline_zoom = (self.timeline_zoom / 1.35).clamp(1.0, 32.0);
                }
                NativeMenuAction::ResetZoom => self.timeline_zoom = 1.0,
            }
            ctx.request_repaint();
        }
    }
}

fn preview_decode_budget(ctx: &egui::Context) -> (usize, usize) {
    let pixels_per_point = ctx.pixels_per_point();
    let viewport = ctx.input(|input| {
        input
            .viewport()
            .inner_rect
            .map_or(egui::Vec2::new(1440.0, 900.0), |rect| rect.size())
    });
    let preview_height = (viewport.y - 360.0).max(360.0) * pixels_per_point;
    let preview_width = (viewport.x - 36.0).max(640.0) * pixels_per_point;

    (
        (preview_width.ceil() as usize).clamp(1280, 1920),
        (preview_height.ceil() as usize).clamp(720, 1080),
    )
}

fn supported_video_path(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ["mp4", "mov", "mkv", "avi", "webm", "m4v"]
                .iter()
                .any(|supported| extension.eq_ignore_ascii_case(supported))
        })
}

impl eframe::App for VideoEditor {
    fn update(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {
        self.update_native_menu(ctx, frame);
        ui::title_bar(ctx, self);
        if self.project_session.is_none() {
            ui::startup(ctx, self);
            ui::new_project_dialog(ctx, self);
            return;
        }
        self.update_clock();
        self.poll_external_media_probe(ctx);
        self.waveform_generator.set_playback_active(self.playing);
        self.sync_playback_segment(ctx);
        self.prepare_upcoming_transition(ctx);
        self.update_frame(ctx);
        self.poll_thumbnail(ctx);
        if let Some(result) = self.waveform_generator.poll() {
            let media_id = self.waveform_media.take();
            match result {
                Ok(waveform) => {
                    if let Some(id) = media_id {
                        self.waveforms.insert(id, waveform);
                    }
                }
                Err(error) if !error.contains("cancelled") => self.status = Some(error),
                Err(_) => {}
            }
            self.pump_waveform_queue(ctx);
        }
        self.poll_export();
        self.handle_shortcuts(ctx);

        ui::missing_media_dialog(ctx, self);
        ui::export_dialog(ctx, self);
        ui::export_progress_dialog(ctx, self);
        ui::export_notice(ctx, self);
        ui::media_info_dialog(ctx, self);
        ui::new_project_dialog(ctx, self);
        // Bottom chrome first so the timeline toggle strip stays under the island.
        ui::timeline_view_toggle(ctx, self);
        timeline::show(ctx, self);
        ui::media_panel(ctx, self);
        ui::properties_panel(ctx, self);
        ui::preview(ctx, self);
        self.tick_project();

        if self.playing || self.export_job.is_some() {
            ctx.request_repaint_after(std::time::Duration::from_millis(8));
        }
    }

    fn clear_color(&self, _visuals: &egui::Visuals) -> [f32; 4] {
        egui::Rgba::BLACK.to_array()
    }

    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        if self.project_session.is_some() {
            self.save_project();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        process::Command,
        thread,
        time::{Duration, Instant},
    };

    use super::{LibraryMedia, VideoEditor};
    use crate::{
        media::VideoAsset,
        project::{
            project_path, sequence::ClipColor, EditTool, ProjectDocument, ProjectSession,
            ProjectSettings, Sequence,
        },
    };

    #[test]
    fn history_is_bounded_and_a_transaction_creates_one_entry() {
        let mut editor = VideoEditor::new();
        editor.sequence = Some(Sequence::new(10.0));
        editor.initialize_history();
        editor.begin_history_transaction();
        editor.sequence.as_mut().unwrap().select_only(1);
        editor.commit_history_transaction();
        assert_eq!(editor.history.len(), 1);

        editor.begin_history_transaction();
        editor
            .sequence
            .as_mut()
            .unwrap()
            .split_at(5.0, 30.0)
            .expect("transaction should edit the sequence");
        editor.commit_history_transaction();
        assert_eq!(editor.history.len(), 2);

        for step in 0..150 {
            editor.sequence.as_mut().unwrap().clips[0].audio.volume_db = step as f32;
            editor.record_history();
        }
        assert_eq!(editor.history.len(), crate::project::MAX_HISTORY);
        assert_eq!(editor.history_index, crate::project::MAX_HISTORY - 1);
    }

    #[test]
    fn undo_restores_only_sequence_edits_and_preserves_current_selection() {
        let ctx = eframe::egui::Context::default();
        let mut sequence = Sequence::new(10.0);
        let second = sequence.split_at(5.0, 30.0).expect("second clip");
        let first = sequence.clips[0].id;
        sequence.select_only(first);

        let mut editor = VideoEditor::new();
        editor.sequence = Some(sequence);
        editor.initialize_history();
        assert!(editor
            .sequence
            .as_mut()
            .unwrap()
            .set_color_for_selection(first, ClipColor::Red));
        editor.record_history();

        editor.sequence.as_mut().unwrap().select_only(second);
        editor.current_time = 7.0;
        editor.timeline_zoom = 4.0;
        editor.timeline_height = 420.0;
        editor.tool = EditTool::Razor;
        editor.undo(&ctx);

        let restored = editor.sequence.as_ref().unwrap();
        assert_eq!(restored.clip(first).unwrap().color, ClipColor::Blue);
        assert_eq!(restored.selected, vec![second]);
        assert_eq!(editor.current_time, 7.0);
        assert_eq!(editor.timeline_zoom, 4.0);
        assert_eq!(editor.timeline_height, 420.0);
        assert_eq!(editor.tool, EditTool::Razor);
    }

    #[test]
    fn autosave_ignores_workspace_only_changes_but_saves_sequence_edits() {
        let directory =
            std::env::temp_dir().join(format!("unclip-autosave-test-{}", std::process::id()));
        let path = project_path(&directory, "Autosave");
        let document = ProjectDocument::empty("Autosave".to_owned(), ProjectSettings::default());

        let mut editor = VideoEditor::new();
        editor.project_session = Some(
            ProjectSession::new(path.clone(), document).expect("project session should start"),
        );
        editor.current_time = 7.0;
        editor.timeline_zoom = 4.0;
        editor.tool = EditTool::Razor;
        editor.tick_project();

        let session = editor.project_session.as_ref().unwrap();
        assert!(!session.is_dirty());
        assert_eq!(session.document.editor.current_time, 0.0);
        assert_eq!(session.document.editor.timeline_zoom, 1.0);
        assert_eq!(session.document.editor.tool, EditTool::Select);

        editor.sequence = Some(Sequence::new(10.0));
        editor.initialize_history();
        editor.sequence.as_mut().unwrap().clips[0].color = ClipColor::Red;
        editor.record_history();
        assert!(editor.project_session.as_ref().unwrap().is_dirty());
        editor.project_session.as_mut().unwrap().make_autosave_due();
        editor.tick_project();
        assert!(!editor.project_session.as_ref().unwrap().is_dirty());

        let saved = ProjectSession::open(path).expect("autosaved project should reopen");
        assert_eq!(saved.document.editor.current_time, 7.0);
        assert_eq!(saved.document.editor.timeline_zoom, 4.0);
        assert_eq!(saved.document.editor.tool, EditTool::Razor);
        assert_eq!(
            saved.document.sequence.unwrap().clips[0].color,
            ClipColor::Red
        );

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn preloads_the_next_clip_before_a_gap_and_crosses_the_boundary_without_waiting() {
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let path = std::env::temp_dir().join(format!(
            "unclip-gap-preroll-test-{}.mkv",
            std::process::id()
        ));
        let generated = Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=24",
                "-t",
                "2",
                "-c:v",
                "ffv1",
            ])
            .arg(&path)
            .status()
            .expect("test video should be generated");
        assert!(generated.success());

        let video = VideoAsset::load(path.clone()).expect("test video should load");
        let first_video = video.clone();
        let mut second_video = video.clone();
        second_video.source_width = 180;
        second_video.source_height = 320;
        let mut sequence = Sequence::new(video.duration);
        let middle = sequence.split_at(0.5, video.fps).expect("first cut");
        let tail = sequence.split_at(1.5, video.fps).expect("second cut");
        sequence.select(Some(middle));
        sequence.delete_selected();
        sequence
            .clips
            .iter_mut()
            .find(|clip| clip.id == tail)
            .expect("tail clip should exist")
            .media_id = 2;
        let first = sequence.clips[0].id;

        let ctx = eframe::egui::Context::default();
        let mut editor = VideoEditor::new();
        editor.video = Some(first_video.clone());
        editor.media_library = vec![
            LibraryMedia {
                id: 1,
                folder_id: None,
                asset: first_video,
                thumbnail: None,
            },
            LibraryMedia {
                id: 2,
                folder_id: None,
                asset: second_video,
                thumbnail: None,
            },
        ];
        editor.sequence = Some(sequence);
        editor.current_time = 0.25;
        editor.playing = true;
        editor.start_current_segment(&ctx);
        assert_eq!(editor.active_clip, Some(first));

        editor.current_time = 0.45;
        for _ in 0..100 {
            editor.prepare_upcoming_transition(&ctx);
            if editor
                .preloaded_playback
                .as_ref()
                .is_some_and(|(id, playback)| *id == tail && playback.is_ready())
            {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert!(editor
            .preloaded_playback
            .as_ref()
            .is_some_and(|(id, playback)| *id == tail && playback.is_ready()));

        editor.current_time = 0.5;
        editor.sync_playback_segment(&ctx);
        assert_eq!(editor.active_clip, Some(tail));
        assert_eq!(
            editor
                .video
                .as_ref()
                .map(|video| (video.source_width, video.source_height)),
            Some((180, 320))
        );
        assert!(editor.playback.is_ready());
        assert!(editor.preserve_clock_on_start);

        editor.current_time = 1.49;
        editor.playback_origin = 1.49;
        editor.playback_started = Instant::now() - Duration::from_millis(20);
        editor.sequence_audio_started = true;
        editor.update_clock();
        assert!(editor.current_time >= 1.5);
        let uninterrupted_origin = editor.playback_origin;
        for _ in 0..20 {
            editor.update_frame(&ctx);
            if !editor.preserve_clock_on_start {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        assert!(!editor.preserve_clock_on_start);
        assert_eq!(editor.playback_origin, uninterrupted_origin);
        editor.playback.stop();
        let _ = fs::remove_file(path);
    }
}
