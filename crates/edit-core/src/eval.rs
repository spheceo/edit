use crate::model::*;

/// Everything needed to draw one frame, bottom layer first.
#[derive(Clone, Debug, PartialEq)]
pub struct Scene {
    pub width: u32,
    pub height: u32,
    pub layers: Vec<Layer>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Layer {
    Video {
        clip: String,
        media: String,
        /// Seconds into the source.
        source_time: f64,
        transform: Transform,
        opacity: f32,
    },
    Text {
        clip: String,
        text: String,
        style: TextStyle,
        transform: Transform,
        animation: TextAnimation,
        /// Frames since the clip started.
        local_frame: f32,
        opacity: f32,
    },
    Adjustment {
        grade: Grade,
        opacity: f32,
    },
    Solid {
        color: Rgba,
        opacity: f32,
    },
}

/// A video source the preview must have decoded before drawing a frame.
#[derive(Clone, Debug, PartialEq)]
pub struct SourceRequest {
    pub media: String,
    pub source_time: f64,
}

pub fn evaluate(project: &Project, frame: i64) -> Scene {
    let fps = project.fps();
    let mut layers = Vec::new();
    for track in project
        .tracks
        .iter()
        .filter(|track| track.kind == TrackKind::Video && !track.hidden)
    {
        let Some(clip) = project
            .clips
            .iter()
            .find(|clip| clip.track == track.id && clip.contains(frame))
        else {
            continue;
        };
        let local = (frame - clip.start) as f32;
        let fade = fade_factor(clip, local);
        let anim = |param: &str, base: f32| animated(clip, param, local, base);
        let seconds = frame as f32 / fps as f32;
        let animated_transform = |transform: &Transform| {
            let shake = anim("shake", transform.shake);
            let [dx, dy, turn] = if shake > 0.0 {
                wobble(&clip.id, seconds)
            } else {
                [0.0; 3]
            };
            Transform {
                x: anim("x", transform.x) + dx * shake,
                y: anim("y", transform.y) + dy * shake,
                scale: anim("scale", transform.scale),
                // A degree of tilt for every 40 px of shake: barely there.
                rotation: anim("rotation", transform.rotation) + turn * shake / 40.0,
                shake,
            }
        };
        let layer = match &clip.content {
            ClipContent::Video {
                media,
                source_in,
                speed,
                transform,
                opacity,
            } => Layer::Video {
                clip: clip.id.clone(),
                media: media.clone(),
                source_time: source_in + f64::from(local) / fps * speed,
                transform: animated_transform(transform),
                opacity: anim("opacity", *opacity) * fade,
            },
            ClipContent::Text {
                text,
                style,
                transform,
                animation,
                opacity,
                word_times,
            } => {
                // Words: only those said so far, in place of a glyph animation.
                let (text, animation) = if animation.preset == TextPreset::Words {
                    let shown = words_shown(text, word_times, animation.stagger, local);
                    if shown.is_empty() {
                        continue;
                    }
                    (
                        shown,
                        TextAnimation {
                            preset: TextPreset::None,
                            ..*animation
                        },
                    )
                } else {
                    (text.clone(), *animation)
                };
                let mut style = style.clone();
                style.size = anim("size", style.size);
                style.tracking = anim("tracking", style.tracking);
                style.glow.radius = anim("glow.radius", style.glow.radius);
                style.glow.strength = anim("glow.strength", style.glow.strength);
                Layer::Text {
                    clip: clip.id.clone(),
                    text,
                    style,
                    transform: animated_transform(transform),
                    animation,
                    local_frame: local,
                    opacity: anim("opacity", *opacity) * fade,
                }
            }
            ClipContent::Adjustment { grade, opacity } => Layer::Adjustment {
                grade: Grade {
                    exposure: anim("exposure", grade.exposure),
                    contrast: anim("contrast", grade.contrast),
                    saturation: anim("saturation", grade.saturation),
                    temperature: anim("temperature", grade.temperature),
                    vignette: anim("vignette", grade.vignette),
                },
                opacity: anim("opacity", *opacity) * fade,
            },
            ClipContent::Solid { fill, opacity } => Layer::Solid {
                color: *fill,
                opacity: anim("opacity", *opacity) * fade,
            },
            ClipContent::Audio { .. } => continue,
        };
        layers.push(layer);
    }
    Scene {
        width: project.settings.width,
        height: project.settings.height,
        layers,
    }
}

/// Video frames the scene at `frame` needs, one per visible video layer.
pub fn sources_at(project: &Project, frame: i64) -> Vec<SourceRequest> {
    evaluate(project, frame)
        .layers
        .into_iter()
        .filter_map(|layer| match layer {
            Layer::Video {
                media, source_time, ..
            } => Some(SourceRequest { media, source_time }),
            _ => None,
        })
        .collect()
}

/// The text up to the last word that has appeared by `local` (frames into the
/// clip): at `times` when given, else one word every `stagger` frames.
/// Whitespace and line breaks are kept as written.
pub fn words_shown(text: &str, times: &[f32], stagger: f32, local: f32) -> String {
    let mut count = 0;
    let mut end = 0;
    let mut in_word = false;
    for (index, c) in text.char_indices() {
        if c.is_whitespace() {
            in_word = false;
            continue;
        }
        if !in_word {
            in_word = true;
            let appears = times
                .get(count)
                .copied()
                .unwrap_or(count as f32 * stagger.max(0.0));
            if appears > local {
                break;
            }
            count += 1;
        }
        end = index + c.len_utf8();
    }
    text[..end].to_owned()
}

/// Smooth handheld wander for `seconds`, each axis in -1..1 (x, y, tilt).
/// Seeded by the clip so stacked clips don't shake in lockstep.
fn wobble(seed: &str, seconds: f32) -> [f32; 3] {
    let seed = seed.bytes().fold(2166136261_u32, |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(16777619)
    });
    let noise = |channel: u32, t: f32| {
        let lattice = |i: i64| {
            let mut h =
                seed ^ channel.wrapping_mul(0x9E37_79B9) ^ (i as u32).wrapping_mul(0x85EB_CA6B);
            h ^= h >> 15;
            h = h.wrapping_mul(0x2C1B_3C6D);
            h ^= h >> 12;
            (h as f32 / u32::MAX as f32) * 2.0 - 1.0
        };
        let i = t.floor();
        let f = t - i;
        let s = f * f * (3.0 - 2.0 * f);
        lattice(i as i64) * (1.0 - s) + lattice(i as i64 + 1) * s
    };
    // A slow drift plus a quicker jitter, like a hand holding a camera.
    let axis = |channel: u32| {
        0.7 * noise(channel, seconds * 2.5) + 0.3 * noise(channel + 7, seconds * 9.0)
    };
    [axis(1), axis(2), axis(3)]
}

