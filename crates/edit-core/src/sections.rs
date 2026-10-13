//! The parts of a scripted edit, found from where the script's blocks sit on
//! the timeline (nothing is marked by hand):
//!
//! - the intro: the teasers up to the "On <date>" cut-in that starts the
//!   story. Cut-ins inside it split it: one makes a two-split intro, two a
//!   three-split, and so on.
//! - the story: from that cut-in on.
//! - the outro: cut-ins after the last footage.
//!
//! Every cut-in is a B-roll spot, the intro's included.

use serde::Serialize;

use crate::{Media, MediaKind, Project, ScriptBlock};

/// Footage at least this long is the full footage that follows the intro (seconds).
const FULL_FOOTAGE: f64 = 20.0;

/// Audio this short is a sound effect, not something said (seconds).
const SOUND_EFFECT_SECONDS: f64 = 3.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SectionKind {
    Intro,
    /// A cut-in: where B-roll goes.
    Broll,
    Story,
    Outro,
}

/// A stretch of the timeline, in frames (`end` exclusive).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Section {
    pub kind: SectionKind,
    pub start: i64,
    pub end: i64,
    /// "Intro 1/2", "B-roll", "Story", "Outro".
    pub label: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Sections {
    /// Frames `[start, end)` of the intro, cut-ins included.
    pub intro: Option<(i64, i64)>,
    /// How many parts the intro's cut-ins split it into (1 when it has none).
    pub intro_splits: usize,
    pub outro: Option<(i64, i64)>,
    /// Back to back from the start of the edit to its end; empty without a script.
    pub parts: Vec<Section>,
}

/// One script block on the timeline.
struct Placed<'a> {
    cut_in: Option<&'a str>,
    start: i64,
    end: i64,
}

pub fn sections(project: &Project) -> Sections {
    let Some(script) = &project.script else {
        return Sections::default();
    };
    let mut blocks: Vec<Placed> = script
        .blocks
        .iter()
        .filter_map(|block| {
            let clip = match block {
                ScriptBlock::Footage { clip, .. } => {
                    clip.as_deref().and_then(|id| project.clip(id))
                }
                // The card, or its voice-over once the card is gone.
                ScriptBlock::Narration {
                    clip, voiceover, ..
                } => clip
                    .as_deref()
                    .and_then(|id| project.clip(id))
                    .or_else(|| voiceover.as_deref().and_then(|id| project.clip(id))),
            }?;
            let cut_in = match block {
                ScriptBlock::Footage { .. } => None,
                ScriptBlock::Narration { text, .. } => Some(text.as_str()),
            };
            Some(Placed {
                cut_in,
                start: clip.start,
                end: clip.end(),
            })
        })
        .collect();
    if blocks.is_empty() {
        return Sections::default();
    }
    blocks.sort_by_key(|block| block.start);
    let end = project.duration();

    // Cut-ins back to back are one card.
    let mut cards: Vec<(i64, i64)> = Vec::new();
    for block in blocks.iter().filter(|block| block.cut_in.is_some()) {
        match cards.last_mut() {
            Some(last) if block.start <= last.1 => last.1 = last.1.max(block.end),
            _ => cards.push((block.start, block.end)),
        }
    }

    let intro_end = intro_end(project, &blocks).filter(|&at| at > 0);
    let footage_end = blocks
        .iter()
        .filter(|block| block.cut_in.is_none())
        .map(|block| block.end)
        .max()
        .unwrap_or(0);
    let outro_start = cards
        .iter()
        .map(|card| card.0)
        .find(|&start| start >= footage_end && intro_end.is_none_or(|intro| start >= intro))
        .filter(|&start| start < end);

    let intro_cards = intro_end.map_or(0, |intro| {
        cards.iter().filter(|card| card.1 <= intro).count()
    });
    let splits = intro_cards + 1;
    let mut parts: Vec<Section> = Vec::new();
    let mut intro_part = 0;
    let mut push = |kind: SectionKind, start: i64, stop: i64| {
        let stop = stop.min(end);
        if stop <= start {
            return;
        }
        let label = match kind {
            SectionKind::Intro if splits > 1 => {
                intro_part += 1;
                format!("Intro {intro_part}/{splits}")
            }
            SectionKind::Intro => "Intro".to_owned(),
            SectionKind::Broll => "B-roll".to_owned(),
            SectionKind::Story => "Story".to_owned(),
            SectionKind::Outro => "Outro".to_owned(),
        };
        parts.push(Section {
            kind,
            start,
            end: stop,
            label,
        });
    };
    let between = |at: i64| match intro_end {
        Some(intro) if at < intro => SectionKind::Intro,
        _ => SectionKind::Story,
    };
    let mut cursor = 0;
    for &(start, stop) in &cards {
        if outro_start.is_some_and(|outro| start >= outro) {
            break;
        }
        push(between(cursor), cursor, start);
        push(SectionKind::Broll, start.max(cursor), stop);
        cursor = cursor.max(stop);
    }
    let story_end = outro_start.unwrap_or(end);
    push(between(cursor), cursor, story_end);
    if let Some(outro) = outro_start {
        push(SectionKind::Outro, outro, end);
    }

    Sections {
        intro: intro_end.map(|intro| (0, intro)),
        intro_splits: if intro_end.is_some() { splits } else { 0 },
        outro: outro_start.map(|outro| (outro, end)),
        parts,
    }
}

