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
- tracks: video tracks composite in list order (first = bottom, label V1); audio tracks mix. A track holds non-overlapping clips. Video-type clips go on video tracks; audio clips on audio tracks. One video track may be the subtitles' own (subtitles: true): always the top video track, holding only subtitles (add_subtitles puts them there; new tracks go beneath it; tidy_tracks leaves it alone). Put nothing else on it.
- clip: {id, track, start, duration, color (blue|cyan|green|yellow|orange|red|purple|pink), link?, fade_in, fade_out, keyframes, type, ...}
  - type "video": media, source_in, speed (0.05..20), transform {x, y (px from frame centre, y down), scale (1 = fit frame), rotation (deg clockwise), shake (px of handheld camera wobble, 0 = still)}, opacity 0..1
  - type "audio": media, source_in, speed, volume_db
  - type "text": text (\n for lines), style {font "Geist" (weight 400|500|600|700|900) or "Montserrat" (600 only), size px, color [r,g,b,a] 0..1, tracking px, line_height, glow {enabled (default true), color [r,g,b,a] or null = text colour (default null), radius = blur px (default 46), strength = opacity 0..1 (default 0.5)}, optional max_width px (wrap lines), optional background {color, opacity (0.75), pad_x (12), pad_y (8), border px (0 = none), border_color (white)} = a box behind the lines (border: a line around it, outside it), optional shadow {color, opacity (0.65), distance px (3), angle degrees clockwise from up (112), size px (6), blur px (8)} (with a background, the box casts it), optional label {text, color, size px (26)} = a small line centred above the text in its own colour, in its own box when there's a background (who's speaking: "Officer:")}. Subtitle house style after the intro (at 1080p; scale by height/1080): Montserrat 600, size 48, white, line_height 1.15, glow off, max_width = 0.8*width - 24, background pure black (color [0,0,0,1], opacity 1, default padding), no shadow, label {text "<speaker>:", color = the speaker's colour, size 26}, transform.y = 0.4*height, animation none, transform (as video, shake included), animation {preset none|fade|rise|pop|typewriter|words, duration frames, stagger frames}, opacity, word_times (frames from the clip start at which each word appears, for preset "words": words pop in one at a time, no motion, synced to speech; without word_times one every `stagger` frames)
  - type "adjustment": grade {exposure stops, contrast -1..1, saturation -1..1, temperature -1..1, vignette 0..1}, shake {preset none|handheld|vertical|horizontal|impact|earthquake, and optionally any of motion wiggle|drop, amount (px at 1080p), frequency (wiggles/s), rotation (deg of tilt), direction both|vertical|horizontal, envelope steady|build|hit|swell (wiggle only), motion_blur (frames of movement smeared), edges mirror|zoom — each overrides the preset}, opacity — grades and moves everything below it, modelled on Sapphire S_Shake (heavy motion blur, picture mirrored past its edges). motion "wiggle" = random jolts; motion "drop" = a whip through a cut at the clip's middle: the picture accelerates away until the cut, then the next shot comes in from the other side and settles (amount px = a full move each side), down (vertical) or right (horizontal), negative amount for up/left. Presets: vertical = a whip straight down through the cut, 540px, blur 2 (the house slam into a cut: it only goes down, fast, heavily blurred, never up and down); horizontal = the same sideways; impact 160px wiggle 30/s, 3° tilt, hit; earthquake 60px wiggle 16/s; handheld 8px 1.2/s, sharp, zoomed (subtle).
  - type "solid": fill [r,g,b,a], opacity — flashes, dips to black
  - type "waveform": media? (only that media's sound; default everything heard), style {kind line|bars (line: tangled glowing strands that zigzag with the sound, the house look; bars: mirrored bars), color [r,g,b,a] (rich red [1,0.03,0.03,1] by default), strands (2, line), bars (48, bars), width (1400 px), height (360 px, the loudest swing), fill (0.5, bars' share of their slots), window (1.6 s of sound across the width, centred on now), gain (1), glow (the text glow: enabled, color?, radius, strength)}, transform, opacity — a glowing waveform of what's heard
