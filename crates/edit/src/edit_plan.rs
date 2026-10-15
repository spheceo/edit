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
            let start = fields.get("start").and_then(Value::as_i64).unwrap_or(0);
            let end =
                start.saturating_add(fields.get("duration").and_then(Value::as_i64).unwrap_or(1));
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
            let patch = args["patch"].as_object().ok_or("patch must be an object")?;
            for clip in project
                .clips
                .iter_mut()
                .filter(|clip| ids.contains(&clip.id))
            {
                let mut value = serde_json::to_value(&*clip).map_err(|error| error.to_string())?;
                crate::mcp::merge(&mut value, &Value::Object(patch.clone()));
                value
                    .as_object_mut()
                    .ok_or("patched clip must be an object")?
                    .insert("id".to_owned(), json!(clip.id));
                *clip = serde_json::from_value(value).map_err(|error| format!("clip: {error}"))?;
            }
            Ok(json!({"clips": ids}))
        }
        "delete" => {
            let ids = selected(project, &args["select"])?;
            project.clips.retain(|clip| !ids.contains(&clip.id));
            Ok(json!({"clips": ids}))
        }
        "keyframes" => {
            let ids = selected(project, &args["select"])?;
            let param = args["param"].as_str().ok_or("param is required")?;
            let mut keys: Vec<Keyframe> = serde_json::from_value(args["keyframes"].clone())
                .map_err(|error| format!("keyframes: {error}"))?;
            keys.sort_by(|a, b| a.frame.total_cmp(&b.frame));
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
        other => Err(format!(
            "unknown op {other}; use add, update, delete, keyframes, cover_cut_in, tidy_tracks"
        )),
    }
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
