//! Region tracking: follows a box (a face, a redaction block) through footage
//! by template matching on small greyscale frames, the way After Effects'
//! point tracker does. No models and no extra dependencies.
//!
//! The frames are decoded small (the box looked at about 40 px wide), from
//! the media's light preview when that's sharp enough and the original when
//! the box is small in the frame (a face in a zoomed-in shot), in hardware on
//! macOS, at the footage's own rate for a short stretch (fast movement, a
//! swinging bodycam), and kept for a few minutes so another pass on the same
//! shot (a label, then its leader) doesn't decode again.
//!
//! Each frame the box is first carried by the camera's own move
//! (`motion::step`: the whole picture's shift, turn and zoom), so the search
//! only has to cover the person's movement; matching searches a half-size
//! picture first and refines around the best spots at full size to a
//! fraction of a pixel. Drift is held off by checking each match against the
//! box as it was first given; a match too weak is lost (the box rides with
//! the camera until it's found again), and after a cut the box is looked for
//! anywhere in the new shot. Several boxes at different moments are each
//! followed to the next and the tracks blended between them. The path is
//! smoothed with a centred local fit (no lag), never across a cut.

use crate::motion::{self, Small, Step};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

/// Frames per second a stretch up to FAST_SPAN long is looked at (at most
/// the footage's own rate)…
const FAST_RATE: f64 = 30.0;
/// …and a longer one.
const SLOW_RATE: f64 = 15.0;
const FAST_SPAN: f64 = 40.0;
/// The box is looked at this many pixels wide (smaller is faster, bigger finer).
const BOX_WIDTH: f64 = 40.0;
/// How far (in looked-at pixels) the box may move between samples beyond
/// where the camera's move takes it.
const REACH: i32 = 12;
/// Below this match the box is lost: it rides with the camera until found again.
const LOST: f32 = 0.35;
/// A match at least this good is trusted outright.
const GOOD: f32 = 0.6;
/// Found again, after being lost, when the box as first given matches this well…
const REFOUND: f32 = 0.6;
/// …or anywhere in a new shot after a cut, this well.
const REACQUIRE: f32 = 0.8;
/// Footage tracked at most in one go (seconds).
const MAX_SPAN: f64 = 180.0;
/// Frames are decoded at most this wide…
const MAX_WIDTH: f64 = 1280.0;
/// …from the light preview (720p, heavily compressed) only up to this wide.
const PREVIEW_WIDTH: f64 = 640.0;
/// One pass holds at most this many bytes of frames.
const MAX_BYTES: f64 = 160.0 * 1024.0 * 1024.0;
/// Decoded frames kept for another pass on the same shot: this long…
const KEEP: Duration = Duration::from_secs(180);
/// …within this many bytes.
const KEEP_BYTES: usize = 256 << 20;
/// The path is smoothed over about this long either side (seconds).
const SMOOTHING: f64 = 0.05;

/// Where the box's centre is at `time` (seconds into the source), in source pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub time: f64,
    pub x: f64,
    pub y: f64,
}

/// A box ([x0, y0, x1, y1] source pixels) as it is at `at` seconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Anchor {
    pub at: f64,
    pub region: [f64; 4],
}

/// A tracked path and where it can't be trusted.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tracked {
    pub samples: Vec<Sample>,
    /// Stretches (source seconds) where the box wasn't found: it rode with
    /// the camera from where it was last seen. Another box there fixes it.
    pub lost: Vec<(f64, f64)>,
    /// Cuts inside the footage (source seconds of the first frame after).
    pub cuts: Vec<f64>,
}

/// Follows `region` ([x0, y0, x1, y1] in source pixels, as it is at `at`
/// seconds) from `from` to `to` seconds of the source at `path`, whose frame
/// rate is `fps` (0 if unknown).
pub fn track(
    path: &Path,
    size: (u32, u32),
    fps: f64,
    from: f64,
    to: f64,
    at: f64,
    region: [f64; 4],
) -> Result<Vec<Sample>, String> {
    track_anchors(path, size, fps, from, to, &[Anchor { at, region }])
        .map(|tracked| tracked.samples)
}

/// Follows a box given at one or more moments (`anchors`) from `from` to `to`
/// seconds of the source: from each anchor to the next, blended between them.
pub fn track_anchors(
    path: &Path,
    size: (u32, u32),
    fps: f64,
    from: f64,
    to: f64,
    anchors: &[Anchor],
) -> Result<Tracked, String> {
    let (source_w, source_h) = (f64::from(size.0.max(1)), f64::from(size.1.max(1)));
    let widths: Vec<f64> = anchors
        .iter()
        .map(|anchor| (anchor.region[2] - anchor.region[0]).abs().max(4.0))
        .collect();
    let Some(box_w) = widths.iter().copied().reduce(f64::min) else {
        return Err("no box to track".into());
    };
    let to = to.min(from + MAX_SPAN);
    if to <= from {
        return Err("nothing to track".into());
    }
    let rate = sample_rate(fps, to - from);
    // Look at the footage so the box is about BOX_WIDTH pixels wide, within
    // what's worth decoding and holding.
    let count = ((to - from) * rate).ceil().max(1.0);
    let cap = (MAX_WIDTH / source_w)
        .min((MAX_BYTES / count / (source_w * source_h)).sqrt())
        .min(1.0);
    let scale = (BOX_WIDTH / box_w).min(cap).max((96.0 / source_w).min(1.0));
    let (width, height) = (even(source_w * scale), even(source_h * scale));
    let frames = frames(path, from, to, width, height, rate)?;
    if frames.count == 0 {
        return Err("couldn't decode the footage to track".into());
    }
    let (sx, sy) = (
        f64::from(width as u32) / source_w,
        f64::from(height as u32) / source_h,
    );
    let mut starts: Vec<Start> = anchors
        .iter()
        .map(|anchor| {
            let [x0, y0, x1, y1] = anchor.region;
            Start {
                index: (((anchor.at - from) * rate).round().max(0.0) as usize)
                    .min(frames.count - 1),
                centre: (((x0 + x1) / 2.0 * sx) as f32, ((y0 + y1) / 2.0 * sy) as f32),
                tw: (((x1 - x0).abs() * sx).round() as usize).clamp(6, 96),
                th: (((y1 - y0).abs() * sy).round() as usize).clamp(6, 96),
            }
        })
        .collect();
    starts.sort_by_key(|start| start.index);
    starts.dedup_by_key(|start| start.index);
    let steps = frames.steps();
    let found = follow_all(&frames, steps, &starts);
    let cut_after: Vec<usize> = steps
        .iter()
        .enumerate()
        .filter(|(_, step)| step.cut)
        .map(|(index, _)| index + 1)
        .collect();
    let path = smooth(&found, &cut_after, (SMOOTHING * rate).max(1.0));
    let time = |index: usize| from + index as f64 / rate;
    let mut lost = Vec::new();
    let mut run: Option<usize> = None;
    for (index, spot) in found.iter().enumerate() {
        match (spot.lost, run) {
            (true, None) => run = Some(index),
            (false, Some(first)) => {
                lost.push((time(first), time(index)));
                run = None;
            }
            _ => {}
        }
    }
    if let Some(first) = run {
        lost.push((time(first), time(found.len())));
    }
    Ok(Tracked {
        samples: path
            .into_iter()
            .enumerate()
            .map(|(index, (x, y))| Sample {
                time: time(index),
                x: f64::from(x) / sx,
                y: f64::from(y) / sy,
            })
            .collect(),
        lost,
        cuts: cut_after.into_iter().map(time).collect(),
    })
}

