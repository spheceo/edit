//! A section-sized transaction: resolve references, apply all operations, validate
//! once, commit once. Intermediate overlaps are allowed; invalid plans save nothing.
use std::collections::{BTreeSet, HashMap};

use edit_core::{animatable_params, Clip, ClipContent, Keyframe, Project, TrackKind};
use serde::Deserialize;
use serde_json::{json, Value};

pub struct Applied {
    pub results: Vec<Value>,
    pub smooth: Vec<String>,
}

pub fn apply(project: &mut Project, operations: &[Value]) -> Result<Applied, String> {
    if operations.is_empty() || operations.len() > 2000 {
        return Err("give 1 to 2000 operations".to_owned());
    }
    let mut refs = HashMap::new();
    let mut results = Vec::new();
    let mut smooth = Vec::new();
    for (index, original) in operations.iter().enumerate() {
        let result = (|| {
            let mut operation = original.clone();
            // Only operation arguments are references: literal caption text such
            // as "$100" is never interpreted as a reference. Use {"$ref":"hero"}.
            resolve(&mut operation, &refs)?;
            let result = operation_on(project, &operation, &mut smooth)?;
            if let Some(alias) = operation.get("as").and_then(Value::as_str) {
                if alias.is_empty() || refs.insert(alias.to_owned(), result.clone()).is_some() {
                    return Err(format!("duplicate or empty alias {alias}"));
                }
            }
            Ok(result)
        })()
        .map_err(|error: String| format!("operation {}: {error}; nothing saved", index + 1))?;
        results.push(result);
    }
    project
        .validate()
        .map_err(|error| format!("final plan is invalid: {error}; nothing saved"))?;
    Ok(Applied { results, smooth })
}

fn resolve(value: &mut Value, refs: &HashMap<String, Value>) -> Result<(), String> {
    if let Some(reference) = value
        .as_object()
        .filter(|fields| fields.len() == 1)
        .and_then(|fields| fields.get("$ref"))
        .and_then(Value::as_str)
    {
        let (name, pointer) = reference
            .split_once('/')
            .map_or((reference, String::new()), |(name, pointer)| {
                (name, format!("/{pointer}"))
            });
        *value = refs
            .get(name)
            .and_then(|value| value.pointer(&pointer))
            .cloned()
            .ok_or_else(|| {
                format!("unknown reference {reference}; use an earlier operation's alias")
            })?;
        return Ok(());
    }
    match value {
        Value::Array(values) => values.iter_mut().try_for_each(|value| resolve(value, refs)),
        Value::Object(fields) => fields
            .values_mut()
            .try_for_each(|value| resolve(value, refs)),
        _ => Ok(()),
    }
}

