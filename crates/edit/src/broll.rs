//! What cut-ins are made of: B-roll picked from the source footage (looked
//! through and read, not just the timeline), slowed down smoothly, stills
//! turned into footage, and 3D map views of the
//! places a story happens, from Google's photorealistic 3D map drawn in the
//! local Chrome.

use parking_lot::Mutex;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::Path as UrlPath;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use edit_core::{ClipContent, Media, Project};
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::render::RgbaImage;
use crate::server::App;

/// Identifies Edit to the services it calls.
const USER_AGENT: &str = "edit-video-editor/0.1 (+https://github.com/spheceo/edit)";

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"];

/// A still image (png, jpg…), which imports as a clip of footage.
pub fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// Seconds of footage a still becomes: room to hold it, push in and trim.
const STILL_SECONDS: u32 = 30;

fn fingerprint(parts: &[&str]) -> String {
    let mut hasher = DefaultHasher::new();
    for part in parts {
        part.hash(&mut hasher);
    }
    format!("{:012x}", hasher.finish() & 0xffff_ffff_ffff)
}

/// A still as 30 s of steady 30 fps footage (even-sized, high quality), so it
/// plays, scales, grades and exports like any clip. Made once per image.
pub fn still_video(image: &Path, dir: &Path) -> Result<PathBuf, String> {
    let meta = std::fs::metadata(image).map_err(|error| format!("{}: {error}", image.display()))?;
    let stem = image.file_stem().map_or_else(
        || "still".to_owned(),
        |stem| stem.to_string_lossy().into_owned(),
    );
    let key = fingerprint(&[
        &image.to_string_lossy(),
        &meta.len().to_string(),
        &format!("{:?}", meta.modified().ok()),
    ]);
    std::fs::create_dir_all(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    let out = dir.join(format!("{stem}-{key}.mp4"));
    if out.is_file() {
        return Ok(out);
    }
    let partial = dir.join(format!("{stem}-{key}.partial.mp4"));
    let status = Command::new(crate::tools::ffmpeg())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-loop",
            "1",
            "-framerate",
            "30",
            "-i",
        ])
        .arg(image)
        .args([
            "-t",
            &STILL_SECONDS.to_string(),
            "-vf",
            "scale='min(3840,trunc(iw/2)*2)':-2:flags=lanczos,format=yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "12",
            "-tune",
            "stillimage",
            "-r",
            "30",
            "-an",
            "-movflags",
            "+faststart",
        ])
        .arg(&partial)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    if !status.status.success() {
        let _ = std::fs::remove_file(&partial);
        return Err(format!(
            "couldn't turn {} into footage: {}",
            image.display(),
            String::from_utf8_lossy(&status.stderr).trim()
        ));
    }
    std::fs::rename(&partial, &out).map_err(|error| error.to_string())?;
    Ok(out)
}

/// Evenly spaced frames of a media file between `start` and `end` (seconds of
/// the file), at most 480 px, decoded side by side (from the light preview in
/// `cache` when it's made).
pub fn media_frames(
    media: &Media,
    cache: Option<&Path>,
    start: f64,
    end: f64,
    count: usize,
) -> Result<(Vec<RgbaImage>, Vec<f64>), String> {
    crate::render::media_frames(media, cache, start, end, count, 480)
}

/// A media file's words, transcribing it first if needed.
pub async fn transcript(app: &App, media: &Media) -> Result<crate::transcribe::Transcript, String> {
    if !media.has_audio {
        return Err(format!("{} has no sound", media.name));
    }
    let path = PathBuf::from(&media.path);
    app.media.transcribe(path.clone(), true);
    let started = Instant::now();
    loop {
        let status = app.media.status(&path);
        match status.transcript {
            crate::media::Stage::Ready => {
                let bytes = std::fs::read(app.media.paths(&path).transcript)
                    .map_err(|error| error.to_string())?;
                return serde_json::from_slice(&bytes).map_err(|error| error.to_string());
            }
            crate::media::Stage::Failed => {
                return Err(format!(
                    "couldn't transcribe {}: {}",
                    media.name,
                    status.transcript_error.unwrap_or_default()
                ))
            }
            _ if started.elapsed() > Duration::from_secs(15 * 60) => {
                return Err(format!("transcribing {} is taking too long", media.name))
            }
            _ => tokio::time::sleep(Duration::from_secs(2)).await,
        }
    }
}

/// What's said in a media file between `from` and `to` (its own seconds), as
/// phrases with their times and who says them, or word by word (`words`) for
/// timing something to an exact word.
pub async fn media_transcript(
    app: &App,
    media: &Media,
    from: f64,
    to: f64,
    words: bool,
) -> Result<String, String> {
    let transcript = transcript(app, media).await?;
    if words {
        let lines: Vec<String> = transcript
            .words
            .iter()
            .filter(|word| word.start >= from && word.start < to)
            .map(|word| format!("{:.2}–{:.2} {}", word.start, word.end, word.text))
            .collect();
        return Ok(if lines.is_empty() {
            format!(
                "nothing is said in {} between {from:.1}s and {to:.1}s",
                media.name
            )
        } else {
            lines.join("\n")
        });
    }
    let mut out = String::new();
    let mut phrase: Option<(f64, Option<String>, String, f64)> = None;
    let flush = |out: &mut String, phrase: &mut Option<(f64, Option<String>, String, f64)>| {
        if let Some((start, speaker, words, end)) = phrase.take() {
            let who = speaker.map_or_else(String::new, |speaker| format!(" ({speaker})"));
            out.push_str(&format!("[{start:.2}–{end:.2}s]{who} {words}\n"));
        }
    };
    for word in transcript
        .words
        .iter()
        .filter(|word| word.start >= from && word.start < to)
    {
        let speaker = word.speaker.as_ref().map(|voice| {
            transcript
                .speakers
                .get(voice)
                .cloned()
                .unwrap_or_else(|| voice.clone())
        });
        let breaks = phrase
            .as_ref()
            .is_none_or(|(_, voice, _, end)| word.start - end > 0.8 || *voice != speaker);
        if breaks {
            flush(&mut out, &mut phrase);
            phrase = Some((word.start, speaker, word.text.clone(), word.end));
        } else if let Some((_, _, words, end)) = phrase.as_mut() {
            words.push(' ');
            words.push_str(&word.text);
            *end = word.end;
        }
    }
    flush(&mut out, &mut phrase);
    Ok(if out.is_empty() {
        format!(
            "nothing is said in {} between {from:.1}s and {to:.1}s",
            media.name
        )
    } else {
        out
    })
}

