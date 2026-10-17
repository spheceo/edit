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

/// Words too common to tie a quote to the moment it's spoken.
const COMMON: &[&str] = &[
    "about",
    "after",
    "again",
    "always",
    "been",
    "because",
    "before",
    "being",
    "could",
    "didn't",
    "does",
    "doesn't",
    "doing",
    "don't",
    "even",
    "every",
    "from",
    "going",
    "gonna",
    "have",
    "here",
    "it's",
    "just",
    "know",
    "like",
    "little",
    "made",
    "make",
    "maybe",
    "much",
    "never",
    "nothing",
    "okay",
    "only",
    "really",
    "said",
    "says",
    "should",
    "some",
    "something",
    "still",
    "that",
    "that's",
    "their",
    "them",
    "then",
    "there",
    "there's",
    "these",
    "they",
    "they're",
    "thing",
    "think",
    "this",
    "those",
    "very",
    "wanna",
    "want",
    "well",
    "were",
    "what",
    "what's",
    "when",
    "where",
    "which",
    "while",
    "with",
    "would",
    "yeah",
    "your",
    "you're",
];

/// Words that say nothing about which line is meant, even two together.
const SLIGHT: &[&str] = &[
    "a", "an", "and", "the", "to", "of", "in", "on", "or", "it", "is", "at",
];

/// A word as compared: lower case, letters and digits only, its ending
/// taken off ("mopped", "mopping" → "mopp").
fn stem(word: &str) -> String {
    let word: String = word
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '\'')
        .collect();
    let word = word.trim_matches('\'').to_owned();
    for ending in ["ing", "ed", "es", "s"] {
        if let Some(root) = word.strip_suffix(ending) {
            if root.chars().count() >= 3 {
                return root.to_owned();
            }
        }
    }
    word
}

/// Whether a text clip is a quote callout: words in quotation marks on
/// screen, not a subtitle or a speaker caption.
fn is_quote(project: &Project, clip: &edit_core::Clip) -> Option<String> {
    let ClipContent::Text { text, .. } = &clip.content else {
        return None;
    };
    if project
        .track(&clip.track)
        .is_some_and(|track| track.subtitles)
        || clip
            .name
            .as_deref()
            .is_some_and(|name| name.starts_with("Subtitle") || name.starts_with("Caption"))
    {
        return None;
    }
    let text = text.trim();
    let quoted = (text.starts_with('“') || text.starts_with('"'))
        && (text.ends_with('”') || text.ends_with('"'));
    quoted.then(|| text.to_owned())
}

