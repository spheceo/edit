//! The native preview (docs/plans/2026-11-06-native-player.md): the edit drawn
//! in Edit.app's window by the engine itself, not in the page. The page's
//! preview decoded every picture in WebCodecs workers and drew it with this
//! same renderer compiled to WebAssembly (crates/edit-wasm); here the pictures
//! come from the Mac's video decoder through the export's readers (a reader
//! just behind a frame decodes forward, anything else seeks), and the frame is
//! presented onto a Core Animation layer under the page. It draws exactly what
//! the page's engine drew: the same scene (`evaluate_seen`), the same
//! compositor, the same letterbox, black around it; the colours are the
//! export's, as its pictures are decoded as the export decodes them.
//!
//! At rest the page owns the playhead and asks for each frame. Playing, the
//! player runs on one clock, the speaker's (`mac_media::Speaker`): the edit's
//! sound is mixed here as the export mixes it (`crate::mix`, a quarter second
//! at a time into the speaker's ring), the frames the speaker has played say
//! where the playhead is, the picture follows them, and the page follows the
//! player (`position`). Short of sound the clock holds, so the picture never
//! runs ahead of the sound and sound never skips to catch up (the page's own
//! clock did, and its sound was decoded in the page from the same footage).
//!
//! Cuts are decoded ahead: the clips starting within the next seconds have a
//! reader opened and seeked to their first frame on other threads
//! (`PreviewPictures::warm`), so the cut reads on from it instead of paying a
//! 20-80 ms seek (and a 2-120 ms open) on the drawing path; a jump the page
//! knows about ahead of time (`hint`) is warmed the same way.
//!
//! The page sends the edit whole once (`set_project`) and then only what
//! changed (`apply_patch`, the page's lib/patch.ts): a drag on Cops Realize
//! sent its 2.4 MB ten times a second, 26 MB/s through the window's IPC, each
//! parsed again here (Nov 8). Every update carries the page's revision, and
//! the player answers with the one it now draws, or why it refused: a refused
//! update leaves the last one on screen, and the page has to know.

use std::collections::HashMap;
use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use edit_core::{evaluate_seen, ClipContent, Layer, Project};
use edit_render::{text::BUNDLED_FONTS, wgpu, Renderer};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::Value;

use crate::mac_media::Speaker;
use crate::mix::{self, Part, RATE};
use crate::render::{decode_stats, feed_peaks, heard_segments, PreviewPictures};

/// Each call and draw said on stderr (`EDIT_PREVIEW_TRACE=1`), to see what the preview does without looking.
pub fn trace(what: impl FnOnce() -> String) {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if *ON.get_or_init(|| std::env::var_os("EDIT_PREVIEW_TRACE").is_some()) {
        eprintln!("edit preview: {}", what());
    }
}

/// How far ahead of the playhead the cuts' readers are opened and seeked (seconds).
const AHEAD_SECONDS: f64 = 3.0;
/// Sound mixed ahead of the speaker, and each window handed to it (seconds).
const SOUND_AHEAD_SECONDS: f64 = 2.0;
const SOUND_WINDOW_SECONDS: f64 = 0.25;
/// A frame drawn slower than this is counted as slow (two frames at 60 fps).
const SLOW_MS: f64 = 33.0;

/// Where one drawn frame's time went, in milliseconds (the decoders' share by kind in `decoders`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DrawTimes {
    pub evaluate: f64,
    pub decode: f64,
    pub upload: f64,
    pub composite: f64,
    pub present: f64,
    pub layers: usize,
    pub decoders: decode_stats::Taken,
}

pub struct Player {
    renderer: Renderer,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    pictures: PreviewPictures,
    project: Option<Project>,
    /// The project as the page sent it (patches apply to this), and the page's revision of it.
    value: Option<Value>,
    revision: u64,
    /// What each media is decoded from: its preview file on this Mac, else a URL the server answers.
    sources: HashMap<String, PathBuf>,
    /// What each media's sound is read from (its picture's file when the page named none).
    sounds: HashMap<String, PathBuf>,
    /// The media cache: waveforms' sound levels.
    cache: PathBuf,
    /// The frame on screen, and whether the project or size changed since.
    drawn: Option<i64>,
    /// The last frame drawn's timings (None when the last ask needed no drawing).
    pub last: Option<DrawTimes>,
    sound: Sound,
    playing: Option<Playing>,
    /// The frame the last decode-ahead pass ran from (None: run one).
    warmed_from: Option<i64>,
    /// How playing went since the page last asked (`position`).
    report: Report,
    /// The speaker's starved count when the page last asked.
    starved_before: u64,
}

