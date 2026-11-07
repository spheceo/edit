//! Faces off macOS: YuNet (OpenCV's face detector, 2023mar, MIT, Shiqi Yu;
//! 232 KB, in the binary) run by tract on the CPU, where a Mac asks Vision
//! (`mac_media::faces`). The same answer: each face's box as shares of the
//! picture from its top left, and how sure it is. ~15 ms a 640×360 frame on
//! one core (Nov 7, a Ryzen); faces.rs runs three stretches side by side.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use tract_onnx::prelude::*;

const MODEL: &[u8] = include_bytes!("../models/face_detection_yunet_2023mar.onnx");

/// The strides YuNet's three heads look at the picture with.
const STRIDES: [usize; 3] = [8, 16, 32];
/// Below this a face isn't kept even for NMS (faces.rs then keeps its own `SURE`).
const LEAST: f32 = 0.3;
/// Boxes overlapping more than this are one face (OpenCV's default).
const OVERLAP: f32 = 0.3;

/// A runnable plan, as tract hands it out (shared: an `Arc`).
type Plan = Arc<TypedRunnableModel>;

/// One plan per padded picture size: the footage of an edit comes in a few.
static PLANS: Mutex<Option<HashMap<(usize, usize), Plan>>> = Mutex::new(None);

fn plan(width: usize, height: usize) -> Result<Plan, String> {
    if let Some(plan) = PLANS
        .lock()
        .get_or_insert_with(HashMap::new)
        .get(&(width, height))
    {
        return Ok(plan.clone());
    }
    let made = tract_onnx::onnx()
        // Its file carries 640×640 shapes: worked out from the input instead.
        .with_ignore_output_shapes(true)
        .with_ignore_value_info(true)
        .model_for_read(&mut std::io::Cursor::new(MODEL))
        .and_then(|model| model.with_input_fact(0, f32::fact([1, 3, height, width]).into()))
        .and_then(|model| model.into_optimized())
        .and_then(|model| model.into_runnable())
        .map_err(|error| format!("the face model: {error}"))?;
    PLANS
        .lock()
        .get_or_insert_with(HashMap::new)
        .insert((width, height), made.clone());
    Ok(made)
}

/// The faces in a `width`×`height` BGRA picture: x0, y0, x1, y1 (shares of the
/// picture) and how sure, as `mac_media::faces` answers.
pub fn faces(bgra: &[u8], width: u32, height: u32) -> Result<Vec<[f32; 5]>, String> {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 || bgra.len() < w * h * 4 {
        return Err("a frame smaller than it says".to_owned());
    }
    // YuNet wants sides that its widest stride divides: padded with black
    // at the right and bottom, as OpenCV's FaceDetectorYN does.
    let (padded_w, padded_h) = (w.div_ceil(32) * 32, h.div_ceil(32) * 32);
    // Planar BGR, 0–255, as OpenCV's blob of an 8-bit BGR picture.
    let plane = padded_w * padded_h;
    let mut input = vec![0f32; 3 * plane];
    for (y, row) in bgra.chunks_exact(w * 4).take(h).enumerate() {
        for (x, pixel) in row.as_chunks::<4>().0.iter().enumerate() {
            let at = y * padded_w + x;
            for (channel, value) in pixel.iter().take(3).enumerate() {
                if let Some(slot) = input.get_mut(channel * plane + at) {
                    *slot = f32::from(*value);
                }
            }
        }
    }
    let tensor: Tensor = tract_ndarray::Array4::from_shape_vec((1, 3, padded_h, padded_w), input)
        .map_err(|error| error.to_string())?
        .into();
    let outputs = plan(padded_w, padded_h)?
        .run(tvec!(tensor.into()))
        .map_err(|error| format!("the face model: {error}"))?;
    let read = |index: usize| -> Result<Vec<f32>, String> {
        let output = outputs
            .get(index)
            .ok_or("the face model gave fewer outputs")?;
        Ok(output
            .to_plain_array_view::<f32>()
            .map_err(|error| error.to_string())?
            .iter()
            .copied()
            .collect())
    };
    let mut heads = Vec::with_capacity(3);
    for (at, stride) in STRIDES.iter().enumerate() {
        heads.push(Head {
            stride: *stride,
            columns: padded_w / stride,
            cls: read(at)?,
            obj: read(3 + at)?,
            bbox: read(6 + at)?,
        });
    }
    Ok(decode(&heads, w as f32, h as f32))
}

