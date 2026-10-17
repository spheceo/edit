//! Camera motion between frames: how the whole picture moved (shift, turn and
//! zoom) from one small greyscale frame to the next. The tracker predicts
//! where a box went from it (a bodycam that swings 100 px between frames
//! still only leaves the person's own movement to search), and `stabilize`
//! smooths the camera's path with it.
//!
//! A frame pair is matched coarse to fine: the whole picture at a quarter of
//! the size for the rough shift, then a grid of small textured patches at the
//! analysis size, each found to a fraction of a pixel; a shift, turn and zoom
//! is fitted to the patches that agree (people walking through are outliers).

use crate::track::{centre_values, ncc, Image};

/// Frames are looked at this wide for camera motion.
pub const ANALYSIS_WIDTH: usize = 384;
/// The rough shift is searched this far (quarter-size pixels) each way.
const COARSE_REACH: i32 = 16;
/// Patches on a grid this many across and down…
const GRID: (usize, usize) = (8, 5);
/// …this many pixels square…
const PATCH: usize = 24;
/// …each searched this far around where the rough shift puts it.
const PATCH_REACH: i32 = 6;

/// How the picture moved from one frame to the next, about the frame's
/// centre: a point `p` of the first is at `scale · R(angle) · (p − c) + c +
/// (dx, dy)` in the second.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Motion {
    pub dx: f64,
    pub dy: f64,
    /// Radians, clockwise on screen (y down).
    pub angle: f64,
    pub scale: f64,
}

impl Default for Motion {
    fn default() -> Self {
        Self::IDENTITY
    }
}

impl Motion {
    pub const IDENTITY: Self = Self {
        dx: 0.0,
        dy: 0.0,
        angle: 0.0,
        scale: 1.0,
    };

    /// Where `point` of the first frame is in the second.
    pub fn apply(&self, point: (f64, f64), centre: (f64, f64)) -> (f64, f64) {
        let (x, y) = (point.0 - centre.0, point.1 - centre.1);
        let (c, s) = (self.scale * self.angle.cos(), self.scale * self.angle.sin());
        (
            c * x - s * y + centre.0 + self.dx,
            s * x + c * y + centre.1 + self.dy,
        )
    }

    /// The motion back from the second frame to the first.
    pub fn inverse(&self) -> Self {
        let scale = 1.0 / self.scale.max(1e-6);
        let angle = -self.angle;
        let (c, s) = (scale * angle.cos(), scale * angle.sin());
        Self {
            dx: -(c * self.dx - s * self.dy),
            dy: -(s * self.dx + c * self.dy),
            angle,
            scale,
        }
    }

    /// The same motion in pictures `factor` times as big.
    pub fn scaled(&self, factor: f64) -> Self {
        Self {
            dx: self.dx * factor,
            dy: self.dy * factor,
            ..*self
        }
    }
}

/// The camera's move from one frame to the next.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Step {
    pub motion: Motion,
    /// The second frame is another shot (nothing of the first found in it).
    pub cut: bool,
    /// Share of the patches that agree with `motion` (0–1).
    pub confidence: f32,
}

impl Step {
    pub const STILL: Self = Self {
        motion: Motion::IDENTITY,
        cut: false,
        confidence: 0.0,
    };
}

/// A frame shrunk for motion analysis, with its half and quarter sizes.
pub struct Small {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<u8>,
    /// Pixels of the frame it was made from per pixel of this one.
    pub factor: f64,
    quarter: (usize, usize, Vec<u8>),
}

impl Small {
    /// `image` box-filtered down to at most ANALYSIS_WIDTH wide.
    pub fn of(image: &Image) -> Self {
        let step = image.width.div_ceil(ANALYSIS_WIDTH).max(1);
        let (width, height, pixels) = shrink(image.pixels, image.width, image.height, step);
        let (qw, qh, quarter) = shrink(&pixels, width, height, 4);
        Self {
            width,
            height,
            pixels,
            factor: step as f64,
            quarter: (qw, qh, quarter),
        }
    }

