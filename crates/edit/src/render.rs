//! Native rendering: single frames (for agents) and full exports. Both run
//! the same `edit-render` compositor the browser preview runs as WASM.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use edit_core::{audio_segments, evaluate, AudioSegment, Layer, Media, Project};
use edit_render::{text::BUNDLED_FONTS, wgpu, Renderer};
use serde_json::json;

use crate::export::{ExportOptions, Plan};
use crate::store::Store;

pub fn new_renderer(width: u32, height: u32) -> Result<Renderer, String> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    .map_err(|error| format!("no GPU available: {error}"))?;
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("edit native"),
        ..Default::default()
    }))
    .map_err(|error| format!("GPU device: {error}"))?;
    let mut renderer = Renderer::new(device, queue, width, height);
    for (family, weight, file) in BUNDLED_FONTS {
        if let Some(bytes) = edit_render::text::bundled_font_bytes(file) {
            renderer.fonts_mut().add(family, *weight, bytes)?;
        }
    }
    Ok(renderer)
}

/// Decoded size for a source drawn into a `width`×`height` frame: contain-fit, even.
fn decode_size(media: &Media, width: u32, height: u32) -> (u32, u32) {
    let (mw, mh) = (media.width.max(2) as f32, media.height.max(2) as f32);
    let fit = (width as f32 / mw).min(height as f32 / mh).min(1.0);
    let even = |value: f32| ((value.round() as u32) / 2 * 2).max(2);
    (even(mw * fit), even(mh * fit))
}

/// Sequential RGBA reader for one source that restarts on jumps.
pub(crate) struct VideoReader {
    path: PathBuf,
    pub(crate) width: u32,
    pub(crate) height: u32,
    fps: f64,
    still: bool,
    child: Option<(Child, ChildStdout)>,
    #[cfg(target_os = "macos")]
    native: Option<crate::mac_media::Reader>,
    #[cfg(target_os = "macos")]
    native_failed: bool,
    start: f64,
    next_index: i64,
    frame: Vec<u8>,
    has_frame: bool,
    eof: bool,
    spare: Vec<u8>,
}

impl VideoReader {
    pub(crate) fn new(media: &Media, width: u32, height: u32) -> Self {
        let (width, height) = decode_size(media, width, height);
        Self {
            path: PathBuf::from(&media.path),
            width,
            height,
            fps: if media.fps > 0.0 { media.fps } else { 30.0 },
            still: media.kind == edit_core::MediaKind::Image,
            child: None,
            #[cfg(target_os = "macos")]
            native: None,
            #[cfg(target_os = "macos")]
            native_failed: std::env::var_os("EDIT_FFMPEG_VIDEO").is_some(),
            start: 0.0,
            next_index: 0,
            frame: vec![0; width as usize * height as usize * 4],
            has_frame: false,
            eof: false,
            spare: Vec::new(),
        }
    }

