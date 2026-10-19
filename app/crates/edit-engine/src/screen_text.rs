//! Words on screen in footage: Apple's Vision text recognition on frames of
//! the light preview, one a second of source, kept per file in its cache dir
//! (`text-v1.json`) like the faces (faces.rs). What it's for: another
//! channel's burned-in calls to action ("SUBSCRIBE", the bell) and logos in a
//! re-upload, which the team wants blurred wherever they show (Corrupt Cop's
//! "Subscribe should be blurred here. This could appear throughout the
//! video"). Off macOS nothing is found.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Frames looked at per second of source.
pub const RATE: f64 = 1.0;
/// The analysis's file in the media's cache dir; a new method is a new file.
const FILE: &str = "text-v1.json";
/// How wide the frames looked at are: a channel's subscribe button reads at this size.
const WIDE: u32 = 960;
/// Text the recogniser is less sure of is ignored.
const SURE: f32 = 0.3;

/// One piece of text seen: its box (x0, y0, x1, y1 as shares of the picture
/// from its top left) and what it says.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Seen {
    pub b: [f64; 4],
    pub t: String,
}

/// The text at each sample index (source seconds × RATE).
pub type Texts = BTreeMap<i64, Vec<Seen>>;

/// One stretch's reads, index by index.
#[cfg(target_os = "macos")]
type Read = Vec<(i64, Vec<Seen>)>;

#[derive(Default, Deserialize, Serialize)]
struct Found {
    samples: Texts,
}

/// The text at `indexes` (source seconds × RATE) of the footage at `source`
/// (`size` its picture size): from its cache, the rest read now. Blocking:
/// call from spawn_blocking.
pub fn detect(source: &Path, size: (u32, u32), indexes: &BTreeSet<i64>) -> Result<Texts, String> {
    // One read per file at a time (faces.rs's locks, under a key of its own).
    let lock = crate::faces::lock_for(&source.with_extension("text"));
    let _held = lock.lock();
    let file = crate::util::media_cache(source).map(|dir| dir.join(FILE));
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
            crate::util::write_atomic(&file, &bytes).map_err(|error| error.to_string())?;
        }
    }
    Ok(indexes
        .iter()
        .filter_map(|index| Some((*index, found.samples.get(index)?.clone())))
        .collect())
}

/// Reads the text at `indexes` (sorted): the light preview decoded by
/// AVFoundation, in up to three stretches side by side, each frame given to Vision.
#[cfg(target_os = "macos")]
fn look(source: &Path, (width, height): (u32, u32), indexes: &[i64]) -> Result<Texts, String> {
    let wide = WIDE.min(width.max(2)) & !1;
    let decode = crate::track::decode_source(source, wide as usize);
    let high = ((f64::from(wide) * f64::from(height.max(1)) / f64::from(width.max(1))).round()
        as u32
        & !1)
        .max(2);
    let parts = indexes.len().div_ceil(300).clamp(1, 3);
    let chunk = indexes.len().div_ceil(parts);
    let read = |part: &[i64]| -> Result<Read, String> {
        let mut reader = crate::mac_media::Reader::open(&decode, wide, high)?;
        let mut bgra = vec![0_u8; wide as usize * high as usize * 4];
        let mut out = Vec::with_capacity(part.len());
        for &index in part {
            let time = index as f64 / RATE;
            // As faces.rs: a failed read is tried once more on a fresh reader,
            // else the whole look fails rather than caching "no text" for good.
            if let Err(error) = reader.frame(time, &mut bgra, crate::render::Order::Bgra, false) {
                crate::log::warn(
                    "screen text",
                    format!(
                        "reading {} at {time:.2}s: {error}; opening it again",
                        decode.display()
                    ),
                );
                reader = crate::mac_media::Reader::open(&decode, wide, high)?;
                reader
                    .frame(time, &mut bgra, crate::render::Order::Bgra, false)
                    .map_err(|error| {
                        format!(
                            "couldn't read {} at {time:.2}s to find text: {error}",
                            decode.display()
                        )
                    })?;
            }
            let seen = crate::mac_media::text(&bgra, wide, high)?
                .into_iter()
                .filter(|(_, sure, _)| *sure >= SURE)
                .map(|(b, _, t)| Seen {
                    b: b.map(|value| (f64::from(value).clamp(0.0, 1.0) * 1000.0).round() / 1000.0),
                    t,
                })
                .collect();
            out.push((index, seen));
        }
        Ok(out)
    };
    let results: Vec<Result<Read, String>> = std::thread::scope(|scope| {
        let reads: Vec<_> = indexes
            .chunks(chunk.max(1))
            .map(|part| scope.spawn(move || read(part)))
            .collect();
        reads
            .into_iter()
            .map(|read| {
                read.join()
                    .unwrap_or_else(|_| Err("text finder crashed".into()))
            })
            .collect()
    });
    let mut out = BTreeMap::new();
    for result in results {
        out.extend(result?);
    }
    Ok(out)
}

/// No text recogniser off macOS.
#[cfg(not(target_os = "macos"))]
fn look(_source: &Path, _size: (u32, u32), _indexes: &[i64]) -> Result<Texts, String> {
    Ok(BTreeMap::new())
}

/// The text read in `source` so far, without looking at anything new (the audit).
pub fn cached(source: &Path) -> Option<Texts> {
    let file = crate::util::media_cache(source)?.join(FILE);
    let found: Found = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    Some(found.samples)
}