fn operation_on(
    project: &mut Project,
    args: &Value,
    smooth: &mut Vec<String>,
) -> Result<Value, String> {
    match args["op"].as_str().ok_or("op is required")? {
        "add" => {
            let mut fields = args["clip"]
                .as_object()
                .cloned()
                .ok_or("clip must be an object")?;
            let id = fields
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| project.fresh_id("c"));
            if project.clip(&id).is_some() {
                return Err(format!("clip {id} already exists; use update"));
            }
            fields.insert("id".to_owned(), json!(id));
            let kind = if fields.get("type").and_then(Value::as_str) == Some("audio") {
                TrackKind::Audio
            } else {
                TrackKind::Video
            };
            // No silent defaults: a clip at frame 0 for one frame is never meant.
            let start = fields
                .get("start")
                .and_then(Value::as_i64)
                .ok_or("clip.start is required (frames)")?;
            let end = start.saturating_add(
                fields
                    .get("duration")
                    .and_then(Value::as_i64)
                    .ok_or("clip.duration is required (frames)")?,
            );
            let track = match fields.get("track").and_then(Value::as_str) {
                Some("new") => Some(project.add_track(kind)),
                Some(_) => None,
                None => Some(crate::mcp::free_track(project, kind, start, end)),
            };
            if let Some(track) = track {
                fields.insert("track".to_owned(), json!(track));
            }
            let clip: Clip = serde_json::from_value(Value::Object(fields))
                .map_err(|error| format!("clip: {error}"))?;
            project.clips.push(clip);
            Ok(json!(id))
        }
        "update" => {
            let ids = selected(project, &args["select"])?;
            let mut patch = args["patch"]
                .as_object()
                .ok_or("patch must be an object")?
                .clone();
            // {track: "new"} moves the clips onto a new track of their kind, as add does.
            if patch.get("track").and_then(Value::as_str) == Some("new") {
                let audio = project
                    .clips
                    .iter()
                    .find(|clip| ids.contains(&clip.id))
                    .is_some_and(|clip| matches!(clip.content, ClipContent::Audio { .. }));
                let track = project.add_track(if audio {
                    TrackKind::Audio
                } else {
                    TrackKind::Video
                });
                patch.insert("track".to_owned(), json!(track));
            }
            let patch = &patch;
            // Moving or trimming one half of a linked pair moves the other
            // half with it (unless both are selected), as in the timeline.
            let mut moved: Vec<(String, i64, i64, i64)> = Vec::new();
            for clip in project
                .clips
                .iter_mut()
                .filter(|clip| ids.contains(&clip.id))
            {
                let (start, duration) = (clip.start, clip.duration);
                let mut value = serde_json::to_value(&*clip).map_err(|error| error.to_string())?;
                crate::mcp::merge(&mut value, &Value::Object(patch.clone()));
                value
                    .as_object_mut()
                    .ok_or("patched clip must be an object")?
                    .insert("id".to_owned(), json!(clip.id));
                *clip = serde_json::from_value(value).map_err(|error| format!("clip: {error}"))?;
                if let Some(link) = &clip.link {
                    if clip.start != start || clip.duration != duration {
                        moved.push((link.clone(), clip.start - start, duration, clip.duration));
                    }
                }
            }
            let mut partners = Vec::new();
            if !args["unlinked"].as_bool().unwrap_or(false) {
                for (link, shift, before, after) in moved {
                    for clip in project.clips.iter_mut().filter(|clip| {
                        clip.link.as_deref() == Some(link.as_str()) && !ids.contains(&clip.id)
                    }) {
                        clip.start += shift;
                        if clip.duration == before {
                            clip.duration = after;
                        }
                        partners.push(clip.id.clone());
                    }
                }
            }
            Ok(json!({"clips": ids, "linked_moved": partners}))
        }
        "delete" => {
            let mut ids = selected(project, &args["select"])?;
            // A linked pair goes together unless asked otherwise.
            if !args["unlinked"].as_bool().unwrap_or(false) {
                let links: BTreeSet<String> = project
                    .clips
                    .iter()
                    .filter(|clip| ids.contains(&clip.id))
                    .filter_map(|clip| clip.link.clone())
                    .collect();
                ids.extend(
                    project
                        .clips
                        .iter()
                        .filter(|clip| clip.link.as_ref().is_some_and(|link| links.contains(link)))
                        .map(|clip| clip.id.clone()),
                );
            }
            project.clips.retain(|clip| !ids.contains(&clip.id));
            Ok(json!({"clips": ids}))
        }
        "keyframes" => {
            let ids = selected(project, &args["select"])?;
            let param = args["param"].as_str().ok_or("param is required")?;
            let mut keys: Vec<Keyframe> = serde_json::from_value(args["keyframes"].clone())
                .map_err(|error| format!("keyframes: {error}"))?;
            keys.sort_by(|a, b| a.frame.total_cmp(&b.frame));
            // Two keys on one frame: the later one given wins.
            keys.reverse();
            keys.dedup_by(|a, b| a.frame == b.frame);
            keys.reverse();
            for clip in project
                .clips
                .iter_mut()
                .filter(|clip| ids.contains(&clip.id))
            {
                if !animatable_params(&clip.content).contains(&param) {
                    return Err(format!("{param} is not animatable on {}", clip.id));
                }
                if keys.is_empty() {
                    clip.keyframes.remove(param);
                } else {
                    clip.keyframes.insert(param.to_owned(), keys.clone());
                }
            }
            Ok(json!({"clips": ids}))
        }
        "cover_cut_in" => {
            let (report, pending) = crate::cutin::cover(project, args)?;
            smooth.extend(pending);
            Ok(report)
        }
        "tidy_tracks" => {
            let (moved, removed) = crate::mcp::tidy_tracks(project);
            Ok(json!({"moved": moved, "removed_tracks": removed}))
        }
        "transition" => transition(project, args),
        "evidence_board" => evidence_board(project, args),
        other => Err(format!(
            "unknown op {other}; use add, update, delete, keyframes, cover_cut_in, transition, evidence_board, tidy_tracks"
        )),
    }
}

/// A house transition at a cut, built the way the house style describes it,
/// so a plan says `{"op":"transition","kind":"dip","at":1234}` instead of a
/// clip and its keyframes for every cut (fewer tokens for the model to
/// write, and no room to get the shape wrong). On a new track above
/// everything there; tidy_tracks packs them down afterwards.
/// - drop: the vertical slam, an adjustment 6 frames straddling the cut.
/// - flash: white, 6 frames centred on the cut, fading out (with a shutter).
/// - dip: to black and straight back, `frames` long (12) centred on the cut.
/// - open: the reverse dip that opens the video, black fading out over ~0.5 s.
fn transition(project: &mut Project, args: &Value) -> Result<Value, String> {
    let kind = args["kind"]
        .as_str()
        .ok_or("transition needs kind: drop, flash, dip or open")?;
    let at = args["at"].as_i64();
    let cut = || at.ok_or_else(|| format!("a {kind} needs at (the cut's frame)"));
    let key =
        |frame: i64, value: f64, ease: &str| json!({"frame": frame, "value": value, "ease": ease});
    let (name, start, duration, content, opacity) = match kind {
        "drop" => (
            "Drop",
            cut()? - 3,
            6,
            json!({"type": "adjustment", "shake": {"preset": "vertical"}}),
            None,
        ),
        "flash" => (
            "Flash",
            cut()? - 3,
            6,
            json!({"type": "solid", "fill": [1.0, 1.0, 1.0, 1.0]}),
            Some(vec![key(0, 1.0, "out"), key(5, 0.0, "linear")]),
        ),
        "dip" => {
            let frames = args["frames"].as_i64().unwrap_or(12).clamp(4, 60);
            (
                "Dip",
                cut()? - frames / 2,
                frames,
                json!({"type": "solid", "fill": [0.0, 0.0, 0.0, 1.0]}),
                Some(vec![
                    key(0, 0.0, "in_out"),
                    key(frames / 2, 1.0, "in_out"),
                    key(frames - 1, 0.0, "linear"),
                ]),
            )
        }
        "open" => {
            let frames = ((project.fps() * 0.5).round() as i64).max(2);
            (
                "Opening dip",
                0,
                frames,
                json!({"type": "solid", "fill": [0.0, 0.0, 0.0, 1.0]}),
                Some(vec![key(0, 1.0, "linear"), key(frames - 1, 0.0, "linear")]),
            )
        }
        other => {
            return Err(format!(
                "unknown transition {other}; use drop, flash, dip or open"
            ))
        }
    };
    // Never before the start of the video: what's cut off the front goes.
    let (start, duration) = (start.max(0), duration - (-start).max(0));
    let id = project.fresh_id("c");
    let track = project.add_track(TrackKind::Video);
    let mut fields = content.as_object().cloned().ok_or("transition content")?;
    for (field, value) in [
        ("id", json!(id)),
        ("name", json!(name)),
        ("track", json!(track)),
        ("start", json!(start)),
        ("duration", json!(duration)),
    ] {
        fields.insert(field.to_owned(), value);
    }
    if let Some(keys) = opacity {
        fields.insert("keyframes".to_owned(), json!({"opacity": keys}));
    }
    let clip: Clip = serde_json::from_value(Value::Object(fields))
        .map_err(|error| format!("{kind}: {error}"))?;
    project.clips.push(clip);
    Ok(json!(id))
}