/// Slows a slowed clip smoothly: the stretch of its media it plays is rendered
/// at its speed with new frames made between the real ones (motion
/// interpolation, like After Effects' pixel-motion frame blending), and the
/// clip plays that at normal speed. Same timing, no stutter.
pub async fn smooth_slow_motion(
    app: &App,
    project_id: &str,
    clip_id: &str,
) -> Result<Value, String> {
    let project = app.store.get(project_id).ok_or("no such project")?.project;
    let clip = project
        .clip(clip_id)
        .ok_or_else(|| format!("no clip {clip_id}"))?
        .clone();
    let ClipContent::Video {
        media,
        source_in,
        speed,
        ..
    } = &clip.content
    else {
        return Err("only video clips can be slowed smoothly".to_owned());
    };
    if *speed >= 0.999 {
        return Err(format!(
            "{clip_id} plays at {speed}×; slow it first (speed below 1, e.g. 0.5)"
        ));
    }
    let source = project
        .media(media)
        .ok_or("the clip's media is missing")?
        .clone();
    let fps = project.fps();
    // Interpolation loses a few frames at the ends: render a little more than
    // the clip plays, so the result always covers it at 1×.
    let length = (clip.duration as f64 / fps + 0.25) * speed;
    let dir = app.store.uploads_dir(project_id)?.join("smooth");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let stem = Path::new(&source.name).file_stem().map_or_else(
        || "clip".to_owned(),
        |stem| stem.to_string_lossy().into_owned(),
    );
    let key = fingerprint(&[
        "bounded-optical-flow-v2",
        &crate::media::media_key(Path::new(&source.path)),
        &format!("{}x{}", project.settings.width, project.settings.height),
        // Named as its cache key names it, so a move to the media drive keeps it.
        &crate::media_drive::key_path(Path::new(&source.path)).to_string_lossy(),
        &format!("{source_in:.4}"),
        &format!("{length:.4}"),
        &format!("{speed:.4}"),
        &format!("{fps}"),
    ]);
    let out = dir.join(format!("{stem}-{speed:.2}x-{key}.mp4"));
    if !out.is_file() {
        // A few renders at a time (see `smoothing_slots`); the rest wait their turn.
        let _slot = smoothing_slots()
            .acquire()
            .await
            .map_err(|error| error.to_string())?;
        let _work = crate::media::background_slots()
            .acquire()
            .await
            .map_err(|error| error.to_string())?;
        let partial = dir.join(format!("{stem}-{key}.partial.mp4"));
        let (input, start) = (PathBuf::from(&source.path), *source_in);
        let speed = *speed;
        // Never two renders into one file: a second ask waits for the first.
        if out.is_file() {
            return swap_in_smooth(app, project_id, &clip, &out, fps).await;
        }
        // A queued request may already be obsolete. Do not spend minutes on it.
        let current = app.store.get(project_id).ok_or("project vanished")?.project;
        let current = current
            .clip(clip_id)
            .ok_or("clip was removed before smoothing")?;
        if source_of(&current.content) != source_of(&clip.content)
            || current.duration > clip.duration
        {
            return Err(format!(
                "{clip_id} changed before smoothing started; skipped"
            ));
        }
        let (width, height) = (project.settings.width, project.settings.height);
        let mut command = tokio::process::Command::new(crate::tools::ffmpeg());
        command.args(["-hide_banner", "-loglevel", "error", "-y", "-threads", "2", "-filter_threads", "1",
            "-ss", &format!("{start:.4}"), "-t", &format!("{length:.4}"), "-i"])
            .arg(&input)
            .args(["-an", "-vf", &format!(
                "scale=w='min({width},iw)':h='min({height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setpts=PTS/{speed:.6},minterpolate=fps={fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,format=yuv420p"),
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "15", "-threads", "2", "-movflags", "+faststart"])
            .arg(&partial).stdin(Stdio::null()).kill_on_drop(true);
        let output = match tokio::time::timeout(Duration::from_secs(120), command.output()).await {
            Ok(Ok(output)) => output,
            result => {
                let _ = std::fs::remove_file(&partial);
                return Err(match result {
                    Ok(Err(error)) => format!("ffmpeg: {error}"),
                    _ => "optical flow exceeded 120 seconds; kept the original slowed clip"
                        .to_owned(),
                });
            }
        };
        if !output.status.success() {
            let _ = std::fs::remove_file(&partial);
            return Err(format!(
                "couldn't slow it smoothly: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        std::fs::rename(&partial, &out).map_err(|error| error.to_string())?;
    }
    swap_in_smooth(app, project_id, &clip, &out, fps).await
}

/// Puts a smoothed render in place of the slowed stretch it was made from,
/// unless the clip has changed since (re-trimmed, re-timed, other media): the
/// render no longer matches it then, and it must be smoothed again.
async fn swap_in_smooth(
    app: &App,
    project_id: &str,
    rendered: &edit_core::Clip,
    out: &Path,
    fps: f64,
) -> Result<Value, String> {
    let current = app.store.get(project_id).ok_or("project vanished")?.project;
    let clip = current.clip(&rendered.id).ok_or("the clip went away")?;
    if source_of(&clip.content) != source_of(&rendered.content) || clip.duration > rendered.duration
    {
        return Err(format!(
            "{} changed while smoothing; kept the current clip",
            rendered.id
        ));
    }
    let path = out.to_owned();
    let probe = tokio::task::spawn_blocking(move || crate::media::probe(&path))
        .await
        .map_err(|error| error.to_string())??;
    let path = out.to_string_lossy().into_owned();
    let (_, done) = app.store.update(project_id, "agent", |project| {
        let clip = project.clip(&rendered.id).ok_or("the clip went away")?;
        if source_of(&clip.content) != source_of(&rendered.content)
            || clip.duration > rendered.duration
        {
            return Err(format!(
                "{} changed while smoothing; kept the current clip",
                rendered.id
            ));
        }
        let smooth = match project.media.iter().find(|media| media.path == path) {
            Some(media) => media.id.clone(),
            None => {
                let id = project.fresh_id("m");
                project.media.push(Media {
                    id: id.clone(),
                    name: out
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    path: path.clone(),
                    kind: probe.kind,
                    duration: probe.duration,
                    width: probe.width,
                    height: probe.height,
                    fps: probe.fps,
                    has_audio: probe.has_audio,
                    markers: Vec::new(),
                });
                id
            }
        };
        let clip = project.clip_mut(&rendered.id).ok_or("the clip went away")?;
        if let ClipContent::Video {
            media,
            source_in,
            speed,
            ..
        } = &mut clip.content
        {
            *media = smooth.clone();
            *source_in = 0.0;
            *speed = 1.0;
        }
        Ok(json!({"clip":rendered.id, "media":smooth, "seconds":clip.duration as f64 / fps}))
    })?;
    app.media.ensure(out.to_owned(), probe);
    Ok(done)
}

/// What a smoothing render was made from: media, in point and speed. (A
/// clip's position, scale or keyframes can change meanwhile.)
fn source_of(content: &ClipContent) -> Option<(&str, f64, f64)> {
    match content {
        ClipContent::Video {
            media,
            source_in,
            speed,
            ..
        } => Some((media.as_str(), *source_in, *speed)),
        _ => None,
    }
}

/// Optical flow is optional and uses one shared background slot. Serializing
/// it also prevents duplicate requests from writing the same cached file.
fn smoothing_slots() -> &'static tokio::sync::Semaphore {
    static SLOTS: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    SLOTS.get_or_init(|| tokio::sync::Semaphore::new(1))
}

/// Clips being smoothed in the background, by project.
fn smoothing() -> &'static Mutex<HashMap<String, HashSet<String>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, HashSet<String>>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

/// The clips of a project still being smoothed in the background.
/// Map shots still rendering (and any whose render failed) come after them,
/// by media: "m7 (map view rendering)".
pub fn smoothing_pending(project_id: &str) -> Vec<String> {
    let mut pending: Vec<String> = smoothing()
        .lock()
        .get(project_id)
        .map(|clips| clips.iter().cloned().collect())
        .unwrap_or_default();
    pending.sort();
    let mut maps: Vec<String> = maps_pending()
        .lock()
        .get(project_id)
        .map(|maps| {
            maps.values()
                .map(|map| match &map.error {
                    None => format!("{} (map view rendering)", map.media),
                    Some(error) => format!(
                        "{} (map view failed: {error}; map_view again with the same arguments carries on from its frames)",
                        map.media
                    ),
                })
                .collect()
        })
        .unwrap_or_default();
    maps.sort();
    pending.extend(maps);
    pending
}

/// Smooths slowed clips without waiting: each swaps in when its render is
/// done (a few render at once). A clip already being smoothed is left to it.
/// Returns the clips started.
pub fn smooth_in_background(app: &App, project_id: &str, clip_ids: &[String]) -> Vec<String> {
    let mut started = Vec::new();
    for clip_id in clip_ids {
        let fresh = smoothing()
            .lock()
            .entry(project_id.to_owned())
            .or_default()
            .insert(clip_id.clone());
        if !fresh {
            continue;
        }
        started.push(clip_id.clone());
        let (app, project_id, clip_id) = (app.clone(), project_id.to_owned(), clip_id.clone());
        tokio::spawn(async move {
            let done = crate::diag::time_async(
                "agent",
                "smooth slow motion (background)",
                smooth_slow_motion(&app, &project_id, &clip_id),
            )
            .await;
            if let Err(error) = done {
                crate::diag::warn(
                    "agent",
                    format!("smoothing {clip_id} in {project_id}: {error}"),
                );
            }
            let mut pending = smoothing().lock();
            if let Some(clips) = pending.get_mut(&project_id) {
                clips.remove(&clip_id);
                if clips.is_empty() {
                    pending.remove(&project_id);
                }
            }
        });
    }
    started
}

/// Waits (up to `limit`) until a project's background smoothing is done, so
/// an export renders the smooth shots. Returns false if it timed out.
pub async fn wait_for_smoothing(project_id: &str, limit: Duration) -> bool {
    let started = Instant::now();
    let busy = || {
        smoothing()
            .lock()
            .get(project_id)
            .is_some_and(|clips| !clips.is_empty())
            || maps_rendering(project_id)
    };
    while busy() {
        if started.elapsed() > limit {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    true
}

/// Where a place is, from Google's geocoding through the relay (only Google's
/// may be shown with its tiles): lat, lon and its full address.
fn geocode(place: &str) -> Result<(f64, f64, String), String> {
    let url = format!(
        "{}/v1/geocode?address={}",
        crate::relay::url(),
        urlencode(place)
    );
    let found: Value = serde_json::from_str(&fetch(&url)?)
        .map_err(|error| format!("unexpected answer from the map search: {error}"))?;
    let status = found.get("status").and_then(Value::as_str);
    match status {
        Some("OK") => {}
        Some("ZERO_RESULTS") => {
            return Err(format!(
                "couldn't find \"{place}\" on the map; try a fuller address"
            ))
        }
        _ => {
            return Err(format!(
                "the map search failed: {}",
                found
                    .get("error_message")
                    .and_then(Value::as_str)
                    .or(found.get("error").and_then(Value::as_str))
                    .or(status)
                    .unwrap_or("no answer")
            ))
        }
    }
    let first = found.pointer("/results/0").unwrap_or(&Value::Null);
    let location = first.pointer("/geometry/location").unwrap_or(&Value::Null);
    Ok((
        location["lat"].as_f64().ok_or("no latitude")?,
        location["lng"].as_f64().ok_or("no longitude")?,
        first["formatted_address"]
            .as_str()
            .unwrap_or(place)
            .to_owned(),
    ))
}

/// The outline (lon, lat ring) of the building at a point, from Google.
fn building_outline(lat: f64, lon: f64) -> Option<Vec<[f64; 2]>> {
    let url = format!("{}/v1/outline?lat={lat}&lon={lon}", crate::relay::url());
    let found: Value = serde_json::from_str(&fetch(&url).ok()?).ok()?;
    outline_in(&found)
}

/// The first building's outer ring in a destinations answer: the place
/// itself if it is a building, else the building that holds it.
fn outline_in(found: &Value) -> Option<Vec<[f64; 2]>> {
    let destination = found["destinations"].get(0)?;
    let places = std::iter::once(&destination["primary"]).chain(
        destination["containingPlaces"]
            .as_array()
            .into_iter()
            .flatten(),
    );
    places
        .filter(|place| place["structureType"] == "BUILDING")
        .find_map(|place| {
            let polygon = &place["displayPolygon"];
            let ring = match polygon["type"].as_str()? {
                "Polygon" => polygon.pointer("/coordinates/0")?,
                "MultiPolygon" => polygon.pointer("/coordinates/0/0")?,
                _ => return None,
            };
            let ring: Vec<[f64; 2]> = ring
                .as_array()?
                .iter()
                .filter_map(|point| Some([point[0].as_f64()?, point[1].as_f64()?]))
                .collect();
            (ring.len() >= 4).then_some(ring)
        })
}

fn urlencode(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            b' ' => "+".to_owned(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn fetch(url: &str) -> Result<String, String> {
    let output = Command::new("curl")
        .args(["-sS", "--max-time", "30", "-A", USER_AGENT, url])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("curl: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "couldn't reach {}: {}",
            url.split('?').next().unwrap_or(url),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub(crate) fn chrome() -> Option<PathBuf> {
    [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|path| path.is_file())
}

/// Where this server answers; map pages open in Chrome against it.
pub static LISTENING: OnceLock<SocketAddr> = OnceLock::new();

/// The map page: Google's Photorealistic 3D Tiles (through the relay, which
/// holds the key) drawn by CesiumJS, graded darker with a vignette and the
/// place marked in glowing red. When the tiles are in, it
/// posts the picture back to its own address.
const MAP_PAGE: &str = include_str!("map_page.html");

/// A map picture and what the page measured, or what went wrong.
type MapShot = Result<(Vec<u8>, Value), String>;

/// Map pages waiting to be opened, who is waiting for their picture, and
/// where a moving shot's frames go.
struct MapJob {
    page: String,
    done: Option<oneshot::Sender<MapShot>>,
    /// A moving shot's first frame is in and where the building is in every
    /// frame is known: what the page measured so far.
    ready: Option<oneshot::Sender<Value>>,
    frames: PathBuf,
}

fn map_jobs() -> &'static Mutex<HashMap<String, MapJob>> {
    static JOBS: OnceLock<Mutex<HashMap<String, MapJob>>> = OnceLock::new();
    JOBS.get_or_init(Default::default)
}

/// `GET /api/maps/{token}`
pub async fn map_page(UrlPath(token): UrlPath<String>) -> Response {
    match map_jobs().lock().get(&token) {
        Some(job) => Html(job.page.clone()).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// `POST /api/maps/{token}/frame/{index}`: one frame of a moving shot (image/jpeg).
pub async fn map_frame(UrlPath((token, index)): UrlPath<(String, u32)>, body: Bytes) -> StatusCode {
    let Some(dir) = map_jobs().lock().get(&token).map(|job| job.frames.clone()) else {
        return StatusCode::NOT_FOUND;
    };
    // Whole frames only: an attempt cut short is resumed from what's there.
    let (partial, frame) = (
        dir.join(format!("frame-{index:05}.partial")),
        dir.join(frame_name(index as usize)),
    );
    match std::fs::write(&partial, body).and_then(|()| std::fs::rename(&partial, &frame)) {
        Ok(()) => StatusCode::NO_CONTENT,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn frame_name(index: usize) -> String {
    format!("frame-{index:05}.jpg")
}

/// The frames of a moving shot already in `dir` (whole JPEGs), from an
/// attempt that was cut short.
fn frames_had(dir: &Path, count: usize) -> Vec<usize> {
    (0..count)
        .filter(|index| {
            std::fs::read(dir.join(frame_name(*index))).is_ok_and(|bytes| {
                bytes.starts_with(&[0xFF, 0xD8]) && bytes.ends_with(&[0xFF, 0xD9])
            })
        })
        .collect()
}

/// `POST /api/maps/{token}`: the picture (image/png) with what the page measured
/// (`x-map-info`, JSON); for a moving shot, once its frames are in, just what it
/// measured (application/json); or what went wrong (text).
pub async fn map_shot(
    UrlPath(token): UrlPath<String>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    if headers
        .get("x-map-phase")
        .is_some_and(|phase| phase.as_bytes() == b"ready")
    {
        let ready = map_jobs()
            .lock()
            .get_mut(&token)
            .and_then(|job| job.ready.take());
        return match ready {
            Some(ready) => {
                let _ = ready.send(serde_json::from_slice(&body).unwrap_or_default());
                StatusCode::NO_CONTENT
            }
            None => StatusCode::NOT_FOUND,
        };
    }
    let waiting = map_jobs()
        .lock()
        .get_mut(&token)
        .and_then(|job| job.done.take());
    let Some(waiting) = waiting else {
        return StatusCode::NOT_FOUND;
    };
    let kind = headers
        .get(header::CONTENT_TYPE)
        .map(|kind| kind.as_bytes())
        .unwrap_or_default();
    let info: Value = headers
        .get("x-map-info")
        .and_then(|info| serde_json::from_slice(info.as_bytes()).ok())
        .unwrap_or_default();
    let _ = waiting.send(if kind.starts_with(b"image/png") {
        Ok((body.to_vec(), info))
    } else if kind.starts_with(b"application/json") {
        Ok((
            Vec::new(),
            serde_json::from_slice(&body).unwrap_or_default(),
        ))
    } else {
        Err(String::from_utf8_lossy(&body).into_owned())
    });
    StatusCode::NO_CONTENT
}

/// Opens the map page in headless Chrome and waits for its picture (or, for a
/// moving shot, its frames in `frames`).
async fn render_map(
    config: &Value,
    width: u32,
    height: u32,
    frames: &Path,
    ready: Option<oneshot::Sender<Value>>,
) -> MapShot {
    let browser = chrome().ok_or("map views need Google Chrome (or Chromium) installed")?;
    let address = LISTENING.get().ok_or("the server isn't listening yet")?;
    let host = if address.ip().is_unspecified() {
        "127.0.0.1".to_owned()
    } else if address.is_ipv6() {
        format!("[{}]", address.ip())
    } else {
        address.ip().to_string()
    };
    let token = fingerprint(&[
        &config.to_string(),
        &format!("{:?}", Instant::now()),
        &std::process::id().to_string(),
    ]);
    let (sender, receiver) = oneshot::channel();
    let page = MAP_PAGE.replace("__CONFIG__", &config.to_string().replace("</", "<\\/"));
    map_jobs().lock().insert(
        token.clone(),
        MapJob {
            page,
            done: Some(sender),
            ready,
            frames: frames.to_owned(),
        },
    );
    let profile = std::env::temp_dir().join(format!("edit-map-{token}"));
    let mut command = tokio::process::Command::new(&browser);
    command
        .args([
            "--headless=new",
            "--hide-scrollbars",
            "--no-first-run",
            "--no-default-browser-check",
            "--mute-audio",
            // Room for the page at full size: headless windows lose some
            // height to the browser's own frame.
            &format!("--window-size={},{}", width + 64, height + 200),
            &format!("--user-data-dir={}", profile.display()),
        ])
        .args(cfg!(target_os = "macos").then_some("--use-angle=metal"))
        .arg(format!("http://{host}:{}/api/maps/{token}", address.port()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let answer = match command.spawn() {
        Ok(mut child) => {
            // A moving shot waits on tiles for every frame.
            let count = config["frames"].as_u64().unwrap_or(0);
            let wait = Duration::from_secs(150 + 2 * count);
            let answer = tokio::time::timeout(wait, receiver).await;
            let _ = child.kill().await;
            match answer {
                Ok(Ok(answer)) => answer.map_err(|error| format!("the map didn't render: {error}")),
                Ok(Err(_)) => Err("the map page went away".to_owned()),
                Err(_) => Err("the map took too long to load".to_owned()),
            }
        }
        Err(error) => Err(format!("chrome: {error}")),
    };
    map_jobs().lock().remove(&token);
    let _ = std::fs::remove_dir_all(&profile);
    answer
}

/// How long map_view waits for a moving shot's first frame and building
/// track before answering that it's still loading.
const MAP_READY_WAIT: Duration = Duration::from_secs(180);
/// How long an export waits for map shots still rendering.
pub const MAP_EXPORT_WAIT: Duration = Duration::from_secs(600);

/// A moving map shot being made in the background, by its key.
struct MapRender {
    /// What the page measured once the first frame was in (or why it failed first).
    ready: tokio::sync::watch::Sender<Option<Result<Value, String>>>,
    /// Projects whose stand-in becomes the footage when it's done.
    projects: Mutex<HashSet<String>>,
    /// Why it failed, once it has (read and written with `maps_pending`
    /// locked, so a stand-in registered as it fails still hears of it).
    failed: Mutex<Option<String>>,
}

fn map_renders() -> &'static Mutex<HashMap<String, std::sync::Arc<MapRender>>> {
    static RENDERS: OnceLock<Mutex<HashMap<String, std::sync::Arc<MapRender>>>> = OnceLock::new();
    RENDERS.get_or_init(Default::default)
}

/// A map shot's stand-in in a project: its media, and why its render failed
/// (None while it's still being made).
struct MapPending {
    media: String,
    error: Option<String>,
}

/// Map stand-ins by project, by the stand-in's path.
fn maps_pending() -> &'static Mutex<HashMap<String, HashMap<String, MapPending>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, HashMap<String, MapPending>>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

/// Whether any of a project's map shots is still being made.
fn maps_rendering(project_id: &str) -> bool {
    maps_pending()
        .lock()
        .get(project_id)
        .is_some_and(|maps| maps.values().any(|map| map.error.is_none()))
}

/// Whether a media file is a moving map shot's first frame standing in for it.
fn is_map_stand_in(path: &str) -> bool {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("map-") && name.ends_with("-first.jpg"))
}

/// Waits (up to `limit`) for a project's map shots still being made, so an
/// export has the footage rather than its stand-in. An error says why it
/// can't: one still rendering after `limit`, or a stand-in on the timeline
/// whose render failed or was cut short (Edit closed): never exported as a
/// still by mistake.
pub async fn wait_for_maps(app: &App, project_id: &str, limit: Duration) -> Result<(), String> {
    let started = Instant::now();
    while maps_rendering(project_id) {
        if started.elapsed() > limit {
            return Err(
                "a map view is still rendering; export again in a minute (get_project's smoothing lists it until it's done)"
                    .to_owned(),
            );
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let project = app.store.get(project_id).ok_or("no such project")?.project;
    let used: HashSet<&str> = project
        .clips
        .iter()
        .filter_map(|clip| clip.media_id())
        .collect();
    let pending = maps_pending().lock();
    let stuck: Vec<String> = project
        .media
        .iter()
        .filter(|media| used.contains(media.id.as_str()) && is_map_stand_in(&media.path))
        .map(|media| {
            let error = pending
                .get(project_id)
                .and_then(|maps| maps.values().find(|map| map.media == media.id))
                .and_then(|map| map.error.clone());
            match error {
                Some(error) => format!("{} (its render failed: {error})", media.id),
                None => format!("{} (its render was cut short)", media.id),
            }
        })
        .collect();
    if stuck.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "the map view {} is still only its first frame; call map_view again with the same arguments (it carries on from the frames it has), then export",
            stuck.join(", ")
        ))
    }
}

/// One map render (a headless Chrome with the 3D map) at a time: each takes
/// a gigabyte or so.
fn map_slot() -> &'static tokio::sync::Semaphore {
    static SLOT: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    SLOT.get_or_init(|| tokio::sync::Semaphore::new(1))
}

/// A tilted 3D view of `place` (or `lat`/`lon`) from Google's photorealistic
/// map, the building there in red, as footage in the project: by default a
/// moving shot (the camera circling the building and closing in), or a still.
/// Returns the media and where the building is. The same view again reuses the
/// footage (each new one is a billed map session).
///
/// A moving shot answers as soon as its first frame is in and the building's
/// place in every frame is known: its media is that first frame, standing in
/// while the rest renders in the background, and becomes the footage when
/// it's done (exports wait for it). A render cut short keeps its frames, and
/// the same call again carries on from them.
pub async fn map_view(app: &App, project_id: &str, args: &Value) -> Result<Value, String> {
    let project: Project = app.store.get(project_id).ok_or("no such project")?.project;
    let place = args["place"].as_str().map(str::to_owned);
    let given = args["lat"].as_f64().zip(args["lon"].as_f64());
    let range = args["range"].as_f64().unwrap_or(170.0).clamp(60.0, 3000.0);
    let pitch = args["pitch"].as_f64().unwrap_or(55.0).clamp(0.0, 80.0);
    let heading = args["heading"].as_f64().unwrap_or(-25.0);
    let mark = args["highlight"].as_bool().unwrap_or(true);
    let still = args["still"].as_bool().unwrap_or(false);
    let seconds = args["seconds"].as_f64().unwrap_or(6.0).clamp(1.0, 20.0);
    let highlight_after = args["highlight_after"]
        .as_f64()
        .unwrap_or(0.0)
        .clamp(0.0, seconds);
    let highlight_fade = args["highlight_fade"]
        .as_f64()
        .unwrap_or(0.0)
        .clamp(0.0, seconds);
    let orbit = args["orbit"].as_f64().unwrap_or(15.0).clamp(-90.0, 90.0);
    let push = args["push"].as_f64().unwrap_or(0.12).clamp(0.0, 0.6);
    let (width, height, fps) = (
        project.settings.width,
        project.settings.height,
        project.settings.fps.max(1),
    );
    let frames = if still {
        0
    } else {
        (seconds * fps as f64).round() as u32
    };
    let (lat, lon, found, ring) = tokio::task::spawn_blocking(move || {
        let (lat, lon, found) = match (given, place) {
            (Some((lat, lon)), place) => (
                lat,
                lon,
                place.unwrap_or_else(|| format!("{lat:.5}, {lon:.5}")),
            ),
            (None, Some(place)) => geocode(&place)?,
            (None, None) => {
                return Err("give a place (an address or name) or lat and lon".to_owned())
            }
        };
        let ring = if mark {
            building_outline(lat, lon)
        } else {
            None
        };
        Ok((lat, lon, found, ring))
    })
    .await
    .map_err(|error| error.to_string())??;
    let mut config = json!({
        "lat": lat, "lon": lon, "range": range, "heading": heading,
        // The page wants the camera's angle below the horizon.
        "pitch": 90.0 - pitch,
        "highlight": mark, "ring": ring,
        "highlight_after": highlight_after, "highlight_fade": highlight_fade, "fps": fps,
        "width": width, "height": height,
        "relay": crate::relay::url(),
    });
    if let (true, Some(fields)) = (frames > 0, config.as_object_mut()) {
        fields.insert("frames".to_owned(), json!(frames));
        fields.insert("orbit".to_owned(), json!(orbit));
        fields.insert("push".to_owned(), json!(push));
    }
    let dir = app.store.uploads_dir(project_id)?.join("maps");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    // A capture-page change (including its baked-in grade) must not reuse
    // footage made with the previous look.
    let key = fingerprint(&[&config.to_string(), "google-3d", MAP_PAGE]);
    let out = dir.join(format!(
        "map-{key}.{}",
        if frames > 0 { "mp4" } else { "png" }
    ));
    // What the page measured is kept beside the footage, for reuse.
    let measured = out.with_extension("json");
    let (info, media, rendering) = if out.is_file() {
        let info = std::fs::read(&measured)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        if frames > 0 {
            // A stand-in still in the project (its swap never happened)
            // becomes the footage, so clips placed on it play the shot.
            let first = dir.join(format!("map-{key}-first.jpg"));
            if first.is_file() {
                swap_in_map(app, project_id, &first, &out).await;
            }
        }
        (info, import_one(app, project_id, &out).await?, false)
    } else if frames == 0 {
        let shots = dir.join(format!("map-{key}.frames"));
        std::fs::create_dir_all(&shots).map_err(|error| error.to_string())?;
        let made = render_map(&config, width, height, &shots, None).await;
        let _ = std::fs::remove_dir_all(&shots);
        let (picture, info) = made?;
        std::fs::write(&out, picture).map_err(|error| error.to_string())?;
        let _ = std::fs::write(&measured, info.to_string());
        (info, import_one(app, project_id, &out).await?, false)
    } else {
        let render = MapShotJob {
            key: key.clone(),
            config,
            width,
            height,
            fps,
            frames: frames as usize,
            dir: dir.clone(),
        };
        moving_map(app, project_id, render).await?
    };
    // The building's box in timeline coordinates (pixels from the frame's centre, y down).
    let place_box = |bounds: &Value| {
        let [left, top, right, bottom] =
            [0, 1, 2, 3].map(|i| bounds.get(i).and_then(Value::as_f64));
        let (half_w, half_h) = (width as f64 / 2.0, height as f64 / 2.0);
        Some(json!({
            "x": ((left? + right?) / 2.0 - half_w).round(),
            "top": (top? - half_h).round(),
            "bottom": (bottom? - half_h).round(),
            "left": (left? - half_w).round(),
            "right": (right? - half_w).round(),
        }))
    };
    let track: Vec<Value> = info
        .get("track")
        .and_then(Value::as_array)
        .map(|track| {
            // Every half second, and the last frame.
            let step = (fps as usize / 2).max(1);
            let last = track.len().saturating_sub(1);
            track
                .iter()
                .enumerate()
                .filter(|(frame, _)| frame % step == 0 || *frame == last)
                .filter_map(|(frame, bounds)| {
                    let mut at = place_box(bounds)?;
                    at.as_object_mut()?.insert("frame".to_owned(), json!(frame));
                    Some(at)
                })
                .collect()
        })
        .unwrap_or_default();
    let building = track
        .first()
        .cloned()
        .or_else(|| info.get("building").and_then(place_box));
    let mut note = if frames > 0 {
        "A moving shot (frames/fps seconds): the camera circles the building and closes in at a constant speed by itself, so place it as a video clip at scale 1 from source_in 0 with no scale keyframes. `building` is where the marked building sits on the first frame and `building_track` where it is every half second (frame = frames into the footage), in timeline transform coordinates: keyframe a label's x and y at those frames (ease linear) to keep it pinned. The marker can reveal after a date title using `highlight_after` and `highlight_fade` in source seconds; tracking remains available throughout.".to_owned()
    } else {
        "30 s of footage of the still: place it as a video clip (it fills the frame) and push in slowly with scale keyframes. `building` is where the marked building sits in the frame (timeline transform coordinates at scale 1; a push-in to s moves a point p to p*s).".to_owned()
    };
    if rendering {
        note.push_str(" It's still rendering in the background: place it now (the media is its first frame until the footage is done, then the same media id is the moving shot by itself; get_edit_context lists it under smoothing until then, and exports wait for it).");
    }
    Ok(json!({
        "media": media,
        "place": found,
        "lat": lat,
        "lon": lon,
        "frames": frames,
        "fps": fps,
        "building_outlined": ring.is_some(),
        "building": building,
        "building_track": track,
        "rendering": rendering,
        "note": note,
    }))
}

/// Adds one file to the project's media (or finds it there).
async fn import_one(app: &App, project_id: &str, path: &Path) -> Result<String, String> {
    let (_, added, errors) = crate::server::import_paths(
        app,
        project_id,
        vec![path.to_string_lossy().into_owned()],
        false,
        "agent",
    )
    .await?;
    added.first().cloned().ok_or_else(|| errors.join("; "))
}

/// A moving map shot to make.
#[derive(Clone)]
struct MapShotJob {
    key: String,
    config: Value,
    width: u32,
    height: u32,
    fps: u32,
    frames: usize,
    dir: PathBuf,
}

impl MapShotJob {
    fn out(&self) -> PathBuf {
        self.dir.join(format!("map-{}.mp4", self.key))
    }

    /// Its first frame, which stands in for it until it's done.
    fn first(&self) -> PathBuf {
        self.dir.join(format!("map-{}-first.jpg", self.key))
    }

    fn shots(&self) -> PathBuf {
        self.dir.join(format!("map-{}.frames", self.key))
    }
}

/// Starts (or joins) the moving shot's render and waits for its first frame
/// and building track: the first frame goes in as the shot's media for now.
/// Returns what the page measured, the media, and whether it's still rendering.
async fn moving_map(
    app: &App,
    project_id: &str,
    job: MapShotJob,
) -> Result<(Value, String, bool), String> {
    let render = {
        let mut renders = map_renders().lock();
        match renders.get(&job.key) {
            Some(render) => std::sync::Arc::clone(render),
            None => {
                let render = std::sync::Arc::new(MapRender {
                    ready: tokio::sync::watch::channel(None).0,
                    projects: Mutex::new(HashSet::new()),
                    failed: Mutex::new(None),
                });
                renders.insert(job.key.clone(), std::sync::Arc::clone(&render));
                let (app, job, running) =
                    (app.clone(), job.clone(), std::sync::Arc::clone(&render));
                tokio::spawn(async move {
                    let key = job.key.clone();
                    let _ = crate::diag::time_async(
                        "agent",
                        "map_view render (background)",
                        render_moving(&app, &job, &running),
                    )
                    .await;
                    map_renders().lock().remove(&key);
                });
                render
            }
        }
    };
    render.projects.lock().insert(project_id.to_owned());
    let mut ready = render.ready.subscribe();
    let info = match tokio::time::timeout(MAP_READY_WAIT, ready.wait_for(Option::is_some)).await {
        Ok(Ok(ready)) => ready.clone().unwrap_or_else(|| Err("the map render stopped".into()))?,
        Ok(Err(_)) => return Err("the map render stopped".into()),
        Err(_) => {
            return Err("the map is still loading its first frame; call map_view again with the same arguments in a minute (the render carries on)".into())
        }
    };
    let (out, first) = (job.out(), job.first());
    let media = import_one(app, project_id, &first).await?;
    {
        // Under the same lock as the render's failure, so one that failed
        // meanwhile is never left looking as if it were still rendering.
        let mut pending = maps_pending().lock();
        let error = render.failed.lock().clone();
        pending.entry(project_id.to_owned()).or_default().insert(
            first.to_string_lossy().into_owned(),
            MapPending {
                media: media.clone(),
                error,
            },
        );
    }
    // It may have finished meanwhile (its own swap found no stand-in yet).
    if out.is_file() {
        swap_in_map(app, project_id, &first, &out).await;
    }
    Ok((info, media, !out.is_file()))
}

/// Makes a moving shot: the page's frames (resuming from those already
/// there), then the footage; the projects waiting on it get it in place of
/// its first frame. A failure keeps the frames for the next attempt.
async fn render_moving(app: &App, job: &MapShotJob, render: &MapRender) -> Result<(), String> {
    let result = async {
        let _slot = map_slot()
            .acquire()
            .await
            .map_err(|error| error.to_string())?;
        let shots = job.shots();
        std::fs::create_dir_all(&shots).map_err(|error| error.to_string())?;
        let have = frames_had(&shots, job.frames);
        let mut config = job.config.clone();
        if let Some(fields) = config.as_object_mut() {
            fields.insert("have".to_owned(), json!(have));
        }
        let (sender, ready) = oneshot::channel();
        let page = render_map(&config, job.width, job.height, &shots, Some(sender));
        tokio::pin!(page);
        let (early, done) = tokio::select! {
            measured = ready => match measured {
                Ok(measured) => (Some(measured), None),
                Err(_) => (None, None),
            },
            done = &mut page => (None, Some(done)),
        };
        let first = job.first();
        let stand_in = |measured: &Value| -> Result<(), String> {
            if !first.is_file() {
                std::fs::copy(shots.join(frame_name(0)), &first)
                    .map_err(|error| format!("the map's first frame: {error}"))?;
            }
            render.ready.send_replace(Some(Ok(measured.clone())));
            Ok(())
        };
        if let Some(measured) = &early {
            stand_in(measured)?;
        }
        let (_, mut info) = match done {
            Some(done) => done?,
            None => page.await?,
        };
        // The track was measured up front; the final answer may not repeat it.
        if let (Some(early), Some(fields)) = (&early, info.as_object_mut()) {
            if !fields.contains_key("track") {
                if let Some(track) = early.get("track") {
                    fields.insert("track".to_owned(), track.clone());
                }
            }
        }
        if early.is_none() {
            stand_in(&info)?;
        }
        let (frames_dir, fps, out) = (shots.clone(), job.fps, job.out());
        tokio::task::spawn_blocking(move || frames_video(&frames_dir, fps, &out))
            .await
            .map_err(|error| error.to_string())??;
        let _ = std::fs::write(job.out().with_extension("json"), info.to_string());
        let _ = std::fs::remove_dir_all(&shots);
        Ok::<_, String>(())
    }
    .await;
    let projects: Vec<String> = render.projects.lock().iter().cloned().collect();
    let first = job.first();
    match &result {
        Ok(()) => {
            for project in projects {
                swap_in_map(app, &project, &first, &job.out()).await;
            }
        }
        Err(error) => {
            if render.ready.borrow().is_none() {
                render.ready.send_replace(Some(Err(error.clone())));
            }
            let first = first.to_string_lossy().into_owned();
            let mut pending = maps_pending().lock();
            *render.failed.lock() = Some(error.clone());
            for project in projects {
                if let Some(map) = pending
                    .get_mut(&project)
                    .and_then(|maps| maps.get_mut(&first))
                {
                    map.error = Some(error.clone());
                }
            }
        }
    }
    result
}

/// The finished footage in place of its first frame: the stand-in media
/// becomes the moving shot (same id), so every clip using it plays it.
async fn swap_in_map(app: &App, project_id: &str, first: &Path, out: &Path) {
    let first_path = first.to_string_lossy().into_owned();
    let swapped = swap_media(app, project_id, first, out).await;
    let mut pending = maps_pending().lock();
    match swapped {
        Ok(()) => {
            if let Some(maps) = pending.get_mut(project_id) {
                maps.remove(&first_path);
                if maps.is_empty() {
                    pending.remove(project_id);
                }
            }
        }
        Err(error) => {
            crate::diag::warn(
                "agent",
                format!("map footage {} into {project_id}: {error}", out.display()),
            );
            // Exports refuse the stand-in and say so, rather than wait on it.
            if let Some(map) = pending
                .get_mut(project_id)
                .and_then(|maps| maps.get_mut(&first_path))
            {
                map.error = Some(error);
            }
        }
    }
}

async fn swap_media(app: &App, project_id: &str, first: &Path, out: &Path) -> Result<(), String> {
    let path = out.to_owned();
    let probe = tokio::task::spawn_blocking(move || crate::media::probe(&path))
        .await
        .map_err(|error| error.to_string())??;
    // As import_paths keeps them.
    let canonical = |path: &Path| {
        path.canonicalize()
            .unwrap_or_else(|_| path.to_owned())
            .to_string_lossy()
            .into_owned()
    };
    let (stand_in, out_path) = (canonical(first), canonical(out));
    let has_stand_in = app.store.get(project_id).is_some_and(|live| {
        live.project
            .media
            .iter()
            .any(|media| media.path == stand_in)
    });
    if !has_stand_in {
        return Ok(());
    }
    let (_, replaced) = app.store.update(project_id, "agent", |project| {
        Ok(replace_media_path(project, &stand_in, &out_path, &probe))
    })?;
    if replaced {
        app.media.ensure(PathBuf::from(&out_path), probe);
    }
    Ok(())
}

/// Points the media at `from` to the file at `to` instead (as `probe` read
/// it). Returns whether there was any.
fn replace_media_path(
    project: &mut Project,
    from: &str,
    to: &str,
    probe: &crate::media::Probe,
) -> bool {
    let name = Path::new(to)
        .file_name()
        .map_or_else(|| to.to_owned(), |name| name.to_string_lossy().into_owned());
    let mut replaced = false;
    for media in project.media.iter_mut().filter(|media| media.path == from) {
        media.path = to.to_owned();
        media.name = name.clone();
        media.kind = probe.kind;
        media.duration = probe.duration;
        media.width = probe.width;
        media.height = probe.height;
        media.fps = probe.fps;
        media.has_audio = probe.has_audio;
        replaced = true;
    }
    replaced
}

/// A moving map shot's frames (`frame-00000.jpg`…) as footage at `fps`.
fn frames_video(frames: &Path, fps: u32, out: &Path) -> Result<(), String> {
    let partial = out.with_extension("partial.mp4");
    let output = Command::new(crate::tools::ffmpeg())
        .args(["-hide_banner", "-loglevel", "error", "-y", "-framerate"])
        .arg(fps.to_string())
        .arg("-i")
        .arg(frames.join("frame-%05d.jpg"))
        .args([
            "-vf",
            "format=yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "14",
            "-an",
            "-movflags",
            "+faststart",
        ])
        .arg(&partial)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&partial);
        return Err(format!(
            "couldn't make the map footage: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    std::fs::rename(&partial, out).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn places_are_encoded_for_the_search() {
        assert_eq!(
            urlencode("Kent Police, WA & co"),
            "Kent+Police%2C+WA+%26+co"
        );
    }

    #[test]
    fn building_outlines_are_read() {
        let found = json!({ "destinations": [{
            "primary": { "structureType": "POINT" },
            "containingPlaces": [{ "structureType": "BUILDING", "displayPolygon": {
                "type": "Polygon",
                "coordinates": [[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 0.0]]]
            } }]
        }] });
        assert_eq!(outline_in(&found).map(|ring| ring.len()), Some(4));
        assert_eq!(outline_in(&json!({ "destinations": [] })), None);
    }

    #[test]
    fn images_are_recognised() {
        assert!(is_image_path(Path::new("/x/Still.PNG")));
        assert!(!is_image_path(Path::new("/x/clip.mp4")));
    }

    #[test]
    fn whole_frames_are_resumed_from() {
        let dir = std::env::temp_dir().join(format!("edit-map-frames-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(frame_name(0)), [0xFF, 0xD8, 1, 2, 0xFF, 0xD9]).unwrap();
        // Cut off mid-write (no end marker), and a gap.
        std::fs::write(dir.join(frame_name(1)), [0xFF, 0xD8, 1, 2]).unwrap();
        std::fs::write(dir.join(frame_name(3)), [0xFF, 0xD8, 0xFF, 0xD9]).unwrap();
        assert_eq!(frames_had(&dir, 5), vec![0, 3]);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn make(args: &[&str], out: &Path) {
        let made = Command::new(crate::tools::ffmpeg())
            .args(["-hide_banner", "-loglevel", "error", "-y"])
            .args(args)
            .arg(out)
            .status()
            .unwrap();
        assert!(made.success());
    }

    /// A moving map shot's stand-in (its first frame) becomes the footage
    /// when the render is done: same media id, so clips placed on it play
    /// the shot; until then it's listed as pending and exports wait.
    #[tokio::test]
    async fn map_footage_swaps_in_for_its_first_frame() {
        let home = std::env::temp_dir().join(format!("edit-map-swap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let store = std::sync::Arc::new(crate::store::Store::open(home.clone()).unwrap());
        let app = App {
            updater: crate::update::Updater::new(home.clone()),
            voices: std::sync::Arc::new(crate::voice::Voices::new(&home)),
            agents: crate::agent::Agents::new(std::sync::Arc::clone(&store), home.clone(), 0),
            scripts: std::sync::Arc::new(crate::script::Jobs::default()),
            library: std::sync::Arc::new(crate::library::Library::default()),
            media: crate::media::Processor::new(std::sync::Arc::clone(&store)),
            frames: crate::render::FrameRenderer::start(store.cache_dir()),
            exports: std::sync::Arc::new(crate::render::Exports::default()),
            allowed_hosts: std::sync::Arc::new(Vec::new()),
            machine: "test".into(),
            store: std::sync::Arc::clone(&store),
        };
        let project = store
            .create("map", edit_core::Settings::default())
            .unwrap()
            .project
            .id;
        let maps = home.join("maps");
        std::fs::create_dir_all(&maps).unwrap();
        let (first, out) = (maps.join("map-k-first.jpg"), maps.join("map-k.mp4"));
        make(
            &[
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=320x180",
                "-frames:v",
                "1",
            ],
            &first,
        );
        make(
            &[
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=320x180:r=30:d=2",
                "-pix_fmt",
                "yuv420p",
            ],
            &out,
        );
        let media = import_one(&app, &project, &first).await.unwrap();
        store
            .update(&project, "test", |project| {
                crate::server::place_at_end(project, &media);
                Ok(())
            })
            .unwrap();
        maps_pending()
            .lock()
            .entry(project.clone())
            .or_default()
            .insert(
                first.to_string_lossy().into_owned(),
                MapPending {
                    media: media.clone(),
                    error: None,
                },
            );
        assert_eq!(
            smoothing_pending(&project),
            vec![format!("{media} (map view rendering)")]
        );
        assert!(wait_for_maps(&app, &project, Duration::from_millis(600))
            .await
            .unwrap_err()
            .contains("still rendering"));
        assert!(!wait_for_smoothing(&project, Duration::from_millis(600)).await);

        // A render that failed: the export refuses the stand-in and says why.
        if let Some(map) = maps_pending()
            .lock()
            .get_mut(&project)
            .and_then(|maps| maps.get_mut(first.to_string_lossy().as_ref()))
        {
            map.error = Some("tiles refused".into());
        }
        let refused = wait_for_maps(&app, &project, Duration::ZERO)
            .await
            .unwrap_err();
        assert!(refused.contains("tiles refused"), "{refused}");
        // Cut short (Edit closed mid-render: nothing pending any more).
        let stand_in = maps_pending().lock().remove(&project);
        let refused = wait_for_maps(&app, &project, Duration::ZERO)
            .await
            .unwrap_err();
        assert!(refused.contains("cut short"), "{refused}");
        if let Some(mut maps) = stand_in {
            for map in maps.values_mut() {
                map.error = None;
            }
            maps_pending().lock().insert(project.clone(), maps);
        }

        swap_in_map(&app, &project, &first, &out).await;

        let live = store.get(&project).unwrap().project;
        let swapped = live.media(&media).unwrap();
        assert_eq!(Path::new(&swapped.path), out.canonicalize().unwrap());
        assert_eq!(swapped.kind, edit_core::MediaKind::Video);
        assert!((swapped.duration - 2.0).abs() < 0.1, "{}", swapped.duration);
        assert!(live
            .clips
            .iter()
            .any(|clip| clip.media_id() == Some(media.as_str())));
        assert!(smoothing_pending(&project).is_empty());
        assert!(wait_for_maps(&app, &project, Duration::ZERO).await.is_ok());

        // A render that failed is listed (with what to do) but holds nothing up.
        maps_pending()
            .lock()
            .entry(project.clone())
            .or_default()
            .insert(
                "elsewhere.jpg".into(),
                MapPending {
                    media: "m9".into(),
                    error: Some("tiles refused".into()),
                },
            );
        assert!(smoothing_pending(&project)[0].starts_with("m9 (map view failed: tiles refused"));
        assert!(wait_for_maps(&app, &project, Duration::ZERO).await.is_ok());
        assert!(wait_for_smoothing(&project, Duration::ZERO).await);
        maps_pending().lock().remove(&project);
        let _ = std::fs::remove_dir_all(home);
    }
}
