//! Region tracking: follows a box (a face, a redaction block) through footage
//! by template matching on small greyscale frames, the way After Effects'
//! point tracker does. No models and no extra dependencies.
//!
//! The frames are decoded small (the tracker only ever looks at the box about
//! 32 px wide), from the media's light preview when it has one, in hardware
//! on macOS, and kept for a few minutes so another pass on the same shot (a
//! label, then its leader) doesn't decode again. Matching searches a half-size
//! picture first and then refines around the best spots at full size, without
//! allocating per candidate.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

/// Frames per second the footage is looked at.
pub const SAMPLE_RATE: f64 = 15.0;
/// The box is looked at this many pixels wide (smaller is faster, bigger finer).
const BOX_WIDTH: f64 = 32.0;
/// How far (in looked-at pixels) the box may move between samples.
const REACH: i32 = 12;
/// Below this match the box is lost: it holds where it was last seen.
const LOST: f32 = 0.35;
/// Footage tracked at most in one go (seconds).
const MAX_SPAN: f64 = 180.0;
/// Frames are decoded at most this wide…
const MAX_WIDTH: f64 = 640.0;
/// …and one pass holds at most this many bytes of them.
const MAX_BYTES: f64 = 160.0 * 1024.0 * 1024.0;
/// Decoded frames kept for another pass on the same shot: this long…
const KEEP: Duration = Duration::from_secs(180);
/// …within this many bytes.
const KEEP_BYTES: usize = 256 << 20;

/// Where the box's centre is at `time` (seconds into the source), in source pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub time: f64,
    pub x: f64,
    pub y: f64,
}

/// Follows `region` ([x0, y0, x1, y1] in source pixels, as it is at `at`
/// seconds) from `from` to `to` seconds of the source at `path`.
pub fn track(
    path: &Path,
    size: (u32, u32),
    from: f64,
    to: f64,
    at: f64,
    region: [f64; 4],
) -> Result<Vec<Sample>, String> {
    let (source_w, source_h) = (f64::from(size.0.max(1)), f64::from(size.1.max(1)));
    let [x0, y0, x1, y1] = region;
    let (box_w, box_h) = ((x1 - x0).abs().max(4.0), (y1 - y0).abs().max(4.0));
    let to = to.min(from + MAX_SPAN);
    if to <= from {
        return Err("nothing to track".into());
    }
    // Look at the footage so the box is about BOX_WIDTH pixels wide, within
    // what's worth decoding and holding.
    let count = ((to - from) * SAMPLE_RATE).ceil().max(1.0);
    let cap = (MAX_WIDTH / source_w)
        .min((MAX_BYTES / count / (source_w * source_h)).sqrt())
        .min(1.0);
    let scale = (BOX_WIDTH / box_w).min(cap).max((96.0 / source_w).min(1.0));
    let (width, height) = (even(source_w * scale), even(source_h * scale));
    let frames = frames(path, from, to, width, height)?;
    if frames.count == 0 {
        return Err("couldn't decode the footage to track".into());
    }
    let (sx, sy) = (
        f64::from(width as u32) / source_w,
        f64::from(height as u32) / source_h,
    );
    let start = (((at - from) * SAMPLE_RATE).round().max(0.0) as usize).min(frames.count - 1);
    let (tw, th) = (
        ((box_w * sx).round() as usize).clamp(6, 96),
        ((box_h * sy).round() as usize).clamp(6, 96),
    );
    let centre = (((x0 + x1) / 2.0 * sx) as f32, ((y0 + y1) / 2.0 * sy) as f32);
    let centres = follow(&frames, start, centre, tw, th);

    // A short moving average takes out the tracker's own jitter.
    let smooth: Vec<(f32, f32)> = (0..centres.len())
        .map(|index| {
            let window = centres
                .get(index.saturating_sub(2)..(index + 3).min(centres.len()))
                .unwrap_or_default();
            let n = window.len() as f32;
            (
                window.iter().map(|c| c.0).sum::<f32>() / n,
                window.iter().map(|c| c.1).sum::<f32>() / n,
            )
        })
        .collect();
    Ok(smooth
        .into_iter()
        .enumerate()
        .map(|(index, (x, y))| Sample {
            time: from + index as f64 / SAMPLE_RATE,
            x: f64::from(x) / sx,
            y: f64::from(y) / sy,
        })
        .collect())
}

