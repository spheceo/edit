//! Native rendering: single frames (for agents and the UI) and full exports.
//! Both run the same `edit-render` compositor the browser preview runs as WASM.
//!
//! An export is a pipeline: a planner evaluates frames a little ahead and hands
//! each clip's run of frames to one of a few decoder threads (so the next
//! clip's file is opened and sought while this one plays), the compositor
//! uploads, renders and queues each frame's readback without waiting for it,
//! and an encoder thread reads frames back and hands them to the encoder. The
//! sound is mixed first (`crate::mix`; seconds, and slower beside the video's
//! decoders), and the two are put together at the end without re-encoding.

use parking_lot::{Condvar, Mutex};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use base64::Engine;
use edit_core::{audio_segments, evaluate_seen, AudioSegment, Layer, Media, Project, Scene};
use edit_render::{text::BUNDLED_FONTS, wgpu, Renderer};
use serde_json::{json, Value};

use crate::export::{ExportOptions, Format, Plan};
#[cfg(target_os = "macos")]
use crate::mac_media::{Writer as ChunkWriter, WriterOptions};
#[cfg(not(target_os = "macos"))]
use crate::pipe_writer::{Writer as ChunkWriter, WriterOptions};

/// The GPU device renderers draw with. On a Mac each renderer has its own;
/// on Linux they share one, made once: NVIDIA's driver (615) deadlocked when
/// one renderer's device was destroyed while another's submitted work (Nov 7,
/// the renderer's tests side by side; exports, previews and frames for the
/// agent do the same in the server).
fn gpu() -> Result<(wgpu::Device, wgpu::Queue), String> {
    #[cfg(not(target_os = "macos"))]
    {
        static SHARED: parking_lot::Mutex<Option<(wgpu::Device, wgpu::Queue)>> =
            parking_lot::Mutex::new(None);
        let mut shared = SHARED.lock();
        if let Some((device, queue)) = shared.as_ref() {
            return Ok((device.clone(), queue.clone()));
        }
        let made = new_gpu()?;
        *shared = Some(made.clone());
        Ok(made)
    }
    #[cfg(target_os = "macos")]
    new_gpu()
}

fn new_gpu() -> Result<(wgpu::Device, wgpu::Queue), String> {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    // Vulkan or Metal only: OpenGL (EGL) opened beside Vulkan deadlocked
    // NVIDIA's driver when renderers came and went side by side (Linux, Nov 7).
    descriptor.backends = wgpu::Backends::PRIMARY;
    // No debug labels on GPU objects (a debug build's default): with renderers
    // made side by side, Vulkan's loader crashed naming one
    // (vkSetDebugUtilsObjectNameEXT, NVIDIA 615 on Linux, Nov 7: `just dev`'s
    // debug addon and `just check`'s tests, never a release build).
    descriptor.flags.remove(wgpu::InstanceFlags::DEBUG);
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    .map_err(|error| format!("no GPU available: {error}"))?;
    if std::env::var("EDIT_REQUIRE_GPU").as_deref() == Ok("1")
        && adapter.get_info().device_type == wgpu::DeviceType::Cpu
    {
        return Err("the cloud worker has no hardware graphics adapter".to_owned());
    }
    pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("edit native"),
        ..Default::default()
    }))
    .map_err(|error| format!("GPU device: {error}"))
}

pub fn new_renderer(width: u32, height: u32) -> Result<Renderer, String> {
    let (device, queue) = gpu()?;
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

/// Pixel order of decoded and rendered frames.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Order {
    Rgba,
    /// The video decoder's and encoder's own order: no conversion on the CPU
    /// (the renderer samples a BGRA texture the same as an RGBA one).
    Bgra,
}

/// What a reader decodes: a file at a size, in an order.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct DecodeKey {
    path: PathBuf,
    width: u32,
    height: u32,
    order: Order,
}

#[derive(Clone, Debug)]
pub(crate) struct Source {
    key: DecodeKey,
    fps: f64,
    still: bool,
}

impl Source {
    fn new(media: &Media, path: PathBuf, (width, height): (u32, u32), order: Order) -> Self {
        Self {
            key: DecodeKey {
                path,
                width,
                height,
                order,
            },
            fps: if media.fps > 0.0 { media.fps } else { 30.0 },
            still: media.kind == edit_core::MediaKind::Image,
        }
    }

    fn bytes(&self) -> usize {
        self.key.width as usize * self.key.height as usize * 4
    }
}

/// Sequential reader for one source that restarts on jumps: AVFoundation on
/// the Mac, FFmpeg for what it can't read (and elsewhere), ImageIO for stills.
pub(crate) struct VideoReader {
    source: Source,
    pub(crate) width: u32,
    pub(crate) height: u32,
    child: Option<(crate::util::Watched, ChildStdout)>,
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
    /// Source seconds last asked for: which pooled reader continues best.
    position: Option<f64>,
    /// A still has been copied out since it was decoded.
    copied: bool,
    /// A cloud original's stretches cut to this Mac (`crate::excerpts`), read instead of the URL where they reach.
    excerpts: Option<Arc<Vec<crate::excerpts::Excerpt>>>,
    /// The excerpt being read (its index) and its reader.
    excerpt: Option<(usize, Box<VideoReader>)>,
    /// Excerpts that wouldn't read: the URL for those stretches.
    broken: Vec<usize>,
}

impl VideoReader {
    /// Small frames for face and text finders (Vision on a Mac, YuNet
    /// elsewhere), using FFmpeg's ranged input for cloud media and
    /// AVFoundation for local files on a Mac, just as timeline rendering does.
    pub(crate) fn analysis(path: &Path, width: u32, height: u32) -> Self {
        Self::open(Source {
            key: DecodeKey {
                path: path.to_path_buf(),
                width,
                height,
                order: Order::Bgra,
            },
            fps: 30.0,
            still: false,
        })
    }

    fn open(source: Source) -> Self {
        let (width, height) = (source.key.width, source.key.height);
        #[cfg(target_os = "macos")]
        let url = crate::util::is_url(&source.key.path);
        let excerpts = crate::excerpts::of(&source.key.path);
        Self {
            source,
            width,
            height,
            child: None,
            #[cfg(target_os = "macos")]
            native: None,
            #[cfg(target_os = "macos")]
            // AVAssetReader only reads local files: a cloud original's URL is FFmpeg's.
            native_failed: std::env::var_os("EDIT_FFMPEG_VIDEO").is_some() || url,
            start: 0.0,
            next_index: 0,
            frame: Vec::new(),
            has_frame: false,
            eof: false,
            spare: Vec::new(),
            position: None,
            copied: false,
            excerpts,
            excerpt: None,
            broken: Vec::new(),
        }
    }

    /// The frame at `time` from a local excerpt that holds it, into `out`;
    /// None when none does (or the one that does won't read: it's left out
    /// after, and the URL read instead).
    fn read_excerpt(&mut self, time: f64, out: &mut [u8], if_changed: bool) -> Option<bool> {
        let excerpts = self.excerpts.clone()?;
        loop {
            let index = crate::excerpts::covering(&excerpts, time, &self.broken)?;
            let excerpt = excerpts.get(index)?;
            if self.excerpt.as_ref().is_none_or(|(at, _)| *at != index) {
                if !excerpt.path.is_file() {
                    self.broken.push(index);
                    continue;
                }
                let mut source = self.source.clone();
                source.key.path = excerpt.path.clone();
                self.excerpt = Some((index, Box::new(VideoReader::open(source))));
            }
            let (_, reader) = self.excerpt.as_mut()?;
            // A new reader has copied nothing out yet: it always says the picture changed.
            match reader.frame_into((time - excerpt.from).max(0.0), out, if_changed) {
                Ok(changed) => return Some(changed),
                Err(error) => {
                    crate::log::warn(
                        "render",
                        format!(
                            "excerpt {} won't read ({error}); reading the cloud original there",
                            excerpt.path.display()
                        ),
                    );
                    self.excerpt = None;
                    self.broken.push(index);
                }
            }
        }
    }

    /// The source frame nearest `time` (as the preview's `videoTime` and the
    /// native reader pick it): frame n covers `[(n - 0.5) / fps, (n + 0.5) / fps)`.
    fn nearest(&self, time: f64) -> i64 {
        (time.max(0.0) * self.source.fps + 0.5 + 1e-7).floor() as i64
    }

    /// Restarts FFmpeg at the frame nearest `time`. FFmpeg begins at the first
    /// frame at or after the time it's given, so it's given half a frame
    /// before that frame (seeking to `time` itself landed a frame late when
    /// `time` was in the first half of a frame), and the timestamps are
    /// re-based on it (`setpts`) so `fps=` keeps every frame in its own slot
    /// rather than rounding half-frame times one way or the other.
    fn restart(&mut self, time: f64) -> Result<(), String> {
        self.stop();
        self.spare.resize(self.source.bytes(), 0);
        let first = self.nearest(time);
        let fps = self.source.fps;
        let time = ((first as f64 - 0.5) / fps).max(0.0);
        let mut child = Command::new(crate::util::ffmpeg())
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
                crate::util::protocols(&self.source.key.path),
            ])
            .args(crate::util::url_args(&self.source.key.path))
            // A cloud original read from R2: decoded on the Mac's media engine.
            .args(
                if cfg!(target_os = "macos") && crate::util::is_url(&self.source.key.path) {
                    &["-hwaccel", "videotoolbox"][..]
                } else {
                    &[]
                },
            )
            .arg("-i")
            .arg(&self.source.key.path)
            .args([
                "-an",
                "-vf",
                &format!(
                    "setpts=PTS-STARTPTS,fps={:.6},scale={}:{}:flags=bicubic",
                    self.source.fps, self.width, self.height
                ),
                "-threads",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                match self.source.key.order {
                    Order::Rgba => "rgba",
                    Order::Bgra => "bgra",
                },
                "pipe:1",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("ffmpeg: {error}"))?;
        let stdout = child.stdout.take().ok_or("ffmpeg stdout")?;
        self.child = Some((crate::util::Watched::new(child), stdout));
        self.start = first as f64 / fps;
        self.next_index = 0;
        self.eof = false;
        self.has_frame = false;
        Ok(())
    }

    fn decode_still(&mut self) -> Result<(), String> {
        self.frame.resize(self.source.bytes(), 0);
        #[cfg(target_os = "macos")]
        crate::mac_media::image(
            &self.source.key.path,
            self.width,
            self.height,
            &mut self.frame,
        )?;
        #[cfg(not(target_os = "macos"))]
        {
            // FFmpeg decodes stills elsewhere: its first (only) frame.
            self.restart(0.0)?;
            self.read_ffmpeg(0.0)?;
            self.stop();
        }
        #[cfg(target_os = "macos")]
        if self.source.key.order == Order::Bgra {
            for pixel in self.frame.as_chunks_mut::<4>().0 {
                pixel.swap(0, 2);
            }
        }
        self.has_frame = true;
        self.copied = false;
        Ok(())
    }

    /// Frame covering `time` (seconds into the source), into the reader's own buffer.
    pub(crate) fn frame_at(&mut self, time: f64) -> Result<&[u8], String> {
        self.position = Some(time);
        if self.source.still {
            if !self.has_frame {
                self.decode_still()?;
            }
            return Ok(&self.frame);
        }
        if self.excerpts.is_some() {
            let mut frame = std::mem::take(&mut self.frame);
            frame.resize(self.source.bytes(), 0);
            let read = self.read_excerpt(time, &mut frame, false);
            self.frame = frame;
            if read.is_some() {
                return Ok(&self.frame);
            }
        }
        #[cfg(target_os = "macos")]
        if !self.native_failed {
            let mut frame = std::mem::take(&mut self.frame);
            frame.resize(self.source.bytes(), 0);
            let decoded = self.native_frame(time, &mut frame, false);
            self.frame = frame;
            if decoded.is_ok() {
                return Ok(&self.frame);
            }
        }
        self.read_ffmpeg(time)?;
        Ok(&self.frame)
    }

    /// The frame covering `time` into `out` (sized for this reader). With
    /// `if_changed`, Ok(false) leaves `out` alone when the picture is the one
    /// last copied out (a slowed clip shows each frame several times).
    fn frame_into(&mut self, time: f64, out: &mut [u8], if_changed: bool) -> Result<bool, String> {
        self.position = Some(time);
        if self.source.still {
            if !self.has_frame {
                self.decode_still()?;
            }
            if if_changed && self.copied {
                return Ok(false);
            }
            out.copy_from_slice(self.frame.get(..out.len()).ok_or("still size changed")?);
            self.copied = true;
            return Ok(true);
        }
        if self.excerpts.is_some() {
            if let Some(changed) = self.read_excerpt(time, out, if_changed) {
                return Ok(changed);
            }
            // Off the excerpts: what `out` holds is the excerpt's, not this reader's last picture.
            if self.excerpt.take().is_some() {
                return self.frame_into_url(time, out, false);
            }
        }
        self.frame_into_url(time, out, if_changed)
    }

    /// `frame_into` from the reader's own file (the URL of a cloud original).
    fn frame_into_url(
        &mut self,
        time: f64,
        out: &mut [u8],
        if_changed: bool,
    ) -> Result<bool, String> {
        #[cfg(target_os = "macos")]
        if !self.native_failed {
            if let Ok(changed) = self.native_frame(time, out, if_changed) {
                return Ok(changed);
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = if_changed; // only the Mac's reader can tell a picture didn't change
        self.read_ffmpeg(time)?;
        out.copy_from_slice(self.frame.get(..out.len()).ok_or("decoded size changed")?);
        Ok(true)
    }

    #[cfg(target_os = "macos")]
    fn native_frame(
        &mut self,
        time: f64,
        out: &mut [u8],
        if_changed: bool,
    ) -> Result<bool, String> {
        let decoded = (|| {
            if self.native.is_none() {
                self.native = Some(crate::mac_media::Reader::open(
                    &self.source.key.path,
                    self.width,
                    self.height,
                )?);
            }
            self.native.as_mut().ok_or("native reader missing")?.frame(
                time,
                out,
                self.source.key.order,
                if_changed,
            )
        })();
        if let Err(error) = &decoded {
            crate::log::warn(
                "render",
                format!(
                    "native decode of {}: {error}; using FFmpeg",
                    self.source.key.path.display()
                ),
            );
            self.native = None;
            self.native_failed = true;
        }
        decoded
    }

    fn read_ffmpeg(&mut self, time: f64) -> Result<(), String> {
        let fps = self.source.fps;
        // Index 0 is the frame at `start`; the one wanted is the nearest to `time`.
        let target = |reader: &Self| reader.nearest(time) - (reader.start * fps).round() as i64;
        let ahead = time - (self.start + self.next_index as f64 / fps);
        let wanted = target(self);
        if self.child.is_none()
            || wanted < 0
            || (!self.eof && ahead > 2.0)
            // Already past it: the frame held now is index `next_index - 1`.
            || (self.next_index > 0 && wanted < self.next_index - 1)
        {
            self.restart(time)?;
        }
        self.frame.resize(self.source.bytes(), 0);
        let mut want = target(self);
        let mut backed_off = false;
        while !self.eof && self.next_index <= want {
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
                        return Err(format!(
                            "decoder failed for {}",
                            self.source.key.path.display()
                        ));
                    }
                    // End of source: hold the last frame.
                    self.eof = true;
                    break;
                }
                // Asked for its very end (an 8.0 s map's frame at 8.0 s, a
                // look_at_media sample at a clip's last instant): the seek
                // lands past the last frame and nothing comes. Start a second
                // earlier and hold the last frame there is.
                Err(error)
                    if error.kind() == std::io::ErrorKind::UnexpectedEof
                        && !backed_off
                        && self.start > 0.0 =>
                {
                    backed_off = true;
                    let earlier = (self.start - 1.0).max(0.0);
                    self.restart(earlier)?;
                    want = target(self);
                }
                Err(error) => {
                    return Err(format!(
                        "could not decode {}: {error}",
                        self.source.key.path.display()
                    ))
                }
            }
        }
        Ok(())
    }

    fn stop(&mut self) {
        if let Some((mut child, _)) = self.child.take() {
            child.stop();
        }
    }
}

