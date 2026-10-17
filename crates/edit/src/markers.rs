//! Marked moments the agent plans sounds on: a moment of a source (a door
//! slamming at 12.4 s of the bodycam) is a media marker, so it stays on the
//! moment however the clips showing it move; a moment of the edit itself (a
//! photo landing on an evidence board) is a timeline marker. Sounds are then
//! placed on the marks by name (add_sound_effect / add_from_library `markers`).

use edit_core::{ClipContent, Marker, Project, TimelineMarker};
use serde_json::{json, Value};

/// A sound effect's own markers ("hit") are part of the file, not plans.
fn is_sound_hit(media: &edit_core::Media, marker: &Marker) -> bool {
    media.kind == edit_core::MediaKind::Audio && marker.name == crate::sfx::HIT
}

fn same(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// Adds and removes markers: `{add: [...], remove: [...]}`.
/// - add `{name, note?, frame}`: on the timeline at that frame;
/// - add `{name, note?, media, time}`: on a media at source seconds;
/// - add `{name, note?, clip, frame}`: on that clip's media, at the source
///   moment the clip shows at timeline `frame` (it moves with that moment).
///
/// A marker of the same name within a frame (or 1/30 s) of a new one is
/// replaced. remove `{name?, media?, frame?}` (at least one) removes every
/// marker matching all given. Returns what changed and the markers now set.
pub fn edit(project: &mut Project, args: &Value) -> Result<Value, String> {
    let fps = project.fps();
    let mut added = Vec::new();
    let mut removed = 0;
    for (index, item) in args["remove"].as_array().into_iter().flatten().enumerate() {
        let name = item["name"].as_str();
        let media = item["media"].as_str();
        let frame = item["frame"].as_i64();
        if name.is_none() && media.is_none() && frame.is_none() {
            return Err(format!("remove {}: give name, media or frame", index + 1));
        }
        let wanted = |own: &str| name.is_none_or(|name| same(name, own));
        if media.is_none() {
            let before = project.markers.len();
            project.markers.retain(|marker| {
                !(wanted(&marker.name) && frame.is_none_or(|at| at == marker.frame))
            });
            removed += before - project.markers.len();
        }
        if frame.is_none() {
            for own in project
                .media
                .iter_mut()
                .filter(|own| media.is_none_or(|media| own.id == media))
            {
                let before = own.markers.len();
                let sound = own.kind == edit_core::MediaKind::Audio;
                own.markers.retain(|marker| {
                    // A sound's hit goes only when asked for by its media.
                    let hit = sound && marker.name == crate::sfx::HIT && media.is_none();
                    hit || !wanted(&marker.name)
                });
                removed += before - own.markers.len();
            }
        }
    }
    for (index, item) in args["add"].as_array().into_iter().flatten().enumerate() {
        let fail = |what: &str| format!("add {}: {what}", index + 1);
        let name = item["name"]
            .as_str()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| fail("name is required (\"door slam\")"))?
            .to_owned();
        let note = item["note"].as_str().unwrap_or_default().trim().to_owned();
        let on_media = match (item["media"].as_str(), item["clip"].as_str()) {
            (Some(media), _) => Some((
                media.to_owned(),
                item["time"]
                    .as_f64()
                    .filter(|time| time.is_finite() && *time >= 0.0)
                    .ok_or_else(|| fail("time (source seconds) is required with media"))?,
            )),
            (None, Some(clip)) => {
                let frame = item["frame"]
                    .as_i64()
                    .ok_or_else(|| fail("frame (timeline) is required with clip"))?;
                let clip = project
                    .clip(clip)
                    .ok_or_else(|| fail(&format!("no clip {clip}")))?;
                let (ClipContent::Video {
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
                }) = &clip.content
                else {
                    return Err(fail("clip must be a video, image or audio clip"));
                };
                if !clip.contains(frame) {
                    return Err(fail(&format!(
                        "frame {frame} is outside clip {} [{}, {})",
                        clip.id,
                        clip.start,
                        clip.end()
                    )));
                }
                Some((
                    media.clone(),
                    source_in + (frame - clip.start) as f64 / fps * speed,
                ))
            }
            (None, None) => None,
        };
        match on_media {
            Some((media_id, time)) => {
                let media = project
                    .media
                    .iter_mut()
                    .find(|media| media.id == media_id)
                    .ok_or_else(|| fail(&format!("no media {media_id}")))?;
                if media.kind != edit_core::MediaKind::Image && time > media.duration + 0.05 {
                    return Err(fail(&format!(
                        "time {time:.2} is past the end of {media_id} ({:.2} s)",
                        media.duration
                    )));
                }
                media.markers.retain(|marker| {
                    !(same(&marker.name, &name) && (marker.time - time).abs() < 1.0 / 30.0)
                });
                media.markers.push(Marker {
                    time,
                    name: name.clone(),
                    note,
                });
                media.markers.sort_by(|a, b| a.time.total_cmp(&b.time));
                added.push(json!({"name": name, "media": media_id, "time": (time * 100.0).round() / 100.0}));
            }
            None => {
                let frame = item["frame"]
                    .as_i64()
                    .filter(|frame| *frame >= 0)
                    .ok_or_else(|| {
                        fail("frame (timeline, from 0) is required, or media and time")
                    })?;
                add_timeline(project, frame, &name, &note);
                added.push(json!({"name": name, "frame": frame}));
            }
        }
    }
    if added.is_empty() && removed == 0 && args["add"].is_null() && args["remove"].is_null() {
        return Err("give add and/or remove".to_owned());
    }
    Ok(json!({"added": added, "removed": removed, "markers": listing(project, None)}))
}

