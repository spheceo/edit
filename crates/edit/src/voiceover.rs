//! Voice-overs for the script's cut-ins. The recordings read the cut-ins'
//! text, so each cut-in's words are found in their transcripts and that
//! stretch of audio is laid where the cut-in is. The cut-in is lengthened to
//! it and everything after moves with it, so the timeline stays butted.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use edit_core::{Clip, ClipColor, ClipContent, Project, ScriptBlock, TrackKind};
use serde_json::{json, Value};

use crate::server::App;
use crate::transcribe::Word;

/// Lead-in kept before the first word and tail after the last (seconds).
const LEAD: f64 = 0.12;
const TAIL: f64 = 0.3;
/// Share of a cut-in's words that must be heard for a stretch to count as reading it.
const LEAST_MATCH: f64 = 0.5;

/// Places voice-overs on the cut-ins: `media` (default: audio that isn't on
/// the timeline and isn't a sound effect). Placing again replaces what it placed.
pub async fn place(app: &App, id: &str, media: Option<Vec<String>>) -> Result<Value, String> {
    let live = app.store.get(id).ok_or("no such project")?;
    let project = &live.project;
    let recordings: Vec<_> = match media {
        Some(ids) => ids
            .iter()
            .map(|id| project.media(id).ok_or_else(|| format!("no media {id}")))
            .collect::<Result<_, _>>()?,
        None => {
            // Recordings not on the timeline yet, and the ones already placed (to place again).
            let placed = placed_voiceovers(project);
            project
                .media
                .iter()
                .filter(|media| {
                    media.kind == edit_core::MediaKind::Audio && !media.is_sound_effect()
                })
                .filter(|media| {
                    placed.contains(&media.id)
                        || !project
                            .clips
                            .iter()
                            .any(|clip| clip.media_id() == Some(media.id.as_str()))
                })
                .collect()
        }
    };
    if recordings.is_empty() {
        return Err("no voice-over recordings: import the audio first".to_owned());
    }
    let mut heard: Vec<(String, Vec<Word>)> = Vec::new();
    for media in &recordings {
        heard.push((media.id.clone(), transcript(app, media).await?));
    }

    let (_, report) = app.store.update(id, "agent", |project| {
        let fps = project.fps();
        let blocks = project.script.as_ref().map(|script| script.blocks.clone()).unwrap_or_default();
        // What it placed before goes; the cut-ins keep the length they were given.
        let previous: Vec<String> = blocks
            .iter()
            .filter_map(|block| match block {
                ScriptBlock::Narration { voiceover, .. } => voiceover.clone(),
                ScriptBlock::Footage { .. } => None,
            })
            .collect();
        let track = project
            .clips
            .iter()
            .find(|clip| previous.contains(&clip.id))
            .map(|clip| clip.track.clone());
        project.clips.retain(|clip| !previous.contains(&clip.id));
        let track = track
            .filter(|track| project.track(track).is_some())
            .unwrap_or_else(|| project.add_track(TrackKind::Audio));

        let mut report = Vec::new();
        let mut voiceovers: HashMap<usize, String> = HashMap::new();
        for (index, block) in blocks.iter().enumerate() {
            let ScriptBlock::Narration { text, clip: Some(card), .. } = block else {
                continue;
            };
            let Some(card) = project.clip(card).cloned() else {
                continue;
            };
            let wanted = words_of(text);
            let best = heard
                .iter()
                .filter_map(|(media, words)| {
                    let spoken: Vec<String> = words.iter().map(|word| normalize(&word.text)).collect();
                    find(&wanted, &spoken).map(|found| (media, words, found))
                })
                .max_by_key(|(_, _, found)| found.matched);
            let preview: String = text.split_whitespace().take(8).collect::<Vec<_>>().join(" ");
            let Some((media, words, found)) =
                best.filter(|(_, _, found)| found.matched as f64 >= wanted.len() as f64 * LEAST_MATCH)
            else {
                report.push(json!({ "cut_in": preview, "placed": false, "why": "its words weren't found in the recordings" }));
                continue;
            };
            // Breathing room, without reaching into the words around it.
            let first = &words[found.first];
            let last = &words[found.last];
            let before = found.first.checked_sub(1).map(|at| words[at].end);
            let after = words.get(found.last + 1).map(|word| word.start);
            let from = (first.start - LEAD).max(before.map_or(0.0, |end| (end + first.start) / 2.0)).max(0.0);
            let to = (last.end + TAIL).min(after.map_or(f64::MAX, |start| (last.end + start) / 2.0));
            let duration = ((to - from) * fps).round().max(1.0) as i64;

            // The cut-in (and its words) takes the voice-over's length; what follows moves.
            let delta = duration - card.duration;
            let old_end = card.end();
            for other in &mut project.clips {
                let partner = other.id == card.id || (card.link.is_some() && other.link == card.link);
                if partner {
                    other.duration = duration;
                } else if other.start >= old_end || (other.start > card.start && other.marks_cut(old_end)) {
                    other.start += delta;
                }
            }
            let clip_id = project.fresh_id("c");
            project.clips.push(Clip {
                id: clip_id.clone(),
                track: track.clone(),
                start: card.start,
                duration,
                color: ClipColor::Green,
                name: Some("Voice-over".to_owned()),
                link: None,
                fade_in: 0,
                fade_out: 0,
                keyframes: Default::default(),
                content: ClipContent::Audio {
                    media: (*media).clone(),
                    source_in: from,
                    speed: 1.0,
                    volume_db: 0.0,
                },
            });
            voiceovers.insert(index, clip_id.clone());
            report.push(json!({
                "cut_in": preview,
                "placed": true,
                "clip": clip_id,
                "media": media,
                "heard": format!("{} … {}", first.text, last.text),
                "words_matched": format!("{}/{}", found.matched, wanted.len()),
                "at_seconds": card.start as f64 / fps,
                "seconds": (duration as f64 / fps * 100.0).round() / 100.0,
                "cut_in_frames_longer": delta,
            }));
        }
        if let Some(script) = project.script.as_mut() {
            for (index, block) in script.blocks.iter_mut().enumerate() {
                if let ScriptBlock::Narration { voiceover, .. } = block {
                    *voiceover = voiceovers.get(&index).cloned();
                }
            }
        }
        Ok(report)
    })?;
    // Voice-overs sit at the footage's loudness, so the narration is as loud as what's said on screen.
    let placed: Vec<String> = report
        .iter()
        .filter_map(|entry| entry["clip"].as_str().map(str::to_owned))
        .collect();
    let project = app.store.get(id).ok_or("project vanished")?.project;
    let gains = tokio::task::spawn_blocking(move || {
        let target = crate::library::footage_loudness(&project)?;
        Ok::<_, String>(
            placed
                .iter()
                .filter_map(|clip_id| {
                    let clip = project.clip(clip_id)?;
                    Some((
                        clip_id.clone(),
                        crate::library::gain_to(&project, clip, target).ok()?,
                    ))
                })
                .collect::<Vec<_>>(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .unwrap_or_default();
    app.store.update(id, "agent", |project| {
        for (clip_id, gain) in &gains {
            if let Some(ClipContent::Audio { volume_db, .. }) = project
                .clips
                .iter_mut()
                .find(|clip| &clip.id == clip_id)
                .map(|clip| &mut clip.content)
            {
                *volume_db = *gain as f32;
            }
        }
        Ok(())
    })?;
    Ok(json!(report))
}

/// Media the script's narration already plays as voice-overs.
fn placed_voiceovers(project: &Project) -> Vec<String> {
    project
        .script
        .iter()
        .flat_map(|script| &script.blocks)
        .filter_map(|block| match block {
            ScriptBlock::Narration {
                voiceover: Some(clip),
                ..
            } => project.clip(clip)?.media_id().map(str::to_owned),
            _ => None,
        })
        .collect()
}

/// A recording's words, transcribing it first if needed.
async fn transcript(app: &App, media: &edit_core::Media) -> Result<Vec<Word>, String> {
    let path = PathBuf::from(&media.path);
    app.media.transcribe(path.clone(), media.has_audio);
    let started = Instant::now();
    loop {
        let status = app.media.status(&path);
        match status.transcript {
            crate::media::Stage::Ready => {
                let bytes = std::fs::read(app.media.paths(&path).transcript)
                    .map_err(|error| error.to_string())?;
                let transcript: crate::transcribe::Transcript =
                    serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
                return Ok(transcript.words);
            }
            crate::media::Stage::Failed => {
                return Err(format!(
                    "couldn't transcribe {}: {}",
                    media.name,
                    status.transcript_error.unwrap_or_default()
                ))
            }
            _ if started.elapsed() > Duration::from_secs(15 * 60) => {
                return Err(format!("transcribing {} is taking too long", media.name))
            }
            _ => tokio::time::sleep(Duration::from_secs(2)).await,
        }
    }
}

/// A word as compared: lower case, letters and digits only.
fn normalize(word: &str) -> String {
    word.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn words_of(text: &str) -> Vec<String> {
    text.split(|c: char| c.is_whitespace() || c == '-' || c == '—' || c == '–')
        .map(normalize)
        .filter(|word| !word.is_empty())
        .collect()
}

/// Whether a written and a heard word are the same, allowing a slip of one letter in longer words.
fn same(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a.len().min(b.len()) < 4 || a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    // Edit distance of at most one.
    let (mut i, mut j, mut edits) = (0, 0, 0);
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            i += 1;
            j += 1;
            continue;
        }
        edits += 1;
        if edits > 1 {
            return false;
        }
        match a.len().cmp(&b.len()) {
            std::cmp::Ordering::Greater => i += 1,
            std::cmp::Ordering::Less => j += 1,
            std::cmp::Ordering::Equal => {
                i += 1;
                j += 1;
            }
        }
    }
    edits + (a.len() - i) + (b.len() - j) <= 1
}

/// Where in `heard` the written words are read: the best local alignment
/// (Smith–Waterman: a word in common scores, a word missed or added costs).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Found {
    pub first: usize,
    pub last: usize,
    pub matched: usize,
}

pub fn find(written: &[String], heard: &[String]) -> Option<Found> {
    let (rows, cols) = (written.len(), heard.len());
    if rows == 0 || cols == 0 {
        return None;
    }
    let width = cols + 1;
    let mut score = vec![0_i32; (rows + 1) * width];
    let mut best = (0, 0, 0);
    for i in 1..=rows {
        for j in 1..=cols {
            let diagonal = score[(i - 1) * width + j - 1]
                + if same(&written[i - 1], &heard[j - 1]) {
                    2
                } else {
                    -1
                };
            let up = score[(i - 1) * width + j] - 1;
            let left = score[i * width + j - 1] - 1;
            let value = diagonal.max(up).max(left).max(0);
            score[i * width + j] = value;
            if value > best.0 {
                best = (value, i, j);
            }
        }
    }
    if best.0 == 0 {
        return None;
    }
    // Walk back to where the alignment starts, counting the words in common.
    let (_, mut i, mut j) = best;
    let last = j - 1;
    let mut first = last;
    let mut matched = 0;
    while i > 0 && j > 0 && score[i * width + j] > 0 {
        let here = score[i * width + j];
        let hit = same(&written[i - 1], &heard[j - 1]);
        if here == score[(i - 1) * width + j - 1] + if hit { 2 } else { -1 } {
            if hit {
                matched += 1;
                first = j - 1;
            }
            i -= 1;
            j -= 1;
        } else if here == score[(i - 1) * width + j] - 1 {
            i -= 1;
        } else {
            j -= 1;
        }
    }
    Some(Found {
        first,
        last,
        matched,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heard(text: &str) -> Vec<String> {
        words_of(text)
    }

    #[test]
    fn finds_the_stretch_that_reads_a_cut_in() {
        let recording = heard(
            "This mother had absolutely no idea that her son had played a central role. \
             On July 13, 2024, Kent police officers were dispatched to a chilling report of a devastating crash.",
        );
        let cut_in =
            words_of("On July 13, 2024, Kent police officers were dispatched to a chilling report");
        let found = find(&cut_in, &recording).unwrap();
        assert_eq!(recording[found.first], "on");
        assert_eq!(recording[found.last], "report");
        assert_eq!(found.matched, cut_in.len());
    }

    #[test]
    fn tolerates_a_slip_and_a_skipped_word() {
        let recording =
            heard("the officers managed to pull alizar from the wreckage but while the rescue");
        // Written "Alizar" heard "alizar"; "were" said but not written; "wreckage" heard as "wreckege".
        let cut_in = words_of(
            "Fortunately, the officers managed to pull Alizar from the wreckege. But while rescue",
        );
        let found = find(&cut_in, &recording).unwrap();
        assert_eq!(recording[found.first], "the");
        assert_eq!(recording[found.last], "rescue");
        assert!(found.matched >= cut_in.len() - 2, "{found:?}");
    }

    #[test]
    fn words_compare_loosely_only_when_long() {
        assert!(same("wreckage", "wreckege"));
        assert!(same("officer", "officers"));
        assert!(!same("on", "in"));
        assert!(!same("crash", "cash1x"));
    }
}