/// The box's centre in every frame, followed forwards and backwards from
/// `start` (side by side).
fn follow(
    frames: &Frames,
    start: usize,
    centre: (f32, f32),
    tw: usize,
    th: usize,
) -> Vec<(f32, f32)> {
    let pass = |direction: i64| {
        let mut found = Vec::new();
        let mut template = Template::new(tw, th);
        let mut tracker = Tracker::default();
        frames
            .image(start)
            .patch_into(centre, tw, th, &mut template.raw);
        template.prepare();
        let mut at = centre;
        let mut index = start as i64 + direction;
        while index >= 0 && (index as usize) < frames.count {
            let frame = frames.image(index as usize);
            if let Some((spot, score)) = tracker.best_match(&frame, &template, at) {
                if score >= LOST {
                    at = spot;
                    // Let the pattern follow slow changes (a turning head) when the match is good.
                    if score > 0.6 {
                        frame.patch_into(at, tw, th, &mut tracker.fresh);
                        for (old, new) in template.raw.iter_mut().zip(&tracker.fresh) {
                            *old = *old * 0.85 + new * 0.15;
                        }
                        template.prepare();
                    }
                }
            }
            found.push((index as usize, at));
            index += direction;
        }
        found
    };
    let mut centres = vec![centre; frames.count];
    let (forward, backward) = std::thread::scope(|scope| {
        let forward = scope.spawn(|| pass(1));
        let backward = pass(-1);
        (forward.join().unwrap_or_default(), backward)
    });
    for (index, at) in forward.into_iter().chain(backward) {
        if let Some(centre) = centres.get_mut(index) {
            *centre = at;
        }
    }
    centres
}

fn even(value: f64) -> usize {
    ((value.round() as usize) / 2 * 2).max(2)
}

/// Greyscale frames, `SAMPLE_RATE` a second, one after another.
struct Frames {
    width: usize,
    height: usize,
    count: usize,
    pixels: Vec<u8>,
}

impl Frames {
    fn image(&self, index: usize) -> Image<'_> {
        let size = self.width * self.height;
        Image {
            pixels: self
                .pixels
                .get(index * size..(index + 1) * size)
                .unwrap_or_default(),
            width: self.width,
            height: self.height,
        }
    }
}

type FramesKey = (String, u64, u64, usize, usize);

#[derive(Default)]
struct Kept {
    frames: HashMap<FramesKey, (Arc<Frames>, Instant)>,
    /// One decode per key at a time; a second pass waits and reuses it.
    working: HashMap<FramesKey, Arc<Mutex<()>>>,
}

fn kept() -> &'static Mutex<Kept> {
    static KEPT: OnceLock<Mutex<Kept>> = OnceLock::new();
    KEPT.get_or_init(Default::default)
}

/// The frames of `path` from `from` to `to` at `width`×`height`: kept from a
/// pass a moment ago, or decoded now.
fn frames(
    path: &Path,
    from: f64,
    to: f64,
    width: usize,
    height: usize,
) -> Result<Arc<Frames>, String> {
    let key: FramesKey = (
        crate::media::media_key(path),
        (from * 1000.0).round() as u64,
        (to * 1000.0).round() as u64,
        width,
        height,
    );
    let lookup = |kept: &mut Kept| {
        kept.frames.retain(|_, (_, used)| used.elapsed() < KEEP);
        kept.frames.get_mut(&key).map(|(frames, used)| {
            *used = Instant::now();
            Arc::clone(frames)
        })
    };
    if let Some(frames) = lookup(&mut kept().lock()) {
        return Ok(frames);
    }
    let lock = Arc::clone(kept().lock().working.entry(key.clone()).or_default());
    let _working = lock.lock();
    if let Some(frames) = lookup(&mut kept().lock()) {
        return Ok(frames);
    }
    let decoded = crate::diag::time_on("agent", "track: decode", &path.to_string_lossy(), || {
        decode(path, from, to, width, height)
    })
    .map(Arc::new);
    let mut kept = kept().lock();
    kept.working.remove(&key);
    let frames = decoded?;
    kept.frames
        .insert(key, (Arc::clone(&frames), Instant::now()));
    while kept.frames.len() > 1
        && kept
            .frames
            .values()
            .map(|(frames, _)| frames.pixels.len())
            .sum::<usize>()
            > KEEP_BYTES
    {
        let Some(oldest) = kept
            .frames
            .iter()
            .min_by_key(|(_, (_, used))| *used)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        kept.frames.remove(&oldest);
    }
    Ok(frames)
}