/// An evidence board: photos laid out on paper like prints on a desk, each in
/// a dark frame with a soft shadow and a red handwritten note under it, the
/// camera holding on one (drifting slowly), then gliding to the next (eased,
/// ~0.7 s), zig-zagging down the board; each note writes itself on, a letter
/// every 2 frames, just after its photo arrives. Built in one go from
/// `{"op":"evidence_board","start":F,"items":[{"media":"m1","label":"arson?","frames":75}]}`
/// (frames = how long the camera stays on that photo; `pan` the glide's frames).
fn evidence_board(project: &mut Project, args: &Value) -> Result<Value, String> {
    let start = args["start"]
        .as_i64()
        .ok_or("evidence_board needs start (frames)")?
        .max(0);
    let items = args["items"]
        .as_array()
        .filter(|items| !items.is_empty() && items.len() <= 8)
        .ok_or("evidence_board needs items: 1 to 8 photos [{media, label, frames}]")?;
    let pan = args["pan"].as_i64().unwrap_or(22).clamp(8, 60);
    let (width, height) = (
        f64::from(project.settings.width),
        f64::from(project.settings.height),
    );
    let k = height / 1080.0;
    // Where each photo sits on the board (its centre, project pixels): down
    // the board, alternately straight under and off to the right.
    let spots: Vec<(f64, f64)> = (0..items.len())
        .map(|index| {
            let x = if index % 2 == 0 { 0.0 } else { 0.42 * width };
            (x, index as f64 * 0.5 * height)
        })
        .collect();
    let holds: Vec<i64> = items
        .iter()
        .map(|item| item["frames"].as_i64().unwrap_or(75).clamp(20, 600))
        .collect();
    // The camera: a slow drift along the way it's going while it holds, then
    // an eased glide to the next photo. (frame, x, y, ease to the next)
    let drift = 0.35 * k;
    let mut camera: Vec<(i64, f64, f64, &str)> = Vec::new();
    let mut at = 0;
    let mut arrivals = Vec::new();
    for (index, (&(x, y), &hold)) in spots.iter().zip(&holds).enumerate() {
        let toward = spots
            .get(index + 1)
            .or_else(|| index.checked_sub(1).and_then(|before| spots.get(before)))
            .map_or((0.6, 0.8), |&(nx, ny)| {
                let (dx, dy) = if index + 1 < spots.len() {
                    (nx - x, ny - y)
                } else {
                    (x - nx, y - ny)
                };
                let length = dx.hypot(dy).max(1.0);
                (dx / length, dy / length)
            });
        let reach = drift * hold as f64 / 2.0;
        arrivals.push(at);
        camera.push((at, x - toward.0 * reach, y - toward.1 * reach, "linear"));
        camera.push((
            at + hold,
            x + toward.0 * reach,
            y + toward.1 * reach,
            "in_out",
        ));
        at += hold + pan;
    }
    let total = at - pan;
    // Where the camera is at `frame` (only asked inside a hold, which is linear).
    let camera_at = |frame: i64| -> (f64, f64) {
        camera
            .windows(2)
            .find_map(|pair| match pair {
                [(from, fx, fy, _), (to, tx, ty, _)] if *from <= frame && frame <= *to => {
                    let share = (frame - from) as f64 / (to - from).max(1) as f64;
                    Some((fx + (tx - fx) * share, fy + (ty - fy) * share))
                }
                _ => None,
            })
            .unwrap_or((0.0, 0.0))
    };
    // An element at board position (bx, by), on screen from `from` (board frames).
    let keys = |bx: f64, by: f64, from: i64| -> Value {
        let mut xs = Vec::new();
        let mut ys = Vec::new();
        let (cx, cy) = camera_at(from);
        xs.push(json!({"frame": 0, "value": bx - cx, "ease": "linear"}));
        ys.push(json!({"frame": 0, "value": by - cy, "ease": "linear"}));
        for &(frame, cx, cy, ease) in camera.iter().filter(|key| key.0 > from) {
            xs.push(json!({"frame": frame - from, "value": bx - cx, "ease": ease}));
            ys.push(json!({"frame": frame - from, "value": by - cy, "ease": ease}));
        }
        json!({"x": xs, "y": ys})
    };
    let mut made = Vec::new();
    let mut add = |project: &mut Project, fields: Value| -> Result<String, String> {
        let id = project.fresh_id("c");
        let mut fields = fields.as_object().cloned().ok_or("board clip")?;
        fields.insert("id".to_owned(), json!(id));
        let clip: Clip = serde_json::from_value(Value::Object(fields))
            .map_err(|error| format!("evidence_board: {error}"))?;
        project.clips.push(clip);
        made.push(id.clone());
        Ok(id)
    };
    // The paper, under everything on the board.
    let paper = project.add_track(TrackKind::Video);
    add(
        project,
        json!({"type": "solid", "name": "Evidence board · paper", "track": paper,
        "start": start, "duration": total, "fill": [0.93, 0.93, 0.915, 1.0]}),
    )?;
    for (index, ((&(x, y), item), &arrival)) in spots.iter().zip(items).zip(&arrivals).enumerate() {
        let media_id = item["media"].as_str().ok_or_else(|| {
            format!(
                "item {}: media (an image's media id) is required",
                index + 1
            )
        })?;
        let media = project
            .media(media_id)
            .cloned()
            .ok_or_else(|| format!("item {}: no media {media_id}", index + 1))?;
        // About half the frame's height (no wider than ~60% of it).
        let (w, h) = (
            f64::from(media.width.max(1)),
            f64::from(media.height.max(1)),
        );
        let fit = (width / w).min(height / h);
        let mut scale = 0.56 * height / (h * fit);
        if w * fit * scale > 0.62 * width {
            scale = 0.62 * width / (w * fit);
        }
        let shown = h * fit * scale;
        let photo = project.add_track(TrackKind::Video);
        add(
            project,
            json!({"type": "video", "name": format!("Evidence board · photo {}", index + 1),
            "track": photo, "media": media_id, "source_in": 0.0, "start": start, "duration": total,
            "transform": {"x": x - camera_at(0).0, "y": y - camera_at(0).1, "scale": scale},
            "frame": {"width": 16.0 * k, "shadow": 0.5},
            "keyframes": keys(x, y, 0)}),
        )?;
        if let Some(label) = item["label"]
            .as_str()
            .filter(|label| !label.trim().is_empty())
        {
            let from = arrival + 8;
            let (lx, ly) = (
                x + if index % 2 == 0 { 0.02 } else { -0.02 } * width,
                y + shown / 2.0 + 0.06 * height,
            );
            let track = project.add_track(TrackKind::Video);
            let (cx, cy) = camera_at(from);
            add(
                project,
                json!({"type": "text", "name": format!("Evidence board · note {}", index + 1),
                "track": track, "start": start + from, "duration": total - from, "text": label,
                "style": {"font": "Reenie Beanie", "weight": 400, "size": 128.0 * k,
                    "color": [0.8, 0.07, 0.15, 1.0], "glow": {"enabled": false}},
                "transform": {"x": lx - cx, "y": ly - cy, "rotation": -4.0},
                "animation": {"preset": "typewriter", "stagger": 2.0, "duration": 1.0},
                "keyframes": keys(lx, ly, from)}),
            )?;
        }
    }
    // The board's vignette, over all of it.
    let shade = project.add_track(TrackKind::Video);
    add(
        project,
        json!({"type": "adjustment", "name": "Evidence board · vignette", "track": shade,
        "start": start, "duration": total, "grade": {"vignette": 0.38}}),
    )?;
    Ok(json!({"clips": made, "end": start + total}))
}