impl Drop for VideoReader {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Open readers kept between frames, by file and size rather than by clip, so
/// cutting back to a file (jump cuts, a sheet's frames) continues a reader
/// instead of opening and seeking a new one.
struct ReaderPool {
    readers: Vec<(VideoReader, u64)>,
    clock: u64,
    total: usize,
    per_key: usize,
}

impl ReaderPool {
    fn new(total: usize, per_key: usize) -> Self {
        Self {
            readers: Vec::new(),
            clock: 0,
            total,
            per_key,
        }
    }

    /// The pooled reader for `source` that gets to `time` soonest (one just
    /// behind it decodes forward; anything else seeks), or a new one.
    fn take(&mut self, source: &Source, time: f64) -> VideoReader {
        let cost = |reader: &VideoReader, used: u64| match reader.position {
            Some(position) if position <= time + 1e-6 && time - position <= 2.0 => time - position,
            _ => 1e6 - used as f64 * 1e-3,
        };
        let best = self
            .readers
            .iter()
            .enumerate()
            .filter(|(_, (reader, _))| reader.source.key == source.key)
            .min_by(|(_, (a, at)), (_, (b, bt))| cost(a, *at).total_cmp(&cost(b, *bt)))
            .map(|(index, _)| index);
        match best {
            Some(index) => self.readers.swap_remove(index).0,
            None => VideoReader::open(source.clone()),
        }
    }

    fn put(&mut self, reader: VideoReader) {
        self.clock += 1;
        let key = reader.source.key.clone();
        self.readers.push((reader, self.clock));
        let oldest = |readers: &Vec<(VideoReader, u64)>, key: Option<&DecodeKey>| {
            readers
                .iter()
                .enumerate()
                .filter(|(_, (reader, _))| key.is_none_or(|key| reader.source.key == *key))
                .min_by_key(|(_, (_, used))| *used)
                .map(|(index, _)| index)
        };
        while self
            .readers
            .iter()
            .filter(|(reader, _)| reader.source.key == key)
            .count()
            > self.per_key
        {
            let Some(index) = oldest(&self.readers, Some(&key)) else {
                break;
            };
            self.readers.swap_remove(index);
        }
        while self.readers.len() > self.total {
            let Some(index) = oldest(&self.readers, None) else {
                break;
            };
            self.readers.swap_remove(index);
        }
    }

    fn clear(&mut self) {
        self.readers.clear();
    }
}

/// Frames for `requests` (each a source and a time), decoded on up to
/// `threads` threads, each going through its share in file and time order.
/// Readers come from and go back to `pool`.
fn decode_all(
    pool: &mut ReaderPool,
    requests: &[(Source, f64)],
    threads: usize,
) -> Result<Vec<Vec<u8>>, String> {
    let mut order: Vec<usize> = (0..requests.len()).collect();
    order.sort_by(|a, b| {
        let (Some((sa, ta)), Some((sb, tb))) = (requests.get(*a), requests.get(*b)) else {
            return std::cmp::Ordering::Equal;
        };
        (&sa.key.path, sa.key.width, sa.key.height)
            .cmp(&(&sb.key.path, sb.key.width, sb.key.height))
            .then(ta.total_cmp(tb))
    });
    let threads = threads.clamp(1, requests.len().max(1));
    let share = order.len().div_ceil(threads).max(1);
    let shares: Vec<Vec<usize>> = order.chunks(share).map(<[usize]>::to_vec).collect();
    let mut work = Vec::new();
    for share in shares {
        let Some((source, time)) = share.first().and_then(|index| requests.get(*index)) else {
            continue;
        };
        let reader = pool.take(source, *time);
        work.push((share, reader));
    }
    let run = |(share, mut reader): (Vec<usize>, VideoReader)| {
        let mut done = Vec::new();
        let mut spent = Vec::new();
        for index in share {
            let Some((source, time)) = requests.get(index) else {
                continue;
            };
            if reader.source.key != source.key {
                spent.push(std::mem::replace(
                    &mut reader,
                    VideoReader::open(source.clone()),
                ));
            }
            let mut out = vec![0_u8; source.bytes()];
            let decoded = reader.frame_into(*time, &mut out, false);
            done.push((index, decoded.map(|_| out)));
        }
        spent.push(reader);
        (done, spent)
    };
    let results: Vec<_> = if work.len() <= 1 {
        work.into_iter().map(run).collect()
    } else {
        std::thread::scope(|scope| {
            let handles: Vec<_> = work
                .into_iter()
                .map(|item| scope.spawn(move || run(item)))
                .collect();
            handles
                .into_iter()
                .filter_map(|handle| handle.join().ok())
                .collect()
        })
    };
    let mut frames: Vec<Option<Vec<u8>>> = vec![None; requests.len()];
    let mut failure = None;
    for (done, spent) in results {
        for reader in spent {
            pool.put(reader);
        }
        for (index, decoded) in done {
            match decoded {
                Ok(pixels) => {
                    if let Some(slot) = frames.get_mut(index) {
                        *slot = Some(pixels);
                    }
                }
                Err(error) => failure = Some(error),
            }
        }
    }
    if let Some(error) = failure {
        return Err(error);
    }
    frames
        .into_iter()
        .map(|frame| frame.ok_or_else(|| "a frame wasn't decoded".to_owned()))
        .collect()
}

// ---------------------------------------------------------------------------
// Single frames

/// Owns a GPU on its own thread; frame renders queue here, the agent's ahead
/// of the UI's (covers and thumbnails can wait; an agent's turn can't).
pub struct FrameRenderer {
    queue: Arc<JobQueue>,
}

struct JobQueue {
    jobs: Mutex<Queues>,
    ready: Condvar,
    /// Set by `stop`: the thread ends, and its GPU and readers go with it.
    stopped: AtomicBool,
}

#[derive(Default)]
struct Queues {
    agent: VecDeque<FrameJob>,
    ui: VecDeque<FrameJob>,
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

/// Readers left open this long with nothing to render are closed.
const IDLE: Duration = Duration::from_secs(20);

impl FrameRenderer {
    /// `cache` is the media cache: waveforms' sound levels and light previews.
    pub fn start(cache: PathBuf) -> Arc<Self> {
        let queue = Arc::new(JobQueue {
            jobs: Mutex::new(Queues::default()),
            ready: Condvar::new(),
            stopped: AtomicBool::new(false),
        });
        let jobs = Arc::clone(&queue);
        std::thread::spawn(move || {
            let mut renderer: Option<Renderer> = None;
            let mut last_project = String::new();
            let mut pool = ReaderPool::new(6, 2);
            loop {
                let job = {
                    let mut queues = jobs.jobs.lock();
                    loop {
                        if jobs.stopped.load(Ordering::Acquire) {
                            // Waiting callers hear "renderer stopped".
                            queues.agent.clear();
                            queues.ui.clear();
                            return;
                        }
                        if let Some(job) =
                            queues.agent.pop_front().or_else(|| queues.ui.pop_front())
                        {
                            break job;
                        }
                        if jobs.ready.wait_for(&mut queues, IDLE).timed_out()
                            && queues.agent.is_empty()
                            && queues.ui.is_empty()
                        {
                            pool.clear();
                        }
                    }
                };
                if job.reply.is_closed() {
                    continue;
                }
                let rendering = Instant::now();
                let caught = crate::util::catch("rendering a frame", || {
                    let settings = job.project.settings;
                    let renderer = match &mut renderer {
                        Some(renderer) => renderer,
                        empty => empty.insert(new_renderer(settings.width, settings.height)?),
                    };
                    // Media ids are per project: another project's may be other files.
                    if job.project.id != last_project {
                        renderer.clear_peaks();
                        last_project = job.project.id.clone();
                    }
                    render_job(
                        renderer,
                        &mut pool,
                        &job.project,
                        &job.frames,
                        job.max_side,
                        &cache,
                    )
                });
                // A crash may leave the GPU state half-way: start afresh next time.
                if caught.is_err() {
                    renderer = None;
                    pool.clear();
                }
                let result = caught.and_then(|result| result);
                let name = if job.frames.len() > 1 {
                    "render: frames"
                } else {
                    "render: frame"
                };
                crate::log::record(
                    "render",
                    name,
                    rendering.elapsed(),
                    result.as_ref().err().map(String::as_str),
                );
                let _ = job.reply.send(result);
            }
        });
        Arc::new(Self { queue })
    }

    /// Ends the renderer's thread once the frame it's on is done; renders
    /// waiting, and any asked for later, fail with "renderer stopped".
    pub fn stop(&self) {
        self.queue.stopped.store(true, Ordering::Release);
        let _held = self.queue.jobs.lock();
        self.queue.ready.notify_all();
    }

    /// Renders for the UI (covers, the export dialog, saving a frame).
    pub async fn render(
        &self,
        project: Project,
        frames: Vec<i64>,
        max_side: u32,
    ) -> Result<Vec<RgbaImage>, String> {
        self.submit(project, frames, max_side, false).await
    }

    /// Renders for an agent's tool call, ahead of any UI renders waiting.
    pub async fn render_for_agent(
        &self,
        project: Project,
        frames: Vec<i64>,
        max_side: u32,
    ) -> Result<Vec<RgbaImage>, String> {
        self.submit(project, frames, max_side, true).await
    }

    async fn submit(
        &self,
        project: Project,
        frames: Vec<i64>,
        max_side: u32,
        agent: bool,
    ) -> Result<Vec<RgbaImage>, String> {
        let (reply, response) = tokio::sync::oneshot::channel();
        {
            let mut queues = self.queue.jobs.lock();
            if self.queue.stopped.load(Ordering::Acquire) {
                return Err("renderer stopped".to_owned());
            }
            // Callers that gave up leave nothing to wait behind.
            queues.agent.retain(|job| !job.reply.is_closed());
            queues.ui.retain(|job| !job.reply.is_closed());
            let (queue, limit) = if agent {
                (&mut queues.agent, 16)
            } else {
                (&mut queues.ui, 8)
            };
            if queue.len() >= limit {
                return Err("renderer busy; try again shortly".to_owned());
            }
            queue.push_back(FrameJob {
                project,
                frames,
                max_side,
                reply,
            });
        }
        self.queue.ready.notify_one();
        response.await.map_err(|_| "renderer stopped".to_owned())?
    }
}

/// A scene's video pictures for the native preview (`crate::player`): each
/// video layer's clip and its frame, decoded at the size it's shown in a
/// `shown` picture from `sources` (a media's preview file, else its own path),
/// through `pool` so playing on decodes forward and a jump seeks.
#[cfg(target_os = "macos")]
pub(crate) struct PreviewPictures {
    pool: ReaderPool,
}

/// A clip's decoded picture: its clip, width, height and BGRA pixels.
#[cfg(target_os = "macos")]
pub(crate) type Picture = (String, u32, u32, Vec<u8>);

#[cfg(target_os = "macos")]
impl PreviewPictures {
    pub(crate) fn new() -> Self {
        // A few readers per file: two layers of one source, and the way back after a jump.
        Self {
            pool: ReaderPool::new(12, 3),
        }
    }

    pub(crate) fn clear(&mut self) {
        self.pool.clear();
    }

