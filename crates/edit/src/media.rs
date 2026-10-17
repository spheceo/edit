//! Background media work: which previews, thumbnail strips, waveforms
//! and transcripts a file still needs, their statuses (sent as `media`
//! events), and the limits on how many run at once. Making them is
//! `edit_engine::media`'s (re-exported here).

use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};

use edit_core::MediaKind;
use serde::Serialize;
use serde_json::{json, Value};

pub use edit_engine::media::*;

use crate::store::Store;

/// Shared across proxies, thumbnails and optional optical flow. Independent
/// per-feature limits used to add up to more RAM than an 8 GB Mac has.
pub fn background_slots() -> &'static tokio::sync::Semaphore {
    static SLOTS: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    SLOTS.get_or_init(|| tokio::sync::Semaphore::new(1))
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
    /// The light preview (720p, ~1.5 Mbit/s) for watching from another machine.
    pub light: Stage,
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
    processing: Mutex<HashSet<String>>,
}

impl Processor {
    pub fn new(store: Arc<Store>) -> Arc<Self> {
        Arc::new(Self {
            store,
            status: Mutex::new(HashMap::new()),
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
            light: dir.join("preview-light.mp4"),
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
            .and_then(|meta| meta.get("count").and_then(Value::as_u64))
            .unwrap_or(0) as u32;
        let proxied = paths.proxy_done.is_file();
        MediaStatus {
            proxy: if proxied {
                Stage::Ready
            } else {
                Stage::Pending
            },
            proxy_progress: if proxied { 1.0 } else { 0.0 },
            light: if paths.light.is_file() {
                Stage::Ready
            } else {
                Stage::Pending
            },
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
        if probe.kind == MediaKind::Image {
            self.set(&source, |status| {
                status.proxy = Stage::Skipped;
                status.light = Stage::Skipped;
                status.peaks = Stage::Skipped;
            });
        }
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
            // Small ImageIO thumbnails need not sit behind minutes of video
            // proxy work. They have their own single, bounded decoder slot.
            static IMAGES: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
            let slots = if probe.kind == MediaKind::Image {
                IMAGES.get_or_init(|| tokio::sync::Semaphore::new(1))
            } else {
                background_slots()
            };
            let Ok(_permit) = slots.acquire().await else {
                return;
            };
            let worker = Arc::clone(&this);
            let job_source = source.clone();
            let outcome = tokio::task::spawn_blocking(move || {
                let status = worker.status(&source);
                let paths = worker.paths(&source);
                if matches!(probe.kind, MediaKind::Video | MediaKind::Image)
                    && status.thumbs != Stage::Ready
                {
                    worker.set(&source, |status| status.thumbs = Stage::Working);
                    match crate::diag::time_on(
                        "media",
                        "media: thumbnails",
                        &source.to_string_lossy(),
                        || {
                            if probe.kind == MediaKind::Image {
                                make_image_thumbs(&source, &paths)
                            } else {
                                make_thumbs(&source, &probe, &paths)
                            }
                        },
                    ) {
                        Ok(count) => worker.set(&source, |status| {
                            status.thumbs = Stage::Ready;
                            status.thumb_count = count;
                        }),
                        Err(error) => worker.set(&source, |status| {
                            status.thumbs = Stage::Failed;
                            status.error = Some(error);
                        }),
                    }
                } else if !matches!(probe.kind, MediaKind::Video | MediaKind::Image) {
                    worker.set(&source, |status| status.thumbs = Stage::Skipped);
                }
                if probe.has_audio && status.peaks != Stage::Ready {
                    worker.set(&source, |status| status.peaks = Stage::Working);
                    match crate::diag::time_on(
                        "media",
                        "media: waveform",
                        &source.to_string_lossy(),
                        || make_peaks(&source, &paths.peaks),
                    ) {
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
                    // A cloud proxy already is a preview: linked, not encoded again.
                    let cloud =
                        crate::cloud_media::is_local_copy(&worker.store.cache_dir(), &source);
                    match crate::diag::time_on(
                        "media",
                        "media: preview copy",
                        &source.to_string_lossy(),
                        || {
                            if cloud && probe.kind == MediaKind::Video {
                                return preview_from_cloud_proxy(&source, &probe, &paths);
                            }
                            make_proxy(&source, &probe, &paths, |progress| {
                                worker.set(&source, |status| status.proxy_progress = progress)
                            })
                        },
                    ) {
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
                // Then the light one, from the preview (already scaled and tagged).
                let proxied = worker.status(&source).proxy == Stage::Ready;
                if probe.kind != MediaKind::Video {
                    worker.set(&source, |status| status.light = Stage::Skipped);
                } else if proxied && !paths.light.is_file() {
                    worker.set(&source, |status| status.light = Stage::Working);
                    match crate::diag::time_on(
                        "media",
                        "media: light preview",
                        &source.to_string_lossy(),
                        || make_light(&source, &paths, &probe),
                    ) {
                        Ok(()) => worker.set(&source, |status| status.light = Stage::Ready),
                        Err(error) => worker.set(&source, |status| {
                            status.light = Stage::Failed;
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
                crate::diag::error(
                    "media",
                    format!("processing {} crashed: {message}", job_source.display()),
                );
                this.set(&job_source, |status| {
                    for stage in [
                        &mut status.thumbs,
                        &mut status.peaks,
                        &mut status.proxy,
                        &mut status.light,
                    ] {
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
                crate::diag::time_on(
                    "media",
                    "media: transcription",
                    &job_source.to_string_lossy(),
                    || crate::transcribe::run(&job_source, &target),
                )
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

/// [`edit_engine::media::make_cloud_proxy`], its error scrubbed: a
/// presigned URL in it is a credential.
pub fn make_cloud_proxy(source: &Path, probe: &Probe, out: &Path) -> Result<(), String> {
    edit_engine::media::make_cloud_proxy(source, probe, out)
        .map_err(|error| crate::cloud_media::scrub(&error))
}

fn make_thumbs(source: &Path, probe: &Probe, paths: &CachePaths) -> Result<u32, String> {
    let wanted = ((probe.duration / 2.0).ceil() as u32).clamp(1, 120);
    let interval = (probe.duration / f64::from(wanted)).max(0.05);
    // Keyframes only (fast), at most one per interval. Sparse keyframes yield
    // fewer frames, so count what came out before tiling.
    let frames_dir = paths.thumbs.with_extension("frames");
    let _ = std::fs::remove_dir_all(&frames_dir);
    std::fs::create_dir_all(&frames_dir).map_err(|error| error.to_string())?;
    run(Command::new(crate::tools::ffmpeg())
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
    let result = run(Command::new(crate::tools::ffmpeg())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-threads",
            "2",
            "-filter_threads",
            "1",
            "-i",
        ])
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
