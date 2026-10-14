//! Subtitled videos the way Repack makes them: every line said in the
//! footage, in the speaker's colour (Montserrat 48 on a 75% black box, soft
//! shadow, glow in the text's colour, bottom middle), held a second after its
//! last word unless the next starts first, one at a time; and the house
//! words muted in the sound (cosine ramps) and starred out on screen.
//!
//! The rules are Repack's (apps/web/src/domain/subtitles.ts: `subtitleCues`,
//! `muteSuggestions`, `shownCues`), ported number for number. Not ported:
//! people shown side by side when they talk over each other, subtitle
//! ranges, positions under faces, and review of each mute (all are muted).

use std::collections::{BTreeMap, HashMap};

use edit_core::{
    Clip, ClipColor, ClipContent, Glow, MediaKind, Mute, Project, Rgba, TextAlign, TextAnimation,
    TextBox, TextShadow, TextStyle, TrackKind, Transform,
};
use serde_json::{json, Value};

use crate::server::App;

/// The editors' word lists. Muted and starred out: "word = s**t" sets how
/// one is starred, otherwise its first letter stays ("f***").
pub const HOUSE_TERMS: [&str; 37] = [
    "fuck = f***",
    "fucking = f******",
    "bitch = b****",
    "bitches = b*****",
    "nigga = n****",
    "nigger",
    "ass = a**",
    "shit = s**t",
    "motherfucker = motherf*****",
    "motherfucking = motherf******",
    "cock",
    "choke",
    "dick",
    "neglect",
    "weed",
    "stab",
    "sex",
    "sexual",
    "grooming",
    "predator",
    "porn",
    "pornography",
    "strangulation",
    "suicide",
    "suicidal",
    "rape",
    "overdose",
    "abuse",
    "crack",
    "cocaine",
    "fentanyl",
    "meth",
    "methamphetamine",
    "heroin",
    "nude",
    "nudity",
    "masturbate",
];
/** Words whose sound is muted but which stay readable in the subtitles. */
pub const HOUSE_MUTE_ONLY: [&str; 7] = [
    "kill",
    "shot",
    "shoot",
    "drug",
    "drugs",
    "dead",
    "marijuana",
];
/// Muted and starred out too, only in a heavy neglect case.
pub const NEGLECT_TERMS: [&str; 11] = [
    "endangerment",
    "kick",
    "hit",
    "punch",
    "kill",
    "blood",
    "lashed",
    "whoop",
    "butt",
    "slap",
    "strangle",
];

/// A muted word is silenced from a little before it starts (ms).
const MUTE_LEAD_MS: f64 = 30.0;
/// And a little after it ends (Repack's default padding, ms).
const MUTE_PADDING_MS: f64 = 25.0;
/// A word timed as an instant was said over someone else, earlier than its
/// time: its mute reaches back to the speaker's word before, at most this far.
const COLLAPSED_REACH_MS: f64 = 1500.0;
/// How long a subtitle may stay after its last word, unless the next one starts first.
pub const DEFAULT_HOLD_MS: f64 = 1000.0;
/// Names the subtitle clips (as add_subtitles does), so either replaces the other.
const NAME: &str = "Subtitle";

/// A word of one clip's transcript, in ms of the source.
#[derive(Clone, Debug, PartialEq)]
pub struct TimedWord {
    pub text: String,
    pub start_ms: f64,
    pub end_ms: f64,
    pub speaker: Option<String>,
}

fn collapsed(word: &TimedWord) -> bool {
    word.end_ms - word.start_ms < 40.0
}

/// A subtitle: the words `words` of the clip's list.
#[derive(Clone, Debug, PartialEq)]
pub struct Cue {
    pub words: std::ops::Range<usize>,
    pub start_ms: f64,
    pub end_ms: f64,
    pub text: String,
    pub speaker: Option<String>,
}