    /// `(clip, width, height, BGRA pixels)` for each video layer of `scene`.
    pub(crate) fn decode(
        &mut self,
        project: &Project,
        scene: &Scene,
        shown: (u32, u32),
        sources: &std::collections::HashMap<String, PathBuf>,
    ) -> Result<Vec<Picture>, String> {
        let mut requests = Vec::new();
        let mut clips = Vec::new();
        for layer in &scene.layers {
            if let Layer::Video {
                clip,
                media,
                source_time,
                ..
            } = layer
            {
                let found = project
                    .media(media)
                    .ok_or_else(|| format!("unknown media {media}"))?;
                let path = sources
                    .get(media)
                    .cloned()
                    .unwrap_or_else(|| PathBuf::from(&found.path));
                requests.push((
                    Source::new(
                        found,
                        path,
                        decode_size(found, shown.0, shown.1),
                        Order::Bgra,
                    ),
                    *source_time,
                ));
                clips.push(clip.clone());
            }
        }
        let threads = if requests.len() > 2 { 4 } else { 1 };
        let decoded = decode_all(&mut self.pool, &requests, threads)?;
        Ok(clips
            .into_iter()
            .zip(&requests)
            .zip(decoded)
            .map(|((clip, (source, _)), pixels)| {
                (clip, source.key.width, source.key.height, pixels)
            })
            .collect())
    }
}

/// Gives the renderer the sound levels this frame's waveforms read: each
/// media's peaks from the media cache (missing ones are tried again next frame).
pub(crate) fn feed_peaks(renderer: &mut Renderer, project: &Project, scene: &Scene, cache: &Path) {
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

/// Where to decode `media` from for a picture whose longest side is
/// `max_side` (0 = full size): the light 720p preview when that's enough and
/// made (short keyframe intervals, a fraction of the decoding), else the file.
fn picture_source(media: &Media, size: (u32, u32), max_side: u32, cache: Option<&Path>) -> Source {
    let original = PathBuf::from(&media.path);
    let path = match cache {
        Some(cache)
            if max_side > 0 && max_side <= 720 && media.kind == edit_core::MediaKind::Video =>
        {
            crate::media::light_preview(cache, &original).unwrap_or(original)
        }
        _ => original,
    };
    Source::new(media, path, size, Order::Bgra)
}

/// Renders `frames` of `project`: every picture they need decoded first (in
/// parallel, at the size they'll be shown), then composited one by one.
fn render_job(
    renderer: &mut Renderer,
    pool: &mut ReaderPool,
    project: &Project,
    frames: &[i64],
    max_side: u32,
    cache: &Path,
) -> Result<Vec<RgbaImage>, String> {
    let settings = project.settings;
    let (width, height) = (settings.width, settings.height);
    let longest = width.max(height).max(1);
    let scale = if max_side > 0 && max_side < longest {
        f64::from(max_side) / f64::from(longest)
    } else {
        1.0
    };
    let shown = (
        ((f64::from(width) * scale).round() as u32).max(2),
        ((f64::from(height) * scale).round() as u32).max(2),
    );
    let scenes: Vec<Scene> = frames
        .iter()
        .map(|frame| evaluate_seen(project, *frame))
        .collect();
    let mut requests = Vec::new();
    let mut layers = Vec::new();
    for (index, scene) in scenes.iter().enumerate() {
        for layer in &scene.layers {
            if let Layer::Video {
                clip,
                media,
                source_time,
                ..
            } = layer
            {
                let media = project
                    .media(media)
                    .ok_or_else(|| format!("unknown media {media}"))?;
                let size = decode_size(media, shown.0, shown.1);
                requests.push((
                    picture_source(media, size, max_side, Some(cache)),
                    *source_time,
                ));
                layers.push((index, clip.as_str()));
            }
        }
    }
    let threads = if requests.len() > 2 { 4 } else { 1 };
    let decoding = Instant::now();
    let decoded = decode_all(pool, &requests, threads)?;
    let decoding = decoding.elapsed();
    let compositing = Instant::now();
    let mut pictures: Vec<Vec<(&str, &Source, Vec<u8>)>> =
        scenes.iter().map(|_| Vec::new()).collect();
    for (((index, clip), (source, _)), pixels) in layers.into_iter().zip(&requests).zip(decoded) {
        if let Some(list) = pictures.get_mut(index) {
            list.push((clip, source, pixels));
        }
    }
    let mut images = Vec::new();
    for (scene, pictures) in scenes.iter().zip(pictures) {
        feed_peaks(renderer, project, scene, cache);
        for (clip, source, pixels) in &pictures {
            renderer.upload_video(clip, source.key.width, source.key.height, pixels, true);
        }
        renderer.render(scene);
        let image = RgbaImage {
            width,
            height,
            pixels: renderer.read_output()?,
        };
        images.push(if max_side > 0 {
            downscale(&image, max_side)
        } else {
            image
        });
    }
    if frames.len() > 1 {
        crate::log::info(
            "render",
            format!(
                "{} frames: {} pictures decoded in {}, composited in {}",
                frames.len(),
                requests.len(),
                crate::log::human(decoding),
                crate::log::human(compositing.elapsed())
            ),
        );
    }
    Ok(images)
}

/// Evenly spaced frames of a media file between `start` and `end` (seconds of
/// the file), at most `max_side` px, decoded side by side (from the light
/// preview when it's made).
pub fn media_frames(
    media: &Media,
    cache: Option<&Path>,
    start: f64,
    end: f64,
    count: usize,
    max_side: u32,
) -> Result<(Vec<RgbaImage>, Vec<f64>), String> {
    let end = end.min(media.duration).max(start);
    let times: Vec<f64> = (0..count)
        .map(|index| {
            if count == 1 {
                start
            } else {
                start + (end - start) * index as f64 / (count - 1) as f64
            }
        })
        .collect();
    let size = decode_size(media, max_side, max_side);
    let mut source = picture_source(media, size, max_side, cache);
    source.key.order = Order::Rgba;
    let requests: Vec<(Source, f64)> = times.iter().map(|time| (source.clone(), *time)).collect();
    let mut pool = ReaderPool::new(4, 4);
    let frames = decode_all(&mut pool, &requests, 4)?;
    let images = frames
        .into_iter()
        .map(|pixels| RgbaImage {
            width: size.0,
            height: size.1,
            pixels,
        })
        .collect();
    Ok((images, times))
}

/// One frame of a media file at full size (RGBA), for saving as a still.
pub fn media_still(media: &Media, time: f64) -> Result<RgbaImage, String> {
    let size = decode_size(media, media.width.max(2), media.height.max(2));
    let source = Source::new(media, PathBuf::from(&media.path), size, Order::Rgba);
    let mut reader = VideoReader::open(source);
    let pixels = reader.frame_at(time)?.to_vec();
    Ok(RgbaImage {
        width: size.0,
        height: size.1,
        pixels,
    })
}

/// Saves the frame of `media` at `time` (seconds) as a PNG at `out`: decoded
/// natively and written by ImageIO on the Mac, grabbed by FFmpeg otherwise.
/// Blocking: call it off the async runtime.
pub fn save_still(media: &Media, time: f64, out: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let native = media_still(media, time).and_then(|still| {
            let png = crate::mac_media::encode_image(
                &still.pixels,
                still.width,
                still.height,
                still.width as usize * 4,
                None,
            )?;
            std::fs::write(out, png).map_err(|error| error.to_string())
        });
        match native {
            Ok(()) => return Ok(()),
            Err(error) => crate::log::warn(
                "render",
                format!("native still of {}: {error}; using FFmpeg", media.path),
            ),
        }
    }
    let output = Command::new(crate::util::ffmpeg())
        .args(["-hide_banner", "-loglevel", "error", "-y", "-ss"])
        .arg(format!("{time:.3}"))
        .arg("-i")
        .arg(&media.path)
        .args(["-frames:v", "1"])
        .arg(out)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    if !output.status.success() || !out.is_file() {
        return Err(format!(
            "couldn't take the frame: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

/// Scales down so the longest side is at most `max_side` (Accelerate's
/// resampler on the Mac, a box filter elsewhere).
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
    #[cfg(target_os = "macos")]
    if crate::mac_media::scale(
        &image.pixels,
        (image.width, image.height, image.width as usize * 4),
        &mut pixels,
        (w, h),
    )
    .is_ok()
    {
        return RgbaImage {
            width: w,
            height: h,
            pixels,
        };
    }
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
        // Frames are big and short-lived: fast compression is the better trade.
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
        writer
            .write_image_data(&image.pixels)
            .map_err(|error| error.to_string())?;
    }
    Ok(out)
}

/// A picture for a model: JPEG (quality 80) where ImageIO is, else PNG; with its MIME type.
pub fn encode_for_agent(image: &RgbaImage) -> Result<(Vec<u8>, &'static str), String> {
    #[cfg(target_os = "macos")]
    if let Ok(jpeg) = crate::mac_media::encode_image(
        &image.pixels,
        image.width,
        image.height,
        image.width as usize * 4,
        Some(0.8),
    ) {
        return Ok((jpeg, "image/jpeg"));
    }
    Ok((encode_png(image)?, "image/png"))
}

/// MCP content for a picture and its caption (a tool result's `content`).
pub fn image_content(image: &RgbaImage, caption: String) -> Result<Value, String> {
    let (bytes, mime) = encode_for_agent(image)?;
    Ok(json!([
        { "type": "image", "data": base64::engine::general_purpose::STANDARD.encode(bytes), "mimeType": mime },
        { "type": "text", "text": caption }
    ]))
}

/// Contact-sheet cells' longest side: four across makes a ~1.5k px sheet, plenty for a model.
pub const SHEET_CELL: u32 = 360;

// ---------------------------------------------------------------------------
// Export

/// A file removed when dropped: an export's partial file, its sound or
/// chapters beside it.
pub struct ExportFile(pub PathBuf);
impl Drop for ExportFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// A file beside `output` named for what it holds; removed when dropped.
pub fn beside(output: &Path, suffix: &str) -> ExportFile {
    let mut name = output.as_os_str().to_owned();
    name.push(suffix);
    ExportFile(PathBuf::from(name))
}

/// What an export of `project` as `options` ask will cover, checked before
/// anything starts: an empty timeline, an invalid project, a span with no
/// sound for a sound-only format, or settings that can't work (a target size
/// too small for the span) fail here, not mid-render. A span with no sound
/// exports picture only.
pub fn export_plan(project: &Project, options: &ExportOptions) -> Result<Plan, String> {
    if project.duration() <= 0 {
        return Err("the timeline is empty".to_owned());
    }
    project.validate()?;
    let mut plan = crate::export::plan(options, project, true)?;
    if heard_segments(project, plan.start, plan.end).is_empty() {
        if !options.format.has_video() {
            return Err("there's no sound to export in that span".to_owned());
        }
        plan.audio = false;
    }
    crate::export::codec_args(options, &plan, project.fps())?;
    Ok(plan)
}

/// The file an export of project `id` writes beside `output` while it
/// runs: only a complete export replaces `output`, so a failed or cancelled
/// one can't destroy an older file.
pub fn partial_path(output: &Path, id: &str, format: Format) -> PathBuf {
    let mut name = output.as_os_str().to_owned();
    name.push(format!(
        ".{}-{}.partial.{}",
        std::process::id(),
        id,
        format.extension()
    ));
    PathBuf::from(name)
}

/// Removes partial files of this export ([`partial_path`]), and what was
/// beside them, that a server no longer running left beside `output` (killed mid-export: the file can be
/// gigabytes, and a restarted server's has a new name).
fn remove_stale_partials(output: &Path, id: &str, format: Format) {
    let (Some(dir), Some(name)) = (output.parent(), output.file_name()) else {
        return;
    };
    let prefix = format!("{}.", name.to_string_lossy());
    let suffix = format!("-{id}.partial.{}", format.extension());
    let Ok(entries) = std::fs::read_dir(if dir.as_os_str().is_empty() {
        Path::new(".")
    } else {
        dir
    }) else {
        return;
    };
    for entry in entries.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        // The partial file, or what was beside it (its sound, chapters, concat list).
        let Some(pid) = file
            .strip_prefix(&prefix)
            .and_then(|rest| rest.split_once(&suffix))
            .filter(|(_, after)| after.is_empty() || after.starts_with('.'))
            .and_then(|(pid, _)| pid.parse::<i32>().ok())
        else {
            continue;
        };
        // This process exports one thing at a time, so its own is left over too.
        // SAFETY: signal 0 only asks whether the process exists.
        let alive = pid != std::process::id() as i32
            && (unsafe { libc::kill(pid, 0) } == 0
                || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM));
        if !alive {
            crate::log::info(
                "export",
                format!("removing {file}, left by an export cut short"),
            );
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Exports `project` (its media already the files to read: originals, not
/// proxies) to `output` through its partial file ([`partial_path`]), renamed
/// onto `output` once complete. "cancelled" when `cancel` is set.
#[allow(clippy::too_many_arguments)]
pub fn export_file(
    project: &Project,
    options: &ExportOptions,
    plan: &Plan,
    output: &Path,
    cache: &Path,
    sounds: &HashMap<String, PathBuf>,
    cancel: &AtomicBool,
    progress: impl FnMut(f32),
) -> Result<(), String> {
    remove_stale_partials(output, &project.id, options.format);
    let path = partial_path(output, &project.id, options.format);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    let temporary = ExportFile(path);
    let mut progress = progress;
    let settings = native_options(project, options, plan, false)?;
    let mut made = None;
    if let Some(settings) = settings {
        // Tried twice before exporting it whole: the chunks made are kept, so
        // a second try only makes the rest. A sound encoder that stalled once
        // under load (card 1, Oct 29) sent a 93-minute edit to the whole
        // export, hours where the chunks take minutes. The second try copies
        // nothing out of the last export: what it copied may be what was
        // wrong, and copying it again fails the same way (Nov 2, JJ's Mom
        // Secretly v2: both joins had 53141 frames, not 53036, and the whole
        // export after stalled on a Mac out of memory).
        for attempt in 1..=2 {
            match export_chunked(
                project,
                options,
                plan,
                settings,
                &temporary.0,
                cache,
                sounds,
                attempt == 1,
                cancel,
                &mut progress,
            ) {
                Ok(chunks) => {
                    made = Some(chunks);
                    break;
                }
                Err(error) if error == "cancelled" || cancel.load(Ordering::Acquire) => {
                    return Err("cancelled".to_owned())
                }
                Err(error) if attempt == 1 => crate::log::warn(
                    "export",
                    format!("a chunked export failed ({error}); trying the chunks again, rendering what it had copied from the last export"),
                ),
                Err(error) => crate::log::warn(
                    "export",
                    format!("a chunked export failed again ({error}); exporting it whole"),
                ),
            }
        }
    }
    if made.is_none() {
        // The native encoder first; when it fails (stalled on a Mac out of
        // memory: JJ's, Nov 2, after 16 minutes), once more with FFmpeg's.
        let whole = |native: bool, progress: &mut dyn FnMut(f32)| {
            export_with(
                project,
                options,
                plan,
                &temporary.0,
                cache,
                sounds,
                native,
                cancel,
                progress,
            )
        };
        match whole(true, &mut progress) {
            Err(error)
                if error != "cancelled"
                    && !cancel.load(Ordering::Acquire)
                    && is_native_encoder_error(&error) =>
            {
                crate::log::warn(
                    "export",
                    format!("the whole export failed ({error}); exporting it again with FFmpeg's encoder"),
                );
                whole(false, &mut progress)?;
            }
            other => other?,
        }
    }
    if cancel.load(Ordering::Acquire) {
        return Err("cancelled".to_owned());
    }
    std::fs::rename(&temporary.0, output).map_err(|error| error.to_string())?;
    if let Some((chunks, sound)) = made {
        let dir = crate::chunks::folder(cache, &project.id);
        // Its chunks are in the file now, which the next export copies them out of.
        crate::chunks::tidy(&dir, &[], options.format.extension());
        if let Err(error) =
            crate::chunks::Manifest::save(&dir, output, project.fps(), &chunks, sound)
        {
            crate::log::warn(
                "export",
                format!("couldn't remember the export's chunks: {error}"),
            );
        }
    }
    Ok(())
}

/// Exports `project` to `output` in chunks (`chunks.rs`): the chunks that are
/// in the last export (or left by a run that stopped) are copied, the rest
/// rendered, and the sound mixed again only when something heard changed.
/// Says which chunks the file is made of and the sound's key.
#[allow(clippy::too_many_arguments)]
fn export_chunked(
    project: &Project,
    options: &ExportOptions,
    plan: &Plan,
    settings: WriterOptions,
    output: &Path,
    cache: &Path,
    sounds: &HashMap<String, PathBuf>,
    reuse_last: bool,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<(Vec<crate::chunks::Chunk>, Option<String>), String> {
    use crate::chunks::{self, Piece};
    let _first = crate::media::foreground();
    let fps = project.fps();
    let seconds = plan.seconds(fps);
    let extension = options.format.extension();
    let dir = chunks::folder(cache, &project.id);
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let key = format!(
        "{:?}|{}x{}|{}|{}|{}",
        options.format, plan.width, plan.height, settings.bitrate, settings.key_interval, fps
    );
    let list = crate::log::time_on("export", "export: chunks", &project.id, || {
        Ok::<_, String>(chunks::split(project, plan, &key))
    })?;
    let last = chunks::Manifest::load(&dir, fps).filter(|_| reuse_last);
    let mut pieces = Vec::new();
    let mut todo = Vec::new();
    let mut copied = 0;
    for chunk in &list {
        let file = chunks::made(&dir, &chunk.key, extension);
        if file.exists() {
            copied += chunk.frames();
            pieces.push((Piece::File(file), chunk.frames()));
            continue;
        }
        if let Some((last, saved)) = last.as_ref().and_then(|last| {
            last.find(&chunk.key)
                .filter(|saved| saved.frames == chunk.frames())
                .map(|saved| (last, saved))
        }) {
            copied += chunk.frames();
            pieces.push((
                Piece::Old {
                    file: last.output.clone(),
                    at: saved.at,
                },
                chunk.frames(),
            ));
            continue;
        }
        todo.push(chunk);
        pieces.push((Piece::File(file), chunk.frames()));
    }
    // Chunks of other exports, and any cut short, go.
    chunks::tidy(&dir, &list.iter().collect::<Vec<_>>(), extension);
    // What's to come, for smooth playback to serve each chunk as it lands.
    chunks::write_plan(&dir, &list, extension)?;
    // Smooth playback's from the viewer's playhead on, then what's before it.
    if let Some(focus) = plan.focus {
        todo.sort_by_key(|chunk| chunks::focus_order(chunk, focus));
    }
    let parts = if plan.audio {
        crate::mix::parts(
            &heard_segments(project, plan.start, plan.end),
            |media| sound_path(project, sounds, media),
            plan.start as f64 / fps,
            seconds,
        )
    } else {
        Vec::new()
    };
    let sound_key = (!parts.is_empty()).then(|| sound_key(options, &parts, seconds));
    let old_sound = last
        .as_ref()
        .filter(|last| sound_key.is_some() && last.sound == sound_key)
        .map(|last| last.output.clone());
    crate::log::info(
        "export",
        format!(
            "export: {} of {} chunks ({} of {} frames) already made; the sound {}",
            list.len() - todo.len(),
            list.len(),
            copied,
            plan.end - plan.start,
            match (&sound_key, &old_sound) {
                (None, _) => "isn't needed",
                (Some(_), Some(_)) => "is the last export's",
                (Some(_), None) => "is mixed again",
            }
        ),
    );
    let rendering = todo.iter().map(|chunk| chunk.frames()).sum::<i64>() as f32;
    let total = (plan.end - plan.start).max(1) as f32;
    let sound_share = if sound_key.is_some() && old_sound.is_none() {
        0.05
    } else {
        0.0
    };
    let picture_share = (1.0 - sound_share) * (rendering / total);
    let sound_file = beside(output, ".sound.m4a");
    let mixing = sound_key.is_some() && old_sound.is_none();
    // Focused (smooth playback, played as each chunk lands): the chunks
    // around the first minute from the playhead are rendered before the
    // sound's mix, the rest after it. The mix first held a 26-minute edit's
    // first chunk back 2 minutes (Nov 2); never beside the picture's
    // decoders, where AVFoundation's sound reads and theirs contend.
    let (first, rest): (Vec<&chunks::Chunk>, Vec<&chunks::Chunk>) = match plan.focus {
        Some(_) if mixing => {
            let mut frames = 0;
            let ahead = (fps * FOCUS_AHEAD_SECONDS).round() as i64;
            todo.iter().partition(|chunk| {
                let take = frames < ahead;
                frames += chunk.frames();
                take
            })
        }
        _ => (Vec::new(), todo.clone()),
    };
    let rendered = (first.iter().map(|chunk| chunk.frames()).sum::<i64>() as f32
        / rendering.max(1.0))
        * picture_share;
    let render_these = |these: &[&chunks::Chunk],
                        from: f32,
                        share: f32,
                        progress: &mut dyn FnMut(f32)|
     -> Result<(), String> {
        if these.is_empty() {
            return Ok(());
        }
        let ranges: Vec<(i64, i64)> = these.iter().map(|chunk| (chunk.start, chunk.end)).collect();
        let sink = Sink::Chunks(ChunkSink {
            todo: these
                .iter()
                .map(|chunk| {
                    (
                        chunk.start,
                        chunk.end,
                        chunks::made(&dir, &chunk.key, extension),
                    )
                })
                .collect(),
            open: None,
            size: (plan.width, plan.height),
            fps,
            settings: WriterOptions {
                faststart: false,
                ..settings
            },
        });
        crate::log::time_on("export", "export: native video", &project.id, || {
            render_frames(project, &ranges, sink, cache, cancel, &mut |done| {
                progress(from + done * share)
            })
        })
    };
    render_these(&first, 0.0, rendered, &mut *progress)?;
    if mixing {
        mix_sound(
            project,
            options,
            &parts,
            seconds,
            &sound_file.0,
            Some(&dir.join("sound")),
            cancel,
            &mut |done| progress(rendered + done * sound_share),
        )?;
    }
    render_these(
        &rest,
        rendered + sound_share,
        picture_share - rendered,
        &mut *progress,
    )?;
    if cancel.load(Ordering::Acquire) {
        return Err("cancelled".to_owned());
    }
    // Chunks joined without re-encoding need one codec setup.
    let mut setups = HashSet::new();
    for (piece, _) in &pieces {
        let file: &Path = match piece {
            Piece::File(path) => path,
            Piece::Old { file, .. } => file,
        };
        setups.insert(chunks::setup_hash(file)?);
        if setups.len() > 1 {
            return Err("chunks were encoded with different settings".to_owned());
        }
    }
    let old = match &last {
        Some(last)
            if pieces
                .iter()
                .any(|(piece, _)| matches!(piece, Piece::Old { .. })) =>
        {
            chunks::old_file(&last.output)?
        }
        _ => chunks::OldFile::default(),
    };
    let chapters = crate::export::chapters_file(options, plan, fps)
        .map(|text| -> Result<ExportFile, String> {
            let file = beside(output, ".chapters.txt");
            std::fs::write(&file.0, text).map_err(|error| error.to_string())?;
            Ok(file)
        })
        .transpose()?;
    let concat = beside(output, ".chunks.txt");
    std::fs::write(&concat.0, chunks::concat_list(&pieces, fps, &old)?)
        .map_err(|error| error.to_string())?;
    let sound = match (&sound_key, &old_sound) {
        (None, _) => None,
        (Some(_), Some(old)) => Some(old.as_path()),
        (Some(_), None) => Some(sound_file.0.as_path()),
    };
    crate::log::time_on("export", "export: join", &project.id, || {
        join_chunks(
            options,
            &concat.0,
            sound,
            chapters.as_ref().map(|file| file.0.as_path()),
            output,
        )
    })?;
    let frames = chunks::frames_in(output)?;
    if frames != plan.end - plan.start {
        return Err(format!(
            "the joined export has {frames} frames, not {}",
            plan.end - plan.start
        ));
    }
    progress(1.0);
    Ok((list, sound_key))
}

/// Joins the chunks in the concat list `list`, the sound (its first sound
/// stream: a mix or the last export) and chapters into `output`.
fn join_chunks(
    options: &ExportOptions,
    list: &Path,
    sound: Option<&Path>,
    chapters: Option<&Path>,
    output: &Path,
) -> Result<(), String> {
    let mut command = Command::new(crate::util::ffmpeg());
    command
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
        ])
        .arg(list);
    let mut inputs = 1;
    if let Some(sound) = sound {
        command.arg("-i").arg(sound);
        inputs += 1;
    }
    if let Some(chapters) = chapters {
        command.args(["-f", "ffmetadata", "-i"]).arg(chapters);
    }
    command.args(["-map", "0:v:0"]);
    if sound.is_some() {
        command.args(["-map", "1:a:0"]);
    }
    // The chapters file's metadata, not none: `-map_metadata -1` also drops
    // the chapters' titles, so every chapter came out unnamed (Oct 31). The
    // file holds no tags of its own, so the export still carries none.
    if chapters.is_some() {
        command.args([
            "-map_chapters",
            &inputs.to_string(),
            "-map_metadata",
            &inputs.to_string(),
        ]);
    } else {
        command.args(["-map_chapters", "-1", "-map_metadata", "-1"]);
    }
    command.args(["-c", "copy"]);
    if options.format == Format::Hevc {
        command.args(["-tag:v", "hvc1"]);
    }
    let result = command
        .args(["-movflags", "+faststart", "-f", "mp4"])
        .arg(output)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("joining the chunks failed")
            .trim()
            .to_owned());
    }
    Ok(())
}

/// Audio that's heard (unmuted, from media with sound) and overlaps frames `[start, end)`.
pub fn heard_segments(project: &Project, start: i64, end: i64) -> Vec<AudioSegment> {
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

/// Exports `project` to `output` (written as it goes: see [`export_file`]).
pub fn export(
    project: &Project,
    options: &ExportOptions,
    plan: &Plan,
    output: &Path,
    cache: &Path,
    cancel: &AtomicBool,
    progress: impl FnMut(f32),
) -> Result<(), String> {
    export_with(
        project,
        options,
        plan,
        output,
        cache,
        &HashMap::new(),
        true,
        cancel,
        progress,
    )
}

/// The file each heard media's sound is mixed from: its copy in `sounds`, else its own.
fn sound_path(
    project: &Project,
    sounds: &HashMap<String, PathBuf>,
    media: &str,
) -> Option<PathBuf> {
    sounds
        .get(media)
        .cloned()
        .or_else(|| project.media(media).map(|media| PathBuf::from(&media.path)))
}

/// [`export`], mixing from `sounds` where given; the picture through the
/// native encoder when `native` and it suits, else FFmpeg's.
#[allow(clippy::too_many_arguments)]
fn export_with(
    project: &Project,
    options: &ExportOptions,
    plan: &Plan,
    output: &Path,
    cache: &Path,
    sounds: &HashMap<String, PathBuf>,
    native: bool,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f32),
) -> Result<(), String> {
    // Background previews wait until it's done.
    let _first = crate::media::foreground();
    let fps = project.fps();
    let seconds = plan.seconds(fps);
    let video = options.format.has_video();
    let chapters = crate::export::chapters_file(options, plan, fps)
        .map(|text| -> Result<ExportFile, String> {
            let file = beside(output, ".chapters.txt");
            std::fs::write(&file.0, text).map_err(|error| error.to_string())?;
            Ok(file)
        })
        .transpose()?;
    let parts = if plan.audio {
        crate::mix::parts(
            &heard_segments(project, plan.start, plan.end),
            |media| sound_path(project, sounds, media),
            plan.start as f64 / fps,
            seconds,
        )
    } else {
        Vec::new()
    };
    let sound = !parts.is_empty();
    // What's put together at the end, if anything: the sound and chapters
    // join the picture without re-encoding it.
    let joined = video && (sound || chapters.is_some());
    let sound_file = (video && sound).then(|| {
        beside(
            output,
            if options.format == Format::Prores {
                ".sound.wav"
            } else {
                ".sound.m4a"
            },
        )
    });
    let picture_file =
        joined.then(|| beside(output, &format!(".picture.{}", options.format.extension())));
    // The sound first, then the picture. Mixing beside the picture's decoders
    // made both slower (AVFoundation's readers contend): a 2-minute edit's
    // 126 sounds mix in ~1.3 s alone but took ~45 s alongside its video.
    // The sound's share of the progress is its share of the time, roughly.
    let share = if video { 0.05 } else { 1.0 };
    if sound {
        let destination = sound_file.as_ref().map_or(output, |file| file.0.as_path());
        mix_sound(
            project,
            options,
            &parts,
            seconds,
            destination,
            None,
            cancel,
            &mut |done| progress(done * share),
        )?;
    }
    let before = if sound { share } else { 0.0 };
    if video {
        let destination = picture_file
            .as_ref()
            .map_or(output, |file| file.0.as_path());
        render_picture(
            project,
            options,
            plan,
            destination,
            !joined,
            native,
            cache,
            cancel,
            &mut |done| progress(before + done * (1.0 - before)),
        )?;
    }
    if cancel.load(Ordering::Acquire) {
        return Err("cancelled".to_owned());
    }
    if let Some(picture_file) = &picture_file {
        crate::log::time_on("export", "export: join", &project.id, || {
            join(
                options,
                &picture_file.0,
                sound_file.as_ref().map(|file| file.0.as_path()),
                chapters.as_ref().map(|file| file.0.as_path()),
                output,
            )
        })?;
    }
    Ok(())
}

/// Mixes `parts` (`seconds` long) into `destination`: the file itself for a
/// sound format, else the sound a join copies in.
/// `blocks`: where a chunked export keeps its sound a minute at a time
/// (`mix::render_kept`): smooth playback's renders (background exports)
/// only, whose sound nothing measures for loudness; a real export's sound is
/// mixed and encoded whole, as before.
#[allow(clippy::too_many_arguments)]
fn mix_sound(
    project: &Project,
    options: &ExportOptions,
    parts: &[crate::mix::Part],
    seconds: f64,
    destination: &Path,
    blocks: Option<&Path>,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<(), String> {
    let video = options.format.has_video();
    let scratch = beside(destination, ".mix.f32");
    let codec = crate::export::audio_args(options);
    let encoding = crate::mix::Encoding {
        codec: &codec,
        // MP4's AAC goes into an .m4a that the join copies.
        aac: (video && matches!(options.format, Format::H264 | Format::Hevc))
            .then(|| options.sound_bitrate()),
    };
    // Written beside it, then renamed into place whole: smooth playback plays
    // the mix the moment it's there, and it was there half-written (Nov 2).
    // (Its own extension kept: a WAV or MP3 export's mix is its file.)
    let extension = destination.extension().map_or_else(
        || "m4a".to_owned(),
        |ext| ext.to_string_lossy().into_owned(),
    );
    let mixing = beside(destination, &format!(".mixing.{extension}"));
    crate::log::time_on("export", "export: sound", &project.id, || {
        crate::util::killed_on_cancel(cancel, || {
            let total = (seconds * crate::mix::RATE as f64).round() as usize;
            match (blocks, options.target_loudness(), encoding.aac) {
                (Some(blocks), None, Some(bitrate)) if crate::media::is_background() => {
                    crate::mix::render_kept(
                        parts, total, bitrate, &mixing.0, blocks, cancel, progress,
                    )
                }
                (_, loudness, _) => crate::mix::render(
                    parts, total, loudness, &encoding, &mixing.0, &scratch.0, cancel, progress,
                ),
            }
        })
    })?;
    std::fs::rename(&mixing.0, destination).map_err(|error| format!("the sound's mix: {error}"))
}

/// What a mix of `parts` sounds like, as a key: the parts (their files by
/// content), the loudness and the codec. The same key is the same sound.
pub fn sound_key(options: &ExportOptions, parts: &[crate::mix::Part], seconds: f64) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    "sound-v2".hash(&mut hasher);
    env!("EDIT_SOUND_SOURCE").hash(&mut hasher);
    format!("{parts:?}").hash(&mut hasher);
    for part in parts {
        crate::chunks::content_key(&part.path).hash(&mut hasher);
    }
    format!("{:?}", options.target_loudness()).hash(&mut hasher);
    crate::export::audio_args(options).hash(&mut hasher);
    options.sound_bitrate().hash(&mut hasher);
    seconds.to_bits().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Puts the picture, sound and chapters into `output` without re-encoding.
fn join(
    options: &ExportOptions,
    picture: &Path,
    sound: Option<&Path>,
    chapters: Option<&Path>,
    output: &Path,
) -> Result<(), String> {
    let mut command = Command::new(crate::util::ffmpeg());
    command
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(picture);
    let mut inputs = 1;
    if let Some(sound) = sound {
        command.arg("-i").arg(sound);
        inputs += 1;
    }
    if let Some(chapters) = chapters {
        command.args(["-f", "ffmetadata", "-i"]).arg(chapters);
    }
    command.args(["-map", "0:v:0"]);
    if sound.is_some() {
        command.args(["-map", "1:a:0"]);
    }
    if chapters.is_some() {
        command.args(["-map_chapters", &inputs.to_string()]);
    }
    command.args(["-c", "copy"]);
    if options.format == Format::Hevc {
        command.args(["-tag:v", "hvc1"]);
    }
    if matches!(options.format, Format::H264 | Format::Hevc) {
        command.args(["-movflags", "+faststart"]);
    }
    let result = command
        .arg(output)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("joining the picture and sound failed")
            .trim()
            .to_owned());
    }
    Ok(())
}

/// Renders the picture to `output`: AVFoundation's hardware encoder for the
/// standard Mac shapes, FFmpeg otherwise. `alone` means nothing is joined to
/// it afterwards (so it gets its index at the front itself).
#[allow(clippy::too_many_arguments)]
fn render_picture(
    project: &Project,
    options: &ExportOptions,
    plan: &Plan,
    output: &Path,
    alone: bool,
    native: bool,
    cache: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    let _ = native;
    #[cfg(target_os = "macos")]
    if let Some(writer) = native
        .then(|| native_writer(project, options, plan, output, alone))
        .transpose()?
        .flatten()
    {
        return crate::log::time_on("export", "export: native video", &project.id, || {
            render_frames(
                project,
                &[(plan.start, plan.end)],
                Sink::Native {
                    writer,
                    first: plan.start,
                },
                cache,
                cancel,
                progress,
            )
        });
    }
    let settings = project.settings;
    let (width, height) = (settings.width, settings.height);
    let mut command = Command::new(crate::util::ffmpeg());
    command
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-filter_complex_threads",
            "2",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-s",
            &format!("{width}x{height}"),
            "-framerate",
            &if settings.ntsc {
                format!("{}/1001", settings.fps * 1000)
            } else {
                settings.fps.to_string()
            },
            "-i",
            "pipe:0",
            "-filter_complex",
            &crate::export::video_graph(options, (width, height), (plan.width, plan.height)),
            "-map",
            "[vout]",
        ])
        .args(crate::export::video_args(options, plan, project.fps())?);
    if alone && matches!(options.format, Format::H264 | Format::Hevc) {
        command.args(["-movflags", "+faststart"]);
    }
    command
        .args(["-threads", "2"])
        .arg(output)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut encoder = command
        .spawn()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    let stdin = encoder.stdin.take().ok_or("ffmpeg stdin")?;
    let stderr = encoder.stderr.take();
    let stderr_thread = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });
    let sink = Sink::Pipe {
        stdin: BufWriter::with_capacity(1 << 20, stdin),
        width,
        height,
    };
    let result = crate::log::time_on("export", "export: video", &project.id, || {
        render_frames(
            project,
            &[(plan.start, plan.end)],
            sink,
            cache,
            cancel,
            progress,
        )
    });
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

