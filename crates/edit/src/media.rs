//! Probing and background media work: scrub proxies, thumbnail strips, waveforms.
//!
//! Preview proxies are small enough to stream over Wi-Fi: H.264 with a
//! keyframe every half second and no B-frames, so the browser decodes at most
//! a few frames to land anywhere and plays forward on one decoder. Sound is a
//! separate AAC file, so decoding it never downloads the picture.

use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use edit_core::MediaKind;
use serde::Serialize;
use serde_json::{json, Value};

use crate::store::Store;

pub const PROXY_MAX_WIDTH: u32 = 1920;
pub const PROXY_MAX_HEIGHT: u32 = 1080;
/// Waveform resolution.
pub const PEAKS_PER_SECOND: u32 = 100;
pub const THUMB_HEIGHT: u32 = 72;

#[derive(Clone, Debug, PartialEq)]
pub struct Probe {
    pub kind: MediaKind,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_audio: bool,
}

pub const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "m4v", "mkv", "webm", "avi", "mts", "mxf"];
pub const AUDIO_EXTENSIONS: &[&str] = &[
    "wav", "mp3", "m4a", "aac", "flac", "aif", "aiff", "ogg", "opus",
];

pub fn is_media_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .is_some_and(|ext| {
            VIDEO_EXTENSIONS.contains(&ext.as_str()) || AUDIO_EXTENSIONS.contains(&ext.as_str())
        })
}