/// Repack's `subtitleCues`: a new subtitle on a change of speaker, a pause
/// over 750 ms, past 3.5 s, or past 52 characters; and after a sentence ends.
pub fn segment(words: &[TimedWord]) -> Vec<Cue> {
    let mut cues = Vec::new();
    let mut group: std::ops::Range<usize> = 0..0;
    let flush = |group: &mut std::ops::Range<usize>, cues: &mut Vec<Cue>| {
        let Some(part) = words.get(group.clone()).filter(|part| !part.is_empty()) else {
            return;
        };
        let Some(first) = part.first() else {
            return;
        };
        cues.push(Cue {
            words: group.clone(),
            start_ms: first.start_ms.round(),
            end_ms: part
                .iter()
                .map(|word| word.end_ms)
                .fold(f64::MIN, f64::max)
                .round(),
            text: part
                .iter()
                .map(|word| word.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            speaker: first.speaker.clone(),
        });
        *group = group.end..group.end;
    };
    for (index, word) in words.iter().enumerate() {
        let part = words.get(group.clone()).unwrap_or_default();
        if let (Some(first), Some(last)) = (part.first(), part.last()) {
            let joined = part
                .iter()
                .map(|word| word.text.chars().count() + 1)
                .sum::<usize>()
                + word.text.chars().count();
            if word.speaker != first.speaker
                // The same pause that still joins a muted phrase, so one
                // never spans two subtitles.
                || word.start_ms - last.end_ms > 750.0
                || word.end_ms - first.start_ms > 3500.0
                || joined > 52
            {
                flush(&mut group, &mut cues);
            }
        }
        if group.is_empty() {
            group = index..index;
        }
        group.end = index + 1;
        if word.text.ends_with(['.', '!', '?']) {
            flush(&mut group, &mut cues);
        }
    }
    flush(&mut group, &mut cues);
    cues
}

/// Repack's tokeniser: /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu on lowercase text.
pub fn tokens(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.to_lowercase().chars().collect();
    let mut out = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        if !chars.get(at).is_some_and(|c| c.is_alphanumeric()) {
            at += 1;
            continue;
        }
        let start = at;
        while chars.get(at).is_some_and(|c| c.is_alphanumeric()) {
            at += 1;
        }
        if chars.get(at).is_some_and(|c| matches!(c, '\'' | '’'))
            && chars.get(at + 1).is_some_and(|c| c.is_alphabetic())
        {
            at += 1;
            while chars.get(at).is_some_and(|c| c.is_alphabetic()) {
                at += 1;
            }
        }
        out.push(chars.get(start..at).unwrap_or_default().iter().collect());
    }
    out
}

/// "shit = s**t" as the word and how it is starred; a plain word has no set form.
fn parse_term(entry: &str) -> (String, Option<String>) {
    let mut parts = entry.split('=').map(str::trim);
    let term = parts.next().unwrap_or_default().to_owned();
    let display = parts.next().filter(|display| !display.is_empty());
    (term, display.map(str::to_owned))
}

/// A word or phrase found to mute, in ms of the clip's source.
#[derive(Clone, Debug, PartialEq)]
pub struct Suggestion {
    pub term: String,
    /// Starred out in the subtitles as well as muted; `display` is its set form.
    pub starred: bool,
    pub display: Option<String>,
    /// The first word's index: the subtitle that has it shows it starred.
    pub word: usize,
    /// When its first word starts, unpadded.
    pub at_ms: f64,
    pub start_ms: f64,
    pub end_ms: f64,
}

/// Repack's `muteSuggestions` with the house lists (and the neglect list
/// when `neglect`): whole words and phrases, longest first, a phrase's words
/// from one speaker with no pause over 750 ms; muted from 30 ms before the
/// first word (further back for a word timed as an instant) to 25 ms after
/// the last, within `from_ms`..`to_ms`.
pub fn suggestions(
    words: &[TimedWord],
    neglect: bool,
    from_ms: f64,
    to_ms: f64,
) -> Vec<Suggestion> {
    let stream: Vec<(String, usize)> = words
        .iter()
        .enumerate()
        .flat_map(|(index, word)| {
            tokens(&word.text)
                .into_iter()
                .map(move |token| (token, index))
        })
        .collect();
    // A word on both lists is starred out.
    struct Listed {
        key: String,
        term: String,
        display: Option<String>,
        starred: bool,
        parts: Vec<String>,
    }
    let mut listed: Vec<Listed> = Vec::new();
    let mut add = |entry: &str, starred: bool| {
        let (term, display) = parse_term(entry);
        let parts = tokens(&term);
        let key = parts.join(" ");
        if parts.is_empty() {
            return;
        }
        let entry = Listed {
            key: key.clone(),
            term,
            display,
            starred,
            parts,
        };
        match listed.iter_mut().find(|known| known.key == key) {
            Some(known) if !known.starred => *known = entry,
            Some(_) => {}
            None => listed.push(entry),
        }
    };
    for entry in HOUSE_MUTE_ONLY {
        add(entry, false);
    }
    if neglect {
        for entry in NEGLECT_TERMS {
            add(entry, true);
        }
    }
    for entry in HOUSE_TERMS {
        add(entry, true);
    }
    listed.sort_by_key(|term| std::cmp::Reverse(term.parts.len()));
    let mut out = Vec::new();
    let mut i = 0;
    while i < stream.len() {
        for term in &listed {
            let Some(found) = stream.get(i..i + term.parts.len()) else {
                continue;
            };
            let fits = found.iter().enumerate().all(|(j, (token, index))| {
                if Some(token) != term.parts.get(j) {
                    return false;
                }
                let Some(previous) = j.checked_sub(1).and_then(|k| found.get(k)) else {
                    return true;
                };
                let (Some(word), Some(before)) = (words.get(*index), words.get(previous.1)) else {
                    return false;
                };
                word.speaker == before.speaker && word.start_ms - before.end_ms <= 750.0
            });
            if !fits {
                continue;
            }
            let (Some((_, first_index)), Some((_, last_index))) = (found.first(), found.last())
            else {
                continue;
            };
            let Some(first) = words.get(*first_index) else {
                continue;
            };
            let mut said_from = first.start_ms;
            if collapsed(first) {
                said_from = (first.start_ms - COLLAPSED_REACH_MS).max(0.0);
                for before in words.get(..*first_index).unwrap_or_default().iter().rev() {
                    if before.end_ms <= said_from {
                        break;
                    }
                    if before.speaker == first.speaker && !collapsed(before) {
                        said_from = before.end_ms;
                        break;
                    }
                }
            }
            let said_until = found
                .iter()
                .filter_map(|(_, index)| words.get(*index))
                .map(|word| word.end_ms)
                .fold(f64::MIN, f64::max);
            let start_ms = from_ms.max(said_from - MUTE_LEAD_MS).round();
            let end_ms = to_ms.min(said_until + MUTE_PADDING_MS).round();
            let last_end = words.get(*last_index).map_or(f64::MIN, |word| word.end_ms);
            if start_ms < end_ms && first.start_ms < to_ms && last_end > from_ms {
                out.push(Suggestion {
                    term: term.term.clone(),
                    starred: term.starred,
                    display: term.display.clone(),
                    word: *first_index,
                    at_ms: first.start_ms.round(),
                    start_ms,
                    end_ms,
                });
            }
            i += term.parts.len() - 1;
            break;
        }
        i += 1;
    }
    out
}

