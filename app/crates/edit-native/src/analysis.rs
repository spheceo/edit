//! Looking at footage: tracking a box (`track`), faces (Vision, `faces`),
//! redaction (`censor`), camera angles (`seats`), and the desktop profile's
//! pictures (`desktop`).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

/// Frames looked at per second of source when finding faces.
#[napi]
pub const FACES_RATE: f64 = edit_engine::faces::RATE;

#[napi(object)]
pub struct TrackAnchor {
    /// Seconds into the source.
    pub at: f64,
    /// [x0, y0, x1, y1] in source pixels.
    #[napi(ts_type = "[number, number, number, number]")]
    pub region: Vec<f64>,
}

#[napi(object)]
pub struct TrackRequest {
    pub path: String,
    /// The source's picture size.
    #[napi(ts_type = "[number, number]")]
    pub size: Vec<u32>,
    /// The source's frame rate (0 if unknown).
    pub fps: f64,
    /// Seconds of the source to track over (at most 180 s).
    pub from: f64,
    pub to: f64,
    pub anchors: Vec<TrackAnchor>,
}

#[napi(object)]
pub struct TrackSample {
    pub time: f64,
    pub x: f64,
    pub y: f64,
}

#[napi(object)]
pub struct Tracked {
    pub samples: Vec<TrackSample>,
    /// Stretches (source seconds) where the box wasn't found.
    #[napi(ts_type = "[number, number][]")]
    pub lost: Vec<Vec<f64>>,
    /// Cuts inside the footage (source seconds of the first frame after).
    pub cuts: Vec<f64>,
}

fn pair<T: Copy>(values: &[T], what: &str) -> Result<(T, T), String> {
    match values {
        [a, b] => Ok((*a, *b)),
        _ => Err(format!("{what} needs two numbers")),
    }
}

/// Follows a box given at one or more moments through the source (frames
/// kept in native memory a few minutes for another pass).
#[napi]
pub async fn track_anchors(request: TrackRequest) -> napi::Result<Tracked> {
    crate::blocking("tracking", move || {
        let size = pair(&request.size, "size")?;
        let anchors = request
            .anchors
            .iter()
            .map(|anchor| match anchor.region.as_slice() {
                [x0, y0, x1, y1] => Ok(edit_engine::track::Anchor {
                    at: anchor.at,
                    region: [*x0, *y0, *x1, *y1],
                }),
                _ => Err("a region is [x0, y0, x1, y1]".to_owned()),
            })
            .collect::<Result<Vec<_>, String>>()?;
        let tracked = edit_engine::track::track_anchors(
            Path::new(&request.path),
            size,
            request.fps,
            request.from,
            request.to,
            &anchors,
        )?;
        Ok(Tracked {
            samples: tracked
                .samples
                .iter()
                .map(|sample| TrackSample {
                    time: sample.time,
                    x: sample.x,
                    y: sample.y,
                })
                .collect(),
            lost: tracked.lost.iter().map(|(a, b)| vec![*a, *b]).collect(),
            cuts: tracked.cuts,
        })
    })
    .await
}

type Faces = BTreeMap<i64, Vec<[f32; 4]>>;

fn faces_json(faces: &Faces) -> Result<serde_json::Value, String> {
    serde_json::to_value(faces).map_err(|error| error.to_string())
}

/// The faces at `indexes` (source seconds × FACES_RATE) of the footage at
/// `source`: from its cache, the rest found now (Vision; a minute or two for
/// a long file's first run; nothing off macOS).
#[napi(
    ts_args_type = "source: string, size: [number, number], indexes: number[]",
    ts_return_type = "Promise<Record<number, Box[]>>"
)]
pub async fn faces_detect(
    source: String,
    size: Vec<u32>,
    indexes: Vec<i64>,
) -> napi::Result<serde_json::Value> {
    crate::blocking("finding faces", move || {
        let size = pair(&size, "size")?;
        let indexes: BTreeSet<i64> = indexes.into_iter().collect();
        faces_json(&edit_engine::faces::detect(
            Path::new(&source),
            size,
            &indexes,
        )?)
    })
    .await
}

/// Frames looked at per second of source when reading text on screen.
#[napi]
pub const SCREEN_TEXT_RATE: f64 = edit_engine::screen_text::RATE;

fn texts_json(texts: &edit_engine::screen_text::Texts) -> Result<serde_json::Value, String> {
    serde_json::to_value(texts).map_err(|error| error.to_string())
}