pub fn probe(path: &Path) -> Result<Probe, String> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
        ])
        .arg(path)
        .output()
        .map_err(|error| format!("ffprobe is not available ({error}); install FFmpeg"))?;
    if !output.status.success() {
        return Err(format!(
            "could not read {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let info: Value = serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
    let streams = info["streams"].as_array().cloned().unwrap_or_default();
    let video = streams.iter().find(|stream| {
        stream["codec_type"] == "video"
            && stream["disposition"]["attached_pic"].as_i64().unwrap_or(0) == 0
    });
    let has_audio = streams.iter().any(|stream| stream["codec_type"] == "audio");
    let duration = info["format"]["duration"]
        .as_str()
        .and_then(|value| value.parse::<f64>().ok())
        .or_else(|| {
            video
                .and_then(|stream| stream["duration"].as_str())
                .and_then(|value| value.parse().ok())
        })
        .unwrap_or(0.0);
    if let Some(video) = video {
        let codec = video["codec_name"].as_str().unwrap_or_default();
        if duration <= 0.0
            || ["png", "mjpeg", "bmp", "gif", "webp", "tiff"].contains(&codec) && duration < 0.1
        {
            return Err(format!(
                "{} looks like a still image; images are not supported yet",
                path.display()
            ));
        }
        let rotation = rotation_of(video);
        let (mut width, mut height) = (
            video["width"].as_u64().unwrap_or(0) as u32,
            video["height"].as_u64().unwrap_or(0) as u32,
        );
        if rotation.rem_euclid(180) == 90 {
            std::mem::swap(&mut width, &mut height);
        }
        let fps = parse_rate(video["avg_frame_rate"].as_str())
            .or_else(|| parse_rate(video["r_frame_rate"].as_str()))
            .unwrap_or(30.0);
        return Ok(Probe {
            kind: MediaKind::Video,
            duration,
            width,
            height,
            fps,
            has_audio,
        });
    }
    if has_audio && duration > 0.0 {
        return Ok(Probe {
            kind: MediaKind::Audio,
            duration,
            width: 0,
            height: 0,
            fps: 0.0,
            has_audio: true,
        });
    }
    Err(format!("{} has no playable video or audio", path.display()))
}

fn rotation_of(stream: &Value) -> i64 {
    if let Some(list) = stream["side_data_list"].as_array() {
        for item in list {
            if let Some(rotation) = item["rotation"].as_f64() {
                return rotation.round() as i64;
            }
        }
    }
    stream["tags"]["rotate"]
        .as_str()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn parse_rate(rate: Option<&str>) -> Option<f64> {
    let (num, den) = rate?.split_once('/')?;
    let (num, den): (f64, f64) = (num.parse().ok()?, den.parse().ok()?);
    (num.is_finite() && den.is_finite() && num > 0.0 && den > 0.0).then_some(num / den)
}

/// Identity of a source file's content for cache reuse across projects.
pub fn media_key(path: &Path) -> String {
    let meta = std::fs::metadata(path).ok();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    meta.as_ref().map(|meta| meta.len()).hash(&mut hasher);
    meta.and_then(|meta| meta.modified().ok()).hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    #[default]
    Pending,
    Working,
    Ready,
    Failed,
    Skipped,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct MediaStatus {
    pub proxy: Stage,
    pub proxy_progress: f32,
    pub thumbs: Stage,
    pub thumb_count: u32,
    pub peaks: Stage,
    /// `pending` = not requested (it costs money, so it never starts on its own).
    pub transcript: Stage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct Processor {
    store: Arc<Store>,
    status: Mutex<HashMap<String, MediaStatus>>,
    encodes: Arc<tokio::sync::Semaphore>,
    processing: Mutex<HashSet<String>>,
}

pub struct CachePaths {
    /// Preview picture (video sources only, no sound).
    pub proxy: PathBuf,
    /// Preview sound (sources with audio).
    pub audio: PathBuf,
    /// Written once both preview files are complete.
    pub proxy_done: PathBuf,
    pub thumbs: PathBuf,
    pub thumbs_meta: PathBuf,
    pub peaks: PathBuf,
    pub transcript: PathBuf,
}

impl Processor {
    pub fn new(store: Arc<Store>) -> Arc<Self> {
        Arc::new(Self {
            store,
            status: Mutex::new(HashMap::new()),
            encodes: Arc::new(tokio::sync::Semaphore::new(2)),
            processing: Mutex::new(HashSet::new()),
        })
    }

    pub fn paths(&self, source: &Path) -> CachePaths {
        let dir = self.store.cache_dir().join(media_key(source));
        CachePaths {
            proxy: dir.join("preview.mp4"),
            audio: dir.join("preview.m4a"),
            proxy_done: dir.join("preview.done"),
            thumbs: dir.join("thumbs.jpg"),
            thumbs_meta: dir.join("thumbs.json"),
            peaks: dir.join("peaks.bin"),
            transcript: dir.join("transcript.json"),
        }
    }

    pub fn status(&self, source: &Path) -> MediaStatus {
        let key = media_key(source);
        if let Some(status) = self.status.lock().get(&key) {
            return status.clone();
        }
        self.status_from_disk(source)
    }

    fn status_from_disk(&self, source: &Path) -> MediaStatus {
        let paths = self.paths(source);
        let thumb_count = std::fs::read_to_string(&paths.thumbs_meta)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|meta| meta["count"].as_u64())
            .unwrap_or(0) as u32;
        let proxied = paths.proxy_done.is_file();
        MediaStatus {
            proxy: if proxied {
                Stage::Ready
            } else {
                Stage::Pending
            },
            proxy_progress: if proxied { 1.0 } else { 0.0 },
            thumbs: if thumb_count > 0 && paths.thumbs.is_file() {
                Stage::Ready
            } else {
                Stage::Pending
            },
            thumb_count,
            peaks: if paths.peaks.is_file() {
                Stage::Ready
            } else {
                Stage::Pending
            },
            transcript: if paths.transcript.is_file() {
                Stage::Ready
            } else {
                Stage::Pending
            },
            transcript_error: None,
            error: None,
        }
    }

    fn set(&self, source: &Path, change: impl FnOnce(&mut MediaStatus)) {
        let key = media_key(source);
        let status = {
            let mut map = self.status.lock();
            let entry = map
                .entry(key)
                .or_insert_with(|| self.status_from_disk(source));
            change(entry);
            entry.clone()
        };
        self.store.emit(json!({
            "type": "media",
            "path": source.to_string_lossy(),
            "status": status,
        }));
    }

    /// Starts whatever work is missing for `source`. Safe to call repeatedly.
    pub fn ensure(self: &Arc<Self>, source: PathBuf, probe: Probe) {
        let key = media_key(&source);
        if !self.processing.lock().insert(key.clone()) {
            return;
        }
        let paths = self.paths(&source);
        if let Some(dir) = paths.proxy.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let this = Arc::clone(self);
        tokio::spawn(async move {
            // Limit all FFmpeg work, including waveforms and thumbnails, rather
            // than starting two unbounded extra decoders for every import.
            let Ok(_permit) = this.encodes.clone().acquire_owned().await else {
                return;
            };
            let worker = Arc::clone(&this);
            let job_source = source.clone();
            let outcome = tokio::task::spawn_blocking(move || {
                let status = worker.status(&source);
                let paths = worker.paths(&source);
                if probe.kind == MediaKind::Video && status.thumbs != Stage::Ready {
                    worker.set(&source, |status| status.thumbs = Stage::Working);
                    match make_thumbs(&source, &probe, &paths) {
                        Ok(count) => worker.set(&source, |status| {
                            status.thumbs = Stage::Ready;
                            status.thumb_count = count;
                        }),
                        Err(error) => worker.set(&source, |status| {
                            status.thumbs = Stage::Failed;
                            status.error = Some(error);
                        }),
                    }
                } else if probe.kind != MediaKind::Video {
                    worker.set(&source, |status| status.thumbs = Stage::Skipped);
                }
                if probe.has_audio && status.peaks != Stage::Ready {
                    worker.set(&source, |status| status.peaks = Stage::Working);
                    match make_peaks(&source, &paths.peaks) {
                        Ok(()) => worker.set(&source, |status| status.peaks = Stage::Ready),
                        Err(error) => worker.set(&source, |status| {
                            status.peaks = Stage::Failed;
                            status.error = Some(error);
                        }),
                    }
                } else if !probe.has_audio {
                    worker.set(&source, |status| status.peaks = Stage::Skipped);
                }
                if probe.kind == MediaKind::Image {
                    worker.set(&source, |status| status.proxy = Stage::Skipped);
                } else if status.proxy != Stage::Ready {
                    worker.set(&source, |status| {
                        status.proxy = Stage::Working;
                        status.error = None;
                    });
                    match make_proxy(&source, &probe, &paths, |progress| {
                        worker.set(&source, |status| status.proxy_progress = progress)
                    }) {
                        Ok(()) => worker.set(&source, |status| {
                            status.proxy = Stage::Ready;
                            status.proxy_progress = 1.0;
                        }),
                        Err(error) => worker.set(&source, |status| {
                            status.proxy = Stage::Failed;
                            status.error = Some(error);
                        }),
                    }
                }
            })
            .await;
            // A crash mid-way leaves no stage "working" (and the file can be processed again).
            if let Err(error) = outcome {
                let message = error
                    .try_into_panic()
                    .map(|payload| crate::guard::message(&*payload))
                    .unwrap_or_else(|error| error.to_string());
                eprintln!(
                    "edit: processing {} crashed: {message}",
                    job_source.display()
                );
                this.set(&job_source, |status| {
                    for stage in [&mut status.thumbs, &mut status.peaks, &mut status.proxy] {
                        if *stage == Stage::Working {
                            *stage = Stage::Failed;
                        }
                    }
                    status.error = Some(format!("processing crashed ({message})"));
                });
            }
            this.processing.lock().remove(&key);
        });
    }
}

impl Processor {
    /// Transcribes `source` through the relay unless already done or running.
    pub fn transcribe(self: &Arc<Self>, source: PathBuf, has_audio: bool) -> MediaStatus {
        {
            let key = media_key(&source);
            let mut statuses = self.status.lock();
            let current = statuses
                .entry(key)
                .or_insert_with(|| self.status_from_disk(&source));
            if !has_audio || matches!(current.transcript, Stage::Working | Stage::Ready) {
                return current.clone();
            }
            // Claim before dropping the lock: two requests cannot start the
            // same paid transcription between status() and set().
            current.transcript = Stage::Working;
            current.transcript_error = None;
        }
        self.set(&source, |status| {
            status.transcript = Stage::Working;
            status.transcript_error = None;
        });
        let this = Arc::clone(self);
        let target = self.paths(&source).transcript;
        let job_source = source.clone();
        tokio::task::spawn_blocking(move || {
            match crate::guard::catch("transcription", || {
                crate::transcribe::run(&job_source, &target)
            })
            .and_then(|result| result)
            {
                Ok(()) => this.set(&job_source, |status| status.transcript = Stage::Ready),
                Err(error) => this.set(&job_source, |status| {
                    status.transcript = Stage::Failed;
                    status.transcript_error = Some(error);
                }),
            }
        });
        self.status(&source)
    }
}

fn run(command: &mut Command) -> Result<Vec<u8>, String> {
    let output = command
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffmpeg is not available ({error}); install FFmpeg"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let last = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("ffmpeg failed");
        return Err(last.trim().to_owned());
    }
    Ok(output.stdout)
}

fn make_proxy(
    source: &Path,
    probe: &Probe,
    paths: &CachePaths,
    mut progress: impl FnMut(f32),
) -> Result<(), String> {
    let _ = std::fs::remove_file(&paths.proxy_done);
    let video = probe.kind == MediaKind::Video;
    let video_tmp = paths.proxy.with_extension("partial.mp4");
    let audio_tmp = paths.audio.with_extension("partial.m4a");
    let mut command = Command::new("ffmpeg");
    command
        .args([
            "-hide_banner",
            "-nostats",
            "-y",
            "-progress",
            "pipe:1",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
        ])
        .arg(source);
    if video {
        // Half-second GOPs: seeking decodes at most ~15 frames, and playback
        // streams at a few Mbit/s instead of the ~70 an all-intra 1080p file needs.
        let gop = (probe.fps / 2.0).round().max(1.0).to_string();
        command
            .args([
                "-map",
                "0:v:0",
                "-vf",
                &format!(
                    "scale=w='min({PROXY_MAX_WIDTH},iw)':h='min({PROXY_MAX_HEIGHT},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:out_color_matrix=bt709:out_range=tv,format=yuv420p"
                ),
                // Tagged BT.709 so the browser decodes the colours FFmpeg (and so the export) sees.
                "-colorspace",
                "bt709",
                "-color_primaries",
                "bt709",
                "-color_trc",
                "bt709",
                "-color_range",
                "tv",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "20",
                "-g",
                &gop,
                // No reordering: each frame comes out of the decoder as soon as it goes in.
                "-bf",
                "0",
                "-an",
                "-movflags",
                "+faststart",
            ])
            .arg(&video_tmp);
    }
    if probe.has_audio {
        command
            .args([
                "-map",
                "0:a:0",
                "-vn",
                "-c:a",
                "aac",
                "-b:a",
                "160k",
                "-ac",
                "2",
                "-movflags",
                "+faststart",
            ])
            .arg(&audio_tmp);
    }
    if !video && !probe.has_audio {
        return Err("proxy: nothing to encode".to_owned());
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("ffmpeg is not available ({error}); install FFmpeg"))?;
    let stderr = child.stderr.take();
    let stderr_thread = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(value) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = value.trim().parse::<f64>() {
                    if last_emit.elapsed() > Duration::from_millis(250) && probe.duration > 0.0 {
                        last_emit = Instant::now();
                        progress((us / 1e6 / probe.duration).clamp(0.0, 0.99) as f32);
                    }
                }
            }
        }
    }
    let status = child.wait().map_err(|error| error.to_string())?;
    let stderr = stderr_thread.join().unwrap_or_default();
    if !status.success() {
        let _ = std::fs::remove_file(&video_tmp);
        let _ = std::fs::remove_file(&audio_tmp);
        let last = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("proxy encode failed");
        return Err(format!("proxy: {}", last.trim()));
    }
    for (tmp, out, wanted) in [
        (&video_tmp, &paths.proxy, video),
        (&audio_tmp, &paths.audio, probe.has_audio),
    ] {
        if wanted {
            std::fs::rename(tmp, out).map_err(|error| error.to_string())?;
        }
    }
    std::fs::write(&paths.proxy_done, b"").map_err(|error| error.to_string())?;
    // The all-intra proxy from before 2026-10-12 is no longer read.
    if let Some(dir) = paths.proxy.parent() {
        let _ = std::fs::remove_file(dir.join("proxy.mp4"));
    }
    Ok(())
}