/// What to decode: the media's light preview (720p, made in the background
/// for every video) when it's there, which is a fraction of the work of a
/// full-resolution original and plenty for a box looked at 32 px wide.
fn decode_source(path: &Path) -> PathBuf {
    crate::tools::media_cache(path)
        // `media::Processor::paths`' name for it.
        .map(|dir| dir.join("preview-light.mp4"))
        .filter(|light| light.is_file())
        .unwrap_or_else(|| path.to_owned())
}

/// Greyscale frames of the source between `from` and `to`, SAMPLE_RATE a second.
fn decode(path: &Path, from: f64, to: f64, width: usize, height: usize) -> Result<Frames, String> {
    let source = decode_source(path);
    #[cfg(target_os = "macos")]
    if std::env::var_os("EDIT_FFMPEG_VIDEO").is_none() {
        match decode_native(&source, from, to, width, height) {
            Ok(frames) if frames.count > 0 => return Ok(frames),
            Ok(_) => {}
            Err(error) => crate::diag::info(
                "agent",
                format!(
                    "track: native decode of {} failed ({error}); using FFmpeg",
                    source.display()
                ),
            ),
        }
    }
    decode_ffmpeg(&source, from, to, width, height)
}

/// AVFoundation (hardware decode, scaled as it's decoded).
#[cfg(target_os = "macos")]
fn decode_native(
    path: &Path,
    from: f64,
    to: f64,
    width: usize,
    height: usize,
) -> Result<Frames, String> {
    let count = ((to - from) * SAMPLE_RATE).ceil().max(1.0) as usize;
    // A long span is read in a few stretches side by side (each its own
    // decoder session): the hardware keeps up with more than one.
    let parts = (count / 150).clamp(1, 3);
    let read_part = |part: usize| -> Result<Vec<u8>, String> {
        let (first, last) = (count * part / parts, count * (part + 1) / parts);
        let mut reader = crate::mac_media::Reader::open(path, width as u32, height as u32)?;
        let mut bgra = vec![0_u8; width * height * 4];
        let mut pixels = Vec::with_capacity((last - first) * width * height);
        for index in first..last {
            let time = from + index as f64 / SAMPLE_RATE;
            if reader
                .frame(time, &mut bgra, crate::render::Order::Bgra, false)
                .is_err()
            {
                // Past the end of the file: what was decoded is all there is.
                if index > 0 {
                    break;
                }
                return Err("no frame at the start of the span".into());
            }
            // BT.601 luma, as FFmpeg's gray.
            pixels.extend(bgra.as_chunks::<4>().0.iter().map(|[b, g, r, _]| {
                ((77 * u32::from(*r) + 150 * u32::from(*g) + 29 * u32::from(*b) + 128) >> 8) as u8
            }));
        }
        Ok(pixels)
    };
    let read: Vec<Result<Vec<u8>, String>> = std::thread::scope(|scope| {
        let reads: Vec<_> = (0..parts)
            .map(|part| scope.spawn(move || read_part(part)))
            .collect();
        reads
            .into_iter()
            .map(|read| {
                read.join()
                    .unwrap_or_else(|_| Err("decoder crashed".into()))
            })
            .collect()
    });
    let mut pixels = Vec::with_capacity(count * width * height);
    for (part, read) in read.into_iter().enumerate() {
        let read = read?;
        let whole =
            read.len() == (count * (part + 1) / parts - count * part / parts) * width * height;
        pixels.extend(read);
        if !whole {
            break;
        }
    }
    Ok(Frames {
        width,
        height,
        count: pixels.len() / (width * height),
        pixels,
    })
}

