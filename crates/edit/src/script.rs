//! Scripts: read a Google Doc (footage ranges linked to Google Drive files and
//! the narration between them), download the footage from Drive, and lay the
//! edit out in order: each range as a clip, each narration as a cut-in card.
//!
//! Everything goes through `curl` (as transcription does): no TLS stack in
//! Edit, resumable downloads, and no API key. Drive's "can't scan this file
//! for viruses" page is skipped with `confirm=t`, or by following its form.

use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Weak};
use std::time::{Duration, Instant};

use edit_core::{
    Clip, ClipColor, ClipContent, Glow, Project, Rgba, Script, ScriptBlock, TextAlign,
    TextAnimation, TextStyle, TrackKind, Transform,
};
use serde::Serialize;
use serde_json::json;

use crate::server::{import_paths, App};

/// How long a cut-in card holds when there's no voice-over yet.
pub const CUT_IN_SECONDS: f64 = 3.0;

// ---------------------------------------------------------------------------
// Reading the Doc.

/// A script as read from a Doc.
#[derive(Debug, Default)]
pub struct Parsed {
    pub title: String,
    pub blocks: Vec<ScriptBlock>,
}

/// The document id in a Google Docs link.
pub fn doc_id(url: &str) -> Option<String> {
    let rest = url.split("/document/d/").nth(1)?;
    let id = id_chars(rest);
    (id.len() > 10).then_some(id)
}

/// The file id in a Google Drive link (`/file/d/ID/…`, `open?id=ID`, `uc?id=ID`).
pub fn drive_file_id(url: &str) -> Option<String> {
    if !url.contains("drive.google.com") && !url.contains("drive.usercontent.google.com") {
        return None;
    }
    let id = match url.split("/file/d/").nth(1) {
        Some(rest) => id_chars(rest),
        None => id_chars(query(url, "id")?),
    };
    (id.len() > 10).then_some(id)
}

fn id_chars(text: &str) -> String {
    text.chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

/// A query parameter's raw value.
/// A query value runs to the next `&` (Docs leaves the `?` inside `q=` unescaped).
fn query<'a>(url: &'a str, key: &str) -> Option<&'a str> {
    let search = url.split_once('?')?.1.split('#').next()?;
    let needle = format!("{key}=");
    let (at, _) = search.match_indices(&needle).find(|(at, _)| {
        at.checked_sub(1)
            .and_then(|before| search.as_bytes().get(before))
            .is_none_or(|byte| matches!(byte, b'&' | b'?'))
    })?;
    search.get(at + needle.len()..)?.split('&').next()
}

/// Fetches a Doc that's shared with anyone who has the link, as HTML (which
/// keeps each link's target), and its title (the export's file name).
pub fn fetch_doc(id: &str) -> Result<(String, String), String> {
    let url = format!("https://docs.google.com/document/d/{id}/export?format=html");
    let output = Command::new("curl")
        .args([
            "-sS",
            "-L",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--max-time",
            "30",
            "--max-filesize",
            "20000000",
        ])
        .args([
            "-w",
            "\n%{http_code} %{url_effective}\n%header{content-disposition}",
        ])
        .arg(&url)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("curl: {error}"))?;
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let (rest, disposition) = text.rsplit_once('\n').unwrap_or((&text, ""));
    let (body, status) = rest.rsplit_once('\n').unwrap_or((rest, ""));
    let (code, effective) = status.split_once(' ').unwrap_or((status, ""));
    if code != "200" || effective.contains("accounts.google.com") || !body.contains("<body") {
        return Err("Couldn't read that Google Doc. Share it so anyone with the link can view, then try again.".into());
    }
    let title = disposition_name(disposition)
        .map(|name| name.trim_end_matches(".html").to_owned())
        .unwrap_or_default();
    Ok((body.to_owned(), title))
}

/// One paragraph of the Doc: its text, which byte ranges link where, and the
/// comment markers ([a], [b]…) at their byte offsets.
#[derive(Debug, Default)]
struct Para {
    text: String,
    links: Vec<(usize, usize, String)>,
    refs: Vec<(usize, String)>,
}

