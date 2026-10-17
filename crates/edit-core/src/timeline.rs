//! Ripple edits across every track: taking a stretch of time out of the
//! timeline (`remove_time`) and playing a stretch faster (`speed_span`).
//! Both keep what's left lined up: clips cut by the span are split (media)
//! or shortened (graphics), keyframes stay with the picture they describe,
//! and the in/out points, segments and the script's clip links follow.

use std::collections::{HashMap, HashSet};

use crate::model::{Clip, ClipContent, Keyframe, Project, ScriptBlock};

/// What a ripple did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Rippled {
    /// Frames the timeline got shorter by.
    pub frames: i64,
    /// Clips deleted (wholly inside a removed span).
    pub deleted: usize,
    /// Clips split or shortened where the span cut them.
    pub cut: usize,
    /// Clips that moved left.
    pub moved: usize,
}

/// `[start, end)` played in `length` frames; the rest of the timeline after
/// it moves to follow.
#[derive(Clone, Copy, Debug)]
struct Warp {
    start: i64,
    end: i64,
    length: i64,
}

impl Warp {
    /// Where frame `frame` (may be fractional) ends up.
    fn at(&self, frame: f64) -> f64 {
        let (start, end) = (self.start as f64, self.end as f64);
        if frame <= start {
            frame
        } else if frame >= end {
            frame - (end - start - self.length as f64)
        } else {
            start + (frame - start) * self.length as f64 / (end - start)
        }
    }

    fn frame(&self, frame: i64) -> i64 {
        self.at(frame as f64).round() as i64
    }

    fn removes(&self) -> bool {
        self.length == 0
    }
}

fn is_media(clip: &Clip) -> bool {
    matches!(
        clip.content,
        ClipContent::Video { .. } | ClipContent::Audio { .. }
    )
}

/// Which piece of a split clip keeps its id and link.
#[derive(Clone, Copy, PartialEq)]
enum Keep {
    Left,
    Right,
}

/// The keys that still describe `from..=to` (frames relative to the clip):
/// the ones inside it and the nearest one either side, so the values in
/// between still come out the same.
fn keys_within(keys: &[Keyframe], from: f32, to: f32) -> Vec<Keyframe> {
    let first = keys.iter().rposition(|key| key.frame <= from).unwrap_or(0);
    let last = keys
        .iter()
        .position(|key| key.frame >= to)
        .unwrap_or(keys.len().saturating_sub(1));
    keys.get(first..=last.max(first))
        .unwrap_or_default()
        .to_vec()
}

/// Splits the media clips playing across `frame` (strictly inside them)
/// into a piece before it and one from it, the later one's source moved on.
/// Clips linked together split into pieces linked together. Returns how many
/// were split.
fn split_media(project: &mut Project, frame: i64, keep: Keep, hold: &HashSet<String>) -> usize {
    let fps = project.fps();
    let crossing: Vec<usize> = project
        .clips
        .iter()
        .enumerate()
        .filter(|(_, clip)| {
            is_media(clip) && !hold.contains(&clip.id) && clip.start < frame && clip.end() > frame
        })
        .map(|(index, _)| index)
        .collect();
    let mut links: HashMap<String, String> = HashMap::new();
    let mut pieces = Vec::new();
    for index in &crossing {
        let Some(clip) = project.clips.get(*index).cloned() else {
            continue;
        };
        let cut = frame - clip.start;
        let mut left = clip.clone();
        left.duration = cut;
        left.fade_out = 0;
        left.fade_in = left.fade_in.min(cut);
        left.keyframes = clip
            .keyframes
            .iter()
            .map(|(param, keys)| (param.clone(), keys_within(keys, 0.0, cut as f32)))
            .collect();
        let mut right = clip.clone();
        right.start = frame;
        right.duration = clip.duration - cut;
        right.fade_in = 0;
        right.fade_out = right.fade_out.min(right.duration);
        right.keyframes = clip
            .keyframes
            .iter()
            .map(|(param, keys)| {
                let kept = keys_within(keys, cut as f32, clip.duration as f32);
                let moved = kept
                    .into_iter()
                    .map(|key| Keyframe {
                        frame: key.frame - cut as f32,
                        ..key
                    })
                    .collect();
                (param.clone(), moved)
            })
            .collect();
        if let ClipContent::Video {
            source_in, speed, ..
        }
        | ClipContent::Audio {
            source_in, speed, ..
        } = &mut right.content
        {
            *source_in += cut as f64 / fps * *speed;
        }
        let fresh = project.fresh_id("c");
        let new_link = clip.link.as_ref().map(|link| {
            links
                .entry(link.clone())
                .or_insert_with(|| project.fresh_id("l"))
                .clone()
        });
        let other = match keep {
            Keep::Left => &mut right,
            Keep::Right => &mut left,
        };
        other.id = fresh;
        other.link = new_link;
        pieces.push((*index, left, right));
    }
    let count = pieces.len();
    for (index, left, right) in pieces {
        if let Some(slot) = project.clips.get_mut(index) {
            *slot = left;
        }
        project.clips.push(right);
    }
    count
}