    fn image(&self) -> Image<'_> {
        Image {
            pixels: &self.pixels,
            width: self.width,
            height: self.height,
        }
    }

    fn quarter(&self) -> Image<'_> {
        Image {
            pixels: &self.quarter.2,
            width: self.quarter.0,
            height: self.quarter.1,
        }
    }
}

/// `pixels` (`width`×`height`) averaged over `step`×`step` blocks.
fn shrink(pixels: &[u8], width: usize, height: usize, step: usize) -> (usize, usize, Vec<u8>) {
    let (w, h) = ((width / step).max(1), (height / step).max(1));
    let mut out = Vec::with_capacity(w * h);
    let area = (step * step) as u32;
    for y in 0..h {
        for x in 0..w {
            let mut sum = 0_u32;
            for dy in 0..step {
                let row = (y * step + dy) * width + x * step;
                sum += pixels
                    .get(row..row + step)
                    .map_or(0, |run| run.iter().map(|p| u32::from(*p)).sum());
            }
            out.push(((sum + area / 2) / area) as u8);
        }
    }
    (w, h, out)
}

/// The camera's move from `a` to `b` (same size), in `a`'s source pixels
/// (the frames `Small::of` was given).
pub fn step(a: &Small, b: &Small) -> Step {
    // Rough shift: the middle of the quarter-size picture, every offset.
    let (qa, qb) = (a.quarter(), b.quarter());
    let margin = COARSE_REACH as usize + 1;
    let (bw, bh) = (
        qa.width.saturating_sub(2 * margin),
        qa.height.saturating_sub(2 * margin),
    );
    if bw < 8 || bh < 8 {
        return Step::STILL;
    }
    let mut block = Vec::with_capacity(bw * bh);
    for y in 0..bh {
        let start = (y + margin) * qa.width + margin;
        block.extend(
            qa.pixels
                .get(start..start + bw)
                .unwrap_or_default()
                .iter()
                .map(|p| f32::from(*p)),
        );
    }
    let mut centred = Vec::new();
    let (_, norm) = centre_values(&block, &mut centred);
    if norm < 1e-3 {
        // A flat picture (black, a white flash): nothing to go by.
        return Step::STILL;
    }
    let mut rough: (f32, i32, i32) = (f32::MIN, 0, 0);
    for dy in -COARSE_REACH..=COARSE_REACH {
        for dx in -COARSE_REACH..=COARSE_REACH {
            let score = ncc(
                &qb,
                &centred,
                norm,
                bw,
                bh,
                margin as i64 + i64::from(dx),
                margin as i64 + i64::from(dy),
            );
            // Ties go to the smaller move.
            if score > rough.0 + 1e-6
                || ((score - rough.0).abs() <= 1e-6
                    && dx.abs() + dy.abs() < rough.1.abs() + rough.2.abs())
            {
                rough = (score, dx, dy);
            }
        }
    }
    let (rough_score, rx, ry) = rough;

    // Patches: each found near where the rough shift puts it.
    let (ia, ib) = (a.image(), b.image());
    let shift = (rx as f32 * 4.0, ry as f32 * 4.0);
    let mut pairs: Vec<((f64, f64), (f64, f64))> = Vec::new();
    let mut patch = Vec::with_capacity(PATCH * PATCH);
    let mut centred = Vec::with_capacity(PATCH * PATCH);
    let (gx, gy) = GRID;
    let edge = PATCH as f32 / 2.0 + 2.0;
    for row in 0..gy {
        for column in 0..gx {
            let centre = (
                edge + (a.width as f32 - 2.0 * edge) * (column as f32 + 0.5) / gx as f32,
                edge + (a.height as f32 - 2.0 * edge) * (row as f32 + 0.5) / gy as f32,
            );
            let target = (centre.0 + shift.0, centre.1 + shift.1);
            let reach = PATCH_REACH as f32 + edge;
            if target.0 < reach
                || target.1 < reach
                || target.0 > b.width as f32 - reach
                || target.1 > b.height as f32 - reach
            {
                continue;
            }
            ia.patch_into(centre, PATCH, PATCH, &mut patch);
            let (_, norm) = centre_values(&patch, &mut centred);
            // Too plain to place (sky, a wall in shadow).
            if norm < 4.0 * PATCH as f32 {
                continue;
            }
            let Some((found, score)) = best_offset(&ib, &centred, norm, PATCH, target, PATCH_REACH)
            else {
                continue;
            };
            if score < 0.7 {
                continue;
            }
            pairs.push((
                (f64::from(centre.0), f64::from(centre.1)),
                (f64::from(found.0), f64::from(found.1)),
            ));
        }
    }
    let considered = pairs.len();
    let centre = (a.width as f64 / 2.0, a.height as f64 / 2.0);
    let fitted = fit(&pairs, centre);
    let cut = rough_score < 0.3 || (fitted.is_none() && rough_score < 0.5);
    let (motion, inliers) = match fitted {
        Some(found) => found,
        // Too few patches (a plain or blurred frame): the rough shift.
        None if !cut => (
            Motion {
                dx: f64::from(shift.0),
                dy: f64::from(shift.1),
                ..Motion::IDENTITY
            },
            0,
        ),
        None => (Motion::IDENTITY, 0),
    };
    Step {
        motion: if cut {
            Motion::IDENTITY
        } else {
            motion.scaled(a.factor)
        },
        cut,
        confidence: if considered == 0 {
            0.0
        } else {
            inliers as f32 / considered as f32
        },
    }
}