/// Google Docs' HTML export: paragraphs, links, and the comments at the end.
fn read_html(html: &str) -> (String, Vec<Para>, HashMap<String, String>) {
    let mut title = String::new();
    let mut paras = Vec::new();
    let mut comments: HashMap<String, String> = HashMap::new();
    let mut current: Option<Para> = None;
    let mut link: Option<(usize, String)> = None;
    let mut marker = false;
    let mut comment: Option<String> = None;
    let (mut in_title, mut hidden) = (false, false);
    let mut rest = html;
    while !rest.is_empty() {
        if let Some(open) = rest.strip_prefix('<') {
            let (tag, after) = open.split_once('>').unwrap_or((open, ""));
            rest = after;
            let closing = tag.starts_with('/');
            let name = tag
                .trim_start_matches('/')
                .chars()
                .take_while(char::is_ascii_alphanumeric)
                .collect::<String>()
                .to_ascii_lowercase();
            match name.as_str() {
                "title" => in_title = !closing,
                "style" | "script" => hidden = !closing,
                "p" | "li" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                    if let Some(para) = current.take() {
                        match &comment {
                            Some(id) => comments.entry(id.clone()).or_default().push('\n'),
                            None => paras.push(para),
                        }
                    }
                    if !closing {
                        current = Some(Para::default());
                    }
                }
                "br" => {
                    if let Some(para) = current.as_mut() {
                        para.text.push('\n');
                    }
                }
                "a" if closing => {
                    if marker {
                        marker = false;
                    } else if let (Some((start, href)), Some(para)) =
                        (link.take(), current.as_mut())
                    {
                        para.links.push((start, para.text.len(), href));
                    }
                }
                "a" => {
                    let href = attribute(tag, "href").map(|href| decode_entities(&href));
                    let id = attribute(tag, "id");
                    match (href, id) {
                        // A comment's own text starts here (href back to its marker).
                        (Some(href), Some(id)) if href.starts_with("#cmnt_ref") => {
                            comment = Some(id);
                            marker = true;
                        }
                        // A comment marker in the text.
                        (Some(href), Some(_)) if href.starts_with("#cmnt") => {
                            if let Some(para) = current.as_mut() {
                                let id = href.strip_prefix('#').unwrap_or(&href);
                                para.refs.push((para.text.len(), id.to_owned()));
                            }
                            marker = true;
                        }
                        (Some(href), _) if !href.starts_with('#') => {
                            let start = current.as_ref().map_or(0, |para| para.text.len());
                            link = Some((start, unwrap_google_redirect(&href)));
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        } else {
            let (text, after) = match rest.find('<') {
                Some(end) => rest.split_at(end),
                None => (rest, ""),
            };
            let text = decode_entities(text);
            rest = after;
            if hidden || marker {
                continue;
            }
            if in_title {
                title.push_str(&text);
            } else if let Some(id) = &comment {
                comments.entry(id.clone()).or_default().push_str(&text);
            } else if let Some(para) = current.as_mut() {
                para.text.push_str(&text);
            }
        }
    }
    if let Some(para) = current.take() {
        if comment.is_none() {
            paras.push(para);
        }
    }
    (title.trim().to_owned(), paras, comments)
}

fn attribute(tag: &str, name: &str) -> Option<String> {
    let (_, rest) = tag.split_once(&format!(" {name}=\""))?;
    let (value, _) = rest.split_once('"')?;
    Some(value.to_owned())
}

/// Docs wraps links as google.com/url?q=<target>.
fn unwrap_google_redirect(href: &str) -> String {
    if href.contains("google.com/url?") {
        if let Some(target) = query(href, "q") {
            return percent_decode(target);
        }
    }
    href.to_owned()
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while let Some(&byte) = bytes.get(i) {
        if byte == b'%' && i + 2 < bytes.len() {
            // Not two hex digits (or not even whole characters): a plain `%`.
            if let Some(decoded) = text
                .get(i + 1..i + 3)
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            {
                out.push(decoded);
                i += 3;
                continue;
            }
        }
        out.push(byte);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some((before, after)) = rest.split_once('&') {
        out.push_str(before);
        // An entity is short: its `;` comes within the next few bytes.
        let Some((entity, tail)) = after
            .split_once(';')
            .filter(|(entity, _)| entity.len() < 11)
        else {
            out.push('&');
            rest = after;
            continue;
        };
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            "rsquo" | "lsquo" => Some('\''),
            "ldquo" | "rdquo" => Some('"'),
            "ndash" => Some('–'),
            "mdash" => Some('—'),
            "hellip" => Some('…'),
            _ => entity
                .strip_prefix("#x")
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|dec| dec.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(if c == '\u{a0}' { ' ' } else { c });
                rest = tail;
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// A "mm:ss - mm:ss" (or h:mm:ss) range in text: byte span and seconds.
#[derive(Debug, PartialEq)]
struct Range {
    start: usize,
    end: usize,
    from: f64,
    to: f64,
}

/// Parses "m:ss" / "mm:ss" / "h:mm:ss" at the start of `text`: (seconds, bytes used).
fn timestamp(text: &str) -> Option<(f64, usize)> {
    let mut parts = Vec::new();
    let mut used = 0;
    loop {
        let rest = text.get(used..)?;
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 || digits > 2 || (!parts.is_empty() && digits != 2) {
            return None;
        }
        let (number, rest) = rest.split_at_checked(digits)?;
        parts.push(number.parse::<f64>().ok()?);
        used += digits;
        if parts.len() < 3
            && rest
                .strip_prefix(':')
                .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
        {
            used += 1;
        } else {
            break;
        }
    }
    if parts.len() < 2 || parts.iter().skip(1).any(|part| *part >= 60.0) {
        return None;
    }
    Some((
        parts.iter().fold(0.0, |total, part| total * 60.0 + part),
        used,
    ))
}

fn find_ranges(text: &str) -> Vec<Range> {
    let mut ranges = Vec::new();
    let mut at = 0;
    while at < text.len() {
        let Some(offset) = text
            .get(at..)
            .and_then(|rest| rest.find(|c: char| c.is_ascii_digit()))
        else {
            break;
        };
        let start = at + offset;
        let after_digit = text
            .get(..start)
            .unwrap_or_default()
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_digit() || c == ':');
        if let (false, Some((from, used))) = (after_digit, text.get(start..).and_then(timestamp)) {
            let mut cursor = start + used;
            let skip = |cursor: &mut usize| {
                while let Some(c) = text
                    .get(*cursor..)
                    .and_then(|rest| rest.chars().next())
                    .filter(|c| c.is_whitespace() || *c == '\u{a0}')
                {
                    *cursor += c.len_utf8();
                }
            };
            skip(&mut cursor);
            if let Some(dash) = text
                .get(cursor..)
                .and_then(|rest| rest.chars().next())
                .filter(|c| matches!(c, '-' | '–' | '—' | '‑' | '‐' | '−'))
            {
                cursor += dash.len_utf8();
                skip(&mut cursor);
                if let Some((to, used)) = text.get(cursor..).and_then(timestamp) {
                    let end = cursor + used;
                    if to > from {
                        ranges.push(Range {
                            start,
                            end,
                            from,
                            to,
                        });
                    }
                    at = end;
                    continue;
                }
            }
        }
        at = start
            + text
                .get(start..)
                .unwrap_or_default()
                .chars()
                .take_while(char::is_ascii_digit)
                .count()
                .max(1);
    }
    ranges
}

fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for (index, line) in text
        .split('\n')
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .enumerate()
    {
        if index > 0 && !line.is_empty() && !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&line);
    }
    out.trim().to_owned()
}

/// The comments on a stretch of text, minus resolved ones: a reply of
/// "fixed"/"done" closes the note before it.
fn notes(refs: &[&(usize, String)], comments: &HashMap<String, String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (_, id) in refs {
        let Some(text) = comments
            .get(id)
            .map(|text| collapse(text))
            .filter(|text| !text.is_empty())
        else {
            continue;
        };
        let lower = text.to_ascii_lowercase();
        if matches!(
            lower.trim_end_matches(['.', '!']),
            "fixed" | "done" | "resolved" | "ok" | "okay"
        ) {
            out.pop();
        } else {
            out.push(text);
        }
    }
    out
}

/// Reads a script Doc's HTML export into footage ranges and narration.
pub fn parse(html: &str) -> Parsed {
    let (title, paras, comments) = read_html(html);
    // A range without its own link belongs to the last linked file (or the only one).
    let files: Vec<(String, String)> = paras
        .iter()
        .flat_map(|para| para.links.iter())
        .filter_map(|(_, _, url)| drive_file_id(url).map(|id| (url.clone(), id)))
        .collect();
    let only = {
        let ids: HashSet<&String> = files.iter().map(|(_, id)| id).collect();
        files.first().filter(|_| ids.len() == 1).cloned()
    };
    let mut last = only.clone();
    let mut blocks: Vec<ScriptBlock> = Vec::new();
    let mut seen_footage = false;
    for para in &paras {
        let ranges = find_ranges(&para.text);
        if ranges.is_empty() {
            let text = collapse(&para.text);
            // The video opens on the first timestamp: anything before it is the
            // Doc's heading (title, "Assets:", durations), never a cut-in.
            if text.is_empty() || !seen_footage {
                continue;
            }
            let notes = notes(&para.refs.iter().collect::<Vec<_>>(), &comments);
            if let Some(ScriptBlock::Narration {
                text: previous,
                notes: previous_notes,
                ..
            }) = blocks.last_mut()
            {
                previous.push_str("\n\n");
                previous.push_str(&text);
                previous_notes.extend(notes);
            } else {
                blocks.push(ScriptBlock::Narration {
                    text,
                    notes,
                    clip: None,
                    voiceover: None,
                });
            }
            continue;
        }
        seen_footage = true;
        for (index, range) in ranges.iter().enumerate() {
            let linked = para
                .links
                .iter()
                .filter(|(start, end, _)| *start < range.end && *end > range.start)
                .find_map(|(_, _, url)| drive_file_id(url).map(|id| (url.clone(), id)));
            let Some((url, file)) = linked.or_else(|| last.clone()) else {
                continue;
            };
            last = Some((url.clone(), file.clone()));
            // The link's ?t= is the exact start (the text rounds to the second).
            let start = query(&url, "t")
                .and_then(|t| t.trim_end_matches('s').parse::<f64>().ok())
                .filter(|t| (t - range.from).abs() <= 2.0)
                .unwrap_or(range.from);
            let next = ranges.get(index + 1).map_or(usize::MAX, |next| next.start);
            let from = if index == 0 { 0 } else { range.start };
            let refs: Vec<_> = para
                .refs
                .iter()
                .filter(|(at, _)| *at >= from && *at < next)
                .collect();
            let range_notes = notes(&refs, &comments);
            blocks.push(ScriptBlock::Footage {
                url,
                file,
                start,
                end: range.to.max(start + 0.1),
                label: collapse(para.text.get(range.start..range.end).unwrap_or_default())
                    .replace(['‑', '–', '—'], "-"),
                words: cue_words(&range_notes),
                notes: range_notes,
                media: None,
                media_start: None,
                cut: None,
                clip: None,
            });
        }
    }
    Parsed { title, blocks }
}

/// The first and last words of a range's "first words....last words" comment
/// (editors write where a range starts and ends this way).
fn cue_words(notes: &[String]) -> Option<[String; 2]> {
    notes.iter().find_map(|note| {
        let (left, right) = note.split_once("..").or_else(|| note.split_once('…'))?;
        let left = left.trim_end_matches('.');
        let right = right.trim_start_matches(['.', '…']);
        let first = left.split_whitespace().next()?;
        let last = right.split_whitespace().last()?;
        Some([first.to_owned(), last.to_owned()])
    })
}

// ---------------------------------------------------------------------------
// Precise cuts: the Doc rounds ranges to the second, so each range is cut at
// its first and last words as the transcript times them.

/// Room left before the first word and after the last, so cuts breathe.
pub const WORD_PAD: f64 = 0.08;
/// Speech closer than this to the cut runs straight on: no room is left (it
/// would catch the next word), and the cut goes in the quietest instant
/// within `SETTLE` of the word's edge (transcript times are a little loose).
const RUN_ON: f64 = 0.3;
const SETTLE: f64 = 0.06;
/// How far from the written time a cue word may be found.
const CUE_SEARCH: f64 = 3.0;

fn normalize(word: &str) -> String {
    word.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// A cue word that's spoken: "*Victim groans*" describes a sound, not a word.
fn spoken(word: &str) -> Option<String> {
    if word.starts_with(['*', '(', '[']) || word.ends_with(['*', ')', ']']) {
        return None;
    }
    Some(normalize(word)).filter(|word| !word.is_empty())
}

/// How well a transcript word matches a cue word from the Doc: 0 the same,
/// 1 the same word spelt a little differently (a plural or possessive,
/// "priuses" for "Prius", or a letter or two off), None not it. Short words
/// must match exactly.
fn likeness(word: &str, cue: &str) -> Option<u8> {
    let word = normalize(word);
    if word == cue {
        return Some(0);
    }
    let shortest = word.chars().count().min(cue.chars().count());
    if shortest < 4 {
        return None;
    }
    let stem = |text: &str| {
        let text = text
            .strip_suffix("es")
            .filter(|rest| rest.len() >= 3)
            .unwrap_or(text);
        text.strip_suffix('s')
            .filter(|rest| rest.len() >= 3)
            .unwrap_or(text)
            .to_owned()
    };
    let (a, b) = (stem(&word), stem(cue));
    let allowed = if shortest >= 8 { 2 } else { 1 };
    (a == b || a == cue || b == word || edit_distance(&a, &b) <= allowed).then_some(1)
}

/// Levenshtein distance.
fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        // The row so far: the cell above-left, and the one just written to the left.
        let (mut previous, mut left) = (i, i + 1);
        for (cell, cb) in row.iter_mut().skip(1).zip(&b) {
            let here = *cell;
            *cell = (previous + usize::from(ca != *cb))
                .min(left + 1)
                .min(here + 1);
            previous = here;
            left = *cell;
        }
        if let Some(first) = row.first_mut() {
            *first = i + 1;
        }
    }
    row.last().copied().unwrap_or(0)
}

/// The quietest moment between `from` and `to` (seconds) in a media file's
/// peaks (one level per 1/`PEAKS_PER_SECOND` s), nearest `near` among equals.
fn quietest(peaks: &[u8], from: f64, to: f64, near: f64) -> Option<f64> {
    let rate = f64::from(crate::media::PEAKS_PER_SECOND);
    let first = (from * rate).ceil().max(0.0) as usize;
    let last = ((to * rate).floor().max(0.0) as usize).min(peaks.len().checked_sub(1)?);
    (first..=last)
        .filter_map(|index| Some((*peaks.get(index)?, index as f64 / rate)))
        .min_by(|a, b| {
            a.0.cmp(&b.0)
                .then((a.1 - near).abs().total_cmp(&(b.1 - near).abs()))
        })
        .map(|(_, at)| at)
}

/// Finds a range's first and last words near where it's written to start and
/// end (the same word, else the closest spelling of it), and returns where to
/// cut: just before the first, just after the last (never into a
/// neighbouring word; when speech runs straight on, right at the word, in the
/// quietest instant `peaks` show there). Times are in the transcript's clock.
pub fn align(
    words: &[crate::transcribe::Word],
    peaks: Option<&[u8]>,
    cue: &[String; 2],
    start: f64,
    end: f64,
) -> (Option<f64>, Option<f64>) {
    let nearest = |wanted: Option<String>, time: f64, at: fn(&crate::transcribe::Word) -> f64| {
        let wanted = wanted?;
        words
            .iter()
            .enumerate()
            .filter(|(_, word)| (at(word) - time).abs() <= CUE_SEARCH)
            .filter_map(|(index, word)| {
                likeness(&word.text, &wanted).map(|score| (score, (at(word) - time).abs(), index))
            })
            .min_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)))
            .map(|(_, _, index)| index)
    };
    // A range written "…-02:03" ends somewhere in that second.
    let first = nearest(spoken(&cue[0]), start, |word| word.start);
    let last = nearest(spoken(&cue[1]), end + 0.5, |word| word.end);
    let cut_in = first.and_then(|index| {
        let word = words.get(index)?;
        let before = index
            .checked_sub(1)
            .and_then(|previous| words.get(previous))
            .map(|previous| previous.end)
            .filter(|previous| *previous <= word.start);
        let cut = match before.filter(|before| word.start - before < RUN_ON) {
            Some(before) => peaks
                .and_then(|peaks| {
                    let from = (word.start - SETTLE).max(before);
                    quietest(
                        peaks,
                        from,
                        word.start + SETTLE.min(word.end - word.start) / 2.0,
                        word.start,
                    )
                })
                .unwrap_or(word.start),
            None => (word.start - WORD_PAD).max(before.unwrap_or(f64::MIN)),
        };
        Some(cut.max(0.0))
    });
    let cut_out = last.and_then(|index| {
        let word = words.get(index)?;
        let after = words
            .get(index + 1)
            .map(|next| next.start)
            .filter(|next| *next >= word.end);
        Some(match after.filter(|after| after - word.end < RUN_ON) {
            Some(after) => peaks
                .and_then(|peaks| {
                    let to = (word.end + SETTLE).min(after);
                    quietest(
                        peaks,
                        word.end - SETTLE.min(word.end - word.start) / 2.0,
                        to,
                        word.end,
                    )
                })
                .unwrap_or(word.end),
            None => (word.end + WORD_PAD).min(after.unwrap_or(f64::MAX)),
        })
    });
    match (cut_in, cut_out) {
        // Out before in: one side matched the wrong word.
        (Some(cut_in), Some(cut_out)) if cut_in >= cut_out => (None, None),
        found => found,
    }
}