/// What's playing: the clock started at `from` seconds of the timeline with
/// the speaker's count at `played_at_start`, and stops at frame `until`.
struct Playing {
    from: f64,
    until: i64,
    played_at_start: u64,
}

/// A mixer thread filling the speaker from `from` seconds of the timeline.
struct Mixer {
    from: f64,
    cancel: Arc<AtomicBool>,
}

impl Drop for Mixer {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
    }
}

/// The speaker shared with the mixer thread: a write names the mixer's
/// generation, and a flush (a seek, a stop) moves the generation on, so a
/// mixer cancelled mid-window can't write into the sound that follows.
struct Feed {
    speaker: Speaker,
    generation: AtomicU64,
    writing: Mutex<()>,
}

impl Feed {
    /// Writes `samples` (interleaved stereo) for mixer `generation`, as much as fits; None when the mixer is stale.
    fn write(&self, generation: u64, samples: &[f32]) -> Option<usize> {
        let _guard = self.writing.lock();
        if self.generation.load(Ordering::Acquire) != generation {
            return None;
        }
        Some(self.speaker.write(samples))
    }

    fn flush(&self) -> u64 {
        let _guard = self.writing.lock();
        self.speaker.flush();
        self.generation.fetch_add(1, Ordering::AcqRel) + 1
    }
}

/// The player's sound: the speaker, opened on the first play, and the mixer feeding it.
#[derive(Default)]
struct Sound {
    feed: Option<Arc<Feed>>,
    /// The speaker couldn't open: playing runs on a clock of its own, silent.
    refused: bool,
    mixer: Option<Mixer>,
    /// A clock with no speaker: when it started and from where.
    silent: Option<Instant>,
}

/// How playing went since the page last asked: frames drawn, frames the clock
/// passed before they were drawn, slow draws, the draws' times, and the
/// speaker's output calls that ran short.
#[derive(Default, Clone)]
pub struct Report {
    pub drawn: u64,
    pub skipped: u64,
    pub slow: u64,
    pub draws: Vec<f64>,
    pub starved: u64,
    /// Playing reached its end (the edit's, or the out point) since the last ask.
    pub ended: bool,
}

/// Where the player is: the playhead (a frame and a fraction), whether it's
/// playing, and why it stopped (the end, or asked to).
pub struct Position {
    pub frame: f64,
    pub playing: bool,
    pub ended: bool,
    pub report: Report,
}

