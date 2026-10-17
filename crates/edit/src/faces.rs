//! Subtitles never cover a face. Every subtitle sat bottom middle, and in
//! bodycam footage (the camera often looks down at people) the box sat right
//! on the speaker's face. Faces are found with Apple's Vision face detector
//! on small frames of the light preview, two a second of source, kept per
//! file in its cache dir (`faces-v1.json`) so a second run, another project
//! using the same footage, or a re-run of add_subtitles reads them back; a
//! 30-minute edit is analysed once, in a minute or two, for free. Then each
//! subtitle keeps the house place (bottom middle) unless a face seen while
//! it's up would be under it: it goes to the first of bottom left, bottom
//! right, top middle, top left, top right that's clear of every face (the
//! least covered when none is). A subtitle stays where the one just before
//! it moved to while the bottom middle is still crowded, so a conversation's
//! lines don't jump about. With no face found (none on screen, a redaction
//! blur, a non-mac build) subtitles stay bottom middle.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use edit_core::{ClipContent, MediaKind, Project, TextStyle, Transform};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::server::App;

/// The faces found at each sample index ([x0, y0, x1, y1] shares of the frame).
pub type Faces = BTreeMap<i64, Vec<[f32; 4]>>;
/// One stretch's faces, index by index.
type Seen = Vec<(i64, Vec<[f32; 4]>)>;
/// The picture under a subtitle: media path, size, the clip's transform,
/// and the sample indexes seen while it's up.
type Under = (PathBuf, (u32, u32), Transform, BTreeSet<i64>);

/// Frames looked at per second of source.
pub const RATE: f64 = 2.0;
/// The analysis's file in the media's cache dir; a new method is a new file.
const FILE: &str = "faces-v1.json";
/// How wide the frames looked at are.
const WIDE: u32 = 640;
/// Faces the detector is less sure of are ignored.
const SURE: f32 = 0.5;
/// Faces smaller than this share of the picture's height are ignored (far
/// in the background, or not faces at all).
const SMALLEST: f32 = 0.03;
/// Clip names subtitles start with.
const SUBTITLE: &str = "Subtitle";

/// Faces at each sample (index = source seconds × RATE): x0, y0, x1, y1 as
/// shares of the picture from its top left.
#[derive(Default, Deserialize, Serialize)]
struct Found {
    samples: BTreeMap<i64, Vec<[f32; 4]>>,
}

/// One analysis per file at a time (a second caller waits and reads it).
static BUSY: Mutex<Option<HashMap<PathBuf, Arc<Mutex<()>>>>> = Mutex::new(None);

fn lock_for(path: &Path) -> Arc<Mutex<()>> {
    BUSY.lock()
        .get_or_insert_with(HashMap::new)
        .entry(path.to_path_buf())
        .or_default()
        .clone()
}

