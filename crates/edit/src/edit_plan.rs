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

/// House pictures and sounds a plan's graphics use, already in the
/// project's media (the caller brings them in before the plan runs, so the
/// plan still saves once): see `needs`.
#[derive(Default)]
pub struct Assets {
    /// The bundled camera shutter, for evidence boards.
    pub shutter: Option<Shutter>,
    /// The desktop profile's pictures, one set per pair of window titles.
    pub desktops: Vec<crate::desktop::Art>,
}

pub struct Shutter {
    pub media: String,
    /// Seconds into the file of its click.
    pub hit: f64,
    /// Puts it ~8 LU under the edit's speech: a texture on each photo, not a hit.
    pub volume_db: f32,
}

/// What a plan's operations need brought in first.
#[derive(Default, Debug, PartialEq)]
pub struct Needs {
    pub shutter: bool,
    /// (photo viewer title, notepad title) per desktop profile.
    pub desktops: Vec<(String, String)>,
}

pub fn needs(operations: &[Value]) -> Needs {
    let mut needs = Needs::default();
    for operation in operations {
        match operation["op"].as_str() {
            Some("evidence_board") if operation["shutters"].as_bool() != Some(false) => {
                needs.shutter = true;
            }
            Some("desktop_profile") => {
                let titles = crate::desktop::titles(operation);
                if !needs.desktops.contains(&titles) {
                    needs.desktops.push(titles);
                }
            }
            _ => {}
        }
    }
    needs
}

#[cfg(test)]
pub fn apply(project: &mut Project, operations: &[Value]) -> Result<Applied, String> {
    apply_with(project, operations, &Assets::default())
}

