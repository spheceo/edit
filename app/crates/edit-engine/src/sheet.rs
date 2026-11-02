//! Contact sheets sized for the model's eyes. Claude reads a picture in
//! 28 × 28 px patches, one token each (`⌈w/28⌉ × ⌈h/28⌉`), up to 2576 px on
//! the long edge and 4784 tokens (Opus 4.7 and later; older models 1568 px
//! and tokens). A sheet here is laid out on that grid, every cell's slot a
//! whole number of patches, so no token pays for a sliver of picture, and
//! sized to a stated budget: the grid drawing each frame largest within it.
//! Each cell carries its label (its number, and its time when it has one) and
//! each row of a sheet in time a ruler: the row's span, a tick under each cell.

use std::sync::OnceLock;

use crate::render::{RgbaImage, downscale};

/// A visual token's side, px.
pub const PATCH: u32 = 28;
/// The longest side a model reads unresized.
pub const LONG_EDGE: u32 = 2576;
/// The most tokens a picture is read at.
pub const MAX_TOKENS: u32 = 4784;
/// A sheet's tokens at most unless asked otherwise: twelve 16:9 frames at 360 px.
pub const BUDGET: u32 = 1300;
/// `detail: "fine"`: twice the pixels, for small text, plates and faces.
pub const FINE_BUDGET: u32 = 2600;

/// A sheet of `count` pictures' tokens: 160 and 140 a picture, up to
/// `BUDGET` (twice that `fine`). A few frames aren't blown up to fill the
/// whole budget: two review frames cost 400 tokens, not 1,300 (measured on
/// the agent's 3,008 sheets to Nov 2: 29 % fewer tokens a look than before).
pub fn budget_for(count: usize, fine: bool) -> u32 {
    let count = u32::try_from(count).unwrap_or(u32::MAX);
    let plain = count.saturating_mul(140).saturating_add(160).min(BUDGET);
    if fine {
        (plain * 2).min(FINE_BUDGET)
    } else {
        plain
    }
}
const GUTTER: u32 = 4;
const RULER: u32 = 16;