fn fade_factor(clip: &Clip, local: f32) -> f32 {
    let mut factor = 1.0_f32;
    if clip.fade_in > 0 {
        factor = factor.min(((local + 1.0) / (clip.fade_in as f32 + 1.0)).clamp(0.0, 1.0));
    }
    if clip.fade_out > 0 {
        let remaining = clip.duration as f32 - local;
        factor = factor.min((remaining / (clip.fade_out as f32 + 1.0)).clamp(0.0, 1.0));
    }
    factor
}

fn animated(clip: &Clip, param: &str, local: f32, base: f32) -> f32 {
    clip.keyframes
        .get(param)
        .and_then(|keys| sample(keys, local))
        .unwrap_or(base)
}

/// Value of a keyframe track at `frame`. Holds the first/last value outside the keyed range.
pub fn sample(keys: &[Keyframe], frame: f32) -> Option<f32> {
    let first = keys.first()?;
    if keys.len() == 1 || frame <= first.frame {
        return Some(first.value);
    }
    for pair in keys.windows(2) {
        let (from, to) = (pair[0], pair[1]);
        if frame < to.frame {
            if from.ease == Ease::Hold {
                return Some(from.value);
            }
            let [p1, p2] = segment_handles(&from, &to);
            return Some(bezier_value(&from, &to, p1, p2, frame));
        }
    }
    keys.last().map(|key| key.value)
}

/// The two inner control points of the segment `from`→`to` as (frame, value):
/// each end's explicit handle, else the one its `ease` preset implies.
pub fn segment_handles(from: &Keyframe, to: &Keyframe) -> [[f32; 2]; 2] {
    let span = (to.frame - from.frame).max(f32::EPSILON);
    let [out, inn] = preset_handles(from.ease, (to.value - from.value) / span);
    let out = from.handle_out.unwrap_or(out);
    let inn = to.handle_in.unwrap_or(inn);
    let (a, b) = (out.influence.clamp(0.0, 1.0), inn.influence.clamp(0.0, 1.0));
    [
        [from.frame + a * span, from.value + out.speed * a * span],
        [to.frame - b * span, to.value - inn.speed * b * span],
    ]
}