pub fn apply_with(
    project: &mut Project,
    operations: &[Value],
    assets: &Assets,
) -> Result<Applied, String> {
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
            let result = operation_on(project, &operation, &mut smooth, assets)?;
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
    // Text placed or relabelled (a quote, a caption's speaker): one colour
    // per person across the video, as add_subtitles leaves it.
    if operations.iter().any(|operation| {
        (operation["op"] == "add"
            && operation.pointer("/clip/type").and_then(Value::as_str) == Some("text"))
            || (operation["op"] == "update" && crate::mcp::touches_people(&operation["patch"]))
    }) {
        crate::people::one_colour_per_person(project);
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
    assets: &Assets,
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
                crate::mcp::merge_clip(&mut value, &Value::Object(patch.clone()));
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
        "evidence_board" => evidence_board(project, args, assets.shutter.as_ref()),
        "desktop_profile" => {
            let (photo_title, notepad_title) = crate::desktop::titles(args);
            let art = assets
                .desktops
                .iter()
                .find(|art| art.photo_title == photo_title && art.notepad_title == notepad_title)
                .ok_or("desktop_profile's pictures weren't prepared (run it through apply_edit_plan)")?;
            crate::desktop::profile(project, args, art)
        }
        "evidence_card" => crate::graphics::evidence_card(project, args),
        "date_title" => crate::graphics::date_title(project, args),
        "place_label" => crate::graphics::place_label(project, args),
        "markers" => crate::markers::edit(project, args),
        other => Err(format!(
            "unknown op {other}; use add, update, delete, keyframes, cover_cut_in, transition, evidence_board, evidence_card, date_title, place_label, desktop_profile, markers, tidy_tracks"
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

/// The evidence board's glide between photos (frames) in the old
/// `frames`/`pan` timing, unless told otherwise.
const BOARD_PAN: i64 = 30;
/// How fast the camera passes each photo: this share of its average speed on
/// the way in and out. It eases a little to show each photo and picks up
/// between them (peaking ~1.25x the average); it never stops.
const BOARD_PASS: f64 = 0.7;
/// The camera picks up speed into the first photo over the whole way in (at
/// most this many frames, a slow drift before that)...
const BOARD_LEAD: f64 = 45.0;
/// ...from at most this share of the frame's height before it, so the photo
/// is rising into the picture from the board's first frame (on a short way
/// in it arrives a little slower than BOARD_PASS would have it).
const BOARD_LEAD_REACH: f64 = 0.4;
/// After the last photo it settles into the slow drift within this many
/// frames...
const BOARD_SETTLE: f64 = 36.0;
/// ...and this share of the frame's height, so the last photo stays in the
/// picture to the board's end.
const BOARD_SETTLE_REACH: f64 = 0.17;
/// That slow drift (px a frame at 1080p): slow, but still visibly moving.
const BOARD_DRIFT: f64 = 1.0;
/// The camera path is written as keyframes this many frames apart where it
/// curves past the photos (close enough that each key-to-key cubic follows
/// it to a fraction of a pixel), and this far apart on the straight ramps.
const BOARD_KEY_SPACING: (f64, f64) = (2.0, 6.0);
/// A Bezier handle reaching a third of its segment: with every key's speed
/// set, each segment is the cubic Hermite through its ends.
const HERMITE_INFLUENCE: f64 = 1.0 / 3.0;

/// A camera keyframe on an evidence board (board pixels; velocity in px a frame).
#[derive(Clone, Copy)]
struct CameraKey {
    frame: f64,
    x: f64,
    y: f64,
    vx: f64,
    vy: f64,
}

/// One stretch of an evidence board's camera path (board pixels and frames):
/// the cubic curve from `p0` to `p1` leaving along `t0` and arriving along
/// `t1`, travelled from `from` to `to` with the speed easing from `enter` to
/// `leave` (flat at both ends, so the speed is smooth where stretches meet)
/// and rising in the middle by just enough to cover the curve's length.
struct Stretch {
    from: f64,
    to: f64,
    p0: (f64, f64),
    t0: (f64, f64),
    p1: (f64, f64),
    t1: (f64, f64),
    enter: f64,
    leave: f64,
    /// Frames between its keyframes (a steady drift in a straight line needs
    /// only its two ends).
    spacing: f64,
    /// Length along the curve at u = i / (len - 1).
    lengths: Vec<f64>,
}

impl Stretch {
    fn new(
        span: (f64, f64),
        p0: (f64, f64),
        t0: (f64, f64),
        p1: (f64, f64),
        t1: (f64, f64),
    ) -> Self {
        let mut stretch = Stretch {
            from: span.0,
            to: span.1,
            p0,
            t0,
            p1,
            t1,
            enter: 0.0,
            leave: 0.0,
            spacing: BOARD_KEY_SPACING.0,
            lengths: Vec::new(),
        };
        let steps = 256;
        let mut total = 0.0;
        let mut last = p0;
        stretch.lengths.push(0.0);
        for step in 1..=steps {
            let here = stretch.point(f64::from(step) / f64::from(steps));
            total += (here.0 - last.0).hypot(here.1 - last.1);
            stretch.lengths.push(total);
            last = here;
        }
        stretch
    }

    /// Straight from `p0` to `p1`, the speed easing from `enter` to `leave`.
    fn straight(span: (f64, f64), p0: (f64, f64), p1: (f64, f64), enter: f64, leave: f64) -> Self {
        let chord = (p1.0 - p0.0, p1.1 - p0.1);
        let mut stretch = Stretch::new(span, p0, chord, p1, chord);
        stretch.enter = enter;
        stretch.leave = leave;
        stretch.spacing = if (enter - leave).abs() < 1e-9 {
            f64::INFINITY
        } else {
            BOARD_KEY_SPACING.1
        };
        stretch
    }

    fn point(&self, u: f64) -> (f64, f64) {
        let (u2, u3) = (u * u, u * u * u);
        let (a, b, c, d) = (
            2.0 * u3 - 3.0 * u2 + 1.0,
            u3 - 2.0 * u2 + u,
            3.0 * u2 - 2.0 * u3,
            u3 - u2,
        );
        (
            a * self.p0.0 + b * self.t0.0 + c * self.p1.0 + d * self.t1.0,
            a * self.p0.1 + b * self.t0.1 + c * self.p1.1 + d * self.t1.1,
        )
    }

    fn tangent(&self, u: f64) -> (f64, f64) {
        let u2 = u * u;
        let (a, b, c, d) = (
            6.0 * u2 - 6.0 * u,
            3.0 * u2 - 4.0 * u + 1.0,
            6.0 * u - 6.0 * u2,
            3.0 * u2 - 2.0 * u,
        );
        (
            a * self.p0.0 + b * self.t0.0 + c * self.p1.0 + d * self.t1.0,
            a * self.p0.1 + b * self.t0.1 + c * self.p1.1 + d * self.t1.1,
        )
    }

    fn length(&self) -> f64 {
        self.lengths.last().copied().unwrap_or(0.0)
    }

    /// Where on the curve (u) the camera is once it has come `distance` along.
    fn u_at(&self, distance: f64) -> f64 {
        let last = self.lengths.len().saturating_sub(1).max(1);
        let index = self.lengths.partition_point(|length| *length < distance);
        if index == 0 {
            return 0.0;
        }
        match (self.lengths.get(index - 1), self.lengths.get(index)) {
            (Some(&below), Some(&above)) => {
                let share = if above > below {
                    (distance - below) / (above - below)
                } else {
                    0.0
                };
                (index as f64 - 1.0 + share) / last as f64
            }
            _ => 1.0,
        }
    }

    /// The camera at `frame`: speed `enter` + (`leave` - `enter`) smoothstep +
    /// a bump 16 t^2 (1 - t)^2 (flat at both ends) sized so the stretch ends
    /// exactly at `p1`; position from the distance that speed covers.
    fn at(&self, frame: f64) -> CameraKey {
        let span = (self.to - self.from).max(f64::EPSILON);
        let t = ((frame - self.from) / span).clamp(0.0, 1.0);
        let (t2, t3) = (t * t, t * t * t);
        let (t4, t5) = (t3 * t, t3 * t2);
        let bump = ((self.length() / span - (self.enter + self.leave) / 2.0) * 15.0 / 8.0).max(0.0);
        let change = self.leave - self.enter;
        let speed =
            self.enter + change * (3.0 * t2 - 2.0 * t3) + bump * 16.0 * t2 * (1.0 - t) * (1.0 - t);
        let distance = span
            * (self.enter * t
                + change * (t3 - t4 / 2.0)
                + bump * 16.0 * (t3 / 3.0 - t4 / 2.0 + t5 / 5.0));
        let u = self.u_at(distance);
        let (x, y) = self.point(u);
        let (dx, dy) = self.tangent(u);
        let norm = dx.hypot(dy).max(f64::EPSILON);
        CameraKey {
            frame,
            x,
            y,
            vx: speed * dx / norm,
            vy: speed * dy / norm,
        }
    }
}

/// An evidence board: photos laid out on paper like prints on a desk, each in
/// a dark frame with a soft shadow and a red handwritten note under it,
/// zig-zagging down the board. The camera glides down it in ONE continuous
/// movement: each photo is centred at its moment (`at`, the frame of the word
/// that names it), the camera easing a little as it passes a photo (to ~70%
/// of its average speed) and picking up between them, smooth in position and
/// speed everywhere (never a hold, a stop or a jolt): the path is one S curve
/// through the photos, travelled at a speed set apart from its shape, and
/// written as keyframes close enough together to follow it. Before the first
/// photo it picks up from a slow drift; after the last it settles back into
/// one until the board ends.
/// Each note writes itself on, a letter every 2 frames, as its photo arrives.
/// Built in one go from
/// `{"op":"evidence_board","start":F,"end":F,"items":[{"media":"m1","label":"arson?","at":F}]}`
/// (all frames on the timeline; `end` defaults to 45 frames after the last
/// photo). The older timing still works: without `at`, `frames` is the time
/// around each photo (default 75), centred in its middle, and `pan` the
/// frames between (for the board or per photo, default 30).
/// `illustrative: true` adds a small "Illustrative images" in the corner.
/// Each photo's moment is marked on the timeline ("board photo", its label
/// as the note) and gets a quiet camera shutter whose click lands on it
/// (`shutters: false` for none; a shutter already within 8 frames, a
/// transition's on the cut into the board, stands in for it).
fn evidence_board(
    project: &mut Project,
    args: &Value,
    shutter: Option<&Shutter>,
) -> Result<Value, String> {
    let start = args["start"]
        .as_i64()
        .ok_or("evidence_board needs start (frames)")?
        .max(0);
    let items = args["items"]
        .as_array()
        .filter(|items| !items.is_empty() && items.len() <= 8)
        .ok_or("evidence_board needs items: 1 to 8 photos [{media, label, at}]")?;
    let (width, height) = (
        f64::from(project.settings.width),
        f64::from(project.settings.height),
    );
    let k = height / 1080.0;
    // When each photo is centred (board frames) and how long the board lasts.
    let (centred, total): (Vec<i64>, i64) = if items.iter().any(|item| !item["at"].is_null()) {
        let centred = items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                item["at"].as_i64().map(|at| at - start).ok_or_else(|| {
                    format!(
                        "item {}: at (frames) is required when any item has at",
                        index + 1
                    )
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        if centred.first().is_some_and(|first| *first < 0) {
            return Err("evidence_board: the first photo's at is before start".to_owned());
        }
        if centred
            .windows(2)
            .any(|pair| matches!(pair, [a, b] if b - a < 4))
        {
            return Err(
                "evidence_board: items' at must increase, at least 4 frames apart".to_owned(),
            );
        }
        let last = centred.last().copied().unwrap_or(0);
        let total = match (args["end"].as_i64(), args["duration"].as_i64()) {
            (Some(end), _) => end - start,
            (None, Some(duration)) => duration,
            (None, None) => last + 45,
        };
        if total <= last {
            return Err("evidence_board: end must come after the last photo's at".to_owned());
        }
        (centred, total)
    } else {
        let pan = args["pan"].as_i64().unwrap_or(BOARD_PAN).clamp(8, 60);
        let mut centred = Vec::new();
        let mut at = 0;
        let mut last_pan = pan;
        for item in items {
            let hold = item["frames"].as_i64().unwrap_or(75).clamp(4, 600);
            last_pan = item["pan"].as_i64().map_or(pan, |own| own.clamp(6, 60));
            centred.push(at + hold / 2);
            at += hold + last_pan;
        }
        (centred, at - last_pan)
    };
    // Where each photo sits on the board (its centre, project pixels): down
    // the board, alternately straight under and off to the right.
    let spot = |index: i64| -> (f64, f64) {
        let x = if index.rem_euclid(2) == 0 {
            0.0
        } else {
            0.42 * width
        };
        (x, index as f64 * 0.5 * height)
    };
    let spots: Vec<(f64, f64)> = (0..items.len() as i64).map(spot).collect();
    let drift = BOARD_DRIFT * k;
    // The camera's path: through every photo heading down the board's way
    // (from the photo before to the one after, as if the zig-zag carried on
    // past the ends), so it turns as it passes each photo and swings across
    // between them, one smooth S down the board.
    let headings: Vec<(f64, f64)> = (0..spots.len() as i64)
        .map(|index| {
            let ((ax, ay), (bx, by)) = (spot(index - 1), spot(index + 1));
            let length = (bx - ax).hypot(by - ay).max(1.0);
            ((bx - ax) / length, (by - ay) / length)
        })
        .collect();
    // How hard the curve leaves each photo: how far the neighbours are along
    // the heading (straight down the board, the curve's y moves evenly).
    let pulls: Vec<f64> = headings
        .iter()
        .enumerate()
        .map(|(index, &(hx, hy))| {
            let around: Vec<f64> = [index.checked_sub(1), Some(index)]
                .into_iter()
                .flatten()
                .filter_map(|from| Some((spots.get(from)?, spots.get(from + 1)?)))
                .map(|(a, b)| ((b.0 - a.0) * hx + (b.1 - a.1) * hy).abs())
                .collect();
            (around.iter().sum::<f64>() / around.len().max(1) as f64).max(1.0)
        })
        .collect();
    let scaled = |index: usize| -> (f64, f64) {
        let (hx, hy) = headings.get(index).copied().unwrap_or((0.0, 1.0));
        let pull = pulls.get(index).copied().unwrap_or(1.0);
        (hx * pull, hy * pull)
    };
    let mut glides: Vec<Stretch> = (0..spots.len().saturating_sub(1))
        .filter_map(|index| {
            let (from, to) = (centred.get(index)?, centred.get(index + 1)?);
            Some(Stretch::new(
                (*from as f64, *to as f64),
                *spots.get(index)?,
                scaled(index),
                *spots.get(index + 1)?,
                scaled(index + 1),
            ))
        })
        .collect();
    // Passing each photo at BOARD_PASS of the average speed either side (no
    // faster than the slower side's average, so each stretch's speed rises
    // in its middle and never dips below its ends).
    let averages: Vec<f64> = glides
        .iter()
        .map(|glide| glide.length() / (glide.to - glide.from).max(1.0))
        .collect();
    let mut passes: Vec<f64> = (0..spots.len())
        .map(|index| {
            let around: Vec<f64> = [
                index.checked_sub(1).and_then(|before| averages.get(before)),
                averages.get(index),
            ]
            .into_iter()
            .flatten()
            .copied()
            .collect();
            if around.is_empty() {
                return drift;
            }
            let mean = around.iter().sum::<f64>() / around.len() as f64;
            let slowest = around.iter().copied().fold(f64::INFINITY, f64::min);
            (BOARD_PASS * mean).max(drift).min(slowest)
        })
        .collect();
    // The way in: picking up speed evenly over the last BOARD_LEAD frames
    // before the first photo, from no further than BOARD_LEAD_REACH.
    let first_at = centred.first().copied().unwrap_or(0) as f64;
    let lead = first_at.min(BOARD_LEAD);
    if let Some(pass) = passes.first_mut().filter(|_| lead > 0.0) {
        *pass = pass
            .min(2.0 * BOARD_LEAD_REACH * height / lead - drift)
            .max(drift);
    }
    for (index, glide) in glides.iter_mut().enumerate() {
        glide.enter = passes.get(index).copied().unwrap_or(drift);
        glide.leave = passes.get(index + 1).copied().unwrap_or(drift);
    }
    let along = |(x, y): (f64, f64), (hx, hy): (f64, f64), distance: f64| {
        (x + hx * distance, y + hy * distance)
    };
    let mut path: Vec<Stretch> = Vec::new();
    if let (Some(&spot0), Some(&heading), Some(&pass)) =
        (spots.first(), headings.first(), passes.first())
    {
        if lead > 0.0 {
            let begins = along(spot0, heading, -lead * (pass + drift) / 2.0);
            if first_at > lead {
                let drifts = along(begins, heading, -drift * (first_at - lead));
                path.push(Stretch::straight(
                    (0.0, first_at - lead),
                    drifts,
                    begins,
                    drift,
                    drift,
                ));
            }
            path.push(Stretch::straight(
                (first_at - lead, first_at),
                begins,
                spot0,
                drift,
                pass,
            ));
        }
    }
    path.extend(glides);
    // The way out: easing from the last photo into the drift within
    // BOARD_SETTLE frames and BOARD_SETTLE_REACH, then drifting to the end.
    if let (Some(&last), Some(&spot_n), Some(&heading), Some(&pass)) =
        (centred.last(), spots.last(), headings.last(), passes.last())
    {
        let (last, end) = (last as f64, total as f64);
        let frames = (end - last)
            .min(BOARD_SETTLE)
            .min(2.0 * BOARD_SETTLE_REACH * height / (pass + drift));
        let settles = along(spot_n, heading, frames * (pass + drift) / 2.0);
        path.push(Stretch::straight(
            (last, last + frames),
            spot_n,
            settles,
            pass,
            drift,
        ));
        if end > last + frames {
            let ends = along(settles, heading, drift * (end - last - frames));
            path.push(Stretch::straight(
                (last + frames, end),
                settles,
                ends,
                drift,
                drift,
            ));
        }
    }
    // Where the camera is at `frame` (and how fast it's going).
    let camera_at = |frame: f64| -> CameraKey {
        path.iter()
            .find(|stretch| frame <= stretch.to)
            .or_else(|| path.last())
            .map_or(
                CameraKey {
                    frame,
                    x: 0.0,
                    y: 0.0,
                    vx: 0.0,
                    vy: 0.0,
                },
                |stretch| stretch.at(frame),
            )
    };
    // Its keyframes: every stretch's ends and, on a moving one, every few frames.
    let mut camera: Vec<CameraKey> = Vec::new();
    for stretch in &path {
        let span = stretch.to - stretch.from;
        let steps = (span / stretch.spacing).ceil().max(1.0);
        for step in 0..steps as usize {
            camera.push(stretch.at(stretch.from + span * step as f64 / steps));
        }
    }
    if let Some(stretch) = path.last() {
        camera.push(stretch.at(stretch.to));
    }
    // An element at board position (bx, by), on screen from `from` (board
    // frames): it moves against the camera, so its keys are the camera's
    // turned round, each with the camera's speed on both sides.
    let keys = |bx: f64, by: f64, from: i64| -> Value {
        let mut xs = Vec::new();
        let mut ys = Vec::new();
        let here = camera_at(from as f64);
        let later = camera.iter().filter(|key| key.frame > from as f64 + 0.01);
        for key in std::iter::once(&here).chain(later) {
            for (keys, value, speed) in [
                (&mut xs, bx - key.x, -key.vx),
                (&mut ys, by - key.y, -key.vy),
            ] {
                let handle = json!({"speed": speed, "influence": HERMITE_INFLUENCE});
                keys.push(
                    json!({"frame": key.frame - from as f64, "value": value, "ease": "linear",
                    "handle_in": handle.clone(), "handle_out": handle}),
                );
            }
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
    let opening = camera_at(0.0);
    for (index, ((&(x, y), item), &at)) in spots.iter().zip(items).zip(&centred).enumerate() {
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
            "transform": {"x": x - opening.x, "y": y - opening.y, "scale": scale},
            "frame": {"width": 16.0 * k, "shadow": 0.5},
            "keyframes": keys(x, y, 0)}),
        )?;
        if let Some(label) = item["label"]
            .as_str()
            .filter(|label| !label.trim().is_empty())
        {
            // Written as the photo comes in: starting a little before it's
            // centred (a third of the way from the last one, at most 12 frames).
            let gap = index
                .checked_sub(1)
                .and_then(|before| centred.get(before))
                .map_or(at, |before| at - before);
            let from = at - (gap / 3).min(12);
            let (lx, ly) = (
                x + if index % 2 == 0 { 0.02 } else { -0.02 } * width,
                y + shown / 2.0 + 0.06 * height,
            );
            let track = project.add_track(TrackKind::Video);
            let here = camera_at(from as f64);
            add(
                project,
                json!({"type": "text", "name": format!("Evidence board · note {}", index + 1),
                "track": track, "start": start + from, "duration": total - from, "text": label,
                "style": {"font": "Reenie Beanie", "weight": 400, "size": 128.0 * k,
                    "color": [0.8, 0.07, 0.15, 1.0], "glow": {"enabled": false}},
                "transform": {"x": lx - here.x, "y": ly - here.y, "rotation": -4.0},
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
    // Photos that aren't the case's own say so, small, in the corner, still.
    if args["illustrative"].as_bool().unwrap_or(false) {
        let track = project.add_track(TrackKind::Video);
        add(
            project,
            json!({"type": "text", "name": "Evidence board · illustrative", "track": track,
            "start": start, "duration": total, "text": "Illustrative images",
            "style": {"size": 30.0 * k, "weight": 500, "color": [1.0, 1.0, 1.0, 1.0],
                "glow": {"enabled": false},
                "background": {"opacity": 0.45, "pad_x": 12.0 * k, "pad_y": 6.0 * k}},
            "transform": {"x": 0.5 * width - 190.0 * k, "y": 0.5 * height - 50.0 * k}}),
        )?;
    }
    let centred: Vec<i64> = centred.iter().map(|at| start + at).collect();
    // Each photo's moment, marked: a rebuilt board replaces its old marks.
    project.markers.retain(|marker| {
        !(marker.name == BOARD_MARKER && (start..start + total).contains(&marker.frame))
    });
    for (item, at) in items.iter().zip(&centred) {
        let label = item["label"].as_str().unwrap_or_default().trim();
        crate::markers::add_timeline(project, *at, BOARD_MARKER, label);
    }
    let mut shutters = Vec::new();
    if let Some(shutter) = shutter.filter(|_| args["shutters"].as_bool() != Some(false)) {
        let fps = project.fps();
        let hit = (shutter.hit * fps).round() as i64;
        let length = project
            .media(&shutter.media)
            .map_or(6, |media| ((media.duration * fps).floor() as i64).max(1));
        // A rebuilt board's own shutters go; anyone else's shutter near a
        // photo (the cut's, with its flash) stands in for that photo's.
        project.clips.retain(|clip| {
            !(clip.name.as_deref() == Some(BOARD_SHUTTER)
                && clip.start + hit >= start
                && clip.start + hit < start + total)
        });
        let shutter_at: Vec<i64> = project
            .clips
            .iter()
            .filter_map(|clip| {
                let ClipContent::Audio {
                    media,
                    source_in,
                    speed,
                    ..
                } = &clip.content
                else {
                    return None;
                };
                let named = |name: &str| name.to_lowercase().contains("shutter");
                let media = project.media(media)?;
                // Where its click is heard: the hit, as trimmed and sped.
                (clip.name.as_deref().is_some_and(named) || named(&media.name)).then(|| {
                    let hit = media
                        .markers
                        .iter()
                        .find(|marker| marker.name == crate::sfx::HIT)
                        .map_or(*source_in, |marker| marker.time);
                    clip.start + ((hit - source_in) / speed.max(0.05) * fps).round() as i64
                })
            })
            .collect();
        for &at in &centred {
            if shutter_at.iter().any(|other| (other - at).abs() <= 8) {
                continue;
            }
            let (from, duration, source_in) = if at - hit < 0 {
                (0, length - (hit - at), (hit - at) as f64 / fps)
            } else {
                (at - hit, length, 0.0)
            };
            if duration < 1 {
                continue;
            }
            let track =
                crate::mcp::free_track_from(project, TrackKind::Audio, 1, from, from + duration);
            let id = project.fresh_id("c");
            project.clips.push(Clip {
                id: id.clone(),
                track,
                start: from,
                duration,
                color: edit_core::ClipColor::Yellow,
                name: Some(BOARD_SHUTTER.to_owned()),
                link: None,
                fade_in: 1.min(duration),
                fade_out: 2.min(duration),
                keyframes: Default::default(),
                person: None,
                content: ClipContent::Audio {
                    media: shutter.media.clone(),
                    source_in,
                    speed: 1.0,
                    volume_db: shutter.volume_db,
                    mutes: Vec::new(),
                },
            });
            shutters.push(at);
        }
    }
    Ok(json!({"clips": made, "end": start + total, "centred": centred, "shutters": shutters}))
}

/// The timeline marker an evidence board leaves on each photo's moment.
pub const BOARD_MARKER: &str = "board photo";
/// The name of an evidence board's own shutters.
const BOARD_SHUTTER: &str = "Evidence board · shutter";

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
    // The same transitions over and over (an edit went drop in, dip out on
    // every one of fourteen cut-ins): a run of four alike, or of eight
    // alternating between two, reads as a template.
    let mut cuts: Vec<(i64, &str)> = project
        .clips
        .iter()
        .filter_map(|clip| {
            let name = clip.name.as_deref()?;
            let kind = match name {
                "Dip" => "dip",
                "Flash" => "flash",
                "Drop" => "drop",
                _ if name.ends_with("vertical drop") => "drop",
                _ if name.to_lowercase().contains("glitch") => "glitch",
                _ => return None,
            };
            Some((clip.start + clip.duration / 2, kind))
        })
        .collect();
    cuts.sort_unstable();
    let mut at = 0;
    while at < cuts.len() {
        let alike = |period: usize| {
            let mut end = at + period;
            while end < cuts.len()
                && cuts.get(end).map(|cut| cut.1) == cuts.get(end - period).map(|cut| cut.1)
            {
                end += 1;
            }
            end
        };
        let (same, alternating) = (alike(1), alike(2));
        let end = if same - at >= 4 {
            same
        } else if alternating - at >= 8 {
            alternating
        } else {
            at += 1;
            continue;
        };
        let run = cuts.get(at..end).unwrap_or_default();
        let kinds: Vec<&str> = run.iter().take(2).map(|cut| cut.1).collect();
        issues.push(json!({"kind":"repetitive_transitions", "start":run.first().map(|cut| cut.0),
            "end":run.last().map(|cut| cut.0), "count":run.len(), "pattern":kinds.join(", "),
            "fix":"vary them for their moments: flash or shutter, crossfade, dip, drop (TRANSITIONS)"}));
        at = end;
    }
    // A found photo or still as plain B-roll (letterboxed, often): pictures
    // go on screen only inside a designed graphic (an evidence card or board).
    issues.extend(crate::graphics::bare_stills(project));
    // The date in a box or glowing: it's white with a drop shadow only.
    issues.extend(crate::graphics::date_drift(project));
    // A subtitle or intro caption on someone's face (faces found so far).
    issues.extend(crate::faces::text_on_faces(project));
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
    fn the_same_transitions_over_and_over_are_flagged() {
        let repeated = |kinds: &[&str]| {
            let mut p = project();
            let mut plan = vec![
                json!({"op":"add", "clip":{"type":"solid", "track":"v1", "start":0, "duration":3000, "fill":[0,0,0,1]}}),
            ];
            for (index, kind) in kinds.iter().enumerate() {
                plan.push(json!({"op":"transition", "kind":kind, "at":100 + index as i64 * 200}));
            }
            apply(&mut p, &plan).unwrap();
            audit(&p)["issues"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|issue| issue["kind"] == "repetitive_transitions")
                .cloned()
                .collect::<Vec<_>>()
        };
        // Drop in, dip out, cut-in after cut-in.
        let template = repeated(&["drop", "dip", "drop", "dip", "drop", "dip", "drop", "dip"]);
        assert_eq!(template.len(), 1);
        assert_eq!(template[0]["count"], 8);
        assert_eq!(repeated(&["dip", "dip", "dip", "dip"]).len(), 1);
        // Varied for their moments: nothing to say.
        assert!(
            repeated(&["drop", "dip", "flash", "drop", "dip", "dip", "flash", "drop"]).is_empty()
        );
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

    fn board_project(photos: usize) -> Project {
        let mut p = project();
        for index in 1..=photos {
            p.media.push(serde_json::from_value(json!({"id":format!("m{index}"),"name":"photo","path":"/p.jpg","kind":"image","duration":30.0,"width":1200,"height":900})).unwrap());
        }
        p
    }

    fn board_clip<'a>(p: &'a Project, name: &str) -> &'a Clip {
        p.clips
            .iter()
            .find(|clip| clip.name.as_deref() == Some(name))
            .unwrap()
    }

    /// The camera's speed (px a frame) at `frame` of a board element, from its
    /// x and y keyframes as the renderer samples them.
    fn board_speed(clip: &Clip, frame: f32) -> f32 {
        let at =
            |param: &str, frame: f32| edit_core::sample(&clip.keyframes[param], frame).unwrap();
        let step = 0.02;
        let dx = at("x", frame + step) - at("x", frame - step);
        let dy = at("y", frame + step) - at("y", frame - step);
        dx.hypot(dy) / (2.0 * step)
    }

    /// One continuous movement: never a stop, the speed smooth through every
    /// key, easing a little at each photo (`photos`: when each is centred) and
    /// picking up between, within ~0.5x-1.5x its average from first to last.
    fn assert_glides(clip: &Clip, photos: &[f32], end: f32) {
        let speed = |frame: f32| board_speed(clip, frame);
        if std::env::var_os("BOARD_PROFILE").is_some() {
            let profile: Vec<String> = (0..end as usize)
                .map(|frame| format!("{frame}:{:.1}", speed(frame as f32)))
                .collect();
            eprintln!("PROFILE {}", profile.join(" "));
        }
        for key in &clip.keyframes["x"] {
            if key.frame > 0.5 && key.frame < end - 0.5 {
                let (before, here, after) = (
                    speed(key.frame - 0.1),
                    speed(key.frame),
                    speed(key.frame + 0.1),
                );
                let jump = ((after - here) - (here - before)).abs();
                assert!(
                    jump < 0.05 + 0.01 * here,
                    "jolt at {}: {before}, {here}, {after}",
                    key.frame
                );
            }
        }
        // From one photo to the next it only eases a little and picks up a little.
        for pair in photos.windows(2) {
            let (from, to) = (pair[0], pair[1]);
            let speeds: Vec<f32> = (0..=((to - from) * 4.0) as usize)
                .map(|step| speed(from + step as f32 * 0.25))
                .collect();
            let average = speeds.iter().sum::<f32>() / speeds.len() as f32;
            let slowest = speeds.iter().copied().fold(f32::INFINITY, f32::min);
            let fastest = speeds.iter().copied().fold(0.0, f32::max);
            assert!(
                slowest > 0.5 * average && fastest < 1.35 * average,
                "{from}-{to}: {slowest} to {fastest}, average {average}"
            );
        }
        // Slowest as it passes each photo between the first and the last.
        for &at in &photos[1..photos.len() - 1] {
            assert!(
                speed(at) < speed(at - 3.0) && speed(at) < speed(at + 3.0),
                "not easing at the photo at {at}"
            );
        }
        // Before the first photo and after the last it drifts, never stops.
        for step in 0..(end as usize) {
            assert!(speed(step as f32 + 0.5) > 0.3, "stopped at {step}");
        }
    }

    #[test]
    fn an_evidence_board_glides_continuously_past_photos_centred_on_their_words() {
        let mut p = board_project(5);
        let ats = [139, 165, 185, 207, 243];
        let items: Vec<Value> = ats
            .iter()
            .enumerate()
            .map(|(index, at)| json!({"media": format!("m{}", index + 1), "label": "zip ties", "at": at}))
            .collect();
        let result = apply(
            &mut p,
            &[json!({"op":"evidence_board", "start":100, "end":346, "illustrative":true, "items":items})],
        )
        .unwrap();
        // Paper, five photos and notes, the vignette, "Illustrative images".
        assert_eq!(p.clips.len(), 13);
        assert_eq!(result.results[0]["end"], 346);
        assert_eq!(result.results[0]["centred"], json!(ats));
        for (index, at) in ats.iter().enumerate() {
            let photo = board_clip(&p, &format!("Evidence board · photo {}", index + 1));
            assert_eq!((photo.start, photo.duration), (100, 246));
            let frame = (at - 100) as f32;
            for param in ["x", "y"] {
                let value = edit_core::sample(&photo.keyframes[param], frame).unwrap();
                assert!(
                    value.abs() < 0.5,
                    "photo {index} {param} {value} at its word"
                );
            }
            assert_glides(photo, &[39.0, 65.0, 85.0, 107.0, 143.0], 246.0);
        }
        // Each note writes on as its photo comes in, moving with the board.
        let note = board_clip(&p, "Evidence board · note 2");
        assert_eq!(note.start, 165 - 8);
        let photo = board_clip(&p, "Evidence board · photo 2");
        let offset = |frame: f32, param: &str| {
            edit_core::sample(&note.keyframes[param], frame).unwrap()
                - edit_core::sample(&photo.keyframes[param], frame + 57.0).unwrap()
        };
        for frame in [5.0, 10.0, 40.0, 100.0, 188.0] {
            for param in ["x", "y"] {
                let (now, first) = (offset(frame, param), offset(0.0, param));
                assert!(
                    (now - first).abs() < 0.5,
                    "note drifts from its photo: {now} vs {first}"
                );
            }
        }
        // Nothing to flag but the empty timeline before the board.
        let issues = audit(&p)["issues"].as_array().unwrap().clone();
        assert!(
            issues
                .iter()
                .all(|issue| issue["kind"] == "picture_gap" && issue["end"] == 100),
            "{issues:?}"
        );
        // Every item needs at once one has it, in order.
        let mut bad = board_project(2);
        assert!(apply(&mut bad, &[json!({"op":"evidence_board", "start":0, "items":[{"media":"m1","at":10},{"media":"m2"}]})]).is_err());
        assert!(apply(&mut bad, &[json!({"op":"evidence_board", "start":0, "items":[{"media":"m1","at":30},{"media":"m2","at":20}]})]).is_err());
        assert!(apply(&mut bad, &[json!({"op":"evidence_board", "start":0, "end":20, "items":[{"media":"m1","at":10},{"media":"m2","at":30}]})]).is_err());
    }

    #[test]
    fn an_evidence_board_keeps_the_old_frames_timing() {
        let mut p = board_project(3);
        let result = apply(
            &mut p,
            &[json!({"op":"evidence_board", "start":0, "items":[
                {"media":"m1", "label":"accident?", "frames":60},
                {"media":"m2", "label":"arson?", "frames":60},
                {"media":"m3", "frames":60},
            ]})],
        )
        .unwrap();
        // Same length as before; each photo centred in the middle of its frames.
        assert_eq!(result.results[0]["end"], 60 * 3 + 30 * 2);
        assert_eq!(result.results[0]["centred"], json!([30, 120, 210]));
        assert_eq!(p.clips.len(), 7);
        let photo = board_clip(&p, "Evidence board · photo 2");
        let x = edit_core::sample(&photo.keyframes["x"], 120.0).unwrap();
        assert!(x.abs() < 0.5, "{x}");
        assert_glides(photo, &[30.0, 120.0, 210.0], 240.0);
        assert_eq!(board_clip(&p, "Evidence board · note 2").start, 120 - 12);
        assert!(audit(&p)["issues"].as_array().unwrap().is_empty());
    }

    #[test]
    fn an_evidence_board_marks_each_photo_and_lands_a_shutter_on_it() {
        let mut p = board_project(2);
        p.media.push(serde_json::from_value(json!({"id":"s1","name":"shutter-1.wav","path":"/s.wav","kind":"audio","duration":0.17,"markers":[{"time":0.085,"name":"hit"}]})).unwrap());
        // The cut's own shutter (with its flash) just before the first photo.
        p.clips.push(serde_json::from_value(json!({"id":"cut","track":"a5","type":"audio","media":"s1","name":"Shutter","start":97,"duration":5})).unwrap());
        let assets = Assets {
            shutter: Some(Shutter {
                media: "s1".into(),
                hit: 0.085,
                volume_db: -12.0,
            }),
            desktops: Vec::new(),
        };
        let board = json!({"op":"evidence_board", "start":96, "end":250, "items":[
            {"media":"m1","label":"Stripped mattress","at":104},
            {"media":"m2","label":"Bagged bedding","at":138}]});
        let result = apply_with(&mut p, std::slice::from_ref(&board), &assets).unwrap();
        // The first photo's shutter is the cut's (8 frames or less away); the second gets its own.
        assert_eq!(result.results[0]["shutters"], json!([138]));
        let own: Vec<&Clip> = p
            .clips
            .iter()
            .filter(|clip| clip.name.as_deref() == Some(BOARD_SHUTTER))
            .collect();
        assert_eq!(own.len(), 1);
        // Its click (0.085 s = 3 frames in) lands on the photo's frame.
        assert_eq!(own[0].start + 3, 138);
        assert_ne!(own[0].track, "a4");
        assert_eq!(crate::markers::frames(&p, BOARD_MARKER), vec![104, 138]);
        assert_eq!(p.markers[1].note, "Bagged bedding");
        // Rebuilt, it replaces its own shutters and marks rather than doubling them.
        apply_with(&mut p, &[board], &assets).unwrap();
        assert_eq!(
            p.clips
                .iter()
                .filter(|clip| clip.name.as_deref() == Some(BOARD_SHUTTER))
                .count(),
            1
        );
        assert_eq!(p.markers.len(), 2);
        // shutters: false places none.
        let mut quiet = board_project(1);
        let result = apply_with(&mut quiet, &[json!({"op":"evidence_board", "start":0, "shutters":false, "items":[{"media":"m1","at":20}]})], &assets).unwrap();
        assert_eq!(result.results[0]["shutters"], json!([]));
        assert_eq!(
            needs(&[json!({"op":"evidence_board", "shutters":false})]),
            Needs::default()
        );
    }

    #[test]
    fn a_desktop_profile_builds_a_valid_animated_screen() {
        let mut p = project();
        for (id, width, height) in [
            ("wall", 1920, 1080),
            ("pv", 575, 800),
            ("np", 972, 658),
            ("mug", 634, 730),
        ] {
            p.media.push(serde_json::from_value(json!({"id":id,"name":id,"path":format!("/{id}.png"),"kind":"image","duration":30.0,"width":width,"height":height})).unwrap());
        }
        let op = json!({"op":"desktop_profile", "start":300, "duration":180, "media":"mug",
            "lines":["36-year-old mother", "- Charged with murder"]});
        assert_eq!(
            needs(std::slice::from_ref(&op)).desktops,
            vec![("Photo Viewer".to_owned(), "Notepad".to_owned())]
        );
        // Without its pictures prepared it says so.
        assert!(apply(&mut p.clone(), std::slice::from_ref(&op)).is_err());
        let assets = Assets {
            shutter: None,
            desktops: vec![crate::desktop::Art {
                photo_title: "Photo Viewer".into(),
                notepad_title: "Notepad".into(),
                wallpaper: "wall".into(),
                photo_viewer: "pv".into(),
                notepad: "np".into(),
            }],
        };
        let result = apply_with(&mut p, &[op], &assets).unwrap();
        p.validate().unwrap();
        let report = &result.results[0];
        assert_eq!(report["end"], 480);
        assert_eq!(report["clips"].as_array().unwrap().len(), 6);
        let named = |name: &str| board_clip(&p, &format!("Desktop profile · {name}"));
        // The Photo Viewer comes in first, the Notepad a few frames later, each from 96%.
        let (viewer, notepad) = (named("photo viewer"), named("notepad"));
        assert!(viewer.start < notepad.start);
        let scale =
            |clip: &Clip, frame: f32| edit_core::sample(&clip.keyframes["scale"], frame).unwrap();
        let opacity =
            |clip: &Clip, frame: f32| edit_core::sample(&clip.keyframes["opacity"], frame).unwrap();
        assert!((scale(viewer, 0.0) / scale(viewer, 12.0) - 0.96).abs() < 0.01);
        assert!(opacity(viewer, 0.0) < 0.05 && opacity(viewer, 10.0) > 0.99);
        // Gone by the end, the Notepad first.
        let end = (480 - viewer.start - 1) as f32;
        assert!(opacity(viewer, end) < 0.05);
        let notepad_end = (480 - notepad.start - 1) as f32;
        assert!(opacity(notepad, notepad_end - 3.0) < opacity(viewer, end - 3.0));
        // The photo fills the content area: cropped to its shape, centred in it.
        let photo = named("photo");
        let ClipContent::Video { crop, .. } = &photo.content else {
            panic!("photo");
        };
        // (634 × 730 is wider than the 555 × 714 content area: its sides go.)
        assert!(crop.left > 0.0 && (crop.left - crop.right).abs() < 1e-6 && crop.top == 0.0);
        // The lines type on word by word, the second after the first; one "- " each.
        let notes = named("notes");
        let ClipContent::Text {
            text, word_times, ..
        } = &notes.content
        else {
            panic!("notes");
        };
        assert_eq!(text, "- 36-year-old mother\n- Charged with murder");
        assert_eq!(word_times.len(), 7);
        assert!(word_times[2] < word_times[3] && word_times[0] == 0.0);
        // The whole screen pushes in.
        let wall = named("wallpaper");
        assert!(scale(wall, 179.0) > scale(wall, 0.0) * 1.03);
        assert_eq!(crate::markers::frames(&p, "desktop window opens").len(), 2);
        assert!(audit(&p)["issues"]
            .as_array()
            .unwrap()
            .iter()
            .all(|issue| issue["kind"] == "picture_gap"));
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