/// What a picture costs a model: `⌈w/28⌉ × ⌈h/28⌉` patches, after the
/// model's own downscale to 2576 px and 4784 tokens.
pub fn tokens(width: u32, height: u32) -> u32 {
    let (mut w, mut h) = (f64::from(width.max(1)), f64::from(height.max(1)));
    let fit = (f64::from(LONG_EDGE) / w.max(h)).min(1.0);
    w *= fit;
    h *= fit;
    let count = |w: f64, h: f64| ((w / 28.0).ceil() * (h / 28.0).ceil()) as u32;
    let first = count(w, h);
    if first <= MAX_TOKENS {
        return first;
    }
    let shrink = (f64::from(MAX_TOKENS) / f64::from(first)).sqrt();
    count(w * shrink, h * shrink)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SheetPlan {
    pub columns: u32,
    pub rows: u32,
    /// The box each picture is fitted into (aspect kept, never enlarged).
    pub cell_width: u32,
    pub cell_height: u32,
    /// A row's ruler above its cells (0: none).
    pub ruler: u32,
    /// A cell's slot (cell, gutter and ruler): whole patches.
    pub slot_width: u32,
    pub slot_height: u32,
    pub width: u32,
    pub height: u32,
    pub tokens: u32,
}

/// The grid for `count` pictures of `source`'s shape within `budget` tokens
/// (`columns` fixes how many across): the one drawing each picture largest,
/// then with fewer blank cells, then wider. Over budget only when even the
/// smallest cells (one patch) are.
pub fn plan(
    count: usize,
    source: (u32, u32),
    budget: u32,
    columns: Option<u32>,
    ruler: bool,
) -> SheetPlan {
    let count = u32::try_from(count).unwrap_or(u32::MAX).clamp(1, 256);
    let budget = budget.clamp(16, MAX_TOKENS);
    let (sw, sh) = (f64::from(source.0.max(1)), f64::from(source.1.max(1)));
    let ruler = if ruler { RULER } else { 0 };
    let across = match columns {
        Some(given) => {
            let given = given.clamp(1, count);
            given..=given
        }
        None => 1..=count,
    };
    let at = |cols: u32, k: u32| -> SheetPlan {
        let rows = count.div_ceil(cols);
        let slot_width = k * PATCH;
        let cell_width = slot_width.saturating_sub(GUTTER).max(1);
        let cell_height = ((f64::from(cell_width) * sh / sw).round() as u32).max(1);
        let slot_height = (cell_height + GUTTER + ruler).div_ceil(PATCH) * PATCH;
        let (width, height) = (cols * slot_width, rows * slot_height);
        SheetPlan {
            columns: cols,
            rows,
            cell_width,
            cell_height,
            ruler,
            slot_width,
            slot_height,
            width,
            height,
            tokens: (width / PATCH) * (height / PATCH),
        }
    };
    let mut best: Option<SheetPlan> = None;
    let mut cheapest: Option<SheetPlan> = None;
    for cols in across {
        // Never wider than the picture itself (plus its gutter).
        let widest = (LONG_EDGE / PATCH / cols)
            .min((source.0.max(1) + GUTTER) / PATCH)
            .max(1);
        for k in (1..=widest).rev() {
            let candidate = at(cols, k);
            if k == 1 && cheapest.is_none_or(|c| candidate.tokens < c.tokens) {
                cheapest = Some(candidate);
            }
            if candidate.tokens <= budget && candidate.height <= LONG_EDGE {
                if best.is_none_or(|b| better(&candidate, &b, count)) {
                    best = Some(candidate);
                }
                break;
            }
        }
    }
    best.or(cheapest).unwrap_or_else(|| at(1, 1))
}

fn better(a: &SheetPlan, b: &SheetPlan, count: u32) -> bool {
    let fit = |p: &SheetPlan| u64::from(p.cell_width) * u64::from(p.cell_height);
    if fit(a) != fit(b) {
        return fit(a) > fit(b);
    }
    let blanks = |p: &SheetPlan| p.columns * p.rows - count;
    if blanks(a) != blanks(b) {
        return blanks(a) < blanks(b);
    }
    a.columns > b.columns
}

/// Seconds as a label: one decimal, two where the pictures are under 0.2 s apart.
pub fn time_label(seconds: f64, fine: bool) -> String {
    if fine {
        format!("{seconds:.2}s")
    } else {
        format!("{seconds:.1}s")
    }
}

fn fine_times(times: &[f64]) -> bool {
    let mut sorted: Vec<f64> = times.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted.windows(2).any(|pair| match pair {
        [a, b] => b - a > 1e-6 && b - a < 0.2,
        _ => false,
    })
}

/// Draws `images` into `plan`'s grid, left to right then down, each with its
/// label (and, given `times`, its time after it); with `times`, a ruler above
/// each row. Pictures of another shape are fitted and centred in their cell.
pub fn compose(
    images: &[RgbaImage],
    labels: &[String],
    times: Option<&[f64]>,
    plan: &SheetPlan,
) -> RgbaImage {
    let (w, h) = (plan.width.max(1), plan.height.max(1));
    let mut sheet = RgbaImage {
        width: w,
        height: h,
        pixels: [18_u8, 18, 18, 255].repeat((w * h) as usize),
    };
    let fine = times.is_some_and(fine_times);
    let label_px = (plan.cell_height as f32 / 13.0).clamp(11.0, 20.0);
    for (index, image) in images.iter().enumerate() {
        let index = index as u32;
        let (column, row) = (index % plan.columns, index / plan.columns);
        let (x0, y0) = (
            column * plan.slot_width,
            row * plan.slot_height + plan.ruler,
        );
        let fit = fit_in(image, plan.cell_width, plan.cell_height);
        let (dx, dy) = (
            x0 + (plan.cell_width - fit.width.min(plan.cell_width)) / 2,
            y0 + (plan.cell_height - fit.height.min(plan.cell_height)) / 2,
        );
        blit(&mut sheet, &fit, dx, dy);
        let mut text = labels
            .get(index as usize)
            .cloned()
            .unwrap_or_else(|| (index + 1).to_string());
        if let Some(time) = times.and_then(|all| all.get(index as usize)) {
            text = format!("{text} · {}", time_label(*time, fine));
        }
        let pad = (label_px / 4.0).round() as u32;
        let (tw, th) = measure(&text, label_px);
        fill(
            &mut sheet,
            (dx, dy),
            (tw + 2 * pad, th + 2 * pad),
            [0, 0, 0],
            200,
        );
        draw_text(
            &mut sheet,
            &text,
            label_px,
            dx + pad,
            dy + pad,
            [255, 255, 255],
        );
    }
    if let Some(times) = times.filter(|_| plan.ruler > 0) {
        for row in 0..plan.rows {
            let first = (row * plan.columns) as usize;
            let last = (first + plan.columns as usize).min(images.len());
            let (Some(from), Some(to)) = (times.get(first), times.get(last.saturating_sub(1)))
            else {
                continue;
            };
            let y = row * plan.slot_height;
            fill(&mut sheet, (0, y), (w, plan.ruler - 2), [40, 40, 40], 255);
            for cell in 0..(last - first) as u32 {
                let x = cell * plan.slot_width + plan.cell_width / 2;
                fill(
                    &mut sheet,
                    (x, y + plan.ruler - 6),
                    (1, 4),
                    [200, 200, 200],
                    255,
                );
            }
            let span = if last - first > 1 {
                format!(
                    "{}–{} · {} → {}",
                    first + 1,
                    last,
                    time_label(*from, fine),
                    time_label(*to, fine)
                )
            } else {
                format!("{} · {}", first + 1, time_label(*from, fine))
            };
            draw_text(&mut sheet, &span, 11.0, 4, y + 1, [210, 210, 210]);
        }
    }
    sheet
}

/// `image` scaled down to fit `width` × `height`, its shape kept.
fn fit_in(image: &RgbaImage, width: u32, height: u32) -> RgbaImage {
    let scale = (f64::from(width) / f64::from(image.width.max(1)))
        .min(f64::from(height) / f64::from(image.height.max(1)));
    if scale >= 1.0 {
        return RgbaImage {
            width: image.width,
            height: image.height,
            pixels: image.pixels.clone(),
        };
    }
    let longest = image.width.max(image.height);
    let side = ((f64::from(longest) * scale).floor() as u32).max(1);
    let mut out = downscale(image, side);
    // Rounding can leave a pixel over: crop it.
    if out.width > width || out.height > height {
        out = crop(&out, out.width.min(width), out.height.min(height));
    }
    out
}

fn crop(image: &RgbaImage, width: u32, height: u32) -> RgbaImage {
    let mut pixels = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        let start = (y * image.width * 4) as usize;
        if let Some(row) = image.pixels.get(start..start + (width * 4) as usize) {
            pixels.extend_from_slice(row);
        }
    }
    RgbaImage {
        width,
        height,
        pixels,
    }
}