/// How often a stretch `span` seconds long of footage at `fps` is looked at.
fn sample_rate(fps: f64, span: f64) -> f64 {
    if span > FAST_SPAN {
        SLOW_RATE
    } else if fps >= 10.0 {
        fps.min(FAST_RATE)
    } else {
        FAST_RATE
    }
}

/// Where a pass starts: the box's centre and size in looked-at pixels.
#[derive(Clone, Copy, Debug)]
struct Start {
    index: usize,
    centre: (f32, f32),
    tw: usize,
    th: usize,
}

/// The box in one frame.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Spot {
    at: (f32, f32),
    score: f32,
    lost: bool,
}

/// The box in every frame: followed from each start forwards to the next
/// start and backwards to the one before (side by side), the two tracks
/// between a pair of starts blended by how near each start is.
fn follow_all(frames: &Frames, steps: &[Step], starts: &[Start]) -> Vec<Spot> {
    let last = frames.count.saturating_sub(1);
    let runs: Vec<(usize, Vec<(usize, Spot)>, Vec<(usize, Spot)>)> = std::thread::scope(|scope| {
        let handles: Vec<_> = starts
            .iter()
            .enumerate()
            .map(|(k, start)| {
                let back_to = if k == 0 {
                    0
                } else {
                    starts.get(k - 1).map_or(0, |before| before.index)
                };
                let on_to = starts.get(k + 1).map_or(last, |after| after.index);
                let start = *start;
                let forward = scope.spawn(move || pass(frames, steps, start, on_to, 1));
                let backward = pass(frames, steps, start, back_to, -1);
                (k, forward, backward)
            })
            .collect();
        handles
            .into_iter()
            .map(|(k, forward, backward)| (k, forward.join().unwrap_or_default(), backward))
            .collect()
    });
    let mut spots: Vec<Option<(Spot, f32)>> = vec![None; frames.count];
    let mut offer = |index: usize, spot: Spot, weight: f32| {
        let Some(slot) = spots.get_mut(index) else {
            return;
        };
        // (A match's score says little here: a box sliding onto the wall
        // behind a face scores well too.)
        let weight = if spot.lost { weight * 1e-3 } else { weight };
        *slot = Some(match *slot {
            None => (spot, weight),
            // Seen beats lost outright.
            Some((have, _)) if have.lost && !spot.lost => (spot, weight),
            Some((have, have_weight)) if spot.lost && !have.lost => (have, have_weight),
            Some((have, have_weight)) => {
                let total = (have_weight + weight).max(1e-9);
                let mix = |a: f32, b: f32| (a * have_weight + b * weight) / total;
                (
                    Spot {
                        at: (mix(have.at.0, spot.at.0), mix(have.at.1, spot.at.1)),
                        score: have.score.max(spot.score),
                        lost: have.lost && spot.lost,
                    },
                    have_weight + weight,
                )
            }
        });
    };
    for (k, forward, backward) in runs {
        let Some(start) = starts.get(k) else {
            continue;
        };
        let next = starts.get(k + 1).map(|after| after.index);
        let previous = k
            .checked_sub(1)
            .and_then(|k| starts.get(k))
            .map(|s| s.index);
        // A pass that reaches the next start somewhere other than where the
        // box was given there has drifted: the difference is spread back
        // along it, nothing at its own start and all of it at the other.
        let undrift = |run: Vec<(usize, Spot)>, other: Option<&Start>| -> Vec<(usize, Spot)> {
            let Some(other) = other else {
                return run;
            };
            // Not across a cut: the two sightings are of different shots.
            let (low, high) = (start.index.min(other.index), start.index.max(other.index));
            if steps
                .get(low..high)
                .is_none_or(|between| between.iter().any(|step| step.cut))
            {
                return run;
            }
            let Some(end) = run
                .iter()
                .find(|(index, _)| *index == other.index)
                .map(|(_, spot)| *spot)
                .filter(|spot| !spot.lost)
            else {
                return run;
            };
            let error = (other.centre.0 - end.at.0, other.centre.1 - end.at.1);
            let span = other.index.abs_diff(start.index).max(1) as f32;
            run.into_iter()
                .map(|(index, mut spot)| {
                    let share = index.abs_diff(start.index) as f32 / span;
                    spot.at.0 += error.0 * share;
                    spot.at.1 += error.1 * share;
                    (index, spot)
                })
                .collect()
        };
        let forward = undrift(forward, starts.get(k + 1));
        let backward = undrift(backward, k.checked_sub(1).and_then(|k| starts.get(k)));
        // Found again in another shot counts for less than followed within one.
        let across_cut = |index: usize| {
            let (low, high) = (start.index.min(index), start.index.max(index));
            steps
                .get(low..high)
                .is_some_and(|between| between.iter().any(|step| step.cut))
        };
        let shot = |index: usize| if across_cut(index) { 1e-4 } else { 1.0 };
        for (index, spot) in forward {
            // Weighted by nearness to this start against the next one.
            let weight = next.map_or(1.0, |next| {
                (next.saturating_sub(index)) as f32 / (next - start.index).max(1) as f32
            });
            offer(index, spot, weight.max(1e-3) * shot(index));
        }
        for (index, spot) in backward {
            let weight = previous.map_or(1.0, |previous| {
                (index.saturating_sub(previous)) as f32 / (start.index - previous).max(1) as f32
            });
            // The start itself is offered by the forward pass.
            if index != start.index {
                offer(index, spot, weight.max(1e-3) * shot(index));
            }
        }
    }
    let fallback = starts.first().map_or((0.0, 0.0), |start| start.centre);
    spots
        .into_iter()
        .map(|spot| {
            spot.map_or(
                Spot {
                    at: fallback,
                    score: 0.0,
                    lost: true,
                },
                |(spot, _)| spot,
            )
        })
        .collect()
}