/// The faces at `indexes` (source seconds × RATE) of the footage at
/// `source` (`size` its picture size): from its cache, the rest found now.
/// Blocking: call from spawn_blocking.
pub fn detect(
    source: &Path,
    size: (u32, u32),
    indexes: &BTreeSet<i64>,
) -> Result<BTreeMap<i64, Vec<[f32; 4]>>, String> {
    let lock = lock_for(source);
    let _held = lock.lock();
    let file = crate::tools::media_cache(source).map(|dir| dir.join(FILE));
    let mut found: Found = file
        .as_ref()
        .and_then(|file| std::fs::read(file).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let missing: Vec<i64> = indexes
        .iter()
        .copied()
        .filter(|index| !found.samples.contains_key(index))
        .collect();
    if !missing.is_empty() {
        let fresh = look(source, size, &missing)?;
        let any = !fresh.is_empty();
        found.samples.extend(fresh);
        if let Some(file) = file.filter(|_| any) {
            if let Some(dir) = file.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let bytes = serde_json::to_vec(&found).map_err(|error| error.to_string())?;
            crate::store::write_atomic(&file, &bytes).map_err(|error| error.to_string())?;
        }
    }
    Ok(indexes
        .iter()
        .filter_map(|index| Some((*index, found.samples.get(index)?.clone())))
        .collect())
}

/// Finds the faces at `indexes` (sorted): the light preview decoded small
/// by AVFoundation, in up to three stretches side by side, each frame given
/// to Vision.
#[cfg(target_os = "macos")]
fn look(
    source: &Path,
    (width, height): (u32, u32),
    indexes: &[i64],
) -> Result<BTreeMap<i64, Vec<[f32; 4]>>, String> {
    let wide = WIDE.min(width.max(2)) & !1;
    let decode = crate::track::decode_source(source, wide as usize);
    let high = ((f64::from(wide) * f64::from(height.max(1)) / f64::from(width.max(1))).round()
        as u32
        & !1)
        .max(2);
    let parts = indexes.len().div_ceil(400).clamp(1, 3);
    let chunk = indexes.len().div_ceil(parts);
    let read = |part: &[i64]| -> Result<Seen, String> {
        let mut reader = crate::mac_media::Reader::open(&decode, wide, high)?;
        let mut bgra = vec![0_u8; wide as usize * high as usize * 4];
        let mut out = Vec::with_capacity(part.len());
        for &index in part {
            let time = index as f64 / RATE;
            if reader
                .frame(time, &mut bgra, crate::render::Order::Bgra, false)
                .is_err()
            {
                // Past the end: nothing to see there.
                out.push((index, Vec::new()));
                continue;
            }
            let faces = crate::mac_media::faces(&bgra, wide, high)?
                .into_iter()
                .filter(|[_, y0, _, y1, sure]| *sure >= SURE && y1 - y0 >= SMALLEST)
                .map(|[x0, y0, x1, y1, _]| {
                    [x0, y0, x1, y1].map(|value| (value.clamp(0.0, 1.0) * 1000.0).round() / 1000.0)
                })
                .collect();
            out.push((index, faces));
        }
        Ok(out)
    };
    let results: Vec<Result<Seen, String>> = std::thread::scope(|scope| {
        let reads: Vec<_> = indexes
            .chunks(chunk.max(1))
            .map(|part| scope.spawn(move || read(part)))
            .collect();
        reads
            .into_iter()
            .map(|read| {
                read.join()
                    .unwrap_or_else(|_| Err("face finder crashed".into()))
            })
            .collect()
    });
    let mut out = BTreeMap::new();
    for result in results {
        out.extend(result?);
    }
    Ok(out)
}

/// No face detector off macOS: subtitles stay bottom middle.
#[cfg(not(target_os = "macos"))]
fn look(
    _source: &Path,
    _size: (u32, u32),
    _indexes: &[i64],
) -> Result<BTreeMap<i64, Vec<[f32; 4]>>, String> {
    Ok(BTreeMap::new())
}

/// A subtitle's place: its centre, project pixels from the frame's centre.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spot {
    pub x: f32,
    pub y: f32,
}

/// Room for the speaker's name above a subtitle's box, at 1080p.
const LABEL: f32 = 44.0;

/// How big a subtitle is: its box (wrapped at its style's width) and its label.
pub fn subtitle_size(text: &str, style: &TextStyle, height: u32) -> (f32, f32) {
    let k = height as f32 / 1080.0;
    let wrap = style.max_width.unwrap_or(1512.0 * k);
    let scale = style.size / (48.0 * k);
    let (w, h) = crate::subtitles::box_size(text, wrap / scale.max(0.1), k);
    let label = if style.label.is_some() {
        LABEL * k
    } else {
        0.0
    };
    (w * scale, h * scale + label)
}

/// The places a subtitle may sit, in the order they're tried: bottom
/// middle (the house place), bottom left and right, then top middle, left
/// and right (below the band at the top where bodycam stamps sit).
pub fn spots(size: (f32, f32), label: f32, frame: (f32, f32)) -> [Spot; 6] {
    spots_from(size, label, frame, 0.4 * frame.1)
}

/// `spots` with the bottom row's centre at `bottom` (project pixels below
/// the frame's centre): intro captions sit a little higher than subtitles.
fn spots_from(size: (f32, f32), label: f32, frame: (f32, f32), bottom: f32) -> [Spot; 6] {
    let (w, h) = size;
    let margin = 0.04 * frame.1;
    let side = (frame.0 / 2.0 - margin - w / 2.0).max(0.0);
    // Up top, the label's top sits just under the band where bodycam stamps
    // are; the box (whose centre the transform is) under the label.
    let top = -frame.1 / 2.0 + 0.12 * frame.1 + label + (h - label) / 2.0;
    [
        Spot { x: 0.0, y: bottom },
        Spot {
            x: -side,
            y: bottom,
        },
        Spot { x: side, y: bottom },
        Spot { x: 0.0, y: top },
        Spot { x: -side, y: top },
        Spot { x: side, y: top },
    ]
}