/// A word starred out, its first letter kept: "n****".
fn starred(word: &str) -> String {
    word.chars()
        .enumerate()
        .map(|(i, c)| if i == 0 { c } else { '*' })
        .collect()
}

/// A word's set form in the case it was written: "Shit" → "S**t".
fn in_case(display: &str, written: &str) -> String {
    let upper = written
        .chars()
        .next()
        .is_some_and(|c| c.to_uppercase().eq(std::iter::once(c)));
    let mut chars = display.chars();
    match chars.next() {
        Some(first) if upper => first.to_uppercase().chain(chars).collect(),
        _ => display.to_owned(),
    }
}

/// Where `term` is written in `text` as whole words with any punctuation or
/// spacing between them (Repack's `termPattern`): char ranges, in order.
fn term_spans(text: &[char], term: &str) -> Vec<std::ops::Range<usize>> {
    let parts: Vec<Vec<char>> = tokens(term)
        .iter()
        .map(|part| part.chars().collect())
        .collect();
    if parts.is_empty() {
        return Vec::new();
    }
    let lower: Vec<char> = text
        .iter()
        .map(|c| c.to_lowercase().next().unwrap_or(*c))
        .collect();
    let word = |at: usize| lower.get(at).is_some_and(|c| c.is_alphanumeric());
    let mut spans = Vec::new();
    let mut start = 0;
    'scan: while start < lower.len() {
        if start > 0 && word(start - 1) {
            start += 1;
            continue;
        }
        let mut at = start;
        for (n, part) in parts.iter().enumerate() {
            if n > 0 {
                let gap = at;
                while at < lower.len() && !word(at) {
                    at += 1;
                }
                if at == gap {
                    start += 1;
                    continue 'scan;
                }
            }
            if lower.get(at..at + part.len()) != Some(part.as_slice()) {
                start += 1;
                continue 'scan;
            }
            at += part.len();
        }
        if word(at) {
            start += 1;
            continue;
        }
        spans.push(start..at);
        start = at.max(start + 1);
    }
    spans
}

/// A subtitle's text with its starred terms starred out: their set form
/// ("f***") in the written case, else each word's first letter and stars.
pub fn star(text: &str, found: &[&Suggestion]) -> String {
    let mut chars: Vec<char> = text.chars().collect();
    let mut done: Vec<&str> = Vec::new();
    for suggestion in found.iter().filter(|s| s.starred) {
        if done.contains(&suggestion.term.as_str()) {
            continue;
        }
        done.push(&suggestion.term);
        let mut out: Vec<char> = Vec::with_capacity(chars.len());
        let mut at = 0;
        for span in term_spans(&chars, &suggestion.term) {
            out.extend(chars.get(at..span.start).unwrap_or_default());
            let written: String = chars.get(span.clone()).unwrap_or_default().iter().collect();
            match &suggestion.display {
                Some(display) => out.extend(in_case(display, &written).chars()),
                None => {
                    let mut run = String::new();
                    for c in written.chars() {
                        if c.is_alphanumeric() {
                            run.push(c);
                        } else {
                            out.extend(starred(&run).chars());
                            run.clear();
                            out.push(c);
                        }
                    }
                    out.extend(starred(&run).chars());
                }
            }
            at = span.end;
        }
        out.extend(chars.get(at..).unwrap_or_default());
        chars = out;
    }
    chars.into_iter().collect()
}

/// A subtitle on the timeline (ms), whoever says it.
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub start_ms: f64,
    pub end_ms: f64,
    pub text: String,
    /// Who says it (a key into the speakers).
    pub speaker: String,
}

