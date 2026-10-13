//! CPU text rasterization shared by preview and export so glyphs land on
//! identical pixels in both.

use std::collections::HashMap;

use edit_core::{glyph_reveal, Rgba, TextAnimation};
use fontdue::{Font, FontSettings, Metrics};

struct Face {
    family: String,
    weight: u16,
    font: Font,
}

#[derive(Default)]
pub struct FontBook {
    faces: Vec<Face>,
}

impl FontBook {
    pub fn add(&mut self, family: &str, weight: u16, bytes: &[u8]) -> Result<(), String> {
        let font = Font::from_bytes(bytes, FontSettings::default()).map_err(str::to_owned)?;
        self.faces
            .retain(|face| !(face.family == family && face.weight == weight));
        self.faces.push(Face {
            family: family.to_owned(),
            weight,
            font,
        });
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.faces.is_empty()
    }

    /// Closest weight in the requested family, else the closest weight overall.
    fn pick(&self, family: &str, weight: u16) -> Option<usize> {
        let distance = |face: &Face| (i32::from(face.weight) - i32::from(weight)).abs();
        let in_family = self
            .faces
            .iter()
            .enumerate()
            .filter(|(_, face)| face.family.eq_ignore_ascii_case(family))
            .min_by_key(|(_, face)| distance(face));
        in_family
            .or_else(|| {
                self.faces
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, face)| distance(face))
            })
            .map(|(index, _)| index)
    }
}

/// Fonts that ship with Edit (Geist and Montserrat, both SIL OFL 1.1).
pub const BUNDLED_FONTS: &[(&str, u16, &str)] = &[
    ("Montserrat", 600, "Montserrat-SemiBold.ttf"),
    ("Geist", 400, "Geist-Regular.ttf"),
    ("Geist", 500, "Geist-Medium.ttf"),
    ("Geist", 600, "Geist-SemiBold.ttf"),
    ("Geist", 700, "Geist-Bold.ttf"),
    ("Geist", 900, "Geist-Black.ttf"),
];

#[cfg(feature = "bundled-fonts")]
pub fn bundled_font_bytes(file: &str) -> Option<&'static [u8]> {
    Some(match file {
        "Geist-Regular.ttf" => include_bytes!("../fonts/Geist-Regular.ttf"),
        "Geist-Medium.ttf" => include_bytes!("../fonts/Geist-Medium.ttf"),
        "Geist-SemiBold.ttf" => include_bytes!("../fonts/Geist-SemiBold.ttf"),
        "Geist-Bold.ttf" => include_bytes!("../fonts/Geist-Bold.ttf"),
        "Geist-Black.ttf" => include_bytes!("../fonts/Geist-Black.ttf"),
        "Montserrat-SemiBold.ttf" => include_bytes!("../fonts/Montserrat-SemiBold.ttf"),
        _ => return None,
    })
}

/// What to draw: style values already scaled to output pixels.
pub struct TextSpec<'a> {
    pub text: &'a str,
    pub family: &'a str,
    pub weight: u16,
    pub px: f32,
    pub color: Rgba,
    pub tracking: f32,
    pub line_height: f32,
    pub animation: &'a TextAnimation,
    pub local_frame: f32,
    /// Draw only this many glyphs (not counting whitespace); the rest keep
    /// their place. `None`: all.
    pub shown_glyphs: Option<usize>,
    /// Transparent border so glows and animated glyphs never clip.
    pub pad: f32,
    /// Wrap at this width (output pixels); `None` breaks only at newlines.
    pub max_width: Option<f32>,
    /// A small line above the text in its own colour (who's speaking).
    pub label: Option<LabelSpec<'a>>,
}

pub struct LabelSpec<'a> {
    pub text: &'a str,
    pub px: f32,
    pub color: Rgba,
    /// Space between the text's line box and the label's (output pixels).
    pub above: f32,
}

/// Premultiplied RGBA8.
pub struct TextImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
    /// The laid-out lines' box (widest line × line height × lines), centred in the image.
    pub block: [f32; 2],
    /// The label's line box (width, height) and how far its centre sits above the image's.
    pub label: Option<[f32; 3]>,
}

#[derive(Default)]
pub struct GlyphCache {
    glyphs: HashMap<(usize, char, u32), (Metrics, Vec<u8>)>,
}

impl GlyphCache {
    fn glyph(&mut self, book: &FontBook, face: usize, ch: char, px: f32) -> &(Metrics, Vec<u8>) {
        let key = (face, ch, (px * 4.0).round() as u32);
        if self.glyphs.len() > 4096 {
            self.glyphs.clear();
        }
        self.glyphs
            .entry(key)
            .or_insert_with(|| book.faces[face].font.rasterize(ch, key.2 as f32 / 4.0))
    }
}

struct Placed {
    ch: char,
    x: f32,
    baseline: f32,
    index: usize,
}

pub const MAX_TEXT_DIMENSION: u32 = 8192;