/// The handles a preset ease stands for, given the segment's average slope
/// (value per frame). Matches the CSS cubic easings.
pub fn preset_handles(kind: Ease, slope: f32) -> [Handle; 2] {
    // cubic-bezier(x1, y1, x2, y2) on a unit segment.
    let [x1, y1, x2, y2] = match kind {
        Ease::Linear | Ease::Hold => [1.0 / 3.0, 1.0 / 3.0, 2.0 / 3.0, 2.0 / 3.0],
        Ease::In => [0.32, 0.0, 0.67, 0.0],
        Ease::Out => [0.33, 1.0, 0.68, 1.0],
        Ease::InOut => [0.65, 0.0, 0.35, 1.0],
    };
    [
        Handle {
            speed: slope * y1 / x1,
            influence: x1,
        },
        Handle {
            speed: slope * (1.0 - y2) / (1.0 - x2),
            influence: 1.0 - x2,
        },
    ]
}

/// Value of the cubic through `from`, `p1`, `p2`, `to` at `frame`. Influences
/// in [0, 1] keep frame monotonic in the curve parameter, so solve for it.
fn bezier_value(from: &Keyframe, to: &Keyframe, p1: [f32; 2], p2: [f32; 2], frame: f32) -> f32 {
    let cubic = |a: f32, b: f32, c: f32, d: f32, u: f32| {
        let v = 1.0 - u;
        v * v * v * a + 3.0 * v * v * u * b + 3.0 * v * u * u * c + u * u * u * d
    };
    let x = |u: f32| cubic(from.frame, p1[0], p2[0], to.frame, u);
    let (mut lo, mut hi) = (0.0_f32, 1.0_f32);
    let mut u = ((frame - from.frame) / (to.frame - from.frame).max(f32::EPSILON)).clamp(0.0, 1.0);
    for _ in 0..30 {
        let at = x(u);
        if (at - frame).abs() < 1e-4 {
            break;
        }
        if at < frame {
            lo = u;
        } else {
            hi = u;
        }
        u = 0.5 * (lo + hi);
    }
    cubic(from.value, p1[1], p2[1], to.value, u)
}

/// A preset's progress curve, for built-in motion (text animation).
pub fn ease(kind: Ease, t: f32) -> f32 {
    match kind {
        Ease::Linear => t,
        Ease::In => t * t * t,
        Ease::Out => 1.0 - (1.0 - t).powi(3),
        Ease::InOut => {
            if t < 0.5 {
                4.0 * t * t * t
            } else {
                1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
            }
        }
        Ease::Hold => 0.0,
    }
}

/// Sound the export mixes. Times are seconds.
#[derive(Clone, Debug, PartialEq)]
pub struct AudioSegment {
    pub clip: String,
    pub media: String,
    pub start: f64,
    pub duration: f64,
    pub source_in: f64,
    pub speed: f64,
    pub volume_db: f32,
    pub fade_in: f64,
    pub fade_out: f64,
}

pub fn audio_segments(project: &Project) -> Vec<AudioSegment> {
    let fps = project.fps();
    project
        .clips
        .iter()
        .filter(|clip| {
            project
                .track(&clip.track)
                .is_some_and(|track| track.kind == TrackKind::Audio && !track.muted)
        })
        .filter_map(|clip| match &clip.content {
            ClipContent::Audio {
                media,
                source_in,
                speed,
                volume_db,
            } => Some(AudioSegment {
                clip: clip.id.clone(),
                media: media.clone(),
                start: clip.start as f64 / fps,
                duration: clip.duration as f64 / fps,
                source_in: *source_in,
                speed: *speed,
                volume_db: *volume_db,
                fade_in: clip.fade_in as f64 / fps,
                fade_out: clip.fade_out as f64 / fps,
            }),
            _ => None,
        })
        .collect()
}