fn decode_ffmpeg(
    path: &Path,
    from: f64,
    to: f64,
    width: usize,
    height: usize,
) -> Result<Frames, String> {
    let mut command = Command::new(crate::tools::ffmpeg());
    command.args(["-hide_banner", "-loglevel", "error"]);
    if cfg!(target_os = "macos") {
        // Hardware decoding where it can (FFmpeg falls back by itself).
        command.args(["-hwaccel", "videotoolbox"]);
    }
    let mut child = command
        .args([
            "-ss",
            &format!("{from:.4}"),
            "-t",
            &format!("{:.4}", to - from),
            "-protocol_whitelist",
            "file,pipe",
            "-i",
        ])
        .arg(path)
        .args([
            "-an",
            "-vf",
            &format!("fps={SAMPLE_RATE},scale={width}:{height}:flags=area,format=gray"),
            "-f",
            "rawvideo",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    let mut stdout = child.stdout.take().ok_or("ffmpeg stdout")?;
    let mut pixels = Vec::new();
    let read = stdout.read_to_end(&mut pixels);
    let _ = child.wait();
    read.map_err(|error| error.to_string())?;
    let size = width * height;
    pixels.truncate(pixels.len() / size * size);
    Ok(Frames {
        width,
        height,
        count: pixels.len() / size,
        pixels,
    })
}

struct Image<'a> {
    pixels: &'a [u8],
    width: usize,
    height: usize,
}

impl Image<'_> {
    fn at(&self, x: i64, y: i64) -> f32 {
        let x = x.clamp(0, self.width as i64 - 1) as usize;
        let y = y.clamp(0, self.height as i64 - 1) as usize;
        self.pixels
            .get(y * self.width + x)
            .map_or(0.0, |pixel| f32::from(*pixel))
    }

    /// The `tw`×`th` patch centred at `centre`, into `out`.
    fn patch_into(&self, centre: (f32, f32), tw: usize, th: usize, out: &mut Vec<f32>) {
        let (left, top) = corner(centre, tw, th);
        out.clear();
        for y in 0..th as i64 {
            for x in 0..tw as i64 {
                out.push(self.at(left + x, top + y));
            }
        }
    }

    /// Pixels of row `y` from `x` for `n`, if they're all inside.
    fn row(&self, x: i64, y: i64, n: usize) -> Option<&[u8]> {
        if x < 0 || y < 0 || x as usize + n > self.width || y as usize >= self.height {
            return None;
        }
        let start = y as usize * self.width + x as usize;
        self.pixels.get(start..start + n)
    }
}

/// The top-left pixel of a `tw`×`th` patch centred at `centre`.
fn corner(centre: (f32, f32), tw: usize, th: usize) -> (i64, i64) {
    (
        (centre.0 - tw as f32 / 2.0).round() as i64,
        (centre.1 - th as f32 / 2.0).round() as i64,
    )
}

/// The pattern being followed, ready to match: its pixels less their mean,
/// at full size and at half size.
struct Template {
    tw: usize,
    th: usize,
    raw: Vec<f32>,
    centred: Vec<f32>,
    norm: f32,
    mean: f32,
    half: Vec<f32>,
    half_norm: f32,
}

impl Template {
    fn new(tw: usize, th: usize) -> Self {
        Self {
            tw,
            th,
            raw: Vec::with_capacity(tw * th),
            centred: Vec::with_capacity(tw * th),
            norm: 0.0,
            mean: 0.0,
            half: Vec::with_capacity(tw * th / 4),
            half_norm: 0.0,
        }
    }