// ---------------------------------------------------------------------------
// Downloading from Google Drive.

#[derive(Clone, Debug, Serialize)]
pub struct FileJob {
    pub file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Job {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub files: Vec<FileJob>,
}

/// Script imports in progress, per project.
#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, Job>>);

impl Jobs {
    pub fn get(&self, project: &str) -> Option<Job> {
        self.0.lock().get(project).cloned()
    }

    fn claim(&self, app: &App, project: &str, job: Job) -> bool {
        let mut jobs = self.0.lock();
        if jobs
            .get(project)
            .is_some_and(|job| matches!(job.state, "downloading" | "transcribing" | "placing"))
        {
            return false;
        }
        jobs.insert(project.to_owned(), job.clone());
        drop(jobs);
        app.store
            .emit(json!({ "type": "script", "id": project, "job": job }));
        true
    }

    fn set(&self, app: &App, project: &str, edit: impl FnOnce(&mut Job)) {
        let job = {
            let mut jobs = self.0.lock();
            let job = jobs.entry(project.to_owned()).or_insert_with(|| Job {
                state: "downloading",
                error: None,
                files: Vec::new(),
            });
            edit(job);
            job.clone()
        };
        app.store
            .emit(json!({ "type": "script", "id": project, "job": job }));
    }
}

struct Head {
    status: u32,
    html: bool,
    name: Option<String>,
    total: Option<u64>,
}

/// Asks for the first byte: the final headers say whether Drive will send the
/// file (and its name and size) or a page instead.
fn probe(url: &str, scratch: &Path) -> Result<Head, String> {
    let output = Command::new("curl")
        .args([
            "-sS",
            "-L",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "-r",
            "0-0",
            "--max-filesize",
            "1048576",
            "--connect-timeout",
            "20",
            "--max-time",
            "60",
            "-D",
            "-",
            "-o",
        ])
        .arg(scratch)
        .arg(url)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("curl: {error}"))?;
    let _ = std::fs::remove_file(scratch);
    let headers = String::from_utf8_lossy(&output.stdout).to_string();
    // Only the last response counts (after redirects).
    let last = headers
        .rfind("\nHTTP/")
        .and_then(|at| headers.get(at + 1..))
        .unwrap_or(&headers);
    let status = last
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let header = |name: &str| {
        last.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim()
                .eq_ignore_ascii_case(name)
                .then(|| value.trim().to_owned())
        })
    };
    let total = header("content-range")
        .and_then(|range| {
            range
                .rsplit('/')
                .next()
                .and_then(|total| total.trim().parse().ok())
        })
        .or_else(|| {
            header("content-length")
                .and_then(|length| length.parse().ok())
                .filter(|_| status == 200)
        });
    Ok(Head {
        status,
        html: header("content-type").is_some_and(|kind| kind.starts_with("text/html")),
        name: header("content-disposition").and_then(|value| disposition_name(&value)),
        total,
    })
}

fn disposition_name(value: &str) -> Option<String> {
    if let Some(encoded) = value.split("filename*=").nth(1) {
        let encoded = encoded.split(';').next()?.trim().trim_matches('"');
        let encoded = encoded.split("''").nth(1).unwrap_or(encoded);
        return Some(percent_decode(encoded));
    }
    let name = value
        .split("filename=")
        .nth(1)?
        .split(';')
        .next()?
        .trim()
        .trim_matches('"');
    (!name.is_empty()).then(|| name.to_owned())
}

/// A file name safe to write: no separators or leading dots.
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '\0') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_owned();
    if cleaned.is_empty() {
        "footage.mp4".to_owned()
    } else {
        cleaned
    }
}

/// The download link behind Drive's "can't scan for viruses" page, if this is that page.
fn confirm_link(page: &str) -> Option<String> {
    let form = page.get(page.find("id=\"download-form\"")?..)?;
    let (tag, _) = form.split_once('>')?;
    let action = attribute(tag, "action").map(|action| decode_entities(&action))?;
    // A Drive upload can itself contain HTML. Never let its form direct curl
    // at an arbitrary URL, local file or service on the editor's network.
    if action != "https://drive.usercontent.google.com/download" {
        return None;
    }
    let form = form.split("</form>").next().unwrap_or(form);
    let fields: Vec<String> = form
        .split("<input")
        .skip(1)
        .filter(|input| input.contains("type=\"hidden\""))
        .filter_map(|input| {
            Some(format!(
                "{}={}",
                attribute(input, "name")?,
                decode_entities(&attribute(input, "value").unwrap_or_default())
            ))
        })
        .collect();
    Some(format!("{action}?{}", fields.join("&")))
}

fn page_problem(page: &str) -> String {
    if page.contains("Too many users") || page.contains("quota") {
        "Google Drive's download limit for this file is used up for today. Try later, or upload a copy.".into()
    } else if page.contains("accounts.google.com") || page.contains("ServiceLogin") {
        "This Drive file isn't shared. Set it so anyone with the link can view.".into()
    } else {
        "Google Drive sent a page instead of the file.".into()
    }
}

/// Stops a download left running by an earlier server (it would write over
/// the resumed one). Only a curl writing into this folder is touched.
fn stop_stale(dir: &Path) {
    let Some(pid) = std::fs::read_to_string(dir.join(".pid"))
        .ok()
        .and_then(|pid| pid.trim().parse::<u32>().ok())
    else {
        return;
    };
    let _ = std::fs::remove_file(dir.join(".pid"));
    #[cfg(unix)]
    {
        let command = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "command="])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
            .unwrap_or_default();
        if command.contains("curl") && command.contains(&*dir.to_string_lossy()) {
            let _ = Command::new("kill").arg(pid.to_string()).status();
            std::thread::sleep(Duration::from_millis(300));
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .status();
    }
}