/// Repack's `shownCues`, one at a time: each held `hold_ms` after its last
/// word but never past the next one's start or `until_ms`; one starting while
/// another is up waits for it; one left no time is dropped. Lines of `silent`
/// speakers (radio) are left out first and cut nothing short; lines of
/// `hidden` ones (the narrator too) still end the line before them, then go.
///
/// `together` (interrogations): people talking over each other are shown at
/// once. Each person's lines go one at a time; a line ends at the next one
/// that doesn't talk over it (the same person's, or anyone's starting after
/// it is said).
pub fn shown(
    lines: &[Line],
    hold_ms: f64,
    from_ms: f64,
    until_ms: f64,
    together: bool,
    silent: impl Fn(&str) -> bool,
    hidden: impl Fn(&str) -> bool,
) -> Vec<Line> {
    let mut cues: Vec<Line> = lines
        .iter()
        .filter(|line| line.start_ms < until_ms && line.end_ms > from_ms)
        .filter(|line| !line.text.trim().is_empty() && !silent(&line.speaker))
        .map(|line| Line {
            start_ms: line.start_ms.max(from_ms),
            end_ms: line.end_ms.min(until_ms),
            ..line.clone()
        })
        .collect();
    cues.sort_by(|a, b| {
        a.start_ms
            .total_cmp(&b.start_ms)
            .then(a.end_ms.total_cmp(&b.end_ms))
    });
    let mut next_start: Vec<Option<f64>> = vec![None; cues.len()];
    for i in (0..cues.len()).rev() {
        let following = match (cues.get(i), cues.get(i + 1)) {
            (Some(cue), Some(next)) if next.start_ms > cue.start_ms => Some(next.start_ms),
            _ => next_start.get(i + 1).copied().flatten(),
        };
        if let Some(slot) = next_start.get_mut(i) {
            *slot = following;
        }
    }
    let mut shown_until = 0.0f64;
    let mut speaker_until: HashMap<&str, f64> = HashMap::new();
    let mut out = Vec::new();
    for (i, cue) in cues.iter().enumerate() {
        if together {
            let tied = cues
                .iter()
                .skip(i + 1)
                .take_while(|next| next.start_ms == cue.start_ms)
                .any(|next| next.speaker == cue.speaker);
            let cut_at = cues
                .iter()
                .skip(i + 1)
                .find(|next| {
                    next.start_ms > cue.start_ms
                        && (next.speaker == cue.speaker || next.start_ms >= cue.end_ms)
                })
                .map_or(f64::INFINITY, |next| next.start_ms);
            let mut end_ms = (cue.end_ms + if tied { 0.0 } else { hold_ms })
                .min(until_ms)
                .min(cut_at);
            let start_ms = cue.start_ms.max(
                speaker_until
                    .get(cue.speaker.as_str())
                    .copied()
                    .unwrap_or(0.0),
            );
            if end_ms < start_ms {
                end_ms = start_ms;
            }
            speaker_until.insert(&cue.speaker, end_ms);
            out.push(Line {
                start_ms,
                end_ms,
                ..cue.clone()
            });
            continue;
        }
        let tied = cues
            .get(i + 1)
            .is_some_and(|next| next.start_ms == cue.start_ms);
        let mut end_ms = (cue.end_ms + if tied { 0.0 } else { hold_ms })
            .min(until_ms)
            .min(
                next_start
                    .get(i)
                    .copied()
                    .flatten()
                    .unwrap_or(f64::INFINITY),
            );
        let start_ms = cue.start_ms.max(shown_until);
        if end_ms < start_ms {
            end_ms = start_ms;
        }
        shown_until = shown_until.max(end_ms);
        out.push(Line {
            start_ms,
            end_ms,
            ..cue.clone()
        });
    }
    out.retain(|cue| cue.end_ms > cue.start_ms && !hidden(&cue.speaker));
    out
}

/// A voice's role: the one the transcript gives, else read from its name
/// (only what decides whether it shows: narrator or radio).
fn role_of(role: Option<&String>, name: &str) -> String {
    if let Some(role) = role {
        return role.clone();
    }
    let words: Vec<String> = tokens(name);
    let has = |list: &[&str]| words.iter().any(|word| list.contains(&word.as_str()));
    if has(&["narrator"]) {
        "narrator".into()
    } else if has(&["dispatch", "dispatcher", "radio", "scanner"]) {
        "dispatch".into()
    } else {
        "other".into()
    }
}

/// Repack's house style at this project's size, in `color`: Montserrat
/// SemiBold 48 on a 75% black box (padding 12 × 8), drop shadow 0.65 at 3 px
/// and 112°, size 6, blur 8, a glow in the text's own colour (0.5, radius
/// 46), as wide as 80% of the frame, bottom middle (y 90%).
pub fn house_style(width: u32, height: u32, color: Rgba) -> TextStyle {
    let k = height as f32 / 1080.0;
    TextStyle {
        font: "Montserrat".into(),
        weight: 600,
        size: (48.0 * k).round(),
        color,
        tracking: 0.0,
        line_height: 1.15,
        glow: Glow {
            enabled: true,
            color: None,
            radius: 46.0 * k,
            strength: 0.5,
        },
        max_width: Some((width as f32 * 0.8 - 24.0 * k).round()),
        background: Some(TextBox {
            color: Rgba::BLACK,
            opacity: 0.75,
            pad_x: 12.0 * k,
            pad_y: 8.0 * k,
            ..TextBox::default()
        }),
        shadow: Some(TextShadow {
            color: Rgba::BLACK,
            opacity: 0.65,
            distance: 3.0 * k,
            angle: 112.0,
            size: 6.0 * k,
            blur: 8.0 * k,
        }),
        label: None,
        leader: None,
        align: TextAlign::Center,
    }
}

