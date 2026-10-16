//! Covering a cut-in with B-roll in one go, the house way: the shots the
//! agent picked, butted end to end across the cut-in, each slowed, pushed in
//! using native frame sampling, the B-roll look over them, the vertical
//! drop into the cut, and the placeholder card and words gone with the
//! voice-over moved onto A1. The agent picks the shots; this does the rest,
//! so a cut-in is one tool call instead of dozens.

use edit_core::{Clip, ClipColor, ClipContent, MediaKind, Project, ScriptBlock, TrackKind};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::server::App;

const ORIGIN: &str = "agent";

#[derive(Deserialize)]
struct Shot {
    media: String,
    /// Seconds into the media.
    source_in: f64,
    /// Timeline seconds where the shot starts (the first defaults to the cut-in's start).
    at: Option<f64>,
    name: Option<String>,
    speed: Option<f64>,
    /// Scale at the shot's first and last frame (multiplied by `scale`).
    push: Option<[f64; 2]>,
    x: Option<f64>,
    y: Option<f64>,
    scale: Option<f64>,
    smooth: Option<bool>,
}

#[derive(Deserialize)]
struct Args {
    cut_in: Value,
    shots: Vec<Shot>,
    #[serde(default = "yes")]
    look: bool,
    /// "drop" (the vertical drop) or "none" (another transition, placed separately).
    into: Option<String>,
}

fn yes() -> bool {
    true
}

/// A cut-in: its number among the script's narration blocks (1-based, as
/// "Cut-in N" in clip and media names), its card, its words and voice-over.
struct CutIn {
    number: usize,
    card: Option<String>,
    voiceover: Option<String>,
    start: i64,
    end: i64,
}

fn find_cut_in(project: &Project, which: &Value) -> Result<CutIn, String> {
    let script = project.script.as_ref().ok_or("the project has no script")?;
    let narrations: Vec<(Option<&String>, Option<&String>)> = script
        .blocks
        .iter()
        .filter_map(|block| match block {
            ScriptBlock::Narration {
                clip, voiceover, ..
            } => Some((clip.as_ref(), voiceover.as_ref())),
            ScriptBlock::Footage { .. } => None,
        })
        .collect();
    let index = match which {
        Value::Number(number) => number
            .as_u64()
            .and_then(|number| (number as usize).checked_sub(1))
            .filter(|index| *index < narrations.len())
            .ok_or_else(|| format!("cut_in is 1 to {}", narrations.len()))?,
        Value::String(id) => narrations
            .iter()
            .position(|(card, voiceover)| {
                card.is_some_and(|card| card == id) || voiceover.is_some_and(|vo| vo == id)
            })
            .ok_or_else(|| format!("{id} isn't a cut-in's card or voice-over"))?,
        _ => return Err("cut_in is its number (1-based) or its card's clip id".to_owned()),
    };
    let (card, voiceover) = narrations.get(index).copied().ok_or("no such cut-in")?;
    let card = card.filter(|id| project.clip(id).is_some()).cloned();
    let voiceover = voiceover.filter(|id| project.clip(id).is_some()).cloned();
    let spanning = card
        .as_deref()
        .or(voiceover.as_deref())
        .and_then(|id| project.clip(id))
        .ok_or_else(|| {
            format!(
                "cut-in {} has neither a card nor a voice-over on the timeline",
                index + 1
            )
        })?;
    Ok(CutIn {
        number: index + 1,
        card,
        voiceover,
        start: spanning.start,
        end: spanning.end(),
    })
}

fn video_tracks(project: &Project) -> Vec<String> {
    project
        .tracks
        .iter()
        .filter(|track| track.kind == TrackKind::Video && !track.subtitles)
        .map(|track| track.id.clone())
        .collect()
}

fn busy(project: &Project, track: &str, start: i64, end: i64) -> bool {
    project
        .clips
        .iter()
        .any(|clip| clip.track == track && clip.start < end && start < clip.end())
}

/// The lowest video track above `below` (any track when None) that's free
/// for the span; a new one on top when none is.
fn free_above(project: &mut Project, below: Option<&str>, start: i64, end: i64) -> String {
    let tracks = video_tracks(project);
    let from = below
        .and_then(|below| tracks.iter().position(|track| track == below))
        .map_or(1, |at| at + 1);
    for track in tracks.iter().skip(from) {
        if !busy(project, track, start, end) {
            return track.clone();
        }
    }
    project.add_track(TrackKind::Video)
}

/// A free video track above everything playing in the span.
fn free_on_top(project: &mut Project, start: i64, end: i64) -> String {
    let tracks = video_tracks(project);
    let top = tracks
        .iter()
        .rev()
        .find(|track| busy(project, track, start, end))
        .cloned();
    free_above(project, top.as_deref(), start, end)
}

