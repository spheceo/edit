use std::{path::PathBuf, time::Instant};

use eframe::egui::{self, ColorImage, TextureHandle, TextureOptions};

use crate::{
    audio::SequenceAudioOutput,
    export::{ExportJob, ExportResult, ExportSettings, SequenceFormat},
    media::VideoAsset,
    playback::{DecodedFrame, PlaybackEngine},
    project::{
        self, EditorProjectState, EditorSnapshot, MediaReference, NewProjectDraft, ProjectDocument,
        ProjectSession, RecentProject, MAX_HISTORY,
    },
    sequence::{frame_duration, ClipId, EditTool, Sequence},
    timeline, ui,
    waveform::{Waveform, WaveformGenerator},
};

pub struct VideoEditor {
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
    pub export_message: Option<String>,
    pub media_info_clip: Option<ClipId>,
    pub timeline_zoom: f32,
    pub timecode_editing: bool,
    pub timecode_input: String,
    pub timecode_select_all: bool,
    pub timecode_error: bool,
    pub workspace_open: bool,
    pub project_session: Option<ProjectSession>,
    pub recent_projects: Vec<RecentProject>,
    pub new_project_dialog_open: bool,
    pub new_project_draft: NewProjectDraft,
    pub missing_media: Option<MediaReference>,
    playback: PlaybackEngine,
    preloaded_playback: Option<(ClipId, PlaybackEngine)>,
    sequence_audio: Option<SequenceAudioOutput>,
    sequence_audio_started: bool,
    waveform_generator: WaveformGenerator,
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
            export_message: None,
            media_info_clip: None,
            timeline_zoom: 1.0,
            timecode_editing: false,
            timecode_input: String::new(),
            timecode_select_all: false,
            timecode_error: false,
            workspace_open: false,
            project_session: None,
            recent_projects: project::load_recent_projects(),
            new_project_dialog_open: false,
            new_project_draft: NewProjectDraft::default(),
            missing_media: None,
            playback: PlaybackEngine::new(),
            preloaded_playback: None,
            sequence_audio: None,
            sequence_audio_started: false,
            waveform_generator: WaveformGenerator::new(),
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

