//! Native rendering: single frames (for agents) and full exports. Both run
//! the same `edit-render` compositor the browser preview runs as WASM.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use edit_core::{audio_segments, evaluate, Layer, Media, Project};
use edit_render::{text::BUNDLED_FONTS, wgpu, Renderer};
use serde_json::json;

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
struct VideoReader {
    path: PathBuf,
    width: u32,
    height: u32,
    fps: f64,
    child: Option<(Child, ChildStdout)>,
    start: f64,
    next_index: i64,
    frame: Vec<u8>,
    has_frame: bool,
}

impl VideoReader {
    fn new(media: &Media, width: u32, height: u32) -> Self {
        let (width, height) = decode_size(media, width, height);
        Self {
            path: PathBuf::from(&media.path),
            width,
            height,
            fps: if media.fps > 0.0 { media.fps } else { 30.0 },
            child: None,
            start: 0.0,
            next_index: 0,
            frame: vec![0; width as usize * height as usize * 4],
            has_frame: false,
        }
    }

    fn restart(&mut self, time: f64) -> Result<(), String> {
        self.stop();
        let time = time.max(0.0);
        let mut child = Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                &format!("{time:.6}"),
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
        Ok(())
    }

    /// Frame covering `time` (seconds into the source).
    fn frame_at(&mut self, time: f64) -> Result<&[u8], String> {
        let ahead = time - (self.start + self.next_index as f64 / self.fps);
        if self.child.is_none()
            || time < self.start - 1e-6
            || ahead > 2.0
            || (self.next_index > 0 && ahead < -1.5 / self.fps)
        {
            self.restart(time)?;
        }
        let target = ((time - self.start) * self.fps + 1e-6).floor() as i64;
        while self.next_index <= target {
            let Some((_, stdout)) = self.child.as_mut() else {
                break;
            };
            match stdout.read_exact(&mut self.frame) {
                Ok(()) => {
                    self.has_frame = true;
                    self.next_index += 1;
                }
                Err(_) => {
                    // End of source: hold the last frame.
                    self.next_index = i64::MAX / 2;
                    break;
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

/// Decodes the single source frame nearest `time` (as the export's fps filter
/// and the browser preview pick it) without keeping a process around.
fn grab_frame(
    media: &Media,
    time: f64,
    width: u32,
    height: u32,
) -> Result<(u32, u32, Vec<u8>), String> {
    let (w, h) = decode_size(media, width, height);
    // An accurate seek returns the first frame at or after its time: half a frame early is the nearest.
    let time = time - 0.5 / if media.fps > 0.0 { media.fps } else { 30.0 };
    let output = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            &format!("{:.6}", time.max(0.0)),
            "-i",
        ])
        .arg(&media.path)
        .args([
            "-an",
            "-frames:v",
            "1",
            "-vf",
            &format!("scale={w}:{h}:flags=bicubic"),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    let expected = w as usize * h as usize * 4;
    if output.stdout.len() < expected {
        return Err(format!("no frame at {time:.3}s in {}", media.name));
    }
    Ok((w, h, output.stdout[..expected].to_vec()))
}

/// Owns a GPU on its own thread; frame renders queue here.
pub struct FrameRenderer {
    jobs: Mutex<mpsc::Sender<FrameJob>>,
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
    pub fn start() -> Arc<Self> {
        let (sender, receiver) = mpsc::channel::<FrameJob>();
        std::thread::spawn(move || {
            let mut renderer: Option<Renderer> = None;
            for job in receiver {
                let result = (|| {
                    let settings = job.project.settings;
                    if renderer.is_none() {
                        renderer = Some(new_renderer(settings.width, settings.height)?);
                    }
                    let renderer = renderer.as_mut().expect("renderer");
                    let mut images = Vec::new();
                    for frame in &job.frames {
                        images.push(render_one(renderer, &job.project, *frame, job.max_side)?);
                    }
                    Ok(images)
                })();
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
            .unwrap()
            .send(FrameJob {
                project,
                frames,
                max_side,
                reply,
            })
            .map_err(|_| "renderer stopped".to_owned())?;
        response.await.map_err(|_| "renderer stopped".to_owned())?
    }
}

fn render_one(
    renderer: &mut Renderer,
    project: &Project,
    frame: i64,
    max_side: u32,
) -> Result<RgbaImage, String> {
    let settings = project.settings;
    let scene = evaluate(project, frame);
    for layer in &scene.layers {
        if let Layer::Video {
            media, source_time, ..
        } = layer
        {
            let source = project
                .media(media)
                .ok_or_else(|| format!("unknown media {media}"))?;
            let (w, h, pixels) = grab_frame(source, *source_time, settings.width, settings.height)?;
            renderer.upload_video_rgba(media, w, h, &pixels);
        }
    }
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
            let mut sum = [0_u32; 4];
            for sy in sy0..sy1 {
                for sx in sx0..sx1 {
                    let i = ((sy * image.width + sx) * 4) as usize;
                    for (total, value) in sum.iter_mut().zip(&image.pixels[i..i + 4]) {
                        *total += u32::from(*value);
                    }
                }
            }
            let n = (sy1 - sy0) * (sx1 - sx0);
            let o = ((y * w + x) * 4) as usize;
            for (out, total) in pixels[o..o + 4].iter_mut().zip(sum) {
                *out = (total / n.max(1)) as u8;
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
            pixels[dst..dst + (image.width * 4) as usize]
                .copy_from_slice(&image.pixels[src..src + (image.width * 4) as usize]);
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
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Exports {
    pub fn cancel(&self, project: &str) -> bool {
        self.jobs
            .lock()
            .unwrap()
            .get(project)
            .map(|flag| flag.store(true, Ordering::Release))
            .is_some()
    }

    pub fn start(
        self: &Arc<Self>,
        store: Arc<Store>,
        project: Project,
        output: PathBuf,
    ) -> Result<(), String> {
        if project.duration() <= 0 {
            return Err("the timeline is empty".to_owned());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut jobs = self.jobs.lock().unwrap();
            if jobs.contains_key(&project.id) {
                return Err("an export is already running for this project".to_owned());
            }
            jobs.insert(project.id.clone(), Arc::clone(&cancel));
        }
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
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
            let result = export(&project, &output, &cancel, |progress| {
                emit("running", progress, json!({}))
            });
            match result {
                Ok(()) => emit(
                    "done",
                    1.0,
                    json!({ "seconds": started.elapsed().as_secs_f32() }),
                ),
                Err(error) if cancel.load(Ordering::Acquire) => {
                    let _ = std::fs::remove_file(&output);
                    emit("cancelled", 0.0, json!({ "error": error }));
                }
                Err(error) => emit("failed", 0.0, json!({ "error": error })),
            }
            this.jobs.lock().unwrap().remove(&id);
        });
        Ok(())
    }
}

fn export(
    project: &Project,
    output: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f32),
) -> Result<(), String> {
    let settings = project.settings;
    let (width, height) = (settings.width, settings.height);
    let fps = settings.fps;
    let total = project.duration();
    let seconds = total as f64 / project.fps();
    let mut renderer = new_renderer(width, height)?;

    let segments: Vec<_> = audio_segments(project)
        .into_iter()
        .filter(|segment| {
            project
                .media(&segment.media)
                .is_some_and(|media| media.has_audio)
        })
        .collect();
    let mut command = Command::new("ffmpeg");
    command.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
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
    let mut filters = Vec::new();
    for (index, segment) in segments.iter().enumerate() {
        let media = project.media(&segment.media).expect("filtered above");
        command.arg("-i").arg(&media.path);
        let input = index + 1;
        let mut chain = format!(
            "[{input}:a:0]aformat=sample_rates=48000:channel_layouts=stereo,atrim=start={:.6}:duration={:.6},asetpts=PTS-STARTPTS",
            segment.source_in,
            segment.duration * segment.speed
        );
        let mut tempo = segment.speed;
        while (tempo - 1.0).abs() > 1e-6 {
            let step = tempo.clamp(0.5, 2.0);
            chain.push_str(&format!(",atempo={step:.6}"));
            tempo /= step;
        }
        chain.push_str(&format!(",volume={:.3}dB", segment.volume_db));
        if segment.fade_in > 0.0 {
            chain.push_str(&format!(",afade=t=in:st=0:d={:.4}", segment.fade_in));
        }
        if segment.fade_out > 0.0 {
            chain.push_str(&format!(
                ",afade=t=out:st={:.4}:d={:.4}",
                (segment.duration - segment.fade_out).max(0.0),
                segment.fade_out
            ));
        }
        let delay = (segment.start * 1000.0).round() as i64;
        chain.push_str(&format!(",adelay={delay}|{delay}[a{index}]"));
        filters.push(chain);
    }
    if !segments.is_empty() {
        let inputs: String = (0..segments.len())
            .map(|index| format!("[a{index}]"))
            .collect();
        filters.push(format!(
            "{inputs}amix=inputs={}:normalize=0:dropout_transition=0,apad,atrim=duration={seconds:.6}[aout]",
            segments.len()
        ));
        command.args([
            "-filter_complex",
            &filters.join(";"),
            "-map",
            "0:v",
            "-map",
            "[aout]",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
        ]);
    } else {
        command.args(["-map", "0:v"]);
    }
    command
        .args([
            "-vf",
            "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "17",
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-movflags",
            "+faststart",
            "-t",
            &format!("{seconds:.6}"),
        ])
        .arg(output)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut encoder = command
        .spawn()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    let mut stdin = encoder.stdin.take().ok_or("encoder stdin")?;
    let stderr = encoder.stderr.take();
    let stderr_thread = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });

    let mut readers: HashMap<String, VideoReader> = HashMap::new();
    let mut last_report = Instant::now();
    let result = (|| {
        for frame in 0..total {
            if cancel.load(Ordering::Acquire) {
                return Err("cancelled".to_owned());
            }
            let scene = evaluate(project, frame);
            for layer in &scene.layers {
                if let Layer::Video {
                    media, source_time, ..
                } = layer
                {
                    let source = project
                        .media(media)
                        .ok_or_else(|| format!("unknown media {media}"))?;
                    let reader = readers
                        .entry(media.clone())
                        .or_insert_with(|| VideoReader::new(source, width, height));
                    let (w, h) = (reader.width, reader.height);
                    let pixels = reader.frame_at(*source_time)?;
                    renderer.upload_video_rgba(media, w, h, pixels);
                }
            }
            renderer.render(&scene);
            let pixels = renderer.read_output()?;
            stdin
                .write_all(&pixels)
                .map_err(|_| "the encoder stopped early".to_owned())?;
            if last_report.elapsed() > Duration::from_millis(200) {
                last_report = Instant::now();
                progress(frame as f32 / total as f32);
            }
        }
        Ok(())
    })();
    drop(stdin);
    drop(readers);
    if result.is_err() {
        let _ = encoder.kill();
    }
    let status = encoder.wait().map_err(|error| error.to_string())?;
    let stderr = stderr_thread.join().unwrap_or_default();
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
