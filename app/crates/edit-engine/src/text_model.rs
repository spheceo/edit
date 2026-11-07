//! Words on screen off macOS: PaddleOCR (Apache 2.0) where a Mac asks Vision
//! (`mac_media::text`), run by tract on the CPU like the faces
//! (`face_model`). Two models in the binary: PP-OCRv3's text finder (2.4 MB),
//! which marks where text is, and PP-OCRv5's English reader (7.8 MB), which
//! reads each line it found. The same answer as Vision's: each line's box as
//! shares of the picture from its top left, how sure, and its words.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use tract_onnx::prelude::*;

const FINDER: &[u8] = include_bytes!("../models/ppocr_v3_det.onnx");
const READER: &[u8] = include_bytes!("../models/ppocr_v5_rec_en.onnx");
/// The reader's characters, one a line (its class n+1; 0 is CTC's blank, the last a space).
const CHARACTERS: &str = include_str!("../models/ppocr_v5_rec_en_dict.txt");

/// A pixel is text above this on the finder's map (PaddleOCR's DB threshold).
const TEXT: f32 = 0.3;
/// A found region is kept when its mean is above this (PaddleOCR's box threshold).
const REGION: f32 = 0.6;
/// How far a region is grown back out (PaddleOCR's unclip ratio).
const GROW: f32 = 1.5;
/// The reader's line height.
const LINE: usize = 48;

type Plan = Arc<TypedRunnableModel>;

/// Plans by model and input size: a frame size for the finder, a line width for the reader.
/// Which model (the finder?) at which height and width.
type Key = (bool, usize, usize);
static PLANS: Mutex<Option<HashMap<Key, Plan>>> = Mutex::new(None);

fn plan(finder: bool, height: usize, width: usize) -> Result<Plan, String> {
    let key = (finder, height, width);
    if let Some(plan) = PLANS.lock().get_or_insert_with(HashMap::new).get(&key) {
        return Ok(plan.clone());
    }
    let made = tract_onnx::onnx()
        .with_ignore_output_shapes(true)
        .with_ignore_value_info(true)
        .model_for_read(&mut std::io::Cursor::new(if finder {
            FINDER
        } else {
            READER
        }))
        .and_then(|model| model.with_input_fact(0, f32::fact([1, 3, height, width]).into()))
        .and_then(|model| model.into_optimized())
        .and_then(|model| model.into_runnable())
        .map_err(|error| format!("the text model: {error}"))?;
    PLANS
        .lock()
        .get_or_insert_with(HashMap::new)
        .insert(key, made.clone());
    Ok(made)
}

fn characters() -> &'static [String] {
    static LIST: OnceLock<Vec<String>> = OnceLock::new();
    LIST.get_or_init(|| CHARACTERS.lines().map(str::to_owned).collect())
}

/// Runs `plan` on planar `input` (1×3×`height`×`width`), its first output flat with its shape.
fn run(
    plan: &Plan,
    input: Vec<f32>,
    height: usize,
    width: usize,
) -> Result<(Vec<f32>, Vec<usize>), String> {
    let tensor: Tensor = tract_ndarray::Array4::from_shape_vec((1, 3, height, width), input)
        .map_err(|error| error.to_string())?
        .into();
    let outputs = plan
        .run(tvec!(tensor.into()))
        .map_err(|error| format!("the text model: {error}"))?;
    let output = outputs.first().ok_or("the text model gave no output")?;
    let shape = output.shape().to_vec();
    let values = output
        .to_plain_array_view::<f32>()
        .map_err(|error| error.to_string())?
        .iter()
        .copied()
        .collect();
    Ok((values, shape))
}

/// The lines of text in a `width`×`height` BGRA picture: box (x0, y0, x1, y1
/// as shares), how sure, and the words, as `mac_media::text` answers.
pub fn text(bgra: &[u8], width: u32, height: u32) -> Result<Vec<([f32; 4], f32, String)>, String> {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 || bgra.len() < w * h * 4 {
        return Err("text picture doesn't match its size".to_owned());
    }
    // The finder: sides padded to multiples of 32 (black), BGR planes
    // normalised as PaddleOCR does (its ImageNet mean and spread, applied to
    // the planes in the order its OpenCV pictures have them).
    let (padded_w, padded_h) = (w.div_ceil(32) * 32, h.div_ceil(32) * 32);
    let plane = padded_w * padded_h;
    const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
    const SPREAD: [f32; 3] = [0.229, 0.224, 0.225];
    let mut input: Vec<f32> = MEAN
        .iter()
        .zip(&SPREAD)
        .flat_map(|(mean, spread)| std::iter::repeat_n(-mean / spread, plane))
        .collect();
    for (y, row) in bgra.chunks_exact(w * 4).take(h).enumerate() {
        for (x, pixel) in row.as_chunks::<4>().0.iter().enumerate() {
            for (channel, (value, (mean, spread))) in
                pixel.iter().zip(MEAN.iter().zip(&SPREAD)).enumerate()
            {
                if let Some(slot) = input.get_mut(channel * plane + y * padded_w + x) {
                    *slot = (f32::from(*value) / 255.0 - mean) / spread;
                }
            }
        }
    }
    let (map, _) = run(&plan(true, padded_h, padded_w)?, input, padded_h, padded_w)?;
    let mut lines = Vec::new();
    for [x0, y0, x1, y1] in regions(&map, padded_w, w, h) {
        let Some((words, sure)) = read(bgra, w, [x0, y0, x1, y1])? else {
            continue;
        };
        lines.push((
            [
                x0 as f32 / w as f32,
                y0 as f32 / h as f32,
                x1 as f32 / w as f32,
                y1 as f32 / h as f32,
            ],
            sure,
            words,
        ));
    }
    Ok(lines)
}

