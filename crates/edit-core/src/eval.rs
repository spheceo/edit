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
        crop: Crop,
        frame: Option<PhotoFrame>,
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
        /// Glyphs drawn so far, not counting whitespace (`None`: all). The
        /// rest keep their place unseen, so the text is laid out once, whole.
        shown_glyphs: Option<usize>,
    },
    Adjustment {
        grade: Grade,
        /// How the picture beneath moves this frame.
        shake: ShakeOffset,
        glitch: GlitchFrame,
        /// Blurs the picture beneath (in a region) before the grade; project px.
        blur: Blur,
        opacity: f32,
    },
    Solid {
        color: Rgba,
        opacity: f32,
        gradient: Option<Gradient>,
    },
    Waveform {
        clip: String,
        /// The sound heard now, which the waveform shows.
        sources: Vec<WaveSource>,
        /// Seconds on the timeline: the line's tangle moves on with time.
        seconds: f32,
        style: WaveformStyle,
        transform: Transform,
        opacity: f32,
    },
}

/// An adjustment's glitch this frame: how far its bands slide (project px),
/// how many there are, the colour split, and which pattern (a new one every
/// frame, different per clip).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GlitchFrame {
    pub amount: f32,
    pub slices: f32,
    pub rgb: f32,
    pub seed: f32,
}

/// One sound a waveform shows: where its media is now, how fast it plays,
/// how loud it's heard (linear), and the stretch of the media its clip plays
/// (seconds), outside which it's silent.
#[derive(Clone, Debug, PartialEq)]
pub struct WaveSource {
    pub media: String,
    pub time: f64,
    pub speed: f64,
    pub gain: f32,
    pub from: f64,
    pub to: f64,
}

/// The picture beneath an adjustment layer, moved by its shake: offset in
/// project px and tilt in degrees clockwise now, and where it was one
/// shutter earlier (`from_*`, the same when there's no motion blur), so the
/// renderer can blur along the move; `zoom` keeps the edges out of sight, or
/// `mirror` reflects the picture past them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShakeOffset {
    pub x: f32,
    pub y: f32,
    pub rotation: f32,
    pub from_x: f32,
    pub from_y: f32,
    pub from_rotation: f32,
    pub zoom: f32,
    pub mirror: bool,
}

impl Default for ShakeOffset {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            rotation: 0.0,
            from_x: 0.0,
            from_y: 0.0,
            from_rotation: 0.0,
            zoom: 1.0,
            mirror: false,
        }
    }
}