/// The words on screen at `indexes` (source seconds × SCREEN_TEXT_RATE) of
/// the footage at `source`, each with its box: from its cache, the rest read
/// now (Vision; nothing off macOS).
#[napi(
    ts_args_type = "source: string, size: [number, number], indexes: number[]",
    ts_return_type = "Promise<Record<number, ScreenText[]>>"
)]
pub async fn screen_text_detect(
    source: String,
    size: Vec<u32>,
    indexes: Vec<i64>,
) -> napi::Result<serde_json::Value> {
    crate::blocking("reading text on screen", move || {
        let size = pair(&size, "size")?;
        let indexes: BTreeSet<i64> = indexes.into_iter().collect();
        texts_json(&edit_engine::screen_text::detect(
            Path::new(&source),
            size,
            &indexes,
        )?)
    })
    .await
}

/// The words on screen read in `source` so far, without looking at anything new.
#[napi(ts_return_type = "Record<number, ScreenText[]> | null")]
pub fn screen_text_cached(source: String) -> napi::Result<Option<serde_json::Value>> {
    crate::sync("reading text on screen", || {
        edit_engine::screen_text::cached(Path::new(&source))
            .map(|texts| texts_json(&texts))
            .transpose()
    })
}

/// The faces found in `source` so far, without looking at anything new.
#[napi(ts_return_type = "Record<number, Box[]> | null")]
pub fn faces_cached(source: String) -> napi::Result<Option<serde_json::Value>> {
    crate::sync("reading faces", || {
        edit_engine::faces::cached(Path::new(&source))
            .map(|faces| faces_json(&faces))
            .transpose()
    })
}

#[napi(object)]
pub struct CensorCheck {
    pub issues: Vec<serde_json::Value>,
    /// Files not read yet (`censor_check_pending`).
    pub pending: Vec<String>,
}

/// B-roll that's mostly censored (`censored_broll`), from the files already
/// read; with `start`, files not read yet start being read in the background.
#[napi]
pub fn censor_issues(
    #[napi(ts_arg_type = "ProjectInput")] project: crate::project::ProjectInput,
    start: bool,
) -> napi::Result<CensorCheck> {
    crate::sync("checking for censored footage", || {
        let project = crate::project::project_of(&project)?;
        let (issues, pending) = edit_engine::censor::issues(&project, &crate::cache_dir()?, start);
        Ok(CensorCheck { issues, pending })
    })
}

/// Reads a video for censored stretches in the background (one at a time),
/// so the audit's `censored_broll` is ready when the edit is reviewed: for
/// footage whose light preview was just made.
#[napi]
pub fn censor_warm(path: String) {
    if let Ok(cache) = crate::cache_dir() {
        edit_engine::censor::analyse_in_background(cache, PathBuf::from(path));
    }
}

#[napi(object)]
pub struct Scenes {
    /// (start, end seconds, camera angle or null for a cutaway); the last
    /// scene ends at Infinity.
    #[napi(ts_type = "[number, number, number | null][]")]
    pub scenes: Vec<Vec<Option<f64>>>,
    pub angles: u32,
}

/// Scenes and camera angles in small greyscale frames (64 × 36 bytes each,
/// two a second, one after another).
#[napi]
pub async fn seats_scenes(gray: Buffer) -> napi::Result<Scenes> {
    let frames = gray.to_vec();
    crate::blocking("finding camera angles", move || {
        let (scenes, angles) = edit_engine::seats::scenes(&frames);
        Ok(Scenes {
            scenes: scenes
                .into_iter()
                .map(|(start, end, angle)| vec![Some(start), Some(end), angle.map(|a| a as f64)])
                .collect(),
            angles: u32::try_from(angles).unwrap_or(u32::MAX),
        })
    })
    .await
}

/// The desktop profile's pictures for a `width` × `height` frame, drawn into
/// `<home>/graphics/` if missing: [wallpaper, photo viewer, notepad].
#[napi(ts_return_type = "Promise<[string, string, string]>")]
pub async fn desktop_files(
    width: u32,
    height: u32,
    photo_title: String,
    notepad_title: String,
) -> napi::Result<Vec<String>> {
    crate::blocking("drawing the desktop", move || {
        let home = crate::lifecycle::home()?;
        let files =
            edit_engine::desktop::files(&home, width, height, &photo_title, &notepad_title)?;
        Ok(files
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect())
    })
    .await
}

/// The laid-out size [width, height] of `text` in Geist at `px`, as the
/// renderer lays it out (the desktop profile's Notepad lines).
#[napi(ts_return_type = "[number, number]")]
pub fn text_block(text: String, px: f64, weight: u32, line_height: f64) -> napi::Result<Vec<f64>> {
    crate::sync("measuring text", || {
        let weight = u16::try_from(weight).map_err(|_| format!("weight {weight} is too big"))?;
        let (width, height) = edit_engine::desktop::text_block(&text, px, weight, line_height);
        Ok(vec![width, height])
    })
}