fn blit(sheet: &mut RgbaImage, image: &RgbaImage, x: u32, y: u32) {
    let width = image.width.min(sheet.width.saturating_sub(x));
    for row in 0..image.height.min(sheet.height.saturating_sub(y)) {
        let from = (row * image.width * 4) as usize;
        let to = (((y + row) * sheet.width + x) * 4) as usize;
        let n = (width * 4) as usize;
        if let (Some(dst), Some(src)) = (
            sheet.pixels.get_mut(to..to + n),
            image.pixels.get(from..from + n),
        ) {
            dst.copy_from_slice(src);
        }
    }
}

/// Mixes `rgb` over the pixel at byte `i` by `a` of 255.
fn blend(sheet: &mut RgbaImage, i: usize, rgb: [u8; 3], a: u32) {
    if let Some(pixel) = sheet.pixels.get_mut(i..i + 3) {
        for (old, value) in pixel.iter_mut().zip(rgb) {
            *old = ((u32::from(value) * a + u32::from(*old) * (255 - a)) / 255) as u8;
        }
    }
}

fn fill(sheet: &mut RgbaImage, at: (u32, u32), size: (u32, u32), rgb: [u8; 3], alpha: u8) {
    let a = u32::from(alpha);
    for y in at.1..(at.1 + size.1).min(sheet.height) {
        for x in at.0..(at.0 + size.0).min(sheet.width) {
            let i = ((y * sheet.width + x) * 4) as usize;
            blend(sheet, i, rgb, a);
            if let Some(opaque) = sheet.pixels.get_mut(i + 3) {
                *opaque = 255;
            }
        }
    }
}

fn font() -> Option<&'static fontdue::Font> {
    static FONT: OnceLock<Option<fontdue::Font>> = OnceLock::new();
    FONT.get_or_init(|| {
        let bytes = edit_render::text::bundled_font_bytes("GeistMono-SemiBold.ttf")?;
        fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default()).ok()
    })
    .as_ref()
}

/// The text's advance and its line's height (ascent, no descent), px.
fn measure(text: &str, px: f32) -> (u32, u32) {
    let Some(font) = font() else {
        return (0, 0);
    };
    let advance: f32 = text
        .chars()
        .map(|ch| font.metrics(ch, px).advance_width)
        .sum();
    let ascent = font
        .horizontal_line_metrics(px)
        .map_or(px, |line| line.ascent);
    (advance.ceil() as u32, ascent.ceil() as u32)
}

