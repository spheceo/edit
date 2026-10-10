//! MCP (streamable HTTP, JSON responses) so Codex / Claude Code can edit.
//! Every mutation goes through the store, so the open UI updates live.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine as _;
use edit_core::{
    animatable_params, Clip, ClipColor, ClipContent, Keyframe, Project, TextAnimation, TextStyle,
    TrackKind, Transform,
};
use serde_json::{json, Value};

use crate::render::{encode_png, tile};
use crate::server::App;

const ORIGIN: &str = "agent";

pub const INSTRUCTIONS: &str = r#"Edit is a local video editor. Tools edit the project the user has open (pass project_id to target another). Changes appear live in their UI and are undoable there.

Model (JSON):
- settings: {width, height, fps}. Timeline times (clip.start, clip.duration, fade_in, fade_out, keyframe.frame) are integer FRAMES at settings.fps. source_in is SECONDS into the media.
- tracks: video tracks composite in list order (first = bottom, label V1); audio tracks mix. A track holds non-overlapping clips. Video-type clips go on video tracks; audio clips on audio tracks.
- clip: {id, track, start, duration, color (blue|cyan|green|yellow|orange|red|purple|pink), link?, fade_in, fade_out, keyframes, type, ...}
  - type "video": media, source_in, speed (0.05..20), transform {x, y (px from frame centre, y down), scale (1 = fit frame), rotation (deg clockwise), shake (px of handheld camera wobble, 0 = still)}, opacity 0..1
  - type "audio": media, source_in, speed, volume_db
  - type "text": text (\n for lines), style {font "Geist" (weight 400|500|600|700|900) or "Montserrat" (600 only), size px, color [r,g,b,a] 0..1, tracking px, line_height, glow {enabled (default true), color [r,g,b,a] or null = text colour (default null), radius = blur px (default 46), strength = opacity 0..1 (default 0.5)}, optional max_width px (wrap lines), optional background {color, opacity (0.75), pad_x (12), pad_y (8)} = a box behind the lines, optional shadow {color, opacity (0.65), distance px (3), angle degrees clockwise from up (112), size px (6), blur px (8)}}. Subtitle house style (at 1080p; scale by height/1080): Montserrat 600, size 48, line_height 1.15, glow default, max_width = 0.8*width - 24, background and shadow at their defaults, transform.y = 0.4*height, animation none, transform (as video, shake included), animation {preset none|fade|rise|pop|typewriter|words, duration frames, stagger frames}, opacity, word_times (frames from the clip start at which each word appears, for preset "words": words pop in one at a time, no motion, synced to speech; without word_times one every `stagger` frames)
  - type "adjustment": grade {exposure stops, contrast -1..1, saturation -1..1, temperature -1..1, vignette 0..1}, opacity — grades everything below it
  - type "solid": fill [r,g,b,a], opacity — flashes, dips to black
- script (optional): the script the edit follows, imported from a Google Doc: {source, blocks: [{kind "footage", url, file (Drive id), start, end (SECONDS of that file), label, notes, media?, clip?} | {kind "narration", text, notes, clip?}]}. Each block's clip is the timeline clip it became. Narration plays as a cut-in: a black solid on one video track with the text on the track above, linked, until a voice-over replaces it. Notes are the Doc's comments (editor notes such as "blur the victim", and first....last words of a range).
- keyframes: {param: [{frame (relative to clip start), value, ease linear|in_out|in|out|hold (preset for the segment to the next key), optional handle_in / handle_out {speed = value units per frame at the key, influence 0..1 of the segment} = After Effects-style bezier handles that override the preset at that end}]}. Animatable params: video x,y,scale,rotation,shake,opacity; text also size,tracking,glow.radius,glow.strength; adjustment exposure,contrast,saturation,temperature,vignette,opacity; solid opacity; audio volume_db.
Linked clips (same link id) are picture+sound of one source; keep them aligned when moving.
Look at your work with render_frame / contact_sheet before telling the user it is done.

