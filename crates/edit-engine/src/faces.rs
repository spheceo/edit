//! Faces in footage: Apple's Vision face detector on small frames of the
//! light preview, two a second of source, kept per file in its cache dir
//! (`faces-v1.json`) so a second run, another project using the same
//! footage, or a re-run reads them back. Off macOS nothing is found.
//! Placing subtitles and captions around them is the server's.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// The faces found at each sample index ([x0, y0, x1, y1] shares of the frame).
pub type Faces = BTreeMap<i64, Vec<[f32; 4]>>;
/// One stretch's faces, index by index.
type Seen = Vec<(i64, Vec<[f32; 4]>)>;

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
/// Faces at each sample (index = source seconds × RATE): x0, y0, x1, y1 as
/// shares of the picture from its top left.
#[derive(Default, Deserialize, Serialize)]
struct Found {
    samples: BTreeMap<i64, Vec<[f32; 4]>>,
}

/// One analysis per file at a time (a second caller waits and reads it).
static BUSY: Mutex<Option<HashMap<PathBuf, Arc<Mutex<()>>>>> = Mutex::new(None);

/// The lock held while `path` is analysed.
pub fn lock_for(path: &Path) -> Arc<Mutex<()>> {
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
            // The reader holds its last picture past the end, so a failure is
            // real: tried once more on a fresh reader, else the whole look
            // fails rather than caching "no faces" for good.
            if let Err(error) = reader.frame(time, &mut bgra, crate::render::Order::Bgra, false) {
                crate::log::warn(
                    "faces",
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
                            "couldn't read {} at {time:.2}s to find faces: {error}",
                            decode.display()
                        )
                    })?;
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

/// The faces found in `source` so far, without looking at anything new (the audit).
pub fn cached(source: &Path) -> Option<BTreeMap<i64, Vec<[f32; 4]>>> {
    let file = crate::util::media_cache(source)?.join(FILE);
    let found: Found = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    Some(found.samples)
}