/// Quote callouts away from the words that point to them: a callout whose
/// telling words (not "like", "something") are heard within 10 s of it, in
/// the narration or the footage, but none while it's on screen (half a
/// second either side). Mom & Teen's "Like they mopped or something?" rose
/// 1.6 s after the narration's "mopped", over "out the back door".
pub fn callout_timing(project: &Project, transcripts: &HashMap<String, Transcript>) -> Vec<Value> {
    let fps = project.fps();
    // Every word heard on the timeline: (frame, stem).
    let mut heard: Vec<(i64, String)> = Vec::new();
    for clip in &project.clips {
        let ClipContent::Audio {
            media,
            source_in,
            speed,
            ..
        } = &clip.content
        else {
            continue;
        };
        if project.track(&clip.track).is_some_and(|track| track.muted) {
            continue;
        }
        let Some(transcript) = transcripts.get(media) else {
            continue;
        };
        let to = source_in + clip.duration as f64 / fps * speed;
        for word in &transcript.words {
            let middle = (word.start + word.end) / 2.0;
            if middle < *source_in || middle >= to {
                continue;
            }
            let frame = clip.start + ((middle - source_in) / speed * fps).round() as i64;
            heard.push((frame, stem(&word.text)));
        }
    }
    let near = (0.5 * fps).round() as i64;
    let around = (10.0 * fps).round() as i64;
    let mut issues = Vec::new();
    for clip in &project.clips {
        let Some(text) = is_quote(project, clip) else {
            continue;
        };
        let telling: Vec<String> = text
            .split_whitespace()
            .filter(|word| !word.contains('*'))
            .map(stem)
            .filter(|word| word.chars().count() >= 4 && !COMMON.contains(&word.as_str()))
            .collect();
        if telling.is_empty() {
            continue;
        }
        let said = |from: i64, to: i64| -> Vec<i64> {
            heard
                .iter()
                .filter(|(frame, word)| *frame >= from && *frame < to && telling.contains(word))
                .map(|(frame, _)| *frame)
                .collect()
        };
        if !said(clip.start - near, clip.end() + near).is_empty() {
            continue;
        }
        // The narration under it paraphrasing it ("she thought her mother
        // was" under "I think she was pregnant") shares a few of its words.
        let words: Vec<String> = text
            .split_whitespace()
            .map(stem)
            .filter(|word| word.chars().count() >= 2 && !SLIGHT.contains(&word.as_str()))
            .collect();
        let mut shared: Vec<&String> = heard
            .iter()
            .filter(|(frame, word)| {
                *frame >= clip.start - near && *frame < clip.end() + near && words.contains(word)
            })
            .map(|(_, word)| word)
            .collect();
        shared.sort();
        shared.dedup();
        if shared.len() >= 2 {
            continue;
        }
        let nearby = said(clip.start - around, clip.end() + around);
        if let Some(at) = nearby
            .iter()
            .min_by_key(|frame| (*frame - clip.start).abs())
        {
            issues.push(
                json!({"kind":"callout_off_speech", "clip":clip.id, "start":clip.start,
                "said_at":at, "text":text}),
            );
        }
    }
    issues
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcribe::Word;
    use edit_core::MediaKind;
    use edit_engine::censor;
    use std::path::{Path, PathBuf};

    /// Audits a real project read-only (its media cache read, results kept
    /// in a temp folder): `EDIT_AUDIT_PROJECT=<project.json>
    /// EDIT_AUDIT_CACHE=<~/.edit/cache> cargo test -p edit
    /// edit_review::tests::audit_a_real_project -- --ignored --nocapture`.
    #[test]
    #[ignore = "reads a real project and its media"]
    fn audit_a_real_project() {
        let project: Project = serde_json::from_slice(
            &std::fs::read(std::env::var("EDIT_AUDIT_PROJECT").unwrap()).unwrap(),
        )
        .unwrap();
        let cache = PathBuf::from(std::env::var("EDIT_AUDIT_CACHE").unwrap());
        let scratch = std::env::temp_dir().join(format!("edit-audit-{}", std::process::id()));
        let mut transcripts = HashMap::new();
        // A file on the media drive is keyed by its place in the data folder.
        let drive = std::env::var("EDIT_AUDIT_MEDIA_DIR")
            .ok()
            .map(PathBuf::from);
        let home = cache.parent().map(Path::to_path_buf).unwrap_or_default();
        for media in &project.media {
            let source = Path::new(&media.path);
            let name = drive
                .as_ref()
                .and_then(|drive| source.strip_prefix(drive).ok())
                .map_or_else(|| source.to_path_buf(), |rest| home.join(rest));
            let key = cache.join(edit_engine::media::key_of(&name, source));
            if let Ok(bytes) = std::fs::read(key.join("transcript.json")) {
                if let Ok(transcript) = serde_json::from_slice(&bytes) {
                    transcripts.insert(media.id.clone(), transcript);
                }
            }
            if media.kind == MediaKind::Video
                && source.is_file()
                && std::env::var_os("EDIT_AUDIT_SKIP_CENSOR").is_none()
            {
                let seconds = censor::analyse(&cache, source).unwrap();
                let path = censor::file(&scratch, source);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(&path, &seconds).unwrap();
                let censored = seconds.iter().filter(|&&second| second == 1).count();
                eprintln!(
                    "{} {}: {censored} of {} s censored",
                    media.id,
                    media.name,
                    seconds.len()
                );
            }
        }
        let (issues, waiting) = censor::issues(&project, &scratch, false);
        eprintln!("censored: {issues:#?} waiting {waiting:?}");
        eprintln!("callouts: {:#?}", callout_timing(&project, &transcripts));
        let _ = std::fs::remove_dir_all(scratch);
    }

    #[test]
    fn a_callout_after_its_words_were_said_is_flagged() {
        let mut p = Project::new("p".into(), "callouts".into(), Default::default());
        p.media.push(serde_json::from_value(json!({"id":"vo","name":"voice-over","path":"/vo.mp3","kind":"audio","duration":30.0,"has_audio":true})).unwrap());
        let words = |list: &[(&str, f64)]| Transcript {
            model: "test".into(),
            language: None,
            words: list
                .iter()
                .map(|(text, start)| Word {
                    text: (*text).into(),
                    start: *start,
                    end: start + 0.3,
                    speaker: None,
                })
                .collect(),
            speakers: Default::default(),
            roles: Default::default(),
            colors: Default::default(),
        };
        // "...a floor that looked freshly mopped (4.5 s), all pointed the same way, out the back door."
        let transcripts = HashMap::from([(
            "vo".to_owned(),
            words(&[
                ("floor", 3.3),
                ("freshly", 4.0),
                ("mopped", 4.5),
                ("same", 6.0),
                ("way", 6.3),
                ("back", 7.5),
                ("door.", 7.8),
            ]),
        )]);
        p.clips.push(serde_json::from_value(json!({"id":"voice","track":"a4","type":"audio","media":"vo","name":"Voice-over","start":0,"duration":600})).unwrap());
        // Up 1.6 s after "mopped": flagged. A plain caption isn't a quote.
        p.clips.push(serde_json::from_value(json!({"id":"late","track":"v2","type":"text","text":"“Like they mopped or something?”","start":185,"duration":78})).unwrap());
        p.clips.push(serde_json::from_value(json!({"id":"label","track":"v3","type":"text","text":"Freshly mopped","start":300,"duration":30})).unwrap());
        let issues = callout_timing(&p, &transcripts);
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert_eq!(issues[0]["said_at"], 140);
        // On the word, it's fine.
        p.clips[1].start = 130;
        assert!(callout_timing(&p, &transcripts).is_empty());
        // A quote nobody nearby says (the narration only points to it) is left to judgement.
        if let ClipContent::Text { text, .. } = &mut p.clips[1].content {
            *text = "“I knew her for years”".into();
        }
        p.clips[1].start = 400;
        assert!(callout_timing(&p, &transcripts).is_empty());
        // Said a moment before, but paraphrased under it ("she thought her
        // mother was" under "I think she was pregnant"): where it belongs.
        let transcripts = HashMap::from([(
            "vo".to_owned(),
            words(&[
                ("pregnant", 3.7),
                ("until", 4.2),
                ("she", 9.2),
                ("thought", 10.2),
                ("her", 10.4),
                ("mother", 10.5),
                ("was.", 10.8),
            ]),
        )]);
        if let ClipContent::Text { text, .. } = &mut p.clips[1].content {
            *text = "“I think she\nwas pregnant.”".into();
        }
        p.clips[1].start = 210;
        p.clips[1].duration = 142;
        assert!(callout_timing(&p, &transcripts).is_empty());
    }

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