House editing style (videos cut from a script of police footage):
- The INTRO is everything before the first cut-in. It's the hook, and where the treatment goes:
  - Speaker captions on what's said: run caption_speakers (it works out who speaks each line by watching and listening, then places word-by-word captions in the house box style by that person, above their head when there's room, else just below their face or redaction box, tracked to them with a little shake). Check a few with render_frame and fix any that sit on the wrong person.
  - Punch-ins on reactions and key lines: scale keyframes from 1 to about 1.08–1.15 over a few frames, centred on the face (move x/y too).
  - B-roll over cuts: while someone keeps talking, lay a different shot (another moment of the footage, the scene, the other person reacting) on a video track above for 1–3 s as picture only; the sound underneath carries on. Prefer moments the transcript or the Doc's notes point to.
  - Quick white flashes or dips on hard scene changes, sparingly.
- CUT-INS (the black narration cards) may carry stylised text and graphics.
- AFTER THE INTRO the video is the full footage: keep it clean. No captions or effects on footage there; only work on cut-ins and do what the Doc's notes ask (for example blur a face).
- Redactions in the footage are deliberate; never cover or move them.
- track_region pins anything (text, an overlay) to a moving face or object."#;

pub async fn reject_get() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, "POST JSON-RPC to /mcp").into_response()
}

/// `?project=<id>` pins every tool call to one project (Edit's own agent chats use this).
#[derive(serde::Deserialize, Default)]
pub struct Scope {
    project: Option<String>,
}

pub async fn handle(
    State(app): State<App>,
    axum::extract::Query(scope): axum::extract::Query<Scope>,
    Json(body): Json<Value>,
) -> Response {
    let scope = scope.project.as_deref();
    if let Some(batch) = body.as_array() {
        let mut out = Vec::new();
        for message in batch {
            if let Some(reply) = dispatch(&app, message, scope).await {
                out.push(reply);
            }
        }
        return if out.is_empty() {
            StatusCode::ACCEPTED.into_response()
        } else {
            Json(Value::Array(out)).into_response()
        };
    }
    match dispatch(&app, &body, scope).await {
        Some(reply) => Json(reply).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

async fn dispatch(app: &App, message: &Value, scope: Option<&str>) -> Option<Value> {
    let id = message.get("id").cloned()?;
    let method = message["method"].as_str().unwrap_or_default();
    let params = &message["params"];
    let result = match method {
        "initialize" => {
            let requested = params["protocolVersion"].as_str().unwrap_or("2025-06-18");
            let supported = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
            let version = if supported.contains(&requested) {
                requested
            } else {
                supported[1]
            };
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "edit", "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or_default();
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            Ok(match call(app, name, &args, scope).await {
                Ok(content) => json!({ "content": content, "isError": false }),
                Err(error) => {
                    json!({ "content": [{ "type": "text", "text": error }], "isError": true })
                }
            })
        }
        _ => Err(json!({ "code": -32601, "message": format!("unknown method {method}") })),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    })
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    let mut properties = properties;
    properties["project_id"] =
        json!({ "type": "string", "description": "Defaults to the project open in the UI." });
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required },
    })
}