/// Sets a timeline marker (one of the same name within a frame is replaced).
pub fn add_timeline(project: &mut Project, frame: i64, name: &str, note: &str) {
    project
        .markers
        .retain(|marker| !(same(&marker.name, name) && (marker.frame - frame).abs() <= 1));
    project.markers.push(TimelineMarker {
        frame,
        name: name.to_owned(),
        note: note.to_owned(),
    });
    project.markers.sort_by_key(|marker| marker.frame);
}

/// Where a media's moment at `time` shows on the timeline: one frame per
/// clip of it playing that moment (picture and its sound count once).
fn shown_at(project: &Project, media_id: &str, time: f64) -> Vec<i64> {
    let fps = project.fps();
    let mut frames: Vec<i64> = project
        .clips
        .iter()
        .filter_map(|clip| match &clip.content {
            ClipContent::Video {
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
            } if media == media_id && *speed > 0.0 => {
                let frame = clip.start + ((time - source_in) / speed * fps).round() as i64;
                clip.contains(frame).then_some(frame)
            }
            _ => None,
        })
        .collect();
    frames.sort_unstable();
    frames.dedup();
    frames
}

/// The timeline frames a marker name stands for: its timeline markers, and
/// every place a clip shows a media marker of that name.
pub fn frames(project: &Project, name: &str) -> Vec<i64> {
    let mut frames: Vec<i64> = project
        .markers
        .iter()
        .filter(|marker| same(&marker.name, name))
        .map(|marker| marker.frame)
        .collect();
    for media in &project.media {
        for marker in media
            .markers
            .iter()
            .filter(|marker| same(&marker.name, name) && !is_sound_hit(media, marker))
        {
            frames.extend(shown_at(project, &media.id, marker.time));
        }
    }
    frames.sort_unstable();
    frames.dedup();
    frames
}

/// Timeline seconds for each marker name (for placing sounds on them); an
/// unknown name is an error listing the names there are.
pub fn times(project: &Project, names: &[String]) -> Result<Vec<f64>, String> {
    let mut out = Vec::new();
    for name in names {
        let found = frames(project, name);
        if found.is_empty() {
            let mut known: Vec<String> = project
                .markers
                .iter()
                .map(|marker| marker.name.clone())
                .chain(project.media.iter().flat_map(|media| {
                    media
                        .markers
                        .iter()
                        .filter(|marker| !is_sound_hit(media, marker))
                        .map(|marker| marker.name.clone())
                }))
                .collect();
            known.sort();
            known.dedup();
            return Err(format!(
                "no marker named \"{name}\" on the timeline or shown by a clip; markers: {}",
                if known.is_empty() {
                    "none (set them with markers add)".to_owned()
                } else {
                    known.join(", ")
                }
            ));
        }
        out.extend(found.iter().map(|frame| *frame as f64 / project.fps()));
    }
    Ok(out)
}