/// One of YuNet's heads: per cell, a class and an objectness score and a box.
struct Head {
    stride: usize,
    columns: usize,
    cls: Vec<f32>,
    obj: Vec<f32>,
    bbox: Vec<f32>,
}

/// The heads' cells as faces (score √(cls·obj), the box from the cell's
/// centre, OpenCV's decoding), overlapping ones merged, as shares of the
/// `width`×`height` picture.
fn decode(heads: &[Head], width: f32, height: f32) -> Vec<[f32; 5]> {
    let mut found: Vec<[f32; 5]> = Vec::new();
    for head in heads {
        let stride = head.stride as f32;
        for (cell, (cls, obj)) in head.cls.iter().zip(&head.obj).enumerate() {
            let score = (cls.clamp(0.0, 1.0) * obj.clamp(0.0, 1.0)).sqrt();
            if score < LEAST {
                continue;
            }
            let Some([dx, dy, dw, dh]) = head
                .bbox
                .get(cell * 4..cell * 4 + 4)
                .and_then(|values| <[f32; 4]>::try_from(values).ok())
            else {
                continue;
            };
            let (column, row) = ((cell % head.columns) as f32, (cell / head.columns) as f32);
            let (cx, cy) = ((column + dx) * stride, (row + dy) * stride);
            let (bw, bh) = (dw.exp() * stride, dh.exp() * stride);
            found.push([
                cx - bw / 2.0,
                cy - bh / 2.0,
                cx + bw / 2.0,
                cy + bh / 2.0,
                score,
            ]);
        }
    }
    found.sort_by(|a, b| b[4].total_cmp(&a[4]));
    let mut kept: Vec<[f32; 5]> = Vec::new();
    for face in found {
        if kept.iter().all(|other| overlap(&face, other) <= OVERLAP) {
            kept.push(face);
        }
    }
    kept.into_iter()
        .map(|[x0, y0, x1, y1, score]| [x0 / width, y0 / height, x1 / width, y1 / height, score])
        .collect()
}

/// Intersection over union of two boxes.
fn overlap(a: &[f32; 5], b: &[f32; 5]) -> f32 {
    let across = (a[2].min(b[2]) - a[0].max(b[0])).max(0.0);
    let down = (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
    let both = across * down;
    let area = |c: &[f32; 5]| (c[2] - c[0]).max(0.0) * (c[3] - c[1]).max(0.0);
    let either = area(a) + area(b) - both;
    if either <= 0.0 {
        0.0
    } else {
        both / either
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cell_decodes_to_its_box_and_overlapping_ones_are_one_face() {
        // A 64×64 picture, stride 32: 2×2 cells. Cell 3 (column 1, row 1) is
        // sure; cell 2 says the same face less surely; cell 0 is nothing.
        let head = Head {
            stride: 32,
            columns: 2,
            cls: vec![0.1, 0.0, 0.81, 0.9],
            obj: vec![0.1, 0.0, 0.81, 0.9],
            bbox: [
                [0.0, 0.0, 0.0, 0.0],
                [0.0, 0.0, 0.0, 0.0],
                [1.0, 0.5, -std::f32::consts::LN_2, -std::f32::consts::LN_2],
                [0.0, 0.5, -std::f32::consts::LN_2, -std::f32::consts::LN_2],
            ]
            .concat(),
        };
        let faces = decode(&[head], 64.0, 64.0);
        assert_eq!(faces.len(), 1, "{faces:?}");
        let [x0, y0, x1, y1, sure] = faces[0];
        // Centre (32, 48), 16 px square: x 24–40, y 40–56, of 64.
        for (got, want) in [(x0, 0.375), (y0, 0.625), (x1, 0.625), (y1, 0.875)] {
            assert!((got - want).abs() < 1e-3, "{faces:?}");
        }
        assert!((sure - 0.9).abs() < 1e-6);
    }

    #[test]
    fn a_black_frame_has_no_faces_and_any_size_runs() {
        for (width, height) in [(640, 360), (360, 640), (100, 75)] {
            let black = vec![0u8; width * height * 4];
            let found = faces(&black, width as u32, height as u32).unwrap();
            assert!(
                found.iter().all(|face| face[4] < 0.5),
                "{width}×{height}: {found:?}"
            );
        }
    }
}