/// Per-glyph reveal state for text presets: (opacity, y offset in px, scale).
/// Shared so the preview and export animate identically.
pub fn glyph_reveal(
    animation: &TextAnimation,
    local_frame: f32,
    index: usize,
    size: f32,
) -> (f32, f32, f32) {
    let duration = animation.duration.max(1.0);
    let start = animation.stagger.max(0.0) * index as f32;
    let t = ((local_frame - start) / duration).clamp(0.0, 1.0);
    match animation.preset {
        // Words are revealed in `evaluate`, which hands the glyphs over already chosen.
        TextPreset::None | TextPreset::Words => (1.0, 0.0, 1.0),
        TextPreset::Fade => {
            let t = (local_frame / duration).clamp(0.0, 1.0);
            (ease(Ease::Out, t), 0.0, 1.0)
        }
        TextPreset::Rise => {
            let e = ease(Ease::Out, t);
            (e, (1.0 - e) * size * 0.35, 1.0)
        }
        TextPreset::Pop => {
            // Back-out overshoot.
            let c = 1.70158_f32;
            let p = t - 1.0;
            let scale = 1.0 + (c + 1.0) * p * p * p + c * p * p;
            (ease(Ease::Out, (t * 2.0).min(1.0)), 0.0, scale.max(0.0))
        }
        TextPreset::Typewriter => (if local_frame >= start { 1.0 } else { 0.0 }, 0.0, 1.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> Project {
        let mut project = Project::new("p1".into(), "Test".into(), Settings::default());
        project.media.push(Media {
            id: "m1".into(),
            name: "a.mp4".into(),
            path: "/tmp/a.mp4".into(),
            kind: MediaKind::Video,
            duration: 60.0,
            width: 1920,
            height: 1080,
            fps: 30.0,
            has_audio: true,
        });
        let v1 = project.tracks[0].id.clone();
        let v2 = project.tracks[1].id.clone();
        project.clips.push(Clip {
            id: "c1".into(),
            track: v1,
            start: 0,
            duration: 300,
            color: ClipColor::Blue,
            name: None,
            link: None,
            fade_in: 0,
            fade_out: 0,
            keyframes: Default::default(),
            content: ClipContent::Video {
                media: "m1".into(),
                source_in: 2.0,
                speed: 2.0,
                transform: Transform::default(),
                opacity: 1.0,
            },
        });
        project.clips.push(Clip {
            id: "c2".into(),
            track: v2,
            start: 30,
            duration: 60,
            color: ClipColor::Pink,
            name: None,
            link: None,
            fade_in: 0,
            fade_out: 0,
            keyframes: [(
                "opacity".to_owned(),
                vec![
                    Keyframe {
                        frame: 0.0,
                        value: 0.0,
                        ease: Ease::Linear,
                        handle_in: None,
                        handle_out: None,
                    },
                    Keyframe {
                        frame: 10.0,
                        value: 1.0,
                        ease: Ease::Linear,
                        handle_in: None,
                        handle_out: None,
                    },
                ],
            )]
            .into(),
            content: ClipContent::Solid {
                fill: Rgba::WHITE,
                opacity: 1.0,
            },
        });
        project
    }

    #[test]
    fn evaluates_layers_bottom_up_with_speed_and_keyframes() {
        let project = project();
        project.validate().unwrap();
        let scene = evaluate(&project, 35);
        assert_eq!(scene.layers.len(), 2);
        match &scene.layers[0] {
            Layer::Video { source_time, .. } => {
                assert!((source_time - (2.0 + 35.0 / 30.0 * 2.0)).abs() < 1e-9)
            }
            other => panic!("expected video, got {other:?}"),
        }
        match &scene.layers[1] {
            Layer::Solid { opacity, .. } => assert!((opacity - 0.5).abs() < 1e-6),
            other => panic!("expected solid, got {other:?}"),
        }
        assert_eq!(evaluate(&project, 300).layers.len(), 0);
    }

    #[test]
    fn validate_rejects_overlaps_and_bad_params() {
        let mut project = project();
        project.clips[1].track = project.clips[0].track.clone();
        assert!(project.validate().unwrap_err().contains("overlap"));
        let mut project = self::project();
        project.clips[1].keyframes.insert(
            "exposure".into(),
            vec![Keyframe {
                frame: 0.0,
                value: 1.0,
                ease: Ease::Linear,
                handle_in: None,
                handle_out: None,
            }],
        );
        assert!(project.validate().unwrap_err().contains("cannot animate"));
    }

    #[test]
    fn project_round_trips_through_json() {
        let project = project();
        let json = serde_json::to_string(&project).unwrap();
        assert!(json.contains("\"type\":\"video\""));
        let back: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(back, project);
    }

    #[test]
    fn sample_eases_and_holds() {
        let keys = [
            Keyframe {
                frame: 0.0,
                value: 0.0,
                ease: Ease::Hold,
                handle_in: None,
                handle_out: None,
            },
            Keyframe {
                frame: 10.0,
                value: 10.0,
                ease: Ease::Linear,
                handle_in: None,
                handle_out: None,
            },
            Keyframe {
                frame: 20.0,
                value: 0.0,
                ease: Ease::Linear,
                handle_in: None,
                handle_out: None,
            },
        ];
        assert_eq!(sample(&keys, -5.0), Some(0.0));
        assert_eq!(sample(&keys, 9.0), Some(0.0));
        assert!((sample(&keys, 15.0).unwrap() - 5.0).abs() < 1e-3);
        assert_eq!(sample(&keys, 50.0), Some(0.0));
    }

    fn key(frame: f32, value: f32, ease: Ease) -> Keyframe {
        Keyframe {
            frame,
            value,
            ease,
            handle_in: None,
            handle_out: None,
        }
    }

    #[test]
    fn presets_follow_their_curves() {
        let close = |a: f32, b: f32| (a - b).abs() < 0.01;
        let linear = [key(0.0, 0.0, Ease::Linear), key(30.0, 90.0, Ease::Linear)];
        assert!(close(sample(&linear, 10.0).unwrap(), 30.0));
        let in_out = [key(0.0, 0.0, Ease::InOut), key(30.0, 100.0, Ease::Linear)];
        assert!(close(sample(&in_out, 15.0).unwrap(), 50.0));
        assert!(
            sample(&in_out, 3.0).unwrap() < 3.0,
            "eases out of the first key slowly"
        );
        let ease_in = [key(0.0, 0.0, Ease::In), key(10.0, 1.0, Ease::Linear)];
        assert!(close(sample(&ease_in, 5.0).unwrap(), ease(Ease::In, 0.5)));
    }

    #[test]
    fn handles_shape_the_segment() {
        // A fast start: leave at 10 units/frame, arrive flat.
        let mut keys = [key(0.0, 0.0, Ease::Linear), key(20.0, 100.0, Ease::Linear)];
        keys[0].handle_out = Some(Handle {
            speed: 10.0,
            influence: 0.3,
        });
        keys[1].handle_in = Some(Handle {
            speed: 0.0,
            influence: 0.5,
        });
        let early = sample(&keys, 4.0).unwrap();
        assert!(early > 30.0, "front-loaded: {early}");
        let mut last = f32::MIN;
        for frame in 0..=20 {
            let value = sample(&keys, frame as f32).unwrap();
            assert!(value >= last - 1e-3, "no overshoot, so it only rises");
            last = value;
        }
        assert!((sample(&keys, 20.0).unwrap() - 100.0).abs() < 1e-3);
        // Explicit handles equal to the preset's give the preset's curve.
        let preset = [key(0.0, 0.0, Ease::InOut), key(20.0, 100.0, Ease::Linear)];
        let [out, inn] = preset_handles(Ease::InOut, 5.0);
        let mut explicit = preset;
        explicit[0].handle_out = Some(out);
        explicit[1].handle_in = Some(inn);
        for frame in [2.0, 7.0, 13.0, 18.0] {
            assert!(
                (sample(&preset, frame).unwrap() - sample(&explicit, frame).unwrap()).abs() < 1e-4
            );
        }
    }

    #[test]
    fn words_appear_one_at_a_time() {
        let text = "So, did you\nget anything";
        let times = [0.0, 10.0, 12.0, 30.0, 31.0];
        assert_eq!(words_shown(text, &times, 4.0, -1.0), "");
        assert_eq!(words_shown(text, &times, 4.0, 0.0), "So,");
        assert_eq!(words_shown(text, &times, 4.0, 12.5), "So, did you");
        assert_eq!(words_shown(text, &times, 4.0, 30.0), "So, did you\nget");
        assert_eq!(words_shown(text, &times, 4.0, 99.0), text);
        // Without times, one word every `stagger` frames.
        assert_eq!(words_shown("a b c", &[], 4.0, 5.0), "a b");
    }

    #[test]
    fn shake_wanders_smoothly_within_its_amount() {
        let mut last = wobble("c1", 0.0);
        for step in 1..300 {
            let now = wobble("c1", step as f32 / 30.0);
            for axis in 0..3 {
                assert!(now[axis].abs() <= 1.0);
                assert!(
                    (now[axis] - last[axis]).abs() < 0.5,
                    "no jumps between frames"
                );
            }
            last = now;
        }
        assert_ne!(
            wobble("c1", 1.0),
            wobble("c2", 1.0),
            "each clip shakes its own way"
        );
    }
}