/// Selects many clips without having to enumerate hundreds of subtitle IDs.
/// Times are frames, as in the project model. All supplied filters intersect.
fn selected(project: &Project, select: &Value) -> Result<BTreeSet<String>, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Selector {
        ids: Option<Vec<String>>,
        track: Option<String>,
        label: Option<String>,
        media: Option<String>,
        name_prefix: Option<String>,
        #[serde(rename = "type")]
        kind: Option<String>,
        start: Option<i64>,
        end: Option<i64>,
    }
    let picked: Selector =
        serde_json::from_value(select.clone()).map_err(|error| format!("select: {error}"))?;
    if picked.ids.is_none()
        && picked.track.is_none()
        && picked.label.is_none()
        && picked.media.is_none()
        && picked.name_prefix.is_none()
        && picked.kind.is_none()
        && picked.start.is_none()
        && picked.end.is_none()
    {
        return Err("select needs at least one filter".to_owned());
    }
    let ids = picked.ids;
    if let Some(ids) = &ids {
        if let Some(id) = ids.iter().find(|id| project.clip(id).is_none()) {
            return Err(format!("no clip {id}"));
        }
    }
    let mut result = BTreeSet::new();
    for clip in &project.clips {
        if ids.as_ref().is_some_and(|ids| !ids.contains(&clip.id)) {
            continue;
        }
        if select["track"]
            .as_str()
            .is_some_and(|track| clip.track != track)
        {
            continue;
        }
        if picked.label.as_deref().is_some_and(|label| !matches!(&clip.content, ClipContent::Text {style, ..} if style.label.as_ref().is_some_and(|own| own.text == label))) { continue; }
        if select["media"]
            .as_str()
            .is_some_and(|media| clip.media_id() != Some(media))
        {
            continue;
        }
        if picked.name_prefix.as_deref().is_some_and(|prefix| {
            !clip
                .name
                .as_deref()
                .is_some_and(|name| name.starts_with(prefix))
        }) {
            continue;
        }
        if select["start"]
            .as_i64()
            .is_some_and(|start| clip.start < start)
        {
            continue;
        }
        if picked.end.is_some_and(|end| clip.start >= end) {
            continue;
        }
        if let Some(kind) = picked.kind.as_deref() {
            let value = serde_json::to_value(clip).map_err(|error| error.to_string())?;
            if value.get("type").and_then(Value::as_str) != Some(kind) {
                continue;
            }
        }
        result.insert(clip.id.clone());
    }
    if result.is_empty() {
        return Err("no clips matched; check the selector in get_edit_context".to_owned());
    }
    Ok(result)
}

