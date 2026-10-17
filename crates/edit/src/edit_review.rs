//! Cached transcript coverage, so a model need not compare thousands of words
//! against hundreds of subtitle clips by hand. No transcription or paid calls.
use std::collections::HashMap;

use edit_core::{ClipContent, Project};
use serde_json::{json, Value};

use crate::transcribe::Transcript;

pub fn subtitle_coverage(project: &Project, transcripts: &HashMap<String, Transcript>) -> Value {
    let from = if project.script.is_some() {
        crate::captions::intro(project).map_or(0, |(_, end)| end)
    } else {
        0
    };
    let sound = crate::subtitles::footage_sound(project, from, project.duration());
    let spans: Vec<_> = project
        .clips
        .iter()
        .filter(|clip| {
            matches!(clip.content, ClipContent::Text { .. })
                && project
                    .track(&clip.track)
                    .is_some_and(|track| track.subtitles && !track.hidden)
        })
        .map(|clip| (clip.start, clip.end()))
        .collect();
    let mut checked = 0;
    let mut missing = Vec::new();
    let mut unavailable = Vec::new();
    for clip in sound {
        let ClipContent::Audio {
            media,
            source_in,
            speed,
            ..
        } = &clip.content
        else {
            continue;
        };
        let Some(transcript) = transcripts.get(media) else {
            unavailable.push(media.clone());
            continue;
        };
        let source_end = source_in + clip.duration as f64 / project.fps() * speed;
        for word in &transcript.words {
            let source = (word.start + word.end) / 2.0;
            if source < *source_in
                || source >= source_end
                || crate::subtitles::tokens(&word.text).is_empty()
            {
                continue;
            }
            let frame =
                (clip.start as f64 + (source - source_in) / speed * project.fps()).floor() as i64;
            if frame < from
                || project.segments.iter().any(|segment| {
                    segment.start <= frame
                        && frame < segment.end
                        && segment.kind != edit_core::SegmentKind::Footage
                })
            {
                continue;
            }
            let name = word
                .speaker
                .as_ref()
                .and_then(|id| transcript.speakers.get(id))
                .map_or("Speaker", String::as_str);
            let role = crate::subtitles::role_of(
                word.speaker
                    .as_ref()
                    .and_then(|id| transcript.roles.get(id)),
                name,
            );
            if crate::subtitles::hidden_role(&role) {
                continue;
            }
            checked += 1;
            if spans
                .iter()
                .any(|(start, end)| *start <= frame && frame < *end)
            {
                continue;
            }
            let start = clip.start as f64 / project.fps() + (word.start - source_in) / speed;
            let end = clip.start as f64 / project.fps() + (word.end - source_in) / speed;
            missing.push((
                start,
                end,
                clip.id.clone(),
                media.clone(),
                name.to_owned(),
                word.text.clone(),
            ));
        }
    }
    let count = missing.len();
    missing.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut groups: Vec<(f64, f64, String, String, String, String)> = Vec::new();
    for (start, end, clip, media, speaker, word) in missing {
        if let Some(last) = groups.last_mut().filter(|last| {
            last.2 == clip && last.4 == speaker && start - last.1 <= 0.5 && last.5.len() < 240
        }) {
            last.1 = last.1.max(end);
            last.5.push(' ');
            last.5.push_str(&word);
        } else {
            groups.push((start, end, clip, media, speaker, word));
        }
    }
    unavailable.sort();
    unavailable.dedup();
    let examples: Vec<_> = groups.iter().take(20).map(|(start,end,clip,media,speaker,words)| json!({"start":start,"end":end,"clip":clip,"media":media,"speaker":speaker,"words":words})).collect();
    json!({"checked_words":checked, "uncovered_words":count, "uncovered_spans":groups.len(), "examples_seconds":examples,
        "missing_transcripts":unavailable, "scope":"Temporal coverage of cached, visible footage speech after the intro; does not verify subtitle wording or speaker correctness."})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcribe::Word;

    #[test]
    fn coverage_reports_missing_speech_and_skips_hidden_roles_and_segments() {
        let mut p = Project::new("p".into(), "review".into(), Default::default());
        p.media.push(edit_core::Media {
            id: "m".into(),
            name: "source".into(),
            path: "/unused".into(),
            kind: edit_core::MediaKind::Video,
            duration: 10.0,
            width: 1920,
            height: 1080,
            fps: 30.0,
            has_audio: true,
            markers: vec![],
            cloud: None,
        });
        let a = p
            .tracks
            .iter()
            .find(|track| track.kind == edit_core::TrackKind::Audio)
            .unwrap()
            .id
            .clone();
        let v = p.add_track(edit_core::TrackKind::Video);
        p.tracks
            .iter_mut()
            .find(|track| track.id == v)
            .unwrap()
            .subtitles = true;
        p.clips = vec![
            serde_json::from_value(json!({"id":"audio","track":a,"type":"audio","media":"m","source_in":2,"speed":0.5,"start":0,"duration":300})).unwrap(),
            serde_json::from_value(json!({"id":"sub","track":v,"type":"text","text":"covered","start":0,"duration":60})).unwrap()
        ];
        let mut transcript = Transcript {
            model: "test".into(),
            language: None,
            words: vec![],
            speakers: Default::default(),
            roles: Default::default(),
            colors: Default::default(),
        };
        transcript.roles.insert("radio".into(), "dispatch".into());
        transcript.words = vec![
            Word {
                text: "covered".into(),
                start: 2.2,
                end: 2.4,
                speaker: None,
            },
            Word {
                text: "missing".into(),
                start: 3.5,
                end: 3.7,
                speaker: None,
            },
            Word {
                text: "radio".into(),
                start: 4.0,
                end: 4.2,
                speaker: Some("radio".into()),
            },
        ];
        let transcripts = HashMap::from([("m".into(), transcript)]);
        let review = subtitle_coverage(&p, &transcripts);
        assert_eq!(review["checked_words"], 2);
        assert_eq!(review["uncovered_words"], 1);
        assert_eq!(review["examples_seconds"][0]["words"], "missing");
        p.segments = vec![edit_core::Segment {
            start: 60,
            end: 300,
            kind: edit_core::SegmentKind::Narration,
            note: String::new(),
        }];
        assert_eq!(subtitle_coverage(&p, &transcripts)["uncovered_words"], 0);
    }
}
