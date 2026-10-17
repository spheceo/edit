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
pub const HOUSE_TERMS: [&str; 38] = [
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
    "rapist",
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
pub const NEGLECT_TERMS: [&str; 12] = [
    "endangerment",
    "kick",
    "hit",
    "punch",
    "beat",
    "kill",
    "blood",
    "lash",
    "whoop",
    "butt",
    "slap",
    "strangle",
];
/// The listed words that are verbs: their other forms count as them too
/// ("punched", "hitting", "abusive", "fucker"; see `is_form_of`). Every
/// listed word also counts in the plural ("hits", "bitches").
const VERBS: [&str; 19] = [
    "abuse",
    "beat",
    "choke",
    "drug",
    "fuck",
    "hit",
    "kick",
    "kill",
    "lash",
    "masturbate",
    "neglect",
    "overdose",
    "punch",
    "rape",
    "shoot",
    "slap",
    "stab",
    "strangle",
    "whoop",
];

/// Whether `token` is `term` or a form of it: its plural, and for a verb its
/// past, participles and doers ("punch" → punched, punching, punchin',
/// puncher; "hit" → hitting; "choke" → choked, choking; "beat" → beaten;
/// "abuse" → abusive).
pub fn is_form_of(token: &str, term: &str) -> bool {
    if token == term {
        return true;
    }
    let Some(rest) = token.strip_prefix(term) else {
        return is_verb_form(token, term);
    };
    matches!(rest, "s" | "es") || is_verb_form(token, term)
}

fn is_verb_form(token: &str, term: &str) -> bool {
    if !VERBS.contains(&term) {
        return false;
    }
    let chars: Vec<char> = term.chars().collect();
    let vowel = |c: Option<&char>| c.is_some_and(|c| "aeiou".contains(*c));
    // hit → hitt-ing, slap → slapp-ed: a short vowel between two consonants.
    let doubled = match chars.as_slice() {
        [.., a, b, c] => {
            !vowel(Some(a)) && vowel(Some(b)) && !vowel(Some(c)) && !"wxy".contains(*c)
        }
        _ => false,
    };
    let base = term.strip_suffix('e').unwrap_or(term);
    let stems = [
        Some(base.to_owned()),
        doubled
            .then(|| chars.last().map(|last| format!("{term}{last}")))
            .flatten(),
    ];
    stems.iter().flatten().any(|stem| {
        token
            .strip_prefix(stem.as_str())
            .is_some_and(|rest| matches!(rest, "ed" | "ing" | "in" | "er" | "ers" | "en" | "ive"))
    })
}

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
        // Words as listed first; then another form of one ("punched").
        'found: for loose in [false, true] {
            for term in &listed {
                if loose && term.parts.len() != 1 {
                    continue;
                }
                let Some(found) = stream.get(i..i + term.parts.len()) else {
                    continue;
                };
                let fits = found.iter().enumerate().all(|(j, (token, index))| {
                    let Some(part) = term.parts.get(j) else {
                        return false;
                    };
                    if !(token == part || (loose && is_form_of(token, part))) {
                        return false;
                    }
                    let Some(previous) = j.checked_sub(1).and_then(|k| found.get(k)) else {
                        return true;
                    };
                    let (Some(word), Some(before)) = (words.get(*index), words.get(previous.1))
                    else {
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
                    // Another form is starred as written: "punched" → "p******".
                    let (said, display) = match found.first() {
                        Some((token, _)) if loose && *token != term.key => (token.clone(), None),
                        _ => (term.term.clone(), term.display.clone()),
                    };
                    out.push(Suggestion {
                        term: said,
                        starred: term.starred,
                        display,
                        word: *first_index,
                        at_ms: first.start_ms.round(),
                        start_ms,
                        end_ms,
                    });
                }
                i += term.parts.len() - 1;
                break 'found;
            }
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
/// speakers (radio, background talk: they talk over the conversation rather
/// than instead of it) are left out first and cut nothing short; lines of
/// `hidden` ones that aren't silent (only the narrator) still end the line
/// before them, then go.
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
            // Readable however quick the reply after it: a line held into
            // another speaker's stacks over it (overlap mode's way).
            end_ms = end_ms.max((start_ms + MIN_SHOWN_MS).min(until_ms));
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
    if !together {
        hold_readable(&mut out, until_ms);
    }
    out
}

/// The least time a line stays up: under this it flashes past unread (a
/// finished subtitled video had 28 lines, "No.", "Yeah.", up for a single
/// frame, squeezed in before a quick answer).
pub const MIN_SHOWN_MS: f64 = 400.0;

/// Holds every line at least MIN_SHOWN_MS (not past `until_ms`), starting the
/// next one that much later: its own hold after its last word absorbs it.
fn hold_readable(cues: &mut [Line], until_ms: f64) {
    let mut shown_until = f64::NEG_INFINITY;
    for cue in cues.iter_mut() {
        cue.start_ms = cue.start_ms.max(shown_until);
        let least = (cue.start_ms + MIN_SHOWN_MS).min(until_ms);
        cue.end_ms = cue.end_ms.max(least);
        shown_until = cue.end_ms;
    }
}

/// Whether a role's lines are hidden: the narrator, radio traffic and
/// background talk (a second conversation behind the one followed).
pub(crate) fn hidden_role(role: &str) -> bool {
    matches!(role, "narrator" | "dispatch" | crate::speakers::BACKGROUND)
}

/// Whether a hidden role's lines also cut nothing short: every hidden one
/// but the narrator, since they talk over the conversation rather than
/// instead of it (Repack's silentRadio).
pub(crate) fn silent_role(role: &str) -> bool {
    hidden_role(role) && role != "narrator"
}

/// A voice's role: the one the transcript gives, else read from its name
/// (only what decides whether it shows: narrator or radio).
pub(crate) fn role_of(role: Option<&String>, name: &str) -> String {
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
    /// Each speaker's lines under their face (seats.rs), else bottom middle.
    pub faces: bool,
}

/// Whether `project` is a subtitled video: subtitles over its footage and
/// nothing else (an edit's subtitles carry the same name, among cut-ins,
/// B-roll and sound).
pub fn is_subtitled(project: &Project) -> bool {
    let prefix = format!("{NAME} · ");
    let subtitle = |clip: &Clip| {
        clip.name
            .as_deref()
            .is_some_and(|name| name.starts_with(&prefix))
    };
    let footage = |clip: &Clip| match &clip.content {
        ClipContent::Video { media, .. } | ClipContent::Audio { media, .. } => project
            .media(media)
            .is_some_and(|media| media.kind == MediaKind::Video),
        _ => false,
    };
    project.clips.iter().any(subtitle)
        && project
            .clips
            .iter()
            .all(|clip| subtitle(clip) || footage(clip))
}

/// Segments covering `[0, duration)`: the gaps between `given` (sorted) as
/// footage, overlaps trimmed, and neighbours of one kind (and note) joined.
pub fn fill_segments(given: Vec<edit_core::Segment>, duration: i64) -> Vec<edit_core::Segment> {
    use edit_core::{Segment, SegmentKind};
    let mut out: Vec<Segment> = Vec::new();
    let mut at = 0;
    let push = |out: &mut Vec<Segment>, segment: Segment| {
        if segment.end <= segment.start {
            return;
        }
        match out.last_mut() {
            Some(last) if last.kind == segment.kind && last.note == segment.note => {
                last.end = segment.end;
            }
            _ => out.push(segment),
        }
    };
    for segment in given {
        let start = segment.start.max(at);
        let end = segment.end.min(duration);
        if end <= start {
            continue;
        }
        push(
            &mut out,
            Segment {
                start: at,
                end: start,
                kind: SegmentKind::Footage,
                note: String::new(),
            },
        );
        push(
            &mut out,
            Segment {
                start,
                end,
                ..segment
            },
        );
        at = end;
    }
    push(
        &mut out,
        Segment {
            start: at,
            end: duration,
            kind: SegmentKind::Footage,
            note: String::new(),
        },
    );
    out
}

/// Faster than anyone talks (characters a second): the words' times are wrong.
const CRAMMED_CPS: f64 = 25.0;
/// How long a line needs to be read at least: this many ms a character…
const READ_MS_PER_CHAR: f64 = 60.0;
/// …and never less than this.
const READ_MS: f64 = 800.0;

/// Lines whose words are crammed faster than anyone talks ("Anything in your
/// pocket?" in 0.4 s, after a word stretched over the silence where it was
/// really said) get the time they need to be read: taken from the gap
/// before them, where the words most likely were, else the next line waits
/// (`shown` sequences them).
pub fn uncram(lines: &mut [Line]) {
    lines.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
    let mut before = f64::NEG_INFINITY;
    for line in lines.iter_mut() {
        let chars = line.text.chars().filter(|c| !c.is_whitespace()).count() as f64;
        let span = line.end_ms - line.start_ms;
        if chars >= 8.0 && span < chars / CRAMMED_CPS * 1000.0 {
            let needed = (chars * READ_MS_PER_CHAR).max(READ_MS);
            line.start_ms = line
                .start_ms
                .min((line.end_ms - needed).max(before))
                .max(0.0);
            if line.end_ms - line.start_ms < needed {
                line.end_ms = line.start_ms + needed;
            }
        }
        before = before.max(line.end_ms);
    }
}

/// The longest anyone takes to say `word` (ms): transcription sometimes
/// stretches a word's end over the silence after it ("right." for 9 s), which
/// would hold its subtitle up and rush the next. About a second for a short
/// word, more for a long one; numbers ("$8,320") are said in many words, so
/// they keep their time.
pub fn longest_ms(word: &str) -> f64 {
    if word.chars().any(|c| c.is_ascii_digit()) {
        return f64::INFINITY;
    }
    let letters = word.chars().filter(|c| c.is_alphabetic()).count() as f64;
    (120.0 * letters + 500.0).max(1000.0)
}

/// Between two subtitles stacked because their people talk at once, in 1080p pixels.
const STACK_GAP: f32 = 12.0;

/// Where a face in a footage clip is on the project's frame (both in %): the
/// clip's picture fitted to the frame, scaled and moved by its transform.
fn on_project(
    dot: crate::seats::Dot,
    media: (u32, u32),
    transform: &Transform,
    frame: (u32, u32),
) -> crate::seats::Dot {
    let (fw, fh) = (f64::from(frame.0.max(1)), f64::from(frame.1.max(1)));
    let (mw, mh) = (f64::from(media.0.max(1)), f64::from(media.1.max(1)));
    let fit = (fw / mw).min(fh / mh) * f64::from(transform.scale);
    let x = fw / 2.0 + f64::from(transform.x) + (dot.x / 100.0 - 0.5) * mw * fit;
    let y = fh / 2.0 + f64::from(transform.y) + (dot.y / 100.0 - 0.5) * mh * fit;
    crate::seats::Dot {
        x: x / fw * 100.0,
        y: y / fh * 100.0,
        h: dot.h * mh * fit / fh,
    }
}

/// A footage clip as subtitles look it up: start, end (frames), media,
/// source_in, speed, transform and the media's size.
type Footage = (i64, i64, String, f64, f64, Transform, (u32, u32));

/// About how big a house-style subtitle's box is (project pixels) with its
/// text wrapped at `text_width`: Montserrat SemiBold averages ~0.58 em.
pub(crate) fn box_size(text: &str, text_width: f32, k: f32) -> (f32, f32) {
    let size = 48.0 * k;
    let text_width = text_width.max(size);
    let mut lines = 0.0_f32;
    let mut widest = 0.0_f32;
    for line in text.lines() {
        let natural = line.chars().count() as f32 * 0.58 * size;
        lines += (natural / text_width).ceil().max(1.0);
        widest = widest.max(natural.min(text_width));
    }
    (widest + 24.0 * k, lines.max(1.0) * size * 1.15 + 16.0 * k)
}

/// A line under its speaker's face, the way Repack lays it out
/// (subtitleLayout): 80 px under the face (more for a big face), at most
/// 40% of the frame wide (less near an edge, never under 28%), beside the
/// face, towards the middle, when under it would leave the frame; none for
/// a face in a bottom corner (those stay bottom middle). Returns the box's
/// centre from the frame's centre, the text's wrap width and the box's size.
fn under_face(
    dot: crate::seats::Dot,
    text: &str,
    width: u32,
    height: u32,
    k: f32,
) -> Option<(f32, f32, f32, f32, f32)> {
    let (x, y) = (dot.x as f32, dot.y as f32);
    if y >= 60.0 && (x <= 33.0 || x >= 67.0) {
        return None;
    }
    let (fw, fh) = (width as f32, height as f32);
    let share = 80.0_f32.min(28.0_f32.max(40.0_f32.min(2.0 * x.min(100.0 - x))));
    let text_width = fw * share / 100.0 - 24.0 * k;
    let (w, h) = box_size(text, text_width, k);
    let (face_x, face_y) = (fw * x / 100.0, fh * y / 100.0);
    let gap = (80.0 * k).max(0.9 * fh * dot.h as f32 / 100.0);
    let beside = face_y + gap + h > fh - 50.0 * k;
    let cy = (if beside {
        face_y
    } else {
        face_y + gap + h / 2.0
    })
    .clamp(h / 2.0, (fh - h / 2.0).max(h / 2.0));
    let cx = if beside {
        if face_x > fw / 2.0 {
            face_x - 110.0 * k - w / 2.0
        } else {
            face_x + 110.0 * k + w / 2.0
        }
    } else {
        face_x
    }
    .clamp(w / 2.0, (fw - w / 2.0).max(w / 2.0));
    Some((cx - fw / 2.0, cy - fh / 2.0, text_width, w, h))
}

/// One voice in the footage, for the summary and the subtitles' colour.
struct Voice {
    name: String,
    role: String,
    color: String,
}

/// The narrator only speaks in narration: a "narrator" line inside a footage
/// segment is someone in the room whose voice diarisation lumped in with the
/// narrator's (an interrogator's 475 words were hidden that way). Such lines
/// go to the shown voice sharing a name with it ("JT Palmer (Narrator)" →
/// "Palmer (Undersheriff)"), else to the same voice shown, as "Other".
fn narrators_in_footage(
    project: &Project,
    voices: &mut BTreeMap<String, Voice>,
    lines: &mut [Line],
) {
    let fps = project.fps();
    let footage: Vec<(f64, f64)> = project
        .segments
        .iter()
        .filter(|segment| segment.kind == edit_core::SegmentKind::Footage)
        .map(|segment| {
            (
                segment.start as f64 / fps * 1000.0,
                segment.end as f64 / fps * 1000.0,
            )
        })
        .collect();
    if footage.is_empty() {
        return;
    }
    let generic = [
        "the",
        "officer",
        "detective",
        "deputy",
        "sergeant",
        "narrator",
        "police",
        "speaker",
        "unknown",
    ];
    let names = |name: &str| -> Vec<String> {
        person(name)
            .0
            .into_iter()
            .filter(|word| word.len() > 1 && !generic.contains(&word.as_str()))
            .collect()
    };
    for line in lines.iter_mut() {
        let Some(voice) = voices.get(&line.speaker) else {
            continue;
        };
        if voice.role != "narrator"
            || !footage
                .iter()
                .any(|(start, end)| *start <= line.start_ms && line.start_ms < *end)
        {
            continue;
        }
        let words = names(&voice.name);
        let media = line
            .speaker
            .split('/')
            .next()
            .unwrap_or_default()
            .to_owned();
        let match_key = voices
            .iter()
            .filter(|(key, other)| {
                key.starts_with(&format!("{media}/")) && !hidden_role(&other.role)
            })
            .find(|(_, other)| names(&other.name).iter().any(|word| words.contains(word)))
            .map(|(key, _)| key.clone());
        let key = match match_key {
            Some(key) => key,
            None => {
                let key = format!("{}#footage", line.speaker);
                let shown = Voice {
                    name: "Other".into(),
                    role: "other".into(),
                    color: voice.color.clone(),
                };
                voices.entry(key.clone()).or_insert(shown);
                key
            }
        };
        line.speaker = key;
    }
}

/// A speaker's name as compared: its words (lower case) and the role in its
/// brackets, "Romania Hunter (Mother)" → (["romania", "hunter"], "mother").
fn person(name: &str) -> (Vec<String>, String) {
    let (name, role) = match name.split_once('(') {
        Some((name, role)) => (name, role.trim_end_matches(')').trim().to_lowercase()),
        None => (name, String::new()),
    };
    (tokens(name), role)
}

/// Whether two speaker names are one person: the same name, or (with the
/// same role in brackets) one name the start of the other ("Romania
/// (Mother)" and "Romania Hunter (Mother)"). Bare labels ("Deputy 2",
/// "Deputy 3") only match exactly.
fn same_person(a: &str, b: &str) -> bool {
    let ((a_words, a_role), (b_words, b_role)) = (person(a), person(b));
    if a_words.is_empty() || b_words.is_empty() {
        return false;
    }
    if a_words == b_words && a_role == b_role {
        return true;
    }
    let shorter = a_words.len().min(b_words.len());
    !a_role.is_empty() && a_role == b_role && a_words.get(..shorter) == b_words.get(..shorter)
}

/// One person, one colour: the watcher can name several of the
/// transcript's voices as the same person, each with its own colour (a boy
/// in three colours). Merges them into the voice with the most lines (its
/// colour), under the fullest name.
fn same_person_same_colour(voices: &mut BTreeMap<String, Voice>, lines: &mut [Line]) {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for line in lines.iter() {
        *counts.entry(line.speaker.clone()).or_default() += 1;
    }
    let mut keys: Vec<String> = voices.keys().cloned().collect();
    keys.sort_by_key(|key| std::cmp::Reverse(counts.get(key).copied().unwrap_or(0)));
    let mut into: HashMap<String, String> = HashMap::new();
    for (index, key) in keys.iter().enumerate() {
        if into.contains_key(key) {
            continue;
        }
        let Some(name) = voices.get(key).map(|voice| voice.name.clone()) else {
            continue;
        };
        for other in keys.iter().skip(index + 1) {
            if into.contains_key(other) {
                continue;
            }
            if voices
                .get(other)
                .is_some_and(|voice| same_person(&name, &voice.name))
            {
                into.insert(other.clone(), key.clone());
            }
        }
    }
    for (merged, kept) in &into {
        let Some(gone) = voices.remove(merged) else {
            continue;
        };
        if let Some(voice) = voices.get_mut(kept) {
            if gone.name.len() > voice.name.len() {
                voice.name = gone.name;
            }
        }
    }
    for line in lines.iter_mut() {
        if let Some(kept) = into.get(&line.speaker) {
            line.speaker = kept.clone();
        }
    }
}

/// No two people alike across the files (each transcript picks its colours
/// on its own), and no official in pink (`speakers::distinct`).
fn spread_colours(voices: &mut BTreeMap<String, Voice>, lines: &[Line]) {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for line in lines {
        *counts.entry(line.speaker.as_str()).or_default() += 1;
    }
    let keys: Vec<String> = voices.keys().cloned().collect();
    let colors = {
        let people: Vec<crate::speakers::Person> = keys
            .iter()
            .filter_map(|key| {
                let voice = voices.get(key)?;
                Some(crate::speakers::Person {
                    role: &voice.role,
                    lines: counts.get(key.as_str()).copied().unwrap_or(0),
                    color: &voice.color,
                })
            })
            .collect();
        crate::speakers::distinct(&people)
    };
    for (key, color) in keys.iter().zip(colors) {
        if let Some(voice) = voices.get_mut(key) {
            voice.color = color;
        }
    }
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
        faces,
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
        let words = timed_words(&transcript.words, visible_from, visible_to);
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
            // A cue of only a transcriber's mark ("...") says nothing: no subtitle.
            if !cue.text.chars().any(char::is_alphanumeric) {
                continue;
            }
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
    narrators_in_footage(&project, &mut voices, &mut lines);
    same_person_same_colour(&mut voices, &mut lines);
    spread_colours(&mut voices, &lines);
    uncram(&mut lines);
    let role = |key: &str| voices.get(key).map_or("other", |voice| voice.role.as_str());
    let shown = shown(
        &lines,
        hold_ms,
        from as f64 / fps * 1000.0,
        to as f64 / fps * 1000.0,
        overlap,
        |key| silent_role(role(key)),
        |key| hidden_role(role(key)),
    );
    let (width, height) = (project.settings.width, project.settings.height);
    let frame = |ms: f64| (ms / 1000.0 * fps).round() as i64;
    // Where each speaker sits, per file, for lines under their face.
    let mut seats: HashMap<String, crate::seats::Seats> = HashMap::new();
    if faces {
        for (media_id, transcript) in &transcripts {
            let Some(media) = project.media(media_id) else {
                continue;
            };
            match crate::seats::seats(std::path::Path::new(&media.path), transcript).await {
                Ok(found) => {
                    seats.insert(media_id.clone(), found);
                }
                Err(error) => crate::diag::warn(
                    "subtitles",
                    format!(
                        "no face positions for {}: {error}; bottom middle",
                        media.name
                    ),
                ),
            }
        }
    }
    let (live, (placed, skipped, outside, texts)) =
        app.store.update(project_id, "agent", |project| {
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
            write_mutes(project, &mutes);
            tracks.push(project.subtitles_track());
            tracks.extend(stacked);
            let base_y = height as f32 * 0.4;
            let k = height as f32 / 1080.0;
            // The footage the seats were found in, to find where a line is in it:
            // (start, end, media, source_in, speed, transform, media size).
            let footage: Vec<Footage> = project
                .clips
                .iter()
                .filter_map(|clip| match &clip.content {
                    ClipContent::Video {
                        media,
                        source_in,
                        speed,
                        transform,
                        ..
                    } if seats.contains_key(media) => project.media(media).map(|found| {
                        (
                            clip.start,
                            clip.end(),
                            media.clone(),
                            *source_in,
                            *speed,
                            *transform,
                            (found.width, found.height),
                        )
                    }),
                    _ => None,
                })
                .collect();
            // Lines up now: when each ends (frames), its centre (x, y) and box size.
            let mut open: Vec<(i64, f32, f32, f32, f32)> = Vec::new();
            let (mut placed, mut skipped) = (0, 0);
            // Only inside footage segments: a line across a segment's edge shows
            // only inside it (narration and already-subtitled stretches get none).
            let pieces: Vec<(&Line, i64, i64)> = shown
                .iter()
                .flat_map(|line| {
                    let (start, end) = (frame(line.start_ms).max(from), frame(line.end_ms).min(to));
                    project
                        .subtitled_spans(start, end)
                        .into_iter()
                        .map(move |(start, end)| (line, start, end))
                })
                .collect();
            let mut outside = shown.len();
            let mut counted = std::collections::HashSet::new();
            for &(line, _, _) in &pieces {
                if counted.insert(std::ptr::from_ref(line)) {
                    outside -= 1;
                }
            }
            for (line, start, end) in pieces {
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
                let voice = voices.get(&line.speaker);
                // Under the speaker's face when they're seen there (where the
                // line starts), else bottom middle.
                let face = voice.and_then(|voice| {
                    let (clip_start, _, media, source_in, speed, transform, size) = footage
                        .iter()
                        .find(|clip| clip.0 <= start && start < clip.1)?;
                    let at = source_in + (start - clip_start) as f64 / fps * speed;
                    let dot = seats.get(media)?.dot(&voice.name, at)?;
                    Some(on_project(dot, *size, transform, (width, height)))
                });
                let (x, mut y, text_width, box_width, box_height) =
                    match face.and_then(|dot| under_face(dot, &line.text, width, height, k)) {
                        Some(placed) => placed,
                        None => {
                            let text_width = width as f32 * 0.8 - 24.0 * k;
                            let (box_width, box_height) = box_size(&line.text, text_width, k);
                            (0.0, base_y, text_width, box_width, box_height)
                        }
                    };
                // Stacked: a line whose box would cover one already up goes
                // above it (below when there's no room above).
                open.retain(|(until, ..)| *until > start);
                for _ in 0..=open.len() {
                    let Some(&(_, _, _, over_y, over_height)) =
                        open.iter()
                            .find(|(_, other_x, other_width, other_y, other_height)| {
                                (x - other_x).abs() < (box_width + other_width) / 2.0
                                    && (y - other_y).abs()
                                        < (box_height + other_height) / 2.0 + STACK_GAP * k / 2.0
                            })
                    else {
                        break;
                    };
                    let above = over_y - over_height / 2.0 - STACK_GAP * k - box_height / 2.0;
                    y = if above - box_height / 2.0 >= -(height as f32) / 2.0 {
                        above
                    } else {
                        over_y + over_height / 2.0 + STACK_GAP * k + box_height / 2.0
                    };
                }
                open.push((end, x, box_width, y, box_height));
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
                    person: None,
                    content: ClipContent::Text {
                        text: line.text.clone(),
                        style: TextStyle {
                            max_width: Some(text_width.round()),
                            ..house_style(width, height, color)
                        },
                        transform: Transform {
                            x,
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
            // Every other text on screen too (captions, callouts, charges), all of the video.
            let texts = star_on_screen(project, 0, i64::MAX, neglect);
            Ok((placed, skipped, outside, texts))
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
                "shown": !hidden_role(&voice.role),
            })
        })
        .collect();
    Ok(json!({
        "rev": live.rev,
        "subtitles": placed,
        "skipped": skipped,
        "outside_segments": outside,
        "texts_starred": texts,
        "speakers": speakers,
        "mutes": muted,
    }))
}

/// The footage's own sound in the span: audio clips of video files (not
/// music or sound effects) on tracks that are heard.
pub(crate) fn footage_sound(project: &Project, from: i64, to: i64) -> Vec<&Clip> {
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

/// Mutes for footage sound clips: per clip, the stretch of its source looked
/// at (seconds) and the mutes found in it.
pub(crate) type ClipMutes = HashMap<String, (f64, f64, Vec<Mute>)>;

/// Writes `mutes` onto their audio clips: each clip's mutes inside the
/// stretch looked at are replaced, the rest kept.
pub(crate) fn write_mutes(project: &mut Project, mutes: &ClipMutes) {
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
}

/// A house word found in the footage's sound.
pub(crate) struct Found {
    /// The footage sound clip it's in.
    pub clip: String,
    /// In ms of that clip's source.
    pub suggestion: Suggestion,
    /// When it's said on the timeline (ms), first word's start to the mute's end.
    pub timeline_ms: (f64, f64),
}

/// The house words said in the footage's sound between `from` and `to`
/// (timeline frames), as repack_subtitles finds them.
pub(crate) struct HouseWords {
    pub mutes: ClipMutes,
    pub found: Vec<Found>,
    /// Each one for the agent: term, timeline seconds, starred, clip.
    pub listed: Vec<Value>,
}

/// A clip's transcript words between `from` and `to` (source seconds), each
/// ending when it could have been said (`longest_ms`).
pub(crate) fn timed_words(words: &[crate::transcribe::Word], from: f64, to: f64) -> Vec<TimedWord> {
    words
        .iter()
        .filter(|word| word.start >= from && word.end <= to + 0.05)
        .map(|word| TimedWord {
            text: word.text.trim().to_owned(),
            start_ms: word.start * 1000.0,
            end_ms: (word.end * 1000.0).min(word.start * 1000.0 + longest_ms(&word.text)),
            speaker: word.speaker.clone(),
        })
        .filter(|word| !word.text.is_empty())
        .collect()
}

/// Finds the house words (and the neglect list's when `neglect`) said in the
/// footage and the voice-overs between `from` and `to` (timeline frames), and
/// the mutes for them. Only the footage's go in `found` (they star subtitles).
pub(crate) async fn house_words(
    app: &App,
    project: &Project,
    from: i64,
    to: i64,
    neglect: bool,
) -> Result<HouseWords, String> {
    let fps = project.fps();
    let mut sound: Vec<(&Clip, bool)> = footage_sound(project, from, to)
        .into_iter()
        .map(|clip| (clip, false))
        .chain(
            crate::voiceover::voiceover_sound(project, from, to)
                .into_iter()
                .map(|clip| (clip, true)),
        )
        .collect();
    sound.sort_by_key(|(clip, _)| clip.start);
    let mut transcripts: HashMap<String, crate::transcribe::Transcript> = HashMap::new();
    let mut out = HouseWords {
        mutes: HashMap::new(),
        found: Vec::new(),
        listed: Vec::new(),
    };
    for (clip, voice_over) in sound {
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
        let words = timed_words(&transcript.words, visible_from, visible_to);
        let on_timeline = |source_ms: f64| {
            (clip.start as f64 / fps + (source_ms / 1000.0 - source_in) / speed) * 1000.0
        };
        let entry =
            out.mutes
                .entry(clip.id.clone())
                .or_insert((visible_from, visible_to, Vec::new()));
        for suggestion in suggestions(&words, neglect, visible_from * 1000.0, visible_to * 1000.0) {
            entry.2.push(Mute {
                from: suggestion.start_ms / 1000.0,
                to: suggestion.end_ms / 1000.0,
            });
            let mut listed = json!({
                "term": suggestion.term,
                "time": (on_timeline(suggestion.at_ms) / 10.0).round() / 100.0,
                "starred": suggestion.starred,
                "clip": clip.id,
            });
            if voice_over {
                if let Some(fields) = listed.as_object_mut() {
                    fields.insert("voice_over".into(), json!(true));
                }
                out.listed.push(listed);
                continue;
            }
            out.listed.push(listed);
            out.found.push(Found {
                clip: clip.id.clone(),
                timeline_ms: (
                    on_timeline(suggestion.at_ms),
                    on_timeline(suggestion.end_ms),
                ),
                suggestion,
            });
        }
    }
    Ok(out)
}

/// The starred words of `found` said while a subtitle from `start` to `end`
/// (timeline frames) is up, give or take half a second.
fn said_during(found: &[Found], start: i64, end: i64, fps: f64) -> Vec<&Suggestion> {
    let (from_ms, to_ms) = (
        start as f64 / fps * 1000.0 - 500.0,
        end as f64 / fps * 1000.0 + 500.0,
    );
    found
        .iter()
        .filter(|found| found.timeline_ms.0 < to_ms && found.timeline_ms.1 > from_ms)
        .map(|found| &found.suggestion)
        .collect()
}

/// Mutes the house words in the footage's sound and the voice-overs between
/// `from` and `to` (timeline frames) and stars them out in the subtitles already there,
/// moving nothing: for subtitles finished by hand. Replaces the mutes made
/// before in that span.
pub async fn mute_house_words(
    app: &App,
    project_id: &str,
    from: i64,
    to: i64,
    neglect: bool,
) -> Result<Value, String> {
    if to <= from {
        return Err("the span is empty".into());
    }
    let project = app.store.get(project_id).ok_or("no such project")?.project;
    let fps = project.fps();
    let house = house_words(app, &project, from, to, neglect).await?;
    let (live, (starred, on_screen)) = app.store.update(project_id, "agent", |project| {
        write_mutes(project, &house.mutes);
        let starred = star_subtitles(project, &house.found, from, to, fps);
        Ok((starred, star_on_screen(project, from, to, neglect)))
    })?;
    Ok(json!({
        "rev": live.rev,
        "subtitles_starred": starred,
        "texts_starred": on_screen,
        "mutes": house.listed,
    }))
}

/// Stars out `found` in the subtitles between `from` and `to` (timeline
/// frames) that are up while each is said; how many changed. Words keep
/// their places, so per-word timing (`word_times`) still fits.
fn star_subtitles(project: &mut Project, found: &[Found], from: i64, to: i64, fps: f64) -> usize {
    let mut changed = 0;
    for clip in &mut project.clips {
        let subtitle = clip
            .name
            .as_deref()
            .is_some_and(|name| name.starts_with(NAME));
        if !subtitle || clip.start >= to || clip.end() <= from {
            continue;
        }
        let mine = said_during(found, clip.start, clip.end(), fps);
        if let ClipContent::Text { text, .. } = &mut clip.content {
            let starred = star(text, &mine);
            if starred != *text {
                *text = starred;
                changed += 1;
            }
        }
    }
    changed
}

/// `text` with the starred house words in it (and the neglect list's when
/// `neglect`) starred out, whatever is said: for any text on screen. Words
/// keep their places and lengths, so word timings still fit.
pub fn star_text(text: &str, neglect: bool) -> String {
    let words: Vec<TimedWord> = text
        .split_whitespace()
        .enumerate()
        .map(|(index, word)| TimedWord {
            text: word.to_owned(),
            start_ms: index as f64 * 100.0,
            end_ms: index as f64 * 100.0 + 50.0,
            speaker: None,
        })
        .collect();
    let found = suggestions(&words, neglect, f64::MIN, f64::MAX);
    star(text, &found.iter().collect::<Vec<_>>())
}

/// Stars out the house words in every text clip on screen between `from`
/// and `to` (timeline frames): subtitles, speaker captions, callouts,
/// quotes, charges, labels. How many changed.
pub(crate) fn star_on_screen(project: &mut Project, from: i64, to: i64, neglect: bool) -> usize {
    let mut changed = 0;
    for clip in &mut project.clips {
        if clip.start >= to || clip.end() <= from {
            continue;
        }
        if let ClipContent::Text { text, .. } = &mut clip.content {
            let starred = star_text(text, neglect);
            if starred != *text {
                *text = starred;
                changed += 1;
            }
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    #[test]
    fn lines_sit_under_faces_the_repack_way() {
        use crate::seats::Dot;
        // A face upper left: under it, narrowed near the edge.
        let (x, y, text_width, _, h) = super::under_face(
            Dot {
                x: 25.0,
                y: 30.0,
                h: 10.0,
            },
            "Yes, sir.",
            1920,
            1080,
            1.0,
        )
        .unwrap();
        assert!((x - (480.0 - 960.0)).abs() < 1.0, "{x}");
        assert!((y - (324.0 + 97.2 + h / 2.0 - 540.0)).abs() < 1.0, "{y}");
        assert!((text_width - (1920.0 * 0.4 - 24.0)).abs() < 0.5);
        // A face low down: beside it, towards the middle.
        let (x, ..) = super::under_face(
            Dot {
                x: 40.0,
                y: 70.0,
                h: 30.0,
            },
            "Okay.",
            1920,
            1080,
            1.0,
        )
        .unwrap();
        assert!(x > 768.0 - 960.0, "{x}");
        // A face in a bottom corner: bottom middle instead.
        assert!(super::under_face(
            Dot {
                x: 10.0,
                y: 80.0,
                h: 10.0
            },
            "Okay.",
            1920,
            1080,
            1.0
        )
        .is_none());
    }

    #[test]
    fn overlapping_lines_stay_up_long_enough_to_read() {
        let line = |start_ms: f64, end_ms: f64, speaker: &str| super::Line {
            start_ms,
            end_ms,
            text: "Okay.".into(),
            speaker: speaker.into(),
        };
        let lines = [
            line(0.0, 100.0, "a"),
            line(120.0, 1_000.0, "b"),
            line(1_300.0, 1_400.0, "a"),
        ];
        let shown = super::shown(&lines, 1_000.0, 0.0, 10_000.0, true, |_| false, |_| false);
        assert!(
            shown
                .iter()
                .all(|cue| cue.end_ms - cue.start_ms >= super::MIN_SHOWN_MS - 1e-6),
            "{shown:?}"
        );
    }

    #[test]
    fn a_narrator_in_the_footage_is_someone_in_the_room() {
        use super::{narrators_in_footage, Line, Voice};
        let mut project =
            edit_core::Project::new("p".into(), "t".into(), edit_core::Settings::default());
        project.segments = serde_json::from_value(serde_json::json!([
            {"start": 0, "end": 300, "kind": "narration"},
            {"start": 300, "end": 900, "kind": "footage"},
        ]))
        .unwrap();
        let voice = |name: &str, role: &str| Voice {
            name: name.into(),
            role: role.into(),
            color: "#ffffff".into(),
        };
        let mut voices = std::collections::BTreeMap::from([
            ("m/0".to_owned(), voice("JT Palmer (Narrator)", "narrator")),
            ("m/2".to_owned(), voice("Palmer (Undersheriff)", "leader")),
        ]);
        let line = |start_ms: f64| Line {
            start_ms,
            end_ms: start_ms + 500.0,
            text: "so".into(),
            speaker: "m/0".into(),
        };
        // One in the narration (stays the narrator's), one in the footage.
        let mut lines = vec![line(2_000.0), line(20_000.0)];
        narrators_in_footage(&project, &mut voices, &mut lines);
        assert_eq!(lines[0].speaker, "m/0");
        assert_eq!(lines[1].speaker, "m/2");
    }

    #[test]
    fn one_person_gets_one_colour() {
        use super::{same_person, same_person_same_colour, Line, Voice};
        assert!(same_person("Haven (Boy)", "haven (boy)"));
        assert!(same_person("Romania (Mother)", "Romania Hunter (Mother)"));
        assert!(!same_person("Deputy 2", "Deputy 3"));
        assert!(!same_person("Deputy", "Deputy 2"));
        assert!(!same_person("Romania (Mother)", "Romania (Neighbor)"));
        let voice = |name: &str, color: &str| Voice {
            name: name.into(),
            role: "other".into(),
            color: color.into(),
        };
        let mut voices = std::collections::BTreeMap::from([
            ("m/a".to_owned(), voice("Haven (Boy)", "#111111")),
            ("m/b".to_owned(), voice("Haven (Boy)", "#222222")),
            ("m/c".to_owned(), voice("Romania (Mother)", "#333333")),
            (
                "m/d".to_owned(),
                voice("Romania Hunter (Mother)", "#444444"),
            ),
            ("m/e".to_owned(), voice("Deputy 2", "#555555")),
        ]);
        let line = |speaker: &str| Line {
            start_ms: 0.0,
            end_ms: 1.0,
            text: String::new(),
            speaker: speaker.into(),
        };
        let mut lines: Vec<Line> = ["m/a", "m/b", "m/b", "m/c", "m/c", "m/d", "m/e"]
            .into_iter()
            .map(line)
            .collect();
        same_person_same_colour(&mut voices, &mut lines);
        assert_eq!(voices.len(), 3);
        // Haven keeps the colour of the voice with more lines (b).
        assert_eq!(
            voices.get("m/b").map(|voice| voice.color.as_str()),
            Some("#222222")
        );
        assert_eq!(
            voices.get("m/c").map(|voice| voice.name.as_str()),
            Some("Romania Hunter (Mother)")
        );
        assert!(lines.iter().all(|line| voices.contains_key(&line.speaker)));
    }

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
    fn a_line_squeezed_by_a_quick_answer_still_stays_up_long_enough_to_read() {
        let none = |_: &str| false;
        // "No." said 40 ms before the next line starts.
        let out = shown(
            &[line(0.0, 30.0, "a"), line(40.0, 1500.0, "b")],
            1000.0,
            0.0,
            9000.0,
            false,
            none,
            none,
        );
        assert_eq!(times(&out), [(0.0, 400.0, "a"), (400.0, 2500.0, "b")]);
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
        // Background talk is hidden and, like radio, cuts nothing short;
        // only the narrator does.
        let role = |speaker: &str| match speaker {
            "narrator" => "narrator",
            "behind" => crate::speakers::BACKGROUND,
            _ => "officer",
        };
        let out = shown(
            &[
                line(0.0, 500.0, "a"),
                line(600.0, 1200.0, "behind"),
                line(2000.0, 2300.0, "b"),
                line(2500.0, 2600.0, "narrator"),
            ],
            1000.0,
            0.0,
            9000.0,
            false,
            |speaker| silent_role(role(speaker)),
            |speaker| hidden_role(role(speaker)),
        );
        assert_eq!(times(&out), [(0.0, 1500.0, "a"), (2000.0, 2500.0, "b")]);
        assert!(hidden_role("dispatch") && silent_role("dispatch"));
        assert!(hidden_role("narrator") && !silent_role("narrator"));
        assert!(!hidden_role("officer") && !silent_role("officer"));
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
    fn segments_fill_gaps_with_footage_and_join_neighbours() {
        use edit_core::{Segment, SegmentKind};
        let seg = |start, end, kind| Segment {
            start,
            end,
            kind,
            note: String::new(),
        };
        let out = fill_segments(
            vec![
                seg(0, 100, SegmentKind::Captioned),
                seg(100, 150, SegmentKind::Captioned),
                seg(140, 200, SegmentKind::Narration),
                seg(300, 900, SegmentKind::Narration),
            ],
            500,
        );
        let kinds: Vec<(i64, i64, SegmentKind)> =
            out.iter().map(|s| (s.start, s.end, s.kind)).collect();
        assert_eq!(
            kinds,
            [
                (0, 150, SegmentKind::Captioned),
                (150, 200, SegmentKind::Narration),
                (200, 300, SegmentKind::Footage),
                (300, 500, SegmentKind::Narration)
            ]
        );
    }

    #[test]
    fn crammed_lines_get_time_to_be_read() {
        let line = |start_ms, end_ms, text: &str| Line {
            start_ms,
            end_ms,
            text: text.into(),
            speaker: "a".into(),
        };
        // 24 characters said in 0.4 s after a gap: starts earlier, in the gap.
        let mut lines = vec![
            line(234_750.0, 236_000.0, "All right."),
            line(244_380.0, 244_790.0, "Anything in your pocket?"),
            line(244_790.0, 246_000.0, "Hair is ..."),
        ];
        uncram(&mut lines);
        assert_eq!(lines[1].end_ms, 244_790.0);
        assert!((lines[1].start_ms - (244_790.0 - 21.0 * 60.0)).abs() < 1e-6);
        // No gap before it: it runs on, and the next waits for it in `shown`.
        let mut lines = vec![
            line(0.0, 1000.0, "One two three."),
            line(1000.0, 1300.0, "Four five six seven."),
        ];
        uncram(&mut lines);
        assert_eq!(lines[1].start_ms, 1000.0);
        assert!((lines[1].end_ms - (1000.0 + 17.0 * 60.0)).abs() < 1e-6);
        // Quick short answers are left alone.
        let mut lines = vec![line(0.0, 200.0, "Yes."), line(200.0, 500.0, "No.")];
        uncram(&mut lines);
        assert_eq!(lines[0].end_ms, 200.0);
        assert_eq!(lines[1].start_ms, 200.0);
    }

    #[test]
    fn stretched_words_end_when_they_could_be_said() {
        // "right." stretched over 9.4 s of silence ends within ~1.2 s.
        assert!((longest_ms("right.") - 1100.0).abs() < 1e-9);
        assert_eq!(longest_ms("too."), 1000.0);
        assert!(longest_ms("$8,320").is_infinite());
        assert!(longest_ms("methamphetamine") > 2000.0);
    }

    #[test]
    fn box_heights_grow_with_wrapped_lines() {
        let (_, one) = super::box_size("Short line", 1920.0 * 0.8 - 24.0, 1.0);
        let (_, two) = super::box_size(&"word ".repeat(20), 1920.0 * 0.8 - 24.0, 1.0);
        assert!((one - (48.0 * 1.15 + 16.0)).abs() < 0.01);
        assert!(two > one * 1.5);
    }

    #[test]
    fn listed_words_count_in_their_other_forms() {
        for (token, term) in [
            ("hits", "hit"),
            ("hitting", "hit"),
            ("punched", "punch"),
            ("punching", "punch"),
            ("punches", "punch"),
            ("kicked", "kick"),
            ("kickin", "kick"),
            ("slapped", "slap"),
            ("beaten", "beat"),
            ("beating", "beat"),
            ("choked", "choke"),
            ("choking", "choke"),
            ("abused", "abuse"),
            ("abusive", "abuse"),
            ("abuser", "abuse"),
            ("stabbed", "stab"),
            ("strangled", "strangle"),
            ("whooping", "whoop"),
            ("fucker", "fuck"),
            ("bitches", "bitch"),
            ("drugs", "drug"),
        ] {
            assert!(is_form_of(token, term), "{token} is a form of {term}");
        }
        for (token, term) in [
            ("hitch", "hit"),
            ("butter", "butt"),
            ("cracked", "crack"),
            ("assault", "ass"),
            ("cocky", "cock"),
            ("shots", "shoot"),
        ] {
            assert!(!is_form_of(token, term), "{token} is not a form of {term}");
        }
    }

    #[test]
    fn other_forms_are_muted_and_starred_as_said() {
        // "punched" at 9:29 of a neglect case wasn't muted.
        let words = [
            word("He", 0.0, 200.0, "a"),
            word("punched", 250.0, 600.0, "a"),
            word("her", 650.0, 800.0, "a"),
            word("and", 850.0, 900.0, "a"),
            word("kept", 950.0, 1100.0, "a"),
            word("hitting", 1150.0, 1500.0, "a"),
            word("fucking", 1550.0, 1900.0, "a"),
            word("shooting", 1950.0, 2300.0, "a"),
        ];
        let found = suggestions(&words, true, 0.0, 10_000.0);
        let terms: Vec<(&str, bool)> = found.iter().map(|s| (s.term.as_str(), s.starred)).collect();
        assert_eq!(
            terms,
            [
                ("punched", true),
                ("hitting", true),
                ("fucking", true),
                ("shooting", false)
            ]
        );
        assert_eq!((found[0].start_ms, found[0].end_ms), (220.0, 625.0));
        let mine: Vec<&Suggestion> = found.iter().collect();
        assert_eq!(
            star("He punched her and kept hitting, fucking", &mine),
            "He p****** her and kept h******, f******"
        );
        // Outside a neglect case only the house words count.
        let found = suggestions(&words, false, 0.0, 10_000.0);
        assert!(found.iter().all(|s| s.term != "punched"));
    }

    #[test]
    fn every_text_on_screen_gets_house_words_starred() {
        assert_eq!(
            star_text("Charges:\nChild Abuse\nAggravated child abuse", false),
            "Charges:\nChild A****\nAggravated child a****"
        );
        assert_eq!(star_text("\"He choked me\"", false), "\"He c***** me\"");
        assert_eq!(
            star_text("Shit, he punched him", false),
            "S**t, he punched him"
        );
        assert_eq!(
            star_text("Shit, he punched him", true),
            "S**t, he p****** him"
        );
        // Mute-only words stay readable; words are never removed.
        assert_eq!(
            star_text("Shots fired, he's dead", false),
            "Shots fired, he's dead"
        );
        let mut project = project_with(json!([
            { "id": "caption", "track": "v2", "start": 0, "duration": 30,
              "name": "Caption · Officer", "type": "text", "text": "Stop fucking moving",
              "word_times": [0.0, 5.0, 10.0] },
            { "id": "callout", "track": "v2", "start": 60, "duration": 30,
              "name": "Callout", "type": "text", "text": "Suspected of child abuse" },
            { "id": "later", "track": "v2", "start": 900, "duration": 30,
              "name": "Title", "type": "text", "text": "fuck" }
        ]));
        assert_eq!(star_on_screen(&mut project, 0, 300, false), 2);
        let text_of = |id: &str| match &project.clip(id).unwrap().content {
            ClipContent::Text { text, .. } => text.clone(),
            _ => String::new(),
        };
        assert_eq!(text_of("caption"), "Stop f****** moving");
        assert_eq!(text_of("callout"), "Suspected of child a****");
        assert_eq!(text_of("later"), "fuck");
        // Starred already: nothing changes on a second run.
        assert_eq!(star_on_screen(&mut project, 0, 300, false), 0);
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

    fn project_with(clips: Value) -> Project {
        let mut project = Project::new("p".into(), "t".into(), Default::default());
        project.media = serde_json::from_value(json!([
            { "id": "m", "name": "bodycam", "path": "/tmp/bodycam.mp4", "kind": "video", "duration": 600.0, "has_audio": true }
        ]))
        .unwrap();
        project.tracks = serde_json::from_value(json!([
            { "id": "v1", "kind": "video" },
            { "id": "v2", "kind": "video", "subtitles": true },
            { "id": "a1", "kind": "audio" }
        ]))
        .unwrap();
        project.clips = serde_json::from_value(clips).unwrap();
        project
    }

    #[test]
    fn mutes_go_on_their_clip_in_source_seconds() {
        // Two cuts of one file: the second plays its source from 120 s.
        let mut project = project_with(json!([
            { "id": "a", "track": "a1", "start": 0, "duration": 300, "color": "blue",
              "type": "audio", "media": "m", "source_in": 10.0,
              "mutes": [{ "from": 11.0, "to": 11.5 }, { "from": 50.0, "to": 50.5 }] },
            { "id": "b", "track": "a1", "start": 300, "duration": 300, "color": "blue",
              "type": "audio", "media": "m", "source_in": 120.0,
              "mutes": [{ "from": 121.0, "to": 121.2 }] }
        ]));
        let mut mutes: ClipMutes = HashMap::new();
        // Clip a was looked at from 10 s to 20 s of its source.
        mutes.insert(
            "a".into(),
            (
                10.0,
                20.0,
                vec![Mute {
                    from: 12.0,
                    to: 12.4,
                }],
            ),
        );
        write_mutes(&mut project, &mutes);
        let of = |id: &str| match project.clip(id).map(|clip| &clip.content) {
            Some(ClipContent::Audio { mutes, .. }) => mutes.clone(),
            _ => Vec::new(),
        };
        // The old one inside the span replaced, the one after kept; b untouched.
        assert_eq!(
            of("a"),
            [
                Mute {
                    from: 12.0,
                    to: 12.4
                },
                Mute {
                    from: 50.0,
                    to: 50.5
                }
            ]
        );
        assert_eq!(
            of("b"),
            [Mute {
                from: 121.0,
                to: 121.2
            }]
        );
    }

    #[test]
    fn stars_subtitles_in_place_keeping_their_words() {
        let mut project = project_with(json!([
            { "id": "s1", "track": "v2", "start": 30, "duration": 60, "color": "cyan",
              "name": "Subtitle · Officer", "type": "text", "text": "What the fuck, man",
              "transform": { "x": 0, "y": -300, "scale": 1, "rotation": 0 },
              "word_times": [0, 5, 10, 20] },
            { "id": "s2", "track": "v2", "start": 300, "duration": 60, "color": "cyan",
              "name": "Subtitle · Officer", "type": "text", "text": "fuck off" },
            { "id": "t", "track": "v1", "start": 30, "duration": 60, "color": "cyan",
              "name": "Title", "type": "text", "text": "fuck" }
        ]));
        let words = [word("fuck,", 1500.0, 1800.0, "a")];
        let found: Vec<Found> = suggestions(&words, false, 0.0, 10_000.0)
            .into_iter()
            .map(|suggestion| Found {
                clip: "a".into(),
                timeline_ms: (suggestion.at_ms, suggestion.end_ms),
                suggestion,
            })
            .collect();
        assert_eq!(star_subtitles(&mut project, &found, 0, 900, 30.0), 1);
        let text = |id: &str| match project.clip(id).map(|clip| &clip.content) {
            Some(ClipContent::Text {
                text,
                transform,
                word_times,
                ..
            }) => (text.clone(), transform.y, word_times.len()),
            _ => (String::new(), 0.0, 0),
        };
        // Starred where it's said, kept where it was put, one word per time.
        assert_eq!(text("s1"), ("What the f***, man".into(), -300.0, 4));
        // Not up while it's said, or not a subtitle: left alone.
        assert_eq!(text("s2").0, "fuck off");
        assert_eq!(text("t").0, "fuck");
    }
}