/// Moves a clip that isn't split by the warp (anything outside it, media
/// wholly inside it, graphics anywhere): its start and end go where the warp
/// takes them and its keys and word times with them. Media wholly inside a
/// sped-up span plays faster to fit, unless `keep_speed` (music and sound
/// effects: they play on at their own speed, only shorter where the span
/// squeezes them). False when nothing of it is left.
fn warp_clip(clip: &mut Clip, warp: &Warp, keep_speed: bool) -> bool {
    let (old_start, old_duration) = (clip.start, clip.duration);
    let start = warp.frame(clip.start);
    let end = warp.frame(clip.end());
    if end <= start {
        return false;
    }
    clip.start = start;
    clip.duration = end - start;
    let removed_inside = |absolute: f64| {
        warp.removes() && absolute > warp.start as f64 && absolute < warp.end as f64
    };
    for keys in clip.keyframes.values_mut() {
        let mut moved: Vec<Keyframe> = Vec::with_capacity(keys.len());
        for key in keys.iter() {
            let absolute = old_start as f64 + f64::from(key.frame);
            if removed_inside(absolute) {
                continue;
            }
            // Keys beyond the clip's ends (kept so values inside interpolate
            // right) move with the end they're beyond.
            let frame = if key.frame < 0.0 {
                key.frame
            } else if key.frame > old_duration as f32 {
                key.frame - old_duration as f32 + clip.duration as f32
            } else {
                (warp.at(absolute) - start as f64) as f32
            };
            // Keys that land on one frame (either side of a removed span): the later one wins.
            while moved.last().is_some_and(|last| last.frame >= frame) {
                moved.pop();
            }
            moved.push(Keyframe { frame, ..*key });
        }
        *keys = moved;
    }
    clip.keyframes.retain(|_, keys| !keys.is_empty());
    if let ClipContent::Text { word_times, .. } = &mut clip.content {
        for time in word_times.iter_mut() {
            let absolute = old_start as f64 + f64::from(*time);
            *time = ((warp.at(absolute) - start as f64) as f32).max(0.0);
        }
    }
    if let ClipContent::Video { speed, .. } | ClipContent::Audio { speed, .. } = &mut clip.content {
        if clip.duration != old_duration && !keep_speed {
            *speed = (*speed * old_duration as f64 / clip.duration as f64).clamp(0.05, 20.0);
        }
    }
    clip.fade_in = clip.fade_in.min(clip.duration);
    clip.fade_out = clip.fade_out.min(clip.duration);
    true
}