    fn restart(&mut self, time: f64) -> Result<(), String> {
        self.stop();
        self.spare.resize(self.frame.len(), 0);
        let time = time.max(0.0);
        let mut child = Command::new(crate::tools::ffmpeg())
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-threads",
                "2",
                "-filter_threads",
                "1",
                "-ss",
                &format!("{time:.6}"),
                "-protocol_whitelist",
                "file,pipe",
                "-i",
            ])
            .arg(&self.path)
            .args([
                "-an",
                "-vf",
                &format!(
                    "fps={:.6},scale={}:{}:flags=bicubic",
                    self.fps, self.width, self.height
                ),
                "-threads",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgba",
                "pipe:1",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("ffmpeg: {error}"))?;
        let stdout = child.stdout.take().ok_or("ffmpeg stdout")?;
        self.child = Some((child, stdout));
        self.start = time;
        self.next_index = 0;
        self.eof = false;
        self.has_frame = false;
        Ok(())
    }

    /// Frame covering `time` (seconds into the source).
    pub(crate) fn frame_at(&mut self, time: f64) -> Result<&[u8], String> {
        let time = if self.still { 0.0 } else { time };
        if self.still && self.has_frame {
            return Ok(&self.frame);
        }
        #[cfg(target_os = "macos")]
        if self.still {
            crate::mac_media::image(&self.path, self.width, self.height, &mut self.frame)?;
            self.has_frame = true;
            return Ok(&self.frame);
        }
        #[cfg(target_os = "macos")]
        if !self.native_failed {
            let decoded = (|| {
                if self.native.is_none() {
                    self.native = Some(crate::mac_media::Reader::open(
                        &self.path,
                        self.width,
                        self.height,
                    )?);
                }
                self.native.as_mut().ok_or("native reader missing")?.frame(
                    (time * self.fps + 0.5 + 1e-7).floor() / self.fps,
                    &mut self.frame,
                )
            })();
            match decoded {
                Ok(()) => return Ok(&self.frame),
                Err(error) => {
                    crate::diag::warn(
                        "render",
                        format!(
                            "native decode of {}: {error}; using FFmpeg",
                            self.path.display()
                        ),
                    );
                    self.native = None;
                    self.native_failed = true;
                }
            }
        }
        let ahead = time - (self.start + self.next_index as f64 / self.fps);
        if self.child.is_none()
            || time < self.start - 1e-6
            || (!self.eof && ahead > 2.0)
            || (self.next_index > 0 && ahead < -1.5 / self.fps)
        {
            self.restart(time)?;
        }
        let target = ((time - self.start) * self.fps + 1e-6).floor() as i64;
        while !self.eof && self.next_index <= target {
            let Some((child, stdout)) = self.child.as_mut() else {
                break;
            };
            match stdout.read_exact(&mut self.spare) {
                Ok(()) => {
                    std::mem::swap(&mut self.frame, &mut self.spare);
                    self.has_frame = true;
                    self.next_index += 1;
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::UnexpectedEof && self.has_frame =>
                {
                    if !child.wait().map_err(|error| error.to_string())?.success() {
                        return Err(format!("decoder failed for {}", self.path.display()));
                    }
                    // End of source: hold the last frame.
                    self.eof = true;
                    break;
                }
                Err(error) => {
                    return Err(format!("could not decode {}: {error}", self.path.display()))
                }
            }
        }
        Ok(&self.frame)
    }

    fn stop(&mut self) {
        if let Some((mut child, _)) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for VideoReader {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Owns a GPU on its own thread; frame renders queue here.
pub struct FrameRenderer {
    jobs: Mutex<mpsc::SyncSender<FrameJob>>,
}

struct FrameJob {
    project: Project,
    frames: Vec<i64>,
    /// Longest side of each returned image; 0 = project size.
    max_side: u32,
    reply: tokio::sync::oneshot::Sender<Result<Vec<RgbaImage>, String>>,
}

pub struct RgbaImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl FrameRenderer {
    /// `cache` is the media cache, where waveforms' sound levels are.
    pub fn start(cache: PathBuf) -> Arc<Self> {
        let (sender, receiver) = mpsc::sync_channel::<FrameJob>(8);
        std::thread::spawn(move || {
            let mut renderer: Option<Renderer> = None;
            let mut last_project = String::new();
            let mut readers = HashMap::new();
            for job in receiver {
                if job.reply.is_closed() {
                    continue;
                }
                let rendering = std::time::Instant::now();
                let caught = crate::guard::catch("rendering a frame", || {
                    let settings = job.project.settings;
                    let renderer = match &mut renderer {
                        Some(renderer) => renderer,
                        empty => empty.insert(new_renderer(settings.width, settings.height)?),
                    };
                    // Media ids are per project: another project's may be other files.
                    if job.project.id != last_project {
                        renderer.clear_peaks();
                        readers.clear();
                        last_project = job.project.id.clone();
                    }
                    let mut images = Vec::new();
                    for frame in &job.frames {
                        images.push(render_one(
                            renderer,
                            &mut readers,
                            &job.project,
                            *frame,
                            job.max_side,
                            &cache,
                        )?);
                    }
                    Ok(images)
                });
                // A crash may leave the GPU state half-way: start afresh next time.
                if caught.is_err() {
                    renderer = None;
                    readers.clear();
                }
                let result = caught.and_then(|result| result);
                let name = if job.frames.len() > 1 {
                    "render: frames"
                } else {
                    "render: frame"
                };
                crate::diag::record(
                    "render",
                    name,
                    rendering.elapsed(),
                    result.as_ref().err().map(String::as_str),
                );
                let _ = job.reply.send(result);
            }
        });
        Arc::new(Self {
            jobs: Mutex::new(sender),
        })
    }

    pub async fn render(
        &self,
        project: Project,
        frames: Vec<i64>,
        max_side: u32,
    ) -> Result<Vec<RgbaImage>, String> {
        let (reply, response) = tokio::sync::oneshot::channel();
        self.jobs
            .lock()
            .try_send(FrameJob {
                project,
                frames,
                max_side,
                reply,
            })
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => "renderer busy; try again shortly".to_owned(),
                mpsc::TrySendError::Disconnected(_) => "renderer stopped".to_owned(),
            })?;
        response.await.map_err(|_| "renderer stopped".to_owned())?
    }
}

/// Gives the renderer the sound levels this frame's waveforms read: each
/// media's peaks from the media cache (missing ones are tried again next frame).
fn feed_peaks(renderer: &mut Renderer, project: &Project, scene: &edit_core::Scene, cache: &Path) {
    for layer in &scene.layers {
        let Layer::Waveform { sources, .. } = layer else {
            continue;
        };
        for source in sources {
            if renderer.has_peaks(&source.media) {
                continue;
            }
            let Some(media) = project.media(&source.media) else {
                continue;
            };
            let path = cache
                .join(crate::media::media_key(Path::new(&media.path)))
                .join("peaks.bin");
            if let Ok(peaks) = std::fs::read(path) {
                renderer.set_peaks(&source.media, peaks);
            }
        }
    }
}

fn render_one(
    renderer: &mut Renderer,
    readers: &mut HashMap<String, VideoReader>,
    project: &Project,
    frame: i64,
    max_side: u32,
    cache: &Path,
) -> Result<RgbaImage, String> {
    let settings = project.settings;
    let scene = evaluate(project, frame);
    feed_peaks(renderer, project, &scene, cache);
    for layer in &scene.layers {
        if let Layer::Video {
            clip,
            media,
            source_time,
            ..
        } = layer
        {
            let source = project
                .media(media)
                .ok_or_else(|| format!("unknown media {media}"))?;
            let reader = readers
                .entry(clip.clone())
                .or_insert_with(|| VideoReader::new(source, settings.width, settings.height));
            if reader.path != Path::new(&source.path)
                || (reader.width, reader.height)
                    != decode_size(source, settings.width, settings.height)
            {
                *reader = VideoReader::new(source, settings.width, settings.height);
            }
            let (w, h) = (reader.width, reader.height);
            renderer.upload_video_rgba(clip, w, h, reader.frame_at(*source_time)?);
        }
    }
    readers.retain(|clip, _| {
        scene
            .layers
            .iter()
            .any(|layer| matches!(layer, Layer::Video {clip: active, ..} if active == clip))
    });
    renderer.render(&scene);
    let pixels = renderer.read_output()?;
    let image = RgbaImage {
        width: settings.width,
        height: settings.height,
        pixels,
    };
    Ok(if max_side > 0 {
        downscale(&image, max_side)
    } else {
        image
    })
}

/// Box-filter downscale so the longest side is at most `max_side`.
pub fn downscale(image: &RgbaImage, max_side: u32) -> RgbaImage {
    let longest = image.width.max(image.height);
    if longest <= max_side {
        return RgbaImage {
            width: image.width,
            height: image.height,
            pixels: image.pixels.clone(),
        };
    }
    let scale = max_side as f32 / longest as f32;
    let (w, h) = (
        ((image.width as f32 * scale).round() as u32).max(1),
        ((image.height as f32 * scale).round() as u32).max(1),
    );
    let mut pixels = vec![0_u8; (w * h * 4) as usize];
    for y in 0..h {
        let sy0 = (y as f32 / scale) as u32;
        let sy1 = (((y + 1) as f32 / scale) as u32).clamp(sy0 + 1, image.height);
        for x in 0..w {
            let sx0 = (x as f32 / scale) as u32;
            let sx1 = (((x + 1) as f32 / scale) as u32).clamp(sx0 + 1, image.width);
            let mut sum = [0_u64; 4];
            for sy in sy0..sy1 {
                for sx in sx0..sx1 {
                    let i = ((sy * image.width + sx) * 4) as usize;
                    let pixel = image.pixels.get(i..i + 4).into_iter().flatten();
                    for (total, value) in sum.iter_mut().zip(pixel) {
                        *total += u64::from(*value);
                    }
                }
            }
            let n = (sy1 - sy0) * (sx1 - sx0);
            let o = ((y * w + x) * 4) as usize;
            for (out, total) in pixels.get_mut(o..o + 4).into_iter().flatten().zip(sum) {
                *out = (total / u64::from(n.max(1))) as u8;
            }
        }
    }
    RgbaImage {
        width: w,
        height: h,
        pixels,
    }
}

/// Tiles images into a grid (for agent contact sheets).
pub fn tile(images: &[RgbaImage], columns: u32) -> RgbaImage {
    let columns = columns.max(1);
    let cell_w = images.iter().map(|image| image.width).max().unwrap_or(1);
    let cell_h = images.iter().map(|image| image.height).max().unwrap_or(1);
    let rows = (images.len() as u32).div_ceil(columns).max(1);
    let gap = 4;
    let (w, h) = (
        columns * cell_w + (columns - 1) * gap,
        rows * cell_h + (rows - 1) * gap,
    );
    let mut pixels = vec![0_u8; (w * h * 4) as usize];
    for chunk in pixels.as_chunks_mut::<4>().0 {
        chunk[3] = 255;
    }
    for (index, image) in images.iter().enumerate() {
        let (cx, cy) = (
            (index as u32 % columns) * (cell_w + gap),
            (index as u32 / columns) * (cell_h + gap),
        );
        for y in 0..image.height {
            let src = (y * image.width * 4) as usize;
            let dst = (((cy + y) * w + cx) * 4) as usize;
            let row = (image.width * 4) as usize;
            if let (Some(to), Some(from)) = (
                pixels.get_mut(dst..dst + row),
                image.pixels.get(src..src + row),
            ) {
                to.copy_from_slice(from);
            }
        }
    }
    RgbaImage {
        width: w,
        height: h,
        pixels,
    }
}

pub fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, image.width, image.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
        writer
            .write_image_data(&image.pixels)
            .map_err(|error| error.to_string())?;
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Export

#[derive(Default)]
pub struct Exports {
    jobs: Mutex<HashMap<String, ExportJob>>,
    /// Files exported since the server started, newest last: the only ones it hands out or reveals.
    finished: Mutex<Vec<PathBuf>>,
}

struct ExportJob {
    cancel: Arc<AtomicBool>,
    output: PathBuf,
}

struct ExportFile(PathBuf);
impl Drop for ExportFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

impl Exports {
    /// Whether `path` is a file this server exported (and so may be downloaded or revealed).
    pub fn exported(&self, path: &Path) -> bool {
        self.finished.lock().iter().any(|done| done == path)
    }

    pub fn running(&self) -> bool {
        !self.jobs.lock().is_empty()
    }

    pub fn cancel(&self, project: &str) -> bool {
        self.jobs
            .lock()
            .get(project)
            .map(|job| job.cancel.store(true, Ordering::Release))
            .is_some()
    }

    /// Starts exporting `project` as `options` ask; returns the file it will write
    /// (`output` with the format's extension). A whole subtitled video is then
    /// uploaded to the team's Drive (`crate::drive`).
    pub fn start(
        self: &Arc<Self>,
        store: Arc<Store>,
        library: Arc<crate::library::Library>,
        project: Project,
        options: ExportOptions,
        output: PathBuf,
    ) -> Result<PathBuf, String> {
        if project.duration() <= 0 {
            return Err("the timeline is empty".to_owned());
        }
        project.validate()?;
        let mut plan = crate::export::plan(&options, &project, true)?;
        if heard_segments(&project, plan.start, plan.end).is_empty() {
            if !options.format.has_video() {
                return Err("there's no sound to export in that span".to_owned());
            }
            plan.audio = false;
        }
        // Settings that can't work (a target size too small for the span) fail here, not mid-render.
        crate::export::codec_args(&options, &plan, project.fps())?;
        let output = crate::export::with_extension(&output, options.format);
        let parent = output
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let output = parent
            .canonicalize()
            .map_err(|error| error.to_string())?
            .join(output.file_name().ok_or("export needs a file name")?);
        if let Ok(existing) = output.canonicalize() {
            if project.media.iter().any(|media| {
                Path::new(&media.path)
                    .canonicalize()
                    .is_ok_and(|path| path == existing)
            }) {
                return Err("export would overwrite source footage; choose another file".to_owned());
            }
        }
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut jobs = self.jobs.lock();
            if !jobs.is_empty() {
                return Err("an export is already running; wait for it or cancel it before starting another".to_owned());
            }
            if jobs.values().any(|job| job.output == output) {
                return Err("another export is writing to that file".to_owned());
            }
            jobs.insert(
                project.id.clone(),
                ExportJob {
                    cancel: Arc::clone(&cancel),
                    output: output.clone(),
                },
            );
        }
        let final_path = output.clone();
        let cache = store.cache_dir();
        let upload = crate::drive::wanted(&project, &options, &plan);
        let this = Arc::clone(self);
        std::thread::spawn(move || {
            let id = project.id.clone();
            let emit = |state: &str, progress: f32, extra: serde_json::Value| {
                let mut event = json!({
                    "type": "export",
                    "id": id,
                    "state": state,
                    "progress": progress,
                    "path": output.to_string_lossy(),
                });
                if let (Some(event), Some(extra)) = (event.as_object_mut(), extra.as_object()) {
                    event.extend(extra.clone());
                }
                store.emit(event);
            };
            emit("running", 0.0, json!({}));
            let started = Instant::now();
            let result = crate::guard::catch("the export", || {
                // FFmpeg writes beside the destination; only a complete export
                // replaces it. Failure/cancellation cannot destroy an older file.
                let mut name = output.as_os_str().to_owned();
                name.push(format!(
                    ".{}-{}.partial.{}",
                    std::process::id(),
                    id,
                    options.format.extension()
                ));
                let path = PathBuf::from(name);
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                    .map_err(|error| error.to_string())?;
                let temporary = ExportFile(path);
                export(
                    &project,
                    &options,
                    &plan,
                    &temporary.0,
                    &cache,
                    &cancel,
                    |progress| emit("running", progress, json!({})),
                )?;
                if cancel.load(Ordering::Acquire) {
                    return Err("cancelled".to_owned());
                }
                std::fs::rename(&temporary.0, &output).map_err(|error| error.to_string())?;
                let mut finished = this.finished.lock();
                finished.retain(|done| done != &output);
                finished.push(output.clone());
                let excess = finished.len().saturating_sub(50);
                finished.drain(..excess);
                Ok(())
            })
            .and_then(|result| result);
            let frames = (plan.end - plan.start).max(0);
            let took = started.elapsed();
            match &result {
                Ok(()) => crate::diag::info(
                    "export",
                    format!(
                        "{} exported {frames} frames in {} ({:.1} frames/s) to {}",
                        project.name,
                        crate::diag::human(took),
                        frames as f64 / took.as_secs_f64().max(1e-3),
                        output.display()
                    ),
                ),
                Err(_) if cancel.load(Ordering::Acquire) => {
                    crate::diag::info("export", format!("{} export cancelled", project.name));
                }
                Err(error) => crate::diag::record(
                    "export",
                    "export",
                    took,
                    Some(&format!("{}: {error}", project.name)),
                ),
            }
            if result.is_ok() {
                crate::diag::record("export", "export", took, None);
            }
            let done = result.is_ok();
            match result {
                Ok(()) => emit(
                    "done",
                    1.0,
                    json!({
                        "seconds": started.elapsed().as_secs_f32(),
                        "bytes": std::fs::metadata(&output).map(|meta| meta.len()).ok(),
                        "drive": upload,
                    }),
                ),
                Err(error) if cancel.load(Ordering::Acquire) => {
                    emit("cancelled", 0.0, json!({ "error": error }));
                }
                Err(error) => emit("failed", 0.0, json!({ "error": error })),
            }
            this.jobs.lock().remove(&id);
            if upload && done {
                crate::drive::start(store, library, &project, output);
            }
        });
        Ok(final_path)
    }
}