/// The camera's move between each frame and the next (`frames.len() − 1`
/// steps), worked out side by side.
pub fn steps(frames: &[Small]) -> Vec<Step> {
    let count = frames.len().saturating_sub(1);
    if count == 0 {
        return Vec::new();
    }
    let threads = std::thread::available_parallelism()
        .map_or(2, std::num::NonZeroUsize::get)
        .clamp(1, 4)
        .min(count);
    let chunk = count.div_ceil(threads);
    std::thread::scope(|scope| {
        let parts: Vec<_> = (0..threads)
            .map(|part| {
                scope.spawn(move || {
                    (part * chunk..((part + 1) * chunk).min(count))
                        .map(|index| match (frames.get(index), frames.get(index + 1)) {
                            (Some(a), Some(b)) => step(a, b),
                            _ => Step::STILL,
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        parts
            .into_iter()
            .flat_map(|part| part.join().unwrap_or_default())
            .collect()
    })
}

/// The best spot for a `size`-square centred template within `reach` of
/// `near` (normalised cross-correlation), refined to a fraction of a pixel.
fn best_offset(
    image: &Image,
    centred: &[f32],
    norm: f32,
    size: usize,
    near: (f32, f32),
    reach: i32,
) -> Option<((f32, f32), f32)> {
    let left = (near.0 - size as f32 / 2.0).round() as i64;
    let top = (near.1 - size as f32 / 2.0).round() as i64;
    let side = (2 * reach + 1) as usize;
    let mut scores = vec![f32::MIN; side * side];
    let mut best = (f32::MIN, 0_i32, 0_i32);
    for dy in -reach..=reach {
        for dx in -reach..=reach {
            let score = ncc(
                image,
                centred,
                norm,
                size,
                size,
                left + i64::from(dx),
                top + i64::from(dy),
            );
            if let Some(slot) =
                scores.get_mut(((dy + reach) as usize) * side + (dx + reach) as usize)
            {
                *slot = score;
            }
            if score > best.0 {
                best = (score, dx, dy);
            }
        }
    }
    let (score, bx, by) = best;
    if score == f32::MIN {
        return None;
    }
    let at = |dx: i32, dy: i32| {
        if dx.abs() > reach || dy.abs() > reach {
            return None;
        }
        scores
            .get(((dy + reach) as usize) * side + (dx + reach) as usize)
            .copied()
    };
    let sub = |minus: Option<f32>, plus: Option<f32>| match (minus, plus) {
        (Some(m), Some(p)) => parabola(m, score, p),
        _ => 0.0,
    };
    let fx = sub(at(bx - 1, by), at(bx + 1, by));
    let fy = sub(at(bx, by - 1), at(bx, by + 1));
    Some(((near.0 + bx as f32 + fx, near.1 + by as f32 + fy), score))
}

/// Where the peak of a parabola through three equally spaced values lies,
/// relative to the middle one (−0.5..0.5).
pub fn parabola(minus: f32, middle: f32, plus: f32) -> f32 {
    let curve = minus - 2.0 * middle + plus;
    if curve >= -1e-6 {
        return 0.0;
    }
    (0.5 * (minus - plus) / curve).clamp(-0.5, 0.5)
}

/// A shift, turn and zoom fitted to matched points (`(from, to)`, pixels),
/// leaving out the ones that disagree, and how many agree. None when too few
/// points agree on anything.
pub fn fit(pairs: &[((f64, f64), (f64, f64))], centre: (f64, f64)) -> Option<(Motion, usize)> {
    if pairs.len() < 4 {
        return None;
    }
    // Start from the median shift: robust to a third of the points moving
    // their own way.
    let median = |values: &mut Vec<f64>| {
        values.sort_by(f64::total_cmp);
        values.get(values.len() / 2).copied().unwrap_or(0.0)
    };
    let mut xs: Vec<f64> = pairs.iter().map(|(a, b)| b.0 - a.0).collect();
    let mut ys: Vec<f64> = pairs.iter().map(|(a, b)| b.1 - a.1).collect();
    let mut motion = Motion {
        dx: median(&mut xs),
        dy: median(&mut ys),
        ..Motion::IDENTITY
    };
    let mut inliers: Vec<bool> = vec![true; pairs.len()];
    for round in 0..4 {
        let mut residuals: Vec<f64> = pairs
            .iter()
            .map(|(a, b)| {
                let p = motion.apply(*a, centre);
                (p.0 - b.0).hypot(p.1 - b.1)
            })
            .collect();
        let typical = median(&mut residuals.clone());
        let limit = if round == 0 {
            (2.5 * typical).max(2.0)
        } else {
            (3.0 * typical).max(0.75)
        };
        for (inlier, residual) in inliers.iter_mut().zip(&residuals) {
            *inlier = *residual <= limit;
        }
        residuals.clear();
        let chosen: Vec<&((f64, f64), (f64, f64))> = pairs
            .iter()
            .zip(&inliers)
            .filter(|(_, inlier)| **inlier)
            .map(|(pair, _)| pair)
            .collect();
        if chosen.len() < 4 {
            return None;
        }
        motion = similarity(&chosen, centre);
    }
    let count = inliers.iter().filter(|inlier| **inlier).count();
    // A camera doesn't turn or zoom much between frames; something that says
    // so fitted people, not the scene: the shift alone then.
    if motion.angle.abs() > 0.08 || (motion.scale - 1.0).abs() > 0.08 {
        motion.angle = 0.0;
        motion.scale = 1.0;
    }
    Some((motion, count))
}

/// The least-squares shift, turn and zoom taking each `from` to its `to`.
fn similarity(pairs: &[&((f64, f64), (f64, f64))], centre: (f64, f64)) -> Motion {
    let n = pairs.len() as f64;
    let rel = |p: (f64, f64)| (p.0 - centre.0, p.1 - centre.1);
    let (mut ax, mut ay, mut bx, mut by) = (0.0, 0.0, 0.0, 0.0);
    for (a, b) in pairs {
        let (a, b) = (rel(*a), rel(*b));
        ax += a.0;
        ay += a.1;
        bx += b.0;
        by += b.1;
    }
    let (ax, ay, bx, by) = (ax / n, ay / n, bx / n, by / n);
    let (mut dot, mut cross, mut spread) = (0.0, 0.0, 0.0);
    for (a, b) in pairs {
        let (a, b) = (rel(*a), rel(*b));
        let (x, y, u, v) = (a.0 - ax, a.1 - ay, b.0 - bx, b.1 - by);
        dot += x * u + y * v;
        cross += x * v - y * u;
        spread += x * x + y * y;
    }
    let (c, s) = if spread > 1e-6 {
        (dot / spread, cross / spread)
    } else {
        (1.0, 0.0)
    };
    Motion {
        dx: bx - (c * ax - s * ay),
        dy: by - (s * ax + c * ay),
        angle: s.atan2(c),
        scale: c.hypot(s),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Smooth random texture, `width`×`height`, sampled at `(x, y)` with bilinear filtering.
    pub(crate) fn texture(x: f64, y: f64) -> f64 {
        let hash = |ix: i64, iy: i64| {
            let n = (ix.wrapping_mul(374_761_393) ^ iy.wrapping_mul(668_265_263)) as u64;
            let n = (n ^ (n >> 13)).wrapping_mul(1_274_126_177);
            ((n >> 16) & 0xff) as f64
        };
        let cell = 6.0;
        let (gx, gy) = (x / cell, y / cell);
        let (ix, iy) = (gx.floor() as i64, gy.floor() as i64);
        let (fx, fy) = (gx - gx.floor(), gy - gy.floor());
        let top = hash(ix, iy) * (1.0 - fx) + hash(ix + 1, iy) * fx;
        let bottom = hash(ix, iy + 1) * (1.0 - fx) + hash(ix + 1, iy + 1) * fx;
        top * (1.0 - fy) + bottom * fy
    }

    /// A picture of the texture seen through `motion` (the scene moved by it).
    fn view(width: usize, height: usize, motion: Motion) -> Vec<u8> {
        let centre = (width as f64 / 2.0, height as f64 / 2.0);
        let back = motion.inverse();
        let mut pixels = Vec::with_capacity(width * height);
        for y in 0..height {
            for x in 0..width {
                let (sx, sy) = back.apply((x as f64, y as f64), centre);
                pixels.push(texture(sx + 1000.0, sy + 1000.0).round() as u8);
            }
        }
        pixels
    }

    #[test]
    fn inverse_undoes() {
        let motion = Motion {
            dx: 12.0,
            dy: -7.0,
            angle: 0.03,
            scale: 1.02,
        };
        let centre = (320.0, 180.0);
        let p = motion
            .inverse()
            .apply(motion.apply((100.0, 50.0), centre), centre);
        assert!(
            (p.0 - 100.0).abs() < 1e-9 && (p.1 - 50.0).abs() < 1e-9,
            "{p:?}"
        );
    }

    /// A shift, a small turn and zoom between two frames are measured to a
    /// fraction of a pixel.
    #[test]
    fn measures_a_camera_move() {
        let (width, height) = (768, 432);
        let a = view(width, height, Motion::IDENTITY);
        let moved = Motion {
            dx: 37.0,
            dy: -21.5,
            angle: 0.02,
            scale: 1.01,
        };
        let b = view(width, height, moved);
        let image = |pixels: &[u8]| {
            Small::of(&Image {
                pixels,
                width,
                height,
            })
        };
        let found = step(&image(&a), &image(&b));
        assert!(!found.cut);
        let m = found.motion;
        assert!((m.dx - moved.dx).abs() < 1.0, "{m:?}");
        assert!((m.dy - moved.dy).abs() < 1.0, "{m:?}");
        assert!((m.angle - moved.angle).abs() < 0.004, "{m:?}");
        assert!((m.scale - moved.scale).abs() < 0.004, "{m:?}");
    }

    /// Something else entirely is a cut.
    #[test]
    fn sees_a_cut() {
        let (width, height) = (384, 216);
        let a = view(width, height, Motion::IDENTITY);
        let b: Vec<u8> = view(
            width,
            height,
            Motion {
                dx: 5000.0,
                dy: 3000.0,
                ..Motion::IDENTITY
            },
        );
        let image = |pixels: &[u8]| {
            Small::of(&Image {
                pixels,
                width,
                height,
            })
        };
        assert!(step(&image(&a), &image(&b)).cut);
    }
}