/// The finder's text regions in a `stride`-wide map: each run of text
/// pixels joined to its neighbours, kept when sure enough on the whole, its
/// box grown back out as PaddleOCR's DB post-processing does, kept inside
/// the `width`×`height` picture.
fn regions(map: &[f32], stride: usize, width: usize, height: usize) -> Vec<[usize; 4]> {
    let mut seen = vec![false; map.len()];
    let mut out = Vec::new();
    let mut queue = Vec::new();
    for start in 0..map.len() {
        if seen.get(start).copied().unwrap_or(true)
            || map.get(start).copied().unwrap_or(0.0) <= TEXT
        {
            continue;
        }
        let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
        let (mut sum, mut count) = (0.0f32, 0usize);
        queue.clear();
        queue.push(start);
        if let Some(mark) = seen.get_mut(start) {
            *mark = true;
        }
        while let Some(at) = queue.pop() {
            let (x, y) = (at % stride, at / stride);
            sum += map.get(at).copied().unwrap_or(0.0);
            count += 1;
            (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
            let neighbours = [
                (x > 0).then(|| at - 1),
                (x + 1 < stride).then_some(at + 1),
                (y > 0).then(|| at - stride),
                Some(at + stride),
            ];
            for next in neighbours.into_iter().flatten() {
                let Some(mark) = seen.get_mut(next) else {
                    continue;
                };
                if !*mark && map.get(next).copied().unwrap_or(0.0) > TEXT {
                    *mark = true;
                    queue.push(next);
                }
            }
        }
        let (across, down) = ((x1 - x0 + 1) as f32, (y1 - y0 + 1) as f32);
        if count < 9 || across.min(down) < 3.0 || sum / (count as f32) < REGION {
            continue;
        }
        // Grown by area × ratio ÷ perimeter on every side (the finder shrinks text to its core).
        let grow = (across * down * GROW / (2.0 * (across + down))).round() as usize;
        let box_ = [
            x0.saturating_sub(grow),
            y0.saturating_sub(grow),
            (x1 + 1 + grow).min(width),
            (y1 + 1 + grow).min(height),
        ];
        if box_[2] > box_[0] + 2 && box_[3] > box_[1] + 2 {
            out.push(box_);
        }
    }
    // Top to bottom, then left to right, as one reads.
    out.sort_by_key(|[x0, y0, _, _]| (*y0 / 8, *x0));
    out
}

/// One line's words and how sure: its box cut out of the `width`-wide BGRA
/// picture, scaled to the reader's height (BGR, −1 to 1), read by CTC (repeats
/// and blanks dropped). None when nothing is read.
fn read(
    bgra: &[u8],
    width: usize,
    [x0, y0, x1, y1]: [usize; 4],
) -> Result<Option<(String, f32)>, String> {
    let (across, down) = (x1 - x0, y1 - y0);
    // Its width at the reader's height, in steps of 64 so plans are shared, up to a whole frame.
    let scaled = ((across as f32 * LINE as f32 / down as f32).round() as usize).clamp(16, 1280);
    let padded = scaled.div_ceil(64) * 64;
    let plane = LINE * padded;
    let mut input = vec![0f32; 3 * plane];
    for y in 0..LINE {
        let source_y = (y0 + y * down / LINE).min(y1 - 1);
        for x in 0..scaled {
            let source_x = (x0 + x * across / scaled).min(x1 - 1);
            let at = (source_y * width + source_x) * 4;
            let Some(pixel) = bgra.get(at..at + 3) else {
                continue;
            };
            for (channel, value) in pixel.iter().enumerate() {
                if let Some(slot) = input.get_mut(channel * plane + y * padded + x) {
                    *slot = f32::from(*value) / 127.5 - 1.0;
                }
            }
        }
    }
    let (scores, shape) = run(&plan(false, LINE, padded)?, input, LINE, padded)?;
    let classes = shape
        .get(2)
        .copied()
        .ok_or("the reader's output has no classes")?;
    let list = characters();
    let (mut words, mut sure, mut kept, mut last) = (String::new(), 0.0f32, 0usize, 0usize);
    for step in scores.chunks_exact(classes.max(1)) {
        let Some((best, score)) = step
            .iter()
            .copied()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(&b.1))
        else {
            continue;
        };
        if best != 0 && best != last {
            match list.get(best - 1) {
                Some(character) => words.push_str(character),
                None => words.push(' '),
            }
            sure += score;
            kept += 1;
        }
        last = best;
    }
    let words = words.trim().to_owned();
    if kept == 0 || words.is_empty() {
        return Ok(None);
    }
    Ok(Some((words, sure / kept as f32)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_frame_has_no_words() {
        let gray = vec![128u8; 320 * 180 * 4];
        assert!(text(&gray, 320, 180).unwrap().is_empty());
    }

    #[test]
    fn a_region_of_text_pixels_is_one_box_grown_back_out() {
        // A 64×16 map with a 20×4 run of text at (10, 6); a lone stray pixel is no region.
        let (stride, rows) = (64, 16);
        let mut map = vec![0.0f32; stride * rows];
        for y in 6..10 {
            for x in 10..30 {
                map[y * stride + x] = 0.9;
            }
        }
        map[2 * stride + 50] = 0.9;
        let found = regions(&map, stride, 60, 16);
        // Grown by 20·4·1.5 / (2·24) = 2.5 → 3 px on each side.
        assert_eq!(found, vec![[7, 3, 33, 13]]);
    }
}
