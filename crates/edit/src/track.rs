//! Region tracking: follows a box (a face, a redaction block) through footage
//! by template matching on small greyscale frames, the way After Effects'
//! point tracker does. No models and no extra dependencies: FFmpeg decodes.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

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
    // Look at the footage so the box is about BOX_WIDTH pixels wide.
    let scale = (BOX_WIDTH / box_w).clamp(96.0 / source_w, 1.0);
    let (width, height) = (even(source_w * scale), even(source_h * scale));
    let frames = decode(path, from, to, width, height)?;
    if frames.is_empty() {
        return Err("couldn't decode the footage to track".into());
    }
    let (sx, sy) = (
        f64::from(width as u32) / source_w,
        f64::from(height as u32) / source_h,
    );
    let start = (((at - from) * SAMPLE_RATE).round().max(0.0) as usize).min(frames.len() - 1);
    let (tw, th) = (
        ((box_w * sx).round() as usize).clamp(6, 96),
        ((box_h * sy).round() as usize).clamp(6, 96),
    );
    let centre = (((x0 + x1) / 2.0 * sx) as f32, ((y0 + y1) / 2.0 * sy) as f32);
    let image = |index: usize| Image {
        pixels: &frames[index],
        width,
        height,
    };

    let mut centres = vec![centre; frames.len()];
    for direction in [1_i64, -1] {
        let mut template = image(start).patch(centre, tw, th);
        let mut at = centre;
        let mut index = start as i64 + direction;
        while index >= 0 && (index as usize) < frames.len() {
            let frame = image(index as usize);
            if let Some((found, score)) = frame.best_match(&template, tw, th, at) {
                if score >= LOST {
                    at = found;
                    // Let the pattern follow slow changes (a turning head) when the match is good.
                    if score > 0.6 {
                        let fresh = frame.patch(at, tw, th);
                        for (old, new) in template.iter_mut().zip(fresh) {
                            *old = *old * 0.85 + new * 0.15;
                        }
                    }
                }
            }
            centres[index as usize] = at;
            index += direction;
        }
    }

    // A short moving average takes out the tracker's own jitter.
    let smooth: Vec<(f32, f32)> = (0..centres.len())
        .map(|index| {
            let window = &centres[index.saturating_sub(2)..(index + 3).min(centres.len())];
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

fn even(value: f64) -> usize {
    ((value.round() as usize) / 2 * 2).max(2)
}

/// Greyscale frames of the source between `from` and `to`, SAMPLE_RATE a second.
fn decode(
    path: &Path,
    from: f64,
    to: f64,
    width: usize,
    height: usize,
) -> Result<Vec<Vec<u8>>, String> {
    let mut child = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            &format!("{from:.4}"),
            "-t",
            &format!("{:.4}", to - from),
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
    let mut frames = Vec::new();
    loop {
        let mut frame = vec![0_u8; width * height];
        if stdout.read_exact(&mut frame).is_err() {
            break;
        }
        frames.push(frame);
    }
    let _ = child.wait();
    Ok(frames)
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
        f32::from(self.pixels[y * self.width + x])
    }

    /// A `tw`×`th` patch centred at `centre`.
    fn patch(&self, centre: (f32, f32), tw: usize, th: usize) -> Vec<f32> {
        let (left, top) = (
            (centre.0 - tw as f32 / 2.0).round() as i64,
            (centre.1 - th as f32 / 2.0).round() as i64,
        );
        (0..th)
            .flat_map(|y| (0..tw).map(move |x| (x, y)))
            .map(|(x, y)| self.at(left + x as i64, top + y as i64))
            .collect()
    }

    /// The position within REACH of `near` whose patch matches `template` best
    /// (normalised cross-correlation, 1 = identical), and that score.
    fn best_match(
        &self,
        template: &[f32],
        tw: usize,
        th: usize,
        near: (f32, f32),
    ) -> Option<((f32, f32), f32)> {
        let n = template.len() as f32;
        let mean = template.iter().sum::<f32>() / n;
        let centred: Vec<f32> = template.iter().map(|value| value - mean).collect();
        let norm = centred
            .iter()
            .map(|value| value * value)
            .sum::<f32>()
            .sqrt();
        if norm < 1e-3 {
            // A flat template (a solid block): match its brightness and edges instead.
            return self.best_flat(template, tw, th, near);
        }
        let mut best: Option<((f32, f32), f32)> = None;
        for dy in -REACH..=REACH {
            for dx in -REACH..=REACH {
                let centre = (near.0 + dx as f32, near.1 + dy as f32);
                let patch = self.patch(centre, tw, th);
                let patch_mean = patch.iter().sum::<f32>() / n;
                let (mut dot, mut energy) = (0.0, 0.0);
                for (value, t) in patch.iter().zip(&centred) {
                    let v = value - patch_mean;
                    dot += v * t;
                    energy += v * v;
                }
                let score = if energy < 1e-3 {
                    0.0
                } else {
                    dot / (energy.sqrt() * norm)
                };
                if best.is_none_or(|(_, top)| score > top) {
                    best = Some((centre, score));
                }
            }
        }
        best
    }

    /// For a uniform block (a black redaction box): the spot whose patch is
    /// closest in brightness, scored so a perfect match is 1.
    fn best_flat(
        &self,
        template: &[f32],
        tw: usize,
        th: usize,
        near: (f32, f32),
    ) -> Option<((f32, f32), f32)> {
        let target = template.iter().sum::<f32>() / template.len() as f32;
        let mut best: Option<((f32, f32), f32)> = None;
        for dy in -REACH..=REACH {
            for dx in -REACH..=REACH {
                let centre = (near.0 + dx as f32, near.1 + dy as f32);
                let patch = self.patch(centre, tw, th);
                let error = patch
                    .iter()
                    .map(|value| (value - target).abs())
                    .sum::<f32>()
                    / patch.len() as f32;
                let score = 1.0 - error / 64.0;
                if best.is_none_or(|(_, top)| score > top) {
                    best = Some((centre, score));
                }
            }
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A textured square moving right 2 px a frame over noise is followed.
    #[test]
    fn follows_a_moving_patch() {
        let (width, height) = (120, 80);
        let frames: Vec<Vec<u8>> = (0..20)
            .map(|frame| {
                let mut pixels: Vec<u8> = (0..width * height)
                    .map(|i| ((i * 7919) % 97) as u8)
                    .collect();
                for y in 30..50 {
                    for x in 0..20 {
                        let px = 20 + frame * 2 + x;
                        pixels[y * width + px] = if (x / 4 + y / 4) % 2 == 0 { 255 } else { 120 };
                    }
                }
                pixels
            })
            .collect();
        let image = |index: usize| Image {
            pixels: &frames[index],
            width,
            height,
        };
        let mut at = (30.0, 40.0);
        let mut template = image(0).patch(at, 20, 20);
        for index in 1..frames.len() {
            let (found, score) = image(index).best_match(&template, 20, 20, at).unwrap();
            assert!(score > 0.9, "frame {index}: {score}");
            at = found;
            template = image(index).patch(at, 20, 20);
        }
        assert!((at.0 - (30.0 + 19.0 * 2.0)).abs() <= 1.0, "ended at {at:?}");
        assert!((at.1 - 40.0).abs() <= 1.0);
    }
}