/// Deterministic review catches mechanical issues without asking a model to
/// inspect dozens of pictures. Visual/factual judgment still needs a contact sheet.
pub fn audit(project: &Project) -> Value {
    let mut issues = Vec::new();
    let mut picture: Vec<(i64, i64)> = project
        .clips
        .iter()
        .filter(|clip| {
            project
                .track(&clip.track)
                .is_some_and(|track| !track.hidden)
                && matches!(
                    clip.content,
                    ClipContent::Video { .. } | ClipContent::Solid { .. }
                )
        })
        .map(|clip| (clip.start, clip.end()))
        .collect();
    picture.sort_unstable();
    let mut end = 0;
    for (start, to) in picture {
        if start > end {
            issues.push(json!({"kind":"picture_gap", "start":end, "end":start}));
        }
        end = end.max(to);
    }
    if end < project.duration() {
        issues.push(json!({"kind":"picture_gap", "start":end, "end":project.duration()}));
    }
    for clip in &project.clips {
        if let ClipContent::Video {
            media,
            source_in,
            speed,
            ..
        }
        | ClipContent::Audio {
            media,
            source_in,
            speed,
            ..
        } = &clip.content
        {
            if let Some(media) = project.media(media) {
                if media.kind != edit_core::MediaKind::Image
                    && source_in + clip.duration as f64 / project.fps() * speed
                        > media.duration + 1.0 / project.fps()
                {
                    issues.push(json!({"kind":"source_exhausted", "clip":clip.id}));
                }
            }
        }
    }
    let mut links: HashMap<&str, Vec<&Clip>> = HashMap::new();
    for clip in &project.clips {
        if let Some(link) = clip.link.as_deref() {
            links.entry(link).or_default().push(clip);
        }
    }
    for (link, clips) in links {
        let videos: Vec<_> = clips
            .iter()
            .filter(|clip| matches!(clip.content, ClipContent::Video { .. }))
            .collect();
        for video in videos {
            for audio in clips
                .iter()
                .filter(|clip| matches!(clip.content, ClipContent::Audio { .. }))
            {
                if video.start != audio.start || video.duration != audio.duration {
                    issues.push(json!({"kind":"linked_audio_misaligned", "link":link, "video":video.id, "audio":audio.id}));
                }
            }
        }
    }
    // Slivers: a picture or text clip too short to read is left over from a
    // trim; footage under a quarter of a second reads as a stutter (the team
    // caught a 5-frame fragment; emphasis runs are 12 frames or more).
    for clip in &project.clips {
        let shortest = if matches!(clip.content, ClipContent::Video { .. }) {
            8
        } else {
            3
        };
        if clip.duration < shortest
            && !matches!(
                clip.content,
                ClipContent::Audio { .. } | ClipContent::Adjustment { .. }
            )
        {
            issues.push(json!({"kind":"sliver", "clip":clip.id, "start":clip.start, "frames":clip.duration}));
        }
    }
    // The same moment of footage shown as B-roll in two places (more than
    // a couple of seconds apart: cuts of one moment butted together are one shot).
    let base = project
        .tracks
        .iter()
        .find(|track| track.kind == TrackKind::Video)
        .map(|track| track.id.as_str());
    let broll: Vec<(&Clip, &str, f64, f64)> = project
        .clips
        .iter()
        .filter(|clip| Some(clip.track.as_str()) != base)
        .filter_map(|clip| match &clip.content {
            ClipContent::Video {
                media,
                source_in,
                speed,
                ..
            } => Some((
                clip,
                media.as_str(),
                *source_in,
                source_in + clip.duration as f64 / project.fps() * speed,
            )),
            _ => None,
        })
        .collect();
    let apart = (2.0 * project.fps()).round() as i64;
    for (index, (one, media, from, to)) in broll.iter().enumerate() {
        for (other, other_media, other_from, other_to) in broll.iter().skip(index + 1) {
            let overlap = to.min(*other_to) - from.max(*other_from);
            let gap = (other.start - one.end()).max(one.start - other.end());
            if media == other_media && overlap >= 1.0 && gap > apart {
                issues.push(json!({"kind":"repeated_broll", "clips":[one.id, other.id], "media":media, "seconds_shared":(overlap * 10.0).round() / 10.0}));
            }
        }
    }
    // Every transition is heard: one of the plan's transitions with no sound
    // from an audio file (not footage or voice-over) starting within half a
    // second of its middle, or a short one (a riser, a hit) across it.
    let heard: Vec<(i64, i64)> = project
        .clips
        .iter()
        .filter(|clip| clip.name.as_deref() != Some("Voice-over"))
        .filter_map(|clip| match &clip.content {
            ClipContent::Audio { media, .. } => project
                .media(media)
                .filter(|media| media.kind == edit_core::MediaKind::Audio)
                .map(|_| (clip.start, clip.end())),
            _ => None,
        })
        .collect();
    let near = (0.5 * project.fps()).round() as i64;
    let short = (4.0 * project.fps()).round() as i64;
    for clip in &project.clips {
        if matches!(clip.name.as_deref(), Some("Drop" | "Flash" | "Dip")) {
            let middle = clip.start + clip.duration / 2;
            if !heard.iter().any(|(start, end)| {
                (start - middle).abs() <= near
                    || (end - start <= short && *start <= middle && middle <= end + near)
            }) {
                issues.push(json!({"kind":"silent_transition", "clip":clip.id, "at":middle}));
            }
        }
    }
    // A subtitle runs past the cut it's said before: into a cut-in's
    // voice-over, or over the cut into another moment of footage.
    let voiceovers: Vec<(i64, i64)> = project
        .clips
        .iter()
        .filter(|clip| clip.name.as_deref() == Some("Voice-over"))
        .map(|clip| (clip.start, clip.end()))
        .collect();
    let footage: Vec<(&Clip, &str, f64, f64)> = project
        .clips
        .iter()
        .filter(|clip| Some(clip.track.as_str()) == base)
        .filter_map(|clip| match &clip.content {
            ClipContent::Video {
                media,
                source_in,
                speed,
                ..
            } => Some((clip, media.as_str(), *source_in, *speed)),
            _ => None,
        })
        .collect();
    for clip in &project.clips {
        if !clip
            .name
            .as_deref()
            .is_some_and(|name| name.starts_with("Subtitle"))
        {
            continue;
        }
        let into_voiceover = voiceovers
            .iter()
            .any(|(start, end)| clip.start < *end && *start < clip.end());
        let over_cut = footage
            .iter()
            .find(|(under, ..)| under.start <= clip.start && clip.start < under.end())
            .filter(|(under, ..)| clip.end() > under.end())
            .is_some_and(|(under, media, source_in, speed)| {
                // Carrying on in the same moment (a split, not a cut) is fine.
                let next_in = source_in + under.duration as f64 / project.fps() * speed;
                !footage.iter().any(|(next, next_media, next_source, _)| {
                    next.start == under.end()
                        && next_media == media
                        && (next_source - next_in).abs() * project.fps() < 2.0
                })
            });
        if into_voiceover || over_cut {
            issues.push(json!({"kind":"subtitle_past_cut", "clip":clip.id, "start":clip.start, "into": if into_voiceover {"cut-in"} else {"next shot"}}));
        }
    }
    // A review note left in on-screen text would be burned into the video.
    for clip in &project.clips {
        if let ClipContent::Text { text, .. } = &clip.content {
            let lower = text.to_lowercase();
            if [
                "[unclear",
                "[inaudible",
                "[crosstalk",
                "[?]",
                "???",
                "[unintelligible",
            ]
            .iter()
            .any(|note| lower.contains(note))
            {
                issues.push(json!({"kind":"placeholder_text", "clip":clip.id, "start":clip.start, "text":text}));
            }
        }
    }
    // A narration card with nothing over it is a black screen with words.
    let level = |track: &str| project.tracks.iter().position(|own| own.id == track);
    if let Some(script) = &project.script {
        for (number, card) in script
            .blocks
            .iter()
            .filter_map(|block| match block {
                edit_core::ScriptBlock::Narration { clip, .. } => Some(clip.as_deref()),
                _ => None,
            })
            .enumerate()
            .filter_map(|(number, card)| Some((number + 1, project.clip(card?)?)))
        {
            let base = level(&card.track);
            let mut cover: Vec<(i64, i64)> = project
                .clips
                .iter()
                .filter(|clip| {
                    matches!(clip.content, ClipContent::Video { .. })
                        && level(&clip.track) > base
                        && project
                            .track(&clip.track)
                            .is_some_and(|track| !track.hidden)
                })
                .map(|clip| (clip.start.max(card.start), clip.end().min(card.end())))
                .filter(|(start, end)| end > start)
                .collect();
            cover.sort_unstable();
            let (mut at, mut bare) = (card.start, 0);
            for (start, end) in cover {
                bare += (start - at).max(0);
                at = at.max(end);
            }
            bare += (card.end() - at).max(0);
            if bare >= 6 {
                issues.push(json!({"kind":"bare_card", "cut_in":number, "card":card.id, "uncovered_frames":bare}));
            }
        }
    }
    issues.sort_by_key(Value::to_string);
    json!({"issues":issues, "frames":project.duration(), "clips":project.clips.len()})
}