pub struct Options {
    /// Timeline frames.
    pub from: i64,
    pub to: i64,
    pub neglect: bool,
    pub hold_ms: f64,
    /// People talking over each other shown together, stacked (interrogations).
    pub overlap: bool,
}

/// Between two subtitles stacked because their people talk at once, in 1080p pixels.
const STACK_GAP: f32 = 12.0;

/// About how tall a house-style subtitle's box is (project pixels): Montserrat
/// SemiBold averages ~0.58 em a character, wrapped at 80% of the frame.
fn box_height(text: &str, width: u32, k: f32) -> f32 {
    let size = 48.0 * k;
    let max_width = width as f32 * 0.8 - 24.0 * k;
    let lines: f32 = text
        .lines()
        .map(|line| {
            (line.chars().count() as f32 * 0.58 * size / max_width)
                .ceil()
                .max(1.0)
        })
        .sum::<f32>()
        .max(1.0);
    lines * size * 1.15 + 16.0 * k
}

/// One voice in the footage, for the summary and the subtitles' colour.
struct Voice {
    name: String,
    role: String,
    color: String,
}

/// Subtitles and mutes the Repack way for everything said in the footage
/// between `from` and `to`: replaces subtitles made before in that span (by
/// this or add_subtitles) and the mutes on the footage's sound there.
pub async fn repack_subtitles(
    app: &App,
    project_id: &str,
    options: Options,
) -> Result<Value, String> {
    let project = app.store.get(project_id).ok_or("no such project")?.project;
    let fps = project.fps();
    let Options {
        from,
        to,
        neglect,
        hold_ms,
        overlap,
    } = options;
    if to <= from {
        return Err("the span is empty".into());
    }
    let mut sound: Vec<&Clip> = footage_sound(&project, from, to);
    sound.sort_by_key(|clip| clip.start);
    let mut transcripts: HashMap<String, crate::transcribe::Transcript> = HashMap::new();
    let mut voices: BTreeMap<String, Voice> = BTreeMap::new();
    let mut lines: Vec<Line> = Vec::new();
    let mut mutes: HashMap<String, (f64, f64, Vec<Mute>)> = HashMap::new();
    let mut muted: Vec<Value> = Vec::new();
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
        let Some(media) = project.media(media) else {
            continue;
        };
        if !transcripts.contains_key(&media.id) {
            let transcript = crate::captions::transcript_of(app, media).await?;
            transcripts.insert(media.id.clone(), transcript);
        }
        let Some(transcript) = transcripts.get(&media.id) else {
            continue;
        };
        let visible_from = source_in + ((from.max(clip.start) - clip.start) as f64 / fps) * speed;
        let visible_to = source_in + ((to.min(clip.end()) - clip.start) as f64 / fps) * speed;
        let words: Vec<TimedWord> = transcript
            .words
            .iter()
            .filter(|word| word.start >= visible_from && word.end <= visible_to + 0.05)
            .map(|word| TimedWord {
                text: word.text.trim().to_owned(),
                start_ms: word.start * 1000.0,
                end_ms: word.end * 1000.0,
                speaker: word.speaker.clone(),
            })
            .filter(|word| !word.text.is_empty())
            .collect();
        let on_timeline = |source_ms: f64| {
            (clip.start as f64 / fps + (source_ms / 1000.0 - source_in) / speed) * 1000.0
        };
        let found = suggestions(&words, neglect, visible_from * 1000.0, visible_to * 1000.0);
        for cue in segment(&words) {
            let mine: Vec<&Suggestion> = found
                .iter()
                .filter(|suggestion| cue.words.contains(&suggestion.word))
                .collect();
            let voice = cue.speaker.clone().unwrap_or_else(|| "unknown".into());
            let key = format!("{}/{voice}", media.id);
            voices.entry(key.clone()).or_insert_with(|| {
                let name = transcript
                    .speakers
                    .get(&voice)
                    .cloned()
                    .unwrap_or_else(|| voice.clone());
                Voice {
                    role: role_of(transcript.roles.get(&voice), &name),
                    color: transcript
                        .colors
                        .get(&voice)
                        .cloned()
                        .unwrap_or_else(|| "#ffffff".into()),
                    name,
                }
            });
            lines.push(Line {
                start_ms: on_timeline(cue.start_ms),
                end_ms: on_timeline(cue.end_ms),
                text: star(&cue.text, &mine),
                speaker: key,
            });
        }
        let entry = mutes
            .entry(clip.id.clone())
            .or_insert((visible_from, visible_to, Vec::new()));
        for suggestion in &found {
            entry.2.push(Mute {
                from: suggestion.start_ms / 1000.0,
                to: suggestion.end_ms / 1000.0,
            });
            muted.push(json!({
                "term": suggestion.term,
                "time": (on_timeline(suggestion.at_ms) / 10.0).round() / 100.0,
                "starred": suggestion.starred,
                "clip": clip.id,
            }));
        }
    }
    let role = |key: &str| voices.get(key).map_or("other", |voice| voice.role.as_str());
    let shown = shown(
        &lines,
        hold_ms,
        from as f64 / fps * 1000.0,
        to as f64 / fps * 1000.0,
        overlap,
        |key| role(key) == "dispatch",
        |key| matches!(role(key), "dispatch" | "narrator"),
    );
    let (width, height) = (project.settings.width, project.settings.height);
    let frame = |ms: f64| (ms / 1000.0 * fps).round() as i64;
    let (live, (placed, skipped)) = app.store.update(project_id, "agent", |project| {
        // Stacked lines (overlap) go on tracks of their own under the
        // subtitles' track, made as needed; a re-run removes them by name.
        let mut tracks: Vec<String> = Vec::new();
        let stacked: Vec<String> = project
            .tracks
            .iter()
            .filter(|track| track.kind == TrackKind::Video && !track.subtitles)
            .filter(|track| {
                let mine = project.clips.iter().filter(|clip| clip.track == track.id);
                let mut mine = mine.peekable();
                mine.peek().is_some()
                    && mine.all(|clip| {
                        clip.name
                            .as_deref()
                            .is_some_and(|name| name.starts_with(NAME))
                    })
            })
            .map(|track| track.id.clone())
            .rev()
            .collect();
        project.clips.retain(|clip| {
            !(clip
                .name
                .as_deref()
                .is_some_and(|name| name.starts_with(NAME))
                && clip.start < to
                && clip.end() > from)
        });
        for clip in &mut project.clips {
            let Some((visible_from, visible_to, new)) = mutes.get(&clip.id) else {
                continue;
            };
            if let ClipContent::Audio { mutes, .. } = &mut clip.content {
                mutes.retain(|mute| mute.to <= *visible_from || mute.from >= *visible_to);
                mutes.extend(new.iter().copied());
                mutes.sort_by(|a, b| a.from.total_cmp(&b.from));
            }
        }
        tracks.push(project.subtitles_track());
        tracks.extend(stacked);
        let base_y = height as f32 * 0.4;
        let k = height as f32 / 1080.0;
        // Lines up now: when each ends (frames), its centre and box height.
        let mut open: Vec<(i64, f32, f32)> = Vec::new();
        let (mut placed, mut skipped) = (0, 0);
        for line in &shown {
            let start = frame(line.start_ms).max(from);
            let end = frame(line.end_ms).min(to);
            if end <= start {
                skipped += 1;
                continue;
            }
            let free = |project: &Project, track: &str| {
                !project
                    .clips
                    .iter()
                    .any(|clip| clip.track == track && clip.start < end && start < clip.end())
            };
            let track = match tracks.iter().find(|track| free(project, track)) {
                Some(track) => track.clone(),
                None if overlap => {
                    let id = project.add_track(TrackKind::Video);
                    tracks.push(id.clone());
                    id
                }
                None => {
                    skipped += 1;
                    continue;
                }
            };
            // Stacked: a line whose box would cover one already up goes above it.
            open.retain(|(until, _, _)| *until > start);
            let box_height = box_height(&line.text, width, k);
            let mut y = base_y;
            for _ in 0..=open.len() {
                let Some(&(_, over_y, over_height)) =
                    open.iter().find(|(_, other, other_height)| {
                        (y - other).abs() < (box_height + other_height) / 2.0 + STACK_GAP * k / 2.0
                    })
                else {
                    break;
                };
                y = over_y - over_height / 2.0 - STACK_GAP * k - box_height / 2.0;
            }
            open.push((end, y, box_height));
            let voice = voices.get(&line.speaker);
            let color = voice
                .and_then(|voice| crate::captions::hex(&voice.color))
                .unwrap_or(Rgba::WHITE);
            let who = voice.map_or("Speaker", |voice| voice.name.as_str());
            let id = project.fresh_id("c");
            project.clips.push(Clip {
                id,
                track: track.clone(),
                start,
                duration: end - start,
                color: ClipColor::Cyan,
                name: Some(format!("{NAME} · {who}")),
                link: None,
                fade_in: 0,
                fade_out: 0,
                keyframes: Default::default(),
                content: ClipContent::Text {
                    text: line.text.clone(),
                    style: house_style(width, height, color),
                    transform: Transform {
                        y,
                        ..Transform::default()
                    },
                    animation: TextAnimation::default(),
                    opacity: 1.0,
                    word_times: Vec::new(),
                },
            });
            placed += 1;
        }
        Ok((placed, skipped))
    })?;
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for line in &shown {
        *counts.entry(line.speaker.as_str()).or_default() += 1;
    }
    let speakers: Vec<Value> = voices
        .iter()
        .map(|(key, voice)| {
            json!({
                "voice": key,
                "name": voice.name,
                "role": voice.role,
                "color": voice.color,
                "lines": counts.get(key.as_str()).copied().unwrap_or(0),
                "shown": !matches!(voice.role.as_str(), "narrator" | "dispatch"),
            })
        })
        .collect();
    Ok(json!({
        "rev": live.rev,
        "subtitles": placed,
        "skipped": skipped,
        "speakers": speakers,
        "mutes": muted,
    }))
}

