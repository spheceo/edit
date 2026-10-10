//! Probing and background media work: scrub proxies, thumbnail strips, waveforms.
//!
//! Proxies are all-intra H.264 (every frame a keyframe), so the browser can
//! land on any frame without decoding a GOP. That is what makes scrubbing clean.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
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
    (num > 0.0 && den > 0.0).then_some(num / den)
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
}

pub struct CachePaths {
    pub proxy: PathBuf,
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
        })
    }

    pub fn paths(&self, source: &Path) -> CachePaths {
        let dir = self.store.cache_dir().join(media_key(source));
        CachePaths {
            proxy: dir.join("proxy.mp4"),
            thumbs: dir.join("thumbs.jpg"),
            thumbs_meta: dir.join("thumbs.json"),
            peaks: dir.join("peaks.bin"),
            transcript: dir.join("transcript.json"),
        }
    }

    pub fn status(&self, source: &Path) -> MediaStatus {
        let key = media_key(source);
        if let Some(status) = self.status.lock().unwrap().get(&key) {
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
        MediaStatus {
            proxy: if paths.proxy.is_file() {
                Stage::Ready
            } else {
                Stage::Pending
            },
            proxy_progress: if paths.proxy.is_file() { 1.0 } else { 0.0 },
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
            let mut map = self.status.lock().unwrap();
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
        {
            let mut map = self.status.lock().unwrap();
            if map.contains_key(&key) {
                return;
            }
            map.insert(key, self.status_from_disk(&source));
        }
        let status = self.status(&source);
        let paths = self.paths(&source);
        if let Some(dir) = paths.proxy.parent() {
            let _ = std::fs::create_dir_all(dir);
        }

        if probe.kind == MediaKind::Video && status.thumbs != Stage::Ready {
            let this = Arc::clone(self);
            let (source, probe) = (source.clone(), probe.clone());
            tokio::task::spawn_blocking(move || {
                this.set(&source, |status| status.thumbs = Stage::Working);
                match make_thumbs(&source, &probe, &this.paths(&source)) {
                    Ok(count) => this.set(&source, |status| {
                        status.thumbs = Stage::Ready;
                        status.thumb_count = count;
                    }),
                    Err(error) => this.set(&source, |status| {
                        status.thumbs = Stage::Failed;
                        status.error = Some(error);
                    }),
                }
            });
        } else if probe.kind != MediaKind::Video {
            self.set(&source, |status| status.thumbs = Stage::Skipped);
        }

        if probe.has_audio && status.peaks != Stage::Ready {
            let this = Arc::clone(self);
            let source = source.clone();
            tokio::task::spawn_blocking(move || {
                this.set(&source, |status| status.peaks = Stage::Working);
                match make_peaks(&source, &this.paths(&source).peaks) {
                    Ok(()) => this.set(&source, |status| status.peaks = Stage::Ready),
                    Err(error) => this.set(&source, |status| {
                        status.peaks = Stage::Failed;
                        status.error = Some(error);
                    }),
                }
            });
        } else if !probe.has_audio {
            self.set(&source, |status| status.peaks = Stage::Skipped);
        }

        if status.proxy != Stage::Ready {
            let this = Arc::clone(self);
            tokio::spawn(async move {
                let Ok(_permit) = this.encodes.clone().acquire_owned().await else {
                    return;
                };
                let worker = Arc::clone(&this);
                let source_for_task = source.clone();
                let result = tokio::task::spawn_blocking(move || {
                    worker.set(&source_for_task, |status| status.proxy = Stage::Working);
                    let paths = worker.paths(&source_for_task);
                    make_proxy(&source_for_task, &probe, &paths.proxy, |progress| {
                        worker.set(&source_for_task, |status| status.proxy_progress = progress);
                    })
                })
                .await
                .unwrap_or_else(|error| Err(error.to_string()));
                match result {
                    Ok(()) => this.set(&source, |status| {
                        status.proxy = Stage::Ready;
                        status.proxy_progress = 1.0;
                    }),
                    Err(error) => this.set(&source, |status| {
                        status.proxy = Stage::Failed;
                        status.error = Some(error);
                    }),
                }
            });
        }
    }
}

impl Processor {
    /// Transcribes `source` through the relay unless already done or running.
    pub fn transcribe(self: &Arc<Self>, source: PathBuf, has_audio: bool) -> MediaStatus {
        let current = self.status(&source);
        if !has_audio || matches!(current.transcript, Stage::Working | Stage::Ready) {
            return current;
        }
        self.set(&source, |status| {
            status.transcript = Stage::Working;
            status.transcript_error = None;
        });
        let this = Arc::clone(self);
        let target = self.paths(&source).transcript;
        let job_source = source.clone();
        tokio::task::spawn_blocking(move || match crate::transcribe::run(&job_source, &target) {
            Ok(()) => this.set(&job_source, |status| status.transcript = Stage::Ready),
            Err(error) => this.set(&job_source, |status| {
                status.transcript = Stage::Failed;
                status.transcript_error = Some(error);
            }),
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
    out: &Path,
    mut progress: impl FnMut(f32),
) -> Result<(), String> {
    let tmp = out.with_extension("partial.mp4");
    let mut command = Command::new("ffmpeg");
    command
        .args(["-hide_banner", "-nostats", "-y", "-i"])
        .arg(source);
    if probe.kind == MediaKind::Video {
        command.args([
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
            "-tune",
            "fastdecode",
            "-crf",
            "20",
            "-g",
            "1",
            "-bf",
            "0",
        ]);
    } else {
        command.args(["-vn"]);
    }
    if probe.has_audio {
        command.args(["-map", "0:a:0?", "-c:a", "aac", "-b:a", "160k", "-ac", "2"]);
    }
    command
        .args(["-movflags", "+faststart", "-progress", "pipe:1"])
        .arg(&tmp)
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
        let _ = std::fs::remove_file(&tmp);
        let last = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("proxy encode failed");
        return Err(format!("proxy: {}", last.trim()));
    }
    std::fs::rename(&tmp, out).map_err(|error| error.to_string())
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
        .args(["-hide_banner", "-loglevel", "error", "-y", "-skip_frame", "nokey", "-i"])
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
    let pcm = run(Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-i"])
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
        ]))?;
    let samples: Vec<f32> = pcm
        .as_chunks::<4>()
        .0
        .iter()
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();
    let peaks: Vec<u8> = samples
        .chunks(40)
        .map(|bucket| {
            let peak = bucket
                .iter()
                .fold(0.0_f32, |max, value| max.max(value.abs()));
            (peak.min(1.0).sqrt() * 255.0).round() as u8
        })
        .collect();
    let tmp = out.with_extension("partial");
    std::fs::write(&tmp, peaks).map_err(|error| error.to_string())?;
    std::fs::rename(tmp, out).map_err(|error| error.to_string())
}