fn tools() -> Vec<Value> {
    vec![
        tool("list_projects", "List projects on this machine.", json!({}), &[]),
        tool("get_project", "The full project JSON plus track labels and duration. Read this before editing.", json!({}), &[]),
        tool(
            "add_text",
            "Add a text clip. Times in seconds. Picks a free video track above existing clips unless track is given.",
            json!({
                "text": { "type": "string" },
                "start": { "type": "number", "description": "Seconds." },
                "duration": { "type": "number", "description": "Seconds." },
                "track": { "type": "string", "description": "Track id (optional)." },
                "style": { "type": "object", "description": "Partial TextStyle." },
                "animation": { "type": "object", "description": "TextAnimation." },
                "transform": { "type": "object" },
                "color": { "type": "string", "description": "Timeline label colour." }
            }),
            &["text", "start", "duration"],
        ),
        tool(
            "add_clip",
            "Add any clip (video/audio/text/adjustment/solid) using the model in the server instructions. Omit id. If track is omitted a free track of the right kind is chosen (created if needed).",
            json!({ "clip": { "type": "object" } }),
            &["clip"],
        ),
        tool(
            "update_clip",
            "Change a clip with a JSON merge patch (RFC 7386), e.g. {\"start\": 90, \"style\": {\"glow\": {\"enabled\": true}}}. Set a key to null to remove it.",
            json!({ "clip_id": { "type": "string" }, "patch": { "type": "object" } }),
            &["clip_id", "patch"],
        ),
        tool(
            "delete_clips",
            "Delete clips by id.",
            json!({ "clip_ids": { "type": "array", "items": { "type": "string" } } }),
            &["clip_ids"],
        ),
        tool(
            "set_keyframes",
            "Replace one parameter's keyframes on a clip. Frames are relative to the clip start. Empty list removes the animation.",
            json!({
                "clip_id": { "type": "string" },
                "param": { "type": "string" },
                "keyframes": { "type": "array", "items": { "type": "object", "properties": {
                    "frame": { "type": "number" }, "value": { "type": "number" },
                    "ease": { "type": "string", "enum": ["linear", "in_out", "in", "out", "hold"] },
                    "handle_in": { "type": "object", "properties": { "speed": { "type": "number" }, "influence": { "type": "number" } }, "required": ["speed", "influence"] },
                    "handle_out": { "type": "object", "properties": { "speed": { "type": "number" }, "influence": { "type": "number" } }, "required": ["speed", "influence"] }
                }, "required": ["frame", "value"] } }
            }),
            &["clip_id", "param", "keyframes"],
        ),
        tool(
            "import_media",
            "Import media files by absolute path. place=true also appends them to the end of the timeline.",
            json!({ "paths": { "type": "array", "items": { "type": "string" } }, "place": { "type": "boolean" } }),
            &["paths"],
        ),
        tool(
            "read_transcript",
            "What is said on the timeline, with timeline times in seconds, grouped into phrases. Only audio clips whose media has been transcribed appear; use `transcribe` first.",
            json!({}),
            &[],
        ),
        tool(
            "transcribe",
            "Transcribe a media item's speech (word timings). Costs money and runs once per file; check get_project's media first. Poll read_transcript afterwards.",
            json!({ "media_id": { "type": "string" } }),
            &["media_id"],
        ),
        tool(
            "render_frame",
            "Render one frame exactly as it will export and return it as an image. Give time (seconds) or frame.",
            json!({ "time": { "type": "number" }, "frame": { "type": "integer" }, "max_size": { "type": "integer", "description": "Longest side in px (default 960)." } }),
            &[],
        ),
        tool(
            "contact_sheet",
            "Render evenly spaced frames between start and end (seconds) into one grid image, to review motion or many moments at once.",
            json!({
                "start": { "type": "number" }, "end": { "type": "number" },
                "count": { "type": "integer", "description": "Frames, max 24 (default 12)." },
                "columns": { "type": "integer", "description": "Default 4." }
            }),
            &["start", "end"],
        ),
        tool(
            "caption_speakers",
            "Speaker captions for intro footage: splits what's said into lines, asks a vision model (Luna) who says each line and where they are (stills + sound), then adds a word-by-word caption per line in the house box style beside its speaker, tracked to their face with a little shake. Replaces captions it made before in that span. Takes a few minutes. Defaults to the intro (start to the first cut-in).",
            json!({
                "start": { "type": "number", "description": "Seconds on the timeline (default 0)." },
                "end": { "type": "number", "description": "Seconds on the timeline (default: the first cut-in)." }
            }),
            &[],
        ),
        tool(
            "track_region",
            "Track a box in the footage (a face, a redaction block, an object) and make a clip follow it: bakes x/y keyframes onto `follow` so it stays above, below or on the box. Give the box as it appears at `time` in project pixels from the top-left of the frame (as render_frame shows it, scaled to the project size).",
            json!({
                "time": { "type": "number", "description": "Timeline seconds where the box is as given." },
                "box": { "type": "array", "items": { "type": "number" }, "description": "[x0, y0, x1, y1] in project pixels from the top-left." },
                "follow": { "type": "string", "description": "Clip id to move with it (text or video)." },
                "place": { "type": "string", "enum": ["above", "below", "on"], "description": "Where the clip sits relative to the box (default on)." }
            }),
            &["time", "box", "follow"],
        ),
        tool(
            "export",
            "Export the project to an MP4 (H.264 + AAC). Progress shows in the UI.",
            json!({ "path": { "type": "string", "description": "Output .mp4 path (default ~/Movies/Edit/<name>.mp4)." } }),
            &[],
        ),
    ]
}