fn clip_from(fields: Value) -> Result<Clip, String> {
    serde_json::from_value(fields).map_err(|error| format!("clip: {error}"))
}

pub async fn cover_cut_in(app: &App, project_id: &str, args: &Value) -> Result<Value, String> {
    let (_, (report, smooth)) = app
        .store
        .update(project_id, ORIGIN, |project| cover(project, args))?;
    let started = crate::broll::smooth_in_background(app, project_id, &smooth);
    let mut report = report;
    if let Some(fields) = report.as_object_mut() {
        fields.insert("smoothing_started".to_owned(), json!(started));
    }
    Ok(report)
}

/// Pure plan operation: the caller validates and commits the whole section once.
/// Expensive optical flow is an explicit shot option, never automatic work.
pub fn cover(project: &mut Project, args: &Value) -> Result<(Value, Vec<String>), String> {
    let args: Args =
        serde_json::from_value(args.clone()).map_err(|error| format!("arguments: {error}"))?;
    if args.shots.is_empty() {
        return Err("give at least one shot".to_owned());
    }
    let drop = match args.into.as_deref() {
        None | Some("drop") => true,
        Some("none") => false,
        Some(other) => return Err(format!("into is drop or none, not {other}")),
    };
    let fps = project.fps();
    let cut = find_cut_in(project, &args.cut_in)?;
    let prefix = format!("Cut-in {} · ", cut.number);

    // Where each shot starts and ends, butted across the whole cut-in.
    let frame = |seconds: f64| (seconds * fps).round() as i64;
    let mut starts = Vec::new();
    for (index, shot) in args.shots.iter().enumerate() {
        let start = match shot.at {
            Some(at) => frame(at),
            None if index == 0 => cut.start,
            None => {
                return Err(format!(
                    "shot {} needs at (timeline seconds where it starts)",
                    index + 1
                ))
            }
        };
        // A first shot within a few frames of the cut-in's start starts it.
        let start = if index == 0 && (start - cut.start).abs() <= 6 {
            cut.start
        } else {
            start
        };
        starts.push(start);
    }
    if starts.first() != Some(&cut.start) {
        return Err(format!(
            "the first shot must start the cut-in, at {:.2} s",
            cut.start as f64 / fps
        ));
    }
    let mut spans = Vec::new();
    for (index, start) in starts.iter().enumerate() {
        let end = starts.get(index + 1).copied().unwrap_or(cut.end);
        if end <= *start || end > cut.end {
            return Err(format!(
                "shot {} has no room: shots start in order inside the cut-in ({:.2}–{:.2} s)",
                index + 1,
                cut.start as f64 / fps,
                cut.end as f64 / fps
            ));
        }
        spans.push((*start, end));
    }

    // A re-run replaces what it placed before.
    let span = (cut.start - 6, cut.end + 6);
    project.clips.retain(|clip| {
        let ours = clip.name.as_deref().is_some_and(|name| {
            name.starts_with(&format!("{prefix}B-roll")) || name == format!("{prefix}vertical drop")
        });
        !(ours && clip.start < span.1 && span.0 < clip.end())
    });

    // The placeholder card and its words go; the narration keeps its voice-over.
    let mut removed = Vec::new();
    if let Some(card_id) = &cut.card {
        let card = project.clip(card_id).cloned();
        if let Some(card) = card {
            project.clips.retain(|clip| {
                let words = clip.id != card.id
                    && matches!(clip.content, ClipContent::Text { .. })
                    && (card.link.is_some() && clip.link == card.link
                        || clip.start == card.start && clip.duration == card.duration);
                let gone = clip.id == card.id || words;
                if gone {
                    removed.push(clip.id.clone());
                }
                !gone
            });
        }
        // The script keeps the card's id: a placed block whose clip is gone
        // was removed on purpose. Cleared, it read as never placed, and the
        // next script resume laid every covered card out again at the end.
    }

    // The shots, on the lowest free track above the footage.
    let shots_track = free_above(project, None, cut.start, cut.end);
    let mut placed = Vec::new();
    let mut smooth = Vec::new();
    for (index, (shot, (start, end))) in args.shots.iter().zip(&spans).enumerate() {
        let media = project
            .media(&shot.media)
            .ok_or_else(|| format!("shot {}: no media {}", index + 1, shot.media))?;
        let still = media.kind == MediaKind::Image;
        if media.kind == MediaKind::Audio {
            return Err(format!("shot {}: {} is audio", index + 1, shot.media));
        }
        let speed = if still {
            1.0
        } else {
            shot.speed.unwrap_or(0.5).clamp(0.05, 20.0)
        };
        let duration = end - start;
        let needs = duration as f64 / fps * speed;
        if !shot.source_in.is_finite() || shot.source_in < 0.0 {
            return Err(format!(
                "shot {}: source_in must be finite and nonnegative",
                index + 1
            ));
        }
        if !still && shot.source_in + needs > media.duration + 0.05 {
            return Err(format!(
                    "shot {}: {} runs out at {:.2} s; from {:.2} s at {speed}× this shot needs {:.2} s of it",
                    index + 1,
                    shot.media,
                    media.duration,
                    shot.source_in,
                    needs
                ));
        }
        let scale = shot.scale.unwrap_or(1.0);
        let [from, to] = shot.push.unwrap_or([1.0, 1.08]);
        let label = shot
            .name
            .clone()
            .unwrap_or_else(|| format!("shot {}", index + 1));
        let id = project.fresh_id("c");
        let clip = clip_from(json!({
            "id": id, "track": shots_track, "start": start, "duration": duration,
            "color": "cyan", "name": format!("{prefix}B-roll: {label}"),
            "type": "video", "media": shot.media, "source_in": shot.source_in.max(0.0), "speed": speed,
            "transform": { "x": shot.x.unwrap_or(0.0), "y": shot.y.unwrap_or(0.0), "scale": scale, "rotation": 0.0 },
            "opacity": 1.0,
            "keyframes": { "scale": [
                { "frame": 0.0, "value": scale * from, "ease": "linear" },
                { "frame": (duration - 1).max(1) as f64, "value": scale * to, "ease": "linear" }
            ] },
        }))?;
        project.clips.push(clip);
        if !still && speed < 0.999 && shot.smooth.unwrap_or(false) {
            smooth.push(id.clone());
        }
        placed.push(json!({
            "clip": id, "name": label,
            "start": *start as f64 / fps, "end": *end as f64 / fps,
            "source": [shot.source_in, shot.source_in + needs],
        }));
    }

    // The B-roll look over the whole stretch, above the shots.
    let look = if args.look {
        let track = free_above(project, Some(&shots_track), cut.start, cut.end);
        let id = project.fresh_id("c");
        project.clips.push(clip_from(json!({
                "id": id, "track": track, "start": cut.start, "duration": cut.end - cut.start,
                "color": "blue", "name": format!("{prefix}B-roll look"),
                "type": "adjustment",
                "grade": { "exposure": 0.0, "contrast": 0.0, "saturation": -0.6, "temperature": 0.0, "vignette": 0.3 },
                "opacity": 1.0,
            }))?);
        Some(id)
    } else {
        None
    };

    // The vertical drop into the cut-in, straddling the cut above everything.
    let drop = if drop && cut.start >= 3 {
        let (start, end) = (cut.start - 3, cut.start + 3);
        let track = free_on_top(project, start, end);
        let id = project.fresh_id("c");
        project.clips.push(clip_from(json!({
                "id": id, "track": track, "start": start, "duration": end - start,
                "color": "blue", "name": format!("{prefix}vertical drop"),
                "type": "adjustment",
                "grade": { "exposure": 0.0, "contrast": 0.0, "saturation": 0.0, "temperature": 0.0, "vignette": 0.0 },
                "shake": { "preset": "vertical" },
                "opacity": 1.0,
            }))?);
        Some(id)
    } else {
        None
    };

    // The voice-over onto A1 (the footage's sound track, free under B-roll), purple.
    let mut voiceover = Value::Null;
    if let Some(vo) = cut.voiceover.as_deref() {
        let a1 = project
            .tracks
            .iter()
            .find(|track| track.kind == TrackKind::Audio)
            .map(|track| track.id.clone());
        let (start, end) = project
            .clip(vo)
            .map_or((0, 0), |clip| (clip.start, clip.end()));
        let free = a1.as_deref().is_some_and(|a1| {
            !project.clips.iter().any(|clip| {
                clip.id != vo && clip.track == a1 && clip.start < end && start < clip.end()
            })
        });
        if let (Some(a1), Some(clip)) = (a1.filter(|_| free), project.clip_mut(vo)) {
            clip.track = a1;
            clip.color = ClipColor::Purple;
            voiceover = json!({ "clip": vo, "moved_to_a1": true });
        } else {
            voiceover =
                json!({ "clip": vo, "moved_to_a1": false, "why": "A1 isn't free under it" });
        }
    }

    let report = json!({
        "cut_in": cut.number,
        "span": [cut.start as f64 / fps, cut.end as f64 / fps],
        "shots": placed,
        "look": look,
        "vertical_drop": drop,
        "removed_card_and_words": removed,
        "voiceover": voiceover,
    });
    Ok((report, smooth))
}