fn make_thumbs(source: &Path, probe: &Probe, paths: &CachePaths) -> Result<u32, String> {
    let wanted = ((probe.duration / 2.0).ceil() as u32).clamp(1, 120);
    let interval = (probe.duration / f64::from(wanted)).max(0.05);
    // Keyframes only (fast), at most one per interval. Sparse keyframes yield
    // fewer frames, so count what came out before tiling.
    let frames_dir = paths.thumbs.with_extension("frames");
    let _ = std::fs::remove_dir_all(&frames_dir);
    std::fs::create_dir_all(&frames_dir).map_err(|error| error.to_string())?;
    run(Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-skip_frame", "nokey", "-protocol_whitelist", "file,pipe", "-i"])
        .arg(source)
        .args([
            "-an",
            "-vf",
            &format!(
                "select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,{:.4})',scale=-2:{THUMB_HEIGHT}",
                interval * 0.99
            ),
            "-fps_mode",
            "vfr",
            "-frames:v",
            &wanted.to_string(),
            "-q:v",
            "5",
        ])
        .arg(frames_dir.join("%04d.jpg")))?;
    let count = std::fs::read_dir(&frames_dir)
        .map_err(|error| error.to_string())?
        .count() as u32;
    if count == 0 {
        let _ = std::fs::remove_dir_all(&frames_dir);
        return Err("no thumbnails could be decoded".to_owned());
    }
    let tmp = paths.thumbs.with_extension("partial.jpg");
    let result = run(Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(frames_dir.join("%04d.jpg"))
        .args([
            "-vf",
            &format!("tile={count}x1"),
            "-frames:v",
            "1",
            "-q:v",
            "5",
        ])
        .arg(&tmp));
    let _ = std::fs::remove_dir_all(&frames_dir);
    result?;
    std::fs::rename(&tmp, &paths.thumbs).map_err(|error| error.to_string())?;
    std::fs::write(
        &paths.thumbs_meta,
        json!({ "count": count, "interval": interval }).to_string(),
    )
    .map_err(|error| error.to_string())?;
    Ok(count)
}