/// Follows the box from `start` to frame `until` (inclusive) in `direction`
/// (1 forwards, −1 backwards).
fn pass(
    frames: &Frames,
    steps: &[Step],
    start: Start,
    until: usize,
    direction: i64,
) -> Vec<(usize, Spot)> {
    let Start {
        index: first,
        centre,
        tw,
        th,
    } = start;
    let mut given = Template::new(tw, th);
    given.emphasise(&moving_parts(frames, steps, first, centre, tw, th));
    frames
        .image(first)
        .patch_into(centre, tw, th, &mut given.raw);
    given.prepare();
    let mut template = given.clone();
    let mut tracker = Tracker::default();
    let middle = (frames.width as f64 / 2.0, frames.height as f64 / 2.0);
    let mut at = centre;
    // The box's own movement a frame, beyond the camera's.
    let mut own = (0.0_f32, 0.0_f32);
    let mut lost = false;
    let mut new_shot = false;
    let mut confirming = false;
    let mut found = vec![(
        first,
        Spot {
            at,
            score: 1.0,
            lost: false,
        },
    )];
    if direction > 0 && until <= first || direction < 0 && until >= first {
        return found;
    }
    let mut index = first as i64;
    while index != until as i64 {
        let next = index + direction;
        let Ok(next_frame) = usize::try_from(next) else {
            break;
        };
        if next_frame >= frames.count {
            break;
        }
        let step = if direction > 0 {
            usize::try_from(index).ok().and_then(|i| steps.get(i))
        } else {
            steps.get(next_frame)
        }
        .copied()
        .unwrap_or(Step::STILL);
        let camera = if direction > 0 {
            step.motion
        } else {
            step.motion.inverse()
        };
        let image = frames.image(next_frame);
        if step.cut {
            new_shot = true;
            own = (0.0, 0.0);
        }
        let carried = {
            let (x, y) = camera.apply((f64::from(at.0), f64::from(at.1)), middle);
            (x as f32, y as f32)
        };
        let was_confirming = confirming;
        let spot = if new_shot {
            // Another shot: the box as first given, anywhere in it; taken
            // once the next frame finds it there too (one good-looking spot
            // in a whole frame can be chance).
            match tracker.search_whole(&image, &given) {
                Some((spot, score)) if score >= REACQUIRE => {
                    new_shot = false;
                    confirming = true;
                    lost = true;
                    template = given.clone();
                    at = spot;
                    Spot {
                        at,
                        score,
                        lost: true,
                    }
                }
                _ => {
                    lost = true;
                    Spot {
                        at,
                        score: 0.0,
                        lost: true,
                    }
                }
            }
        } else {
            let predicted = (carried.0 + own.0, carried.1 + own.1);
            let reach = if lost { 2 * REACH } else { REACH };
            let mut best = tracker.best_match(&image, &template, predicted, reach);
            // The camera's move misread (a person filling the frame): where it was.
            if best.is_none_or(|(_, score)| score < GOOD) {
                if let Some(other) = tracker.best_match(&image, &template, at, reach) {
                    if best.is_none_or(|(_, score)| other.1 > score) {
                        best = Some(other);
                    }
                }
            }
            // A strong match is taken anywhere in reach; a middling one only
            // near where the box should be (a turning head, motion blur),
            // and once lost, only a strong one finds it again.
            let near = |spot: (f32, f32)| {
                let from = |p: (f32, f32)| (spot.0 - p.0).hypot(spot.1 - p.1);
                from(predicted).min(from(at)) <= REACH as f32 * 0.5
            };
            let trusted = |spot: (f32, f32), score: f32| {
                if lost {
                    score >= REFOUND
                } else {
                    score >= GOOD || (score >= LOST && near(spot))
                }
            };
            match best {
                Some((spot, score)) if trusted(spot, score) => {
                    // Held to the box as first given, so small errors don't add up.
                    let mut spot = spot;
                    if let Some((held, held_score)) = tracker.best_match(&image, &given, spot, 3) {
                        if held_score >= GOOD && (held.0 - spot.0).hypot(held.1 - spot.1) <= 3.0 {
                            spot = held;
                        }
                    }
                    own = (
                        0.5 * own.0 + 0.5 * (spot.0 - carried.0),
                        0.5 * own.1 + 0.5 * (spot.1 - carried.1),
                    );
                    at = spot;
                    lost = false;
                    // Let the pattern follow slow changes (a turning head) when the match is good.
                    if score > 0.7 {
                        image.patch_into(at, tw, th, &mut tracker.fresh);
                        for (old, new) in template.raw.iter_mut().zip(&tracker.fresh) {
                            *old = *old * 0.85 + new * 0.15;
                        }
                        template.prepare();
                    }
                    Spot {
                        at,
                        score,
                        lost: false,
                    }
                }
                _ => match tracker.best_match(&image, &given, carried, 2 * REACH) {
                    Some((spot, score)) if score >= REFOUND => {
                        template = given.clone();
                        own = (0.0, 0.0);
                        at = spot;
                        lost = false;
                        Spot {
                            at,
                            score,
                            lost: false,
                        }
                    }
                    _ => {
                        // Out of sight: it rides with the camera.
                        at = carried;
                        own = (own.0 * 0.5, own.1 * 0.5);
                        lost = true;
                        Spot {
                            at,
                            score: best.map_or(0.0, |(_, score)| score),
                            lost: true,
                        }
                    }
                },
            }
        };
        // A spot found anywhere in a new shot that the next frame doesn't
        // bear out: look anywhere again.
        if was_confirming {
            confirming = false;
            if spot.lost {
                new_shot = true;
            } else if let Some((_, previous)) = found.last_mut() {
                // Borne out: it was found there.
                previous.lost = false;
            }
        }
        // Gone past the frame's edge: out of sight, whatever matched.
        let (w, h) = (frames.width as f32, frames.height as f32);
        let spot = if spot.at.0 < 0.0 || spot.at.1 < 0.0 || spot.at.0 > w || spot.at.1 > h {
            lost = true;
            Spot { lost: true, ..spot }
        } else {
            spot
        };
        found.push((next_frame, spot));
        index = next;
    }
    found
}

