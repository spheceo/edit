//! Footage that's mostly pixelated or blurred: a redacted stretch of a
//! bodycam (a mosaic over a whole room). Fine in the footage proper, where
//! the people speaking carry it, but noise as B-roll under narration, so
//! the plan's audit flags such B-roll (`censored_broll`).
//!
//! Each file is read once, a small greyscale frame a second (the light
//! preview's keyframes when it has one), and every second is judged from
//! how flat the picture is: a mosaic or a heavy blur leaves almost no
//! difference between neighbouring pixels, where real footage, even dark,
//! has detail everywhere. Kept as `<cache>/<media key>/censor-v1.bin`, one
//! byte a second (1 censored, 0 not).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};

use edit_core::{ClipContent, MediaKind, Project, TrackKind};
use parking_lot::Mutex;
use serde_json::{json, Value};

const FILE: &str = "censor-v1.bin";
const WIDE: usize = 128;
const HIGH: usize = 72;
/// A frame is censored when at least this share of neighbouring pixels
/// differ by 2 levels or less...
const FLAT: f64 = 0.78;
/// ...the average difference is this small (real footage: 5–14)...
const DETAIL: f64 = 3.5;
/// ...and it isn't just a dark or blank frame (a mosaic keeps its contrast).
const CONTRAST: f64 = 15.0;
/// B-roll is flagged when this share of its seconds are censored.
const SHARE: f64 = 0.6;

fn memory() -> &'static Mutex<HashMap<PathBuf, Arc<Vec<u8>>>> {
    static MEMORY: OnceLock<Mutex<HashMap<PathBuf, Arc<Vec<u8>>>>> = OnceLock::new();
    MEMORY.get_or_init(Default::default)
}

fn pending() -> &'static Mutex<HashSet<PathBuf>> {
    static PENDING: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

/// One analysis at a time: they're background work beside the edit.
fn running() -> &'static Mutex<()> {
    static RUNNING: OnceLock<Mutex<()>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

/// Whether a small greyscale frame (WIDE × HIGH) is mostly pixelated or blurred.
pub fn censored(frame: &[u8]) -> bool {
    if frame.len() < WIDE * HIGH {
        return false;
    }
    let at = |x: usize, y: usize| f64::from(frame.get(y * WIDE + x).copied().unwrap_or(0));
    let (mut flat, mut total, mut sum) = (0usize, 0usize, 0.0);
    for y in 0..HIGH {
        for x in 0..WIDE {
            let here = at(x, y);
            for (nx, ny) in [(x + 1, y), (x, y + 1)] {
                if nx >= WIDE || ny >= HIGH {
                    continue;
                }
                let difference = (at(nx, ny) - here).abs();
                total += 1;
                sum += difference;
                if difference <= 2.0 {
                    flat += 1;
                }
            }
        }
    }
    let count = (WIDE * HIGH) as f64;
    let mean = frame.iter().map(|&value| f64::from(value)).sum::<f64>() / count;
    let spread = (frame
        .iter()
        .map(|&value| (f64::from(value) - mean).powi(2))
        .sum::<f64>()
        / count)
        .sqrt();
    let total = total.max(1) as f64;
    flat as f64 / total >= FLAT && sum / total <= DETAIL && spread >= CONTRAST
}

fn file(cache: &Path, source: &Path) -> PathBuf {
    cache.join(crate::media::media_key(source)).join(FILE)
}

/// The file's seconds (1 censored, 0 not), once it's been read.
pub fn seconds(cache: &Path, source: &Path) -> Option<Arc<Vec<u8>>> {
    let path = file(cache, source);
    if let Some(found) = memory().lock().get(&path) {
        return Some(Arc::clone(found));
    }
    let bytes = Arc::new(std::fs::read(&path).ok()?);
    memory().lock().insert(path, Arc::clone(&bytes));
    Some(bytes)
}