- media: {id, name, path, kind, duration, …, markers?: [{time (SECONDS into the media), name}]} — markers are points in the source that every clip of it carries (a sound effect's "hit"; the user adds them with M).
- script (optional): the script the edit follows, imported from a Google Doc: {source, blocks: [{kind "footage", url, file (Drive id), start, end (SECONDS of that file), label, notes, media?, clip?} | {kind "narration", text, notes, clip?, voiceover? (the voice-over clip reading it)}]}. Each block's clip is the timeline clip it became. Narration plays as a cut-in: a black solid on one video track with the text on the track above, linked, until a voice-over replaces it. Notes are the Doc's comments (editor notes such as "blur the victim", and first....last words of a range).
- mark_in, mark_out (optional): the in and out points (I / O), frames; mark_out is the last frame in (inclusive). Playback stops at the out point and export renders just that span when no range is given. They're part of the project (set_in_out), so setting them is an undo step like any edit.
- keyframes: {param: [{frame (relative to clip start), value, ease linear|in_out|in|out|hold (preset for the segment to the next key), optional handle_in / handle_out {speed = value units per frame at the key, influence 0..1 of the segment} = After Effects-style bezier handles that override the preset at that end}]}. Animatable params: video x,y,scale,rotation,shake,opacity; text also size,tracking,glow.radius,glow.strength; waveform x,y,scale,rotation,opacity,gain,glow.radius,glow.strength; adjustment shake (amount),exposure,contrast,saturation,temperature,vignette,opacity; solid opacity; audio volume_db.
Validation: collection IDs are nonempty and unique; next_id is a nonnegative safe integer; timeline start/duration/fades are nonnegative safe integer frames (duration positive), source_in is finite and nonnegative, all numeric parameters are finite, keyframes are in strictly increasing frame order, and script file is a Drive ID with no path separators and a positive source range. Project dimensions are 1..8192.
Linked clips (same link id) are picture+sound of one source; keep them aligned when moving.
Look at your work with render_frame / contact_sheet before telling the user it is done.

House editing style (videos cut from a script of police footage):
- get_project's "sections" are found automatically from where the script's blocks sit (never set by hand): intro, intro_splits, outro, and parts back to back (intro / b-roll / story / outro, frames). Every cut-in is a B-roll spot.
- The INTRO is the hook: the short teaser clips from the start up to the "On <date>" cut-in that starts the story (without one, the cut-in that leads into the full footage). It can have cut-ins between its teasers (they're part of it, but get none of the footage treatment): one cut-in makes a two-split intro, two a three-split, and so on. It's where the treatment goes:
  - It always opens with a reverse dip to black: add_clip {type "solid", fill [0,0,0,1], start 0, duration about 0.5 s in frames, track "new"} so it covers everything, then set_keyframes opacity [{frame 0, value 1}, {frame duration-1, value 0}].
  - A vertical drop on each cut into a cut-in: an adjustment layer {type "adjustment", grade all 0, shake {preset "vertical"}} 6 frames long (~0.2 s) straddling the cut, half on each side: it starts 3 frames before the cut-in's first frame and ends 3 frames after it (start = cut - 3, duration 6), on a track above everything at the cut (the footage, the cut-in, its B-roll and text, captions), so the whole picture moves. A shake always sits between the two shots, never at the end of one: the old shot slams down out of frame and the new one drops in from above and settles, fast and heavily motion-blurred — one direction only, never a back-and-forth shake. If it looks weak in render_frame, raise amount or motion_blur rather than lengthening it.
  - Linked picture and sound stay whole: never leave a clip's sound trimmed short of its picture, and never put a sound effect on the footage's own audio track (A1).
  - Speaker captions on what's said: run caption_speakers (it works out who speaks each line by watching and listening, then places word-by-word captions in the house box style by that person, above their head when there's room, else just below their face or redaction box, tracked to them with a little shake). Check a few with render_frame and fix any that sit on the wrong person.
  - Punch-ins on reactions and key lines: scale keyframes from 1 to about 1.08–1.15 over a few frames, centred on the face (move x/y too).
  - B-roll over cuts: while someone keeps talking, lay a different shot (another moment of the footage, the scene, the other person reacting) on a video track above for 1–3 s as picture only; the sound underneath carries on. Prefer moments the transcript or the Doc's notes point to.
  - Quick white flashes or dips on hard scene changes, sparingly.
- CUT-INS (the black narration cards) may carry stylised text and graphics.
- B-ROLL IN CUT-INS: use source footage for B-roll, not AI-generated images. A cut-in's voice-over is covered by B-roll that shows what it says, never generic footage. Read the narration, then find the moments that back it up in the source footage (media_transcript to find who says what where; look_at_media to see it): someone confused when the words say they had no idea, the wreck or a shocked witness when they say a devastating crash. Time each shot to the words it shows (media_transcript with words: true on the voice-over gives exact times; a voice-over clip's timeline time = clip start + word time - its source_in): a shot showing \"the teenagers and the missing driver\" starts just before those words and lasts until they're said. Short cut-ins (under ~10 s) get two shots, longer ones more, each a few seconds, butted end to end and filling the cut-in from its first frame to its last, on a video track above the card. Each shot is picture only, slowed (speed about 0.5) and then made smooth with smooth_slow_motion, with a slow push-in (scale keyframes from 1 to about 1.08 across the shot, ease linear). The vertical drop into the cut-in still applies.
- PUSH-INS (the slow zoom across a B-roll shot and anything pinned to it; the moving map is linear by itself) are ease linear: a constant-speed zoom, a straight line on the graph, never in_out (no slow start, rush and slow stop).
- THE DATE CUT-IN (the "On <date>…" cut-in that opens the story) opens on where it happened: map_view of the place the narration names (the department, the station or the street; add the city and state), as a moving shot with the defaults and seconds = how long it's on screen, unless the user asks for another angle (each new view is a paid map session). Full frame at scale 1 from source_in 0, no scale keyframes: the camera slowly circles right and closes in. While the narration says the date, darken the background heavily with an adjustment beneath the text and show the date large and centered, in white (Geist 600, ~120 at 1080p, soft glow radius 40, strength 0.85, one line like "July 13th, 2024", rising into place letter by letter (animation {preset "rise", duration 14, stagger 1.5}, in frames), with shadow {color [0,0,0,1], opacity 1, distance 6, angle 112, size 10, blur 20}). Fade the date out after the spoken year, then lift the extra darkening and reveal the red building marker and floating place label together. Set map_view highlight_after to the reveal time in source seconds and highlight_fade to ~0.4 s; start the label at that time with a matching fade. The label sits just above the building (x = building.x, box bottom ~30 px above building.top, kept inside the frame), white (Geist 600, ~44 at 1080p, glow off), in an opaque black box (pad_x 20, pad_y 12) with a red border (2 px, border_color [1,0.1,0.1,1]) and shadow (opacity 0.85, distance 8, size 2, blur 18). Pin it using building_track x and y, same offsets and linear easing; when the label starts later, subtract its source start frame from tracking frames and interpolate its initial position. No state or city text. Then the cut-in's other B-roll.
- CALLS WITHOUT PICTURE in the story (a 911 call, a voicemail): cover them with B-roll that moves slowly (a push-in), the glowing waveform and its dark vignette on top (see PHONE CALLS), and subtitles as everywhere after the intro.
- VOICE-OVERS: audio files in the project that read the cut-ins (narration recordings) go on with place_voiceovers, never by hand. Each cut-in then plays its voice-over and is a B-roll spot (cover it with B-roll, or the card until there is some). A narration block's voiceover is its clip once placed. Leave the cut-in cards and their words in place unless the user asks to remove them.
- PHONE CALLS and other sound without a picture (911 calls, voicemails, recordings): a glowing waveform. Lay a dark vignette first: an adjustment layer {type "adjustment", name "Dark vignette", grade {exposure -1.9, contrast 0, saturation 0, temperature 0, vignette 0.9}} over the footage for the span (the footage still shows, darker at the edges), then a waveform on the track above it (both spanning the call, linked), centred, in its defaults (rich red tangled line, house glow). Scale its width, height and glow radius by the project height / 1080.
- AFTER THE INTRO the video is the full footage: keep it clean. No speaker captions, punch-ins or effects on footage there; only work on cut-ins and do what the Doc's notes ask (for example blur a face).
  - It does get plain subtitles throughout (Repack's subtitles), as part of editing the whole video: run add_subtitles (it defaults to everything after the intro). They sit bottom middle on the subtitles track, no animation, no tracking: white words without glow in a pure black box (opaque, unlike the intro captions'), the speaker's name above in their colour ("Officer:"). The intro keeps its own speaker captions (caption_speakers), glow and all. If footage after the intro changes (a range realigned, a clip moved), run add_subtitles again; it replaces its own.