/// Applies `warp` to the whole project; media crossing its edges is split
/// there first, so only what's inside the span changes. Clips in `hold` are
/// never split or sped: they move and shorten with the span.
fn ripple(project: &mut Project, warp: Warp, hold: &HashSet<String>) -> Rippled {
    if warp.end <= warp.start || warp.length < 0 || warp.length >= warp.end - warp.start {
        return Rippled::default();
    }
    let before: HashSet<String> = project.clips.iter().map(|clip| clip.id.clone()).collect();
    let mut cut = split_media(project, warp.start, Keep::Left, hold);
    cut += split_media(project, warp.end, Keep::Right, hold);
    let mut out = Rippled {
        frames: warp.end - warp.start - warp.length,
        cut,
        ..Rippled::default()
    };
    let clips = std::mem::take(&mut project.clips);
    for mut clip in clips {
        let (start, duration) = (clip.start, clip.duration);
        let original = before.contains(&clip.id);
        let inside_media = is_media(&clip) && clip.start >= warp.start && clip.end() <= warp.end;
        // Pieces of a split clip that are dropped count as its cut, not as deletions.
        let keep_speed = hold.contains(&clip.id);
        if (inside_media && warp.removes()) || !warp_clip(&mut clip, &warp, keep_speed) {
            out.deleted += usize::from(original);
            continue;
        }
        if clip.duration != duration && !is_media(&clip) {
            out.cut += 1;
        } else if original && clip.start < start && clip.duration == duration {
            out.moved += 1;
        }
        project.clips.push(clip);
    }
    if let Some(in_point) = &mut project.mark_in {
        *in_point = warp.frame(*in_point);
    }
    if let Some(out_point) = &mut project.mark_out {
        // Inclusive: the frame after it is what moves.
        *out_point = (warp.frame(*out_point + 1) - 1).max(project.mark_in.unwrap_or(0));
    }
    for segment in &mut project.segments {
        segment.start = warp.frame(segment.start);
        segment.end = warp.frame(segment.end);
    }
    project
        .segments
        .retain(|segment| segment.end > segment.start);
    // A link to a clip that's gone is dropped.
    let alive: HashSet<&str> = project.clips.iter().map(|clip| clip.id.as_str()).collect();
    if let Some(script) = &mut project.script {
        for block in &mut script.blocks {
            let links = match block {
                ScriptBlock::Footage { clip, .. } => vec![clip],
                ScriptBlock::Narration {
                    clip, voiceover, ..
                } => vec![clip, voiceover],
            };
            for link in links {
                if link.as_deref().is_some_and(|id| !alive.contains(id)) {
                    *link = None;
                }
            }
        }
    }
    out
}

/// Takes frames `[start, end)` out of the timeline, on every track: clips
/// wholly inside are deleted, media crossing it is cut so what's before and
/// after stays (the later piece's source moved on), graphics crossing it are
/// shortened, and everything after moves left by `end - start`.
pub fn remove_time(project: &mut Project, start: i64, end: i64) -> Rippled {
    ripple(
        project,
        Warp {
            start: start.max(0),
            end,
            length: 0,
        },
        &HashSet::new(),
    )
}

/// Plays frames `[start, end)` `speed` times faster: media inside the span
/// (split at its edges) speeds up, graphics and keyframes in it squeeze to
/// match, and everything after moves left by the frames saved.
pub fn speed_span(project: &mut Project, start: i64, end: i64, speed: f64) -> Rippled {
    speed_span_holding(project, start, end, speed, &HashSet::new())
}