/// What a subtitle at `spot` covers ([x0, y0, x1, y1], its label included).
fn rect(spot: Spot, (w, h): (f32, f32), label: f32) -> [f32; 4] {
    // The transform is the box's centre; the label rides above it.
    let box_h = h - label;
    [
        spot.x - w / 2.0,
        spot.y - box_h / 2.0 - label,
        spot.x + w / 2.0,
        spot.y + box_h / 2.0,
    ]
}

pub fn overlap(a: [f32; 4], b: [f32; 4]) -> f32 {
    let w = (a[2].min(b[2]) - a[0].max(b[0])).max(0.0);
    let h = (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
    w * h
}

/// A face grown to take in the hair, chin and a margin around it.
pub fn grown(face: [f32; 4]) -> [f32; 4] {
    let (w, h) = (face[2] - face[0], face[3] - face[1]);
    [
        face[0] - 0.25 * w,
        face[1] - 0.35 * h,
        face[2] + 0.25 * w,
        face[3] + 0.2 * h,
    ]
}

/// Where a subtitle of `size` goes, with `faces` ([x0, y0, x1, y1] project
/// pixels from the frame's centre) seen while it's up and `previous` where
/// the line just before it sat (None after a pause or a cut).
pub fn place(
    size: (f32, f32),
    frame: (f32, f32),
    label: f32,
    faces: &[[f32; 4]],
    previous: Option<Spot>,
) -> Spot {
    place_from(size, frame, label, faces, previous, 0.4 * frame.1)
}

/// `place` with the house place's centre at `bottom` below the frame's centre.
pub fn place_from(
    size: (f32, f32),
    frame: (f32, f32),
    label: f32,
    faces: &[[f32; 4]],
    previous: Option<Spot>,
    bottom: f32,
) -> Spot {
    let spots = spots_from(size, label, frame, bottom);
    let faces: Vec<[f32; 4]> = faces.iter().copied().map(grown).collect();
    let covered = |spot: Spot, slack: f32| -> f32 {
        let [x0, y0, x1, y1] = rect(spot, size, label);
        let area = [x0 - slack, y0 - slack, x1 + slack, y1 + slack];
        faces.iter().map(|face| overlap(area, *face)).sum()
    };
    let house = spots[0];
    if covered(house, 0.0) <= 0.0 {
        // Clear; but a line that follows one moved off a face stays with it
        // while the face is still close by, rather than jumping back and forth.
        let near = 0.06 * frame.1;
        if let Some(previous) = previous.filter(|previous| {
            *previous != house
                && spots.contains(previous)
                && covered(*previous, 0.0) <= 0.0
                && covered(house, near) > 0.0
        }) {
            return previous;
        }
        return house;
    }
    if let Some(previous) = previous.filter(|previous| {
        *previous != house && spots.contains(previous) && covered(*previous, 0.0) <= 0.0
    }) {
        return previous;
    }
    spots
        .iter()
        .copied()
        .find(|spot| covered(*spot, 0.0) <= 0.0)
        .unwrap_or_else(|| {
            spots
                .iter()
                .copied()
                .min_by(|a, b| covered(*a, 0.0).total_cmp(&covered(*b, 0.0)))
                .unwrap_or(house)
        })
}

/// Whether a subtitle sits where Edit put it (one of its spots, no
/// keyframes), not moved by hand.
pub fn placed_by_edit(
    text: &str,
    style: &TextStyle,
    transform: &Transform,
    frame: (u32, u32),
) -> bool {
    let size = subtitle_size(text, style, frame.1);
    let label = if style.label.is_some() {
        LABEL * frame.1 as f32 / 1080.0
    } else {
        0.0
    };
    transform.scale == 1.0
        && transform.rotation == 0.0
        && spots(size, label, (frame.0 as f32, frame.1 as f32))
            .iter()
            .any(|spot| (spot.x - transform.x).abs() < 0.5 && (spot.y - transform.y).abs() < 0.5)
}

/// One subtitle to place: its clip, size and the footage under it.
struct Line {
    id: String,
    start: i64,
    end: i64,
    size: (f32, f32),
    label: f32,
    at: Transform,
    /// The picture under it: media path, size, the clip's transform, and
    /// the sample indexes seen while the subtitle is up.
    under: Option<Under>,
}

/// The footage under frame `at`: the topmost visible video clip of a video file.
pub(crate) fn picture_at(project: &Project, at: i64) -> Option<&edit_core::Clip> {
    let level = |track: &str| {
        project
            .tracks
            .iter()
            .position(|own| own.id == track && !own.hidden && !own.subtitles)
    };
    project
        .clips
        .iter()
        .filter(|clip| clip.start <= at && at < clip.end())
        .filter_map(|clip| Some((level(&clip.track)?, clip)))
        .filter(|(_, clip)| matches!(clip.content, ClipContent::Video { .. }))
        .max_by_key(|(level, _)| *level)
        .map(|(_, clip)| clip)
}

/// Moves the edit's subtitles between `from` and `to` (frames) off the
/// faces under them (see the module notes); subtitles moved by hand stay
/// put. Returns how many it looked at and moved.
pub async fn place_subtitles(
    app: &App,
    project_id: &str,
    from: i64,
    to: i64,
) -> Result<Value, String> {
    let started = std::time::Instant::now();
    let live = app.store.get(project_id).ok_or("no such project")?;
    let project = &live.project;
    let fps = project.fps();
    let (width, height) = (project.settings.width, project.settings.height);
    let frame = (width as f32, height as f32);
    let k = height as f32 / 1080.0;
    let mut lines = Vec::new();
    let mut by_hand = 0;
    for clip in &project.clips {
        let ClipContent::Text {
            text,
            style,
            transform,
            ..
        } = &clip.content
        else {
            continue;
        };
        // The edit's subtitles: speaker-labelled ones (a subtitled video's
        // keep Repack's places).
        if !clip
            .name
            .as_deref()
            .is_some_and(|name| name.starts_with(SUBTITLE))
            || style.label.is_none()
            || clip.start >= to
            || clip.end() <= from
        {
            continue;
        }
        if !clip.keyframes.is_empty() || !placed_by_edit(text, style, transform, (width, height)) {
            by_hand += 1;
            continue;
        }
        let middle = clip.start + clip.duration / 2;
        let under = picture_at(project, middle).and_then(|picture| {
            let ClipContent::Video {
                media,
                source_in,
                speed,
                transform,
                ..
            } = &picture.content
            else {
                return None;
            };
            let media = project
                .media(media)
                .filter(|media| media.kind == MediaKind::Video)?;
            let first = clip.start.max(picture.start);
            let last = clip.end().min(picture.end()).max(first + 1);
            let source = |frame: i64| source_in + (frame - picture.start) as f64 / fps * speed;
            let (a, b) = (source(first), source(last));
            let indexes: BTreeSet<i64> =
                ((a * RATE).floor() as i64..=(b * RATE).ceil() as i64).collect();
            Some((
                PathBuf::from(&media.path),
                (media.width, media.height),
                *transform,
                indexes,
            ))
        });
        lines.push(Line {
            id: clip.id.clone(),
            start: clip.start,
            end: clip.end(),
            size: subtitle_size(text, style, height),
            label: LABEL * k,
            at: *transform,
            under,
        });
    }
    lines.sort_by_key(|line| line.start);
    // Each file's samples, found side by side with nothing else (one file at a time).
    let mut wanted: BTreeMap<PathBuf, ((u32, u32), BTreeSet<i64>)> = BTreeMap::new();
    for (path, size, _, indexes) in lines.iter().filter_map(|line| line.under.as_ref()) {
        wanted
            .entry(path.clone())
            .or_insert_with(|| (*size, BTreeSet::new()))
            .1
            .extend(indexes);
    }
    let mut seen: HashMap<PathBuf, BTreeMap<i64, Vec<[f32; 4]>>> = HashMap::new();
    let mut failed = Vec::new();
    for (path, (size, indexes)) in wanted {
        let source = path.clone();
        let found = tokio::task::spawn_blocking(move || detect(&source, size, &indexes))
            .await
            .map_err(|error| error.to_string())
            .and_then(|found| found);
        match found {
            Ok(found) => {
                seen.insert(path, found);
            }
            Err(error) => {
                crate::diag::warn("subtitles", format!("faces in {}: {error}", path.display()));
                failed.push(path.to_string_lossy().into_owned());
            }
        }
    }
    // Where each goes, in order, each after the one before.
    let mut moves: Vec<(String, Transform, Spot)> = Vec::new();
    let mut previous: Option<(i64, Spot)> = None;
    let mut with_faces = 0;
    for line in &lines {
        let faces: Vec<[f32; 4]> = line
            .under
            .as_ref()
            .and_then(|(path, size, transform, indexes)| {
                let found = seen.get(path)?;
                let (mw, mh) = (f64::from(size.0.max(1)), f64::from(size.1.max(1)));
                let fit = (f64::from(width) / mw).min(f64::from(height) / mh)
                    * f64::from(transform.scale);
                let to_frame = |x: f32, y: f32| {
                    (
                        ((f64::from(x) - 0.5) * mw * fit + f64::from(transform.x)) as f32,
                        ((f64::from(y) - 0.5) * mh * fit + f64::from(transform.y)) as f32,
                    )
                };
                Some(
                    indexes
                        .iter()
                        .filter_map(|index| found.get(index))
                        .flatten()
                        .map(|[x0, y0, x1, y1]| {
                            let (a, b) = (to_frame(*x0, *y0), to_frame(*x1, *y1));
                            [a.0, a.1, b.0, b.1]
                        })
                        .collect(),
                )
            })
            .unwrap_or_default();
        if !faces.is_empty() {
            with_faces += 1;
        }
        // The line before counts when it ended within a second of this one.
        let before = previous
            .filter(|(end, _)| line.start - end <= fps.round() as i64)
            .map(|(_, spot)| spot);
        let spot = place(line.size, frame, line.label, &faces, before);
        previous = Some((line.end, spot));
        if (spot.x - line.at.x).abs() >= 0.5 || (spot.y - line.at.y).abs() >= 0.5 {
            moves.push((line.id.clone(), line.at, spot));
        }
    }
    let (live, moved) = app.store.update(project_id, "agent", |project| {
        let mut moved = 0;
        for (id, was, spot) in &moves {
            let Some(clip) = project.clip_mut(id) else {
                continue;
            };
            if let ClipContent::Text { transform, .. } = &mut clip.content {
                // Moved meanwhile (by hand): theirs stands.
                if transform == was {
                    transform.x = spot.x;
                    transform.y = spot.y;
                    moved += 1;
                }
            }
        }
        Ok(moved)
    })?;
    let off_house = live
        .project
        .clips
        .iter()
        .filter(|clip| {
            clip.name
                .as_deref()
                .is_some_and(|name| name.starts_with(SUBTITLE))
                && clip.start < to
                && clip.end() > from
        })
        .filter(|clip| {
            matches!(&clip.content, ClipContent::Text { transform, style, .. }
                if style.label.is_some() && (transform.x != 0.0 || (transform.y - 0.4 * frame.1).abs() >= 0.5))
        })
        .count();
    crate::diag::record("subtitles", "faces: placed", started.elapsed(), None);
    Ok(json!({
        "rev": live.rev,
        "subtitles": lines.len(),
        "with_a_face_under_them": with_faces,
        "moved": moved,
        "off_bottom_middle_now": off_house,
        "moved_by_hand_left_alone": by_hand,
        "footage_not_analysed": failed,
    }))
}

/// A face at least this tall (share of the picture's height) is clearly
/// visible: smaller ones are people across the room, or not faces at all.
pub const CLEAR: f32 = 0.07;

/// The faces found in `source` so far, without looking at anything new (the audit).
pub fn cached(source: &Path) -> Option<BTreeMap<i64, Vec<[f32; 4]>>> {
    let file = crate::tools::media_cache(source)?.join(FILE);
    let found: Found = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    Some(found.samples)
}

/// The sample indexes seen between source seconds `a` and `b`.
pub fn indexes_between(a: f64, b: f64) -> BTreeSet<i64> {
    let (a, b) = (a.min(b), a.max(b));
    ((a * RATE).floor() as i64..=(b * RATE).ceil() as i64).collect()
}

/// A face (shares of the picture) in project pixels from the frame's centre,
/// through the footage clip's fit and `transform`.
pub fn in_frame(
    media: (u32, u32),
    transform: &Transform,
    frame: (u32, u32),
    face: [f32; 4],
) -> [f32; 4] {
    let (mw, mh) = (f64::from(media.0.max(1)), f64::from(media.1.max(1)));
    let fit = (f64::from(frame.0) / mw).min(f64::from(frame.1) / mh) * f64::from(transform.scale);
    let x = |share: f32| ((f64::from(share) - 0.5) * mw * fit + f64::from(transform.x)) as f32;
    let y = |share: f32| ((f64::from(share) - 0.5) * mh * fit + f64::from(transform.y)) as f32;
    [x(face[0]), y(face[1]), x(face[2]), y(face[3])]
}

fn centre(face: [f32; 4]) -> (f32, f32) {
    ((face[0] + face[2]) / 2.0, (face[1] + face[3]) / 2.0)
}

fn iou(a: [f32; 4], b: [f32; 4]) -> f32 {
    let both = overlap(a, b);
    let area = |r: [f32; 4]| (r[2] - r[0]).max(0.0) * (r[3] - r[1]).max(0.0);
    both / (area(a) + area(b) - both).max(1e-9)
}

/// The face in `faces` that `target` (a box drawn around someone) means: the
/// one it overlaps most, else the nearest whose centre is within a face's
/// size of the box's. None when no face there: a hand, a car, an empty spot.
pub fn pick(faces: &[[f32; 4]], target: [f32; 4]) -> Option<[f32; 4]> {
    let overlapping = faces
        .iter()
        .copied()
        .map(|face| (iou(face, target), face))
        .filter(|(share, _)| *share > 0.0)
        .max_by(|a, b| a.0.total_cmp(&b.0));
    if let Some((_, face)) = overlapping {
        return Some(face);
    }
    let (tx, ty) = centre(target);
    faces
        .iter()
        .copied()
        .filter_map(|face| {
            let (x, y) = centre(face);
            let distance = ((x - tx).powi(2) + (y - ty).powi(2)).sqrt();
            let size = (face[2] - face[0]).max(face[3] - face[1]);
            (distance <= size).then_some((distance, face))
        })
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, face)| face)
}