pub fn rasterize(book: &FontBook, cache: &mut GlyphCache, spec: &TextSpec) -> Option<TextImage> {
    let face = book.pick(spec.family, spec.weight)?;
    let font = &book.faces[face].font;
    let px = spec.px.clamp(1.0, 2000.0);
    let line_metrics = font.horizontal_line_metrics(px)?;
    let line_advance = px * spec.line_height.max(0.1);

    // Wrap to the width (greedy, by words; an overlong word breaks by letters).
    let measure = |text: &str, px: f32| -> f32 {
        let mut pen = 0.0_f32;
        let mut previous: Option<char> = None;
        for ch in text.chars() {
            if let Some(prev) = previous {
                pen += font.horizontal_kern(prev, ch, px).unwrap_or(0.0);
            }
            pen += font.metrics(ch, px).advance_width + spec.tracking;
            previous = Some(ch);
        }
        if previous.is_some() {
            pen - spec.tracking
        } else {
            0.0
        }
    };
    let advance = |text: &str| measure(text, px);
    let mut wrapped: Vec<String> = Vec::new();
    for paragraph in spec.text.split('\n') {
        let Some(max) = spec.max_width.filter(|max| *max > px) else {
            wrapped.push(paragraph.to_owned());
            continue;
        };
        let mut line = String::new();
        for word in paragraph.split(' ') {
            let candidate = if line.is_empty() {
                word.to_owned()
            } else {
                format!("{line} {word}")
            };
            if advance(&candidate) <= max || line.is_empty() && advance(word) <= max {
                line = candidate;
                continue;
            }
            if !line.is_empty() {
                wrapped.push(std::mem::take(&mut line));
            }
            if advance(word) <= max {
                line = word.to_owned();
            } else {
                for ch in word.chars() {
                    let next = format!("{line}{ch}");
                    if advance(&next) > max && !line.is_empty() {
                        wrapped.push(std::mem::take(&mut line));
                        line.push(ch);
                    } else {
                        line = next;
                    }
                }
            }
        }
        wrapped.push(line);
    }

    // Lay out each line, then centre lines on the widest.
    let mut lines: Vec<(Vec<(char, f32)>, f32)> = Vec::new();
    for line in wrapped.iter().map(String::as_str) {
        let mut pen = 0.0_f32;
        let mut glyphs = Vec::new();
        let mut previous: Option<char> = None;
        for ch in line.chars() {
            if let Some(prev) = previous {
                pen += font.horizontal_kern(prev, ch, px).unwrap_or(0.0);
            }
            glyphs.push((ch, pen));
            pen += font.metrics(ch, px).advance_width + spec.tracking;
            previous = Some(ch);
        }
        let width = if glyphs.is_empty() {
            0.0
        } else {
            pen - spec.tracking
        };
        lines.push((glyphs, width.max(0.0)));
    }
    let block_width = lines.iter().map(|(_, width)| *width).fold(0.0, f32::max);
    let text_height =
        line_metrics.ascent - line_metrics.descent + line_advance * (lines.len() as f32 - 1.0);
    let pad = spec.pad.max(0.0).ceil();
    // The label sits centred above the lines; the image grows evenly so the lines stay centred.
    let label = spec
        .label
        .as_ref()
        .filter(|label| !label.text.trim().is_empty())
        .and_then(|label| {
            let px = label.px.clamp(1.0, 2000.0);
            let metrics = font.horizontal_line_metrics(px)?;
            let line = px * spec.line_height.max(0.1);
            let offset = line_advance * lines.len() as f32 / 2.0 + label.above + line / 2.0;
            Some((label, px, metrics, measure(label.text, px), line, offset))
        });
    let content_width = label
        .as_ref()
        .map_or(block_width, |label| block_width.max(label.3));
    let half_height = label.as_ref().map_or(text_height / 2.0, |label| {
        (text_height / 2.0).max(label.5 + label.4 / 2.0)
    });
    let width = ((content_width + 2.0 * pad).ceil() as u32).clamp(1, MAX_TEXT_DIMENSION);
    let height = ((half_height * 2.0 + 2.0 * pad).ceil() as u32).clamp(1, MAX_TEXT_DIMENSION);
    let top = pad + half_height - text_height / 2.0;

    let mut placed = Vec::new();
    let mut index = 0;
    for (row, (glyphs, line_width)) in lines.iter().enumerate() {
        let left = pad + (content_width - line_width) / 2.0;
        let baseline = top + line_metrics.ascent + line_advance * row as f32;
        for &(ch, x) in glyphs {
            placed.push(Placed {
                ch,
                x: left + x,
                baseline,
                index,
            });
            if !ch.is_whitespace() {
                index += 1;
            }
        }
    }

    let mut pixels = vec![0_u8; width as usize * height as usize * 4];
    let [r, g, b, a] = spec.color.0;
    let shown = spec.shown_glyphs.unwrap_or(usize::MAX);
    for glyph in placed
        .iter()
        .filter(|glyph| !glyph.ch.is_whitespace() && glyph.index < shown)
    {
        let (alpha, rise, scale) = glyph_reveal(spec.animation, spec.local_frame, glyph.index, px);
        let alpha = alpha * a;
        if alpha <= 0.0 || scale <= 0.0 {
            continue;
        }
        let (metrics, bitmap) = cache.glyph(book, face, glyph.ch, px);
        if metrics.width == 0 || metrics.height == 0 {
            continue;
        }
        let left = glyph.x + metrics.xmin as f32;
        let top = glyph.baseline - metrics.ymin as f32 - metrics.height as f32 + rise;
        blit(
            &mut pixels,
            width,
            height,
            bitmap,
            metrics.width,
            metrics.height,
            left,
            top,
            scale,
            [r, g, b],
            alpha,
        );
    }
    let tracking = spec.tracking;
    if let Some((label_spec, px, metrics, label_width, _, offset)) = &label {
        let centre = pad + half_height - offset;
        let baseline = centre + (metrics.ascent + metrics.descent) / 2.0;
        let mut pen = pad + (content_width - label_width) / 2.0;
        let mut previous: Option<char> = None;
        let [r, g, b, a] = label_spec.color.0;
        for ch in label_spec.text.chars() {
            if let Some(prev) = previous {
                pen += font.horizontal_kern(prev, ch, *px).unwrap_or(0.0);
            }
            let (glyph, bitmap) = cache.glyph(book, face, ch, *px);
            let advance = glyph.advance_width;
            if !ch.is_whitespace() && glyph.width > 0 && glyph.height > 0 {
                let left = pen + glyph.xmin as f32;
                let top = baseline - glyph.ymin as f32 - glyph.height as f32;
                blit(
                    &mut pixels,
                    width,
                    height,
                    bitmap,
                    glyph.width,
                    glyph.height,
                    left,
                    top,
                    1.0,
                    [r, g, b],
                    a,
                );
            }
            pen += advance + tracking;
            previous = Some(ch);
        }
    }
    Some(TextImage {
        width,
        height,
        pixels,
        block: [block_width, line_advance * lines.len() as f32],
        label: label.map(|(_, _, _, label_width, line, offset)| [label_width, line, offset]),
    })
}