/// `speed_span`, except that the clips in `hold` (the music and sound
/// effects over a sped voice-over) keep their speed: a bed plays on unbroken
/// and ends where the timeline now ends it, a sound effect moves with the
/// words. Sped with the rest, a bed jumped 10% in tempo for every cut-in.
pub fn speed_span_holding(
    project: &mut Project,
    start: i64,
    end: i64,
    speed: f64,
    hold: &HashSet<String>,
) -> Rippled {
    if !(speed.is_finite() && speed > 1.0) || end <= start {
        return Rippled::default();
    }
    let length = ((end - start) as f64 / speed).round() as i64;
    ripple(
        project,
        Warp {
            start: start.max(0),
            end,
            length: length.max(1),
        },
        hold,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Ease, Media, MediaKind, Script, Settings};
    use serde_json::json;

    fn clip(value: serde_json::Value) -> Clip {
        serde_json::from_value(value).unwrap()
    }

    fn project() -> Project {
        let mut project = Project::new("p".into(), "t".into(), Settings::default());
        project.media.push(Media {
            id: "m".into(),
            name: "bodycam".into(),
            path: "/tmp/b.mp4".into(),
            kind: MediaKind::Video,
            duration: 600.0,
            width: 1920,
            height: 1080,
            fps: 30.0,
            has_audio: true,
            markers: Vec::new(),
            cloud: None,
        });
        let (v1, v2, a1) = (
            project.tracks[0].id.clone(),
            project.tracks[1].id.clone(),
            project.tracks[3].id.clone(),
        );
        project.clips = vec![
            // Picture and sound of one shot, 0..300, crossing the span 100..160.
            clip(
                json!({ "id": "pic", "track": v1, "start": 0, "duration": 300, "link": "l",
                "fade_in": 10, "fade_out": 10, "type": "video", "media": "m", "source_in": 5.0, "speed": 2.0,
                "keyframes": { "scale": [
                    { "frame": 0, "value": 1.0, "ease": "linear" },
                    { "frame": 200, "value": 2.0, "ease": "linear" } ] } }),
            ),
            clip(
                json!({ "id": "snd", "track": a1, "start": 0, "duration": 300, "link": "l",
                "type": "audio", "media": "m", "source_in": 5.0, "speed": 2.0 }),
            ),
            // A title wholly inside the span, a callout crossing its end, one after it.
            clip(
                json!({ "id": "inside", "track": v2, "start": 110, "duration": 30, "type": "text", "text": "gone" }),
            ),
            clip(
                json!({ "id": "crossing", "track": v2, "start": 150, "duration": 40, "type": "text", "text": "kept",
                "word_times": [0.0, 20.0],
                "keyframes": { "opacity": [
                    { "frame": 0, "value": 0.0, "ease": "linear" },
                    { "frame": 30, "value": 1.0, "ease": "linear" } ] } }),
            ),
            clip(
                json!({ "id": "after", "track": v2, "start": 200, "duration": 20, "type": "solid", "fill": [0, 0, 0, 1] }),
            ),
        ];
        project.mark_in = Some(20);
        project.mark_out = Some(250);
        project.script = Some(Script {
            source: None,
            blocks: vec![ScriptBlock::Narration {
                text: "x".into(),
                notes: Vec::new(),
                clip: Some("inside".into()),
                voiceover: Some("snd".into()),
            }],
        });
        project
    }

    fn value_at(project: &Project, id: &str, param: &str, frame: f32) -> f32 {
        let keys = &project.clip(id).unwrap().keyframes[param];
        crate::eval::sample(keys, frame).unwrap()
    }

    #[test]
    fn removing_time_cuts_deletes_and_moves_on_every_track() {
        let mut p = project();
        let before = value_at(&p, "pic", "scale", 170.0);
        let done = remove_time(&mut p, 100, 160);
        assert_eq!(done.frames, 60);
        assert_eq!(done.deleted, 1);
        p.validate().unwrap();
        // The shot: a piece before the span and one after it, joined up.
        let pic = p.clip("pic").unwrap();
        assert_eq!(
            (pic.start, pic.duration, pic.fade_in, pic.fade_out),
            (0, 100, 10, 0)
        );
        let later: Vec<&Clip> = p
            .clips
            .iter()
            .filter(|clip| clip.start == 100 && is_media(clip))
            .collect();
        assert_eq!(later.len(), 2);
        for piece in &later {
            assert_eq!(piece.duration, 140);
            assert_eq!(piece.fade_in, 0);
            let (ClipContent::Video { source_in, .. } | ClipContent::Audio { source_in, .. }) =
                piece.content
            else {
                panic!()
            };
            // 160 frames in at 2x speed: 5 + 160 / 30 * 2.
            assert!((source_in - (5.0 + 160.0 / 30.0 * 2.0)).abs() < 1e-9);
            assert_ne!(piece.link.as_deref(), Some("l"));
        }
        assert_eq!(later[0].link, later[1].link);
        // The later piece's keys still describe the same picture.
        let piece = later.iter().find(|clip| clip.track == pic.track).unwrap();
        assert!((value_at(&p, &piece.id, "scale", 10.0) - before).abs() < 1e-4);
        // The title inside is gone; the callout lost the part in the span.
        assert!(p.clip("inside").is_none());
        let crossing = p.clip("crossing").unwrap();
        assert_eq!((crossing.start, crossing.duration), (100, 30));
        let ClipContent::Text { word_times, .. } = &crossing.content else {
            panic!()
        };
        assert_eq!(word_times, &[0.0, 10.0]);
        assert_eq!(p.clip("after").unwrap().start, 140);
        assert_eq!((p.mark_in, p.mark_out), (Some(20), Some(190)));
        // The script's link to the deleted title is dropped; the sound keeps its id.
        let Some(ScriptBlock::Narration {
            clip, voiceover, ..
        }) = p.script.as_ref().unwrap().blocks.first()
        else {
            panic!()
        };
        assert_eq!((clip.as_deref(), voiceover.as_deref()), (None, Some("snd")));
    }

    #[test]
    fn removing_from_a_clips_start_keeps_its_id() {
        let mut p = project();
        remove_time(&mut p, 0, 30);
        p.validate().unwrap();
        let pic = p.clip("pic").unwrap();
        assert_eq!((pic.start, pic.duration), (0, 270));
        let ClipContent::Video { source_in, .. } = pic.content else {
            panic!()
        };
        assert!((source_in - 7.0).abs() < 1e-9);
        assert_eq!(pic.link.as_deref(), Some("l"));
        assert_eq!(p.clip("snd").unwrap().link.as_deref(), Some("l"));
        // A span before everything only moves things.
        let mut p = project();
        p.clips.retain(|clip| clip.start >= 110);
        for clip in &mut p.clips {
            clip.start += 100;
        }
        let done = remove_time(&mut p, 0, 50);
        assert_eq!((done.deleted, done.cut, done.moved), (0, 0, 3));
        assert_eq!(p.clip("inside").unwrap().start, 160);
    }

    #[test]
    fn keys_inside_a_removed_span_go() {
        let mut p = project();
        p.clips.retain(|clip| clip.id == "crossing");
        // Removing 160..170 out of the callout (150..190): the fade-in key at 180 (30) moves to 170 (20).
        remove_time(&mut p, 160, 170);
        let crossing = p.clip("crossing").unwrap();
        assert_eq!(crossing.duration, 30);
        let frames: Vec<f32> = crossing.keyframes["opacity"]
            .iter()
            .map(|key| key.frame)
            .collect();
        assert_eq!(frames, vec![0.0, 20.0]);
        assert_eq!(crossing.keyframes["opacity"][0].ease, Ease::Linear);
        p.validate().unwrap();
    }

    #[test]
    fn speeding_a_span_squeezes_it_and_moves_the_rest() {
        let mut p = project();
        let done = speed_span(&mut p, 100, 160, 1.2);
        // 60 frames in 50.
        assert_eq!(done.frames, 10);
        p.validate().unwrap();
        let sped: Vec<&Clip> = p
            .clips
            .iter()
            .filter(|clip| clip.start == 100 && is_media(clip))
            .collect();
        assert_eq!(sped.len(), 2);
        for piece in &sped {
            assert_eq!(piece.duration, 50);
            let (ClipContent::Video { speed, .. } | ClipContent::Audio { speed, .. }) =
                piece.content
            else {
                panic!()
            };
            assert!((speed - 2.4).abs() < 1e-9);
        }
        // After the span, the shot plays on where it would have: 160 frames in.
        let after: Vec<&Clip> = p
            .clips
            .iter()
            .filter(|clip| clip.start == 150 && is_media(clip))
            .collect();
        assert_eq!(after.len(), 2);
        let (ClipContent::Video { source_in, .. } | ClipContent::Audio { source_in, .. }) =
            after[0].content
        else {
            panic!()
        };
        assert!((source_in - (5.0 + 160.0 / 30.0 * 2.0)).abs() < 1e-9);
        // Graphics in it squeeze; the title 110..140 becomes 108..133.
        let inside = p.clip("inside").unwrap();
        assert_eq!((inside.start, inside.end()), (108, 133));
        let crossing = p.clip("crossing").unwrap();
        assert_eq!((crossing.start, crossing.end()), (142, 180));
        assert_eq!(p.clip("after").unwrap().start, 190);
        assert_eq!(p.mark_out, Some(240));
    }

    #[test]
    fn segments_follow_a_ripple() {
        let mut p = project();
        p.segments = vec![
            crate::model::Segment {
                start: 0,
                end: 120,
                kind: crate::model::SegmentKind::Footage,
                note: String::new(),
            },
            crate::model::Segment {
                start: 120,
                end: 150,
                kind: crate::model::SegmentKind::Narration,
                note: String::new(),
            },
            crate::model::Segment {
                start: 150,
                end: 300,
                kind: crate::model::SegmentKind::Footage,
                note: String::new(),
            },
        ];
        remove_time(&mut p, 100, 160);
        p.validate().unwrap();
        let spans: Vec<(i64, i64)> = p.segments.iter().map(|s| (s.start, s.end)).collect();
        assert_eq!(spans, vec![(0, 100), (100, 240)]);
    }
}
