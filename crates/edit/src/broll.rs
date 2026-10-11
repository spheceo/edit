//! What cut-ins are made of: B-roll picked from the source footage (looked
//! through and read, not just the timeline), slowed down smoothly, stills
//! (generated images, map views) turned into footage, and 3D map views of the
//! places a story happens, made with free map data and the local Chrome.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use edit_core::{ClipContent, Media, Project};
use serde_json::{json, Value};

use crate::render::RgbaImage;
use crate::server::App;

/// Identifies Edit to the free map services (as their usage policies ask).
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
    let status = Command::new("ffmpeg")
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
/// phrases with their times and who says them.
pub async fn media_transcript(
    app: &App,
    media: &Media,
    from: f64,
    to: f64,
) -> Result<String, String> {
    let transcript = transcript(app, media).await?;
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
    let length = clip.duration as f64 / fps * speed;
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
        let partial = dir.join(format!("{stem}-{key}.partial.mp4"));
        let (input, start) = (PathBuf::from(&source.path), *source_in);
        let speed = *speed;
        let result = tokio::task::spawn_blocking(move || {
            Command::new("ffmpeg")
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
    let (_, added, errors) = crate::server::import_paths(
        app,
        project_id,
        vec![out.to_string_lossy().into_owned()],
        false,
        "agent",
    )
    .await?;
    let smooth = added.first().cloned().ok_or_else(|| errors.join("; "))?;
    let (_, done) = app.store.update(project_id, "agent", |project| {
        let clip = project.clip_mut(clip_id).ok_or("the clip went away")?;
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

/// Where a place is: (lat, lon, the full name the map service knows it by).
fn geocode(place: &str) -> Result<(f64, f64, String), String> {
    let url = format!(
        "https://nominatim.openstreetmap.org/search?format=json&limit=1&q={}",
        urlencode(place)
    );
    let body = fetch(&url)?;
    let found: Value = serde_json::from_str(&body)
        .map_err(|error| format!("unexpected answer from the map search: {error}"))?;
    let first = found
        .get(0)
        .ok_or_else(|| format!("couldn't find \"{place}\" on the map; try a fuller address"))?;
    let number = |key: &str| {
        first[key]
            .as_str()
            .and_then(|value| value.parse::<f64>().ok())
    };
    Ok((
        number("lat").ok_or("no latitude")?,
        number("lon").ok_or("no longitude")?,
        first["display_name"].as_str().unwrap_or(place).to_owned(),
    ))
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
        .args(["-sS", "-f", "--max-time", "30", "-A", USER_AGENT, url])
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

/// The outline (lon, lat ring) and height (m) of the building at a point, from OpenStreetMap.
fn building_at(lat: f64, lon: f64) -> Option<(Vec<[f64; 2]>, f64)> {
    let d = 0.0006;
    let url = format!(
        "https://api.openstreetmap.org/api/0.6/map.json?bbox={},{},{},{}",
        lon - d,
        lat - d,
        lon + d,
        lat + d
    );
    let data: Value = serde_json::from_str(&fetch(&url).ok()?).ok()?;
    let elements = data["elements"].as_array()?;
    let nodes: std::collections::HashMap<i64, [f64; 2]> = elements
        .iter()
        .filter(|element| element["type"] == "node")
        .filter_map(|node| {
            Some((
                node["id"].as_i64()?,
                [node["lon"].as_f64()?, node["lat"].as_f64()?],
            ))
        })
        .collect();
    let buildings = elements
        .iter()
        .filter(|element| element["type"] == "way" && element["tags"]["building"].is_string());
    let mut best: Option<(f64, Vec<[f64; 2]>, f64)> = None;
    for way in buildings {
        let ring: Vec<[f64; 2]> = way["nodes"]
            .as_array()?
            .iter()
            .filter_map(|id| nodes.get(&id.as_i64()?).copied())
            .collect();
        if ring.len() < 4 {
            continue;
        }
        let tags = &way["tags"];
        let height = tags["height"]
            .as_str()
            .and_then(|value| value.trim_end_matches(" m").parse::<f64>().ok())
            .or_else(|| {
                tags["building:levels"]
                    .as_str()
                    .and_then(|value| value.parse::<f64>().ok())
                    .map(|levels| levels * 3.2)
            })
            .unwrap_or(5.5);
        // Containing the point wins; else the nearest by its middle.
        let inside = contains(&ring, [lon, lat]);
        let middle = ring.iter().fold([0.0, 0.0], |sum, point| {
            [sum[0] + point[0], sum[1] + point[1]]
        });
        let middle = [middle[0] / ring.len() as f64, middle[1] / ring.len() as f64];
        let distance = if inside {
            0.0
        } else {
            (middle[0] - lon).hypot(middle[1] - lat)
        };
        if best.as_ref().is_none_or(|(least, _, _)| distance < *least) {
            best = Some((distance, ring, height));
        }
    }
    // Further than ~60 m isn't the place.
    best.filter(|(distance, _, _)| *distance < 0.0006)
        .map(|(_, ring, height)| (ring, height))
}

fn contains(ring: &[[f64; 2]], point: [f64; 2]) -> bool {
    let mut inside = false;
    let mut j = ring.len() - 1;
    for i in 0..ring.len() {
        let (a, b) = (ring[i], ring[j]);
        if (a[1] > point[1]) != (b[1] > point[1])
            && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]
        {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn chrome() -> Option<PathBuf> {
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

/// The map page: satellite imagery with buildings raised in 3D (OpenFreeMap),
/// tilted, and the place's building marked in glowing red. Drawn by MapLibre;
/// all free, no keys.
const MAP_PAGE: &str = r##"<!doctype html><html><head><meta charset="utf-8">
<link href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet">
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<style>html,body,#map{margin:0;width:100%;height:100%;background:#000}</style></head><body><div id="map"></div>
<script>
const C = __CONFIG__;
const map = new maplibregl.Map({
  container: "map", interactive: false, attributionControl: false, preserveDrawingBuffer: true,
  center: [C.lon, C.lat], zoom: C.zoom, pitch: C.pitch, bearing: C.bearing,
  style: {
    version: 8,
    sources: {
      sat: { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 19 },
      omt: { type: "vector", url: "https://tiles.openfreemap.org/planet" },
    },
    layers: [
      { id: "sat", type: "raster", source: "sat" },
      { id: "buildings", type: "fill-extrusion", source: "omt", "source-layer": "building", minzoom: 14,
        paint: { "fill-extrusion-color": "#d9d4cc", "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
                 "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0], "fill-extrusion-opacity": 0.92 } },
    ],
  },
});
// The place, marked over the map (drawn here, not by the map, so it never waits on the map's workers):
// its outline lifted into a block of its height, red, glowing.
if (C.ring) {
  const canvas = document.createElement("canvas");
  canvas.width = innerWidth; canvas.height = innerHeight;
  canvas.style.cssText = "position:absolute;inset:0;pointer-events:none";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const metersPerPixel = 40075016.686 * Math.cos(C.lat * Math.PI / 180) / (512 * Math.pow(2, C.zoom));
  const lift = C.height / metersPerPixel * Math.sin(C.pitch * Math.PI / 180);
  const base = C.ring.map((point) => map.project(point));
  const roof = base.map((point) => ({ x: point.x, y: point.y - lift }));
  const face = (points) => { ctx.beginPath(); points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill(); };
  ctx.fillStyle = "rgba(255, 40, 40, 0.42)";
  ctx.shadowColor = "rgba(255, 30, 30, 0.9)";
  ctx.shadowBlur = 40;
  for (let i = 0; i + 1 < base.length; i++) face([base[i], base[i + 1], roof[i + 1], roof[i]]);
  face(roof);
}
</script></body></html>"##;

/// A tilted 3D map view of `place` (or `lat`/`lon`), the building there in
/// red, as footage in the project. Returns the media and where it is.
pub async fn map_still(app: &App, project_id: &str, args: &Value) -> Result<Value, String> {
    let project: Project = app.store.get(project_id).ok_or("no such project")?.project;
    let place = args["place"].as_str().map(str::to_owned);
    let given = args["lat"].as_f64().zip(args["lon"].as_f64());
    let zoom = args["zoom"].as_f64().unwrap_or(18.2).clamp(14.0, 19.5);
    let pitch = args["pitch"].as_f64().unwrap_or(60.0).clamp(0.0, 75.0);
    let bearing = args["bearing"].as_f64().unwrap_or(-25.0);
    let mark = args["highlight"].as_bool().unwrap_or(true);
    let (width, height) = (project.settings.width, project.settings.height);
    let browser = chrome().ok_or("map views need Google Chrome (or Chromium) installed")?;
    let dir = app.store.uploads_dir(project_id).join("maps");
    let (lat, lon, found, png) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let (lat, lon, found) = match (given, place.as_deref()) {
            (Some((lat, lon)), _) => (
                lat,
                lon,
                place
                    .clone()
                    .unwrap_or_else(|| format!("{lat:.5}, {lon:.5}")),
            ),
            (None, Some(place)) => geocode(place)?,
            (None, None) => {
                return Err("give a place (an address or name) or lat and lon".to_owned())
            }
        };
        let building = if mark { building_at(lat, lon) } else { None };
        let config = json!({
            "lat": lat, "lon": lon, "zoom": zoom, "pitch": pitch, "bearing": bearing,
            "ring": building.as_ref().map(|(ring, _)| ring),
            "height": building.as_ref().map_or(0.0, |(_, height)| *height),
        });
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        let key = fingerprint(&[&config.to_string(), &format!("{width}x{height}")]);
        let page = std::env::temp_dir().join(format!("edit-map-{key}.html"));
        std::fs::write(&page, MAP_PAGE.replace("__CONFIG__", &config.to_string()))
            .map_err(|error| error.to_string())?;
        let png = dir.join(format!("map-{key}.png"));
        let output = Command::new(&browser)
            .args([
                "--headless=new",
                "--hide-scrollbars",
                "--use-angle=metal",
                &format!("--window-size={width},{height}"),
                // The map's tiles load on Chrome's virtual clock before the shot.
                "--virtual-time-budget=20000",
                &format!("--screenshot={}", png.display()),
            ])
            .arg(format!("file://{}", page.display()))
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("chrome: {error}"))?;
        let _ = std::fs::remove_file(&page);
        if !png.is_file() {
            return Err(format!(
                "the map didn't render: {}",
                String::from_utf8_lossy(&output.stderr)
                    .lines()
                    .last()
                    .unwrap_or("")
            ));
        }
        Ok((lat, lon, found, png))
    })
    .await
    .map_err(|error| error.to_string())??;
    let (_, added, errors) = crate::server::import_paths(
        app,
        project_id,
        vec![png.to_string_lossy().into_owned()],
        false,
        "agent",
    )
    .await?;
    let media = added.first().cloned().ok_or_else(|| errors.join("; "))?;
    Ok(json!({
        "media": media,
        "place": found,
        "lat": lat,
        "lon": lon,
        "note": "30 s of footage of the still: place it as a video clip (it fills the frame) and push in slowly with scale keyframes.",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn points_in_outlines() {
        let square = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [0.0, 0.0]];
        assert!(contains(&square, [0.5, 0.5]));
        assert!(!contains(&square, [1.5, 0.5]));
    }

    #[test]
    fn places_are_encoded_for_the_search() {
        assert_eq!(
            urlencode("Kent Police, WA & co"),
            "Kent+Police%2C+WA+%26+co"
        );
    }

    #[test]
    fn images_are_recognised() {
        assert!(is_image_path(Path::new("/x/Still.PNG")));
        assert!(!is_image_path(Path::new("/x/clip.mp4")));
    }
}