/// The standard Mac video path encodes with AVFoundation; the compositor
/// remains shared with the browser. Nonstandard shapes/rates and
/// software-quality exports keep the compatibility encoder (None).
fn native_options(
    project: &Project,
    options: &ExportOptions,
    plan: &Plan,
    alone: bool,
) -> Result<Option<WriterOptions>, String> {
    if !options.hardware
        || std::env::var_os("EDIT_FFMPEG_VIDEO").is_some()
        || !matches!(options.format, Format::H264 | Format::Hevc)
        || options.shape != crate::export::Shape::Original
        || (plan.width, plan.height) != (project.settings.width, project.settings.height)
        || options
            .fps
            .is_some_and(|fps| fps > 0 && fps != project.settings.fps)
    {
        return Ok(None);
    }
    // Off a Mac the chunks are FFmpeg's (`pipe_writer`): HEVC needs NVENC or libx265.
    let encoders = crate::export::encoders();
    if !cfg!(target_os = "macos")
        && options.format == Format::Hevc
        && !(encoders.nvenc || encoders.hevc)
    {
        return Ok(None);
    }
    Ok(Some(WriterOptions {
        hevc: options.format == Format::Hevc,
        bitrate: crate::export::video_bitrate(options, plan, project.fps())?,
        key_interval: options.key_interval(f64::from(project.settings.fps)),
        finished: true,
        faststart: alone,
    }))
}