/// Audio that's heard (unmuted, from media with sound) and overlaps frames `[start, end)`.
fn heard_segments(project: &Project, start: i64, end: i64) -> Vec<AudioSegment> {
    let fps = project.fps();
    let (from, to) = (start as f64 / fps, end as f64 / fps);
    audio_segments(project)
        .into_iter()
        .filter(|segment| {
            segment.start < to
                && segment.start + segment.duration > from
                && project
                    .media(&segment.media)
                    .is_some_and(|media| media.has_audio)
        })
        .collect()
}

/// One sound's filter chain, from input `input` to the label `[a{index}]`:
/// its part of the source, mutes, tempo, volume, fades, and delay to its place.
#[cfg(test)]
fn segment_chain(input: usize, index: usize, segment: &AudioSegment) -> String {
    segment_chain_with_fades(input, index, segment, 0.0, segment.duration)
}

fn segment_chain_with_fades(
    input: usize,
    index: usize,
    segment: &AudioSegment,
    elapsed: f64,
    original_duration: f64,
) -> String {
    let mut chain = format!(
        "[{input}:a:0]aformat=sample_rates=48000:channel_layouts=stereo,atrim=start={:.6}:duration={:.6},asetpts=PTS-STARTPTS",
        segment.source_in,
        segment.duration * segment.speed
    );
    // Mutes are in source seconds: here t = 0 is source_in, before any tempo change.
    if let Some(mute) = mute_filter(segment) {
        chain.push_str(&mute);
    }
    let mut tempo = segment.speed;
    while (tempo - 1.0).abs() > 1e-6 {
        let step = tempo.clamp(0.5, 2.0);
        chain.push_str(&format!(",atempo={step:.6}"));
        tempo /= step;
    }
    if elapsed > 0.0 {
        chain.push_str(&format!(",asetpts=PTS+{elapsed:.9}/TB"));
    }
    chain.push_str(&format!(",volume={:.3}dB", segment.volume_db));
    if segment.fade_in > 0.0 {
        chain.push_str(&format!(",afade=t=in:st=0:d={:.4}", segment.fade_in));
    }
    if segment.fade_out > 0.0 {
        chain.push_str(&format!(
            ",afade=t=out:st={:.4}:d={:.4}",
            (original_duration - segment.fade_out).max(0.0),
            segment.fade_out
        ));
    }
    if elapsed > 0.0 {
        chain.push_str(",asetpts=PTS-STARTPTS");
    }
    let delay = (segment.start * 1000.0).round() as i64;
    chain.push_str(&format!(",adelay={delay}|{delay}[a{index}]"));
    chain
}