#[cfg(test)]
mod tests {
    use super::*;
    use edit_core::Settings;

    fn project() -> Project {
        Project::new(
            "p".into(),
            "plan".into(),
            Settings {
                width: 1920,
                height: 1080,
                fps: 30,
            },
        )
    }

    #[test]
    fn named_references_and_intermediate_overlaps() {
        let mut p = project();
        let result = apply(&mut p, &[
            json!({"op":"add", "as":"first", "clip":{"type":"solid", "track":"v1", "start":0, "duration":30, "fill":[0,0,0,1]}}),
            json!({"op":"add", "as":"next", "clip":{"type":"solid", "track":"v1", "start":0, "duration":30, "fill":[1,1,1,1]}}),
            json!({"op":"update", "select":{"ids":[{"$ref":"next"}]}, "patch":{"start":30}}),
        ]).unwrap();
        assert_eq!(p.clips.len(), 2);
        assert_eq!(result.results.len(), 3);
        assert_eq!(p.clips[1].start, 30);
        assert!(audit(&p)["issues"].as_array().unwrap().is_empty());
    }

    #[test]
    fn linked_halves_move_and_go_together_and_add_needs_times() {
        let mut p = project();
        apply(&mut p, &[
            json!({"op":"add", "as":"card", "clip":{"type":"solid", "track":"v1", "start":0, "duration":30, "fill":[0,0,0,1], "link":"l1"}}),
            json!({"op":"add", "as":"words", "clip":{"type":"solid", "track":"new", "start":0, "duration":30, "fill":[1,1,1,1], "link":"l1"}}),
        ]).unwrap();
        let card = p.clips[0].id.clone();
        apply(
            &mut p,
            &[json!({"op":"update", "select":{"ids":[card]}, "patch":{"start":10, "duration":20}})],
        )
        .unwrap();
        assert!(p
            .clips
            .iter()
            .all(|clip| clip.start == 10 && clip.duration == 20));
        let card = p.clips[0].id.clone();
        apply(&mut p, &[json!({"op":"delete", "select":{"ids":[card]}})]).unwrap();
        assert!(p.clips.is_empty());
        let missing = apply(
            &mut p,
            &[json!({"op":"add", "clip":{"type":"solid", "fill":[0,0,0,1]}})],
        );
        assert!(missing.err().unwrap().contains("clip.start is required"));
    }