/// Where the story starts: the "On <date>" cut-in after the teasers; else the
/// cut-in(s) leading into the first full-length footage; else the first cut-in.
fn intro_end(project: &Project, blocks: &[Placed]) -> Option<i64> {
    let after_teasers = blocks
        .iter()
        .position(|block| block.cut_in.is_none())
        .unwrap_or(blocks.len());
    if let Some(card) = blocks
        .iter()
        .skip(after_teasers)
        .find(|block| block.cut_in.is_some_and(is_date_card))
    {
        return Some(card.start);
    }
    let full = (FULL_FOOTAGE * project.fps()).round() as i64;
    match blocks
        .iter()
        .position(|block| block.cut_in.is_none() && block.end - block.start >= full)
    {
        Some(index) => {
            // Back up over the cut-ins right before it.
            let leading = blocks
                .iter()
                .take(index)
                .rev()
                .take_while(|block| block.cut_in.is_some())
                .count();
            blocks.get(index - leading).map(|block| block.start)
        }
        None => blocks
            .iter()
            .find(|block| block.cut_in.is_some())
            .map(|block| block.start),
    }
}

const MONTHS: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

/// Narration that opens with a date: "On July 13, 2024, …", "In March 2021, …".
pub fn is_date_card(text: &str) -> bool {
    let lower = text.trim_start().to_lowercase();
    let Some(rest) = lower
        .strip_prefix("on ")
        .or_else(|| lower.strip_prefix("in "))
    else {
        return false;
    };
    rest.split_whitespace().take(5).any(|word| {
        let word = word.trim_matches(|c: char| !c.is_alphanumeric());
        let year = word.len() == 4
            && word.chars().all(|c| c.is_ascii_digit())
            && (word.starts_with("19") || word.starts_with("20"));
        let month = word.len() >= 3 && MONTHS.iter().any(|month| month.starts_with(word));
        year || month
    })
}

impl Media {
    /// A sound effect (a bundled sound, one from the team's library, or any
    /// very short audio): it's heard, never transcribed.
    pub fn is_sound_effect(&self) -> bool {
        self.kind == MediaKind::Audio
            && (self.duration <= SOUND_EFFECT_SECONDS || in_sfx_folder(&self.path))
    }
}