/// `,aeval=…` silencing a segment's mutes sample by sample, each ramped over
/// MUTE_FADE_SECONDS with a cosine (as `edit_core::mute_gain`); None without
/// any in the part it plays.
fn mute_filter(segment: &AudioSegment) -> Option<String> {
    let fade = edit_core::MUTE_FADE_SECONDS;
    let length = segment.duration * segment.speed;
    let gains: Vec<String> = segment
        .mutes
        .iter()
        .map(|mute| (mute.from - segment.source_in, mute.to - segment.source_in))
        .filter(|&(from, to)| to > -fade && from < length + fade)
        .map(|(from, to)| {
            format!("if(between(t,{:.6},{:.6}),(1-cos(PI*min(max(max(({from:.6})-t,t-({to:.6})),0)/{fade:.6},1)))/2,1)", from-fade, to+fade)
        })
        .collect();
    let gain = gains
        .into_iter()
        .reduce(|all, next| format!("min({all},{next})"))?;
    // c=same keeps the stereo layout, which encoders (AAC) need named.
    Some(format!(",aeval=exprs='val(0)*{gain}|val(1)*{gain}':c=same"))
}

#[allow(clippy::too_many_arguments)]
fn export(
    project: &Project,
    options: &ExportOptions,
    plan: &Plan,
    output: &Path,
    cache: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f32),
) -> Result<(), String> {
    let pending = crate::broll::smoothing_pending(&project.id);
    if !pending.is_empty() {
        crate::diag::info("export", format!("exporting current timeline snapshot; {} optional optical-flow renders still pending", pending.len()));
    }
    let settings = project.settings;
    let (width, height) = (settings.width, settings.height);
    let fps = settings.fps;
    let seconds = plan.seconds(project.fps());
    let offset = plan.start as f64 / project.fps();
    let video = options.format.has_video();

    #[cfg(target_os = "macos")]
    let native_video = native_video(project, options, plan, output, cache, cancel, &mut progress)?;
    #[cfg(not(target_os = "macos"))]
    let native_video: Option<ExportFile> = None;
    if native_video.is_some() && !plan.audio && options.chapters.is_empty() {
        if let Some(file) = native_video {
            std::fs::rename(&file.0, output).map_err(|error| error.to_string())?;
        }
        return Ok(());
    }
    let mut command = Command::new(crate::tools::ffmpeg());
    command.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-filter_complex_threads",
        "2",
    ]);
    let mut inputs = 0;
    if let Some(file) = &native_video {
        command.arg("-i").arg(&file.0);
        inputs += 1;
    } else if video {
        command.args([
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-s",
            &format!("{width}x{height}"),
            "-framerate",
            &fps.to_string(),
            "-i",
            "pipe:0",
        ]);
        inputs += 1;
    }
    let mut graph = Vec::new();
    if video && native_video.is_none() {
        graph.push(crate::export::video_graph(
            options,
            (width, height),
            (plan.width, plan.height),
        ));
    }
    let segments = if plan.audio {
        heard_segments(project, plan.start, plan.end)
    } else {
        Vec::new()
    };
    for (index, original) in segments.iter().enumerate() {
        let from = original.start.max(offset);
        let to = (original.start + original.duration).min(offset + seconds);
        let elapsed = from - original.start;
        let mut segment = original.clone();
        segment.source_in += elapsed * segment.speed;
        segment.start = (from - offset).max(0.0);
        segment.duration = to - from;
        // heard_segments only keeps sounds whose media is there.
        let Some(media) = project.media(&segment.media) else {
            continue;
        };
        command
            .args([
                "-threads",
                "1",
                "-ss",
                &format!("{:.6}", segment.source_in),
                "-t",
                &format!("{:.6}", segment.duration * segment.speed),
                "-protocol_whitelist",
                "file,pipe",
                "-i",
            ])
            .arg(&media.path);
        let input = inputs;
        inputs += 1;
        let mut sought = segment.clone();
        sought.source_in = 0.0;
        for mute in &mut sought.mutes {
            mute.from -= segment.source_in;
            mute.to -= segment.source_in;
        }
        graph.push(segment_chain_with_fades(
            input,
            index,
            &sought,
            elapsed,
            original.duration,
        ));
    }
    if !segments.is_empty() {
        let mixed: String = (0..segments.len())
            .map(|index| format!("[a{index}]"))
            .collect();
        // Mixed on the edit's clock, then cut to the span.
        let mut mix = format!(
            "{mixed}amix=inputs={}:normalize=0:dropout_transition=0,apad,atrim=start=0:duration={seconds:.6},asetpts=PTS-STARTPTS",
            segments.len()
        );
        if let Some(lufs) = options.loudness {
            mix.push_str(&format!(
                ",loudnorm=I={lufs:.1}:TP=-1.5:LRA=11,aresample=48000"
            ));
        }
        mix.push_str("[aout]");
        graph.push(mix);
    }
    // Chapters come in as one more input, an FFMETADATA file beside the output.
    let chapters = crate::export::chapters_file(options, plan, project.fps())
        .map(|text| -> Result<ExportFile, String> {
            let mut name = output.as_os_str().to_owned();
            name.push(".chapters.txt");
            let path = PathBuf::from(name);
            std::fs::write(&path, text).map_err(|error| error.to_string())?;
            Ok(ExportFile(path))
        })
        .transpose()?;
    if let Some(file) = &chapters {
        command.args(["-f", "ffmetadata", "-i"]).arg(&file.0);
    }
    if !graph.is_empty() {
        command.args(["-filter_complex", &graph.join(";")]);
    }
    if video {
        command.args([
            "-map",
            if native_video.is_some() {
                "0:v:0"
            } else {
                "[vout]"
            },
        ]);
    }
    if !segments.is_empty() {
        command.args(["-map", "[aout]"]);
    }
    if chapters.is_some() {
        command.args(["-map_chapters", &inputs.to_string()]);
    }
    command.args(crate::export::codec_args(options, plan, project.fps())?);
    if native_video.is_some() {
        command.args(["-c:v", "copy"]);
    }
    command
        .args(["-threads", "2"])
        .arg(output)
        .stdin(if video && native_video.is_none() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut encoder = command
        .spawn()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    let stdin = encoder.stdin.take();
    let stderr = encoder.stderr.take();
    let stderr_thread = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });

    let result = match stdin {
        Some(mut stdin) => render_frames(
            project,
            plan,
            |_, pixels| {
                stdin
                    .write_all(pixels)
                    .map_err(|_| "the encoder stopped early".to_owned())
            },
            cache,
            cancel,
            &mut progress,
        ),
        // Sound only: FFmpeg does all the work; wait for it, staying cancellable.
        None => loop {
            if cancel.load(Ordering::Acquire) {
                break Err("cancelled".to_owned());
            }
            match encoder.try_wait() {
                Ok(Some(_)) => break Ok(()),
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(error) => break Err(error.to_string()),
            }
        },
    };
    if result.is_err() {
        let _ = encoder.kill();
    }
    let status = encoder.wait().map_err(|error| error.to_string())?;
    let stderr = stderr_thread.join().unwrap_or_default();
    drop(chapters);
    result?;
    if !status.success() {
        let last = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("encode failed");
        return Err(last.trim().to_owned());
    }
    Ok(())
}