impl Player {
    /// A player drawing into `layer`, `width`×`height` pixels.
    ///
    /// # Safety
    /// `layer` is a `CAMetalLayer` that outlives the player.
    pub unsafe fn new(layer: *mut c_void, width: u32, height: u32) -> Result<Self, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        // SAFETY: the caller keeps the layer alive for as long as the player.
        let surface = unsafe {
            instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(layer))
        }
        .map_err(|error| format!("the window's picture layer: {error}"))?;
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
            apply_limit_buckets: false,
        }))
        .map_err(|error| format!("no GPU for the preview: {error}"))?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("edit preview"),
            required_limits: wgpu::Limits::default().using_resolution(adapter.limits()),
            ..Default::default()
        }))
        .map_err(|error| format!("GPU device: {error}"))?;
        let caps = surface.get_capabilities(&adapter);
        let (Some(&first), Some(&alpha_mode)) = (caps.formats.first(), caps.alpha_modes.first())
        else {
            return Err("this GPU can't draw the preview".to_owned());
        };
        // Pixels are already sRGB-encoded, so present through a non-sRGB view (as the page's canvas).
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|format| !format.is_srgb())
            .unwrap_or(first);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: width.max(1),
            height: height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 1,
            alpha_mode,
            view_formats: vec![],
            color_space: wgpu::SurfaceColorSpace::Auto,
        };
        surface.configure(&device, &config);
        let mut renderer = Renderer::new(device, queue, 1920, 1080);
        for (family, weight, file) in BUNDLED_FONTS {
            if let Some(bytes) = edit_render::text::bundled_font_bytes(file) {
                renderer.fonts_mut().add(family, *weight, bytes)?;
            }
        }
        Ok(Self {
            renderer,
            surface,
            config,
            pictures: PreviewPictures::new(),
            project: None,
            value: None,
            revision: 0,
            sources: HashMap::new(),
            sounds: HashMap::new(),
            cache: PathBuf::new(),
            drawn: None,
            last: None,
            sound: Sound::default(),
            playing: None,
            warmed_from: None,
            report: Report::default(),
            starved_before: 0,
        })
    }

    /// The edit to draw (the page's JSON, as its engine takes it) at the
    /// page's `revision`, what each media is decoded from and what its sound
    /// is read from, the local excerpts of streamed ones (`crate::excerpts`:
    /// a pieced proxy's pieces on this Mac), and the media cache. Refused,
    /// the last edit stays.
    pub fn set_project(
        &mut self,
        json: &str,
        revision: u64,
        sources: HashMap<String, String>,
        sounds: HashMap<String, String>,
        excerpts: HashMap<String, Vec<crate::excerpts::Excerpt>>,
        cache: PathBuf,
    ) -> Result<u64, String> {
        let value: Value = serde_json::from_str(json).map_err(|error| error.to_string())?;
        let project = Project::deserialize(&value).map_err(|error| error.to_string())?;
        project.validate()?;
        let sources: HashMap<String, PathBuf> = sources
            .into_iter()
            .map(|(media, path)| (media, PathBuf::from(path)))
            .collect();
        let sounds: HashMap<String, PathBuf> = sounds
            .into_iter()
            .map(|(media, path)| (media, PathBuf::from(path)))
            .collect();
        for (media, list) in excerpts {
            if let Some(object) = sources
                .get(&media)
                .and_then(|path| crate::excerpts::object_of(path))
            {
                crate::excerpts::add(&object, list);
            }
        }
        // A media decoded from another file now: its readers of the old one go.
        if sources != self.sources {
            self.pictures.clear();
        }
        if sounds != self.sounds {
            self.sound.disarm();
        }
        self.sources = sources;
        self.sounds = sounds;
        self.cache = cache;
        self.take(project, value, revision);
        Ok(revision)
    }

    /// What changed since `base` (the page's lib/patch.ts), making `revision`.
    /// Refused when the player isn't at `base` or the patch doesn't fit: the
    /// page sends the whole edit then.
    pub fn apply_patch(&mut self, base: u64, revision: u64, patch: &str) -> Result<u64, String> {
        if self.revision != base || self.value.is_none() {
            return Err(format!(
                "the window has revision {}, not {base}",
                self.revision
            ));
        }
        let patch: Value = serde_json::from_str(patch).map_err(|error| error.to_string())?;
        // Applied in place; refused, the window has no edit to patch until the next whole one.
        let mut value = self.value.take().unwrap_or(Value::Null);
        edit_core::patch::apply(&mut value, &patch)?;
        if let Some(project) = self
            .project
            .as_mut()
            .filter(|_| edit_core::patch::only_clips(&patch))
        {
            // A drag, a trim, a title typed: the clips that changed, not the whole edit parsed again
            // (2.4 MB of Cops Realize took 22 ms a patch that way, Nov 8).
            edit_core::patch::patch_clips(project, &patch)?;
            self.value = Some(value);
            self.revision = revision;
            self.changed();
            return Ok(revision);
        }
        let project = Project::deserialize(&value).map_err(|error| error.to_string())?;
        project.validate()?;
        self.take(project, value, revision);
        Ok(revision)
    }

    /// The revision on screen (0: none yet).
    pub fn revision(&self) -> u64 {
        self.revision
    }

    fn take(&mut self, project: Project, value: Value, revision: u64) {
        if self.project.as_ref().map(|old| &old.id) != Some(&project.id) {
            self.renderer.clear_peaks();
            self.pictures.clear();
            self.stop();
        }
        self.renderer
            .resize(project.settings.width, project.settings.height);
        self.project = Some(project);
        self.value = Some(value);
        self.revision = revision;
        self.changed();
    }

    /// The edit changed: drawn again, the cuts ahead looked at again, and a
    /// mix armed for an edit that's gone dropped (one playing plays on: the
    /// picture is the new edit's, the sound catches up at the next play).
    fn changed(&mut self) {
        self.drawn = None;
        self.warmed_from = None;
        if self.playing.is_none() {
            self.sound.disarm();
        }
    }

    /// The layer's size in pixels changed.
    pub fn resize(&mut self, width: u32, height: u32) {
        let (width, height) = (width.max(1), height.max(1));
        if (width, height) == (self.config.width, self.config.height) {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(self.renderer.device(), &self.config);
        self.drawn = None;
        self.warmed_from = None;
    }

    /// Pictures are decoded no bigger than they're shown: the edit's size fitted into the layer.
    fn shown(&self, project: &Project) -> (u32, u32) {
        let (width, height) = (
            project.settings.width.max(1),
            project.settings.height.max(1),
        );
        let fit = (self.config.width as f32 / width as f32)
            .min(self.config.height as f32 / height as f32)
            .min(1.0);
        (
            ((width as f32 * fit).round() as u32).max(2),
            ((height as f32 * fit).round() as u32).max(2),
        )
    }

    /// Draws `frame`, unless it's on screen already (nothing changed since).
    pub fn draw(&mut self, frame: i64) -> Result<(), String> {
        self.last = None;
        if self.drawn == Some(frame) {
            return Ok(());
        }
        let Some(project) = &self.project else {
            return Err("no edit to draw yet".to_owned());
        };
        let ms = |since: Instant| since.elapsed().as_secs_f64() * 1000.0;
        let mut times = DrawTimes::default();
        let started = Instant::now();
        decode_stats::take();
        let scene = evaluate_seen(project, frame);
        times.evaluate = ms(started);
        let shown = self.shown(project);
        let started = Instant::now();
        let pictures = self.pictures.decode(project, &scene, shown, &self.sources);
        times.decoders = decode_stats::take();
        let pictures = pictures?;
        times.decode = ms(started);
        times.layers = pictures.len();
        let started = Instant::now();
        for (clip, width, height, pixels) in &pictures {
            self.renderer
                .upload_video(clip, *width, *height, pixels, true);
        }
        feed_peaks(&mut self.renderer, project, &scene, &self.cache);
        times.upload = ms(started);
        let started = Instant::now();
        self.renderer.render(&scene);
        times.composite = ms(started);
        let started = Instant::now();
        self.present()?;
        times.present = ms(started);
        self.drawn = Some(frame);
        self.last = Some(times);
        Ok(())
    }

    /// The last frame drawn, letterboxed into the layer as the page's canvas was (crates/edit-wasm `present`).
    fn present(&mut self) -> Result<(), String> {
        let texture = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(texture)
            | wgpu::CurrentSurfaceTexture::Suboptimal(texture) => texture,
            other => {
                self.surface.configure(self.renderer.device(), &self.config);
                return Err(format!("the preview's surface: {other:?}"));
            }
        };
        let view = texture
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let (width, height) = self.renderer.size();
        let (cw, ch) = (self.config.width as f32, self.config.height as f32);
        let fit = (cw / width as f32).min(ch / height as f32);
        let w = (width as f32 * fit).round().min(cw);
        let h = (height as f32 * fit).round().min(ch);
        let viewport = [((cw - w) / 2.0).floor(), ((ch - h) / 2.0).floor(), w, h];
        self.renderer
            .present(&view, self.config.format, viewport, wgpu::Color::BLACK);
        self.renderer.queue().present(texture);
        Ok(())
    }

    /// Lets go of the decoders and the sound (the preview is hidden); they open again on the next frame.
    pub fn rest(&mut self) {
        self.stop();
        self.sound.disarm();
        self.pictures.clear();
        self.drawn = None;
        self.warmed_from = None;
    }

    // ----------------------------------------------------------------------
    // Decoding ahead

    /// Opens and seeks readers for the cuts within the next seconds of `frame`
    /// (and at `frame` itself, for a jump told ahead), on other threads. Run
    /// once per half second of playhead, and again when the edit changes.
    pub fn warm_ahead(&mut self, frame: i64, jump: bool) {
        let Some(project) = &self.project else { return };
        let fps = project.fps();
        if !jump
            && self
                .warmed_from
                .is_some_and(|from| frame >= from && (frame - from) as f64 <= fps / 2.0)
        {
            return;
        }
        self.warmed_from = Some(frame);
        let shown = self.shown(project);
        let hidden: std::collections::HashSet<&str> = project
            .tracks
            .iter()
            .filter(|track| track.hidden)
            .map(|track| track.id.as_str())
            .collect();
        let until = frame + (AHEAD_SECONDS * fps).ceil() as i64;
        let mut cuts: Vec<i64> = project
            .clips
            .iter()
            .filter(|clip| {
                matches!(clip.content, ClipContent::Video { .. })
                    && !hidden.contains(clip.track.as_str())
                    && clip.start > frame
                    && clip.start <= until
            })
            .map(|clip| clip.start)
            .collect();
        if jump {
            cuts.push(frame);
        }
        cuts.sort_unstable();
        cuts.dedup();
        for cut in cuts {
            let scene = evaluate_seen(project, cut);
            for layer in &scene.layers {
                if let Layer::Video {
                    media, source_time, ..
                } = layer
                {
                    self.pictures
                        .warm(project, media, *source_time, shown, &self.sources);
                }
            }
        }
    }

    /// The page knows where the playhead will land: its pictures are made ready now.
    pub fn hint(&mut self, frame: i64) {
        self.warm_ahead(frame, true);
    }

    // ----------------------------------------------------------------------
    // Playing

    /// Where the clock stops for a play from `from`: the out point when the
    /// play starts before it, else the edit's end (as the page's tick did).
    fn until(project: &Project, from: i64) -> i64 {
        let duration = project.duration();
        match project.mark_out {
            Some(out) if from < out && out < duration => out,
            _ => duration,
        }
    }

    /// Plays from `frame` on the speaker's clock. The sound is mixed from
    /// there (or carries on, armed there by `settle`), the picture follows.
    pub fn play(&mut self, frame: i64) -> Result<(), String> {
        let Some(project) = &self.project else {
            return Err("no edit to play yet".to_owned());
        };
        let fps = project.fps();
        let until = Self::until(project, frame);
        if frame >= until {
            return Err("at the end".to_owned());
        }
        let from = frame as f64 / fps;
        self.stop();
        let started = Instant::now();
        let from = self.arm(from, until);
        let played_at_start = self
            .sound
            .feed
            .as_ref()
            .map_or(0, |feed| feed.speaker.state().played);
        self.playing = Some(Playing {
            from,
            until,
            played_at_start,
        });
        match &self.sound.feed {
            Some(feed) => feed.speaker.run(true),
            None => self.sound.silent = Some(Instant::now()),
        }
        self.warmed_from = None;
        trace(|| {
            format!(
                "play from {frame} to {until}, sound {} in {:.1} ms",
                if self.sound.feed.is_some() {
                    "on the speaker"
                } else {
                    "silent (no speaker)"
                },
                started.elapsed().as_secs_f64() * 1000.0
            )
        });
        Ok(())
    }

    /// Stops playing; the frame the playhead rests on. The sound stays armed
    /// there, so playing on from it starts at once.
    pub fn pause(&mut self) -> Option<i64> {
        let at = self.playing.as_ref().map(|_| self.clock_frame());
        if let Some(feed) = &self.sound.feed {
            feed.speaker.run(false);
        }
        // The mix goes on from where the speaker's ring stopped (what's buffered is the sound from
        // there), which is a speaker's latency ahead of what was heard.
        let resumed = self.playing.take().map(|playing| {
            let played = self.sound.feed.as_ref().map_or_else(
                || self.played_seconds(&playing),
                |feed| {
                    feed.speaker
                        .state()
                        .played
                        .saturating_sub(playing.played_at_start) as f64
                        / RATE as f64
                },
            );
            playing.from + played
        });
        self.sound.silent = None;
        if let (Some(from), Some(mixer)) = (resumed, self.sound.mixer.as_mut()) {
            mixer.from = from;
        }
        if let Some(at) = at {
            trace(|| format!("paused at {at}"));
        }
        at
    }

    fn stop(&mut self) {
        if self.playing.is_some() {
            self.pause();
        }
    }

    /// Seconds of sound played since the clock started.
    fn played_seconds(&self, playing: &Playing) -> f64 {
        match (&self.sound.feed, self.sound.silent) {
            (Some(feed), _) => {
                let state = feed.speaker.state();
                let played =
                    state.played.saturating_sub(playing.played_at_start) as f64 / RATE as f64;
                // What's heard now left the ring a moment ago.
                (played - feed.speaker.latency().clamp(0.0, 0.2)).max(0.0)
            }
            (None, Some(since)) => since.elapsed().as_secs_f64(),
            (None, None) => 0.0,
        }
    }

    /// The timeline position the clock says, in frames (a fraction too).
    fn clock_position(&self) -> Option<f64> {
        let (playing, project) = (self.playing.as_ref()?, self.project.as_ref()?);
        Some((playing.from + self.played_seconds(playing)) * project.fps())
    }

    fn clock_frame(&self) -> i64 {
        self.clock_position().map_or(0, |at| at.floor() as i64)
    }

    /// Playing: draws the clock's frame when it moved on, stops at the end;
    /// how long until the next frame is due (None: not playing).
    pub fn tick(&mut self) -> Option<Duration> {
        let (at, until, fps) = {
            let playing = self.playing.as_ref()?;
            let fps = self.project.as_ref()?.fps();
            (self.clock_position()?, playing.until, fps)
        };
        let frame = at.floor() as i64;
        if frame >= until {
            self.pause();
            self.drawn = None;
            let _ = self.draw(until.max(1) - 1);
            self.report.ended = true;
            return None;
        }
        if self.drawn != Some(frame) {
            if let Some(drawn) = self.drawn.filter(|drawn| frame > *drawn + 1) {
                self.report.skipped += (frame - drawn - 1) as u64;
            }
            let started = Instant::now();
            let drawn = self.draw(frame);
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            if drawn.is_ok() {
                self.report.drawn += 1;
                self.report.draws.push(ms);
                if ms > SLOW_MS {
                    self.report.slow += 1;
                }
            }
            trace(|| describe_draw(frame, ms, &drawn, self.last));
            self.warm_ahead(frame, false);
        }
        // Until the next frame boundary (a touch after it, so the clock has moved on).
        let next = ((frame + 1) as f64 / fps - at / fps) * 1000.0 + 0.5;
        Some(Duration::from_secs_f64(next.clamp(1.0, 50.0) / 1000.0))
    }

    /// Where the player is, and how playing went since the last ask.
    pub fn position(&mut self) -> Position {
        let frame = self
            .clock_position()
            .unwrap_or_else(|| self.drawn.unwrap_or(0) as f64);
        let mut report = std::mem::take(&mut self.report);
        if let Some(feed) = &self.sound.feed {
            let starved = feed.speaker.state().starved;
            report.starved = starved.saturating_sub(self.starved_before);
            self.starved_before = starved;
        }
        Position {
            frame,
            playing: self.playing.is_some(),
            ended: report.ended,
            report,
        }
    }

    pub fn is_playing(&self) -> bool {
        self.playing.is_some()
    }

    /// The playhead has rested on the frame drawn: its sound is armed so Play
    /// starts at once, and the cuts ahead of it are decoded.
    pub fn settle(&mut self) {
        if self.playing.is_some() {
            return;
        }
        let Some((frame, (fps, until))) = self.drawn.zip(
            self.project
                .as_ref()
                .map(|project| (project.fps(), Self::until(project, self.drawn.unwrap_or(0)))),
        ) else {
            return;
        };
        if frame < until {
            self.arm(frame as f64 / fps, until);
        }
        self.warm_ahead(frame, false);
    }

    /// Has the sound mixed from `from` seconds of the timeline to frame
    /// `until` into the speaker, unless a mixer is there (within a frame)
    /// already; where the sound is armed from.
    fn arm(&mut self, from: f64, until: i64) -> f64 {
        let Some(project) = &self.project else {
            return from;
        };
        if self.sound.refused {
            return from;
        }
        let fps = project.fps();
        if let Some(armed) = self
            .sound
            .mixer
            .as_ref()
            .map(|mixer| mixer.from)
            .filter(|armed| (armed - from).abs() < 1.5 / fps)
        {
            return armed;
        }
        if self.sound.feed.is_none() {
            match Speaker::open((SOUND_AHEAD_SECONDS * RATE as f64) as usize) {
                Ok(speaker) => {
                    self.sound.feed = Some(Arc::new(Feed {
                        speaker,
                        generation: AtomicU64::new(0),
                        writing: Mutex::new(()),
                    }));
                }
                Err(error) => {
                    crate::log::warn("preview", format!("no speaker for the player: {error}"));
                    self.sound.refused = true;
                    return from;
                }
            }
        }
        let Some(feed) = self.sound.feed.clone() else {
            return from;
        };
        self.sound.mixer = None;
        let generation = feed.flush();
        let from_frame = (from * fps).floor() as i64;
        let seconds = (until as f64 / fps - from).max(0.0);
        let total = (seconds * RATE as f64).round() as usize;
        let paths: HashMap<String, PathBuf> = project
            .media
            .iter()
            .map(|media| {
                let path = self
                    .sounds
                    .get(&media.id)
                    .or_else(|| self.sources.get(&media.id))
                    .cloned()
                    .unwrap_or_else(|| PathBuf::from(&media.path));
                (media.id.clone(), path)
            })
            .collect();
        let parts: Vec<Part> = mix::parts(
            &heard_segments(project, from_frame, until),
            |media| paths.get(media).cloned(),
            from,
            seconds,
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&cancel);
        let count = parts.len();
        let _ = std::thread::Builder::new()
            .name("edit preview sound".to_owned())
            .spawn(move || {
                crate::util::utility_thread();
                mix_into(&feed, generation, parts, total, &stop);
            });
        self.sound.mixer = Some(Mixer { from, cancel });
        trace(|| format!("sound armed from {from:.3} s, {count} parts, {seconds:.1} s"));
        from
    }
}