/// Composite one coverage bitmap at (left, top), scaled about its centre, with bilinear sampling.
#[allow(clippy::too_many_arguments)]
fn blit(
    dst: &mut [u8],
    dst_w: u32,
    dst_h: u32,
    coverage: &[u8],
    src_w: usize,
    src_h: usize,
    left: f32,
    top: f32,
    scale: f32,
    rgb: [f32; 3],
    alpha: f32,
) {
    let cx = left + src_w as f32 / 2.0;
    let cy = top + src_h as f32 / 2.0;
    let half_w = src_w as f32 * scale / 2.0;
    let half_h = src_h as f32 * scale / 2.0;
    let x0 = (cx - half_w).floor().max(0.0) as i64;
    let y0 = (cy - half_h).floor().max(0.0) as i64;
    let x1 = ((cx + half_w).ceil() as i64).min(i64::from(dst_w));
    let y1 = ((cy + half_h).ceil() as i64).min(i64::from(dst_h));
    let sample = |x: i64, y: i64| -> f32 {
        if x < 0 || y < 0 || x >= src_w as i64 || y >= src_h as i64 {
            0.0
        } else {
            f32::from(coverage[y as usize * src_w + x as usize]) / 255.0
        }
    };
    for y in y0..y1 {
        for x in x0..x1 {
            // Pixel centre mapped back into the unscaled bitmap.
            let sx = (x as f32 + 0.5 - cx) / scale + src_w as f32 / 2.0 - 0.5;
            let sy = (y as f32 + 0.5 - cy) / scale + src_h as f32 / 2.0 - 0.5;
            let fx = sx.floor();
            let fy = sy.floor();
            let tx = sx - fx;
            let ty = sy - fy;
            let (ix, iy) = (fx as i64, fy as i64);
            let c = sample(ix, iy) * (1.0 - tx) * (1.0 - ty)
                + sample(ix + 1, iy) * tx * (1.0 - ty)
                + sample(ix, iy + 1) * (1.0 - tx) * ty
                + sample(ix + 1, iy + 1) * tx * ty;
            let src_a = c * alpha;
            if src_a <= 0.0 {
                continue;
            }
            let offset = (y as usize * dst_w as usize + x as usize) * 4;
            let px = &mut dst[offset..offset + 4];
            let keep = 1.0 - src_a;
            for channel in 0..3 {
                let value = rgb[channel] * src_a + f32::from(px[channel]) / 255.0 * keep;
                px[channel] = (value * 255.0).round().clamp(0.0, 255.0) as u8;
            }
            let value = src_a + f32::from(px[3]) / 255.0 * keep;
            px[3] = (value * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
}