    fn prepare(&mut self) {
        (self.mean, self.norm) = centre_values(&self.raw, &mut self.centred);
        let (hw, hh) = (self.tw / 2, self.th / 2);
        let mut half = std::mem::take(&mut self.half);
        half.clear();
        for y in 0..hh {
            for x in 0..hw {
                let at = |dx: usize, dy: usize| {
                    self.raw
                        .get((2 * y + dy) * self.tw + 2 * x + dx)
                        .copied()
                        .unwrap_or(0.0)
                };
                half.push((at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) / 4.0);
            }
        }
        let raw = half.clone();
        (_, self.half_norm) = centre_values(&raw, &mut half);
        self.half = half;
    }
}

/// `values` less their mean into `out`; returns the mean and the norm of what's left.
fn centre_values(values: &[f32], out: &mut Vec<f32>) -> (f32, f32) {
    let mean = values.iter().sum::<f32>() / values.len().max(1) as f32;
    out.clear();
    out.extend(values.iter().map(|value| value - mean));
    (
        mean,
        out.iter().map(|value| value * value).sum::<f32>().sqrt(),
    )
}

/// Scratch space reused frame after frame.
#[derive(Default)]
struct Tracker {
    half: Vec<u8>,
    fresh: Vec<f32>,
    scores: Vec<(f32, i32, i32)>,
    /// Summed-area table of a flat template's error over the search stretch.
    sums: Vec<f64>,
}

impl Tracker {
    /// The position within REACH of `near` whose patch matches `template` best
    /// (normalised cross-correlation, 1 = identical), and that score.
    fn best_match(
        &mut self,
        image: &Image,
        template: &Template,
        near: (f32, f32),
    ) -> Option<((f32, f32), f32)> {
        let (tw, th) = (template.tw, template.th);
        if template.norm < 1e-3 {
            // A flat template (a solid block): match its brightness and edges instead.
            return self.best_flat(image, template, near);
        }
        let (left, top) = corner(near, tw, th);
        let score_at = |dx: i32, dy: i32| {
            ncc(
                image,
                &template.centred,
                template.norm,
                tw,
                th,
                left + i64::from(dx),
                top + i64::from(dy),
            )
        };
        let mut best: Option<(f32, i32, i32)> = None;
        let mut consider = |score: f32, dx: i32, dy: i32| {
            // Ties go to the first seen, scanning rows then columns from the top-left.
            let better = match best {
                None => true,
                Some((top, bx, by)) => score > top || (score == top && (dy, dx) < (by, bx)),
            };
            if better {
                best = Some((score, dx, dy));
            }
        };
        if tw >= 12 && th >= 12 && template.half_norm >= 1e-3 {
            // Coarse: every other offset on a half-size picture of the
            // stretch the search covers…
            let margin = i64::from(REACH) + 2;
            let (rx, ry) = (
                (left - margin).div_euclid(2) * 2,
                (top - margin).div_euclid(2) * 2,
            );
            let (hw, hh) = (
                (tw + 2 * margin as usize) / 2 + 2,
                (th + 2 * margin as usize) / 2 + 2,
            );
            self.half.clear();
            for y in 0..hh as i64 {
                for x in 0..hw as i64 {
                    let (fx, fy) = (rx + 2 * x, ry + 2 * y);
                    let sum = image.at(fx, fy)
                        + image.at(fx + 1, fy)
                        + image.at(fx, fy + 1)
                        + image.at(fx + 1, fy + 1);
                    self.half.push((sum / 4.0).round() as u8);
                }
            }
            let half = Image {
                pixels: &self.half,
                width: hw,
                height: hh,
            };
            let reach = REACH / 2;
            self.scores.clear();
            for dy in -reach..=reach {
                for dx in -reach..=reach {
                    let score = ncc(
                        &half,
                        &template.half,
                        template.half_norm,
                        tw / 2,
                        th / 2,
                        (left + i64::from(2 * dx) - rx).div_euclid(2),
                        (top + i64::from(2 * dy) - ry).div_euclid(2),
                    );
                    self.scores.push((score, 2 * dx, 2 * dy));
                }
            }
            // …then every offset around the three best at full size.
            self.scores.sort_by(|a, b| b.0.total_cmp(&a.0));
            let mut seen = [false; ((2 * REACH + 1) * (2 * REACH + 1)) as usize];
            let picks: Vec<(i32, i32)> = self.scores.iter().take(3).map(|s| (s.1, s.2)).collect();
            for (cx, cy) in picks {
                for dy in (cy - 2).max(-REACH)..=(cy + 2).min(REACH) {
                    for dx in (cx - 2).max(-REACH)..=(cx + 2).min(REACH) {
                        let slot = ((dy + REACH) * (2 * REACH + 1) + dx + REACH) as usize;
                        match seen.get_mut(slot) {
                            Some(seen) if !*seen => *seen = true,
                            _ => continue,
                        }
                        consider(score_at(dx, dy), dx, dy);
                    }
                }
            }
        } else {
            for dy in -REACH..=REACH {
                for dx in -REACH..=REACH {
                    consider(score_at(dx, dy), dx, dy);
                }
            }
        }
        best.map(|(score, dx, dy)| ((near.0 + dx as f32, near.1 + dy as f32), score))
    }
}

