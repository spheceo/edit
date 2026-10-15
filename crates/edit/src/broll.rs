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

/// Evenly spaced frames of a media file between `start` and `end` (seconds of the file).
pub fn media_frames(
    media: &Media,
    start: f64,
    end: f64,
    count: usize,
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
    let mut images = Vec::new();
    for time in &times {
        let (width, height, pixels) = crate::render::grab_frame(media, *time, 480, 480)?;
        images.push(RgbaImage {
            width,
            height,
            pixels,
        });
    }
    Ok((images, times))
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
    let dir = app.store.uploads_dir(project_id).join("smooth");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let stem = Path::new(&source.name).file_stem().map_or_else(
        || "clip".to_owned(),
        |stem| stem.to_string_lossy().into_owned(),
    );
    let key = fingerprint(&[
        &source.path,
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
        let partial = dir.join(format!("{stem}-{key}.partial.mp4"));
        let (input, start) = (PathBuf::from(&source.path), *source_in);
        let speed = *speed;
        // Never two renders into one file: a second ask waits for the first.
        if out.is_file() {
            return swap_in_smooth(app, project_id, &clip, &out, fps).await;
        }
        let result = tokio::task::spawn_blocking(move || {
            Command::new(crate::tools::ffmpeg())
                .args(["-hide_banner", "-loglevel", "error", "-y", "-ss", &format!("{start:.4}"), "-t", &format!("{length:.4}"), "-i"])
                .arg(&input)
                .args([
                    "-an",
                    "-vf",
                    &format!(
                        "setpts=PTS/{speed:.6},minterpolate=fps={fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,format=yuv420p"
                    ),
                    "-c:v",
                    "libx264",
                    "-preset",
                    "medium",
                    "-crf",
                    "15",
                    // x264's own frame threads cost ~350 MB at 1080p; the
                    // interpolation is the slow part anyway.
                    "-threads",
                    "2",
                    "-movflags",
                    "+faststart",
                ])
                .arg(&partial)
                .stdin(Stdio::null())
                .output()
                .map(|output| (output, partial))
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("ffmpeg: {error}"))?;
        let (output, partial) = result;
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
    let (_, added, errors) = crate::server::import_paths(
        app,
        project_id,
        vec![out.to_string_lossy().into_owned()],
        false,
        "agent",
    )
    .await?;
    let smooth = added.first().cloned().ok_or_else(|| errors.join("; "))?;
    let clip_id = rendered.id.as_str();
    let (_, done) = app.store.update(project_id, "agent", |project| {
        let clip = project.clip_mut(clip_id).ok_or("the clip went away")?;
        if source_of(&clip.content) != source_of(&rendered.content)
            || clip.duration > rendered.duration
        {
            return Err(format!(
                "{clip_id} changed while it was being smoothed; run smooth_slow_motion on it again"
            ));
        }
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
        Ok(json!({ "clip": clip_id, "media": smooth, "seconds": clip.duration as f64 / fps }))
    })?;
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

/// How many smoothing renders run at once. Motion interpolation keeps about
/// one core busy each, so several side by side finish a cut-in's shots in
/// the time of one or two; but a 1080p render holds about a gigabyte, so
/// memory caps them too (one per 4 GB): on an 8 GB Mac four at once swapped
/// the whole machine and each took half an hour.
fn smoothing_slots() -> &'static tokio::sync::Semaphore {
    static SLOTS: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    SLOTS.get_or_init(|| {
        let cores = std::thread::available_parallelism().map_or(4, |cores| cores.get());
        let memory_gb = Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()
            .and_then(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .parse::<u64>()
                    .ok()
            })
            .map_or(8, |bytes| bytes >> 30);
        let slots = (cores / 2).min(memory_gb as usize / 4).clamp(1, 6);
        tokio::sync::Semaphore::new(slots)
    })
}

/// Clips being smoothed in the background, by project.
fn smoothing() -> &'static Mutex<HashMap<String, HashSet<String>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, HashSet<String>>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

/// The clips of a project still being smoothed in the background.
pub fn smoothing_pending(project_id: &str) -> Vec<String> {
    let mut pending: Vec<String> = smoothing()
        .lock()
        .get(project_id)
        .map(|clips| clips.iter().cloned().collect())
        .unwrap_or_default();
    pending.sort();
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
    while !smoothing_pending(project_id).is_empty() {
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
        crate::transcribe::relay(),
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
    let url = format!(
        "{}/v1/outline?lat={lat}&lon={lon}",
        crate::transcribe::relay()
    );
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
    match std::fs::write(dir.join(format!("frame-{index:05}.jpg")), body) {
        Ok(()) => StatusCode::NO_CONTENT,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// `POST /api/maps/{token}`: the picture (image/png) with what the page measured
/// (`x-map-info`, JSON); for a moving shot, once its frames are in, just what it
/// measured (application/json); or what went wrong (text).
pub async fn map_shot(
    UrlPath(token): UrlPath<String>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
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
async fn render_map(config: &Value, width: u32, height: u32, frames: &Path) -> MapShot {
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

/// A tilted 3D view of `place` (or `lat`/`lon`) from Google's photorealistic
/// map, the building there in red, as footage in the project: by default a
/// moving shot (the camera circling the building and closing in), or a still.
/// Returns the media and where the building is. The same view again reuses the
/// footage (each new one is a billed map session).
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
        "relay": crate::transcribe::relay(),
    });
    if let (true, Some(fields)) = (frames > 0, config.as_object_mut()) {
        fields.insert("frames".to_owned(), json!(frames));
        fields.insert("orbit".to_owned(), json!(orbit));
        fields.insert("push".to_owned(), json!(push));
    }
    let dir = app.store.uploads_dir(project_id).join("maps");
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
    let info: Value = if out.is_file() {
        std::fs::read(&measured)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    } else {
        let shots = dir.join(format!("map-{key}.frames"));
        std::fs::create_dir_all(&shots).map_err(|error| error.to_string())?;
        let made = async {
            let (picture, info) = render_map(&config, width, height, &shots).await?;
            if frames > 0 {
                let (shots, out) = (shots.clone(), out.clone());
                tokio::task::spawn_blocking(move || frames_video(&shots, fps, &out))
                    .await
                    .map_err(|error| error.to_string())??;
            } else {
                std::fs::write(&out, picture).map_err(|error| error.to_string())?;
            }
            Ok::<_, String>(info)
        }
        .await;
        let _ = std::fs::remove_dir_all(&shots);
        let info = made?;
        let _ = std::fs::write(&measured, info.to_string());
        info
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
    let (_, added, errors) = crate::server::import_paths(
        app,
        project_id,
        vec![out.to_string_lossy().into_owned()],
        false,
        "agent",
    )
    .await?;
    let media = added.first().cloned().ok_or_else(|| errors.join("; "))?;
    let note = if frames > 0 {
        "A moving shot (frames/fps seconds): the camera circles the building and closes in at a constant speed by itself, so place it as a video clip at scale 1 from source_in 0 with no scale keyframes. `building` is where the marked building sits on the first frame and `building_track` where it is every half second (frame = frames into the footage), in timeline transform coordinates: keyframe a label's x and y at those frames (ease linear) to keep it pinned. The marker can reveal after a date title using `highlight_after` and `highlight_fade` in source seconds; tracking remains available throughout."
    } else {
        "30 s of footage of the still: place it as a video clip (it fills the frame) and push in slowly with scale keyframes. `building` is where the marked building sits in the frame (timeline transform coordinates at scale 1; a push-in to s moves a point p to p*s)."
    };
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
        "note": note,
    }))
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
}