/// One face followed through `indexes` (sorted) from sample `at`, where it is
/// `start`: at each sample, the face of a like size nearest where it last was
/// (within about its own height); a sample where it isn't found is left out,
/// and after two misses in a row (a second) it's lost that way. No template
/// matching: nothing drifts onto a hand or a wall.
pub fn follow(
    found: &BTreeMap<i64, Vec<[f32; 4]>>,
    indexes: &[i64],
    at: i64,
    start: [f32; 4],
) -> Vec<(i64, [f32; 4])> {
    let step = |from: [f32; 4], index: i64| -> Option<[f32; 4]> {
        let (cx, cy) = centre(from);
        let size = (from[3] - from[1]).max(1e-3);
        found
            .get(&index)?
            .iter()
            .copied()
            .filter(|face| {
                let ratio = (face[3] - face[1]) / size;
                (0.6..=1.6).contains(&ratio)
            })
            .map(|face| {
                let (x, y) = centre(face);
                (((x - cx).powi(2) + (y - cy).powi(2)).sqrt(), face)
            })
            .filter(|(distance, _)| *distance <= 0.9 * size)
            .min_by(|a, b| a.0.total_cmp(&b.0))
            .map(|(_, face)| face)
    };
    let walk = |order: &mut dyn Iterator<Item = &i64>| {
        let (mut last, mut misses, mut got) = (start, 0, Vec::new());
        for &index in order {
            match step(last, index) {
                Some(face) => {
                    last = face;
                    misses = 0;
                    got.push((index, face));
                }
                None => {
                    misses += 1;
                    if misses > 2 {
                        break;
                    }
                }
            }
        }
        got
    };
    let split = indexes.partition_point(|index| *index < at);
    let (before, after) = indexes.split_at(split);
    let mut out = walk(&mut before.iter().rev());
    out.extend(walk(&mut after.iter()));
    out.sort_by_key(|(index, _)| *index);
    out
}