fn text(value: impl Into<String>) -> Value {
    json!([{ "type": "text", "text": value.into() }])
}

fn image(png: &[u8], caption: String) -> Value {
    json!([
        { "type": "image", "data": base64::engine::general_purpose::STANDARD.encode(png), "mimeType": "image/png" },
        { "type": "text", "text": caption }
    ])
}

async fn call(app: &App, name: &str, args: &Value, scope: Option<&str>) -> Result<Value, String> {
    let store = &app.store;
    if name == "list_projects" {
        return Ok(text(
            serde_json::to_string_pretty(&store.list()).unwrap_or_default(),
        ));
    }
    // A scoped connection only ever touches its own project.
    let id = match scope {
        Some(project) => store.resolve(Some(project))?,
        None => store.resolve(args["project_id"].as_str())?,
    };
    match name {
        "get_project" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let project = &live.project;
            let labels: serde_json::Map<String, Value> = project
                .tracks
                .iter()
                .map(|track| (track.id.clone(), json!(project.track_label(&track.id))))
                .collect();
            Ok(text(
                serde_json::to_string_pretty(&json!({
                    "rev": live.rev,
                    "duration_frames": project.duration(),
                    "duration_seconds": project.duration() as f64 / project.fps(),
                    "track_labels": labels,
                    "project": project,
                }))
                .unwrap_or_default(),
            ))
        }
        "add_text" => {
            let fps = store.get(&id).ok_or("project vanished")?.project.fps();
            let start = (args["start"].as_f64().ok_or("start is required")? * fps).round() as i64;
            let duration =
                ((args["duration"].as_f64().ok_or("duration is required")? * fps).round() as i64)
                    .max(1);
            let mut style = serde_json::to_value(TextStyle::default()).unwrap_or_default();
            merge(&mut style, &args["style"]);
            let style: TextStyle =
                serde_json::from_value(style).map_err(|error| format!("style: {error}"))?;
            let mut animation = serde_json::to_value(TextAnimation::default()).unwrap_or_default();
            merge(&mut animation, &args["animation"]);
            let animation: TextAnimation =
                serde_json::from_value(animation).map_err(|error| format!("animation: {error}"))?;
            let mut transform = serde_json::to_value(Transform::default()).unwrap_or_default();
            merge(&mut transform, &args["transform"]);
            let transform: Transform =
                serde_json::from_value(transform).map_err(|error| format!("transform: {error}"))?;
            let color: ClipColor = args
                .get("color")
                .filter(|value| !value.is_null())
                .map(|value| serde_json::from_value(value.clone()))
                .transpose()
                .map_err(|error| format!("color: {error}"))?
                .unwrap_or(ClipColor::Pink);
            let text_value = args["text"].as_str().ok_or("text is required")?.to_owned();
            let track = args["track"].as_str().map(str::to_owned);
            let (_, clip_id) = store.update(&id, ORIGIN, |project| {
                let track = match track {
                    Some(track) => track,
                    None => free_track(project, TrackKind::Video, start, start + duration),
                };
                let clip_id = project.fresh_id("c");
                project.clips.push(Clip {
                    id: clip_id.clone(),
                    track,
                    start,
                    duration,
                    color,
                    name: None,
                    link: None,
                    fade_in: 0,
                    fade_out: 0,
                    keyframes: Default::default(),
                    content: ClipContent::Text {
                        text: text_value,
                        style,
                        transform,
                        animation,
                        opacity: 1.0,
                        word_times: Vec::new(),
                    },
                });
                Ok(clip_id)
            })?;
            Ok(text(format!("added text clip {clip_id}")))
        }
        "add_clip" => {
            let mut value = args["clip"].clone();
            if !value.is_object() {
                return Err("clip must be an object".to_owned());
            }
            let (_, clip_id) = store.update(&id, ORIGIN, |project| {
                let clip_id = project.fresh_id("c");
                value["id"] = json!(clip_id);
                let kind = if value["type"] == "audio" {
                    TrackKind::Audio
                } else {
                    TrackKind::Video
                };
                if value["track"].as_str().is_none() {
                    let start = value["start"].as_i64().unwrap_or(0);
                    let end = start + value["duration"].as_i64().unwrap_or(1);
                    value["track"] = json!(free_track(project, kind, start, end));
                }
                let clip: Clip =
                    serde_json::from_value(value).map_err(|error| format!("clip: {error}"))?;
                project.clips.push(clip);
                Ok(clip_id)
            })?;
            Ok(text(format!("added clip {clip_id}")))
        }
        "update_clip" => {
            let clip_id = args["clip_id"]
                .as_str()
                .ok_or("clip_id is required")?
                .to_owned();
            let patch = args["patch"].clone();
            store.update(&id, ORIGIN, |project| {
                let clip = project
                    .clip_mut(&clip_id)
                    .ok_or_else(|| format!("no clip {clip_id}"))?;
                let mut value = serde_json::to_value(&*clip).map_err(|error| error.to_string())?;
                merge(&mut value, &patch);
                value["id"] = json!(clip_id);
                *clip = serde_json::from_value(value)
                    .map_err(|error| format!("patched clip is invalid: {error}"))?;
                Ok(())
            })?;
            let clip = store
                .get(&id)
                .and_then(|live| live.project.clip(&clip_id).cloned());
            Ok(text(format!(
                "updated {clip_id}: {}",
                serde_json::to_string(&clip).unwrap_or_default()
            )))
        }
        "delete_clips" => {
            let ids: Vec<String> = serde_json::from_value(args["clip_ids"].clone())
                .map_err(|error| error.to_string())?;
            let (_, removed) = store.update(&id, ORIGIN, |project| {
                let before = project.clips.len();
                project.clips.retain(|clip| !ids.contains(&clip.id));
                Ok(before - project.clips.len())
            })?;
            Ok(text(format!("deleted {removed} clip(s)")))
        }
        "set_keyframes" => {
            let clip_id = args["clip_id"]
                .as_str()
                .ok_or("clip_id is required")?
                .to_owned();
            let param = args["param"]
                .as_str()
                .ok_or("param is required")?
                .to_owned();
            let mut keys: Vec<Keyframe> = serde_json::from_value(args["keyframes"].clone())
                .map_err(|error| format!("keyframes: {error}"))?;
            keys.sort_by(|a, b| a.frame.total_cmp(&b.frame));
            store.update(&id, ORIGIN, |project| {
                let clip = project
                    .clip_mut(&clip_id)
                    .ok_or_else(|| format!("no clip {clip_id}"))?;
                if !animatable_params(&clip.content).contains(&param.as_str()) {
                    return Err(format!(
                        "{param} is not animatable here; use one of {}",
                        animatable_params(&clip.content).join(", ")
                    ));
                }
                if keys.is_empty() {
                    clip.keyframes.remove(&param);
                } else {
                    clip.keyframes.insert(param.clone(), keys);
                }
                Ok(())
            })?;
            Ok(text(format!("set {param} keyframes on {clip_id}")))
        }
        "import_media" => {
            let paths: Vec<String> =
                serde_json::from_value(args["paths"].clone()).map_err(|error| error.to_string())?;
            let place = args["place"].as_bool().unwrap_or(false);
            let (_, added, errors) =
                crate::server::import_paths(app, &id, paths, place, ORIGIN).await?;
            Ok(text(format!(
                "imported media {added:?}{}",
                if errors.is_empty() {
                    String::new()
                } else {
                    format!("; errors: {errors:?}")
                }
            )))
        }
        "transcribe" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let media_id = args["media_id"].as_str().ok_or("media_id is required")?;
            let media = live
                .project
                .media(media_id)
                .ok_or_else(|| format!("no media {media_id}"))?;
            let status = app
                .media
                .transcribe(std::path::PathBuf::from(&media.path), media.has_audio);
            Ok(text(format!(
                "transcript for {}: {}",
                media.name,
                serde_json::to_string(&status.transcript).unwrap_or_default()
            )))
        }
        "caption_speakers" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let fps = live.project.fps();
            let (intro_from, intro_to) =
                crate::captions::intro(&live.project).unwrap_or((0, live.project.duration()));
            let from = args["start"]
                .as_f64()
                .map_or(intro_from, |seconds| (seconds * fps).round() as i64);
            let to = args["end"]
                .as_f64()
                .map_or(intro_to, |seconds| (seconds * fps).round() as i64);
            let summary = crate::captions::caption_speakers(app, &id, from, to).await?;
            Ok(text(format!(
                "captioned {}–{}s: {}",
                from as f64 / fps,
                to as f64 / fps,
                serde_json::to_string(&summary).unwrap_or_default()
            )))
        }
        "track_region" => {
            let time = args["time"].as_f64().ok_or("time is required")?;
            let region: Vec<f64> = args["box"]
                .as_array()
                .map(|values| values.iter().filter_map(Value::as_f64).collect())
                .unwrap_or_default();
            let follow = args["follow"].as_str().ok_or("follow is required")?;
            let [x0, y0, x1, y1] = region[..] else {
                return Err("box is [x0, y0, x1, y1]".into());
            };
            let place = args["place"].as_str().unwrap_or("on");
            let summary =
                crate::captions::follow_region(app, &id, time, [x0, y0, x1, y1], follow, place)
                    .await?;
            Ok(text(summary))
        }
        "read_transcript" => {
            let live = store.get(&id).ok_or("project vanished")?;
            Ok(text(timeline_transcript(app, &live.project)))
        }
        "render_frame" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let frame = match (args["frame"].as_i64(), args["time"].as_f64()) {
                (Some(frame), _) => frame,
                (None, Some(time)) => (time * live.project.fps()).floor() as i64,
                _ => 0,
            };
            let max = args["max_size"].as_u64().unwrap_or(960) as u32;
            let images = app
                .frames
                .render(live.project.clone(), vec![frame], max)
                .await?;
            let png = encode_png(&images[0])?;
            Ok(image(
                &png,
                format!("frame {frame} ({:.2}s)", frame as f64 / live.project.fps()),
            ))
        }
        "contact_sheet" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let fps = live.project.fps();
            let start = args["start"].as_f64().ok_or("start is required")?;
            let end = args["end"].as_f64().ok_or("end is required")?.max(start);
            let count = args["count"].as_u64().unwrap_or(12).clamp(1, 24) as usize;
            let columns = args["columns"].as_u64().unwrap_or(4).clamp(1, 8) as u32;
            let frames: Vec<i64> = (0..count)
                .map(|index| {
                    let t = if count == 1 {
                        start
                    } else {
                        start + (end - start) * index as f64 / (count - 1) as f64
                    };
                    (t * fps).floor() as i64
                })
                .collect();
            let images = app
                .frames
                .render(live.project.clone(), frames.clone(), 480)
                .await?;
            let png = encode_png(&tile(&images, columns))?;
            let times: Vec<String> = frames
                .iter()
                .map(|frame| format!("{:.2}s", *frame as f64 / fps))
                .collect();
            Ok(image(
                &png,
                format!(
                    "{count} frames, left-to-right then down: {}",
                    times.join(", ")
                ),
            ))
        }
        "export" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let path = args["path"]
                .as_str()
                .filter(|path| !path.trim().is_empty())
                .map(crate::server::expand_home)
                .unwrap_or_else(|| crate::server::default_export_path(&live.project));
            app.exports
                .start(std::sync::Arc::clone(store), live.project, path.clone())?;
            Ok(text(format!("export started → {}", path.display())))
        }
        _ => Err(format!("unknown tool {name}")),
    }
}