/// An error of the native (AVFoundation) encoder, which FFmpeg's may not
/// have: stalled, a frame rejected, a buffer it couldn't give.
fn is_native_encoder_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("native encoder")
        || lower.contains("encoder pixel buffer")
        || lower.contains("the encoder stopped early")
}

#[cfg(target_os = "macos")]
fn native_writer(
    project: &Project,
    options: &ExportOptions,
    plan: &Plan,
    output: &Path,
    alone: bool,
) -> Result<Option<crate::mac_media::Writer>, String> {
    let Some(settings) = native_options(project, options, plan, alone)? else {
        return Ok(None);
    };
    match crate::mac_media::Writer::open(output, plan.width, plan.height, project.fps(), settings) {
        Ok(writer) => Ok(Some(writer)),
        Err(error) => {
            crate::log::warn(
                "export",
                format!("native encoder unavailable: {error}; using FFmpeg"),
            );
            Ok(None)
        }
    }
}

/// Writes each chunk of a chunked export to its own file: `<key>.partial.mp4`
/// while it's being written, renamed to `<key>.mp4` once whole.
struct ChunkSink {
    /// Frames `[start, end)` and the file, in the order they're rendered.
    todo: VecDeque<(i64, i64, PathBuf)>,
    /// The chunk being written: its frames, file, writer and frames written.
    open: Option<(i64, i64, PathBuf, ChunkWriter, i64)>,
    size: (u32, u32),
    fps: f64,
    settings: WriterOptions,
}

impl ChunkSink {
    fn partial(path: &Path) -> PathBuf {
        path.with_extension("partial.mp4")
    }

    fn write(&mut self, frame: i64, pixels: &[u8], stride: usize) -> Result<(), String> {
        // A frame outside the open chunk is the next chunk's: after it, or
        // before it in a focused export (the playhead's chunks first, then
        // those before: Nov 2, the last chunk took frame 0 into its encoder
        // and failed, "Native encoder: The operation could not be completed").
        if self
            .open
            .as_ref()
            .is_some_and(|open| frame >= open.1 || frame < open.0)
        {
            self.close()?;
        }
        if self.open.is_none() {
            let (start, end, path) = self
                .todo
                .pop_front()
                .ok_or("a frame came after the last chunk")?;
            if frame != start {
                return Err("a chunk's frames came out of order".to_owned());
            }
            let writer = ChunkWriter::open(
                &Self::partial(&path),
                self.size.0,
                self.size.1,
                self.fps,
                self.settings,
            )?;
            self.open = Some((start, end, path, writer, 0));
        }
        let Some((start, _, _, writer, written)) = self.open.as_mut() else {
            return Err("no chunk is open".to_owned());
        };
        writer.frame(frame - *start, pixels, stride, Order::Rgba)?;
        *written += 1;
        Ok(())
    }

    /// Finishes the open chunk; one cut short is removed, never kept.
    fn close(&mut self) -> Result<(), String> {
        let Some((start, end, path, mut writer, written)) = self.open.take() else {
            return Ok(());
        };
        let partial = Self::partial(&path);
        if written != end - start {
            drop(writer);
            let _ = std::fs::remove_file(&partial);
            return Err("the export stopped part-way through a chunk".to_owned());
        }
        writer.finish(written)?;
        std::fs::rename(&partial, &path).map_err(|error| error.to_string())
    }

    fn finish(mut self) -> Result<(), String> {
        self.close()?;
        if self.todo.is_empty() {
            Ok(())
        } else {
            Err("the export stopped before every chunk was made".to_owned())
        }
    }
}

/// Where rendered frames go (on the encoder thread).
enum Sink {
    /// Frames from `first` on into one file.
    #[cfg(target_os = "macos")]
    Native {
        writer: crate::mac_media::Writer,
        first: i64,
    },
    /// Each chunk into its own file (`chunks.rs`).
    Chunks(ChunkSink),
    Pipe {
        stdin: BufWriter<ChildStdin>,
        width: u32,
        height: u32,
    },
}

impl Sink {
    /// Timeline frame `frame` (RGBA, rows `stride` bytes apart).
    fn write(&mut self, _frame: i64, pixels: &[u8], stride: usize) -> Result<(), String> {
        match self {
            #[cfg(target_os = "macos")]
            Sink::Native { writer, first } => {
                writer.frame(_frame - *first, pixels, stride, Order::Rgba)
            }
            Sink::Chunks(chunks) => chunks.write(_frame, pixels, stride),
            Sink::Pipe {
                stdin,
                width,
                height,
            } => {
                let row = *width as usize * 4;
                for line in pixels.chunks(stride).take(*height as usize) {
                    stdin
                        .write_all(line.get(..row).ok_or("GPU readback came back short")?)
                        .map_err(|_| "the encoder stopped early".to_owned())?;
                }
                Ok(())
            }
        }
    }

    fn finish(self, _frames: i64) -> Result<(), String> {
        match self {
            #[cfg(target_os = "macos")]
            Sink::Native { mut writer, .. } => writer.finish(_frames),
            Sink::Chunks(chunks) => chunks.finish(),
            Sink::Pipe { mut stdin, .. } => stdin
                .flush()
                .map_err(|_| "the encoder stopped early".to_owned()),
        }
    }
}

/// Decoder threads per export: one plays the current clip while the others
/// open and seek the next ones.
const DECODERS: usize = 3;
/// A focused export renders this much from the playhead before the sound's mix (seconds).
const FOCUS_AHEAD_SECONDS: f64 = 60.0;
/// Frames the planner (and so the decoders) may run ahead of the compositor.
const LOOKAHEAD: usize = 48;
/// Readback buffers in flight between the compositor and the encoder.
const READBACKS: usize = 3;
/// How far ahead (source seconds) a reader decodes forward rather than seeks
/// (the native reader's own limit).
const FORWARD: f64 = 2.0;

/// How the compositor gets a video layer's picture.
enum Decode {
    /// From decoder thread n (which was sent the job).
    Worker(usize),
    /// On the compositor's own thread (more clips overlap than there are decoders).
    Inline(Source, f64),
    Missing(String),
}

/// A frame the planner evaluated, and where its pictures come from.
struct Planned {
    frame: i64,
    scene: Scene,
    decodes: Vec<(String, Decode)>,
}

struct DecodeJob {
    frame: i64,
    clip: String,
    source: Source,
    time: f64,
    /// The first frame of the clip's run (always copied, never "unchanged").
    first: bool,
}

struct Decoded {
    frame: i64,
    clip: String,
    width: u32,
    height: u32,
    order: Order,
    /// None: the same picture as this clip's last.
    pixels: Option<Vec<u8>>,
}

/// One decoder thread: decodes its jobs in order, recycling pixel buffers.
/// It keeps one reader open (each holds a hardware decoder and its buffers):
/// a clip in the same file carries on with it (the planner sends jump cuts to
/// the decoder already in that file), any other opens a new one.
fn decoder(
    jobs: mpsc::Receiver<DecodeJob>,
    out: mpsc::SyncSender<Result<Decoded, String>>,
    recycle: mpsc::Receiver<Vec<u8>>,
) {
    let mut current: Option<(String, VideoReader)> = None;
    let mut spare: Vec<Vec<u8>> = Vec::new();
    for job in jobs {
        if job.first || current.as_ref().is_none_or(|(clip, _)| *clip != job.clip) {
            let reader = match current.take() {
                Some((_, reader)) if reader.source.key == job.source.key => reader,
                _ => VideoReader::open(job.source.clone()),
            };
            current = Some((job.clip.clone(), reader));
        }
        let Some((_, reader)) = current.as_mut() else {
            break;
        };
        let mut buffer = spare
            .pop()
            .or_else(|| recycle.try_recv().ok())
            .unwrap_or_default();
        buffer.resize(job.source.bytes(), 0);
        let result = reader
            .frame_into(job.time, &mut buffer, !job.first)
            .map(|changed| {
                let pixels = if changed {
                    Some(buffer)
                } else {
                    spare.push(buffer);
                    None
                };
                Decoded {
                    frame: job.frame,
                    clip: job.clip,
                    width: job.source.key.width,
                    height: job.source.key.height,
                    order: job.source.key.order,
                    pixels,
                }
            });
        let failed = result.is_err();
        if out.send(result).is_err() || failed {
            break;
        }
    }
}

/// The planner: evaluates each frame, gives each clip's run to a free decoder
/// (the one idle longest, so it can get ahead), and passes the frame on.
fn planner(
    project: &Project,
    ranges: &[(i64, i64)],
    jobs: Vec<mpsc::Sender<DecodeJob>>,
    planned: mpsc::SyncSender<Planned>,
    cancel: &AtomicBool,
) {
    let (width, height) = (project.settings.width, project.settings.height);
    let mut sources: HashMap<String, Source> = HashMap::new();
    let mut assigned: HashMap<String, Option<usize>> = HashMap::new();
    // Each decoder's current clip, and the frame its last run ended on.
    let mut decoders: Vec<(Option<String>, i64)> = vec![(None, i64::MIN); jobs.len()];
    // Where each decoder's reader was left: file and source seconds.
    let mut left: Vec<Option<(PathBuf, f64)>> = vec![None; jobs.len()];
    for frame in ranges.iter().flat_map(|&(from, to)| from..to) {
        if cancel.load(Ordering::Acquire) {
            break;
        }
        let scene = evaluate_seen(project, frame);
        let mut decodes = Vec::new();
        let present: HashSet<&String> = scene
            .layers
            .iter()
            .filter_map(|layer| match layer {
                Layer::Video { clip, .. } => Some(clip),
                _ => None,
            })
            .collect();
        // A clip that's gone has finished its run: its decoder is free for
        // the clips starting on this frame.
        for (busy, ended) in &mut decoders {
            if busy.as_ref().is_some_and(|clip| !present.contains(clip)) {
                *busy = None;
                *ended = frame;
            }
        }
        assigned.retain(|clip, _| present.contains(clip));
        for layer in &scene.layers {
            let Layer::Video {
                clip,
                media,
                source_time,
                ..
            } = layer
            else {
                continue;
            };
            let source = match sources.get(media) {
                Some(source) => source.clone(),
                None => match project.media(media) {
                    Some(found) => {
                        let source = Source::new(
                            found,
                            PathBuf::from(&found.path),
                            decode_size(found, width, height),
                            Order::Bgra,
                        );
                        sources.insert(media.clone(), source.clone());
                        source
                    }
                    None => {
                        decodes.push((
                            clip.clone(),
                            Decode::Missing(format!("unknown media {media}")),
                        ));
                        continue;
                    }
                },
            };
            let (worker, first) = match assigned.get(clip) {
                Some(Some(worker)) => (Some(*worker), false),
                // Decoded inline (none was free), or new: a free decoder takes it.
                _ => {
                    // A jump cut forward in the file a free decoder just read
                    // continues there (decoding the gap costs less than a
                    // seek); otherwise the decoder idle longest gets ahead.
                    let continues = |index: usize| {
                        left.get(index)
                            .and_then(Option::as_ref)
                            .is_some_and(|(path, at)| {
                                *path == source.key.path
                                    && *source_time >= *at
                                    && *source_time - *at <= FORWARD
                            })
                    };
                    let free = decoders
                        .iter()
                        .enumerate()
                        .filter(|(_, (busy, _))| busy.is_none())
                        .min_by_key(|(index, (_, ended))| (!continues(*index), *ended))
                        .map(|(index, _)| index);
                    if let Some((busy, _)) = free.and_then(|index| decoders.get_mut(index)) {
                        *busy = Some(clip.clone());
                    }
                    assigned.insert(clip.clone(), free);
                    (free, true)
                }
            };
            let sent = worker
                .and_then(|index| jobs.get(index))
                .is_some_and(|jobs| {
                    jobs.send(DecodeJob {
                        frame,
                        clip: clip.clone(),
                        source: source.clone(),
                        time: *source_time,
                        first,
                    })
                    .is_ok()
                });
            if let Some(at) = worker
                .filter(|_| sent)
                .and_then(|index| left.get_mut(index))
            {
                *at = Some((source.key.path.clone(), *source_time));
            }
            decodes.push((
                clip.clone(),
                match worker {
                    Some(index) if sent => Decode::Worker(index),
                    _ => Decode::Inline(source, *source_time),
                },
            ));
        }
        if planned
            .send(Planned {
                frame,
                scene,
                decodes,
            })
            .is_err()
        {
            break;
        }
    }
}

