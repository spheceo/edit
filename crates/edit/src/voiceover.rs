//! Voice-overs for the script's cut-ins. The recordings read the cut-ins'
//! text, so each cut-in's words are found in their transcripts and that
//! stretch of audio is laid where the cut-in is. The cut-in is lengthened to
//! it and everything after moves with it, so the timeline stays butted.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use edit_core::{Clip, ClipColor, ClipContent, MediaKind, Project, ScriptBlock, TrackKind};
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
            let (Some(first), Some(last)) = (words.get(found.first), words.get(found.last)) else {
                report.push(json!({ "cut_in": preview, "placed": false, "why": "its words weren't found in the recordings" }));
                continue;
            };
            let before = found
                .first
                .checked_sub(1)
                .and_then(|at| words.get(at))
                .map(|word| word.end);
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
                person: None,
                content: ClipContent::Audio {
                    media: (*media).clone(),
                    source_in: from,
                    speed: 1.0,
                    volume_db: 0.0,
                    mutes: Vec::new(),
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

/// Speaks the script's cut-ins with the house voice (ElevenLabs) and lays the
/// takes on them: the last step of a script import. A voice-over an earlier
/// run left half spoken carries on instead of starting again.
pub async fn generate(app: &App, id: &str) -> Result<Value, String> {
    let live = app.store.get(id).ok_or("no such project")?;
    let lines = crate::voice::narration_lines(&live.project);
    if lines.is_empty() {
        return Ok(json!({ "media": [] }));
    }
    let name = format!("{} (voice-over)", live.project.name);
    let voices = std::sync::Arc::clone(&app.voices);
    let source = id.to_owned();
    let voice = tokio::task::spawn_blocking(move || {
        let project = voices.for_project(&name, &source, lines)?;
        // One at a time, in order: each line carries on from the one before.
        for line in &project.lines {
            if line.chosen.is_none() {
                voices.generate(&project.id, &line.id)?;
            }
        }
        Ok::<_, String>(project.id)
    })
    .await
    .map_err(|error| error.to_string())??;
    send(app, &voice, id).await
}

/// Puts a voice-over's chosen takes into video project `id` and lays them on
/// its cut-ins (matched by their words, as with any recorded voice-over).
pub async fn send(app: &App, voice_id: &str, id: &str) -> Result<Value, String> {
    let voice = app.voices.get(voice_id)?;
    let takes = app.voices.chosen_takes(voice_id)?;
    if takes.is_empty() {
        return Err("No lines have a chosen take yet.".to_owned());
    }
    app.store.get(id).ok_or("no such project")?;
    let dir = app.store.uploads_dir(id)?.join("voice-over");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let mut paths = Vec::new();
    for (number, label, take) in takes {
        let name = label.unwrap_or_else(|| format!("Line {number}"));
        let file = dir.join(format!("{} - {name}.mp3", voice.name.replace('/', "-")));
        std::fs::copy(&take, &file).map_err(|error| error.to_string())?;
        paths.push(file.to_string_lossy().into_owned());
    }
    let (_, added, errors) = crate::server::import_paths(app, id, paths, false, "voice").await?;
    if added.is_empty() {
        return Err(format!("Couldn't import the takes: {errors:?}"));
    }
    let report = crate::diag::time_async(
        "voice",
        "voice: place in a project",
        place(app, id, Some(added.clone())),
    )
    .await?;
    Ok(json!({ "media": added, "report": report }))
}

/// Whether any cut-in already plays a voice-over.
pub fn any_placed(project: &Project) -> bool {
    !placed_voiceovers(project).is_empty()
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
    while let (Some(x), Some(y)) = (a.get(i), b.get(j)) {
        if x == y {
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
    // A cell outside the table is no alignment.
    let cell = |score: &[i32], i: usize, j: usize| score.get(i * width + j).copied().unwrap_or(0);
    let mut best = (0, 0, 0);
    for (i, said) in (1..).zip(written) {
        for (j, read) in (1..).zip(heard) {
            let diagonal = cell(&score, i - 1, j - 1) + if same(said, read) { 2 } else { -1 };
            let up = cell(&score, i - 1, j) - 1;
            let left = cell(&score, i, j - 1) - 1;
            let value = diagonal.max(up).max(left).max(0);
            if let Some(slot) = score.get_mut(i * width + j) {
                *slot = value;
            }
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
    while i > 0 && j > 0 && cell(&score, i, j) > 0 {
        let (Some(said), Some(read)) = (written.get(i - 1), heard.get(j - 1)) else {
            break;
        };
        let here = cell(&score, i, j);
        let hit = same(said, read);
        if here == cell(&score, i - 1, j - 1) + if hit { 2 } else { -1 } {
            if hit {
                matched += 1;
                first = j - 1;
            }
            i -= 1;
            j -= 1;
        } else if here == cell(&score, i - 1, j) - 1 {
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

/// Whether `clip` is a voice-over: one the script's narration plays, one
/// place_voiceovers laid ("Voice-over"), or a voice-over project's take
/// ("<voice-over> - Cut-in N").
pub fn is_voiceover(project: &Project, clip: &Clip) -> bool {
    let ClipContent::Audio { media, .. } = &clip.content else {
        return false;
    };
    let narrated = project.script.iter().flat_map(|script| &script.blocks).any(|block| {
        matches!(block, ScriptBlock::Narration { voiceover: Some(id), .. } if *id == clip.id)
    });
    narrated
        || clip
            .name
            .as_deref()
            .is_some_and(|name| name.starts_with("Voice-over"))
        || project
            .media(media)
            .is_some_and(|media| media.name.contains(" - Cut-in "))
}

/// The voice-over clips playing in frames `[from, to)`, in order.
fn voiceovers_in(project: &Project, from: i64, to: i64) -> Vec<&Clip> {
    let mut clips: Vec<&Clip> = project
        .clips
        .iter()
        .filter(|clip| clip.start < to && clip.end() > from && is_voiceover(project, clip))
        .collect();
    clips.sort_by_key(|clip| clip.start);
    clips
}

/// The voice-overs heard in frames `[from, to)`: voice-over clips of sound
/// files on audio tracks that aren't muted (a video file's own sound is
/// `subtitles::footage_sound`). Their house words are muted like the footage's.
pub(crate) fn voiceover_sound(project: &Project, from: i64, to: i64) -> Vec<&Clip> {
    voiceovers_in(project, from, to)
        .into_iter()
        .filter(|clip| {
            project
                .track(&clip.track)
                .is_some_and(|track| track.kind == TrackKind::Audio && !track.muted)
                && matches!(&clip.content, ClipContent::Audio { media, .. }
                    if project.media(media).is_some_and(|media| media.kind != MediaKind::Video))
        })
        .collect()
}

/// A silence between two words of a voice-over, and the frames of the
/// timeline that shortening it takes out (`[from, to)`).
#[derive(Clone, Debug, PartialEq)]
pub struct Pause {
    pub clip: String,
    /// The word before it and the one after.
    pub between: (String, String),
    /// How long it is on the timeline (seconds).
    pub seconds: f64,
    pub from: i64,
    pub to: i64,
}

/// The pauses in voice-over `clip` longer than `max_pause` seconds (on the
/// timeline) between two of its words, each shortened to about `keep`: what
/// stays is split evenly after the word before and before the word after,
/// so no word is touched, and the silence before its first word and after its
/// last are left alone.
pub fn pauses(
    project: &Project,
    clip: &Clip,
    words: &[Word],
    max_pause: f64,
    keep: f64,
) -> Vec<Pause> {
    let ClipContent::Audio {
        source_in, speed, ..
    } = &clip.content
    else {
        return Vec::new();
    };
    let fps = project.fps();
    let source_out = source_in + clip.duration as f64 / fps * speed;
    let mut heard: Vec<&Word> = words
        .iter()
        .filter(|word| !word.text.trim().is_empty())
        .filter(|word| word.start >= source_in - 1e-6 && word.end <= source_out + 1e-6)
        .collect();
    heard.sort_by(|a, b| a.start.total_cmp(&b.start));
    // Seconds of the source to frames of the timeline.
    let at = |seconds: f64| clip.start as f64 + (seconds - source_in) / speed * fps;
    heard
        .windows(2)
        .filter_map(|pair| {
            let [before, after] = pair else { return None };
            let seconds = (after.start - before.end) / speed;
            if seconds <= max_pause {
                return None;
            }
            let half = keep / 2.0 * fps;
            let from = (at(before.end) + half).ceil() as i64;
            let to = (at(after.start) - half).floor() as i64;
            (to > from).then(|| Pause {
                clip: clip.id.clone(),
                between: (before.text.trim().to_owned(), after.text.trim().to_owned()),
                seconds,
                from,
                to,
            })
        })
        .collect()
}

/// The pauses to shorten in the voice-overs between frames `from` and `to`
/// (wholly inside it), and those left because someone in the footage is heard
/// over them.
pub fn tighten_plan(
    project: &Project,
    words: &HashMap<String, Vec<Word>>,
    from: i64,
    to: i64,
    max_pause: f64,
    keep: f64,
) -> (Vec<Pause>, Vec<Pause>) {
    let (mut cut, mut left) = (Vec::new(), Vec::new());
    for clip in voiceovers_in(project, from, to) {
        let Some(heard) = clip.media_id().and_then(|media| words.get(media)) else {
            continue;
        };
        for pause in pauses(project, clip, heard, max_pause, keep) {
            if pause.from < from || pause.to > to {
                continue;
            }
            if crate::subtitles::footage_sound(project, pause.from, pause.to).is_empty() {
                cut.push(pause);
            } else {
                left.push(pause);
            }
        }
    }
    (cut, left)
}

/// Takes `pauses` out of the timeline, latest first so each is where it was
/// found; frames removed in all.
pub fn remove_pauses(project: &mut Project, pauses: &[Pause]) -> i64 {
    let mut spans: Vec<(i64, i64)> = pauses.iter().map(|pause| (pause.from, pause.to)).collect();
    spans.sort_unstable();
    spans.dedup();
    spans
        .into_iter()
        .rev()
        .map(|(from, to)| edit_core::remove_time(project, from, to).frames)
        .sum()
}

/// Shortens the long pauses in the voice-overs between `from` and `to`
/// (timeline frames) to `keep` seconds, rippling the timeline (B-roll and
/// all after it follow). `dry_run` only lists them.
pub async fn tighten(
    app: &App,
    id: &str,
    span: (i64, i64),
    max_pause: f64,
    keep: f64,
    dry_run: bool,
) -> Result<Value, String> {
    let project = app.store.get(id).ok_or("no such project")?.project;
    let fps = project.fps();
    let (from, to) = span;
    let media: Vec<String> = voiceovers_in(&project, from, to)
        .iter()
        .filter_map(|clip| clip.media_id().map(str::to_owned))
        .collect();
    if media.is_empty() {
        return Err("no voice-over plays in that span".into());
    }
    let mut words = HashMap::new();
    for media_id in media {
        if words.contains_key(&media_id) {
            continue;
        }
        let Some(media) = project.media(&media_id) else {
            continue;
        };
        words.insert(media_id, transcript(app, media).await?);
    }
    let seconds = |frames: i64| (frames as f64 / fps * 100.0).round() / 100.0;
    let describe = |pause: &Pause| {
        json!({
            "at": seconds(pause.from),
            "between": format!("{} … {}", pause.between.0, pause.between.1),
            "pause": (pause.seconds * 100.0).round() / 100.0,
            "removed": seconds(pause.to - pause.from),
            "clip": pause.clip,
        })
    };
    let (cut, left, removed) = if dry_run {
        let (cut, left) = tighten_plan(&project, &words, from, to, max_pause, keep);
        let removed = cut.iter().map(|pause| pause.to - pause.from).sum();
        (cut, left, removed)
    } else {
        app.store
            .update(id, "agent", |project| {
                let (cut, left) = tighten_plan(project, &words, from, to, max_pause, keep);
                let removed = remove_pauses(project, &cut);
                Ok((cut, left, removed))
            })?
            .1
    };
    Ok(json!({
        "dry_run": dry_run,
        "removed_seconds": seconds(removed),
        "pauses": cut.iter().map(describe).collect::<Vec<_>>(),
        "left_alone": left.iter().map(describe).collect::<Vec<_>>(),
        "note": "times are where each pause was before any was taken out",
    }))
}

/// Plays the voice-overs between frames `from` and `to` `speed` times
/// faster (pitch kept), with everything laid over them squeezed to match, and
/// ripples the rest: (the span actually sped, frames saved). Refuses a span
/// with the footage's own sound in it, which would speed up what people say.
pub fn speed_up(
    project: &mut Project,
    from: i64,
    to: i64,
    speed: f64,
) -> Result<(i64, i64, i64), String> {
    if !(1.01..=1.25).contains(&speed) {
        return Err("speed must be between 1.01 and 1.25 (1.04–1.08 is usual)".into());
    }
    let clips = voiceovers_in(project, from, to);
    let (Some(first), Some(last)) = (
        clips.iter().map(|clip| clip.start).min(),
        clips.iter().map(|clip| clip.end()).max(),
    ) else {
        return Err("no voice-over plays in that span".into());
    };
    let (start, end) = (from.max(first), to.min(last));
    let footage: Vec<String> = crate::subtitles::footage_sound(project, start, end)
        .iter()
        .map(|clip| clip.id.clone())
        .collect();
    if !footage.is_empty() {
        return Err(format!(
            "the footage's own sound plays in that span ({}); speed only a stretch that's voice-over",
            footage.join(", ")
        ));
    }
    // Music and sound effects over it keep their speed: only the narration
    // (and the picture laid over it) plays faster.
    let narration: std::collections::HashSet<&str> = voiceovers_in(project, start, end)
        .iter()
        .map(|clip| clip.id.as_str())
        .collect();
    let hold: std::collections::HashSet<String> = project
        .clips
        .iter()
        .filter(|clip| {
            matches!(clip.content, ClipContent::Audio { .. })
                && !narration.contains(clip.id.as_str())
        })
        .map(|clip| clip.id.clone())
        .collect();
    let done = edit_core::speed_span_holding(project, start, end, speed, &hold);
    Ok((start, end, done.frames))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(text: &str, start: f64, end: f64) -> Word {
        Word {
            text: text.into(),
            start,
            end,
            speaker: None,
        }
    }

    /// A cut-in: a voice-over on A1 from 1 s into its recording, B-roll over
    /// it, and footage after it.
    fn cut_in() -> Project {
        serde_json::from_value(json!({
            "version": 1, "id": "p", "name": "t",
            "settings": { "width": 1920, "height": 1080, "fps": 30 },
            "media": [
                { "id": "vo", "name": "Narration", "path": "/tmp/vo.wav", "kind": "audio", "duration": 60.0, "has_audio": true },
                { "id": "m", "name": "bodycam", "path": "/tmp/b.mp4", "kind": "video", "duration": 600.0, "has_audio": true }
            ],
            "tracks": [
                { "id": "v1", "kind": "video" }, { "id": "v2", "kind": "video" },
                { "id": "a1", "kind": "audio" }
            ],
            "clips": [
                { "id": "voice", "track": "a1", "start": 0, "duration": 300, "name": "Voice-over",
                  "type": "audio", "media": "vo", "source_in": 1.0 },
                { "id": "broll", "track": "v1", "start": 0, "duration": 300, "type": "video", "media": "m", "source_in": 20.0 },
                { "id": "title", "track": "v2", "start": 150, "duration": 60, "type": "text", "text": "Callout" },
                { "id": "pic", "track": "v1", "start": 300, "duration": 90, "link": "f", "type": "video", "media": "m", "source_in": 40.0 },
                { "id": "snd", "track": "a1", "start": 300, "duration": 90, "link": "f", "type": "audio", "media": "m", "source_in": 40.0 }
            ]
        }))
        .unwrap()
    }

    fn words() -> Vec<Word> {
        vec![
            // Before the clip's source_in: not in the clip.
            said("Earlier", 0.0, 0.5),
            said("On", 1.2, 1.4),
            said("March", 1.45, 1.8),
            // A 1.2 s pause: shortened to 0.35.
            said("police", 3.0, 3.4),
            // 0.6 s: left.
            said("arrived.", 4.0, 4.5),
            // 2 s: shortened.
            said("Then", 6.5, 6.8),
            said("silence", 7.0, 7.5),
        ]
    }

    #[test]
    fn voiceovers_are_heard_for_house_words_beside_the_footage() {
        let mut project = cut_in();
        let ids = |clips: Vec<&Clip>| clips.iter().map(|clip| clip.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(voiceover_sound(&project, 0, 400)), ["voice"]);
        assert_eq!(
            ids(crate::subtitles::footage_sound(&project, 0, 400)),
            ["snd"]
        );
        // Narration says a house word: its mute lands on the voice-over clip.
        let heard = [
            said("he", 2.0, 2.2),
            said("abused", 2.3, 2.9),
            said("her", 3.0, 3.2),
        ];
        let words = crate::subtitles::timed_words(&heard, 1.0, 11.0);
        let found = crate::subtitles::suggestions(&words, true, 1000.0, 11_000.0);
        let mutes = found
            .iter()
            .map(|found| edit_core::Mute {
                from: found.start_ms / 1000.0,
                to: found.end_ms / 1000.0,
            })
            .collect();
        let pending = HashMap::from([("voice".to_owned(), (1.0, 11.0, mutes))]);
        crate::subtitles::write_mutes(&mut project, &pending);
        let Some(ClipContent::Audio { mutes, .. }) =
            project.clip("voice").map(|clip| &clip.content)
        else {
            panic!("no voice-over");
        };
        assert_eq!(mutes.len(), 1);
        assert!(mutes
            .first()
            .is_some_and(|mute| mute.from < 2.3 && mute.to > 2.9));
        // A muted track isn't heard, so nothing on it is muted.
        if let Some(track) = project.tracks.iter_mut().find(|track| track.id == "a1") {
            track.muted = true;
        }
        assert!(voiceover_sound(&project, 0, 400).is_empty());
    }

    #[test]
    fn finds_only_long_pauses_between_words() {
        let project = cut_in();
        let clip = project.clip("voice").unwrap();
        let found = pauses(&project, clip, &words(), 0.7, 0.35);
        let spans: Vec<(i64, i64, &str)> = found
            .iter()
            .map(|pause| (pause.from, pause.to, pause.between.0.as_str()))
            .collect();
        // March ends 0.8 s into the clip (24 frames); 0.175 s kept after it,
        // and before police (2 s in, frame 60).
        assert_eq!(spans, vec![(30, 54, "March"), (111, 159, "arrived.")]);
        assert!((found[0].seconds - 1.2).abs() < 1e-9);
        assert!(project
            .clip("voice")
            .is_some_and(|clip| is_voiceover(&project, clip)));
        assert!(!is_voiceover(&project, project.clip("snd").unwrap()));
    }

    #[test]
    fn tightening_ripples_the_broll_and_everything_after() {
        let mut project = cut_in();
        let heard = HashMap::from([("vo".to_owned(), words())]);
        let (cut, left) = tighten_plan(&project, &heard, 0, project.duration(), 0.7, 0.35);
        assert_eq!((cut.len(), left.len()), (2, 0));
        let removed = remove_pauses(&mut project, &cut);
        assert_eq!(removed, 24 + 48);
        project.validate().unwrap();
        assert_eq!(project.clip("pic").unwrap().start, 300 - removed);
        assert_eq!(project.clip("snd").unwrap().start, 300 - removed);
        // The voice-over and its B-roll are cut at the same places.
        let pieces = |track: &str| {
            let mut pieces: Vec<(i64, i64)> = project
                .clips
                .iter()
                .filter(|clip| clip.track == track && clip.start < 300 - removed)
                .map(|clip| (clip.start, clip.duration))
                .collect();
            pieces.sort_unstable();
            pieces
        };
        assert_eq!(pieces("a1"), vec![(0, 30), (30, 57), (87, 141)]);
        assert_eq!(pieces("v1"), pieces("a1"));
        // A pause with the footage heard over it is left.
        let mut project = cut_in();
        let snd = project.clip_mut("snd").unwrap();
        (snd.start, snd.duration, snd.track) = (0, 300, "a2".into());
        project
            .tracks
            .push(serde_json::from_value(json!({ "id": "a2", "kind": "audio" })).unwrap());
        let (cut, left) = tighten_plan(&project, &heard, 0, 300, 0.7, 0.35);
        assert_eq!((cut.len(), left.len()), (0, 2));
    }

    #[test]
    fn speeding_a_voiceover_squeezes_what_is_over_it() {
        let mut project = cut_in();
        let (start, end, saved) = speed_up(&mut project, 0, 300, 1.2).unwrap();
        assert_eq!((start, end, saved), (0, 300, 50));
        project.validate().unwrap();
        let voice = project.clip("voice").unwrap();
        assert_eq!(voice.duration, 250);
        let ClipContent::Audio { speed, .. } = voice.content else {
            panic!()
        };
        assert!((speed - 1.2).abs() < 1e-9);
        assert_eq!(project.clip("broll").unwrap().duration, 250);
        let title = project.clip("title").unwrap();
        assert_eq!((title.start, title.duration), (125, 50));
        assert_eq!(project.clip("pic").unwrap().start, 250);
        // Not the footage, nor too fast.
        assert!(speed_up(&mut cut_in(), 0, 400, 1.3).is_err());
        let mut over_footage = cut_in();
        over_footage.clip_mut("snd").unwrap().start = 200;
        over_footage.clip_mut("snd").unwrap().track = "a2".into();
        over_footage
            .tracks
            .push(serde_json::from_value(json!({ "id": "a2", "kind": "audio" })).unwrap());
        assert!(speed_up(&mut over_footage, 0, 300, 1.1).is_err());
    }

    #[test]
    fn speeding_a_voiceover_leaves_the_music_and_sound_effects_at_their_speed() {
        let mut project = cut_in();
        project.media.push(
            serde_json::from_value(
                json!({ "id": "bed", "name": "Nothing Much", "path": "/tmp/bed.wav",
                "kind": "audio", "duration": 120.0, "has_audio": true }),
            )
            .unwrap(),
        );
        project
            .tracks
            .push(serde_json::from_value(json!({ "id": "a2", "kind": "audio" })).unwrap());
        project
            .tracks
            .push(serde_json::from_value(json!({ "id": "a3", "kind": "audio" })).unwrap());
        for clip in [
            // A bed from the cut-in's start on past it, and a hit inside it.
            json!({ "id": "music", "track": "a2", "start": 0, "duration": 390, "type": "audio", "media": "bed", "source_in": 0.0 }),
            json!({ "id": "hit", "track": "a3", "start": 120, "duration": 15, "type": "audio", "media": "bed", "source_in": 30.0 }),
        ] {
            project.clips.push(serde_json::from_value(clip).unwrap());
        }
        let (_, _, saved) = speed_up(&mut project, 0, 300, 1.2).unwrap();
        assert_eq!(saved, 50);
        project.validate().unwrap();
        let speed = |id: &str| match project.clip(id).unwrap().content {
            ClipContent::Audio { speed, .. } => speed,
            _ => panic!(),
        };
        // The bed plays on unbroken at its own speed and ends as the timeline does.
        let beds: Vec<&Clip> = project
            .clips
            .iter()
            .filter(|clip| {
                matches!(&clip.content, ClipContent::Audio { media, .. } if media == "bed")
                    && clip.track == "a2"
            })
            .collect();
        assert_eq!(beds.len(), 1);
        assert_eq!((beds[0].start, beds[0].end()), (0, 340));
        assert!((speed("music") - 1.0).abs() < 1e-9);
        // The hit moves with the words it was on, at its own speed.
        assert_eq!(project.clip("hit").unwrap().start, 100);
        assert!((speed("hit") - 1.0).abs() < 1e-9);
        // The narration itself is sped.
        assert!((speed("voice") - 1.2).abs() < 1e-9);
    }

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