/// Words heard on the timeline (audio clips on unmuted tracks), as phrases with
/// timeline times. A phrase breaks on a pause or a change of voice.
fn timeline_transcript(app: &App, project: &Project) -> String {
    let fps = project.fps();
    let mut words: Vec<(f64, String, Option<String>)> = Vec::new();
    let mut missing = Vec::new();
    for clip in &project.clips {
        let ClipContent::Audio {
            media,
            source_in,
            speed,
            ..
        } = &clip.content
        else {
            continue;
        };
        if project.track(&clip.track).is_some_and(|track| track.muted) {
            continue;
        }
        let Some(source) = project.media(media) else {
            continue;
        };
        let path = app
            .media
            .paths(std::path::Path::new(&source.path))
            .transcript;
        let Some(transcript) = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<crate::transcribe::Transcript>(&bytes).ok())
        else {
            if !missing.contains(&source.name) {
                missing.push(source.name.clone());
            }
            continue;
        };
        let from = *source_in;
        let to = source_in + clip.duration as f64 / fps * speed;
        for word in transcript
            .words
            .iter()
            .filter(|word| word.start >= from && word.start < to)
        {
            let at = clip.start as f64 / fps + (word.start - from) / speed;
            // Named voices ("Officer") read better than Scribe's numbers.
            let speaker = word.speaker.as_ref().map(|voice| {
                transcript
                    .speakers
                    .get(voice)
                    .cloned()
                    .unwrap_or_else(|| voice.clone())
            });
            words.push((at, word.text.clone(), speaker));
        }
    }
    words.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out = String::new();
    let mut last: Option<(f64, Option<String>)> = None;
    for (at, word, speaker) in words {
        let breaks = last
            .as_ref()
            .is_none_or(|(previous, voice)| at - previous > 0.8 || *voice != speaker);
        if breaks {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&format!("[{at:.2}s]"));
            if let Some(voice) = &speaker {
                out.push_str(&format!(" ({voice})"));
            }
        }
        out.push(' ');
        out.push_str(&word);
        last = Some((at, speaker));
    }
    if out.is_empty() {
        out.push_str("No transcribed speech on the timeline.");
    }
    if !missing.is_empty() {
        out.push_str(&format!("\n\nNot transcribed yet: {}.", missing.join(", ")));
    }
    out
}