/// The standard Mac video path uses AVFoundation for decoding and encoding;
/// the compositor remains shared with the browser. Nonstandard shapes/rates and
/// software-quality exports keep the compatibility encoder.
#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn native_video(
    project: &Project,
    options: &ExportOptions,
    plan: &Plan,
    output: &Path,
    cache: &Path,
    cancel: &AtomicBool,
    progress: &mut impl FnMut(f32),
) -> Result<Option<ExportFile>, String> {
    use crate::export::{Format, Shape};
    if !options.hardware
        || std::env::var_os("EDIT_FFMPEG_VIDEO").is_some()
        || !matches!(options.format, Format::H264 | Format::Hevc)
        || options.shape != Shape::Original
        || (plan.width, plan.height) != (project.settings.width, project.settings.height)
        || options
            .fps
            .is_some_and(|fps| fps > 0 && fps != project.settings.fps)
    {
        return Ok(None);
    }
    let mut name = output.as_os_str().to_owned();
    name.push(".native.mp4");
    let temporary = ExportFile(PathBuf::from(name));
    let rate = crate::export::video_bitrate(options, plan, project.fps())?;
    let mut writer = match crate::mac_media::Writer::open(
        &temporary.0,
        plan.width,
        plan.height,
        project.fps(),
        options.format == Format::Hevc,
        rate,
        (project.settings.fps * 2) as i32,
    ) {
        Ok(writer) => writer,
        Err(error) => {
            crate::diag::warn(
                "export",
                format!("native encoder unavailable: {error}; using FFmpeg"),
            );
            return Ok(None);
        }
    };
    crate::diag::time_on("export", "export: native video", &project.id, || {
        render_frames(
            project,
            plan,
            |frame, pixels| writer.frame(frame, pixels),
            cache,
            cancel,
            progress,
        )?;
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".to_owned());
        }
        writer.finish(plan.end - plan.start)
    })?;
    Ok(Some(temporary))
}