/// A draw's trace line: "Ok" first (the acceptance check, scripts/acceptance.ts,
/// reads success from it), then where its time went.
pub fn describe_draw(
    frame: i64,
    ms: f64,
    drawn: &Result<(), String>,
    times: Option<DrawTimes>,
) -> String {
    match (drawn, times) {
        (Ok(()), Some(t)) => format!(
            "frame {frame} in {ms:.1} ms: Ok, eval {:.1} decode {:.1} (layers {}, open {}×{:.1} seek {}×{:.1} fwd {}×{:.1} ffmpeg {}×{:.1} ahead {}×{:.1}) upload {:.1} composite {:.1} present {:.1}",
            t.evaluate, t.decode, t.layers, t.decoders.opens, t.decoders.open_ms, t.decoders.seeks, t.decoders.seek_ms,
            t.decoders.forward, t.decoders.forward_ms, t.decoders.ffmpeg, t.decoders.ffmpeg_ms, t.decoders.ahead, t.decoders.ahead_ms,
            t.upload, t.composite, t.present
        ),
        _ => format!("frame {frame} in {ms:.1} ms: {drawn:?}"),
    }
}

impl Sound {
    fn disarm(&mut self) {
        self.mixer = None;
    }
}

/// The mixer's thread: `parts` mixed as the export mixes them, a window at a
/// time into the speaker, held back while it's full. A part that won't
/// decode is logged and the rest of its window is silence, so the clock
/// never holds on a broken file.
fn mix_into(feed: &Feed, generation: u64, parts: Vec<Part>, total: usize, cancel: &AtomicBool) {
    let window = (SOUND_WINDOW_SECONDS * RATE as f64) as usize;
    let written = std::cell::Cell::new(0_usize);
    let mut push = |samples: &[f32]| -> Result<(), String> {
        let mut rest = samples;
        while !rest.is_empty() {
            if cancel.load(Ordering::Acquire) {
                return Err("cancelled".to_owned());
            }
            match feed.write(generation, rest) {
                None => return Err("cancelled".to_owned()),
                Some(0) => std::thread::sleep(Duration::from_millis(5)),
                Some(frames) => rest = rest.get(frames * 2..).unwrap_or_default(),
            }
        }
        written.set(written.get() + samples.len() / 2);
        Ok(())
    };
    let mixed = mix::mix_live(&parts, total, window, cancel, &mut push);
    match mixed {
        Ok(()) => {}
        Err(error) if error == "cancelled" => {}
        Err(error) => {
            crate::log::warn(
                "preview",
                format!("the player's sound: {error}; silent from there"),
            );
            let silence = vec![0.0_f32; window * 2];
            while written.get() < total {
                let frames = (total - written.get()).min(window);
                if push(silence.get(..frames * 2).unwrap_or_default()).is_err() {
                    return;
                }
            }
        }
    }
}