/// One byte per 1/`PEAKS_PER_SECOND` s: the peak absolute amplitude scaled to 0..255.
fn make_peaks(source: &Path, out: &Path) -> Result<(), String> {
    let rate = PEAKS_PER_SECOND * 40;
    let tmp = out.with_extension("partial");
    let mut child = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
        ])
        .arg(source)
        .args([
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            &rate.to_string(),
            "-f",
            "f32le",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    let result = (|| {
        let mut reader = BufReader::new(child.stdout.take().ok_or("ffmpeg stdout")?);
        let mut writer =
            BufWriter::new(std::fs::File::create(&tmp).map_err(|error| error.to_string())?);
        let mut sample = [0; 4];
        let mut peak = 0.0_f32;
        let mut count = 0;
        loop {
            match reader.read_exact(&mut sample) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(error) => return Err(error.to_string()),
            }
            peak = peak.max(f32::from_le_bytes(sample).abs());
            count += 1;
            if count == 40 {
                writer
                    .write_all(&[(peak.min(1.0).sqrt() * 255.0).round() as u8])
                    .map_err(|error| error.to_string())?;
                count = 0;
                peak = 0.0;
            }
        }
        if count > 0 {
            writer
                .write_all(&[(peak.min(1.0).sqrt() * 255.0).round() as u8])
                .map_err(|error| error.to_string())?;
        }
        writer.flush().map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = child.kill();
    }
    let status = child.wait().map_err(|error| error.to_string())?;
    if result.is_err() || !status.success() {
        let _ = std::fs::remove_file(&tmp);
        result?;
        return Err("waveform decoding failed".to_owned());
    }
    std::fs::rename(tmp, out).map_err(|error| error.to_string())
}