    #[test]
    fn update_can_move_clips_to_a_new_track() {
        let mut p = project();
        apply(&mut p, &[
            json!({"op":"add", "as":"a", "clip":{"type":"solid", "track":"v1", "start":0, "duration":30, "fill":[0,0,0,1]}}),
            json!({"op":"update", "select":{"ids":[{"$ref":"a"}]}, "patch":{"track":"new"}}),
        ]).unwrap();
        assert_ne!(p.clips[0].track, "v1");
        assert!(p.track(&p.clips[0].track).is_some());
    }

    #[test]
    fn the_same_broll_moment_twice_is_flagged() {
        let mut p = project();
        p.media.push(serde_json::from_value(json!({"id":"m1","name":"f","path":"/f.mp4","kind":"video","duration":600.0,"width":1920,"height":1080,"has_audio":false})).unwrap());
        apply(&mut p, &[
            json!({"op":"add", "clip":{"type":"solid", "track":"v1", "start":0, "duration":900, "fill":[0,0,0,1]}}),
            // Two cuts of one moment, butted: one shot.
            json!({"op":"add", "clip":{"type":"video", "track":"new", "media":"m1", "source_in":10.0, "start":0, "duration":60}}),
            json!({"op":"add", "clip":{"type":"video", "track":"v2", "media":"m1", "source_in":11.0, "start":60, "duration":60}}),
            // The same moment again, later.
            json!({"op":"add", "clip":{"type":"video", "track":"v2", "media":"m1", "source_in":10.5, "start":600, "duration":90}}),
        ]).unwrap();
        let issues = audit(&p)["issues"].as_array().unwrap().clone();
        let repeated: Vec<_> = issues
            .iter()
            .filter(|issue| issue["kind"] == "repeated_broll")
            .collect();
        assert_eq!(repeated.len(), 2, "{issues:?}");
    }

    #[test]
    fn a_transition_without_a_sound_is_flagged() {
        let mut p = project();
        p.media.push(
            serde_json::from_value(
                json!({"id":"s1","name":"whoosh","path":"/w.wav","kind":"audio","duration":1.0}),
            )
            .unwrap(),
        );
        apply(&mut p, &[
            json!({"op":"add", "clip":{"type":"solid", "track":"v1", "start":0, "duration":300, "fill":[0,0,0,1]}}),
            json!({"op":"transition", "kind":"drop", "at":100}),
            json!({"op":"transition", "kind":"flash", "at":200}),
            json!({"op":"add", "clip":{"type":"audio", "media":"s1", "source_in":0.0, "start":98, "duration":30}}),
        ]).unwrap();
        let issues = audit(&p)["issues"].as_array().unwrap().clone();
        let silent: Vec<_> = issues
            .iter()
            .filter(|issue| issue["kind"] == "silent_transition")
            .collect();
        assert_eq!(silent.len(), 1, "{issues:?}");
        assert_eq!(silent[0]["at"], 200);
    }

    #[test]
    fn a_subtitle_past_its_cut_is_flagged() {
        let mut p = project();
        p.media.push(serde_json::from_value(json!({"id":"m1","name":"f","path":"/f.mp4","kind":"video","duration":600.0,"width":1920,"height":1080,"has_audio":false})).unwrap());
        apply(&mut p, &[
            // A cut: 0–100 from 10 s, then 100–200 from 50 s.
            json!({"op":"add", "clip":{"type":"video", "track":"v1", "media":"m1", "source_in":10.0, "start":0, "duration":100}}),
            json!({"op":"add", "clip":{"type":"video", "track":"v1", "media":"m1", "source_in":50.0, "start":100, "duration":100}}),
            // A split: 200–300 carries straight on from 300 (50 s + 100 frames).
            json!({"op":"add", "clip":{"type":"video", "track":"v1", "media":"m1", "source_in":53.333333, "start":200, "duration":100}}),
            json!({"op":"add", "clip":{"type":"text", "track":"new", "name":"Subtitle · A", "start":80, "duration":30, "text":"over the cut"}}),
            json!({"op":"add", "clip":{"type":"text", "track":"new", "name":"Subtitle · A", "start":180, "duration":30, "text":"over the split"}}),
        ]).unwrap();
        let issues = audit(&p)["issues"].as_array().unwrap().clone();
        let past: Vec<_> = issues
            .iter()
            .filter(|issue| issue["kind"] == "subtitle_past_cut")
            .collect();
        assert_eq!(past.len(), 1, "{issues:?}");
        assert_eq!(past[0]["start"], 80);
    }

    #[test]
    fn an_evidence_board_holds_and_glides_between_photos() {
        let mut p = project();
        for id in ["m1", "m2", "m3"] {
            p.media.push(serde_json::from_value(json!({"id":id,"name":id,"path":"/p.jpg","kind":"image","duration":30.0,"width":1200,"height":900})).unwrap());
        }
        let result = apply(
            &mut p,
            &[json!({"op":"evidence_board", "start":0, "items":[
                {"media":"m1", "label":"accident?", "frames":60},
                {"media":"m2", "label":"arson?", "frames":60},
                {"media":"m3", "frames":60},
            ]})],
        )
        .unwrap();
        // Paper, three photos, two notes, the vignette.
        assert_eq!(p.clips.len(), 7);
        assert_eq!(result.results[0]["end"], 60 * 3 + 22 * 2);
        let photo = p
            .clips
            .iter()
            .find(|clip| clip.name.as_deref() == Some("Evidence board · photo 2"))
            .unwrap();
        // On screen in the middle once the camera has arrived there (drifting a little).
        let x = &photo.keyframes["x"];
        let arrived = x.iter().find(|key| key.frame as i64 == 60 + 22).unwrap();
        assert!(arrived.value.abs() < 40.0, "{arrived:?}");
        let note = p
            .clips
            .iter()
            .find(|clip| clip.name.as_deref() == Some("Evidence board · note 2"))
            .unwrap();
        assert_eq!(note.start, 60 + 22 + 8);
        assert!(
            audit(&p)["issues"].as_array().unwrap().is_empty(),
            "{:?}",
            audit(&p)
        );
    }