/// A frame read back for the encoder: the buffer it's in and when it's ready.
struct Readback {
    /// The timeline frame.
    frame: i64,
    slot: usize,
    submission: wgpu::SubmissionIndex,
    mapped: mpsc::Receiver<Result<(), wgpu::BufferAsyncError>>,
}

/// Renders the frames of `ranges` (timeline frames `[from, to)`, in order)
/// into `sink`, finishing it.
fn render_frames(
    project: &Project,
    ranges: &[(i64, i64)],
    sink: Sink,
    cache: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<(), String> {
    crate::util::killed_on_cancel(cancel, || {
        render_frames_watched(project, ranges, sink, cache, cancel, progress)
    })
}

fn render_frames_watched(
    project: &Project,
    ranges: &[(i64, i64)],
    mut sink: Sink,
    cache: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<(), String> {
    let (width, height) = (project.settings.width, project.settings.height);
    let mut renderer = new_renderer(width, height)?;
    let device = renderer.device().clone();
    let row = renderer.output_row_bytes() as usize;
    let buffers: Vec<wgpu::Buffer> = (0..READBACKS).map(|_| renderer.output_buffer()).collect();
    let total = ranges
        .iter()
        .map(|(from, to)| to - from)
        .sum::<i64>()
        .max(1);
    std::thread::scope(|scope| {
        let (planned_tx, planned) = mpsc::sync_channel::<Planned>(LOOKAHEAD);
        let mut job_senders = Vec::new();
        let mut outputs = Vec::new();
        let mut recyclers = Vec::new();
        for _ in 0..DECODERS {
            let (job_tx, job_rx) = mpsc::channel::<DecodeJob>();
            let (out_tx, out_rx) = mpsc::sync_channel(2);
            let (recycle_tx, recycle_rx) = mpsc::channel::<Vec<u8>>();
            let decoders = crate::util::decoders();
            scope.spawn(move || {
                crate::util::with_decoders(decoders, || decoder(job_rx, out_tx, recycle_rx))
            });
            job_senders.push(job_tx);
            outputs.push(out_rx);
            recyclers.push(recycle_tx);
        }
        scope.spawn(move || planner(project, ranges, job_senders, planned_tx, cancel));
        let (free_tx, free) = mpsc::sync_channel::<usize>(READBACKS);
        for slot in 0..READBACKS {
            let _ = free_tx.send(slot);
        }
        let (readback_tx, readbacks) = mpsc::sync_channel::<Readback>(READBACKS);
        let buffers = &buffers;
        let encoder = scope.spawn(move || -> Result<(), String> {
            let mut written = 0;
            for readback in readbacks {
                let buffer = buffers.get(readback.slot).ok_or("no readback buffer")?;
                let mapped = readback.mapped;
                loop {
                    match mapped.try_recv() {
                        Ok(result) => {
                            result.map_err(|error| format!("GPU readback failed: {error}"))?;
                            break;
                        }
                        Err(mpsc::TryRecvError::Empty) => {
                            let _ = device.poll(wgpu::PollType::Wait {
                                submission_index: Some(readback.submission.clone()),
                                timeout: Some(Duration::from_secs(1)),
                            });
                        }
                        Err(mpsc::TryRecvError::Disconnected) => {
                            return Err("GPU readback was dropped".to_owned())
                        }
                    }
                }
                let view = buffer
                    .slice(..)
                    .get_mapped_range()
                    .map_err(|error| format!("GPU readback failed: {error}"))?;
                let wrote = sink.write(readback.frame, &view, row);
                drop(view);
                buffer.unmap();
                wrote?;
                written += 1;
                if free_tx.send(readback.slot).is_err() {
                    break;
                }
            }
            sink.finish(written)
        });
        let composited = (|| -> Result<(), String> {
            let mut inline_pool = ReaderPool::new(4, 2);
            let mut inline: HashMap<String, VideoReader> = HashMap::new();
            let mut scratch = Vec::new();
            let mut last_report = Instant::now();
            // Where the compositor waited: on the planner, the decoders, the encoder.
            let (mut on_plan, mut on_decode, mut on_encode) =
                (Duration::ZERO, Duration::ZERO, Duration::ZERO);
            let started = Instant::now();
            let mut planned = planned.into_iter();
            let mut done = 0;
            loop {
                let waiting = Instant::now();
                let Some(planned) = planned.next() else {
                    break;
                };
                on_plan += waiting.elapsed();
                if cancel.load(Ordering::Acquire) {
                    return Err("cancelled".to_owned());
                }
                feed_peaks(&mut renderer, project, &planned.scene, cache);
                for (clip, decode) in &planned.decodes {
                    match decode {
                        Decode::Worker(index) => {
                            let waiting = Instant::now();
                            let decoded = outputs
                                .get(*index)
                                .ok_or("no such decoder")?
                                .recv()
                                .map_err(|_| "a decoder stopped".to_owned())??;
                            on_decode += waiting.elapsed();
                            if decoded.frame != planned.frame || decoded.clip != *clip {
                                return Err("decoding fell out of step".to_owned());
                            }
                            if let Some(pixels) = decoded.pixels {
                                renderer.upload_video(
                                    clip,
                                    decoded.width,
                                    decoded.height,
                                    &pixels,
                                    decoded.order == Order::Bgra,
                                );
                                if let Some(recycle) = recyclers.get(*index) {
                                    let _ = recycle.send(pixels);
                                }
                            }
                        }
                        Decode::Inline(source, time) => {
                            let reader = inline
                                .entry(clip.clone())
                                .or_insert_with(|| inline_pool.take(source, *time));
                            scratch.resize(source.bytes(), 0);
                            reader.frame_into(*time, &mut scratch, false)?;
                            renderer.upload_video(
                                clip,
                                source.key.width,
                                source.key.height,
                                &scratch,
                                source.key.order == Order::Bgra,
                            );
                        }
                        Decode::Missing(error) => return Err(error.clone()),
                    }
                }
                let gone: Vec<String> = inline
                    .keys()
                    .filter(|clip| {
                        !planned.decodes.iter().any(|(active, decode)| {
                            active == *clip && matches!(decode, Decode::Inline(..))
                        })
                    })
                    .cloned()
                    .collect();
                for clip in gone {
                    if let Some(reader) = inline.remove(&clip) {
                        inline_pool.put(reader);
                    }
                }
                renderer.render(&planned.scene);
                let waiting = Instant::now();
                let slot = free.recv().map_err(|_| "the encoder stopped".to_owned())?;
                on_encode += waiting.elapsed();
                let buffer = buffers.get(slot).ok_or("no readback buffer")?;
                let submission = renderer.copy_output_to(buffer);
                let (mapped_tx, mapped) = mpsc::channel();
                buffer
                    .slice(..)
                    .map_async(wgpu::MapMode::Read, move |result| {
                        let _ = mapped_tx.send(result);
                    });
                readback_tx
                    .send(Readback {
                        frame: planned.frame,
                        slot,
                        submission,
                        mapped,
                    })
                    .map_err(|_| "the encoder stopped".to_owned())?;
                done += 1;
                if last_report.elapsed() > Duration::from_millis(200) {
                    last_report = Instant::now();
                    progress(done as f32 / total as f32);
                }
            }
            if cancel.load(Ordering::Acquire) {
                return Err("cancelled".to_owned());
            }
            crate::log::info(
                "export",
                format!(
                    "{} frames composited in {}; waited {} on planning, {} on decoding, {} on encoding",
                    total,
                    crate::log::human(started.elapsed()),
                    crate::log::human(on_plan),
                    crate::log::human(on_decode),
                    crate::log::human(on_encode),
                ),
            );
            Ok(())
        })();
        drop(readback_tx);
        drop(outputs);
        let encoded = encoder
            .join()
            .unwrap_or_else(|_| Err("the encoder crashed".to_owned()));
        // The encoder's own error explains a compositor that found it gone;
        // any other error of the compositor's is why the encoder was left
        // with a chunk cut short (Nov 2: Kroger's export said only "the
        // export stopped part-way through a chunk", three times over, the
        // compositor's reason never logged).
        match (composited, encoded) {
            (Err(error), _) if error == "cancelled" => Err(error),
            (Err(error), Err(encoder)) if error == "the encoder stopped" => Err(encoder),
            (Err(error), _) => Err(error),
            (Ok(()), Err(error)) => Err(error),
            (Ok(()), Ok(())) => Ok(()),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "edit-render-{name}-{}-{}",
            std::process::id(),
            crate::util::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A 2 s 320×180 source of one flat colour, its sound a 0.8 click at `click` s.
    fn source(dir: &Path, name: &str, color: &str, click: f64) -> PathBuf {
        let path = dir.join(name);
        let made = Command::new(crate::util::ffmpeg())
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg(format!("color=c={color}:size=320x180:rate=30:duration=2"))
            .args(["-f", "lavfi", "-i"])
            .arg(format!(
                "aevalsrc='if(between(t\\,{click}\\,{click}+0.002)\\,0.8\\,0)':s=48000:d=2:c=stereo"
            ))
            .args([
                "-c:v", "libx264", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
            ])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        path
    }

    fn decode_video(path: &Path) -> Vec<u8> {
        let output = Command::new(crate::util::ffmpeg())
            .args(["-v", "error", "-i"])
            .arg(path)
            .args([
                "-vf",
                "scale=32:18",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-",
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        output.stdout
    }

    fn decode_sound(path: &Path) -> Vec<f32> {
        let output = Command::new(crate::util::ffmpeg())
            .args(["-v", "error", "-i"])
            .arg(path)
            .args([
                "-map", "0:a:0", "-f", "f32le", "-ac", "2", "-ar", "48000", "-",
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        output
            .stdout
            .as_chunks::<4>()
            .0
            .iter()
            .map(|bytes| f32::from_le_bytes(*bytes))
            .collect()
    }

    fn duration(path: &Path, stream: &str) -> f64 {
        let output = Command::new(crate::util::ffprobe())
            .args([
                "-v",
                "error",
                "-select_streams",
                stream,
                "-show_entries",
                "stream=duration",
                "-of",
                "csv=p=0",
            ])
            .arg(path)
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse()
            .unwrap()
    }

    /// Many short cuts between two files, each clip's sound with it: every
    /// frame shows the right file, the sound stays in sync with the picture,
    /// and both last exactly the span.
    #[test]
    fn exports_cuts_in_sync_with_their_sound() {
        let dir = temp_dir("export");
        let red = source(&dir, "red.mp4", "red", 0.5);
        let blue = source(&dir, "blue.mp4", "blue", 1.0);
        let mut clips = Vec::new();
        // Twelve 5-frame cuts alternating red/blue, red from 0.4 s, blue from 0.9 s.
        for index in 0..12 {
            let (media, source_in) = if index % 2 == 0 {
                ("r", 0.4)
            } else {
                ("b", 0.9)
            };
            let start = index * 5;
            clips.push(
                json!({"id": format!("v{index}"), "track": "v", "type": "video", "media": media,
                "source_in": source_in, "start": start, "duration": 5}),
            );
            clips.push(
                json!({"id": format!("a{index}"), "track": "a", "type": "audio", "media": media,
                "source_in": source_in, "start": start, "duration": 5}),
            );
        }
        let project: Project = serde_json::from_value(json!({
            "version": 1, "id": "p", "name": "t",
            "settings": {"width": 320, "height": 180, "fps": 30},
            "media": [
                {"id": "r", "name": "red", "path": red, "kind": "video", "duration": 2.0, "width": 320, "height": 180, "fps": 30, "has_audio": true},
                {"id": "b", "name": "blue", "path": blue, "kind": "video", "duration": 2.0, "width": 320, "height": 180, "fps": 30, "has_audio": true}
            ],
            "tracks": [{"id": "v", "kind": "video"}, {"id": "a", "kind": "audio"}],
            "clips": clips,
        }))
        .unwrap();
        let options = ExportOptions::default();
        let plan = crate::export::plan(&options, &project, true).unwrap();
        let output = dir.join("out.mp4");
        export(
            &project,
            &options,
            &plan,
            &output,
            &dir,
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert!(
            (duration(&output, "v:0") - 2.0).abs() < 0.04,
            "{}",
            duration(&output, "v:0")
        );
        assert!(
            (duration(&output, "a:0") - 2.0).abs() < 0.03,
            "{}",
            duration(&output, "a:0")
        );
        let frames = decode_video(&output);
        let pixel = 32 * 18 * 3;
        assert_eq!(frames.len(), pixel * 60);
        for frame in 0..60 {
            let middle = &frames[frame * pixel + (9 * 32 + 16) * 3..][..3];
            let red = (frame / 5) % 2 == 0;
            assert!(
                if red {
                    middle[0] > 180 && middle[2] < 80
                } else {
                    middle[2] > 180 && middle[0] < 80
                },
                "frame {frame}: {middle:?}"
            );
        }
        // Each cut plays 0.4–0.567 s of red (click at 0.5) or 0.9–1.067 of blue
        // (click at 1.0): the click sounds 0.1 s into every cut.
        let sound = decode_sound(&output);
        for index in 0..12 {
            let start = index * 5 * 48000 / 30;
            let window = &sound[start * 2..(start + 8000) * 2];
            let loudest = (0..8000)
                .max_by(|a, b| window[a * 2].abs().total_cmp(&window[b * 2].abs()))
                .unwrap();
            assert!(
                (loudest as i64 - 4800).abs() < 96,
                "cut {index}: click at {loudest} samples, expected 4800"
            );
        }
        std::fs::remove_dir_all(dir).ok();
    }

    /// 100 one-second cuts alternating red and blue (`blue_at` makes those
    /// clips blue instead), each with its sound.
    fn cuts(red: &Path, blue: &Path, blue_at: &[i64], skip_first: i64) -> Project {
        let mut clips = Vec::new();
        let first = skip_first;
        for index in first..100 {
            let blue_here = index % 2 == 1 || blue_at.contains(&index);
            let media = if blue_here { "b" } else { "r" };
            let start = (index - first) * 30;
            clips.push(
                json!({"id": format!("v{index}"), "track": "v", "type": "video", "media": media,
                "source_in": 0.4 + index as f64 * 0.005, "start": start, "duration": 30}),
            );
            clips.push(json!({"id": format!("a{index}"), "track": "a", "type": "audio", "media": if index % 2 == 1 { "b" } else { "r" },
                "source_in": 0.4, "start": start, "duration": 30}));
        }
        serde_json::from_value(json!({
            "version": 1, "id": "chunky", "name": "t",
            "settings": {"width": 320, "height": 180, "fps": 30},
            "media": [
                {"id": "r", "name": "red", "path": red, "kind": "video", "duration": 2.0, "width": 320, "height": 180, "fps": 30, "has_audio": true},
                {"id": "b", "name": "blue", "path": blue, "kind": "video", "duration": 2.0, "width": 320, "height": 180, "fps": 30, "has_audio": true}
            ],
            "tracks": [{"id": "v", "kind": "video"}, {"id": "a", "kind": "audio"}],
            "clips": clips,
        }))
        .unwrap()
    }

    fn manifest(cache: &Path) -> crate::chunks::Manifest {
        let text = std::fs::read_to_string(
            crate::chunks::folder(cache, "chunky").join("manifest-v1.json"),
        )
        .unwrap();
        serde_json::from_str(&text).unwrap()
    }

    /// Every frame of `output` is the colour `project` has there.
    fn shows(output: &Path, blue: impl Fn(usize) -> bool, frames: usize) {
        let decoded = decode_video(output);
        let pixel = 32 * 18 * 3;
        assert_eq!(decoded.len(), pixel * frames);
        for frame in 0..frames {
            let middle = &decoded[frame * pixel + (9 * 32 + 16) * 3..][..3];
            assert!(
                if blue(frame) {
                    middle[2] > 180 && middle[0] < 80
                } else {
                    middle[0] > 180 && middle[2] < 80
                },
                "frame {frame}: {middle:?}"
            );
        }
    }

    /// A re-export whose copies out of the last export come out wrong (Nov 2,
    /// JJ's Mom Secretly v2: the join had 105 frames too many, twice) tries
    /// again rendering those chunks, not copying them again, and stays a
    /// chunked export instead of going whole.
    #[test]
    fn a_second_try_renders_what_the_first_copied_from_the_last_export() {
        let dir = temp_dir("chunks-retry");
        let red = source(&dir, "red.mp4", "red", 0.5);
        let blue = source(&dir, "blue.mp4", "blue", 1.0);
        let options = ExportOptions::default();
        let cache = dir.join("cache");
        let run = |project: &Project, name: &str| {
            let plan = export_plan(project, &options).unwrap();
            let output = dir.join(name);
            export_file(
                project,
                &options,
                &plan,
                &output,
                &cache,
                &HashMap::new(),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
            output
        };
        let one = run(&cuts(&red, &blue, &[], 0), "one.mp4");
        // The last export spoilt where its manifest can't tell: the same size and time.
        let modified = std::fs::metadata(&one).unwrap().modified().unwrap();
        let size = std::fs::metadata(&one).unwrap().len();
        std::fs::write(&one, vec![0_u8; size as usize]).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&one)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        let two = run(&cuts(&red, &blue, &[96], 0), "two.mp4");
        assert_eq!(
            manifest(&cache).output,
            two,
            "made of chunks, not exported whole"
        );
        shows(
            &two,
            |frame| (frame / 30) % 2 == 1 || frame / 30 == 96,
            3000,
        );
        std::fs::remove_dir_all(dir).ok();
    }

    /// Smooth playback's render (a background export) keeps its sound a
    /// minute at a time: the file's sound is the edit's length, and after a
    /// change to the edit's last seconds only the last minute is made again.
    #[test]
    fn smooth_playback_keeps_its_sound_a_minute_at_a_time() {
        let dir = temp_dir("kept-sound");
        let red = source(&dir, "red.mp4", "red", 0.5);
        let blue = source(&dir, "blue.mp4", "blue", 1.0);
        let options = ExportOptions {
            quality: crate::export::Quality::Small,
            ..ExportOptions::default()
        };
        let cache = dir.join("cache");
        let run = |project: &Project, name: &str| {
            let plan = export_plan(project, &options).unwrap();
            let output = dir.join(name);
            crate::media::as_background(|| {
                export_file(
                    project,
                    &options,
                    &plan,
                    &output,
                    &cache,
                    &HashMap::new(),
                    &AtomicBool::new(false),
                    |_| {},
                )
            })
            .unwrap();
            output
        };
        let blocks = crate::chunks::folder(&cache, "chunky").join("sound");
        let names = || {
            let mut names: Vec<String> = std::fs::read_dir(&blocks)
                .unwrap()
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        };
        let one = run(&cuts(&red, &blue, &[], 0), "one.mp4");
        assert!(
            (duration(&one, "a:0") - 100.0).abs() < 0.05,
            "{}",
            duration(&one, "a:0")
        );
        let first = names();
        assert_eq!(first.len(), 2, "{first:?}");
        assert!(first.iter().all(|name| name.ends_with(".aac")));
        // The last second's sound quieter: only the last minute's is made again.
        let mut quieter = serde_json::to_value(cuts(&red, &blue, &[], 0)).unwrap();
        for clip in quieter["clips"].as_array_mut().unwrap() {
            if clip["id"] == "a99" {
                clip["volume_db"] = json!(-6.0);
            }
        }
        let two = run(&serde_json::from_value(quieter).unwrap(), "two.mp4");
        assert!(
            (duration(&two, "a:0") - 100.0).abs() < 0.05,
            "{}",
            duration(&two, "a:0")
        );
        let second = names();
        assert_eq!(second.len(), 2);
        assert_eq!(
            second.iter().filter(|name| first.contains(name)).count(),
            1,
            "{first:?} then {second:?}"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    /// A focused export (smooth playback: the playhead's chunks first, then
    /// on, then those before) makes the same file as one in order: every
    /// frame where it belongs, made of chunks, not exported whole.
    #[test]
    fn a_focused_export_renders_from_the_playhead_and_joins_in_order() {
        let dir = temp_dir("focused");
        let red = source(&dir, "red.mp4", "red", 0.5);
        let blue = source(&dir, "blue.mp4", "blue", 1.0);
        let options = ExportOptions::default();
        let cache = dir.join("cache");
        let project = cuts(&red, &blue, &[], 0);
        let mut plan = export_plan(&project, &options).unwrap();
        plan.focus = Some(1500);
        let output = dir.join("focused.mp4");
        export_file(
            &project,
            &options,
            &plan,
            &output,
            &cache,
            &HashMap::new(),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        let made = manifest(&cache);
        // Where chunks end hangs on the fresh sources' keys (one cut in 16 may end one), so a
        // run makes two or more: two came up on Nov 5 and failed a nightly's check at ">= 3".
        assert!(made.chunks.len() >= 2, "{:?}", made.chunks);
        assert_eq!(made.output, output, "made of chunks, not exported whole");
        shows(&output, |frame| (frame / 30) % 2 == 1, 3000);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn only_the_native_encoders_failures_are_tried_again_with_ffmpeg() {
        assert!(is_native_encoder_error("Native encoder stalled"));
        assert!(is_native_encoder_error(
            "Native encoder: The operation could not be completed"
        ));
        assert!(is_native_encoder_error(
            "Cannot allocate native encoder pixel buffer"
        ));
        assert!(!is_native_encoder_error("cancelled"));
        assert!(!is_native_encoder_error(
            "No video frame at the requested source time"
        ));
    }

    /// A chunked re-export copies what didn't change out of the last export
    /// and gives the same file a whole export would: every frame, the sound
    /// the length of the picture; a trim near the start leaves later chunks
    /// as they were when the trim ends on a chunk boundary.
    #[test]
    fn a_re_export_redoes_only_the_chunks_that_changed() {
        let dir = temp_dir("chunks");
        let red = source(&dir, "red.mp4", "red", 0.5);
        let blue = source(&dir, "blue.mp4", "blue", 1.0);
        let options = ExportOptions::default();
        let cache = dir.join("cache");
        let run = |project: &Project, name: &str| {
            let plan = export_plan(project, &options).unwrap();
            let output = dir.join(name);
            export_file(
                project,
                &options,
                &plan,
                &output,
                &cache,
                &HashMap::new(),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
            output
        };
        let first = cuts(&red, &blue, &[], 0);
        let one = run(&first, "one.mp4");
        let made = manifest(&cache);
        assert!(made.chunks.len() >= 2, "{:?}", made.chunks);
        assert_eq!(made.output, one);
        shows(&one, |frame| (frame / 30) % 2 == 1, 3000);
        // Clip 96 (frames 2880 to 2909) turns blue: the chunk it's in is new,
        // and every chunk that ends before it is copied as it was. (A chunk
        // may or may not end on its first frame now: content decides.)
        let changed = cuts(&red, &blue, &[96], 0);
        let two = run(&changed, "two.mp4");
        let again = manifest(&cache);
        assert_eq!(again.output, two);
        let before_the_change = |manifest: &crate::chunks::Manifest| {
            manifest
                .chunks
                .iter()
                .filter(|chunk| chunk.at + chunk.frames < 2880)
                .cloned()
                .collect::<Vec<_>>()
        };
        assert_eq!(before_the_change(&made), before_the_change(&again));
        let covering = |manifest: &crate::chunks::Manifest| {
            manifest
                .chunks
                .iter()
                .find(|chunk| (chunk.at..chunk.at + chunk.frames).contains(&2880))
                .map(|chunk| chunk.key.clone())
        };
        assert_ne!(covering(&made), covering(&again));
        assert_eq!(made.sound, again.sound, "only the picture changed");
        shows(
            &two,
            |frame| (frame / 30) % 2 == 1 || frame / 30 == 96,
            3000,
        );
        let first_frame = Command::new(crate::util::ffprobe())
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-read_intervals",
                "%+#1",
                "-show_entries",
                "packet=pts_time",
                "-of",
                "csv=p=0",
            ])
            .arg(&two)
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&first_frame.stdout).trim(),
            "0.000000",
            "the picture starts with the sound"
        );
        assert!((duration(&two, "v:0") - 100.0).abs() < 0.04);
        assert!(
            (duration(&two, "a:0") - 100.0).abs() < 0.05,
            "{}",
            duration(&two, "a:0")
        );
        // Trim exactly the first chunk. Trimming only one cut can move an
        // anchor below MIN_SECONDS and legitimately change later boundaries;
        // which cut is an anchor varies with the source's content key.
        let removed = again.chunks[0].frames;
        assert_eq!(removed % 30, 0);
        let skipped = removed / 30;
        let trimmed = cuts(&red, &blue, &[96], skipped);
        let three = run(&trimmed, "three.mp4");
        let last = manifest(&cache);
        assert!(
            last.chunks
                .iter()
                .all(|chunk| again.chunks.iter().any(|old| old.key == chunk.key)),
            "{:?} against {:?}",
            last.chunks,
            again.chunks
        );
        shows(
            &three,
            |frame| {
                let index = frame / 30 + skipped as usize;
                index % 2 == 1 || index == 96
            },
            (3000 - removed) as usize,
        );
        assert!(
            (duration(&three, "a:0") - (100.0 - removed as f64 / 30.0)).abs() < 0.05,
            "{}",
            duration(&three, "a:0")
        );
        // Nothing's left in the chunk folder but the manifest and the plan.
        let mut left: Vec<String> = std::fs::read_dir(crate::chunks::folder(&cache, "chunky"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec!["manifest-v1.json", "plan-v1.json"]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_media_with_a_sound_copy_is_mixed_from_it() {
        let project: Project = serde_json::from_value(json!({
            "version": 1, "id": "p", "name": "t",
            "settings": {"width": 320, "height": 180, "fps": 30},
            "media": [{"id": "m", "name": "m", "path": "https://r2/x.mp4?sig", "kind": "video", "duration": 2.0, "width": 320, "height": 180, "fps": 30, "has_audio": true}],
            "tracks": [], "clips": [],
        }))
        .unwrap();
        let sounds = HashMap::from([("m".to_owned(), PathBuf::from("/cache/sound.mov"))]);
        assert_eq!(
            sound_path(&project, &sounds, "m"),
            Some(PathBuf::from("/cache/sound.mov"))
        );
        assert_eq!(
            sound_path(&project, &HashMap::new(), "m"),
            Some(PathBuf::from("https://r2/x.mp4?sig"))
        );
    }

    /// An NTSC project (24 × 1000/1001) exports at exactly 24000/1001, its
    /// frames and sound the timeline's length at that rate.
    #[test]
    fn an_ntsc_project_exports_at_its_exact_rate() {
        let dir = temp_dir("ntsc");
        let red = source(&dir, "red.mp4", "red", 0.5);
        let project: Project = serde_json::from_value(json!({
            "version": 1, "id": "ntsc", "name": "t",
            "settings": {"width": 320, "height": 180, "fps": 24, "ntsc": true},
            "media": [{"id": "r", "name": "red", "path": red, "kind": "video", "duration": 2.0, "width": 320, "height": 180, "fps": 30, "has_audio": true}],
            "tracks": [{"id": "v", "kind": "video"}, {"id": "a", "kind": "audio"}],
            "clips": [
                {"id": "v1", "track": "v", "type": "video", "media": "r", "source_in": 0.0, "start": 0, "duration": 46},
                {"id": "a1", "track": "a", "type": "audio", "media": "r", "source_in": 0.0, "start": 0, "duration": 46}
            ],
        }))
        .unwrap();
        assert!((project.fps() - 23.976_023_976).abs() < 1e-6);
        let options = ExportOptions::default();
        let plan = export_plan(&project, &options).unwrap();
        let output = dir.join("ntsc.mp4");
        let cache = dir.join("cache");
        export_file(
            &project,
            &options,
            &plan,
            &output,
            &cache,
            &HashMap::new(),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        let probe = Command::new(crate::util::ffprobe())
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-count_packets",
                "-show_entries",
                "stream=r_frame_rate,nb_read_packets",
                "-of",
                "csv=p=0",
            ])
            .arg(&output)
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&probe.stdout).trim(),
            "24000/1001,46"
        );
        let seconds = 46.0 * 1001.0 / 24000.0;
        assert!(
            (duration(&output, "v:0") - seconds).abs() < 0.01,
            "{}",
            duration(&output, "v:0")
        );
        assert!(
            (duration(&output, "a:0") - seconds).abs() < 0.03,
            "{}",
            duration(&output, "a:0")
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn partial_exports_of_dead_servers_are_removed() {
        let dir = temp_dir("stale");
        let output = dir.join("out.mp4");
        let own = std::process::id();
        for name in [
            "out.mp4.999999-p.partial.mp4".to_owned(),
            format!("out.mp4.{own}-p.partial.mp4"),
            "out.mp4.999999-p.partial.mp4.sound.m4a".to_owned(),
            "out.mp4.1-p.partial.mp4".to_owned(),
            "out.mp4.999999-q.partial.mp4".to_owned(),
            "other.mp4.999999-p.partial.mp4".to_owned(),
        ] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        remove_stale_partials(&output, "p", Format::H264);
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            vec![
                "other.mp4.999999-p.partial.mp4",
                "out.mp4.1-p.partial.mp4",
                "out.mp4.999999-q.partial.mp4"
            ]
        );
        std::fs::remove_dir_all(dir).ok();
    }

    /// A 2 s 30 fps 64×36 grey source whose frame n is lit 16 + 3n (flat, so
    /// nearly lossless; not lossless, which AVFoundation can't decode),
    /// so every decoded picture says which frame it is.
    fn frame_counter(dir: &Path) -> PathBuf {
        let path = dir.join("counter.mp4");
        let made = Command::new(crate::util::ffmpeg())
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg("color=c=black:size=64x36:rate=30:duration=2,format=yuv420p,geq=lum='16+3*N':cb=128:cr=128")
            .args(["-c:v", "libx264", "-qp", "4", "-g", "10", "-bf", "0"])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        path
    }

    /// Which frame of [`frame_counter`] a decoded RGBA picture is.
    fn counted(frame: &[u8]) -> i64 {
        // Limited-range grey 16 + 3n is full-range 3n × 255 / 219.
        (f64::from(frame[0]) * 219.0 / 255.0 / 3.0).round() as i64
    }

    /// A cloud original's reader reads a local excerpt where one holds the
    /// time, frame for frame: an excerpt cut off a keyframe, from a source
    /// with B-frames, shows the original's frame at `t` at `t - from`.
    #[test]
    fn readers_read_a_cloud_original_from_its_local_excerpt() {
        let dir = temp_dir("excerpt");
        let path = dir.join("counter-b.mp4");
        let made = Command::new(crate::util::ffmpeg())
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg("color=c=black:size=64x36:rate=30:duration=2,format=yuv420p,geq=lum='16+3*N':cb=128:cr=128")
            .args(["-c:v", "libx264", "-qp", "4", "-g", "12", "-bf", "3"])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        // Frame 21 (0.7 s) is no keyframe: the copy starts at 12's and hides 12–20.
        let excerpt = dir.join("excerpt.mp4");
        let cut = Command::new(crate::util::ffmpeg())
            .args(["-v", "error", "-ss", "0.7", "-i"])
            .arg(&path)
            .args(["-t", "0.8", "-map", "0:v:0", "-c:v", "copy", "-an"])
            .arg(&excerpt)
            .status()
            .unwrap();
        assert!(cut.success());
        let object = "https://r2.invalid/edit/originals/drive/counterB/counter-b.mp4";
        crate::excerpts::add(
            object,
            [crate::excerpts::Excerpt {
                from: 0.7,
                to: 1.5,
                path: excerpt.clone(),
            }],
        );
        let media: Media = serde_json::from_value(json!({
            "id": "m", "name": "m", "path": format!("{object}?sig=1"), "kind": "video",
            "duration": 2.0, "width": 64, "height": 36, "fps": 30
        }))
        .unwrap();
        let source = Source::new(&media, PathBuf::from(&media.path), (64, 36), Order::Rgba);
        let mut reader = VideoReader::open(source.clone());
        for n in 21..=44_i64 {
            let got = counted(reader.frame_at(n as f64 / 30.0).unwrap());
            assert_eq!(got, n, "frame {n} read on");
        }
        let mut out = vec![0; source.bytes()];
        for n in [40_i64, 22, 33] {
            let mut fresh = VideoReader::open(source.clone());
            assert!(fresh.frame_into(n as f64 / 30.0, &mut out, false).unwrap());
            assert_eq!(counted(&out), n, "frame {n} from a fresh reader");
        }
        // Through AVFoundation, not FFmpeg's fallback.
        #[cfg(target_os = "macos")]
        assert!(reader
            .excerpt
            .as_ref()
            .is_some_and(|(_, inner)| !inner.native_failed));
        // Outside it the URL is read (one that doesn't answer here).
        assert!(reader.frame_at(1.8).is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    /// The same with NTSC's 30000/1001 and a GOP longer than a cell (CCTV,
    /// screen recordings): a cell begins on the frame grid, ⌊30·n·fps⌋, well
    /// past the keyframe before it, and every frame read from the excerpt is
    /// the very picture read from the original.
    #[test]
    fn excerpts_of_long_gops_at_ntsc_rates_read_as_the_original() {
        let dir = temp_dir("excerpt-ntsc");
        let path = dir.join("long-gop.mp4");
        let made = Command::new(crate::util::ffmpeg())
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg("testsrc2=size=96x54:rate=30000/1001:duration=40")
            .args([
                "-c:v", "libx264", "-g", "1200", "-bf", "2", "-pix_fmt", "yuv420p",
            ])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        let fps = 30000.0 / 1001.0;
        // Cell 1: frame ⌊30 × 29.97⌋ = 899 on; the only keyframe before it is frame 0.
        let from = (30.0_f64 * fps + 1e-6).floor() / fps;
        let excerpt = dir.join("cell-1.mp4");
        let cut = Command::new(crate::util::ffmpeg())
            .args(["-v", "error", "-ss", &format!("{from:.6}"), "-i"])
            .arg(&path)
            .args([
                "-t",
                &format!("{:.6}", 40.0 - from),
                "-map",
                "0:v:0",
                "-c:v",
                "copy",
                "-an",
            ])
            .arg(&excerpt)
            .status()
            .unwrap();
        assert!(cut.success());
        let object = "https://r2.invalid/edit/originals/drive/ntscLongGop/long-gop.mp4";
        crate::excerpts::add(
            object,
            [crate::excerpts::Excerpt {
                from,
                to: 40.0,
                path: excerpt.clone(),
            }],
        );
        let media = |at: &str| -> Media {
            serde_json::from_value(json!({
                "id": "m", "name": "m", "path": at, "kind": "video",
                "duration": 40.0, "width": 96, "height": 54, "fps": fps
            }))
            .unwrap()
        };
        let original = media(path.to_str().unwrap());
        let cloud = media(&format!("{object}?sig=1"));
        let source =
            |media: &Media| Source::new(media, PathBuf::from(&media.path), (96, 54), Order::Rgba);
        let (mut here, mut there) = (
            VideoReader::open(source(&original)),
            VideoReader::open(source(&cloud)),
        );
        for n in [899_i64, 900, 901, 950, 1100, 1180] {
            let time = n as f64 / fps;
            let want = here.frame_at(time).unwrap().to_vec();
            assert_eq!(there.frame_at(time).unwrap(), &want[..], "frame {n}");
        }
        #[cfg(target_os = "macos")]
        assert!(there
            .excerpt
            .as_ref()
            .is_some_and(|(_, inner)| !inner.native_failed));
        std::fs::remove_dir_all(dir).ok();
    }

    /// FFmpeg's reader (cloud originals, URL sources) shows the frame nearest
    /// the time asked, as the preview and the native reader do, whether it
    /// starts there or reads on to it.
    #[test]
    fn ffmpeg_reader_picks_the_nearest_frame() {
        let dir = temp_dir("nearest");
        let path = frame_counter(&dir);
        let media: Media = serde_json::from_value(json!({
            "id": "m", "name": "m", "path": path, "kind": "video",
            "duration": 2.0, "width": 64, "height": 36, "fps": 30
        }))
        .unwrap();
        let source = Source::new(&media, path.clone(), (64, 36), Order::Rgba);
        let reader = || {
            #[allow(unused_mut)]
            let mut reader = VideoReader::open(source.clone());
            #[cfg(target_os = "macos")]
            {
                reader.native_failed = true;
            }
            reader
        };
        // Fresh readers, each started in the first or second half of a frame.
        for n in [0_i64, 1, 7, 15, 31, 44, 58] {
            for offset in [-0.45, -0.2, 0.0, 0.2, 0.45] {
                let time = ((n as f64 + offset) / 30.0).max(0.0);
                let mut fresh = reader();
                let got = counted(fresh.frame_at(time).unwrap());
                assert_eq!(got, n, "started at {time:.4} s (frame {n} {offset:+})");
            }
        }
        // One reader reading on, a frame at a time and skipping, at times in
        // either half of a frame; then back.
        let mut on = reader();
        let mut times = vec![];
        for n in 3..40 {
            times.push((n, (n as f64 + if n % 2 == 0 { -0.3 } else { 0.3 }) / 30.0));
        }
        for n in [42, 47, 55, 12, 13] {
            times.push((n, (n as f64 - 0.4) / 30.0));
        }
        for (n, time) in times {
            assert_eq!(counted(on.frame_at(time).unwrap()), n, "at {time:.4} s");
        }
        // The native reader picks the same frames.
        #[cfg(target_os = "macos")]
        {
            let mut native = crate::mac_media::Reader::open(&path, 64, 36).unwrap();
            let mut frame = vec![0_u8; 64 * 36 * 4];
            for n in [0_i64, 7, 8, 9, 31, 44] {
                for offset in [-0.3, 0.3] {
                    let time = ((n as f64 + offset) / 30.0).max(0.0);
                    native.frame(time, &mut frame, Order::Rgba, false).unwrap();
                    assert_eq!(counted(&frame), n, "native at {time:.4}");
                }
            }
        }
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_frame_asked_at_the_very_end_is_the_last_one() {
        // look_at_media sampled an 8.0 s map at 8.0 s: the seek landed past
        // the last frame and the reader failed ("failed to fill whole buffer").
        let dir = temp_dir("end");
        let path = frame_counter(&dir);
        let media: Media = serde_json::from_value(json!({
            "id": "m", "name": "m", "path": path, "kind": "video",
            "duration": 2.0, "width": 64, "height": 36, "fps": 30
        }))
        .unwrap();
        let source = Source::new(&media, path.clone(), (64, 36), Order::Rgba);
        for time in [2.0, 2.05, 1.99] {
            #[allow(unused_mut)]
            let mut reader = VideoReader::open(source.clone());
            #[cfg(target_os = "macos")]
            {
                reader.native_failed = true;
            }
            let got = counted(reader.frame_at(time).unwrap());
            assert_eq!(got, 59, "at {time:.3} s");
        }
        std::fs::remove_dir_all(dir).ok();
    }

    /// Times a 1080p export of footage wholly under full-frame B-roll (the
    /// footage isn't seen, so it isn't decoded). Ignored: a measurement.
    /// `cargo test -p edit-engine --release covered_footage -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_export_of_covered_footage() {
        // The export's own account of where the time went.
        struct Print;
        impl crate::log::Sink for Print {
            fn log(&self, _: crate::log::Level, area: &str, message: String) {
                if area == "export" {
                    println!("  {message}");
                }
            }
            fn record(&self, _: &str, _: &str, _: Duration, _: Option<&str>) {}
        }
        crate::log::use_sink(Box::new(Print));
        let dir = temp_dir("covered");
        let make = |name: &str, pattern: &str| {
            let path = dir.join(name);
            let made = Command::new(crate::util::ffmpeg())
                .args(["-v", "error", "-f", "lavfi", "-i"])
                .arg(format!("{pattern}=size=1920x1080:rate=30:duration=20"))
                .args([
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-g",
                    "60",
                    "-pix_fmt",
                    "yuv420p",
                ])
                .arg(&path)
                .status()
                .unwrap();
            assert!(made.success());
            path
        };
        let footage = make("footage.mp4", "testsrc2");
        let broll = make("broll.mp4", "testsrc");
        let project = |covered: bool| -> Project {
            let mut clips = vec![
                json!({"id": "b", "track": "v2", "type": "video", "media": "b",
                "source_in": 0.0, "start": 0, "duration": 600}),
            ];
            if covered {
                clips.push(
                    json!({"id": "f", "track": "v1", "type": "video", "media": "f",
                    "source_in": 0.0, "start": 0, "duration": 600}),
                );
            }
            serde_json::from_value(json!({
                "version": 1, "id": "p", "name": "t",
                "settings": {"width": 1920, "height": 1080, "fps": 30},
                "media": [
                    {"id": "f", "name": "footage", "path": footage, "kind": "video", "duration": 20.0, "width": 1920, "height": 1080, "fps": 30, "has_audio": false},
                    {"id": "b", "name": "broll", "path": broll, "kind": "video", "duration": 20.0, "width": 1920, "height": 1080, "fps": 30, "has_audio": false}
                ],
                "tracks": [{"id": "v1", "kind": "video"}, {"id": "v2", "kind": "video"}],
                "clips": clips,
            }))
            .unwrap()
        };
        // Twice each, alternating: the first export also warms the GPU up.
        for (label, covered) in [
            ("B-roll alone", false),
            ("B-roll over footage", true),
            ("B-roll alone", false),
            ("B-roll over footage", true),
        ] {
            let project = project(covered);
            let options = ExportOptions::default();
            let plan = crate::export::plan(&options, &project, false).unwrap();
            let started = Instant::now();
            export(
                &project,
                &options,
                &plan,
                &dir.join("out.mp4"),
                &dir,
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
            println!("{label}: 600 frames in {:.2?}", started.elapsed());
        }
        std::fs::remove_dir_all(dir).ok();
    }

    /// Three layers cut to one: the clip starting on that frame gets one of
    /// the decoders the three just left, not the compositor's own thread.
    #[test]
    fn a_clip_after_a_layered_cut_gets_a_decoder() {
        let clip = |id: &str, track: &str, start: i64, duration: i64| {
            json!({"id": id, "track": track, "type": "video", "media": "m",
                "source_in": 0.0, "start": start, "duration": duration})
        };
        let project: Project = serde_json::from_value(json!({
            "version": 1, "id": "p", "name": "t",
            "settings": {"width": 320, "height": 180, "fps": 30},
            "media": [{"id": "m", "name": "m", "path": "/nowhere/m.mp4", "kind": "video",
                "duration": 2.0, "width": 320, "height": 180, "fps": 30, "has_audio": false}],
            "tracks": [{"id": "v1", "kind": "video"}, {"id": "v2", "kind": "video"},
                {"id": "v3", "kind": "video"}],
            "clips": [clip("a", "v1", 0, 1), clip("b", "v2", 0, 1), clip("c", "v3", 0, 1),
                clip("d", "v1", 1, 2)],
        }))
        .unwrap();
        let (senders, _receivers): (Vec<_>, Vec<_>) =
            (0..DECODERS).map(|_| mpsc::channel::<DecodeJob>()).unzip();
        let (planned_tx, planned) = mpsc::sync_channel(8);
        planner(
            &project,
            &[(0, 3)],
            senders,
            planned_tx,
            &AtomicBool::new(false),
        );
        let decodes: Vec<Vec<(String, bool)>> = planned
            .into_iter()
            .map(|planned| {
                planned
                    .decodes
                    .into_iter()
                    .map(|(clip, decode)| (clip, matches!(decode, Decode::Worker(_))))
                    .collect()
            })
            .collect();
        assert_eq!(decodes.len(), 3);
        assert!(decodes[0].iter().all(|(_, worker)| *worker), "{decodes:?}");
        assert_eq!(decodes[1], vec![("d".to_owned(), true)]);
        assert_eq!(decodes[2], vec![("d".to_owned(), true)]);
    }

    #[test]
    fn readers_are_pooled_by_file_and_continue_forward() {
        let media: Media = serde_json::from_value(json!({
            "id": "m", "name": "m", "path": "/nowhere.mp4", "kind": "video",
            "duration": 10.0, "width": 1920, "height": 1080, "fps": 30
        }))
        .unwrap();
        let source = Source::new(&media, "/nowhere.mp4".into(), (640, 360), Order::Bgra);
        let mut pool = ReaderPool::new(3, 2);
        let mut behind = VideoReader::open(source.clone());
        behind.position = Some(4.0);
        let mut far = VideoReader::open(source.clone());
        far.position = Some(9.0);
        pool.put(far);
        pool.put(behind);
        assert_eq!(
            pool.take(&source, 4.5).position,
            Some(4.0),
            "the one just behind"
        );
        // A third for the same file pushes out its oldest; other files count to the total.
        pool.put(VideoReader::open(source.clone()));
        pool.put(VideoReader::open(source.clone()));
        assert_eq!(pool.readers.len(), 2);
        let mut other = source.clone();
        other.key.path = "/other.mp4".into();
        pool.put(VideoReader::open(other.clone()));
        pool.put(VideoReader::open(other));
        assert_eq!(pool.readers.len(), 3);
    }
}