/// Renders frames `[plan.start, plan.end)` into the encoder's stdin (closed when done).
fn render_frames(
    project: &Project,
    plan: &Plan,
    mut write_frame: impl FnMut(i64, &[u8]) -> Result<(), String>,
    cache: &Path,
    cancel: &AtomicBool,
    progress: &mut impl FnMut(f32),
) -> Result<(), String> {
    let (width, height) = (project.settings.width, project.settings.height);
    let mut renderer = new_renderer(width, height)?;
    let mut readers: HashMap<String, VideoReader> = HashMap::new();
    let mut last_report = Instant::now();
    let total = (plan.end - plan.start).max(1);
    for frame in plan.start..plan.end {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".to_owned());
        }
        let scene = evaluate(project, frame);
        feed_peaks(&mut renderer, project, &scene, cache);
        for layer in &scene.layers {
            if let Layer::Video {
                clip,
                media,
                source_time,
                ..
            } = layer
            {
                let source = project
                    .media(media)
                    .ok_or_else(|| format!("unknown media {media}"))?;
                let reader = readers
                    .entry(clip.clone())
                    .or_insert_with(|| VideoReader::new(source, width, height));
                let (w, h) = (reader.width, reader.height);
                let pixels = reader.frame_at(*source_time)?;
                renderer.upload_video_rgba(clip, w, h, pixels);
            }
        }
        // A reader owns an FFmpeg process and pipe. Keep only the clips
        // visible now, so a long export doesn't accumulate one per cut.
        readers.retain(|clip, _| {
            scene
                .layers
                .iter()
                .any(|layer| matches!(layer, Layer::Video { clip: active, .. } if active == clip))
        });
        renderer.render(&scene);
        let pixels = renderer.read_output()?;
        write_frame(frame - plan.start, &pixels)?;
        if last_report.elapsed() > Duration::from_millis(200) {
            last_report = Instant::now();
            progress((frame - plan.start) as f32 / total as f32);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use edit_core::Mute;

    /// RMS of interleaved stereo f32 samples between two times (seconds).
    fn rms(samples: &[f32], from: f64, to: f64) -> f64 {
        let (a, b) = ((from * 48000.0) as usize * 2, (to * 48000.0) as usize * 2);
        let part = &samples[a..b];
        (part.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>() / part.len() as f64).sqrt()
    }

    /// The export's own chain, run through FFmpeg on a tone: silence inside a
    /// mute, a cosine ramp outside it, the rest untouched.
    #[test]
    fn mutes_silence_the_source_with_ramps() {
        let dir = std::env::temp_dir().join(format!("edit-mute-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tone = dir.join("tone.wav");
        let made = Command::new(crate::tools::ffmpeg())
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
            ])
            .arg("sine=frequency=440:sample_rate=48000:duration=4")
            .arg(&tone)
            .status()
            .unwrap();
        assert!(made.success());
        // The clip plays the source from 1 s; the mute is 2.0–2.5 s of the source.
        let segment = AudioSegment {
            clip: "a".into(),
            media: "m".into(),
            start: 0.0,
            duration: 2.5,
            source_in: 1.0,
            speed: 1.0,
            volume_db: 0.0,
            fade_in: 0.0,
            fade_out: 0.0,
            mutes: vec![
                Mute { from: 2.0, to: 2.5 },
                Mute {
                    from: 30.0,
                    to: 31.0,
                },
            ],
        };
        let chain = segment_chain(0, 0, &segment);
        assert_eq!(
            chain.matches("cos(").count(),
            2,
            "only the mute it plays: {chain}"
        );
        let output = Command::new(crate::tools::ffmpeg())
            .args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(&tone)
            .args([
                "-filter_complex",
                &chain,
                "-map",
                "[a0]",
                "-f",
                "f32le",
                "-",
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let samples: Vec<f32> = output
            .stdout
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_le_bytes(*b))
            .collect();
        // Seeking at the input must keep the same mute positions and samples.
        let mut sought = segment.clone();
        sought.source_in = 0.0;
        for mute in &mut sought.mutes {
            mute.from -= segment.source_in;
            mute.to -= segment.source_in;
        }
        let output = Command::new(crate::tools::ffmpeg())
            .args(["-v", "error", "-ss", "1", "-t", "2.5", "-i"])
            .arg(&tone)
            .args([
                "-filter_complex",
                &segment_chain(0, 0, &sought),
                "-map",
                "[a0]",
                "-f",
                "f32le",
                "-",
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let optimized: Vec<f32> = output
            .stdout
            .as_chunks::<4>()
            .0
            .iter()
            .map(|bytes| f32::from_le_bytes(*bytes))
            .collect();
        assert_eq!(optimized, samples);
        // As the export encodes it.
        let encoded = Command::new(crate::tools::ffmpeg())
            .args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(&tone)
            .args([
                "-filter_complex",
                &chain,
                "-map",
                "[a0]",
                "-c:a",
                "aac",
                "-f",
                "null",
                "-",
            ])
            .output()
            .unwrap();
        assert!(
            encoded.status.success(),
            "{}",
            String::from_utf8_lossy(&encoded.stderr)
        );
        let full = rms(&samples, 0.1, 0.9);
        assert!(full > 0.05, "tone heard: {full}");
        // Clip time 1.0–1.5 s is source 2.0–2.5 s.
        assert!(rms(&samples, 1.0, 1.5) < 1e-4, "silent inside");
        assert!(
            (rms(&samples, 1.52, 2.4) - full).abs() < 0.01 * full,
            "untouched after the fade"
        );
        assert!(
            (rms(&samples, 0.1, 0.98) - full).abs() < 0.01 * full,
            "untouched before"
        );
        // Halfway through the 12 ms fade the gain is about one half.
        let ramp = rms(&samples, 1.5045, 1.5075) / full;
        assert!((0.3..0.7).contains(&ramp), "ramping: {ramp}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_partial_export_preserves_a_fade_already_in_progress() {
        let segment = AudioSegment {
            clip: "a".into(),
            media: "m".into(),
            start: 0.0,
            duration: 0.5,
            source_in: 0.0,
            speed: 1.0,
            volume_db: 0.0,
            fade_in: 2.0,
            fade_out: 1.0,
            mutes: vec![],
        };
        let chain = segment_chain_with_fades(0, 0, &segment, 1.0, 4.0);
        let output = Command::new(crate::tools::ffmpeg())
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=0.5|0.5:d=0.5:s=48000:c=stereo",
                "-filter_complex",
                &chain,
                "-map",
                "[a0]",
                "-f",
                "f32le",
                "-",
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let samples: Vec<f32> = output
            .stdout
            .as_chunks::<4>()
            .0
            .iter()
            .map(|bytes| f32::from_le_bytes(*bytes))
            .collect();
        assert!(
            (samples[0] - 0.25).abs() < 0.001,
            "mid-fade starts at original gain: {}",
            samples[0]
        );
        assert!((samples[samples.len() - 2] - 0.375).abs() < 0.001);
    }
}