/// How much each pixel of the box at frame `index` moves against the scene
/// (tw × th, 0 = with the camera like a wall behind a face, 1 = its own way
/// like the face): the frame compared with a few frames either side, each
/// carried there by the camera's move. A box around a face takes in some
/// wall; when the person moves and the camera pans, matching the wall would
/// pull the box with the camera, so it's weighted down. All ones when nothing
/// in the box moves its own way (nothing to tell apart).
fn moving_parts(
    frames: &Frames,
    steps: &[Step],
    index: usize,
    centre: (f32, f32),
    tw: usize,
    th: usize,
) -> Vec<f32> {
    let middle = (frames.width as f64 / 2.0, frames.height as f64 / 2.0);
    let here = frames.image(index);
    let (left, top) = corner(centre, tw, th);
    let mut difference = vec![0.0_f32; tw * th];
    let mut looks = 0;
    for offset in [-6_i64, -3, 3, 6] {
        let Ok(other) = usize::try_from(index as i64 + offset) else {
            continue;
        };
        if other >= frames.count {
            continue;
        }
        // The camera's moves from here to there (none across a cut).
        let (low, high) = (index.min(other), index.max(other));
        let Some(moves) = steps.get(low..high) else {
            continue;
        };
        if moves.iter().any(|step| step.cut) {
            continue;
        }
        let there = frames.image(other);
        looks += 1;
        for (slot, difference) in difference.iter_mut().enumerate() {
            let (x, y) = ((slot % tw) as i64 + left, (slot / tw) as i64 + top);
            let mut point = (x as f64, y as f64);
            if offset > 0 {
                for step in moves {
                    point = step.motion.apply(point, middle);
                }
            } else {
                for step in moves.iter().rev() {
                    point = step.motion.inverse().apply(point, middle);
                }
            }
            *difference += (here.at(x, y) - there.sample(point.0 as f32, point.1 as f32)).abs();
        }
    }
    if looks == 0 {
        return vec![1.0; tw * th];
    }
    // A little blur (3 × 3): one noisy pixel isn't movement.
    let mean: Vec<f32> = difference.iter().map(|d| d / looks as f32).collect();
    let blurred: Vec<f32> = (0..tw * th)
        .map(|slot| {
            let (x, y) = ((slot % tw) as i64, (slot / tw) as i64);
            let mut sum = 0.0;
            let mut n = 0.0;
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let (nx, ny) = (x + dx, y + dy);
                    if nx >= 0 && ny >= 0 && (nx as usize) < tw && (ny as usize) < th {
                        sum += mean
                            .get(ny as usize * tw + nx as usize)
                            .copied()
                            .unwrap_or(0.0);
                        n += 1.0;
                    }
                }
            }
            sum / n
        })
        .collect();
    // Grey levels apart: under ~6 is noise and compression, over ~24 moved.
    let moving: Vec<f32> = blurred
        .iter()
        .map(|d| ((d - 6.0) / 18.0).clamp(0.0, 1.0))
        .collect();
    let share = moving.iter().sum::<f32>() / moving.len().max(1) as f32;
    if share < 0.08 {
        return vec![1.0; tw * th];
    }
    moving.iter().map(|m| 0.15 + 0.85 * m).collect()
}