/// Every marker in one line each: `name@frame` (timeline) and
/// `name media@seconds → frames` (a source's, where clips show it), notes in
/// brackets, within `span` (frames) when given.
pub fn listing(project: &Project, span: Option<(i64, i64)>) -> Vec<String> {
    let inside = |frame: i64| span.is_none_or(|(from, to)| frame >= from && frame < to);
    let note = |note: &str| {
        if note.is_empty() {
            String::new()
        } else {
            format!(" ({note})")
        }
    };
    let mut rows: Vec<(i64, String)> = project
        .markers
        .iter()
        .filter(|marker| inside(marker.frame))
        .map(|marker| {
            (
                marker.frame,
                format!("{}@{}{}", marker.name, marker.frame, note(&marker.note)),
            )
        })
        .collect();
    for media in &project.media {
        for marker in &media.markers {
            if is_sound_hit(media, marker) {
                continue;
            }
            let shown: Vec<i64> = shown_at(project, &media.id, marker.time)
                .into_iter()
                .filter(|frame| inside(*frame))
                .collect();
            if span.is_some() && shown.is_empty() {
                continue;
            }
            let at = shown.first().copied().unwrap_or(i64::MAX);
            let frames = if shown.is_empty() {
                "not on the timeline".to_owned()
            } else {
                shown
                    .iter()
                    .map(i64::to_string)
                    .collect::<Vec<_>>()
                    .join(",")
            };
            rows.push((
                at,
                format!(
                    "{} {}@{:.2}s → {frames}{}",
                    marker.name,
                    media.id,
                    marker.time,
                    note(&marker.note)
                ),
            ));
        }
    }
    rows.sort_by_key(|(at, _)| *at);
    rows.into_iter().map(|(_, row)| row).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use edit_core::Settings;

    fn project() -> Project {
        let mut p = Project::new(
            "p".into(),
            "markers".into(),
            Settings {
                width: 1920,
                height: 1080,
                fps: 30,
            },
        );
        p.media.push(serde_json::from_value(json!({"id":"m1","name":"bodycam","path":"/b.mp4","kind":"video","duration":600.0,"width":1920,"height":1080,"has_audio":true})).unwrap());
        p.media.push(serde_json::from_value(json!({"id":"s1","name":"shutter","path":"/s.wav","kind":"audio","duration":0.2,"markers":[{"time":0.08,"name":"hit"}]})).unwrap());
        // 10 s of the bodycam from 100 s, then the same file again from 200 s at half speed.
        p.clips.push(serde_json::from_value(json!({"id":"c1","track":"v1","type":"video","media":"m1","source_in":100.0,"start":0,"duration":300})).unwrap());
        p.clips.push(serde_json::from_value(json!({"id":"c2","track":"v2","type":"video","media":"m1","source_in":200.0,"speed":0.5,"start":600,"duration":300})).unwrap());
        p
    }

    #[test]
    fn markers_on_sources_follow_their_clips_and_timeline_ones_stay_put() {
        let mut p = project();
        edit(
            &mut p,
            &json!({"add":[
                {"name":"door slam","note":"the back door","clip":"c1","frame":120},
                {"name":"camera flash","media":"m1","time":202.0},
                {"name":"photo lands","frame":700},
            ]}),
        )
        .unwrap();
        p.validate().unwrap();
        // 100 s + 120 frames = 104 s of the source.
        assert!((p.media[0].markers[0].time - 104.0).abs() < 1e-9);
        assert_eq!(frames(&p, "Door Slam"), vec![120]);
        // 202 s is 2 s into c2, at half speed: 4 s = 120 frames after 600.
        assert_eq!(frames(&p, "camera flash"), vec![720]);
        assert_eq!(
            times(&p, &["photo lands".into()]).unwrap(),
            vec![700.0 / 30.0]
        );
        // Moving the clip moves the mark with it.
        p.clips[0].start = 30;
        assert_eq!(frames(&p, "door slam"), vec![150]);
        let rows = listing(&p, None);
        assert_eq!(rows.len(), 3, "{rows:?}");
        assert!(
            rows[0].starts_with("door slam m1@104.00s → 150 (the back door)"),
            "{rows:?}"
        );
        assert!(times(&p, &["nothing".into()])
            .unwrap_err()
            .contains("door slam"));
        // A sound's own hit is never listed nor removed by name alone.
        edit(
            &mut p,
            &json!({"remove":[{"name":"hit"},{"name":"door slam"},{"frame":700}]}),
        )
        .unwrap();
        assert_eq!(p.media[1].markers.len(), 1);
        assert_eq!(listing(&p, None).len(), 1);
        assert!(p.markers.is_empty());
        assert!(edit(
            &mut p,
            &json!({"add":[{"name":"x","clip":"c1","frame":5000}]})
        )
        .is_err());
    }

    #[test]
    fn ripples_carry_timeline_markers() {
        let mut p = project();
        add_timeline(&mut p, 700, "photo lands", "");
        edit_core::remove_time(&mut p, 0, 60);
        assert_eq!(p.markers[0].frame, 640);
    }
}