/// Normalised cross-correlation of the patch at (`left`, `top`) with a
/// centred template whose norm is `norm`.
fn ncc(
    image: &Image,
    centred: &[f32],
    norm: f32,
    tw: usize,
    th: usize,
    left: i64,
    top: i64,
) -> f32 {
    let (mut dot, mut sum, mut squares) = (0.0_f32, 0.0_f32, 0.0_f32);
    for (y, wanted) in centred.chunks_exact(tw.max(1)).take(th).enumerate() {
        let row_y = top + y as i64;
        match image.row(left, row_y, tw) {
            Some(row) => {
                for (pixel, t) in row.iter().zip(wanted) {
                    let value = f32::from(*pixel);
                    dot += value * t;
                    sum += value;
                    squares += value * value;
                }
            }
            None => {
                for (x, t) in wanted.iter().enumerate() {
                    let value = image.at(left + x as i64, row_y);
                    dot += value * t;
                    sum += value;
                    squares += value * value;
                }
            }
        }
    }
    // The template sums to zero, so the patch's mean drops out of the dot product.
    let n = (tw * th) as f32;
    let energy = squares - sum * sum / n;
    if energy < 1e-3 {
        0.0
    } else {
        dot / (energy.sqrt() * norm)
    }
}

/// For a uniform block (a black redaction box): the spot whose patch is
/// closest in brightness, scored so a perfect match is 1.
/// Every offset's error comes off a summed-area table of the stretch the
/// search covers, so each is four lookups rather than a pass over the patch.
impl Tracker {
    fn best_flat(
        &mut self,
        image: &Image,
        template: &Template,
        near: (f32, f32),
    ) -> Option<((f32, f32), f32)> {
        let (tw, th) = (template.tw, template.th);
        let target = template.mean;
        let (left, top) = corner(near, tw, th);
        let reach = i64::from(REACH);
        let (rx, ry) = (left - reach, top - reach);
        let (w, h) = (tw + 2 * REACH as usize, th + 2 * REACH as usize);
        let stride = w + 1;
        self.sums.clear();
        self.sums.resize(stride * (h + 1), 0.0);
        for y in 0..h {
            let mut row = 0.0;
            for x in 0..w {
                row += f64::from((image.at(rx + x as i64, ry + y as i64) - target).abs());
                let above = self.sums.get(y * stride + x + 1).copied().unwrap_or(0.0);
                if let Some(sum) = self.sums.get_mut((y + 1) * stride + x + 1) {
                    *sum = above + row;
                }
            }
        }
        let sum = |at: usize| self.sums.get(at).copied().unwrap_or(0.0);
        let mut best: Option<((f32, f32), f32, i32)> = None;
        for dy in -REACH..=REACH {
            for dx in -REACH..=REACH {
                let (x0, y0) = ((dx + REACH) as usize, (dy + REACH) as usize);
                let (x1, y1) = (x0 + tw, y0 + th);
                let error = sum(y1 * stride + x1) - sum(y0 * stride + x1) - sum(y1 * stride + x0)
                    + sum(y0 * stride + x0);
                let score = 1.0 - (error / (tw * th) as f64 / 64.0) as f32;
                // Equally good spots (a block on a plain background, a black
                // frame) keep the box where it is rather than walking it off.
                let distance = dx.abs() + dy.abs();
                let better = match best {
                    None => true,
                    Some((_, top, nearest)) => {
                        score > top + 1e-4 || (score > top - 1e-4 && distance < nearest)
                    }
                };
                if better {
                    best = Some(((near.0 + dx as f32, near.1 + dy as f32), score, distance));
                }
            }
        }
        best.map(|(at, score, _)| (at, score))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Noise with a textured square moving `step` px right a frame.
    fn moving_square(width: usize, height: usize, count: usize, step: usize) -> Frames {
        let mut pixels = Vec::with_capacity(width * height * count);
        for frame in 0..count {
            let mut image: Vec<u8> = (0..width * height)
                .map(|i| ((i * 7919 + frame * 13) % 97) as u8)
                .collect();
            for y in 30..50 {
                for x in 0..20 {
                    let px = 20 + frame * step + x;
                    image[y * width + px] = if (x / 4 + y / 4) % 2 == 0 { 255 } else { 120 };
                }
            }
            pixels.extend(image);
        }
        Frames {
            width,
            height,
            count,
            pixels,
        }
    }

    /// A textured square moving right 2 px a frame over noise is followed.
    #[test]
    fn follows_a_moving_patch() {
        let frames = moving_square(120, 80, 20, 2);
        let mut at = (30.0, 40.0);
        let mut template = Template::new(20, 20);
        frames.image(0).patch_into(at, 20, 20, &mut template.raw);
        template.prepare();
        let mut tracker = Tracker::default();
        for index in 1..frames.count {
            let (found, score) = tracker
                .best_match(&frames.image(index), &template, at)
                .unwrap();
            assert!(score > 0.9, "frame {index}: {score}");
            at = found;
            frames
                .image(index)
                .patch_into(at, 20, 20, &mut template.raw);
            template.prepare();
        }
        assert!((at.0 - (30.0 + 19.0 * 2.0)).abs() <= 1.0, "ended at {at:?}");
        assert!((at.1 - 40.0).abs() <= 1.0);
    }

    /// The whole pass (both directions from a frame in the middle), as track_region runs it.
    #[test]
    fn follows_both_ways_from_the_middle() {
        let frames = moving_square(200, 80, 40, 3);
        let start = 20;
        let centres = follow(&frames, start, (30.0 + 3.0 * start as f32, 40.0), 20, 20);
        for (index, (x, y)) in centres.iter().enumerate() {
            let expected = 30.0 + 3.0 * index as f32;
            assert!(
                (x - expected).abs() <= 1.0,
                "frame {index}: {x} not {expected}"
            );
            assert!((y - 40.0).abs() <= 1.0, "frame {index}: {y}");
        }
    }

    /// A solid black block (a redaction box) moving over bright noise.
    #[test]
    fn follows_a_flat_block() {
        let (width, height) = (160, 90);
        let mut pixels = Vec::new();
        for frame in 0..10 {
            let mut image: Vec<u8> = (0..width * height)
                .map(|i| 100 + ((i * 7919) % 97) as u8)
                .collect();
            for y in 30..50 {
                for x in 0..20 {
                    image[y * width + 20 + frame * 4 + x] = 0;
                }
            }
            pixels.extend(image);
        }
        let frames = Frames {
            width,
            height,
            count: 10,
            pixels,
        };
        let centres = follow(&frames, 0, (30.0, 40.0), 20, 20);
        assert!((centres[9].0 - 66.0).abs() <= 1.0, "{:?}", centres[9]);
        assert!((centres[9].1 - 40.0).abs() <= 1.0, "{:?}", centres[9]);
    }

    /// On black frames every spot matches: the box stays where it is.
    #[test]
    fn holds_still_on_black_frames() {
        let frames = Frames {
            width: 120,
            height: 80,
            count: 30,
            pixels: vec![0; 120 * 80 * 30],
        };
        let centres = follow(&frames, 0, (60.0, 40.0), 20, 20);
        assert!(centres.iter().all(|at| *at == (60.0, 40.0)), "{centres:?}");
    }

    /// The coarse-to-fine search lands where checking every offset does.
    #[test]
    fn coarse_search_agrees_with_exhaustive() {
        let frames = moving_square(160, 100, 2, 7);
        let mut template = Template::new(24, 22);
        frames
            .image(0)
            .patch_into((32.0, 41.0), 24, 22, &mut template.raw);
        template.prepare();
        let near = (33.0, 41.0);
        let image = frames.image(1);
        let found = Tracker::default()
            .best_match(&image, &template, near)
            .unwrap();
        let (left, top) = corner(near, 24, 22);
        let mut best = (f32::MIN, 0, 0);
        for dy in -REACH..=REACH {
            for dx in -REACH..=REACH {
                let score = ncc(
                    &image,
                    &template.centred,
                    template.norm,
                    24,
                    22,
                    left + i64::from(dx),
                    top + i64::from(dy),
                );
                if score > best.0 {
                    best = (score, dx, dy);
                }
            }
        }
        assert_eq!(
            found.0,
            (near.0 + best.1 as f32, near.1 + best.2 as f32),
            "{found:?} vs {best:?}"
        );
    }

    /// A white square with a black middle crossing a noisy grey 720p frame
    /// at 200 px/s from x = 100 (its centre at 160 + 200 t, y = 360).
    fn square_video(dir: &Path) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join("square.mp4");
        let made = Command::new(crate::tools::ffmpeg())
            .args(["-hide_banner", "-loglevel", "error", "-y", "-filter_complex"])
            .arg("color=c=0x404040:s=1280x720:r=30:d=4[bg];color=white:s=120x120:r=30:d=4,drawbox=x=30:y=30:w=60:h=60:color=black:t=fill[sq];[bg][sq]overlay=x='100+200*t':y=300,noise=alls=12:allf=t")
            .args(["-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast"])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        path
    }