/// Bundled sounds are written to `<Edit's home>/sfx/` (crates/edit/src/sfx.rs),
/// the team library's sounds and music to `<Edit's home>/library/<music|sfx>/<checksum>/`
/// (library.rs).
fn in_sfx_folder(path: &str) -> bool {
    let mut parts = path.rsplit(['/', '\\']).skip(1);
    let parent = parts.next();
    parent == Some("sfx") || parts.nth(1) == Some("library")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn date_cards() {
        assert!(is_date_card(
            "On July 13, 2024, Kent police officers were dispatched"
        ));
        assert!(is_date_card("In March 2021, a man called 911"));
        assert!(is_date_card("on the night of Dec. 3rd"));
        assert!(is_date_card("On 4 September, police"));
        assert!(!is_date_card("This mother had absolutely no idea"));
        assert!(!is_date_card("In a car crash, perhaps"));
        assert!(!is_date_card("On the way home"));
    }

    /// A scripted edit: (cut-in text or None for footage, seconds) back to back at 30 fps.
    fn edit(blocks: &[(Option<&str>, i64)]) -> Project {
        let mut clips = Vec::new();
        let mut script = Vec::new();
        let mut at = 0;
        for (index, (cut_in, seconds)) in blocks.iter().enumerate() {
            let id = format!("c{index}");
            let duration = seconds * 30;
            clips.push(match cut_in {
                Some(_) => json!({"id": id, "track": "v1", "start": at, "duration": duration,
                    "type": "solid", "fill": [0.0, 0.0, 0.0, 1.0]}),
                None => json!({"id": id, "track": "v1", "start": at, "duration": duration,
                    "type": "video", "media": "m1", "source_in": 0.0}),
            });
            script.push(match cut_in {
                Some(text) => json!({"kind": "narration", "text": text, "clip": id}),
                None => json!({"kind": "footage", "url": "", "file": "f", "start": 0.0, "end": 1.0,
                    "label": "", "clip": id}),
            });
            at += duration;
        }
        serde_json::from_value(json!({
            "version": 1, "id": "p", "name": "t",
            "settings": {"width": 1920, "height": 1080, "fps": 30},
            "media": [{"id": "m1", "name": "a.mp4", "path": "/a.mp4", "kind": "video", "duration": 9999.0}],
            "tracks": [{"id": "v1", "kind": "video"}],
            "clips": clips,
            "script": {"blocks": script},
        }))
        .unwrap()
    }

    fn summary(sections: &Sections) -> Vec<(String, i64, i64)> {
        sections
            .parts
            .iter()
            .map(|part| (part.label.clone(), part.start / 30, part.end / 30))
            .collect()
    }

    #[test]
    fn a_two_split_intro_then_the_story_and_an_outro() {
        // Teasers, a cut-in, teasers, the date card, full footage, a cut-in, footage, the outro card.
        let project = edit(&[
            (None, 6),
            (None, 2),
            (Some("This mother had no idea"), 3),
            (None, 2),
            (None, 5),
            (Some("On July 13, 2024, police were called"), 3),
            (None, 63),
            (Some("The man was later identified"), 3),
            (None, 72),
            (Some("In the end, he was charged"), 3),
        ]);
        let sections = sections(&project);
        assert_eq!(sections.intro, Some((0, 18 * 30)));
        assert_eq!(sections.intro_splits, 2);
        assert_eq!(sections.outro, Some((159 * 30, 162 * 30)));
        assert_eq!(
            summary(&sections),
            [
                ("Intro 1/2".into(), 0, 8),
                ("B-roll".into(), 8, 11),
                ("Intro 2/2".into(), 11, 18),
                ("B-roll".into(), 18, 21),
                ("Story".into(), 21, 84),
                ("B-roll".into(), 84, 87),
                ("Story".into(), 87, 159),
                ("Outro".into(), 159, 162),
            ]
        );
    }

    #[test]
    fn without_a_date_card_the_intro_ends_before_the_full_footage() {
        let project = edit(&[
            (None, 4),
            (Some("A first card"), 3),
            (None, 4),
            (Some("A second card"), 3),
            (None, 5),
            (Some("Police arrived"), 3),
            (None, 40),
        ]);
        let sections = sections(&project);
        assert_eq!(sections.intro, Some((0, 19 * 30)));
        assert_eq!(sections.intro_splits, 3);
        assert_eq!(sections.outro, None);
        assert_eq!(sections.parts.last().unwrap().kind, SectionKind::Story);
    }

    #[test]
    fn in_and_out_points() {
        let mut project = edit(&[(None, 10)]);
        assert_eq!(project.in_out(), None);
        project.mark_in = Some(30);
        assert_eq!(project.in_out(), Some((30, 300)));
        // The out frame is in the span.
        project.mark_out = Some(89);
        assert_eq!(project.in_out(), Some((30, 90)));
        assert!(project.validate().is_ok());
        project.mark_in = Some(100);
        assert!(project.validate().is_err());
        project.mark_in = None;
        assert_eq!(project.in_out(), Some((0, 90)));
    }

    #[test]
    fn no_script_no_sections() {
        let mut project = edit(&[(None, 4)]);
        project.script = None;
        assert_eq!(sections(&project), Sections::default());
    }

    #[test]
    fn sound_effects() {
        let sound = |path: &str, duration: f64| {
            serde_json::from_value::<Media>(json!({"id": "s", "name": "s", "path": path,
                "kind": "audio", "duration": duration}))
            .unwrap()
        };
        assert!(sound("/Users/me/.edit/sfx/shutter-1a2b.wav", 0.17).is_sound_effect());
        assert!(sound("/Users/me/.edit/sfx/riser-9f.wav", 8.0).is_sound_effect());
        assert!(sound("/x/whoosh.wav", 1.2).is_sound_effect());
        assert!(sound(
            "/Users/me/.edit/library/music/0a1b2c3d4e5f/Drone.wav",
            240.0
        )
        .is_sound_effect());
        assert!(!sound("/x/library/voiceover.wav", 42.0).is_sound_effect());
        assert!(!sound("/x/voiceover.wav", 42.0).is_sound_effect());
    }
}