    pub fn create_project(&mut self, ctx: &egui::Context) {
        let name = self.new_project_draft.name.trim();
        if name.is_empty() {
            self.status = Some("Enter a project name.".to_owned());
            return;
        }
        let path = project::project_path(&self.new_project_draft.directory, name);
        if path.exists() {
            self.status =
                Some("A project with that name already exists in this folder.".to_owned());
            return;
        }
        let document =
            ProjectDocument::empty(name.to_owned(), self.new_project_draft.settings.clone());
        match ProjectSession::new(path.clone(), document) {
            Ok(session) => {
                self.reset_editor(ctx);
                self.project_session = Some(session);
                self.workspace_open = true;
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
            .add_filter("Kuro project", &["kuro"])
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
                self.tool = document.editor.tool;
                self.export_settings = document.editor.export_settings.clone();
                self.sequence = document.sequence.clone();
                self.project_session = Some(session);
                self.workspace_open = true;
                self.missing_media = None;
                if let Some(media) = document.active_media().cloned() {
                    if media.path.exists() {
                        if let Err(error) = self.load_video_path(media.path.clone(), false, ctx) {
                            self.status = Some(error);
                            self.missing_media = Some(media);
                        }
                    } else {
                        self.missing_media = Some(media);
                        self.status =
                            Some("Project media is missing. Relink it to continue.".to_owned());
                    }
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
        match self.load_video_path(path.clone(), false, ctx) {
            Ok(()) => {
                if let Some(session) = &mut self.project_session {
                    if let Some(media) = session
                        .document
                        .media
                        .iter_mut()
                        .find(|media| media.id == missing.id)
                    {
                        media.path = path;
                        media.name = self
                            .video
                            .as_ref()
                            .map_or_else(|| missing.name.clone(), |video| video.name.clone());
                    }
                    session.dirty_since = Some(Instant::now());
                }
                self.missing_media = None;
            }
            Err(error) => self.status = Some(error),
        }
    }

    fn load_video_path(
        &mut self,
        path: PathBuf,
        reset_sequence: bool,
        ctx: &egui::Context,
    ) -> Result<(), String> {
        let mut video = VideoAsset::load(path)?;
        let (max_width, max_height) = preview_decode_budget(ctx);
        video.set_decode_budget(max_width, max_height);
        self.texture = None;
        if reset_sequence || self.sequence.is_none() {
            self.current_time = 0.0;
            self.sequence = Some(Sequence::new(video.duration));
            self.timeline_zoom = 1.0;
        }
        self.waveform = None;
        self.media_info_clip = None;
        self.timecode_editing = false;
        self.timecode_input.clear();
        self.timecode_select_all = false;
        self.timecode_error = false;
        self.export_message = None;
        self.status = Some(format!(
            "{} × {}  ·  {:.2} fps{}",
            video.source_width,
            video.source_height,
            video.fps,
            if video.has_audio { "  ·  audio" } else { "" }
        ));
        self.preview_source_time = Some(0.0);
        self.playback.request_preview(&video, 0.0, ctx);
        if video.has_audio {
            self.waveform_generator
                .request(&video.path, video.duration, ctx.clone());
        }
        self.video = Some(video);
        Ok(())
    }

    fn reset_editor(&mut self, ctx: &egui::Context) {
        self.pause(ctx);
        self.video = None;
        self.sequence = None;
        self.texture = None;
        self.waveform = None;
        self.current_time = 0.0;
        self.timeline_zoom = 1.0;
        self.tool = EditTool::Select;
        self.export_settings = ExportSettings::default();
        self.missing_media = None;
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
        EditorSnapshot {
            sequence: self.sequence.clone(),
            current_time: self.current_time,
            timeline_zoom: self.timeline_zoom,
            tool: self.tool,
            export_settings: self.export_settings.clone(),
        }
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
            session.dirty_since = Some(Instant::now());
        }
    }

    fn apply_history_snapshot(&mut self, snapshot: EditorSnapshot, ctx: &egui::Context) {
        self.pause(ctx);
        self.sequence = snapshot.sequence;
        self.current_time = snapshot.current_time.clamp(0.0, self.duration());
        self.timeline_zoom = if self.sequence.is_some() {
            snapshot.timeline_zoom.clamp(1.0, 32.0)
        } else {
            1.0
        };
        self.tool = snapshot.tool;
        self.export_settings = snapshot.export_settings;
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

    pub fn redo(&mut self, ctx: &egui::Context) {
        if self.history_index + 1 >= self.history.len() {
            return;
        }
        self.history_transaction = None;
        self.history_index += 1;
        self.apply_history_snapshot(self.history[self.history_index].clone(), ctx);
    }

    fn sync_project_document(&mut self) {
        let editor = EditorProjectState {
            current_time: self.current_time,
            timeline_zoom: self.timeline_zoom,
            tool: self.tool,
            export_settings: self.export_settings.clone(),
        };
        let current_media = self.video.as_ref().map(|video| MediaReference {
            id: self
                .project_session
                .as_ref()
                .and_then(|session| session.document.active_media_id)
                .unwrap_or(1),
            path: video.path.clone(),
            name: video.name.clone(),
        });
        let Some(session) = &mut self.project_session else {
            return;
        };
        session.document.sequence = self.sequence.clone();
        session.document.editor = editor;
        if let Some(media) = current_media {
            session.document.active_media_id = Some(media.id);
            if let Some(existing) = session
                .document
                .media
                .iter_mut()
                .find(|item| item.id == media.id)
            {
                *existing = media;
            } else {
                session.document.media.push(media);
            }
        }
    }

    fn tick_project(&mut self) {
        if !self.workspace_open || self.history_transaction.is_some() {
            return;
        }
        self.sync_project_document();
        let result = self.project_session.as_mut().map(|session| {
            session.observe_changes()?;
            session.autosave_if_due()
        });
        if let Some(Err(error)) = result {
            self.status = Some(format!("Project autosave failed: {error}"));
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
            .pick_file();
        let Some(path) = selected else { return };

        self.pause(ctx);
        match self.load_video_path(path, true, ctx) {
            Ok(()) => {
                // Import establishes the editable sequence baseline. Keeping it as the
                // first snapshot means the first cut/trim undoes back to the full clip,
                // rather than to an empty project with a still-loaded decoder.
                self.initialize_history();
                if let Some(session) = &mut self.project_session {
                    session.dirty_since = Some(Instant::now());
                }
            }
            Err(error) => self.status = Some(error),
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
        let duration = self.duration();
        if self.current_time >= duration - 0.001 {
            self.current_time = 0.0;
        }
        self.playback_origin = self.current_time;
        self.playback_started = Instant::now();
        self.sequence_audio_started = false;
        let sequence_audio = match (&self.video, &self.sequence) {
            (Some(video), Some(sequence)) if video.has_audio => {
                match SequenceAudioOutput::prepare(&video.path, sequence, self.current_time) {
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

    pub fn pause(&mut self, ctx: &egui::Context) {
        if self.playing {
            self.update_clock();
        }
        self.playing = false;
        self.stop_all_playback();
        self.active_clip = None;
        self.refresh_preview(ctx);
    }

    pub fn seek(&mut self, time: f64, ctx: &egui::Context) {
        if self.playing {
            self.playing = false;
        }
        self.stop_all_playback();
        if self.video.is_none() || self.sequence.is_none() {
            self.current_time = 0.0;
            return;
        }
        self.active_clip = None;
        self.current_time = time.clamp(0.0, self.duration());
        self.refresh_preview(ctx);
        ctx.request_repaint();
    }

    pub fn duration(&self) -> f64 {
        self.sequence
            .as_ref()
            .map_or(0.0, |sequence| sequence.duration)
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

    pub fn select_clip(&mut self, selected: Option<ClipId>) {
        if let Some(sequence) = &mut self.sequence {
            sequence.select(selected);
        }
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

    pub fn trim_left(&mut self, id: ClipId, time: f64, ctx: &egui::Context) {
        if self.video.is_none() {
            return;
        }
        let fps = self.frame_rate();
        if self.playing {
            self.pause(ctx);
        }
        let trimmed = self
            .sequence
            .as_mut()
            .and_then(|sequence| sequence.trim_left(id, time, fps));
        if let Some(time) = trimmed {
            self.select_clip(Some(id));
            self.seek(time, ctx);
        }
    }

    pub fn trim_right(&mut self, id: ClipId, time: f64, ctx: &egui::Context) {
        if self.video.is_none() {
            return;
        }
        let fps = self.frame_rate();
        if self.playing {
            self.pause(ctx);
        }
        let trimmed = self
            .sequence
            .as_mut()
            .and_then(|sequence| sequence.trim_right(id, time, fps));
        if let Some(time) = trimmed {
            self.select_clip(Some(id));
            self.seek((time - frame_duration(fps)).max(0.0), ctx);
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
                || "Kuro Export.mp4".to_owned(),
                |name| format!("{name} - Kuro.mp4"),
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
            self.export_message = Some(
                "Choose a different file name so the source video is not overwritten.".to_owned(),
            );
            return;
        }
        self.pause(ctx);
        self.export_dialog_open = false;
        self.export_message = None;
        self.export_job = Some(ExportJob::start(
            video,
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

    fn poll_export(&mut self) {
        let result = self.export_job.as_ref().and_then(ExportJob::poll);
        if let Some(result) = result {
            self.export_job = None;
            self.export_message = Some(match result {
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
        let source_time = self
            .sequence
            .as_ref()
            .and_then(|sequence| sequence.source_time_at(self.current_time));
        self.preview_source_time = source_time;
        if let (Some(video), Some(source_time)) = (&self.video, source_time) {
            self.playback.request_preview(video, source_time, ctx);
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
        let Some(video) = &self.video else { return };
        self.active_clip = Some(clip_id);
        match self.playback.start(video, source_time, ctx) {
            Ok(()) => {}
            Err(error) => {
                self.status = Some(error);
                self.playing = false;
                self.active_clip = None;
                self.stop_all_playback();
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
            let next = sequence
                .clips
                .iter()
                .find(|clip| clip.timeline_start >= active.timeline_end - 0.000_001)?;
            let continuous = (active.timeline_end - next.timeline_start).abs() < 0.000_001
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
            let Some(video) = &self.video else { return };
            let mut playback = PlaybackEngine::new();
            match playback.start(video, upcoming.source_in, ctx) {
                Ok(()) => {}
                Err(error) => {
                    self.status = Some(error);
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
                .find(|clip| clip.timeline_start > self.current_time + 0.000_001)
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
            self.texture = Some(ctx.load_texture("kuro-video", image, TextureOptions::LINEAR));
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
            self.delete_selected(ctx);
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

impl eframe::App for VideoEditor {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        ui::title_bar(ctx);
        if !self.workspace_open {
            ui::startup(ctx, self);
            ui::new_project_dialog(ctx, self);
            return;
        }
        self.update_clock();
        self.sync_playback_segment(ctx);
        self.prepare_upcoming_transition(ctx);
        self.update_frame(ctx);
        if let Some(result) = self.waveform_generator.poll() {
            match result {
                Ok(waveform) => self.waveform = Some(waveform),
                Err(error) if !error.contains("cancelled") => self.status = Some(error),
                Err(_) => {}
            }
        }
        self.poll_export();
        self.handle_shortcuts(ctx);

        ui::toolbar(ctx, self);
        ui::missing_media_dialog(ctx, self);
        ui::export_dialog(ctx, self);
        ui::media_info_dialog(ctx, self);
        timeline::show(ctx, self);
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
        if self.workspace_open {
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

    use super::VideoEditor;
    use crate::{media::VideoAsset, sequence::Sequence};

    #[test]
    fn history_is_bounded_and_a_transaction_creates_one_entry() {
        let mut editor = VideoEditor::new();
        editor.sequence = Some(Sequence::new(10.0));
        editor.initialize_history();
        editor.begin_history_transaction();
        for step in 1..=20 {
            editor.current_time = step as f64 / 10.0;
        }
        editor.commit_history_transaction();
        assert_eq!(editor.history.len(), 2);

        for step in 0..150 {
            editor.current_time = 3.0 + step as f64 / 100.0;
            editor.record_history();
        }
        assert_eq!(editor.history.len(), crate::project::MAX_HISTORY);
        assert_eq!(editor.history_index, crate::project::MAX_HISTORY - 1);
    }

    #[test]
    fn preloads_the_next_clip_before_a_gap_and_crosses_the_boundary_without_waiting() {
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let path =
            std::env::temp_dir().join(format!("kuro-gap-preroll-test-{}.mkv", std::process::id()));
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
        let mut sequence = Sequence::new(video.duration);
        let middle = sequence.split_at(0.5, video.fps).expect("first cut");
        let tail = sequence.split_at(1.5, video.fps).expect("second cut");
        sequence.select(Some(middle));
        sequence.delete_selected();
        let first = sequence.clips[0].id;

        let ctx = eframe::egui::Context::default();
        let mut editor = VideoEditor::new();
        editor.video = Some(video);
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