/// The path through `spots`, smoothed by a local straight-line fit over a
/// Gaussian window of `sigma` frames centred on each (so it doesn't lag or
/// cut corners at the ends), never across a cut (the frame after one in
/// `cuts`). Lost frames count for little.
fn smooth(spots: &[Spot], cuts: &[usize], sigma: f64) -> Vec<(f32, f32)> {
    let reach = (3.0 * sigma).ceil() as usize;
    let segment = |index: usize| cuts.iter().filter(|cut| **cut <= index).count();
    (0..spots.len())
        .map(|index| {
            let here = segment(index);
            let (mut s0, mut s1, mut s2, mut sx, mut sxd, mut sy, mut syd) =
                (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
            for other in index.saturating_sub(reach)..(index + reach + 1).min(spots.len()) {
                let Some(spot) = spots.get(other) else {
                    continue;
                };
                if segment(other) != here {
                    continue;
                }
                let d = other as f64 - index as f64;
                let mut weight = (-0.5 * (d / sigma).powi(2)).exp();
                if spot.lost {
                    weight *= 0.05;
                }
                let (x, y) = (f64::from(spot.at.0), f64::from(spot.at.1));
                s0 += weight;
                s1 += weight * d;
                s2 += weight * d * d;
                sx += weight * x;
                sxd += weight * x * d;
                sy += weight * y;
                syd += weight * y * d;
            }
            let det = s0 * s2 - s1 * s1;
            if s0 <= 0.0 {
                return spots.get(index).map_or((0.0, 0.0), |spot| spot.at);
            }
            if det.abs() < 1e-9 {
                return ((sx / s0) as f32, (sy / s0) as f32);
            }
            (
                ((s2 * sx - s1 * sxd) / det) as f32,
                ((s2 * sy - s1 * syd) / det) as f32,
            )
        })
        .collect()
}

/// The box's centre in every frame from one start, as before several starts
/// existed (the tests).
#[cfg(test)]
fn follow(
    frames: &Frames,
    start: usize,
    centre: (f32, f32),
    tw: usize,
    th: usize,
) -> Vec<(f32, f32)> {
    let starts = [Start {
        index: start,
        centre,
        tw,
        th,
    }];
    follow_all(frames, frames.steps(), &starts)
        .into_iter()
        .map(|spot| spot.at)
        .collect()
}

fn even(value: f64) -> usize {
    ((value.round() as usize) / 2 * 2).max(2)
}

/// Greyscale frames, `rate` a second, one after another.
pub(crate) struct Frames {
    pub width: usize,
    pub height: usize,
    pub count: usize,
    pixels: Vec<u8>,
    /// The camera's move from each frame to the next, worked out once.
    steps: OnceLock<Vec<Step>>,
}

impl Frames {
    fn new(width: usize, height: usize, pixels: Vec<u8>) -> Self {
        let size = (width * height).max(1);
        let mut pixels = pixels;
        pixels.truncate(pixels.len() / size * size);
        Self {
            width,
            height,
            count: pixels.len() / size,
            pixels,
            steps: OnceLock::new(),
        }
    }

    /// The camera's move from each frame to the next (`count − 1` of them).
    pub fn steps(&self) -> &[Step] {
        self.steps.get_or_init(|| {
            let small: Vec<Small> = (0..self.count)
                .map(|index| Small::of(&self.image(index)))
                .collect();
            motion::steps(&small)
        })
    }

    pub fn image(&self, index: usize) -> Image<'_> {
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

type FramesKey = (String, u64, u64, usize, usize, u64);

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

/// The frames of `path` from `from` to `to` at `width`×`height`, `rate` a
/// second: kept from a pass a moment ago, or decoded now.
pub(crate) fn frames(
    path: &Path,
    from: f64,
    to: f64,
    width: usize,
    height: usize,
    rate: f64,
) -> Result<Arc<Frames>, String> {
    let key: FramesKey = (
        crate::media::media_key(path),
        (from * 1000.0).round() as u64,
        (to * 1000.0).round() as u64,
        width,
        height,
        (rate * 1000.0).round() as u64,
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
        decode(path, from, to, width, height, rate)
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
/// full-resolution original and plenty when frames are looked at small; the
/// original when they're looked at bigger (a small face in a zoomed-in
/// shot), where the preview's compression would blur what's followed.
fn decode_source(path: &Path, width: usize) -> PathBuf {
    if width as f64 > PREVIEW_WIDTH {
        return path.to_owned();
    }
    crate::tools::media_cache(path)
        // `media::Processor::paths`' name for it.
        .map(|dir| dir.join("preview-light.mp4"))
        .filter(|light| light.is_file())
        .unwrap_or_else(|| path.to_owned())
}

/// Greyscale frames of the source between `from` and `to`, `rate` a second.
fn decode(
    path: &Path,
    from: f64,
    to: f64,
    width: usize,
    height: usize,
    rate: f64,
) -> Result<Frames, String> {
    let source = decode_source(path, width);
    #[cfg(target_os = "macos")]
    if std::env::var_os("EDIT_FFMPEG_VIDEO").is_none() {
        match decode_native(&source, from, to, width, height, rate) {
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
    decode_ffmpeg(&source, from, to, width, height, rate)
}

/// AVFoundation (hardware decode, scaled as it's decoded).
#[cfg(target_os = "macos")]
fn decode_native(
    path: &Path,
    from: f64,
    to: f64,
    width: usize,
    height: usize,
    rate: f64,
) -> Result<Frames, String> {
    let count = ((to - from) * rate).ceil().max(1.0) as usize;
    // A long span is read in a few stretches side by side (each its own
    // decoder session): the hardware keeps up with more than one.
    let parts = (count / 150).clamp(1, 3);
    let read_part = |part: usize| -> Result<Vec<u8>, String> {
        let (first, last) = (count * part / parts, count * (part + 1) / parts);
        let mut reader = crate::mac_media::Reader::open(path, width as u32, height as u32)?;
        let mut bgra = vec![0_u8; width * height * 4];
        let mut pixels = Vec::with_capacity((last - first) * width * height);
        for index in first..last {
            let time = from + index as f64 / rate;
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
    Ok(Frames::new(width, height, pixels))
}

fn decode_ffmpeg(
    path: &Path,
    from: f64,
    to: f64,
    width: usize,
    height: usize,
    rate: f64,
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
            &format!("fps={rate},scale={width}:{height}:flags=area,format=gray"),
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
    Ok(Frames::new(width, height, pixels))
}

pub(crate) struct Image<'a> {
    pub pixels: &'a [u8],
    pub width: usize,
    pub height: usize,
}

impl Image<'_> {
    fn at(&self, x: i64, y: i64) -> f32 {
        let x = x.clamp(0, self.width as i64 - 1) as usize;
        let y = y.clamp(0, self.height as i64 - 1) as usize;
        self.pixels
            .get(y * self.width + x)
            .map_or(0.0, |pixel| f32::from(*pixel))
    }

    /// The brightness at (`x`, `y`), between pixels (bilinear).
    pub fn sample(&self, x: f32, y: f32) -> f32 {
        let (fx, fy) = (x.floor(), y.floor());
        let (ix, iy) = (fx as i64, fy as i64);
        let (ax, ay) = (x - fx, y - fy);
        let top = self.at(ix, iy) * (1.0 - ax) + self.at(ix + 1, iy) * ax;
        let bottom = self.at(ix, iy + 1) * (1.0 - ax) + self.at(ix + 1, iy + 1) * ax;
        top * (1.0 - ay) + bottom * ay
    }

    /// The `tw`×`th` patch centred at `centre`, into `out`.
    pub fn patch_into(&self, centre: (f32, f32), tw: usize, th: usize, out: &mut Vec<f32>) {
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

/// The pattern being followed, ready to match, at full size and at half
/// size: its pixels less their mean, weighted toward the middle of the box
/// (a Gaussian falling to about a fifth at the edges), so the background a
/// box around a face always takes in counts for less than the face: a head
/// turning or moving against a still wall then doesn't pull the box onto
/// the wall.
#[derive(Clone)]
struct Template {
    tw: usize,
    th: usize,
    raw: Vec<f32>,
    full: Weighted,
    half: Weighted,
    mean: f32,
}

/// A template's pixels for weighted matching.
#[derive(Clone, Default)]
struct Weighted {
    width: usize,
    height: usize,
    weights: Vec<f32>,
    weight_sum: f32,
    /// weight · (pixel − weighted mean).
    centred: Vec<f32>,
    norm: f32,
}

impl Weighted {
    fn new(width: usize, height: usize) -> Self {
        let weights: Vec<f32> = (0..height)
            .flat_map(|y| {
                (0..width).map(move |x| {
                    let dx = (x as f32 + 0.5 - width as f32 / 2.0) / (0.25 * width as f32);
                    let dy = (y as f32 + 0.5 - height as f32 / 2.0) / (0.25 * height as f32);
                    (-0.5 * (dx * dx + dy * dy)).exp()
                })
            })
            .collect();
        Self {
            width,
            height,
            weight_sum: weights.iter().sum(),
            weights,
            centred: Vec::with_capacity(width * height),
            norm: 0.0,
        }
    }

    fn scale_weights(&mut self, by: &[f32]) {
        for (weight, by) in self.weights.iter_mut().zip(by) {
            *weight *= by;
        }
        self.weight_sum = self.weights.iter().sum();
    }

    /// Takes `values` (width × height); returns their weighted mean.
    fn set(&mut self, values: &[f32]) -> f32 {
        let mean = values
            .iter()
            .zip(&self.weights)
            .map(|(value, weight)| value * weight)
            .sum::<f32>()
            / self.weight_sum.max(1e-6);
        self.centred.clear();
        let mut energy = 0.0;
        for (value, weight) in values.iter().zip(&self.weights) {
            let centred = value - mean;
            energy += weight * centred * centred;
            self.centred.push(weight * centred);
        }
        self.norm = energy.sqrt();
        mean
    }

    /// Weighted normalised cross-correlation with the patch of `image` whose
    /// top-left is (`left`, `top`): 1 = the same picture.
    fn score(&self, image: &Image, left: i64, top: i64) -> f32 {
        let (w, h) = (self.width, self.height);
        let (mut dot, mut sum, mut squares) = (0.0_f32, 0.0_f32, 0.0_f32);
        let rows = self
            .centred
            .chunks_exact(w.max(1))
            .zip(self.weights.chunks_exact(w.max(1)))
            .take(h);
        for (y, (wanted, weights)) in rows.enumerate() {
            let row_y = top + y as i64;
            match image.row(left, row_y, w) {
                Some(row) => {
                    for ((pixel, t), weight) in row.iter().zip(wanted).zip(weights) {
                        let value = f32::from(*pixel);
                        dot += value * t;
                        let weighted = weight * value;
                        sum += weighted;
                        squares += weighted * value;
                    }
                }
                None => {
                    for (x, (t, weight)) in wanted.iter().zip(weights).enumerate() {
                        let value = image.at(left + x as i64, row_y);
                        dot += value * t;
                        let weighted = weight * value;
                        sum += weighted;
                        squares += weighted * value;
                    }
                }
            }
        }
        // The weighted template sums to zero, so the patch's mean drops out of
        // the dot product.
        let energy = squares - sum * sum / self.weight_sum.max(1e-6);
        if energy < 1e-3 || self.norm < 1e-6 {
            0.0
        } else {
            dot / (energy.sqrt() * self.norm)
        }
    }
}

impl Template {
    fn new(tw: usize, th: usize) -> Self {
        Self {
            tw,
            th,
            raw: Vec::with_capacity(tw * th),
            full: Weighted::new(tw, th),
            half: Weighted::new(tw / 2, th / 2),
            mean: 0.0,
        }
    }

    fn prepare(&mut self) {
        self.mean = self.full.set(&self.raw);
        let (hw, hh) = (self.tw / 2, self.th / 2);
        let mut half = Vec::with_capacity(hw * hh);
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
        self.half.set(&half);
    }

    /// Weights the box's pixels by `emphasis` (tw × th, 0–1) on top of the
    /// fall-off toward its edges.
    fn emphasise(&mut self, emphasis: &[f32]) {
        if emphasis.len() != self.tw * self.th {
            return;
        }
        self.full.scale_weights(emphasis);
        let (hw, hh) = (self.tw / 2, self.th / 2);
        let half: Vec<f32> = (0..hh)
            .flat_map(|y| (0..hw).map(move |x| (x, y)))
            .map(|(x, y)| {
                let at = |dx: usize, dy: usize| {
                    emphasis
                        .get((2 * y + dy) * self.tw + 2 * x + dx)
                        .copied()
                        .unwrap_or(1.0)
                };
                (at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) / 4.0
            })
            .collect();
        self.half.scale_weights(&half);
    }

    /// Nothing to match but brightness (a solid block).
    fn flat(&self) -> bool {
        self.full.norm < 1e-3
    }
}

/// `values` less their mean into `out`; returns the mean and the norm of what's left.
pub(crate) fn centre_values(values: &[f32], out: &mut Vec<f32>) -> (f32, f32) {
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
    seen: Vec<bool>,
    /// Summed-area table of a flat template's error over the search stretch.
    sums: Vec<f64>,
}

impl Tracker {
    /// The position within `reach` of `near` whose patch matches `template`
    /// best (normalised cross-correlation, 1 = identical), to a fraction of a
    /// pixel, and that score.
    fn best_match(
        &mut self,
        image: &Image,
        template: &Template,
        near: (f32, f32),
        reach: i32,
    ) -> Option<((f32, f32), f32)> {
        let (tw, th) = (template.tw, template.th);
        if template.flat() {
            // A flat template (a solid block): match its brightness and edges instead.
            return self.best_flat(image, template, near, reach);
        }
        let (left, top) = corner(near, tw, th);
        let score_at = |dx: i32, dy: i32| {
            template
                .full
                .score(image, left + i64::from(dx), top + i64::from(dy))
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
        if tw >= 12 && th >= 12 && template.half.norm >= 1e-3 {
            // Coarse: every other offset on a half-size picture of the
            // stretch the search covers…
            let margin = i64::from(reach) + 2;
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
            let half_reach = reach / 2;
            self.scores.clear();
            for dy in -half_reach..=half_reach {
                for dx in -half_reach..=half_reach {
                    let score = template.half.score(
                        &half,
                        (left + i64::from(2 * dx) - rx).div_euclid(2),
                        (top + i64::from(2 * dy) - ry).div_euclid(2),
                    );
                    self.scores.push((score, 2 * dx, 2 * dy));
                }
            }
            // …then every offset around the three best at full size.
            self.scores.sort_by(|a, b| b.0.total_cmp(&a.0));
            let side = (2 * reach + 1) as usize;
            self.seen.clear();
            self.seen.resize(side * side, false);
            let picks: Vec<(i32, i32)> = self.scores.iter().take(3).map(|s| (s.1, s.2)).collect();
            for (cx, cy) in picks {
                for dy in (cy - 2).max(-reach)..=(cy + 2).min(reach) {
                    for dx in (cx - 2).max(-reach)..=(cx + 2).min(reach) {
                        let slot = ((dy + reach) as usize) * side + (dx + reach) as usize;
                        match self.seen.get_mut(slot) {
                            Some(seen) if !*seen => *seen = true,
                            _ => continue,
                        }
                        consider(score_at(dx, dy), dx, dy);
                    }
                }
            }
        } else {
            for dy in -reach..=reach {
                for dx in -reach..=reach {
                    consider(score_at(dx, dy), dx, dy);
                }
            }
        }
        let (score, dx, dy) = best?;
        // A fraction of a pixel: the peak of a parabola through the
        // neighbours' scores.
        let fx = motion::parabola(score_at(dx - 1, dy), score, score_at(dx + 1, dy));
        let fy = motion::parabola(score_at(dx, dy - 1), score, score_at(dx, dy + 1));
        Some(((near.0 + dx as f32 + fx, near.1 + dy as f32 + fy), score))
    }

    /// The box as first given, looked for anywhere in `image` (a new shot):
    /// every spot of a quarter-size picture, then the best few refined.
    fn search_whole(&mut self, image: &Image, template: &Template) -> Option<((f32, f32), f32)> {
        let (tw, th) = (template.tw, template.th);
        let (qw, qh) = (image.width / 4, image.height / 4);
        let (sw, sh) = (tw / 4, th / 4);
        if template.flat() || sw < 3 || sh < 3 || qw <= sw || qh <= sh {
            return None;
        }
        // The template and the picture at a quarter size.
        let mut small = Vec::with_capacity(sw * sh);
        for y in 0..sh {
            for x in 0..sw {
                let mut sum = 0.0;
                for dy in 0..4 {
                    for dx in 0..4 {
                        sum += template
                            .raw
                            .get((4 * y + dy) * tw + 4 * x + dx)
                            .copied()
                            .unwrap_or(0.0);
                    }
                }
                small.push(sum / 16.0);
            }
        }
        let mut centred = Vec::with_capacity(small.len());
        let (_, norm) = centre_values(&small, &mut centred);
        if norm < 1e-3 {
            return None;
        }
        let mut quarter = Vec::with_capacity(qw * qh);
        for y in 0..qh as i64 {
            for x in 0..qw as i64 {
                let mut sum = 0.0;
                for dy in 0..4 {
                    for dx in 0..4 {
                        sum += image.at(4 * x + dx, 4 * y + dy);
                    }
                }
                quarter.push((sum / 16.0).round() as u8);
            }
        }
        let picture = Image {
            pixels: &quarter,
            width: qw,
            height: qh,
        };
        let mut scores: Vec<(f32, usize, usize)> = Vec::new();
        for top in 0..=qh - sh {
            for left in 0..=qw - sw {
                let score = ncc(&picture, &centred, norm, sw, sh, left as i64, top as i64);
                scores.push((score, left, top));
            }
        }
        scores.sort_by(|a, b| b.0.total_cmp(&a.0));
        let mut best: Option<((f32, f32), f32)> = None;
        for (_, left, top) in scores.into_iter().take(5) {
            let near = (
                (4 * left) as f32 + tw as f32 / 2.0,
                (4 * top) as f32 + th as f32 / 2.0,
            );
            if let Some(found) = self.best_match(image, template, near, 4) {
                if best.is_none_or(|(_, score)| found.1 > score) {
                    best = Some(found);
                }
            }
        }
        best
    }
}

/// Normalised cross-correlation of the patch at (`left`, `top`) with a
/// centred template whose norm is `norm`.
pub(crate) fn ncc(
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
        reach: i32,
    ) -> Option<((f32, f32), f32)> {
        let (tw, th) = (template.tw, template.th);
        let target = template.mean;
        let (left, top) = corner(near, tw, th);
        let (rx, ry) = (left - i64::from(reach), top - i64::from(reach));
        let (w, h) = (tw + 2 * reach as usize, th + 2 * reach as usize);
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
        for dy in -reach..=reach {
            for dx in -reach..=reach {
                let (x0, y0) = ((dx + reach) as usize, (dy + reach) as usize);
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
        Frames::new(width, height, pixels)
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
                .best_match(&frames.image(index), &template, at, REACH)
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
        let frames = Frames::new(width, height, pixels);
        let centres = follow(&frames, 0, (30.0, 40.0), 20, 20);
        assert!((centres[9].0 - 66.0).abs() <= 1.0, "{:?}", centres[9]);
        assert!((centres[9].1 - 40.0).abs() <= 1.0, "{:?}", centres[9]);
    }

    /// On black frames every spot matches: the box stays where it is.
    #[test]
    fn holds_still_on_black_frames() {
        let frames = Frames::new(120, 80, vec![0; 120 * 80 * 30]);
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
            .best_match(&image, &template, near, REACH)
            .unwrap();
        let (left, top) = corner(near, 24, 22);
        let mut best = (f32::MIN, 0, 0);
        for dy in -REACH..=REACH {
            for dx in -REACH..=REACH {
                let score = template
                    .full
                    .score(&image, left + i64::from(dx), top + i64::from(dy));
                if score > best.0 {
                    best = (score, dx, dy);
                }
            }
        }
        // The same pixel (then refined to a fraction of one).
        let exhaustive = (near.0 + best.1 as f32, near.1 + best.2 as f32);
        assert!(
            (found.0 .0 - exhaustive.0).abs() <= 0.5 && (found.0 .1 - exhaustive.1).abs() <= 0.5,
            "{found:?} vs {best:?}"
        );
    }

    /// A synthetic shot: textured scenery seen by a camera that jolts up to
    /// ~45 px between frames (far beyond the search's reach on its own), a
    /// distinct patch crossing it fast (6 px a frame), then a cut at frame
    /// `CUT` to other scenery where the patch is somewhere else, moving left.
    /// Returns the frames and the patch's true centre in each.
    const CUT: usize = 40;
    fn shaky_shot(patch_after_cut: bool) -> (Frames, Vec<(f32, f32)>) {
        use crate::motion::tests::texture;
        let (width, height, count) = (320_usize, 180_usize, 60_usize);
        let mut pixels = Vec::with_capacity(width * height * count);
        let mut truth = Vec::new();
        for frame in 0..count {
            let f = frame as f64;
            let (camera, scenery, patch) = if frame < CUT {
                (
                    (
                        30.0 * (f * 1.7).sin() + 8.0 * (f * 4.1).cos(),
                        18.0 * (f * 2.3).cos(),
                    ),
                    0.0,
                    (60.0 + 6.0 * f, 90.0 + 2.0 * (f * 0.5).sin()),
                )
            } else {
                let g = (frame - CUT) as f64;
                ((0.0, 0.0), 9000.0, (230.0 - 3.0 * g, 60.0))
            };
            // The patch, where it is in the picture.
            let at = (patch.0 - camera.0, patch.1 - camera.1);
            truth.push((at.0 as f32, at.1 as f32));
            for y in 0..height {
                for x in 0..width {
                    let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
                    let inside = (px - at.0).abs() < 13.0 && (py - at.1).abs() < 13.0;
                    let value = if inside && (frame < CUT || patch_after_cut) {
                        // Its own pattern, high contrast.
                        if texture(px - at.0 + 5000.0, py - at.1 + 5000.0) > 127.0 {
                            235.0
                        } else {
                            25.0
                        }
                    } else {
                        texture(px + camera.0 + 1000.0 + scenery, py + camera.1 + 1000.0)
                    };
                    pixels.push(value.round() as u8);
                }
            }
        }
        (Frames::new(width, height, pixels), truth)
    }

    /// The tracker carries the box with the camera, follows its own fast
    /// movement, and finds it again after the cut.
    #[test]
    fn follows_fast_movement_through_shake_and_a_cut() {
        let (frames, truth) = shaky_shot(true);
        let steps = frames.steps();
        assert!(steps[CUT - 1].cut, "the cut is seen");
        assert_eq!(
            steps.iter().filter(|step| step.cut).count(),
            1,
            "only the cut"
        );
        let start = 10;
        let found = follow_all(
            &frames,
            steps,
            &[Start {
                index: start,
                centre: truth[start],
                tw: 24,
                th: 24,
            }],
        );
        for (index, (spot, want)) in found.iter().zip(&truth).enumerate() {
            let error = (spot.at.0 - want.0).hypot(spot.at.1 - want.1);
            assert!(!spot.lost, "frame {index} lost");
            assert!(
                error < 1.5,
                "frame {index}: {:?} not {want:?} ({error:.1} px)",
                spot.at
            );
        }
    }

    /// When the box isn't in the new shot, the frames after the cut are
    /// reported lost, and a second box given there tracks them.
    #[test]
    fn another_box_after_a_cut() {
        let (frames, truth) = shaky_shot(false);
        let steps = frames.steps();
        let one = [Start {
            index: 10,
            centre: truth[10],
            tw: 24,
            th: 24,
        }];
        let found = follow_all(&frames, steps, &one);
        assert!(found[..CUT].iter().all(|spot| !spot.lost));
        assert!(
            found[CUT..].iter().all(|spot| spot.lost),
            "nothing to follow after the cut"
        );
        // A plain spot of the new scenery, given after the cut, is followed there.
        let given = (100.0, 100.0);
        let two = [
            one[0],
            Start {
                index: 50,
                centre: given,
                tw: 24,
                th: 24,
            },
        ];
        let found = follow_all(&frames, steps, &two);
        for index in CUT..frames.count {
            assert!(!found[index].lost, "frame {index}");
            let error = (found[index].at.0 - given.0).hypot(found[index].at.1 - given.1);
            assert!(error < 1.0, "frame {index}: {:?}", found[index].at);
        }
        for index in 0..CUT {
            let error =
                (found[index].at.0 - truth[index].0).hypot(found[index].at.1 - truth[index].1);
            assert!(
                error < 1.5,
                "frame {index}: {:?} not {:?}",
                found[index].at,
                truth[index]
            );
        }
    }

    /// The smoothing fits a line locally: steady movement passes through
    /// unchanged, ends included, and a cut isn't smoothed over.
    #[test]
    fn smoothing_neither_lags_nor_crosses_cuts() {
        let spots: Vec<Spot> = (0..30)
            .map(|index| Spot {
                at: if index < 20 {
                    (5.0 * index as f32, 0.0)
                } else {
                    (500.0, 300.0)
                },
                score: 1.0,
                lost: false,
            })
            .collect();
        let path = smooth(&spots, &[20], 2.0);
        for (index, (x, y)) in path.iter().enumerate() {
            let want = spots[index].at;
            assert!(
                (x - want.0).abs() < 1e-3 && (y - want.1).abs() < 1e-3,
                "{index}: {x},{y}"
            );
        }
    }

    /// The Mom & Teen intro's bench shot (Hanan on the porch, bodycam, shown
    /// at ~2.9×): her face's centre as read off the frames by eye, source
    /// pixels. `EDIT_TRACK_REAL=/tmp/motion` (src.mp4 = the excerpt,
    /// light.mp4 = its light preview) runs it.
    #[test]
    #[ignore = "needs the real footage"]
    fn real_bench_face() {
        let Some(dir) = std::env::var_os("EDIT_TRACK_REAL").map(PathBuf::from) else {
            return;
        };
        // Read off 6× crops: the middle of the skin of her face (in profile).
        let truth = [
            (23.0, 563.0, 647.0),
            (23.25, 563.0, 651.0),
            (23.5, 564.0, 650.0),
            (23.75, 567.0, 641.0),
            (24.0, 562.0, 635.0),
            (24.25, 537.0, 632.0),
            (24.5, 517.0, 631.0),
            (24.75, 505.0, 630.0),
            (25.0, 503.0, 630.0),
        ];
        let face = |(at, cx, cy): (f64, f64, f64)| Anchor {
            at,
            region: [cx - 22.0, cy - 25.0, cx + 22.0, cy + 25.0],
        };
        let mut runs: Vec<Vec<Anchor>> = truth.iter().map(|t| vec![face(*t)]).collect();
        runs.push(vec![face(truth[0]), face(truth[4]), face(truth[8])]);
        for file in ["light.mp4", "src.mp4"] {
            for anchors in &runs {
                let at = anchors
                    .iter()
                    .map(|a| a.at.to_string())
                    .collect::<Vec<_>>()
                    .join("+");
                let samples =
                    track_anchors(&dir.join(file), (1920, 1080), 30.0, 23.0, 25.25, anchors)
                        .unwrap()
                        .samples;
                let errors: Vec<f64> = truth
                    .iter()
                    .map(|(t, x, y)| {
                        let s = samples
                            .iter()
                            .min_by(|a, b| (a.time - t).abs().total_cmp(&(b.time - t).abs()))
                            .unwrap();
                        (s.x - x).hypot(s.y - y)
                    })
                    .collect();
                let mean = errors.iter().sum::<f64>() / errors.len() as f64;
                let max = errors.iter().copied().fold(0.0, f64::max);
                println!(
                    "{file} from {at}: mean {mean:.1} px, max {max:.1} px: {:?}",
                    errors.iter().map(|e| e.round()).collect::<Vec<_>>()
                );
            }
        }
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
        let samples = track(&path, (1280, 720), 30.0, 0.0, 3.5, 1.0, region).unwrap();
        let first = started.elapsed();
        let started = Instant::now();
        let again = track(&path, (1280, 720), 30.0, 0.0, 3.5, 1.0, region).unwrap();
        assert!(
            started.elapsed() < first,
            "the second pass reuses the frames"
        );
        assert_eq!(samples, again);
        // A short stretch is looked at the footage's own rate.
        assert_eq!(samples.len(), 105);
        for sample in &samples {
            let expected = 160.0 + 200.0 * sample.time;
            // The centred fit doesn't lag, even at the ends.
            assert!(
                (sample.x - expected).abs() < 6.0 && (sample.y - 360.0).abs() < 6.0,
                "{sample:?} not near {expected}"
            );
        }
        // FFmpeg (the compatibility decoder) sees the same pictures.
        let ffmpeg = decode_ffmpeg(&path, 0.0, 3.5, 340, 192, 15.0).unwrap();
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