/// Draws one line of text with its top at `y`.
fn draw_text(sheet: &mut RgbaImage, text: &str, px: f32, x: u32, y: u32, rgb: [u8; 3]) {
    let Some(font) = font() else {
        return;
    };
    let ascent = font
        .horizontal_line_metrics(px)
        .map_or(px, |line| line.ascent);
    let baseline = y as f32 + ascent;
    let mut pen = x as f32;
    for ch in text.chars() {
        let (metrics, coverage) = font.rasterize(ch, px);
        let left = (pen + metrics.xmin as f32).round() as i64;
        let top = (baseline - metrics.height as f32 - metrics.ymin as f32).round() as i64;
        for gy in 0..metrics.height {
            for gx in 0..metrics.width {
                let (sx, sy) = (left + gx as i64, top + gy as i64);
                if sx < 0 || sy < 0 || sx >= i64::from(sheet.width) || sy >= i64::from(sheet.height)
                {
                    continue;
                }
                let a = u32::from(coverage.get(gy * metrics.width + gx).copied().unwrap_or(0));
                if a == 0 {
                    continue;
                }
                let i = ((sy as u32 * sheet.width + sx as u32) * 4) as usize;
                blend(sheet, i, rgb, a);
            }
        }
        pen += metrics.advance_width;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_follow_the_patch_rule() {
        assert_eq!(tokens(1000, 1000), 1296);
        assert_eq!(tokens(1092, 1092), 1521);
        assert_eq!(tokens(1920, 1080), 2691);
        assert_eq!(tokens(200, 200), 64);
        // Over the long edge: read at 2576 × 1449.
        assert_eq!(tokens(3840, 2160), 4784);
    }

    #[test]
    fn a_sheet_is_whole_patches_and_within_budget() {
        for count in 1..=36 {
            for source in [(1920, 1080), (1080, 1920), (640, 480), (320, 240)] {
                for budget in [BUDGET, FINE_BUDGET, 600] {
                    let p = plan(count, source, budget, None, true);
                    assert_eq!(p.width % PATCH, 0, "{count} {source:?}");
                    assert_eq!(p.height % PATCH, 0);
                    assert_eq!(p.tokens, tokens(p.width, p.height));
                    assert!(p.columns * p.rows >= count as u32);
                    assert!(p.width <= LONG_EDGE && p.height <= LONG_EDGE);
                    if p.slot_width > PATCH {
                        assert!(p.tokens <= budget, "{count} {source:?} {budget}: {p:?}");
                    }
                    assert!(p.cell_width <= source.0 && p.cell_height <= source.1);
                }
            }
        }
    }

    #[test]
    fn twelve_frames_keep_todays_cells() {
        // The old sheet: 4 across, 360 px cells, ~1,000–1,250 tokens.
        let p = plan(12, (1920, 1080), BUDGET, None, true);
        assert!(p.cell_width >= 330, "{p:?}");
        assert!(p.tokens <= BUDGET);
        let fine = plan(12, (1920, 1080), FINE_BUDGET, None, true);
        assert!(fine.cell_width > p.cell_width + 100, "{fine:?}");
        // Asked for columns: kept.
        assert_eq!(plan(12, (1920, 1080), BUDGET, Some(6), true).columns, 6);
    }

    #[test]
    fn the_budget_grows_with_the_frames() {
        assert_eq!(budget_for(1, false), 300);
        assert_eq!(budget_for(2, false), 440);
        assert_eq!(budget_for(12, false), BUDGET);
        assert_eq!(budget_for(2, true), 880);
        assert_eq!(budget_for(24, true), FINE_BUDGET);
        let two = plan(2, (1920, 1080), budget_for(2, false), None, true);
        assert!(two.tokens <= 440 && two.cell_width >= 440, "{two:?}");
    }

    #[test]
    fn a_few_frames_are_drawn_large() {
        let p = plan(2, (1920, 1080), BUDGET, None, false);
        assert!(p.cell_width >= 600, "{p:?}");
    }

    #[test]
    fn compose_labels_cells_and_rules_rows() {
        let images: Vec<RgbaImage> = (0..5)
            .map(|_| RgbaImage {
                width: 64,
                height: 36,
                pixels: [90_u8, 120, 200, 255].repeat(64 * 36),
            })
            .collect();
        let p = plan(5, (64, 36), 200, Some(3), true);
        let labels: Vec<String> = (1..=5).map(|n| n.to_string()).collect();
        let sheet = compose(&images, &labels, Some(&[0.0, 0.5, 1.0, 1.5, 2.0]), &p);
        assert_eq!((sheet.width, sheet.height), (p.width, p.height));
        // The label's box darkened the first cell's corner; its middle is the picture.
        let at = |x: u32, y: u32| {
            let i = ((y * sheet.width + x) * 4) as usize;
            [sheet.pixels[i], sheet.pixels[i + 1], sheet.pixels[i + 2]]
        };
        let (cx, cy) = (p.cell_width / 2, p.ruler + p.cell_height - 3);
        assert_eq!(at(cx, cy), [90, 120, 200]);
        assert!(at(1, p.ruler + 1)[2] < 100);
        // The ruler strip is drawn above each row.
        assert_eq!(at(p.width - 2, 2), [40, 40, 40]);
        assert!(font().is_some());
    }
}