/// Downloads one Drive file into `dir` (resuming a partial download), calling
/// `progress(bytes, total, name)` as it goes. Finished files are reused.
pub fn download(
    dir: &Path,
    file: &str,
    progress: &dyn Fn(u64, Option<u64>, &str),
) -> Result<PathBuf, String> {
    static DOWNLOADS: LazyLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    let lock = {
        let mut downloads = DOWNLOADS.lock();
        downloads.retain(|_, lock| lock.strong_count() > 0);
        let lock = downloads
            .get(dir)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| Arc::new(Mutex::new(())));
        downloads.insert(dir.to_path_buf(), Arc::downgrade(&lock));
        lock
    };
    let _guard = lock.lock();
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    if let Ok(name) = std::fs::read_to_string(dir.join(".done")) {
        let path = dir.join(name.trim());
        if path.exists() {
            return Ok(path);
        }
    }
    let scratch = dir.join(".probe");
    let mut url = format!(
        "https://drive.usercontent.google.com/download?id={file}&export=download&confirm=t"
    );
    let mut head = probe(&url, &scratch)?;
    if head.html {
        let page = Command::new("curl")
            .args([
                "-sS",
                "-L",
                "--proto",
                "=https",
                "--proto-redir",
                "=https",
                "--max-time",
                "30",
                "--max-filesize",
                "5000000",
            ])
            .arg(&url)
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
            .unwrap_or_default();
        url = confirm_link(&page).ok_or_else(|| page_problem(&page))?;
        head = probe(&url, &scratch)?;
        if head.html {
            return Err(page_problem(""));
        }
    }
    if head.status == 403 || head.status == 401 {
        return Err(
            "This Drive file isn't shared. Set it so anyone with the link can view.".into(),
        );
    }
    if head.status == 404 {
        return Err("Google Drive can't find this file (deleted, or in the trash).".into());
    }
    if head.status >= 400 || head.status == 0 {
        return Err(format!("Google Drive answered {}.", head.status));
    }
    let name = safe_name(head.name.as_deref().unwrap_or(&format!("{file}.mp4")));
    let part = dir.join(".download");
    stop_stale(dir);
    let mut child = Command::new("curl")
        .args([
            "-sS",
            "-L",
            "--fail",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "-C",
            "-",
            "--retry",
            "5",
            "--retry-delay",
            "3",
            "--connect-timeout",
            "20",
            "-o",
        ])
        .arg(&part)
        .arg(&url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("curl: {error}"))?;
    // A server that dies mid-download leaves curl running; the next run stops it first.
    let _ = std::fs::write(dir.join(".pid"), child.id().to_string());
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        progress(
            std::fs::metadata(&part).map_or(0, |meta| meta.len()),
            head.total,
            &name,
        );
        std::thread::sleep(Duration::from_millis(400));
    };
    let _ = std::fs::remove_file(dir.join(".pid"));
    let size = std::fs::metadata(&part).map_or(0, |meta| meta.len());
    if !status.success() {
        let mut detail = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = std::io::Read::read_to_string(&mut stderr, &mut detail);
        }
        return Err(format!(
            "Download stopped ({}). It resumes where it left off when you retry.",
            detail.trim().trim_start_matches("curl: ")
        ));
    }
    if head.total.is_some_and(|total| total != size) {
        return Err("The download ended early. Retry to resume it.".into());
    }
    progress(size, head.total, &name);
    let path = dir.join(&name);
    std::fs::rename(&part, &path).map_err(|error| error.to_string())?;
    std::fs::write(dir.join(".done"), &name).map_err(|error| error.to_string())?;
    Ok(path)
}

// ---------------------------------------------------------------------------
// Excerpts: police footage runs for hours and a script uses minutes of it.
// Only what the script uses (with room to trim) becomes media, so proxies
// stay small. Cut losslessly from a keyframe, so timing is exact.

/// Footage kept either side of a range, for trimming.
const HANDLE_SECONDS: f64 = 10.0;
/// Ranges closer than this share one excerpt.
const MERGE_SECONDS: f64 = 120.0;

/// A piece of a downloaded file: `from`..`to` seconds of it.
#[derive(Clone, Debug)]
pub struct Excerpt {
    pub path: PathBuf,
    pub from: f64,
    pub to: f64,
}

fn duration_of(path: &Path) -> Result<f64, String> {
    let output = Command::new(crate::tools::ffprobe())
        .args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .map_err(|error| format!("ffprobe: {error}"))?;
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .map_err(|_| format!("couldn't read {}", path.display()))
}

/// The last keyframe at or before `time` (an excerpt must start on one to be cut without re-encoding).
fn keyframe_before(path: &Path, time: f64) -> f64 {
    for window in [20.0, 120.0, 600.0] {
        let from = (time - window).max(0.0);
        let output = Command::new(crate::tools::ffprobe())
            .args([
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-select_streams",
                "v:0",
                "-skip_frame",
                "nokey",
                "-show_entries",
                "frame=pts_time",
                "-of",
                "csv=p=0",
            ])
            .args(["-read_intervals", &format!("{from}%{}", time + 0.001)])
            .arg(path)
            .output();
        let best = output
            .ok()
            .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
            .unwrap_or_default()
            .lines()
            .filter_map(|line| line.trim().trim_end_matches(',').parse::<f64>().ok())
            .filter(|pts| *pts <= time + 1e-6)
            .fold(None, |best: Option<f64>, pts| {
                Some(best.map_or(pts, |best| best.max(pts)))
            });
        if let Some(best) = best {
            return best;
        }
        if from == 0.0 {
            break;
        }
    }
    0.0
}

/// Merged, padded spans of a file that `ranges` (seconds) need.
fn spans(ranges: &[(f64, f64)], duration: f64) -> Vec<(f64, f64)> {
    let mut sorted: Vec<(f64, f64)> = ranges
        .iter()
        .map(|(from, to)| {
            (
                (from - HANDLE_SECONDS).max(0.0),
                (to + HANDLE_SECONDS).min(duration),
            )
        })
        .filter(|(from, to)| to > from)
        .collect();
    sorted.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for (from, to) in sorted {
        match merged.last_mut() {
            Some(last) if from - last.1 < MERGE_SECONDS => last.1 = last.1.max(to),
            _ => merged.push((from, to)),
        }
    }
    merged
}

/// Cuts the parts of `source` that `ranges` need into excerpt files beside it
/// (reused if already cut). Footage mostly used anyway stays whole. Picture
/// is copied from a keyframe; sound is re-encoded so it starts on that same
/// instant (copied audio would begin earlier and shift everything).
pub fn excerpts(source: &Path, ranges: &[(f64, f64)]) -> Result<Vec<Excerpt>, String> {
    let duration = duration_of(source)?;
    let spans = spans(ranges, duration);
    let used: f64 = spans.iter().map(|(from, to)| to - from).sum();
    if spans.is_empty() || used >= duration * 0.6 {
        return Ok(vec![Excerpt {
            path: source.to_path_buf(),
            from: 0.0,
            to: duration,
        }]);
    }
    let dir = source.parent().unwrap_or(Path::new(".")).join("excerpts");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let stem = source.file_stem().map_or_else(
        || "footage".into(),
        |stem| stem.to_string_lossy().to_string(),
    );
    let stem: String = stem.chars().take(20).collect();
    let source_key = crate::media::media_key(source);
    let extension = source
        .extension()
        .map_or_else(|| "mp4".into(), |ext| ext.to_string_lossy().to_string());
    let mut out = Vec::new();
    for (from, to) in spans {
        let start = keyframe_before(source, from);
        let clock = |seconds: f64| {
            let whole = seconds.round() as u64;
            format!("{}h{:02}m{:02}s", whole / 3600, whole / 60 % 60, whole % 60)
        };
        let path = dir.join(format!(
            "{stem} {}-{}-{source_key}-{:016x}-{:016x}.{extension}",
            clock(start),
            clock(to),
            start.to_bits(),
            to.to_bits()
        ));
        if !path.exists() {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let partial = dir.join(format!(
                ".cutting-{}-{}-{}.{}",
                std::process::id(),
                crate::store::now_ms(),
                NEXT.fetch_add(1, Ordering::Relaxed),
                extension
            ));
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&partial)
                .map_err(|error| error.to_string())?;
            struct Partial(PathBuf);
            impl Drop for Partial {
                fn drop(&mut self) {
                    let _ = std::fs::remove_file(&self.0);
                }
            }
            let partial = Partial(partial);
            let status = Command::new(crate::tools::ffmpeg())
                .args([
                    "-v",
                    "error",
                    "-y",
                    "-ss",
                    &format!("{start}"),
                    "-protocol_whitelist",
                    "file,pipe",
                    "-i",
                ])
                .arg(source)
                .args([
                    "-t",
                    &format!("{}", to - start),
                    "-map",
                    "0:v:0",
                    "-map",
                    "0:a?",
                    "-c:v",
                    "copy",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "192k",
                ])
                .arg(&partial.0)
                .status()
                .map_err(|error| format!("ffmpeg: {error}"))?;
            if !status.success() {
                return Err("Couldn't cut an excerpt from the footage.".into());
            }
            std::fs::rename(&partial.0, &path).map_err(|error| error.to_string())?;
        }
        out.push(Excerpt {
            path,
            from: start,
            to,
        });
    }
    Ok(out)
}