- Be precise, and fill in the small gaps yourself: skip throwaway moments (a lone "like" or "um", a blip that adds nothing to the story) rather than captioning them; when something starts or ends within ~0.2 s of a cut or of the next caption, snap it to that edge so there are no slivers or hairline gaps.
- Keep the layers tidy: a clip shouldn't float on a track with nothing under it. After adding or removing layers, run tidy_tracks; it moves clips down into empty space below them (keeping what's above what) and drops empty tracks.
- When the user corrects something or tells you how they like it, apply it everywhere it fits in the project, not just the one spot they pointed at.
- Every footage range must play from its first word to its last (the Doc's "first....last" note). If one stops or starts a word short (e.g. it cuts at "hit that" when the range ends on "priuses"), run realign_script, then re-caption the clips it changed.
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
            "Add any clip (video/audio/text/adjustment/solid/waveform) using the model in the server instructions. Omit id. If track is omitted a free track of the right kind is chosen (created if needed); track \"new\" puts it on a new track on top of the rest.",
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
            "set_in_out",
            "Set the in and out points (seconds on the timeline; the out point's frame is the last one in). Null clears one; omit to leave it. Export without a range renders just that span, and playback stops at the out point.",
            json!({
                "in": { "type": ["number", "null"] },
                "out": { "type": ["number", "null"] }
            }),
            &[],
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
            "look_at_media",
            "Look through a media file (the whole source, not just what's on the timeline): evenly spaced frames between start and end (seconds of the file) in one grid image. For finding B-roll moments that show what a cut-in says.",
            json!({
                "media_id": { "type": "string" },
                "start": { "type": "number" }, "end": { "type": "number" },
                "count": { "type": "integer", "description": "Frames, max 24 (default 12)." },
                "columns": { "type": "integer", "description": "Default 4." }
            }),
            &["media_id", "start", "end"],
        ),
        tool(
            "media_transcript",
            "What's said in a media file (its own seconds, the whole source), as phrases with times and speakers; transcribes it first if needed. For finding moments to use as B-roll (someone confused, a witness reacting).",
            json!({
                "media_id": { "type": "string" },
                "start": { "type": "number", "description": "Default 0." },
                "end": { "type": "number", "description": "Default the end of the file." },
                "words": { "type": "boolean", "description": "Each word with its times, to time a shot to an exact word (default: phrases)." }
            }),
            &["media_id"],
        ),
        tool(
            "smooth_slow_motion",
            "Make a slowed video clip (speed below 1) play smoothly: the stretch of its media is rendered at that speed with new frames made between the real ones (motion interpolation, like After Effects' pixel-motion frame blending), and the clip then plays that at 1×. Timing is unchanged. Set the clip's speed and trim first; run again after changing them. Takes a while (it renders).",
            json!({ "clip_id": { "type": "string" } }),
            &["clip_id"],
        ),
        tool(
            "map_view",
            "A tilted 3D view of a place from Google's photorealistic 3D map (real buildings and trees, darker exposure and a vignette, the building at the place marked in glowing red), imported as footage: by default a moving shot, the camera slowly circling the building and closing in while aimed at it (rendered frame by frame; takes a minute or two), or a still. Give the place as an address or name (\"Kent Police Department, Kent, Washington\"; Google finds it and the building's outline) or lat/lon. Each new view is a paid map session (a few a day): get it right the first time, and asking for the same view again reuses the footage. Returns the media id, the address it found, whether the building was outlined and where it sits in the frame (`building`: x, top, bottom, left, right in timeline transform coordinates; for a moving shot also `building_track`, where it is every half second), to place text by it.",
            json!({
                "place": { "type": "string" },
                "lat": { "type": "number" }, "lon": { "type": "number" },
                "range": { "type": "number", "description": "Camera distance in metres at the start: 170 (default) close on the building, ~330 the block around it, 800+ the neighbourhood." },
                "pitch": { "type": "number", "description": "Tilt from straight down in degrees; default 55." },
                "heading": { "type": "number", "description": "Compass direction the camera faces in degrees at the start; default -25." },
                "seconds": { "type": "number", "description": "Length of the moving shot: how long it's on screen (default 6)." },
                "orbit": { "type": "number", "description": "Degrees the camera circles the building over the shot, positive to its right (default 15)." },
                "push": { "type": "number", "description": "How much closer the camera ends, as a fraction of the range (default 0.12)." },
                "still": { "type": "boolean", "description": "A still picture instead of a moving shot (30 s of footage, for a push-in)." },
                "highlight": { "type": "boolean", "description": "Mark the building in red (default true)." },
                "highlight_after": { "type": "number", "description": "Reveal the marker after this many source seconds, e.g. once a date title has faded away (default 0). Building tracking is returned even while hidden." },
                "highlight_fade": { "type": "number", "description": "Marker reveal fade duration in seconds (default 0, immediate)." }
            }),
            &[],
        ),
        tool(
            "add_sound_effect",
            "Place a sound effect bundled with Edit at timeline times, on a free audio track. Only when the user asks for one. Each is lined up by its \"hit\" marker (see media markers): for a cut, give the cut's time (where the two clips meet) and the sound straddles it. The same sound already within 0.5 s of a time is replaced, so placing again (or after the sound is updated) never doubles up.",
            json!({
                "sound": { "type": "string", "enum": crate::sfx::names(), "description": "shutter = a camera shutter. Not part of the house style: only when the user asks for it." },
                "times": { "type": "array", "items": { "type": "number" }, "description": "Seconds on the timeline." },
                "volume_db": { "type": "number", "description": "Default 0." }
            }),
            &["sound", "times"],
        ),
        tool(
            "realign_script",
            "Re-finds each script range's first and last words in its transcript (forgiving how the Doc spells them: plurals, possessives, a letter off, e.g. \"priuses\" for \"Prius\") and moves that clip's in/out points to them, shifting everything after it so nothing overlaps or gaps (effects ending on its cut move with the cut). Use it when a range starts or ends a word early or late. Re-run caption_speakers over any clip it changes.",
            json!({}),
            &[],
        ),
        tool(
            "place_voiceovers",
            "Lay voice-over recordings on the script's cut-ins. The recordings read the cut-ins' text: each is transcribed, the words that read each cut-in are found, and that stretch of audio is placed where the cut-in is (on a voice-over track). The cut-in (card and words) takes the voice-over's length and everything after moves with it, so the timeline stays butted. Placing again replaces what it placed. Takes a while the first time (transcription). Reports what was placed and any cut-in whose words weren't found.",
            json!({
                "media_ids": { "type": "array", "items": { "type": "string" }, "description": "The recordings (default: every audio file not on the timeline that isn't a sound effect, plus ones placed before)." }
            }),
            &[],
        ),
        tool(
            "tidy_tracks",
            "Moves every clip down onto the track below wherever that track is empty for the clip's whole span (never into V1/A1, the footage tracks), so layers don't float above gaps and clips that overlap keep their order, then removes tracks left empty. Run it after adding or removing layers.",
            json!({}),
            &[],
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
            "Speaker captions for intro footage: splits what's said into lines, asks a vision model (Luna) who says each line and where they are (stills + sound), then adds a word-by-word caption per line in the house box style beside its speaker, tracked to their face with a little shake. Replaces captions it made before in that span. Takes a few minutes. Defaults to the intro (start to the cut-in before the full footage).",
            json!({
                "start": { "type": "number", "description": "Seconds on the timeline (default 0)." },
                "end": { "type": "number", "description": "Seconds on the timeline (default: the end of the intro)." }
            }),
            &[],
        ),
        tool(
            "add_subtitles",
            "Plain subtitles for everything said (Repack's style): bottom middle, no animation, no tracking, each line in its speaker's colour. Made from the footage's own sound, skipping throwaway lines and snapping to cuts. Replaces subtitles it made before in that span. Defaults to after the intro: from the cut-in before the full footage to the end of the timeline.",
            json!({
                "start": { "type": "number", "description": "Seconds on the timeline (default: the end of the intro)." },
                "end": { "type": "number", "description": "Seconds on the timeline (default: the end)." }
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
            "Export the project (default: the whole edit as an MP4, H.264 + AAC, at the project's size). Progress shows in the UI. Options as the export dialog: format, range (frames [start, end)), shape (vertical = 9:16 for Shorts/Reels, filled per fill: blur | crop | black), size (short side px), quality or target_mb, loudness (LUFS, e.g. -14 for YouTube), chapters.",
            json!({
                "path": { "type": "string", "description": "Output path (default ~/Movies/Edit/<name>.mp4); the extension follows the format." },
                "options": {
                    "type": "object",
                    "properties": {
                        "format": { "type": "string", "enum": ["h264", "hevc", "prores", "gif", "wav", "mp3", "png"] },
                        "range": { "type": "array", "items": { "type": "integer" }, "description": "[start, end) frames of the edit; png uses start." },
                        "shape": { "type": "string", "enum": ["original", "vertical", "square", "portrait"] },
                        "fill": { "type": "string", "enum": ["blur", "crop", "black"] },
                        "size": { "type": "integer", "description": "Short side in px (e.g. 1080, 720)." },
                        "quality": { "type": "string", "enum": ["high", "balanced", "small"] },
                        "target_mb": { "type": "number" },
                        "hardware": { "type": "boolean", "description": "Encode on the Mac's media engine: much faster." },
                        "audio": { "type": "boolean" },
                        "loudness": { "type": "number" },
                        "chapters": { "type": "array", "items": { "type": "object", "properties": { "start": { "type": "integer" }, "title": { "type": "string" } } } }
                    }
                }
            }),
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
                    "sections": edit_core::sections(project),
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
                match value["track"].as_str() {
                    Some("new") => value["track"] = json!(project.add_track(kind)),
                    Some(_) => {}
                    None => {
                        let start = value["start"].as_i64().unwrap_or(0);
                        let end = start + value["duration"].as_i64().unwrap_or(1);
                        value["track"] = json!(free_track(project, kind, start, end));
                    }
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
        "set_in_out" => {
            let fps = store.get(&id).ok_or("project vanished")?.project.fps();
            let frame = |key: &str| -> Option<Option<i64>> {
                let value = args.get(key)?;
                Some(
                    value
                        .as_f64()
                        .map(|seconds| (seconds * fps).round().max(0.0) as i64),
                )
            };
            let (start, end) = (frame("in"), frame("out"));
            let (_, span) = store.update(&id, ORIGIN, |project| {
                if let Some(start) = start {
                    project.mark_in = start;
                }
                if let Some(end) = end {
                    project.mark_out = end;
                }
                Ok(project.in_out())
            })?;
            Ok(text(match span {
                Some((start, end)) => format!(
                    "in/out: {:.2}s to {:.2}s ({} frames)",
                    start as f64 / fps,
                    end as f64 / fps,
                    end - start
                ),
                None => "in and out points cleared".to_owned(),
            }))
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
        "add_sound_effect" => {
            let name = args["sound"].as_str().ok_or("sound is required")?;
            let sound = crate::sfx::find(name).ok_or_else(|| {
                format!(
                    "no sound {name}; use one of {}",
                    crate::sfx::names().join(", ")
                )
            })?;
            let times: Vec<f64> =
                serde_json::from_value(args["times"].clone()).map_err(|error| error.to_string())?;
            let volume_db = args["volume_db"].as_f64().unwrap_or(0.0) as f32;
            let path = crate::sfx::path(store.home(), sound)?;
            let (_, added, errors) = crate::server::import_paths(
                app,
                &id,
                vec![path.to_string_lossy().to_string()],
                false,
                ORIGIN,
            )
            .await?;
            let media_id = added
                .into_iter()
                .next()
                .ok_or_else(|| format!("couldn't import {name}: {errors:?}"))?;
            let (_, placed) = store.update(&id, ORIGIN, |project| {
                let fps = project.fps();
                let media = project
                    .media
                    .iter_mut()
                    .find(|media| media.id == media_id)
                    .ok_or("sound media vanished")?;
                // The sound's markers come with it (kept if the user has moved them).
                if media.markers.is_empty() {
                    media.markers = sound.markers();
                }
                let hit = media
                    .markers
                    .iter()
                    .find(|marker| marker.name == crate::sfx::HIT)
                    .or(media.markers.first())
                    .map_or(0.0, |marker| marker.time);
                let length = ((media.duration * fps).floor() as i64).max(1);
                let mut placed = Vec::new();
                let mut replaced = 0;
                for time in &times {
                    // This sound already near the time (any version of it) gives way to the new one.
                    let (near0, near1) = (((time - 0.5) * fps) as i64, ((time + 0.5) * fps) as i64);
                    let before = project.clips.len();
                    project.clips.retain(|clip| {
                        !(clip.name.as_deref() == Some(name)
                            && matches!(clip.content, ClipContent::Audio { .. })
                            && clip.start < near1
                            && clip.end() > near0)
                    });
                    replaced += before - project.clips.len();
                    // Its hit marker lands on the time given.
                    let mut start = ((time - hit) * fps).round() as i64;
                    let mut duration = length;
                    let mut source_in = 0.0;
                    // A hit on frame 0: drop the bit before it.
                    if start < 0 {
                        source_in = -start as f64 / fps;
                        duration += start;
                        start = 0;
                    }
                    if duration < 1 {
                        continue;
                    }
                    // Never on A1: that's the footage's own sound.
                    let track =
                        free_track_from(project, TrackKind::Audio, 1, start, start + duration);
                    let clip_id = project.fresh_id("c");
                    project.clips.push(Clip {
                        id: clip_id,
                        track,
                        start,
                        duration,
                        color: ClipColor::Yellow,
                        name: Some(name.to_owned()),
                        link: None,
                        fade_in: 0,
                        fade_out: 0,
                        keyframes: Default::default(),
                        content: ClipContent::Audio {
                            media: media_id.clone(),
                            source_in,
                            speed: 1.0,
                            volume_db,
                        },
                    });
                    placed.push(format!("{time:.2}s"));
                }
                Ok((placed, replaced))
            })?;
            let (placed, replaced) = placed;
            Ok(text(format!(
                "placed {name} at {} (replacing {replaced} already near those times)",
                placed.join(", ")
            )))
        }
        "realign_script" => {
            let changed = crate::script::realign(app, &id).await?;
            Ok(text(if changed.is_empty() {
                "every range already starts and ends on its words".to_owned()
            } else {
                serde_json::to_string_pretty(&changed).unwrap_or_default()
            }))
        }
        "look_at_media" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let media_id = args["media_id"].as_str().ok_or("media_id is required")?;
            let media = live
                .project
                .media(media_id)
                .ok_or_else(|| format!("no media {media_id}"))?
                .clone();
            let start = args["start"].as_f64().unwrap_or(0.0).max(0.0);
            let end = args["end"].as_f64().unwrap_or(media.duration);
            let count = args["count"].as_u64().unwrap_or(12).clamp(1, 24) as usize;
            let columns = args["columns"].as_u64().unwrap_or(4).clamp(1, 8) as u32;
            let (images, times) = tokio::task::spawn_blocking(move || {
                crate::broll::media_frames(&media, start, end, count)
            })
            .await
            .map_err(|error| error.to_string())??;
            let png = encode_png(&tile(&images, columns))?;
            let times: Vec<String> = times.iter().map(|time| format!("{time:.2}s")).collect();
            Ok(image(
                &png,
                format!(
                    "{media_id}: {} frames, left-to-right then down, at {}",
                    times.len(),
                    times.join(", ")
                ),
            ))
        }
        "media_transcript" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let media_id = args["media_id"].as_str().ok_or("media_id is required")?;
            let media = live
                .project
                .media(media_id)
                .ok_or_else(|| format!("no media {media_id}"))?;
            let from = args["start"].as_f64().unwrap_or(0.0);
            let to = args["end"].as_f64().unwrap_or(f64::MAX);
            let words = args["words"].as_bool().unwrap_or(false);
            Ok(text(
                crate::broll::media_transcript(app, media, from, to, words).await?,
            ))
        }
        "smooth_slow_motion" => {
            let clip = args["clip_id"].as_str().ok_or("clip_id is required")?;
            let done = crate::broll::smooth_slow_motion(app, &id, clip).await?;
            Ok(text(done.to_string()))
        }
        "map_view" => {
            let done = crate::broll::map_view(app, &id, args).await?;
            Ok(text(
                serde_json::to_string_pretty(&done).unwrap_or_default(),
            ))
        }
        "place_voiceovers" => {
            let media: Option<Vec<String>> = args
                .get("media_ids")
                .filter(|value| !value.is_null())
                .map(|value| {
                    serde_json::from_value(value.clone()).map_err(|error| error.to_string())
                })
                .transpose()?;
            let report = crate::voiceover::place(app, &id, media).await?;
            Ok(text(
                serde_json::to_string_pretty(&report).unwrap_or_default(),
            ))
        }
        "tidy_tracks" => {
            let (_, (moved, removed)) =
                store.update(&id, ORIGIN, |project| Ok(tidy_tracks(project)))?;
            Ok(text(format!(
                "moved {moved} clip(s) down, removed {removed} empty track(s)"
            )))
        }
        "transcribe" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let media_id = args["media_id"].as_str().ok_or("media_id is required")?;
            let media = live
                .project
                .media(media_id)
                .ok_or_else(|| format!("no media {media_id}"))?;
            if media.is_sound_effect() {
                return Err(format!(
                    "{} is a sound effect; there's nothing said to transcribe",
                    media.name
                ));
            }
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
        "add_subtitles" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let fps = live.project.fps();
            let intro_end = crate::captions::intro(&live.project).map_or(0, |(_, end)| end);
            let from = args["start"]
                .as_f64()
                .map_or(intro_end, |seconds| (seconds * fps).round() as i64);
            let to = args["end"]
                .as_f64()
                .map_or(live.project.duration(), |seconds| {
                    (seconds * fps).round() as i64
                });
            let summary = crate::captions::subtitles(app, &id, from, to).await?;
            Ok(text(format!(
                "subtitled {:.2}–{:.2}s: {}",
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
            let options: crate::export::ExportOptions =
                serde_json::from_value(args["options"].clone()).unwrap_or_default();
            let path =
                app.exports
                    .start(std::sync::Arc::clone(store), live.project, options, path)?;
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
/// Moves clips down onto the track below wherever it's empty for the clip's
/// whole span, so nothing floats above a gap; clips that overlap in time keep
/// their order. The first track of each kind (the footage) is left as it is.
/// Then drops tracks left empty. Returns (clips moved, tracks removed).
fn tidy_tracks(project: &mut Project) -> (usize, usize) {
    let mut moved = 0;
    loop {
        let mut changed = false;
        for kind in [TrackKind::Video, TrackKind::Audio] {
            // The subtitles keep their own track: nothing moves onto it or off it.
            let tracks: Vec<(String, bool)> = project
                .tracks
                .iter()
                .filter(|track| track.kind == kind && !track.subtitles)
                .map(|track| (track.id.clone(), track.locked))
                .collect();
            // From the second track up, each onto the one below (never into the first).
            for pair in tracks.windows(2).skip(1) {
                let ((below, below_locked), (here, here_locked)) = (&pair[0], &pair[1]);
                if *below_locked || *here_locked {
                    continue;
                }
                let ids: Vec<String> = project
                    .clips
                    .iter()
                    .filter(|clip| &clip.track == here)
                    .map(|clip| clip.id.clone())
                    .collect();
                for id in ids {
                    let (start, end) = match project.clip(&id) {
                        Some(clip) => (clip.start, clip.end()),
                        None => continue,
                    };
                    let free = !project.clips.iter().any(|other| {
                        &other.track == below && other.start < end && start < other.end()
                    });
                    if free {
                        if let Some(clip) = project.clip_mut(&id) {
                            clip.track = below.clone();
                        }
                        moved += 1;
                        changed = true;
                    }
                }
            }
        }
        if !changed {
            break;
        }
    }
    let before = project.tracks.len();
    let firsts: Vec<String> = [TrackKind::Video, TrackKind::Audio]
        .iter()
        .filter_map(|kind| project.tracks.iter().find(|track| track.kind == *kind))
        .map(|track| track.id.clone())
        .collect();
    let used: std::collections::HashSet<String> = project
        .clips
        .iter()
        .map(|clip| clip.track.clone())
        .collect();
    project
        .tracks
        .retain(|track| firsts.contains(&track.id) || used.contains(&track.id) || track.subtitles);
    (moved, before - project.tracks.len())
}

fn free_track(project: &mut Project, kind: TrackKind, start: i64, end: i64) -> String {
    free_track_from(
        project,
        kind,
        usize::from(kind == TrackKind::Video),
        start,
        end,
    )
}

/// The lowest track of `kind` free for the span, after the first `skip` of them.
fn free_track_from(
    project: &mut Project,
    kind: TrackKind,
    skip: usize,
    start: i64,
    end: i64,
) -> String {
    let busy = |project: &Project, track: &str| {
        project
            .clips
            .iter()
            .any(|clip| clip.track == track && clip.start < end && start < clip.end())
    };
    let candidates: Vec<String> = project
        .tracks
        .iter()
        .filter(|track| track.kind == kind && !track.subtitles)
        .skip(skip)
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
    use super::{merge, tidy_tracks, Clip, Project, TrackKind};
    use serde_json::json;

    #[test]
    fn tidy_tracks_drops_layers_into_gaps_and_keeps_their_order() {
        let mut project = Project::new("p".into(), "t".into(), Default::default());
        project.tracks.clear();
        let [v1, v2, v3, v4] = [(); 4].map(|_| project.add_track(TrackKind::Video));
        project.add_track(TrackKind::Audio);
        let clip = |id: &str, track: &str, start: i64, duration: i64| {
            serde_json::from_value::<Clip>(json!({
                "id": id, "track": track, "start": start, "duration": duration,
                "type": "solid", "fill": [0, 0, 0, 1]
            }))
            .unwrap()
        };
        project.clips = vec![
            clip("footage", &v1, 0, 100),
            // A caption alone on V3 with V2 empty under it: drops to V2.
            clip("caption", &v3, 0, 20),
            // A flash on V4 over a title on V2: drops to V3 (still above the title), not onto it.
            clip("title", &v2, 40, 30),
            clip("flash", &v4, 50, 5),
        ];
        let (moved, removed) = tidy_tracks(&mut project);
        let track_of = |id: &str| project.clip(id).unwrap().track.clone();
        assert_eq!(track_of("footage"), v1);
        assert_eq!(track_of("caption"), v2);
        assert_eq!(track_of("title"), v2);
        assert_eq!(track_of("flash"), v3);
        assert_eq!((moved, removed), (2, 1));
        assert!(!project.tracks.iter().any(|track| track.id == v4));
    }

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