    #[test]
    fn review_notes_on_screen_are_flagged() {
        let mut p = project();
        apply(&mut p, &[
            json!({"op":"add", "clip":{"type":"solid", "track":"v1", "start":0, "duration":60, "fill":[0,0,0,1]}}),
            json!({"op":"add", "clip":{"type":"text", "track":"new", "start":0, "duration":30, "text":"Go to the [unclear]"}}),
            json!({"op":"add", "clip":{"type":"text", "track":"new", "start":30, "duration":30, "text":"Go to the store"}}),
        ]).unwrap();
        let issues = audit(&p)["issues"].as_array().unwrap().clone();
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert_eq!(issues[0]["kind"], "placeholder_text");
    }

    #[test]
    fn transitions_are_built_the_house_way() {
        let mut p = project();
        apply(&mut p, &[
            json!({"op":"add", "clip":{"type":"solid", "track":"v1", "start":0, "duration":300, "fill":[0,0,0,1]}}),
            json!({"op":"transition", "kind":"open"}),
            json!({"op":"transition", "kind":"dip", "at":100}),
            json!({"op":"transition", "kind":"drop", "at":200}),
            json!({"op":"transition", "kind":"flash", "at":2}),
        ]).unwrap();
        let named = |name: &str| {
            p.clips
                .iter()
                .find(|clip| clip.name.as_deref() == Some(name))
                .unwrap()
        };
        assert_eq!(
            (named("Opening dip").start, named("Opening dip").duration),
            (0, 15)
        );
        assert_eq!((named("Dip").start, named("Dip").duration), (94, 12));
        assert_eq!(named("Dip").keyframes["opacity"].len(), 3);
        assert_eq!((named("Drop").start, named("Drop").duration), (197, 6));
        // Cut off at the start of the video.
        assert_eq!((named("Flash").start, named("Flash").duration), (0, 5));
        assert!(apply(&mut p, &[json!({"op":"transition", "kind":"dip"})]).is_err());
    }

    #[test]
    fn unresolved_reference_and_bad_final_state_fail() {
        let mut p = project();
        assert!(apply(
            &mut p,
            &[json!({"op":"delete", "select":{"ids":[{"$ref":"missing"}]}})]
        )
        .is_err());
        assert!(apply(&mut p, &[json!({"op":"add", "clip":{"type":"solid", "start":0, "duration":0, "fill":[0,0,0,1]}})]).is_err());
    }

    #[test]
    fn rejected_plan_leaves_disk_revision_and_events_untouched() {
        let home = std::env::temp_dir().join(format!(
            "edit-plan-{}-{}",
            std::process::id(),
            crate::store::now_ms()
        ));
        let store = crate::store::Store::open(home.clone()).unwrap();
        let live = store.create("atomic", Default::default()).unwrap();
        let mut events = store.subscribe();
        let before = std::fs::read(
            home.join("projects")
                .join(format!("{}.json", live.project.id)),
        )
        .unwrap();
        let result = store.update(&live.project.id, "test", |project| apply(project, &[
            json!({"op":"add", "clip":{"type":"solid", "start":0, "duration":30, "fill":[0,0,0,1]}}),
            json!({"op":"update", "select":{"track":4}, "patch":{"duration":60}}),
        ]));
        assert!(result.is_err());
        assert_eq!(store.get(&live.project.id).unwrap().rev, live.rev);
        assert!(events.try_recv().is_err());
        assert_eq!(
            std::fs::read(
                home.join("projects")
                    .join(format!("{}.json", live.project.id))
            )
            .unwrap(),
            before
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn one_plan_commits_once_and_stale_retry_cannot_duplicate_it() {
        let home = std::env::temp_dir().join(format!(
            "edit-plan-retry-{}-{}",
            std::process::id(),
            crate::store::now_ms()
        ));
        let store = crate::store::Store::open(home.clone()).unwrap();
        let live = store.create("atomic", Default::default()).unwrap();
        let mut events = store.subscribe();
        let mut project = live.project.clone();
        apply(&mut project, &[
            json!({"op":"add", "clip":{"type":"solid", "start":0, "duration":30, "fill":[0,0,0,1]}}),
            json!({"op":"add", "clip":{"type":"solid", "start":30, "duration":30, "fill":[0,0,0,1]}}),
        ]).unwrap();
        let saved = store
            .replace(&project.id, Some(live.rev), project.clone(), "test")
            .unwrap_or_else(|_| panic!("valid plan"));
        assert_eq!(saved.rev, live.rev + 1);
        assert!(events.try_recv().is_ok());
        assert!(events.try_recv().is_err());
        assert!(matches!(
            store.replace(&project.id, Some(live.rev), project.clone(), "test"),
            Err(crate::store::UpdateError::Conflict(_))
        ));
        assert_eq!(store.get(&project.id).unwrap().project.clips.len(), 2);
        std::fs::remove_dir_all(home).unwrap();
    }
}