/// The ranges (seconds) a project's script plays from one file.
fn file_ranges(project: &Project, file: &str) -> Vec<(f64, f64)> {
    project
        .script
        .iter()
        .flat_map(|script| &script.blocks)
        .filter_map(|block| match block {
            ScriptBlock::Footage {
                file: of,
                start,
                end,
                ..
            } if of == file => Some((*start, *end)),
            _ => None,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// The import: download every file, then lay the edit out.

/// Footage files the script needs that aren't media in the project yet, in script order.
fn missing_files(project: &Project) -> Vec<String> {
    let mut seen = HashSet::new();
    project
        .script
        .iter()
        .flat_map(|script| &script.blocks)
        .filter_map(|block| match block {
            ScriptBlock::Footage { file, media, .. }
                if media
                    .as_ref()
                    .is_none_or(|media| project.media(media).is_none()) =>
            {
                Some(file.clone())
            }
            _ => None,
        })
        .filter(|file| seen.insert(file.clone()))
        .collect()
}

/// Whether the script still has footage to fetch or blocks to place.
pub fn unfinished(project: &Project) -> bool {
    let Some(script) = &project.script else {
        return false;
    };
    !missing_files(project).is_empty()
        // Only blocks never placed: one placed and since removed was removed on purpose.
        || script.blocks.iter().any(|block| !placed(project, block))
}

/// Whether a block was ever put on the timeline (since removed counts: on
/// purpose). A cut-in whose card id was cleared (cover_cut_in once did) but
/// whose voice-over is on the timeline was placed.
fn placed(project: &Project, block: &ScriptBlock) -> bool {
    match block {
        ScriptBlock::Footage { clip, .. } => clip.is_some(),
        ScriptBlock::Narration {
            clip, voiceover, ..
        } => {
            clip.is_some()
                || voiceover
                    .as_deref()
                    .is_some_and(|id| project.clip(id).is_some())
        }
    }
}

/// Downloads the script's footage and lays the edit out. Safe to call again:
/// finished downloads are reused and placed blocks are skipped.
pub fn start(app: &App, project_id: &str, recut: bool) {
    let Some(live) = app.store.get(project_id) else {
        return;
    };
    let files = missing_files(&live.project);
    if !app.scripts.claim(
        app,
        project_id,
        Job {
            state: "downloading",
            error: None,
            files: files
                .iter()
                .map(|file| FileJob {
                    file: file.clone(),
                    name: None,
                    bytes: 0,
                    total: None,
                    state: "queued",
                    error: None,
                })
                .collect(),
        },
    ) {
        return;
    }
    let app = app.clone();
    let id = project_id.to_owned();
    tokio::spawn(async move {
        let (job_app, job_id) = (app.clone(), id.clone());
        let work = async move {
            let mut done: Vec<(String, Vec<Excerpt>)> = Vec::new();
            for (index, file) in files.iter().enumerate() {
                app.scripts.set(&app, &id, |job| {
                    if let Some(entry) = job.files.get_mut(index) {
                        entry.state = "downloading";
                    }
                });
                let dir = app.store.drive_dir().join(file);
                let result = {
                    let (app, id, file) = (app.clone(), id.clone(), file.clone());
                    tokio::task::spawn_blocking(move || {
                        let last = Mutex::new(Instant::now() - Duration::from_secs(1));
                        let drive = format!("Drive file {file}");
                        crate::diag::time_on("script", "script: download", &drive, || {
                            download(&dir, &file, &|bytes, total, name| {
                                let mut last = last.lock();
                                if last.elapsed() < Duration::from_millis(350) {
                                    return;
                                }
                                *last = Instant::now();
                                app.scripts.set(&app, &id, |job| {
                                    if let Some(entry) = job.files.get_mut(index) {
                                        entry.bytes = bytes;
                                        entry.total = total;
                                        entry.name = Some(name.to_owned());
                                    }
                                });
                            })
                        })
                    })
                    .await
                    .unwrap_or_else(|error| Err(error.to_string()))
                };
                // Then only the parts the script uses become media.
                let result = match result {
                    Ok(path) => {
                        app.scripts.set(&app, &id, |job| {
                            if let Some(entry) = job.files.get_mut(index) {
                                entry.state = "cutting";
                            }
                        });
                        let ranges = app
                            .store
                            .get(&id)
                            .map(|live| file_ranges(&live.project, file))
                            .unwrap_or_default();
                        let cut = tokio::task::spawn_blocking({
                            let path = path.clone();
                            move || {
                                crate::diag::time_on(
                                    "script",
                                    "script: cut excerpts",
                                    &path.to_string_lossy(),
                                    || excerpts(&path, &ranges),
                                )
                            }
                        })
                        .await
                        .unwrap_or_else(|error| Err(error.to_string()));
                        cut.map(|cut| (path, cut))
                    }
                    Err(error) => Err(error),
                };
                match result {
                    Ok((path, cut)) => {
                        let (bytes, name) = (
                            std::fs::metadata(&path).map_or(0, |meta| meta.len()),
                            path.file_name()
                                .map(|name| name.to_string_lossy().to_string()),
                        );
                        app.scripts.set(&app, &id, |job| {
                            if let Some(entry) = job.files.get_mut(index) {
                                entry.state = "done";
                                entry.bytes = bytes;
                                entry.total = Some(bytes);
                                entry.name = name;
                            }
                        });
                        done.push((file.clone(), cut));
                    }
                    Err(error) => app.scripts.set(&app, &id, |job| {
                        if let Some(entry) = job.files.get_mut(index) {
                            entry.state = "failed";
                            entry.error = Some(error);
                        }
                    }),
                }
            }
            app.scripts.set(&app, &id, |job| job.state = "placing");
            let result =
                crate::diag::time_async("script", "script: lay out", place(&app, &id, done, recut))
                    .await;
            let placed = result.is_ok();
            app.scripts.set(&app, &id, |job| {
                let failed = job
                    .files
                    .iter()
                    .filter(|file| file.state == "failed")
                    .count();
                job.state = if result.is_err() || failed > 0 {
                    "failed"
                } else {
                    "done"
                };
                job.error = result.err().or_else(|| {
                    (failed > 0).then(|| {
                        format!(
                            "{failed} of {} files couldn't be downloaded.",
                            job.files.len()
                        )
                    })
                });
            });
            // A new edit starts with the case's research, so the articles and
            // images are waiting by the time the editing gets to them.
            let home = app.store.home();
            let researched = !crate::research::articles(home, &id).is_empty()
                || !crate::research::items(home, &id).is_empty();
            if placed && !recut && !researched {
                if let Err(error) = app.agents.send(&id, RESEARCH.to_owned(), None, None).await {
                    crate::diag::warn("script", format!("research didn't start for {id}: {error}"));
                }
            }
        };
        // A crash fails the import instead of leaving it mid-way for good.
        if let Err(error) = crate::guard::catch_async("the script import", work).await {
            job_app.scripts.set(&job_app, &job_id, |job| {
                job.state = "failed";
                job.error = Some(error);
            });
        }
    });
}

/// What the agent is asked once a script is first laid out.
const RESEARCH: &str = "The script is imported and laid out. Research the case now (RESEARCH in your house style): start from the script and the transcripts, find the news articles about this case, check each matches and save it, then collect images of the scene, the people involved and the vehicles, and weed out anything off-target so only real candidates wait for review. Don't change the timeline. Finish with a short summary: the key facts the articles add, how many articles you saved and how many images are waiting.";

/// Imports the excerpts, transcribes the footage, finds each range's exact
/// cut from its cue words, and puts every block it can on the timeline.
/// `recut` first clears what an earlier layout placed.
async fn place(
    app: &App,
    id: &str,
    done: Vec<(String, Vec<Excerpt>)>,
    recut: bool,
) -> Result<(), String> {
    if !done.is_empty() {
        let paths = done
            .iter()
            .flat_map(|(_, cut)| {
                cut.iter()
                    .map(|excerpt| excerpt.path.to_string_lossy().to_string())
            })
            .collect();
        let (_, _, errors) = import_paths(app, id, paths, false, "script").await?;
        if let Some(error) = errors.first() {
            return Err(error.clone());
        }
    }
    let files: HashMap<String, Vec<Excerpt>> = done.into_iter().collect();
    let (live, ()) = app.store.update(id, "script", |project| {
        // Which media each range plays from.
        let by_path: HashMap<String, String> = project
            .media
            .iter()
            .map(|media| (media.path.clone(), media.id.clone()))
            .collect();
        if let Some(script) = project.script.as_mut() {
            for block in &mut script.blocks {
                // Scripts read before cue words existed get them from their notes.
                if let ScriptBlock::Footage {
                    notes,
                    words: words @ None,
                    ..
                } = block
                {
                    *words = cue_words(notes);
                }
                if let ScriptBlock::Footage {
                    file,
                    start,
                    end,
                    media,
                    media_start,
                    ..
                } = block
                {
                    let found = files.get(file).and_then(|cut| {
                        cut.iter().find(|excerpt| {
                            excerpt.from <= *start + 1e-6 && *end <= excerpt.to + 1e-6
                        })
                    });
                    if let Some(excerpt) = found {
                        if let Some(id) = by_path.get(&*excerpt.path.to_string_lossy()) {
                            *media = Some(id.clone());
                            *media_start = (excerpt.from > 0.0).then_some(excerpt.from);
                        }
                    }
                }
            }
        }
        Ok(())
    })?;

    app.scripts.set(app, id, |job| job.state = "transcribing");
    let transcripts = transcripts(app, &live.project).await;

    app.scripts.set(app, id, |job| job.state = "placing");
    app.store
        .update(id, "script", |project| {
            if let Some(script) = project.script.as_mut() {
                for block in &mut script.blocks {
                    if let ScriptBlock::Footage {
                        start,
                        end,
                        media,
                        media_start,
                        words: Some(cue),
                        cut,
                        ..
                    } = block
                    {
                        let Some(heard) = media.as_ref().and_then(|media| transcripts.get(media))
                        else {
                            continue;
                        };
                        let offset = media_start.unwrap_or(0.0);
                        let (cut_in, cut_out) = align(
                            &heard.words,
                            heard.peaks.as_deref(),
                            cue,
                            *start - offset,
                            *end - offset,
                        );
                        *cut = (cut_in.is_some() || cut_out.is_some()).then(|| {
                            [
                                cut_in.map_or(*start, |at| at + offset),
                                cut_out.map_or(*end, |at| at + offset),
                            ]
                        });
                    }
                }
            }
            if recut {
                clear_layout(project);
            }
            lay_out(project);
            Ok(())
        })
        .map(|_| ())
}

/// Re-finds every placed range's first and last words (after matching
/// improves or a transcript arrives) and moves its clip's in and out points
/// to them. Everything after a clip that changes length moves with it, so the
/// timeline stays butted; effects ending on its cut (a shake into a cut-in)
/// keep ending on it. Returns what changed.
pub async fn realign(app: &App, id: &str) -> Result<Vec<serde_json::Value>, String> {
    let live = app.store.get(id).ok_or("no such project")?;
    let transcripts = transcripts(app, &live.project).await;
    let (_, changed) = app.store.update(id, "agent", |project| {
        let fps = project.fps();
        let mut changed = Vec::new();
        let Some(mut blocks) = project.script.as_ref().map(|script| script.blocks.clone()) else {
            return Ok(changed);
        };
        for block in &mut blocks {
            let ScriptBlock::Footage {
                start,
                end,
                label,
                media: Some(media),
                media_start,
                words: Some(cue),
                cut,
                clip: Some(clip_id),
                ..
            } = block
            else {
                continue;
            };
            let Some(heard) = transcripts.get(media.as_str()) else {
                continue;
            };
            let offset = media_start.unwrap_or(0.0);
            let (cut_in, cut_out) = align(
                &heard.words,
                heard.peaks.as_deref(),
                cue,
                *start - offset,
                *end - offset,
            );
            let found = [
                cut_in.map_or(*start, |at| at + offset),
                cut_out.map_or(*end, |at| at + offset),
            ];
            *cut = (cut_in.is_some() || cut_out.is_some()).then_some(found);
            let Some(clip) = project.clip(clip_id).cloned() else {
                continue;
            };
            let ClipContent::Video {
                source_in, speed, ..
            } = clip.content
            else {
                continue;
            };
            // The clip plays seconds of the media, which begins `offset` into the file.
            let (new_in, new_out) = (found[0] - offset, found[1] - offset);
            let old_out = source_in + clip.duration as f64 / fps * speed;
            if (new_in - source_in).abs() < 0.5 / fps && (new_out - old_out).abs() < 0.5 / fps {
                continue;
            }
            let duration = (((new_out - new_in) / speed) * fps).round().max(1.0) as i64;
            let delta = duration - clip.duration;
            let old_end = clip.end();
            for other in &mut project.clips {
                let partner =
                    other.id == clip.id || (clip.link.is_some() && other.link == clip.link);
                if partner {
                    if let ClipContent::Video { source_in, .. }
                    | ClipContent::Audio { source_in, .. } = &mut other.content
                    {
                        *source_in = new_in;
                    }
                    other.duration = duration;
                } else if other.start >= old_end || other.marks_cut(old_end) {
                    other.start += delta;
                }
            }
            changed.push(json!({
                "range": label,
                "clip": clip.id,
                "seconds": [source_in, old_out],
                "now": [new_in, new_out],
                "frames_longer": delta,
                "first_word_found": cut_in.is_some(),
                "last_word_found": cut_out.is_some(),
            }));
        }
        if let Some(script) = project.script.as_mut() {
            script.blocks = blocks;
        }
        Ok(changed)
    })?;
    Ok(changed)
}

/// Transcribes each media the script plays (through Edit's relay) and waits
/// for the words. Media without sound, or whose transcription fails, are
/// left out: their ranges keep the times the Doc wrote.
/// What's said in a media file, and how loud it is moment to moment.
struct Heard {
    words: Vec<crate::transcribe::Word>,
    peaks: Option<Vec<u8>>,
}

async fn transcripts(app: &App, project: &Project) -> HashMap<String, Heard> {
    let used: HashSet<&str> = project
        .script
        .iter()
        .flat_map(|script| &script.blocks)
        .filter_map(|block| match block {
            ScriptBlock::Footage {
                media: Some(media),
                words: Some(_),
                ..
            } => Some(media.as_str()),
            _ => None,
        })
        .collect();
    let media: Vec<_> = project
        .media
        .iter()
        .filter(|media| used.contains(media.id.as_str()) && media.has_audio)
        .collect();
    for item in &media {
        app.media.transcribe(PathBuf::from(&item.path), true);
    }
    let mut out = HashMap::new();
    let started = Instant::now();
    for item in media {
        let path = PathBuf::from(&item.path);
        loop {
            let status = app.media.status(&path);
            match status.transcript {
                crate::media::Stage::Ready => {
                    let words = std::fs::read(app.media.paths(&path).transcript)
                        .ok()
                        .and_then(|bytes| {
                            serde_json::from_slice::<crate::transcribe::Transcript>(&bytes).ok()
                        })
                        .map(|transcript| transcript.words);
                    if let Some(words) = words {
                        let peaks = std::fs::read(app.media.paths(&path).peaks).ok();
                        out.insert(item.id.clone(), Heard { words, peaks });
                    }
                    break;
                }
                crate::media::Stage::Failed => break,
                _ if started.elapsed() > Duration::from_secs(30 * 60) => break,
                _ => tokio::time::sleep(Duration::from_secs(2)).await,
            }
        }
    }
    out
}

/// Takes the script's clips (and their linked partners) off the timeline so it can be laid out again.
fn clear_layout(project: &mut Project) {
    let Some(script) = project.script.as_mut() else {
        return;
    };
    let mut placed: HashSet<String> = HashSet::new();
    for block in &mut script.blocks {
        if let ScriptBlock::Narration { voiceover, .. } = block {
            if let Some(clip) = voiceover.take() {
                placed.insert(clip);
            }
        }
        let (ScriptBlock::Footage { clip, .. } | ScriptBlock::Narration { clip, .. }) = block;
        if let Some(clip) = clip.take() {
            placed.insert(clip);
        }
    }
    let links: HashSet<String> = project
        .clips
        .iter()
        .filter(|clip| placed.contains(&clip.id))
        .filter_map(|clip| clip.link.clone())
        .collect();
    project.clips.retain(|clip| {
        !placed.contains(&clip.id) && !clip.link.as_ref().is_some_and(|link| links.contains(link))
    });
}

/// The cut-in card's text: sized so long narration still fits on screen.
pub fn cut_in_style(width: u32, height: u32, text: &str) -> TextStyle {
    let k = height as f32 / 1080.0;
    let max_width = width as f32 * 0.62;
    let chars = text.chars().count().max(1) as f32;
    let fit = (0.75 * height as f32 * max_width / chars).sqrt();
    TextStyle {
        font: "Geist".into(),
        weight: 500,
        size: fit.clamp(22.0 * k, 46.0 * k).round(),
        color: Rgba::WHITE,
        tracking: 0.0,
        line_height: 1.4,
        glow: Glow {
            enabled: false,
            ..Glow::default()
        },
        max_width: Some(max_width.round()),
        background: None,
        shadow: None,
        label: None,
        leader: None,
        align: TextAlign::Center,
    }
}

const FILE_COLORS: [ClipColor; 6] = [
    ClipColor::Blue,
    ClipColor::Cyan,
    ClipColor::Green,
    ClipColor::Orange,
    ClipColor::Pink,
    ClipColor::Yellow,
];

/// Places every block not on the timeline yet, in script order, after what's there.
fn lay_out(project: &mut Project) {
    let Some(mut script) = project.script.take() else {
        return;
    };
    let tracks = |project: &Project, kind: TrackKind| {
        project
            .tracks
            .iter()
            .filter(|track| track.kind == kind)
            .map(|track| track.id.clone())
            .collect::<Vec<_>>()
    };
    while tracks(project, TrackKind::Video).len() < 2 {
        project.add_track(TrackKind::Video);
    }
    if tracks(project, TrackKind::Audio).is_empty() {
        project.add_track(TrackKind::Audio);
    }
    let video = tracks(project, TrackKind::Video);
    let audio = tracks(project, TrackKind::Audio);
    // Both made just above.
    let (Some(lower), Some(upper), Some(audio)) =
        (video.first(), video.get(1), audio.first().cloned())
    else {
        project.script = Some(script);
        return;
    };
    let fps = project.fps();
    let (width, height) = (project.settings.width, project.settings.height);
    let mut colors: HashMap<String, ClipColor> = HashMap::new();
    let mut cursor = project.duration();
    let mut cut_ins = 0;
    // Cut-ins (numbered from 1) whose voice-over is on the timeline: placed.
    let voiceovers: std::collections::HashSet<usize> = script
        .blocks
        .iter()
        .filter_map(|block| match block {
            ScriptBlock::Narration { voiceover, .. } => Some(voiceover),
            ScriptBlock::Footage { .. } => None,
        })
        .enumerate()
        .filter(|(_, voiceover)| {
            voiceover
                .as_deref()
                .is_some_and(|id| project.clip(id).is_some())
        })
        .map(|(index, _)| index + 1)
        .collect();
    for block in &mut script.blocks {
        match block {
            ScriptBlock::Footage {
                file,
                start,
                end,
                media,
                media_start,
                cut,
                clip,
                ..
            } => {
                // Placed once already: gone means removed on purpose (a cut-in card
                // replaced by B-roll), so it isn't put back. A re-cut clears these first.
                if clip.is_some() {
                    continue;
                }
                let offset = media_start.unwrap_or(0.0);
                // The transcript's cut when there is one, else the Doc's times.
                let [start, end] = cut.unwrap_or([*start, *end]);
                let Some(media) = media
                    .as_ref()
                    .and_then(|media| project.media(media))
                    .cloned()
                else {
                    continue;
                };
                let from = (start - offset).clamp(0.0, media.duration);
                let to = (end - offset).min(media.duration);
                if to <= from {
                    continue;
                }
                let next = colors.len();
                let color = *colors.entry(file.clone()).or_insert_with(|| {
                    FILE_COLORS
                        .iter()
                        .cycle()
                        .nth(next)
                        .copied()
                        .unwrap_or(ClipColor::Blue)
                });
                let duration = (((to - from) * fps).round() as i64).max(1);
                let link = media.has_audio.then(|| project.fresh_id("l"));
                let id = project.fresh_id("c");
                project.clips.push(Clip {
                    id: id.clone(),
                    track: lower.clone(),
                    start: cursor,
                    duration,
                    color,
                    name: None,
                    link: link.clone(),
                    fade_in: 0,
                    fade_out: 0,
                    keyframes: Default::default(),
                    content: ClipContent::Video {
                        media: media.id.clone(),
                        source_in: from,
                        speed: 1.0,
                        transform: Transform::default(),
                        opacity: 1.0,
                        crop: Default::default(),
                        frame: None,
                    },
                });
                if media.has_audio {
                    let audio_id = project.fresh_id("c");
                    project.clips.push(Clip {
                        id: audio_id,
                        track: audio.clone(),
                        start: cursor,
                        duration,
                        color,
                        name: None,
                        link,
                        fade_in: 0,
                        fade_out: 0,
                        keyframes: Default::default(),
                        content: ClipContent::Audio {
                            media: media.id.clone(),
                            source_in: from,
                            speed: 1.0,
                            volume_db: 0.0,
                            mutes: Vec::new(),
                        },
                    });
                }
                *clip = Some(id);
                cursor += duration;
            }
            ScriptBlock::Narration { text, clip, .. } => {
                cut_ins += 1;
                // Placed once already: gone means removed on purpose (a cut-in card
                // replaced by B-roll), so it isn't put back. A re-cut clears these first.
                if clip.is_some() || voiceovers.contains(&cut_ins) {
                    continue;
                }
                let duration = ((CUT_IN_SECONDS * fps).round() as i64).max(1);
                let link = Some(project.fresh_id("l"));
                let card = project.fresh_id("c");
                project.clips.push(Clip {
                    id: card.clone(),
                    track: lower.clone(),
                    start: cursor,
                    duration,
                    color: ClipColor::Purple,
                    name: Some(format!("Cut-in {cut_ins}")),
                    link: link.clone(),
                    fade_in: 0,
                    fade_out: 0,
                    keyframes: Default::default(),
                    content: ClipContent::Solid {
                        fill: Rgba::BLACK,
                        opacity: 1.0,
                        gradient: None,
                    },
                });
                let words = project.fresh_id("c");
                project.clips.push(Clip {
                    id: words,
                    track: upper.clone(),
                    start: cursor,
                    duration,
                    color: ClipColor::Purple,
                    name: None,
                    link,
                    fade_in: 0,
                    fade_out: 0,
                    keyframes: Default::default(),
                    content: ClipContent::Text {
                        text: text.clone(),
                        style: cut_in_style(width, height, text),
                        transform: Transform::default(),
                        animation: TextAnimation::default(),
                        opacity: 1.0,
                        word_times: Vec::new(),
                    },
                });
                *clip = Some(card);
                cursor += duration;
            }
        }
    }
    project.script = Some(script);
}

/// Reads a Doc and attaches its script to a project (replacing any before).
pub fn attach(project: &mut Project, source: &str, parsed: Parsed) {
    project.script = Some(Script {
        source: Some(source.to_owned()),
        blocks: parsed.blocks,
    });
}

/// How much a script holds, for the import dialog's preview.
pub fn summary(parsed: &Parsed) -> serde_json::Value {
    let mut files = Vec::new();
    let (mut footage, mut narration, mut seconds) = (0, 0, 0.0);
    for block in &parsed.blocks {
        match block {
            ScriptBlock::Footage {
                file, start, end, ..
            } => {
                footage += 1;
                seconds += end - start;
                if !files.contains(file) {
                    files.push(file.clone());
                }
            }
            ScriptBlock::Narration { .. } => {
                narration += 1;
                seconds += CUT_IN_SECONDS;
            }
        }
    }
    json!({ "title": parsed.title, "footage": footage, "narration": narration, "files": files.len(), "seconds": seconds })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = r##"<html><head><title>Kent crash</title><style>.c1{color:red}</style></head><body>
<p><span>Kent crash</span></p><p><span>Total Duration: 27m</span></p>
<p><span>FOIA Kent Police - Mother Finds Out Her Son Caused The Crash That Killed Her Neighbour Months Later</span></p>
<p><span>(</span><a href="https://www.google.com/url?q=https://drive.google.com/file/d/1H9hY3w4LjzWlSAqY8hfp3I5Ft5PP0X9Y/view?usp%3Dsharing%26t%3D91.506&amp;sa=D">01:31 - 01:</a><a href="https://www.google.com/url?q=https://drive.google.com/file/d/1H9hY3w4LjzWlSAqY8hfp3I5Ft5PP0X9Y/view?usp%3Dsharing%26t%3D91.506&amp;sa=D">37</a><sup><a href="#cmnt1" id="cmnt_ref1">[a]</a></sup><sup><a href="#cmnt2" id="cmnt_ref2">[b]</a></sup><sup><a href="#cmnt3" id="cmnt_ref3">[c]</a></sup><span>) (</span><a href="https://www.google.com/url?q=https://drive.google.com/file/d/1N4zyXbvBcdg9Y1ZzpeZ6-0e_TgB_rMC9/view?usp%3Dsharing%26t%3D68.674&amp;sa=D">01:08 - 01:10</a><span>)</span></p>
<p><span>This mother had absolutely no idea that her son&rsquo;s role&hellip;</span></p>
<p><span>A second paragraph of the same cut-in.</span><sup><a href="#cmnt4" id="cmnt_ref4">[d]</a></sup></p>
<p><span>(1:02:03 &ndash; 1:02:09)</span></p>
<div><p><a href="#cmnt_ref1" id="cmnt1">[a]</a><span>Extend to 1:37</span></p></div>
<div><p><a href="#cmnt_ref2" id="cmnt2">[b]</a><span>fixed</span></p></div>
<div><p><a href="#cmnt_ref3" id="cmnt3">[c]</a><span>A little accident....car crash</span></p></div>
<div><p><a href="#cmnt_ref4" id="cmnt4">[d]</a><span>To Editor: blur the victim</span></p></div>
</body></html>"##;

    #[test]
    fn reads_ranges_links_narration_and_notes() {
        let parsed = parse(DOC);
        assert_eq!(parsed.title, "Kent crash");
        assert_eq!(parsed.blocks.len(), 4, "{:#?}", parsed.blocks);
        let ScriptBlock::Footage {
            file,
            start,
            end,
            label,
            notes,
            ..
        } = &parsed.blocks[0]
        else {
            panic!()
        };
        assert_eq!(file, "1H9hY3w4LjzWlSAqY8hfp3I5Ft5PP0X9Y");
        assert!(
            (start - 91.506).abs() < 1e-9,
            "the link's t= is the exact start"
        );
        assert_eq!(*end, 97.0);
        assert_eq!(label, "01:31 - 01:37");
        assert_eq!(
            notes,
            &vec!["A little accident....car crash".to_owned()],
            "a 'fixed' reply resolves the note before it"
        );
        let ScriptBlock::Footage { file, start, .. } = &parsed.blocks[1] else {
            panic!()
        };
        assert_eq!(file, "1N4zyXbvBcdg9Y1ZzpeZ6-0e_TgB_rMC9");
        assert!((start - 68.674).abs() < 1e-9);
        let ScriptBlock::Narration { text, notes, .. } = &parsed.blocks[2] else {
            panic!()
        };
        assert_eq!(text, "This mother had absolutely no idea that her son's role…\n\nA second paragraph of the same cut-in.");
        assert_eq!(notes, &vec!["To Editor: blur the victim".to_owned()]);
        // An unlinked range belongs to the file before it; hours parse.
        let ScriptBlock::Footage {
            file, start, end, ..
        } = &parsed.blocks[3]
        else {
            panic!()
        };
        assert_eq!(file, "1N4zyXbvBcdg9Y1ZzpeZ6-0e_TgB_rMC9");
        assert_eq!((*start, *end), (3723.0, 3729.0));
    }

    #[test]
    fn finds_drive_ids_and_ranges() {
        assert_eq!(
            drive_file_id("https://drive.google.com/open?id=1abcdefghijkl").as_deref(),
            Some("1abcdefghijkl")
        );
        assert_eq!(
            drive_file_id("https://drive.google.com/file/d/1abcdefghijkl/view?usp=sharing")
                .as_deref(),
            Some("1abcdefghijkl")
        );
        assert_eq!(
            drive_file_id("https://youtube.com/watch?v=1abcdefghijkl"),
            None
        );
        assert_eq!(doc_id("https://docs.google.com/document/d/1hB2Prvupx1Yhz2y9MZNqQ1rl9y88uarGNe4CmGbiLaE/edit?tab=t.0").as_deref(), Some("1hB2Prvupx1Yhz2y9MZNqQ1rl9y88uarGNe4CmGbiLaE"));
        let ranges = find_ranges("( ) (00:54 - 01:57) 12:30 and (4:12–5:24) 2024");
        assert_eq!(
            ranges
                .iter()
                .map(|range| (range.from, range.to))
                .collect::<Vec<_>>(),
            vec![(54.0, 117.0), (252.0, 324.0)]
        );
        assert_eq!(
            disposition_name("attachment; filename=\"Bodycam 1.mp4\"").as_deref(),
            Some("Bodycam 1.mp4")
        );
        assert_eq!(
            disposition_name("attachment; filename*=UTF-8''Body%20cam.mov").as_deref(),
            Some("Body cam.mov")
        );
        let page = r#"<form id="download-form" action="https://drive.usercontent.google.com/download" method="get"><input type="hidden" name="id" value="X1"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-1"></form>"#;
        assert_eq!(
            confirm_link(page).as_deref(),
            Some("https://drive.usercontent.google.com/download?id=X1&confirm=t&uuid=u-1")
        );
        for action in [
            "file:///etc/passwd",
            "http://127.0.0.1:7700/api/projects",
            "https://evil.example/download",
            "https://drive.usercontent.google.com.evil.example/download",
        ] {
            assert!(confirm_link(
                &page.replace("https://drive.usercontent.google.com/download", action)
            )
            .is_none());
        }
    }

    #[test]
    fn concurrent_local_excerpts_keep_exact_ranges_and_separate_temporary_files() {
        if Command::new(crate::tools::ffmpeg())
            .arg("-version")
            .output()
            .is_err()
        {
            return;
        }
        let dir = std::env::temp_dir().join(format!(
            "edit-excerpt-test-{}-{}",
            std::process::id(),
            crate::store::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.mp4");
        assert!(Command::new(crate::tools::ffmpeg())
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=red:s=32x32:r=30:d=60",
                "-c:v",
                "libx264",
                "-g",
                "1",
                "-pix_fmt",
                "yuv420p"
            ])
            .arg(&source)
            .status()
            .unwrap()
            .success());
        let (a, b) = std::thread::scope(|scope| {
            let a = scope.spawn(|| excerpts(&source, &[(20.1, 20.61)]).unwrap());
            let b = scope.spawn(|| excerpts(&source, &[(20.2, 20.7)]).unwrap());
            (a.join().unwrap(), b.join().unwrap())
        });
        assert_ne!(a[0].path, b[0].path);
        for excerpt in [&a[0], &b[0]] {
            let duration = duration_of(&excerpt.path).unwrap();
            assert!((20.4..20.7).contains(&duration), "{duration}");
        }
        assert!(std::fs::read_dir(dir.join("excerpts"))
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".cutting")));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lays_out_footage_and_cut_ins_in_order() {
        use edit_core::{Media, MediaKind, Settings};
        let mut project = Project::new("p1".into(), "Test".into(), Settings::default());
        project.media.push(Media {
            id: "m1".into(),
            name: "a.mp4".into(),
            path: "/tmp/a.mp4".into(),
            kind: MediaKind::Video,
            duration: 120.0,
            width: 1920,
            height: 1080,
            fps: 30.0,
            has_audio: true,
            markers: Vec::new(),
        });
        let footage = |start: f64, end: f64| ScriptBlock::Footage {
            url: String::new(),
            file: "f1".into(),
            start,
            end,
            label: String::new(),
            notes: Vec::new(),
            media: Some("m1".into()),
            media_start: None,
            words: None,
            cut: None,
            clip: None,
        };
        project.script = Some(Script {
            source: None,
            blocks: vec![
                footage(91.506, 97.0),
                ScriptBlock::Narration {
                    text: "Words between.".into(),
                    notes: Vec::new(),
                    clip: None,
                    voiceover: None,
                },
                footage(10.0, 12.0),
                // Past the end of the file: skipped, not stretched.
                footage(150.0, 160.0),
            ],
        });
        lay_out(&mut project);
        project.validate().unwrap();
        let fps = project.fps();
        let video: Vec<_> = project
            .clips
            .iter()
            .filter(|clip| {
                matches!(
                    clip.content,
                    ClipContent::Video { .. } | ClipContent::Solid { .. }
                )
            })
            .collect();
        assert_eq!(video.len(), 3);
        assert_eq!(
            (video[0].start, video[0].duration),
            (0, ((97.0 - 91.506) * fps).round() as i64)
        );
        assert!(
            matches!(video[0].content, ClipContent::Video { source_in, .. } if (source_in - 91.506).abs() < 1e-9)
        );
        assert_eq!(video[1].start, video[0].end());
        assert_eq!(video[1].duration, (CUT_IN_SECONDS * fps) as i64);
        assert_eq!(video[2].start, video[1].end());
        // Picture and sound are linked; the cut-in's words sit above its card.
        assert_eq!(
            project
                .clips
                .iter()
                .filter(|clip| matches!(clip.content, ClipContent::Audio { .. }))
                .count(),
            2
        );
        assert!(project.clips.iter().any(|clip| matches!(&clip.content, ClipContent::Text { text, .. } if text == "Words between.")));
        // Placed blocks remember their clips, so a second pass adds nothing.
        let count = project.clips.len();
        lay_out(&mut project);
        assert_eq!(project.clips.len(), count);
        // A covered cut-in whose card id was cleared (as cover_cut_in once
        // did) but whose voice-over is on the timeline isn't laid out again.
        let sound = project
            .clips
            .iter()
            .find(|clip| matches!(clip.content, ClipContent::Audio { .. }))
            .map(|clip| clip.id.clone());
        if let Some(script) = &mut project.script {
            for block in &mut script.blocks {
                if let ScriptBlock::Narration {
                    clip, voiceover, ..
                } = block
                {
                    *clip = None;
                    voiceover.clone_from(&sound);
                }
            }
        }
        lay_out(&mut project);
        assert_eq!(project.clips.len(), count);
        assert!(project.script.as_ref().is_some_and(|script| script
            .blocks
            .iter()
            .filter(|block| matches!(block, ScriptBlock::Narration { .. }))
            .all(|block| placed(&project, block))));
    }

    /// Downloads a real (715 MB) Drive file: `cargo test -p edit drive_download -- --ignored`.
    #[test]
    #[ignore]
    fn drive_download() {
        let dir = std::env::temp_dir().join("edit-drive-test");
        let path = download(
            &dir,
            "17v9r7-0q_qldU39KXXat1iPkFVlSQINA",
            &|bytes, total, name| {
                eprintln!("{name}: {bytes}/{total:?}");
            },
        )
        .unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 715_467_099);
        // Finished files are reused, not fetched again.
        assert_eq!(
            download(
                &dir,
                "17v9r7-0q_qldU39KXXat1iPkFVlSQINA",
                &|_, _, _| panic!("downloaded twice")
            )
            .unwrap(),
            path
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn excerpt_spans_pad_and_merge() {
        // Close ranges share a span; far ones get their own; padding stays inside the file.
        let ranges = [
            (54.0, 117.0),
            (120.0, 141.0),
            (5.0, 8.0),
            (3600.0, 3610.0),
            (19_710.0, 19_714.0),
        ];
        assert_eq!(
            spans(&ranges, 19_714.35),
            vec![(0.0, 151.0), (3590.0, 3620.0), (19_700.0, 19_714.35)]
        );
    }

    #[test]
    fn reads_cue_words() {
        let notes = |text: &str| vec!["Extend to 1:37".to_owned(), text.to_owned()];
        assert_eq!(
            cue_words(&notes("A little accident....car crash, perhaps?")),
            Some(["A".into(), "perhaps?".into()])
        );
        assert_eq!(
            cue_words(&notes("Do you.....arm injured?")),
            Some(["Do".into(), "injured?".into()])
        );
        assert_eq!(
            cue_words(&notes("*Victim groans*....hey man")),
            Some(["*Victim".into(), "man".into()])
        );
        assert_eq!(cue_words(&["To Editor: Blur the victim".to_owned()]), None);
    }

    #[test]
    fn matches_cue_words_spelt_a_little_differently() {
        use crate::transcribe::Word;
        let word = |text: &str, start: f64, end: f64| Word {
            text: text.into(),
            start,
            end,
            speaker: None,
        };
        // The Doc's range "i....priuses" over a transcript that heard "Prius".
        let words = [
            word("I", 77.1, 77.2),
            word("saw", 77.25, 77.5),
            word("hit", 81.4, 81.55),
            word("that", 81.56, 81.8),
            word("Prius", 81.82, 82.12),
            word("that's,", 82.14, 82.4),
            word("whatever,", 82.5, 83.0),
            word("behind", 83.6, 83.9),
            word("the", 83.92, 84.0),
            word("Prius", 84.14, 84.36),
            word("car.", 84.4, 84.7),
        ];
        let (_, cut_out) = align(&words, None, &["i".into(), "priuses".into()], 77.0, 82.0);
        // Right after the "Prius" nearest the written end, not short of it.
        let cut_out = cut_out.expect("found the last word");
        assert!((82.12..=82.14).contains(&cut_out), "{cut_out}");
        assert_eq!(likeness("Prius", "priuses"), Some(1));
        assert_eq!(likeness("Prious", "prius"), Some(1));
        assert_eq!(likeness("Prius", "prius"), Some(0));
        // Short words and different words don't pass.
        assert_eq!(likeness("a", "i"), None);
        assert_eq!(likeness("Pickup", "priuses"), None);
    }

    #[test]
    fn cuts_at_the_first_and_last_words() {
        use crate::transcribe::Word;
        let word = |text: &str, start: f64, end: f64| Word {
            text: text.into(),
            start,
            end,
            speaker: None,
        };
        let words = [
            word("Okay.", 90.2, 90.6),
            word("A", 91.70, 91.78),
            word("little", 91.80, 92.10),
            word("accident,", 92.12, 92.70),
            word("a", 93.0, 93.05),
            word("car", 95.0, 95.3),
            word("crash,", 95.3, 95.8),
            word("perhaps?", 95.9, 96.62),
            word("Yes.", 96.66, 97.1),
        ];
        let (cut_in, cut_out) = align(&words, None, &["A".into(), "perhaps?".into()], 91.506, 97.0);
        // The nearest "A" to 91.5 (not the later "a"), a little room before it, never into "Okay.".
        assert!((cut_in.unwrap() - (91.70 - WORD_PAD)).abs() < 1e-9);
        // "Yes." follows 40 ms after "perhaps?": no room, right at its end.
        assert!((cut_out.unwrap() - 96.62).abs() < 1e-9);
        // With the sound to go by, in the quietest instant near that end
        // (transcript times are loose): the dip at 96.60, not the quieter one
        // inside "Yes.".
        let mut peaks = vec![200_u8; 9800];
        peaks[9660] = 40;
        peaks[9670] = 10;
        let (_, cut_out) = align(
            &words,
            Some(&peaks),
            &["A".into(), "perhaps?".into()],
            91.506,
            97.0,
        );
        assert!((cut_out.unwrap() - 96.60).abs() < 1e-9, "{cut_out:?}");
        // A described sound can't be found in speech: that side keeps the Doc's time.
        assert_eq!(
            align(
                &words,
                None,
                &["*Victim".into(), "perhaps?".into()],
                91.5,
                97.0
            )
            .0,
            None
        );
        // Words far from where the range is written don't count.
        assert_eq!(
            align(&words, None, &["Okay.".into(), "Yes.".into()], 40.0, 50.0),
            (None, None)
        );
    }
}