pub fn evaluate(project: &Project, frame: i64) -> Scene {
    let fps = project.fps();
    let mut layers = Vec::new();
    let active: std::collections::HashMap<_, _> = project
        .clips
        .iter()
        .filter(|clip| clip.contains(frame))
        .map(|clip| (clip.track.as_str(), clip))
        .collect();
    for track in project
        .tracks
        .iter()
        .filter(|track| track.kind == TrackKind::Video && !track.hidden)
    {
        let Some(clip) = active.get(track.id.as_str()) else {
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
                crop,
                frame,
            } => Layer::Video {
                clip: clip.id.clone(),
                media: media.clone(),
                source_time: source_in + f64::from(local) / fps * speed,
                transform: animated_transform(transform),
                opacity: anim("opacity", *opacity) * fade,
                crop: *crop,
                frame: *frame,
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
                // The whole line is laid out from the first word, so each word
                // lands where it ends up and nothing shifts as the line fills.
                let still = TextAnimation {
                    preset: TextPreset::None,
                    ..*animation
                };
                let (text, shown_glyphs, animation) = match animation.preset {
                    TextPreset::Words => {
                        let shown = words_shown(text, word_times, animation.stagger, local)
                            .chars()
                            .filter(|c| !c.is_whitespace())
                            .count();
                        if shown == 0 {
                            continue;
                        }
                        (text.clone(), Some(shown), still)
                    }
                    // Word: just the latest, laid out on its own.
                    TextPreset::Word => {
                        let said = words_shown(text, word_times, animation.stagger, local);
                        let Some(word) = said.split_whitespace().last() else {
                            continue;
                        };
                        (word.to_owned(), None, still)
                    }
                    _ => (text.clone(), None, *animation),
                };
                let mut style = style.clone();
                style.size = anim("size", style.size);
                style.tracking = anim("tracking", style.tracking);
                style.glow.radius = anim("glow.radius", style.glow.radius);
                style.glow.strength = anim("glow.strength", style.glow.strength);
                if let Some(leader) = &mut style.leader {
                    leader.x = anim("leader.x", leader.x);
                    leader.y = anim("leader.y", leader.y);
                }
                Layer::Text {
                    clip: clip.id.clone(),
                    text,
                    style,
                    transform: animated_transform(transform),
                    animation,
                    local_frame: local,
                    opacity: anim("opacity", *opacity) * fade,
                    shown_glyphs,
                }
            }
            ClipContent::Adjustment {
                grade,
                shake,
                glitch,
                blur,
                opacity,
            } => {
                let settings = shake.resolved();
                // Amounts are at 1080p.
                let amount =
                    anim("shake", settings.amount) * project.settings.height as f32 / 1080.0;
                Layer::Adjustment {
                    grade: Grade {
                        exposure: anim("exposure", grade.exposure),
                        contrast: anim("contrast", grade.contrast),
                        saturation: anim("saturation", grade.saturation),
                        temperature: anim("temperature", grade.temperature),
                        vignette: anim("vignette", grade.vignette),
                        vignette_x: anim("vignette_x", grade.vignette_x),
                        vignette_y: anim("vignette_y", grade.vignette_y),
                        vignette_size: anim("vignette_size", grade.vignette_size),
                        vignette_aspect: grade.vignette_aspect,
                        focus_exposure: grade.focus_exposure,
                        vignette_saturation: grade.vignette_saturation,
                    },
                    glitch: GlitchFrame {
                        // Amounts are at 1080p.
                        amount: anim("glitch", glitch.amount) * project.settings.height as f32
                            / 1080.0,
                        slices: glitch.slices.max(1.0),
                        rgb: glitch.rgb,
                        seed: ((seed_of(&clip.id) ^ (frame as u32).wrapping_mul(0x9E37_79B9)) % 997)
                            as f32,
                    },
                    blur: Blur {
                        radius: anim("blur", blur.radius).max(0.0),
                        x: anim("blur.x", blur.x),
                        y: anim("blur.y", blur.y),
                        width: anim("blur.width", blur.width).max(0.0),
                        height: anim("blur.height", blur.height).max(0.0),
                        feather: blur.feather.max(0.0),
                        shape: blur.shape,
                    },
                    shake: shake_offset(
                        &clip.id,
                        &ShakeSettings { amount, ..settings },
                        ShakeTime {
                            seconds,
                            local: local / fps as f32,
                            length: clip.duration.max(1) as f32 / fps as f32,
                            frame: 1.0 / fps as f32,
                        },
                        (project.settings.width, project.settings.height),
                    ),
                    opacity: anim("opacity", *opacity) * fade,
                }
            }
            ClipContent::Solid {
                fill,
                opacity,
                gradient,
            } => Layer::Solid {
                color: *fill,
                opacity: anim("opacity", *opacity) * fade,
                gradient: *gradient,
            },
            ClipContent::Waveform {
                media,
                style,
                transform,
                opacity,
            } => Layer::Waveform {
                clip: clip.id.clone(),
                sources: heard(project, frame, media.as_deref()),
                seconds,
                style: WaveformStyle {
                    gain: anim("gain", style.gain),
                    glow: Glow {
                        radius: anim("glow.radius", style.glow.radius),
                        strength: anim("glow.strength", style.glow.strength),
                        ..style.glow
                    },
                    ..style.clone()
                },
                transform: animated_transform(transform),
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
    // `end` always follows a char, so this is the whole prefix.
    text.get(..end).unwrap_or_default().to_owned()
}

fn seed_of(text: &str) -> u32 {
    text.bytes().fold(2166136261_u32, |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(16777619)
    })
}

/// Smooth value noise in -1..1, one wave per unit of `t`.
fn noise(seed: u32, channel: u32, t: f32) -> f32 {
    let lattice = |i: i64| {
        let mut h = seed ^ channel.wrapping_mul(0x9E37_79B9) ^ (i as u32).wrapping_mul(0x85EB_CA6B);
        h ^= h >> 15;
        h = h.wrapping_mul(0x2C1B_3C6D);
        h ^= h >> 12;
        (h as f32 / u32::MAX as f32) * 2.0 - 1.0
    };
    let i = t.floor();
    let f = t - i;
    let s = f * f * (3.0 - 2.0 * f);
    lattice(i as i64) * (1.0 - s) + lattice(i as i64 + 1) * s
}

/// Smooth handheld wander for `seconds`, each axis in -1..1 (x, y, tilt).
/// Seeded by the clip so stacked clips don't shake in lockstep.
fn wobble(seed: &str, seconds: f32) -> [f32; 3] {
    let seed = seed_of(seed);
    // A slow drift plus a quicker jitter, like a hand holding a camera.
    let axis = |channel: u32| {
        0.7 * noise(seed, channel, seconds * 2.5) + 0.3 * noise(seed, channel + 7, seconds * 9.0)
    };
    [axis(1), axis(2), axis(3)]
}

/// When a shake is evaluated, in seconds: on the timeline, into the clip,
/// the clip's length, and one frame.
#[derive(Clone, Copy, Debug)]
pub struct ShakeTime {
    pub seconds: f32,
    pub local: f32,
    pub length: f32,
    pub frame: f32,
}

/// An adjustment layer's shake, after Sapphire S_Shake: a fast random wiggle
/// (a wave `frequency` times a second with a finer one on top), shaped over
/// the clip by its envelope, plus where it was a shutter earlier for the
/// motion blur, and the edge handling.
pub fn shake_offset(
    seed: &str,
    shake: &ShakeSettings,
    time: ShakeTime,
    (width, height): (u32, u32),
) -> ShakeOffset {
    let drop = shake.motion == ShakeMotion::Drop;
    // A drop can go either way; a wiggle's amount is a size.
    let amount = if drop {
        shake.amount
    } else {
        shake.amount.max(0.0)
    };
    if amount == 0.0 && shake.rotation.abs() <= 0.0 {
        return ShakeOffset::default();
    }
    let seed = seed_of(seed);
    let (along_x, along_y) = match shake.direction {
        ShakeDirection::Both => (1.0, 1.0),
        ShakeDirection::Vertical => (0.0, 1.0),
        ShakeDirection::Horizontal => (1.0, 0.0),
    };
    let at = |back: f32| {
        if drop {
            // A whip through the cut at the clip's middle: the picture accelerates
            // away up to the cut, then the next shot comes in from the other side
            // and settles, so it's fastest (and most blurred) either side of the
            // cut. Measured mid-frame, so the frames either side mirror each other.
            let half = time.length.max(1e-3) / 2.0;
            let at = |local: f32| (local + time.frame / 2.0) / half;
            let now = at(time.local);
            let p = if now < 1.0 {
                at(time.local - back).clamp(0.0, 1.0).powi(3)
            } else {
                // The old shot's blur mirrored: it smears toward where the
                // picture settles, so the new shot comes clean as it lands.
                -(2.0 - at(time.local + back).clamp(1.0, 2.0)).powi(3)
            };
            return (
                amount * p * along_x,
                amount * p * along_y,
                shake.rotation * p,
            );
        }
        let t = (time.seconds - back) * shake.frequency.max(0.0);
        let strength = shake
            .envelope
            .at((time.local - back) / time.length.max(1e-3));
        let axis = |channel: u32| {
            (0.75 * noise(seed, channel, t) + 0.25 * noise(seed, channel + 7, t * 2.3)) * strength
        };
        (
            axis(1) * amount * along_x,
            axis(2) * amount * along_y,
            axis(3) * shake.rotation,
        )
    };
    let (x, y, rotation) = at(0.0);
    let (from_x, from_y, from_rotation) = at(shake.motion_blur.max(0.0) * time.frame);
    let zoom = match shake.edges {
        ShakeEdges::Mirror => 1.0,
        // Cover the furthest it can go, so the zoom holds steady while it moves.
        ShakeEdges::Zoom => {
            let (w, h) = (width.max(1) as f32, height.max(1) as f32);
            let turn = shake.rotation.abs().to_radians();
            (turn.cos() + (w / h).max(h / w) * turn.sin())
                + 2.0 * (amount.abs() * along_x / w).max(amount.abs() * along_y / h)
        }
    };
    ShakeOffset {
        x,
        y,
        rotation,
        from_x,
        from_y,
        from_rotation,
        zoom,
        mirror: shake.edges == ShakeEdges::Mirror,
    }
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
        let &[from, to] = pair else { continue };
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
    /// Stretches silenced, in seconds of the source (see `Mute`).
    pub mutes: Vec<Mute>,
}

/// What's heard at `frame` (audio clips on unmuted tracks), only `media`'s if given.
fn heard(project: &Project, frame: i64, media: Option<&str>) -> Vec<WaveSource> {
    let fps = project.fps();
    project
        .clips
        .iter()
        .filter(|clip| clip.contains(frame))
        .filter(|clip| {
            project
                .track(&clip.track)
                .is_some_and(|track| track.kind == TrackKind::Audio && !track.muted)
        })
        .filter_map(|clip| {
            let ClipContent::Audio {
                media: source,
                source_in,
                speed,
                volume_db,
                ..
            } = &clip.content
            else {
                return None;
            };
            if media.is_some_and(|wanted| wanted != source) {
                return None;
            }
            let local = (frame - clip.start) as f32;
            let db = animated(clip, "volume_db", local, *volume_db);
            Some(WaveSource {
                media: source.clone(),
                time: source_in + (frame - clip.start) as f64 / fps * speed,
                speed: *speed,
                gain: 10f32.powf(db / 20.0) * fade_factor(clip, local),
                from: *source_in,
                to: source_in + clip.duration as f64 / fps * speed,
            })
        })
        .collect()
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
                mutes,
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
                mutes: mutes.clone(),
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
        TextPreset::None | TextPreset::Words | TextPreset::Word => (1.0, 0.0, 1.0),
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
            markers: Vec::new(),
            cloud: None,
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
                crop: Default::default(),
                frame: None,
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
                gradient: None,
            },
        });
        project
    }

    #[test]
    fn blur_strength_and_region_follow_keyframes() {
        let mut project = project();
        let key = |frame: f32, value: f32| Keyframe {
            frame,
            value,
            ease: Ease::Linear,
            handle_in: None,
            handle_out: None,
        };
        let Some(clip) = project.clips.get_mut(1) else {
            panic!("no clip");
        };
        clip.content = ClipContent::Adjustment {
            grade: Grade::default(),
            shake: Shake::default(),
            glitch: Glitch::default(),
            blur: Blur {
                radius: 30.0,
                width: 200.0,
                height: 260.0,
                feather: 12.0,
                ..Blur::default()
            },
            opacity: 1.0,
        };
        clip.keyframes = [
            ("blur".to_owned(), vec![key(0.0, 0.0), key(10.0, 40.0)]),
            (
                "blur.x".to_owned(),
                vec![key(0.0, -100.0), key(20.0, 100.0)],
            ),
            ("blur.y".to_owned(), vec![key(0.0, 50.0), key(20.0, -50.0)]),
            (
                "blur.width".to_owned(),
                vec![key(0.0, 200.0), key(20.0, 300.0)],
            ),
        ]
        .into();
        assert!(project.validate().is_ok());
        let scene = evaluate(&project, 40);
        let blur = scene
            .layers
            .iter()
            .find_map(|layer| match layer {
                Layer::Adjustment { blur, .. } => Some(*blur),
                _ => None,
            })
            .unwrap();
        assert!((blur.radius - 40.0).abs() < 1e-4, "{blur:?}");
        assert!(blur.x.abs() < 1e-4 && blur.y.abs() < 1e-4, "{blur:?}");
        assert!((blur.width - 250.0).abs() < 1e-4, "{blur:?}");
        // Not keyed: as set.
        assert_eq!((blur.height, blur.feather), (260.0, 12.0));
        // Before the first key it holds the first value; keys can't make it negative.
        let Some(clip) = project.clips.get_mut(1) else {
            panic!("no clip");
        };
        clip.keyframes
            .insert("blur".to_owned(), vec![key(0.0, -5.0), key(10.0, 40.0)]);
        let scene = evaluate(&project, 30);
        assert!(scene.layers.iter().any(|layer| matches!(
            layer,
            Layer::Adjustment { blur, .. } if blur.radius == 0.0 && (blur.x + 100.0).abs() < 1e-4
        )));
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
    fn words_keep_the_whole_line_laid_out() {
        let mut project = project();
        project.clips[1].keyframes = Default::default();
        project.clips[1].content = ClipContent::Text {
            text: "So, did you".into(),
            style: TextStyle::default(),
            transform: Transform::default(),
            animation: TextAnimation {
                preset: TextPreset::Words,
                duration: 12.0,
                stagger: 4.0,
            },
            opacity: 1.0,
            word_times: vec![0.0, 10.0, 12.0],
        };
        let shown = |frame| {
            evaluate(&project, frame)
                .layers
                .into_iter()
                .find_map(|layer| match layer {
                    Layer::Text {
                        text, shown_glyphs, ..
                    } => Some((text, shown_glyphs)),
                    _ => None,
                })
        };
        // The clip starts at 30: the first word, then two, the full text throughout.
        let word = |frame| {
            let mut project = project.clone();
            if let ClipContent::Text { animation, .. } = &mut project.clips[1].content {
                animation.preset = TextPreset::Word;
            }
            evaluate(&project, frame)
                .layers
                .into_iter()
                .find_map(|layer| match layer {
                    Layer::Text { text, .. } => Some(text),
                    _ => None,
                })
        };
        assert_eq!(word(30).as_deref(), Some("So,"));
        assert_eq!(word(40).as_deref(), Some("did"));
        assert_eq!(word(45).as_deref(), Some("you"));
        assert_eq!(shown(30), Some(("So, did you".into(), Some(3))));
        assert_eq!(shown(40), Some(("So, did you".into(), Some(6))));
        assert_eq!(shown(29), None);
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

    #[test]
    fn shake_presets_move_hard_with_blur_and_follow_their_envelope() {
        let frame = (1920, 1080);
        let at = |shake: &ShakeSettings, local: f32| {
            shake_offset(
                "c1",
                shake,
                ShakeTime {
                    seconds: 10.0 + local,
                    local,
                    length: 0.5,
                    frame: 1.0 / 30.0,
                },
                frame,
            )
        };
        // The vertical preset is a whip down through the cut at its middle: the
        // old shot drops away faster every frame, the new one comes in from
        // above, slowing to rest, and each frame is blurred along the drop.
        let vertical = Shake {
            preset: ShakePreset::Vertical,
            ..Shake::default()
        }
        .resolved();
        let whip = |index: u32| {
            shake_offset(
                "c1",
                &vertical,
                ShakeTime {
                    seconds: 10.0,
                    local: index as f32 / 30.0,
                    length: 6.0 / 30.0,
                    frame: 1.0 / 30.0,
                },
                frame,
            )
        };
        let mut last_step = 0.0_f32;
        for index in 0..6 {
            let shaken = whip(index);
            assert_eq!((shaken.x, shaken.from_x), (0.0, 0.0));
            assert!(shaken.mirror && shaken.zoom == 1.0);
            // The new shot settles the way the old one fell away, blur and all.
            let mirror = whip(5 - index);
            assert!((shaken.y + mirror.y).abs() < 1e-3);
            assert!((shaken.from_y + mirror.from_y).abs() < 1e-3);
            if index < 3 {
                assert!(shaken.y >= shaken.from_y, "blurred along the drop");
            }
            if (1..3).contains(&index) {
                let step = shaken.y - whip(index - 1).y;
                assert!(step > last_step, "only down, accelerating into the cut");
                last_step = step;
            }
        }
        let before = whip(2);
        let after = whip(3);
        assert!(before.y > vertical.amount * 0.5, "far down at the cut");
        assert!(whip(5).y.abs() < 5.0, "at rest by the end");
        assert!(
            before.y - before.from_y > 100.0 && after.from_y - after.y > 100.0,
            "a heavy streak either side of the cut: {}",
            before.y - before.from_y
        );
        // A wiggle lands somewhere new every frame rather than gliding.
        let earthquake = Shake {
            preset: ShakePreset::Earthquake,
            frequency: Some(30.0),
            ..Shake::default()
        }
        .resolved();
        let jumps: f32 = (1..15)
            .map(|i| {
                (at(&earthquake, i as f32 / 30.0).y - at(&earthquake, (i - 1) as f32 / 30.0).y)
                    .abs()
            })
            .sum::<f32>()
            / 14.0;
        assert!(jumps > earthquake.amount * 0.25, "{jumps}");
        // Built up, a wiggle rises into the end of the clip.
        let building = Shake {
            preset: ShakePreset::Earthquake,
            envelope: Some(ShakeEnvelope::Build),
            ..Shake::default()
        }
        .resolved();
        let early: f32 = (0..4).map(|i| at(&building, i as f32 / 30.0).y.abs()).sum();
        let late: f32 = (11..15)
            .map(|i| at(&building, i as f32 / 30.0).y.abs())
            .sum();
        assert!(late > early * 2.0);
        // An impact dies away; no motion blur means no streak.
        let impact = Shake {
            preset: ShakePreset::Impact,
            motion_blur: Some(0.0),
            ..Shake::default()
        }
        .resolved();
        let start = at(&impact, 0.02);
        assert_eq!((start.x, start.y), (start.from_x, start.from_y));
        assert!(at(&impact, 0.5).x.abs() < 1e-3);
        // A given number overrides the preset's; nothing at all is no shake.
        let custom = Shake {
            preset: ShakePreset::Vertical,
            amount: Some(4.0),
            ..Shake::default()
        };
        assert_eq!(custom.resolved().amount, 4.0);
        assert_eq!(custom.resolved().frequency, vertical.frequency);
        assert_eq!(
            at(&Shake::default().resolved(), 0.2),
            ShakeOffset::default()
        );
        // Zoomed edges cover the move.
        let handheld = Shake {
            preset: ShakePreset::Handheld,
            ..Shake::default()
        }
        .resolved();
        assert!((at(&handheld, 0.2).zoom - 1.0) * 1080.0 / 2.0 >= handheld.amount - 1e-3);
    }
}