/// The footage's own sound in the span: audio clips of video files (not
/// music or sound effects) on tracks that are heard.
fn footage_sound(project: &Project, from: i64, to: i64) -> Vec<&Clip> {
    project
        .clips
        .iter()
        .filter(|clip| {
            project
                .track(&clip.track)
                .is_some_and(|track| track.kind == TrackKind::Audio && !track.muted)
                && clip.start < to
                && clip.end() > from
                && matches!(&clip.content, ClipContent::Audio { media, .. }
                    if project.media(media).is_some_and(|media| media.kind == MediaKind::Video && media.has_audio))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, start_ms: f64, end_ms: f64, speaker: &str) -> TimedWord {
        TimedWord {
            text: text.into(),
            start_ms,
            end_ms,
            speaker: Some(speaker.into()),
        }
    }

    fn texts(cues: &[Cue]) -> Vec<&str> {
        cues.iter().map(|cue| cue.text.as_str()).collect()
    }

    #[test]
    fn segments_at_speakers_pauses_length_and_sentences() {
        // A change of speaker.
        let cues = segment(&[
            word("Hi", 0.0, 200.0, "a"),
            word("there", 250.0, 400.0, "b"),
        ]);
        assert_eq!(texts(&cues), ["Hi", "there"]);
        // A pause of 750 ms joins; over it splits.
        let cues = segment(&[
            word("one", 0.0, 100.0, "a"),
            word("two", 850.0, 900.0, "a"),
            word("three", 1651.0, 1700.0, "a"),
        ]);
        assert_eq!(texts(&cues), ["one two", "three"]);
        // Past 3.5 s from the first word's start.
        let cues = segment(&[
            word("one", 0.0, 100.0, "a"),
            word("two", 700.0, 3500.0, "a"),
            word("three", 3600.0, 3501.0 + 100.0, "a"),
        ]);
        assert_eq!(texts(&cues), ["one two", "three"]);
        // Past 52 characters with the word.
        let long: Vec<TimedWord> = (0..12)
            .map(|i| {
                word(
                    "abcd",
                    f64::from(i) * 100.0,
                    f64::from(i) * 100.0 + 50.0,
                    "a",
                )
            })
            .collect();
        let cues = segment(&long);
        // Ten words are 49 characters, eleven 54.
        assert_eq!(
            cues.iter().map(|cue| cue.words.len()).collect::<Vec<_>>(),
            [10, 2]
        );
        // After a sentence ends.
        let cues = segment(&[
            word("Stop.", 0.0, 100.0, "a"),
            word("Now!", 150.0, 200.0, "a"),
            word("Why?", 250.0, 300.0, "a"),
            word("ok", 350.0, 400.0, "a"),
        ]);
        assert_eq!(texts(&cues), ["Stop.", "Now!", "Why?", "ok"]);
        assert_eq!((cues[1].start_ms, cues[1].end_ms), (150.0, 200.0));
    }

    fn line(start_ms: f64, end_ms: f64, speaker: &str) -> Line {
        Line {
            start_ms,
            end_ms,
            text: speaker.into(),
            speaker: speaker.into(),
        }
    }

    fn times(lines: &[Line]) -> Vec<(f64, f64, &str)> {
        lines
            .iter()
            .map(|line| (line.start_ms, line.end_ms, line.speaker.as_str()))
            .collect()
    }

    #[test]
    fn holds_a_second_one_at_a_time() {
        let none = |_: &str| false;
        // Held 1 s, unless the next starts first.
        let out = shown(
            &[
                line(0.0, 500.0, "a"),
                line(1000.0, 1500.0, "b"),
                line(5000.0, 5500.0, "a"),
            ],
            1000.0,
            0.0,
            6000.0,
            false,
            none,
            none,
        );
        assert_eq!(
            times(&out),
            [
                (0.0, 1000.0, "a"),
                (1000.0, 2500.0, "b"),
                (5000.0, 6000.0, "a")
            ]
        );
        // Two that start together: shown one after the other.
        let out = shown(
            &[line(0.0, 500.0, "a"), line(0.0, 800.0, "b")],
            1000.0,
            0.0,
            9000.0,
            false,
            none,
            none,
        );
        assert_eq!(times(&out), [(0.0, 500.0, "a"), (500.0, 1800.0, "b")]);
        // The narrator is hidden but still ends the line before; radio cuts nothing.
        let out = shown(
            &[
                line(0.0, 500.0, "a"),
                line(700.0, 900.0, "narrator"),
                line(800.0, 900.0, "radio"),
            ],
            1000.0,
            0.0,
            9000.0,
            false,
            |speaker| speaker == "radio",
            |speaker| speaker == "radio" || speaker == "narrator",
        );
        assert_eq!(times(&out), [(0.0, 700.0, "a")]);
    }

    #[test]
    fn shows_people_talking_over_each_other_together() {
        let none = |_: &str| false;
        // b starts while a is still talking: both up; a's held until b's
        // next line that starts after a is said, b's own next line cuts b.
        let out = shown(
            &[
                line(0.0, 2000.0, "a"),
                line(1000.0, 1500.0, "b"),
                line(1800.0, 2600.0, "b"),
                line(4000.0, 4500.0, "a"),
            ],
            1000.0,
            0.0,
            9000.0,
            true,
            none,
            none,
        );
        assert_eq!(
            times(&out),
            [
                (0.0, 3000.0, "a"),
                (1000.0, 1800.0, "b"),
                (1800.0, 3600.0, "b"),
                (4000.0, 5500.0, "a")
            ]
        );
    }

    #[test]
    fn box_heights_grow_with_wrapped_lines() {
        let one = box_height("Short line", 1920, 1.0);
        let two = box_height(&"word ".repeat(20), 1920, 1.0);
        assert!((one - (48.0 * 1.15 + 16.0)).abs() < 0.01);
        assert!(two > one * 1.5);
    }

    #[test]
    fn mutes_house_words_and_stars_them() {
        let words = [
            word("What", 0.0, 200.0, "a"),
            word("the", 250.0, 400.0, "a"),
            word("Fuck,", 450.0, 700.0, "a"),
            word("he's", 750.0, 900.0, "a"),
            word("dead.", 950.0, 1200.0, "a"),
            word("Motherfucker", 1300.0, 1800.0, "a"),
            word("neglect", 1900.0, 2300.0, "a"),
            word("hit", 2400.0, 2600.0, "a"),
        ];
        let found = suggestions(&words, false, 0.0, 10_000.0);
        let terms: Vec<(&str, bool)> = found.iter().map(|s| (s.term.as_str(), s.starred)).collect();
        assert_eq!(
            terms,
            [
                ("fuck", true),
                ("dead", false),
                ("motherfucker", true),
                ("neglect", true)
            ]
        );
        // 30 ms before, 25 ms after.
        assert_eq!((found[0].start_ms, found[0].end_ms), (420.0, 725.0));
        let mine: Vec<&Suggestion> = found.iter().collect();
        assert_eq!(
            star("What the Fuck, he's dead.", &mine),
            "What the F***, he's dead."
        );
        assert_eq!(star("Motherfucker neglect", &mine), "Motherf***** n******");
        // "fuck" inside another word is left alone.
        assert_eq!(star("fuckers", &mine), "fuckers");
        // The neglect list adds "hit", starred.
        let found = suggestions(&words, true, 0.0, 10_000.0);
        let hit = found.iter().find(|s| s.term == "hit").map(|s| s.starred);
        assert_eq!(hit, Some(true));
        // "kill" is mute-only in the house list but starred in a neglect case.
        let kill = [word("kill", 0.0, 300.0, "a")];
        assert!(!suggestions(&kill, false, 0.0, 1000.0)[0].starred);
        assert!(suggestions(&kill, true, 0.0, 1000.0)[0].starred);
    }

    #[test]
    fn a_word_timed_as_an_instant_reaches_back() {
        let words = [
            word("you", 1000.0, 1200.0, "a"),
            word("um", 1300.0, 1500.0, "b"),
            word("bitch", 2000.0, 2010.0, "a"),
        ];
        let found = suggestions(&words, false, 0.0, 10_000.0);
        // Back to the end of the speaker's word before, less the lead.
        assert_eq!((found[0].start_ms, found[0].end_ms), (1170.0, 2035.0));
        // No word of theirs in reach: 1.5 s back.
        let alone = [word("bitch", 2000.0, 2010.0, "a")];
        assert_eq!(suggestions(&alone, false, 0.0, 10_000.0)[0].start_ms, 470.0);
        // Clamped to the range.
        assert_eq!(
            suggestions(&alone, false, 1000.0, 2020.0)[0].start_ms,
            1000.0
        );
        assert_eq!(suggestions(&alone, false, 1000.0, 2020.0)[0].end_ms, 2020.0);
    }

    #[test]
    fn tokens_like_repack() {
        assert_eq!(
            tokens("He's DEAD, rock'n'roll 42!"),
            ["he's", "dead", "rock'n", "roll", "42"]
        );
        assert_eq!(
            parse_term("shit = s**t"),
            ("shit".into(), Some("s**t".into()))
        );
        assert_eq!(parse_term("nigger"), ("nigger".into(), None));
    }
}
