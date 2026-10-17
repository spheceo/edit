//! Camera angles in interrogation footage, from small greyscale frames: a
//! cut is a jump between frames; a scene lasting 20 s or more is a camera
//! angle, and later scenes that look the same (however short) are that
//! angle. Reading the frames and asking who sits where is the server's.

/// Frames a second looked at, and their size: enough to see a cut.
pub const FPS: f64 = 2.0;
pub const WIDE: usize = 64;
pub const HIGH: usize = 36;
/// A jump between frames this big (brightness removed) is a cut.
const CUT: f32 = 0.16;
/// Scenes shorter than this are cutaways: no angle, subtitles bottom middle.
const LASTING: f64 = 20.0;
/// Scenes whose middle frames differ less than this are one camera angle.
const SAME_ANGLE: f32 = 0.09;

/// A frame with its brightness taken out (each pixel less the mean).
fn levelled(frame: &[u8]) -> Vec<f32> {
    let mean = frame.iter().map(|&value| f32::from(value)).sum::<f32>() / frame.len().max(1) as f32;
    frame.iter().map(|&value| f32::from(value) - mean).collect()
}

/// How different two levelled frames are (0 alike .. ~1).
fn distance(a: &[f32], b: &[f32]) -> f32 {
    let total: f32 = a.iter().zip(b).map(|(a, b)| (a - b).abs()).sum();
    total / a.len().max(1) as f32 / 128.0
}

/// The scenes (start, end seconds, camera angle) in `frames`, and how many angles.
pub fn scenes(frames: &[u8]) -> (Vec<(f64, f64, Option<usize>)>, usize) {
    let frames: Vec<Vec<f32>> = frames
        .as_chunks::<{ WIDE * HIGH }>()
        .0
        .iter()
        .map(|frame| levelled(frame))
        .collect();
    let mut cuts = vec![0];
    for index in 1..frames.len() {
        if let (Some(before), Some(now)) = (frames.get(index - 1), frames.get(index)) {
            if distance(before, now) > CUT {
                cuts.push(index);
            }
        }
    }
    cuts.push(frames.len());
    let mut looks: Vec<&Vec<f32>> = Vec::new();
    let mut scenes = Vec::new();
    for pair in cuts.windows(2) {
        let [from, to] = pair else {
            continue;
        };
        if to <= from {
            continue;
        }
        let (start, end) = (*from as f64 / FPS, *to as f64 / FPS);
        let angle = (end - start >= LASTING)
            .then(|| frames.get((from + to) / 2))
            .flatten()
            .map(|middle| {
                looks
                    .iter()
                    .position(|look| distance(look, middle) <= SAME_ANGLE)
                    .unwrap_or_else(|| {
                        looks.push(middle);
                        looks.len() - 1
                    })
            });
        scenes.push((start, end, angle));
    }
    // A short stretch of a room already seen (between jump cuts) is that
    // angle too; only other pictures (photos, B-roll, maps) are cutaways.
    for (index, pair) in cuts.windows(2).enumerate() {
        let (Some(scene), [from, to]) = (scenes.get_mut(index), pair) else {
            continue;
        };
        if scene.2.is_none() && to > from {
            scene.2 = frames.get((from + to) / 2).and_then(|middle| {
                looks
                    .iter()
                    .position(|look| distance(look, middle) <= SAME_ANGLE)
            });
        }
    }
    // The last scene runs on to the end, however the frames were rounded.
    if let Some(last) = scenes.last_mut() {
        last.1 = f64::INFINITY;
    }
    (scenes, looks.len())
}
#[cfg(test)]
mod tests {
    use super::{scenes, HIGH, WIDE};

    #[test]
    fn a_room_seen_again_is_the_same_angle_however_short() {
        let frame = |shade: u8, stripe: bool| -> Vec<u8> {
            (0..WIDE * HIGH)
                .map(|index| {
                    if stripe && index % WIDE < WIDE / 2 {
                        shade.saturating_add(120)
                    } else {
                        shade
                    }
                })
                .collect()
        };
        let mut frames = Vec::new();
        // 25 s of the room, 5 s of a photo (a cutaway), 5 s of the room again.
        for _ in 0..50 {
            frames.extend(frame(40, true));
        }
        for _ in 0..10 {
            frames.extend(frame(200, false));
        }
        for _ in 0..10 {
            frames.extend(frame(40, true));
        }
        let (found, angles) = scenes(&frames);
        assert_eq!(angles, 1);
        let kinds: Vec<Option<usize>> = found.iter().map(|scene| scene.2).collect();
        assert_eq!(kinds, [Some(0), None, Some(0)]);
    }
}