/// Reads the file in the background unless it's read or being read.
pub fn analyse_in_background(cache: PathBuf, source: PathBuf) {
    let path = file(&cache, &source);
    if path.is_file() || !pending().lock().insert(path.clone()) {
        return;
    }
    std::thread::spawn(move || {
        let _turn = running().lock();
        let result = crate::diag::time_on(
            "media",
            "censor: analyse",
            &source.to_string_lossy(),
            || analyse(&cache, &source),
        );
        match result {
            Ok(seconds) => {
                if let Some(dir) = path.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = crate::store::write_atomic(&path, &seconds);
                memory().lock().insert(path.clone(), Arc::new(seconds));
            }
            Err(error) => crate::diag::warn(
                "media",
                format!(
                    "couldn't check {} for censored stretches: {error}",
                    source.display()
                ),
            ),
        }
        pending().lock().remove(&path);
    });
}

fn analyse(cache: &Path, source: &Path) -> Result<Vec<u8>, String> {
    let light = crate::media::light_preview(cache, source);
    let mut command = Command::new(crate::tools::ffmpeg());
    command.args(["-hide_banner", "-loglevel", "error"]);
    // The light preview has a keyframe every half second: only those are decoded.
    if light.is_some() {
        command.args(["-skip_frame", "nokey"]);
    }
    let output = command
        .arg("-i")
        .arg(light.as_deref().unwrap_or(source))
        .args([
            "-map",
            "0:v:0",
            "-vf",
            &format!("fps=1,scale={WIDE}:{HIGH},format=gray"),
            "-f",
            "rawvideo",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    Ok(output
        .stdout
        .chunks_exact(WIDE * HIGH)
        .map(|frame| u8::from(censored(frame)))
        .collect())
}

/// B-roll (video above the footage track) that's mostly censored, from the
/// files already read; the rest are started in the background when `start`
/// and listed as pending.
pub fn issues(project: &Project, cache: &Path, start: bool) -> (Vec<Value>, Vec<String>) {
    let base = project
        .tracks
        .iter()
        .find(|track| track.kind == TrackKind::Video)
        .map(|track| track.id.as_str());
    let fps = project.fps();
    let mut issues = Vec::new();
    let mut waiting = Vec::new();
    for clip in &project.clips {
        if Some(clip.track.as_str()) == base
            || project.track(&clip.track).is_none_or(|track| track.hidden)
        {
            continue;
        }
        let ClipContent::Video {
            media,
            source_in,
            speed,
            ..
        } = &clip.content
        else {
            continue;
        };
        let Some(media) = project
            .media(media)
            .filter(|media| media.kind == MediaKind::Video)
        else {
            continue;
        };
        let source = Path::new(&media.path);
        let Some(seconds) = seconds(cache, source) else {
            if start && source.is_file() {
                analyse_in_background(cache.to_path_buf(), source.to_path_buf());
            }
            if !waiting.contains(&media.id) {
                waiting.push(media.id.clone());
            }
            continue;
        };
        let to = source_in + clip.duration as f64 / fps * speed;
        let span: Vec<u8> = (source_in.floor() as usize
            ..(to.ceil() as usize).max(source_in.floor() as usize + 1))
            .filter_map(|second| seconds.get(second).copied())
            .collect();
        if span.is_empty() {
            continue;
        }
        let share = span.iter().filter(|&&second| second == 1).count() as f64 / span.len() as f64;
        if share >= SHARE {
            issues.push(json!({"kind":"censored_broll", "clip":clip.id, "start":clip.start,
                "media":media.id, "source_seconds":[(source_in * 10.0).round() / 10.0, (to * 10.0).round() / 10.0],
                "censored_share":(share * 100.0).round() / 100.0}));
        }
    }
    (issues, waiting)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frame of blocks (a mosaic), of noise-like detail, and dark.
    fn frame(kind: &str) -> Vec<u8> {
        let mut seed = 7u32;
        let mut noise = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            (seed % 256) as u8
        };
        (0..WIDE * HIGH)
            .map(|index| {
                let (x, y) = (index % WIDE, index / WIDE);
                match kind {
                    "mosaic" => (60 + ((x / 11) * 9 + (y / 11) * 23) % 120) as u8,
                    "detail" => noise() / 2 + ((x + y) % 64) as u8,
                    _ => 12,
                }
            })
            .collect()
    }

    /// Audits a real project read-only (its media cache read, results kept
    /// in a temp folder): `EDIT_AUDIT_PROJECT=<project.json>
    /// EDIT_AUDIT_CACHE=<~/.edit/cache> cargo test -p edit
    /// censor::tests::audit_a_real_project -- --ignored --nocapture`.
    #[test]
    #[ignore = "reads a real project and its media"]
    fn audit_a_real_project() {
        let project: Project = serde_json::from_slice(
            &std::fs::read(std::env::var("EDIT_AUDIT_PROJECT").unwrap()).unwrap(),
        )
        .unwrap();
        let cache = PathBuf::from(std::env::var("EDIT_AUDIT_CACHE").unwrap());
        let scratch = std::env::temp_dir().join(format!("edit-audit-{}", std::process::id()));
        let mut transcripts = HashMap::new();
        // A file on the media drive is keyed by its place in the data folder.
        let drive = std::env::var("EDIT_AUDIT_MEDIA_DIR")
            .ok()
            .map(PathBuf::from);
        let home = cache.parent().map(Path::to_path_buf).unwrap_or_default();
        for media in &project.media {
            let source = Path::new(&media.path);
            let name = drive
                .as_ref()
                .and_then(|drive| source.strip_prefix(drive).ok())
                .map_or_else(|| source.to_path_buf(), |rest| home.join(rest));
            let key = cache.join(crate::media::key_of(&name, source));
            if let Ok(bytes) = std::fs::read(key.join("transcript.json")) {
                if let Ok(transcript) = serde_json::from_slice(&bytes) {
                    transcripts.insert(media.id.clone(), transcript);
                }
            }
            if media.kind == MediaKind::Video
                && source.is_file()
                && std::env::var_os("EDIT_AUDIT_SKIP_CENSOR").is_none()
            {
                let seconds = analyse(&cache, source).unwrap();
                let path = file(&scratch, source);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(&path, &seconds).unwrap();
                let censored = seconds.iter().filter(|&&second| second == 1).count();
                eprintln!(
                    "{} {}: {censored} of {} s censored",
                    media.id,
                    media.name,
                    seconds.len()
                );
            }
        }
        let (issues, waiting) = issues(&project, &scratch, false);
        eprintln!("censored: {issues:#?} waiting {waiting:?}");
        eprintln!(
            "callouts: {:#?}",
            crate::edit_review::callout_timing(&project, &transcripts)
        );
        let _ = std::fs::remove_dir_all(scratch);
    }

    #[test]
    fn mosaics_are_censored_and_real_or_dark_frames_are_not() {
        assert!(censored(&frame("mosaic")));
        assert!(!censored(&frame("detail")));
        assert!(!censored(&frame("dark")));
    }

    #[test]
    fn broll_over_a_censored_stretch_is_flagged() {
        let mut p = Project::new("p".into(), "censor".into(), Default::default());
        let cache = std::env::temp_dir().join(format!("edit-censor-{}", std::process::id()));
        let source = cache.join("bodycam.mp4");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(&source, b"not really a video").unwrap();
        p.media.push(serde_json::from_value(json!({"id":"m1","name":"bodycam","path":source,"kind":"video","duration":60.0,"width":1920,"height":1080,"has_audio":true})).unwrap());
        // Seconds 10–19 redacted.
        let mut seconds = vec![0u8; 60];
        for second in &mut seconds[10..20] {
            *second = 1;
        }
        let path = file(&cache, &source);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &seconds).unwrap();
        p.clips.push(serde_json::from_value(json!({"id":"footage","track":"v1","type":"video","media":"m1","source_in":10.0,"start":0,"duration":300})).unwrap());
        p.clips.push(serde_json::from_value(json!({"id":"redacted","track":"v2","type":"video","media":"m1","source_in":11.0,"speed":0.5,"start":0,"duration":120})).unwrap());
        p.clips.push(serde_json::from_value(json!({"id":"clear","track":"v2","type":"video","media":"m1","source_in":30.0,"speed":0.5,"start":120,"duration":120})).unwrap());
        let (issues, waiting) = issues(&p, &cache, false);
        assert!(waiting.is_empty());
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert_eq!(issues[0]["clip"], "redacted");
        std::fs::remove_dir_all(cache).unwrap();
    }
}