    /// The whole tool path on a synthetic clip: decoded, tracked, and kept
    /// for a second pass.
    #[test]
    fn tracks_a_square_in_a_video() {
        let dir = std::env::temp_dir().join(format!("edit-track-{}", std::process::id()));
        let path = square_video(&dir);
        let region = [300.0, 300.0, 420.0, 420.0];
        let started = Instant::now();
        let samples = track(&path, (1280, 720), 0.0, 3.5, 1.0, region).unwrap();
        let first = started.elapsed();
        let started = Instant::now();
        let again = track(&path, (1280, 720), 0.0, 3.5, 1.0, region).unwrap();
        assert!(
            started.elapsed() < first,
            "the second pass reuses the frames"
        );
        assert_eq!(samples, again);
        assert_eq!(samples.len(), 53);
        for sample in &samples {
            let expected = 160.0 + 200.0 * sample.time;
            // The moving average lags a sample's motion (13 px) at the very ends.
            assert!(
                (sample.x - expected).abs() < 16.0 && (sample.y - 360.0).abs() < 8.0,
                "{sample:?} not near {expected}"
            );
        }
        // FFmpeg (the compatibility decoder) sees the same pictures.
        let ffmpeg = decode_ffmpeg(&path, 0.0, 3.5, 340, 192).unwrap();
        assert_eq!(ffmpeg.count, 53);
        let centres = follow(&ffmpeg, 15, (360.0 * 340.0 / 1280.0, 96.0), 32, 32);
        let last = centres[52].0 * 1280.0 / 340.0;
        assert!(
            (last - (160.0 + 200.0 * 52.0 / 15.0)).abs() < 12.0,
            "{last}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