/// Lowest track of `kind` free over [start, end); adds a track when none is.
/// Text and graphics prefer tracks above the main footage.
fn free_track(project: &mut Project, kind: TrackKind, start: i64, end: i64) -> String {
    let busy = |project: &Project, track: &str| {
        project
            .clips
            .iter()
            .any(|clip| clip.track == track && clip.start < end && start < clip.end())
    };
    let candidates: Vec<String> = project
        .tracks
        .iter()
        .filter(|track| track.kind == kind)
        .skip(usize::from(kind == TrackKind::Video))
        .map(|track| track.id.clone())
        .collect();
    for track in candidates {
        if !busy(project, &track) {
            return track;
        }
    }
    project.add_track(kind)
}

/// RFC 7386 JSON merge patch.
fn merge(target: &mut Value, patch: &Value) {
    let Some(patch) = patch.as_object() else {
        if !patch.is_null() {
            *target = patch.clone();
        }
        return;
    };
    if !target.is_object() {
        *target = json!({});
    }
    let object = target.as_object_mut().expect("object");
    for (key, value) in patch {
        if value.is_null() {
            object.remove(key);
        } else {
            merge(object.entry(key.clone()).or_insert(Value::Null), value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::merge;
    use serde_json::json;

    #[test]
    fn merge_patch_follows_rfc_7386() {
        let mut value = json!({ "a": 1, "style": { "size": 10, "glow": { "enabled": false } } });
        merge(
            &mut value,
            &json!({ "a": null, "style": { "glow": { "enabled": true } }, "b": [1] }),
        );
        assert_eq!(
            value,
            json!({ "style": { "size": 10, "glow": { "enabled": true } }, "b": [1] })
        );
    }
}