/// Whether a followed face is clearly visible through `samples` samples:
/// found in at least three in four, and big enough to be someone close by.
pub fn clearly_visible(track: &[(i64, [f32; 4])], samples: usize) -> bool {
    if track.is_empty() || samples == 0 {
        return false;
    }
    let mut heights: Vec<f32> = track.iter().map(|(_, face)| face[3] - face[1]).collect();
    heights.sort_by(f32::total_cmp);
    track.len() * 4 >= samples * 3
        && heights
            .get(heights.len() / 2)
            .is_some_and(|height| *height >= CLEAR)
}

/// Points smoothed (twice 1-2-1), so text pinned to a face glides rather than jitters.
pub fn smooth(points: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut out = points.to_vec();
    for _ in 0..2 {
        let was = out.clone();
        for (i, point) in out.iter_mut().enumerate() {
            let here = *point;
            let before = i
                .checked_sub(1)
                .and_then(|j| was.get(j))
                .copied()
                .unwrap_or(here);
            let after = was.get(i + 1).copied().unwrap_or(here);
            *point = (
                (before.0 + 2.0 * here.0 + after.0) / 4.0,
                (before.1 + 2.0 * here.1 + after.1) / 4.0,
            );
        }
    }
    out
}

/// Subtitles and intro captions on someone's face (the audit): each at its
/// middle frame against the faces found there, from the cache only (footage
/// not analysed yet says nothing).
pub fn text_on_faces(project: &Project) -> Vec<Value> {
    let fps = project.fps();
    let (width, height) = (project.settings.width, project.settings.height);
    let k = height as f32 / 1080.0;
    let mut cache: HashMap<PathBuf, Option<Faces>> = HashMap::new();
    let mut out = Vec::new();
    for clip in &project.clips {
        let ClipContent::Text {
            text,
            style,
            transform,
            ..
        } = &clip.content
        else {
            continue;
        };
        let name = clip.name.as_deref().unwrap_or_default();
        let subtitle = name.starts_with(SUBTITLE) && style.label.is_some();
        let caption = name.starts_with(crate::captions::CAPTION_PREFIX);
        if !subtitle && !caption {
            continue;
        }
        let middle = clip.start + clip.duration / 2;
        let Some(picture) = picture_at(project, middle) else {
            continue;
        };
        let ClipContent::Video {
            media,
            source_in,
            speed,
            transform: fit,
            ..
        } = &picture.content
        else {
            continue;
        };
        let Some(media) = project
            .media(media)
            .filter(|media| media.kind == MediaKind::Video)
        else {
            continue;
        };
        let path = PathBuf::from(&media.path);
        let Some(found) = cache
            .entry(path.clone())
            .or_insert_with(|| cached(&path))
            .as_ref()
        else {
            continue;
        };
        let time = source_in + (middle - picture.start) as f64 / fps * speed;
        let Some(faces) = found.get(&((time * RATE).round() as i64)) else {
            continue;
        };
        let local = (middle - clip.start) as f32;
        let at = |param: &str, base: f32| {
            clip.keyframes
                .get(param)
                .and_then(|keys| edit_core::sample(keys, local))
                .unwrap_or(base)
        };
        let spot = Spot {
            x: at("x", transform.x),
            y: at("y", transform.y),
        };
        let area = if subtitle {
            rect(spot, subtitle_size(text, style, height), LABEL * k)
        } else {
            let (w, h) = crate::captions::caption_size(text, style);
            rect(spot, (w as f32, h as f32), 0.0)
        };
        let covered = faces.iter().any(|face| {
            let face = in_frame((media.width, media.height), fit, (width, height), *face);
            let size = (face[2] - face[0]) * (face[3] - face[1]);
            overlap(area, face) > 0.1 * size
        });
        if covered {
            out.push(
                json!({"kind": "text_on_face", "clip": clip.id, "start": clip.start,
                "fix": if caption { "place_captions" } else { "place_subtitles" }}),
            );
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME: (f32, f32) = (1920.0, 1080.0);

    #[test]
    fn a_face_is_followed_not_a_hand() {
        // A face walking right, a hand that pops up beside it at sample 3.
        let mut found = BTreeMap::new();
        for i in 0..8_i64 {
            let x = 0.3 + 0.01 * i as f32;
            let mut faces = vec![[x, 0.2, x + 0.08, 0.35]];
            if i == 3 {
                faces.push([0.0, 0.0, 0.2, 0.3]);
            }
            found.insert(i, faces);
        }
        found.insert(5, Vec::new());
        let indexes: Vec<i64> = (0..8).collect();
        let start = pick(&found[&4], [0.33, 0.18, 0.4, 0.36]).unwrap();
        let track = follow(&found, &indexes, 4, start);
        assert_eq!(track.len(), 7, "every sample but the missed one");
        assert!(track.iter().all(|(_, face)| face[0] >= 0.3));
        assert!(clearly_visible(&track, indexes.len()));
        // A box around a hand, with no face there: nobody.
        assert_eq!(pick(&found[&4], [0.8, 0.7, 0.95, 0.95]), None);
        // A face far away is not clearly visible.
        let far = vec![(0, [0.5, 0.5, 0.52, 0.53]); 8];
        assert!(!clearly_visible(&far, 8));
    }

    fn size() -> (f32, f32) {
        let style = crate::captions::subtitle_style(1920, 1080);
        let style = TextStyle {
            label: Some(edit_core::TextLabel {
                text: "Sister:".into(),
                color: edit_core::Rgba::WHITE,
                size: 26.0,
            }),
            ..style
        };
        subtitle_size("her to stop.", &style, 1080)
    }

    #[test]
    fn no_face_keeps_the_house_place() {
        let spot = place(size(), FRAME, LABEL, &[], None);
        assert_eq!(spot, Spot { x: 0.0, y: 432.0 });
        // A face high in the frame is no matter.
        let high = [[-100.0, -300.0, 100.0, -100.0]];
        assert_eq!(place(size(), FRAME, LABEL, &high, None).y, 432.0);
    }

    #[test]
    fn a_low_face_moves_the_subtitle_off_it() {
        // The camera looks down at someone: their face bottom middle.
        let face = [-90.0, 300.0, 90.0, 480.0];
        let spot = place(size(), FRAME, LABEL, &[face], None);
        assert_ne!(spot, Spot { x: 0.0, y: 432.0 });
        assert_eq!(overlap(rect(spot, size(), LABEL), grown(face)), 0.0);
        // Still at the bottom, to the side.
        assert_eq!(spot.y, 432.0);
        // Faces across the whole bottom: to the top, under the stamp.
        let row = [
            [-900.0, 300.0, -500.0, 520.0],
            [-200.0, 300.0, 200.0, 520.0],
            [500.0, 300.0, 900.0, 520.0],
        ];
        let spot = place(size(), FRAME, LABEL, &row, None);
        assert!(spot.y < 0.0);
        let [_, top, _, _] = rect(spot, size(), LABEL);
        assert!(top >= -540.0 + 0.11 * 1080.0, "{top}");
    }

    #[test]
    fn a_conversation_does_not_jump_about() {
        let face = [-90.0, 300.0, 90.0, 480.0];
        let first = place(size(), FRAME, LABEL, &[face], None);
        // The face drifts up a little: the next line could go back to the
        // middle, but it stays beside them while they're that close.
        let drifted = [-90.0, 220.0, 90.0, 330.0];
        let next = place(size(), FRAME, LABEL, &[drifted], Some(first));
        assert_eq!(next, first);
        // Once they're gone it comes back.
        assert_eq!(
            place(size(), FRAME, LABEL, &[], Some(first)),
            Spot { x: 0.0, y: 432.0 }
        );
    }

    #[test]
    fn edit_places_are_known_from_hand_moves() {
        let style = crate::captions::subtitle_style(1920, 1080);
        let house = Transform {
            y: 432.0,
            ..Transform::default()
        };
        assert!(placed_by_edit("her to stop.", &style, &house, (1920, 1080)));
        let spot = spots(subtitle_size("her to stop.", &style, 1080), 0.0, FRAME)[4];
        let moved = Transform {
            x: spot.x,
            y: spot.y,
            ..Transform::default()
        };
        assert!(placed_by_edit("her to stop.", &style, &moved, (1920, 1080)));
        let by_hand = Transform {
            y: -300.0,
            ..Transform::default()
        };
        assert!(!placed_by_edit(
            "her to stop.",
            &style,
            &by_hand,
            (1920, 1080)
        ));
    }
}
