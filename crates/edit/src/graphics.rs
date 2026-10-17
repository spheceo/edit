//! House graphics built in one plan operation, so their look is right by
//! construction rather than rebuilt (and drifted) by hand each edit:
//! - `date_title`: the date cut-in's date, white with only a drop shadow
//!   (an edit came out with a 65% black box and a glow on it).
//! - `evidence_card`: a found photo on screen the house way, never as a
//!   bare still (an edit letterboxed a news photo as plain B-roll): the photo
//!   framed with a shadow over a dark blurred copy of itself filling the
//!   frame, easing in and slowly pushing in, with a clean label under it.
//!   cover_cut_in lays every picture shot out this way too.

use edit_core::{Clip, ClipContent, MediaKind, Project, TrackKind};
use serde_json::{json, Value};

/// The house drop shadow under white words on a picture (the date), at 1080p.
fn date_shadow(k: f64) -> Value {
    json!({"color": [0.0, 0.0, 0.0, 1.0], "opacity": 1.0, "distance": 6.0 * k, "angle": 112.0,
        "size": 10.0 * k, "blur": 20.0 * k})
}

/// The house label (the place label's look): white Geist 600 in an opaque
/// black box with a red border and a soft shadow.
pub fn label_style(k: f64) -> Value {
    json!({"font": "Geist", "weight": 600, "size": (44.0 * k).round(), "color": [1.0, 1.0, 1.0, 1.0],
        "glow": {"enabled": false},
        "background": {"color": [0.0, 0.0, 0.0, 1.0], "opacity": 1.0, "pad_x": 20.0 * k, "pad_y": 12.0 * k,
            "border": 2.0 * k, "border_color": [1.0, 0.1, 0.1, 1.0]},
        "shadow": {"color": [0.0, 0.0, 0.0, 1.0], "opacity": 0.85, "distance": 8.0 * k, "angle": 112.0,
            "size": 2.0 * k, "blur": 18.0 * k}})
}

fn push(project: &mut Project, made: &mut Vec<String>, fields: Value) -> Result<String, String> {
    let id = project.fresh_id("c");
    let mut fields = fields.as_object().cloned().ok_or("graphic clip")?;
    fields.insert("id".to_owned(), json!(id));
    let clip: Clip =
        serde_json::from_value(Value::Object(fields)).map_err(|error| format!("{error}"))?;
    project.clips.push(clip);
    made.push(id.clone());
    Ok(id)
}

/// `start`/`end` (or `duration`) of a graphic, frames.
fn span(args: &Value, what: &str) -> Result<(i64, i64), String> {
    let start = args["start"]
        .as_i64()
        .ok_or_else(|| format!("{what} needs start (frames)"))?
        .max(0);
    let end = match (args["end"].as_i64(), args["duration"].as_i64()) {
        (Some(end), _) => end,
        (None, Some(duration)) => start + duration,
        (None, None) => return Err(format!("{what} needs end or duration (frames)")),
    };
    if end - start < 6 {
        return Err(format!("{what} needs at least 6 frames"));
    }
    Ok((start, end))
}

/// The date cut-in's date, from
/// `{"op":"date_title","text":"July 22, 2023","start":F,"end":F}`: large
/// and centred, white Geist 600 (~120 at 1080p) with only the house drop
/// shadow (no box, no glow), rising in letter by letter and fading out 8
/// frames before `end`, over an adjustment that darkens the picture beneath
/// it heavily (fading in and out with it; `darken: false` leaves it out).
/// Each on a new track above everything there.
pub fn date_title(project: &mut Project, args: &Value) -> Result<Value, String> {
    let text = args["text"]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or("date_title needs text (\"July 22, 2023\")")?;
    let (start, end) = span(args, "date_title")?;
    let k = f64::from(project.settings.height) / 1080.0;
    let mut made = Vec::new();
    let darken = if args["darken"].as_bool().unwrap_or(true) {
        let track = project.add_track(TrackKind::Video);
        Some(push(
            project,
            &mut made,
            json!({"type": "adjustment", "name": "Date · darken", "track": track,
                "start": start, "duration": end - start, "fade_in": 6, "fade_out": 8,
                "grade": {"exposure": -1.4, "saturation": -0.3, "vignette": 0.5}}),
        )?)
    } else {
        None
    };
    let track = project.add_track(TrackKind::Video);
    let date = push(
        project,
        &mut made,
        json!({"type": "text", "name": "Date", "track": track, "start": start, "duration": end - start,
            "fade_out": 8, "text": text,
            "style": {"font": "Geist", "weight": 600, "size": (120.0 * k).round(),
                "color": [1.0, 1.0, 1.0, 1.0], "glow": {"enabled": false}, "background": null,
                "shadow": date_shadow(k)},
            "transform": {"x": 0.0, "y": 0.0},
            "animation": {"preset": "rise", "duration": 14.0, "stagger": 1.5}}),
    )?;
    Ok(json!({"date": date, "darken": darken}))
}

/// The map's place label, from `{"op":"place_label","text":"1091 Capitol
/// Avenue","start":F,"end":F,"map":"<the map's clip id>","building_track":[…]}`
/// (map_view's `building_track`, or `building` for a still): the house
/// label (white Geist 600 in an opaque black box with a red border and a
/// soft shadow) with its bottom ~30 px above the building, kept in frame,
/// pinned to it (x and y keyed at every tracked frame, linear), fading in
/// with the marker's reveal and out 8 frames before `end`.
pub fn place_label(project: &mut Project, args: &Value) -> Result<Value, String> {
    let text = args["text"]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or("place_label needs text (the street or place, no city or state)")?;
    let (start, end) = span(args, "place_label")?;
    let map = args["map"]
        .as_str()
        .and_then(|id| project.clip(id))
        .ok_or("place_label needs map: the map's clip id")?;
    let (map_start, source_in, speed) = match &map.content {
        ClipContent::Video {
            source_in, speed, ..
        } => (map.start, *source_in, *speed),
        _ => return Err("place_label: map must be the map's video clip".to_owned()),
    };
    let fps = project.fps();
    let k = f64::from(project.settings.height) / 1080.0;
    let (width, height) = (
        f64::from(project.settings.width),
        f64::from(project.settings.height),
    );
    let points: Vec<&Value> = match args["building_track"].as_array() {
        Some(track) if !track.is_empty() => track.iter().collect(),
        _ => vec![&args["building"]],
    };
    // The box: one line of 44 px words, 12 px padding above and below.
    let (box_w, box_h) = (
        text.chars().count() as f64 * 44.0 * k * 0.56 + 40.0 * k,
        44.0 * k * 1.15 + 24.0 * k,
    );
    let margin = 0.04 * height;
    let mut keys: Vec<(f64, f64, f64)> = Vec::new();
    for point in points {
        let (Some(x), Some(top)) = (point["x"].as_f64(), point["top"].as_f64()) else {
            continue;
        };
        // Footage frame → frames into the label.
        let footage = point["frame"].as_f64().unwrap_or(0.0);
        let at = map_start as f64 + (footage / fps - source_in) / speed * fps - start as f64;
        let y = (top - 30.0 * k - box_h / 2.0).max(-height / 2.0 + margin + box_h / 2.0);
        let x = x.clamp(
            -width / 2.0 + margin + box_w / 2.0,
            width / 2.0 - margin - box_w / 2.0,
        );
        keys.push((at, x, y));
    }
    if keys.is_empty() {
        return Err("place_label needs building_track (or building) from map_view".to_owned());
    }
    keys.sort_by(|a, b| a.0.total_cmp(&b.0));
    let last = (end - start - 1) as f64;
    // Where it is on its first frame (between the tracked points around it).
    let at = |frame: f64| -> (f64, f64) {
        let after = keys.iter().position(|key| key.0 >= frame);
        match after {
            Some(0) | None => {
                let key = if after.is_none() {
                    keys.last()
                } else {
                    keys.first()
                };
                key.map_or((0.0, 0.0), |key| (key.1, key.2))
            }
            Some(index) => {
                let (a, b) = (keys[index - 1], keys[index]);
                let t = (frame - a.0) / (b.0 - a.0).max(1e-6);
                (a.1 + (b.1 - a.1) * t, a.2 + (b.2 - a.2) * t)
            }
        }
    };
    let (x0, y0) = at(0.0);
    let mut xs = vec![json!({"frame": 0.0, "value": x0, "ease": "linear"})];
    let mut ys = vec![json!({"frame": 0.0, "value": y0, "ease": "linear"})];
    for &(frame, x, y) in keys.iter().filter(|key| key.0 > 0.0 && key.0 <= last) {
        xs.push(json!({"frame": frame, "value": x, "ease": "linear"}));
        ys.push(json!({"frame": frame, "value": y, "ease": "linear"}));
    }
    let track = project.add_track(TrackKind::Video);
    let mut made = Vec::new();
    let keyframes = if xs.len() > 1 {
        json!({"x": xs, "y": ys})
    } else {
        json!({})
    };
    let id = push(
        project,
        &mut made,
        json!({"type": "text", "name": "Place label", "track": track, "start": start,
            "duration": end - start, "fade_out": 8, "text": text, "style": label_style(k),
            "transform": {"x": x0, "y": y0}, "keyframes": keyframes,
            "animation": {"preset": "fade", "duration": 12.0}}),
    )?;
    Ok(json!(id))
}

/// Where an evidence card's layers go: each layer's track.
pub struct CardTracks {
    pub backdrop: String,
    pub blur: String,
    pub photo: String,
    pub label: String,
}

impl CardTracks {
    /// Four new tracks on top of everything (tidy_tracks packs them down).
    pub fn on_top(project: &mut Project) -> Self {
        Self {
            backdrop: project.add_track(TrackKind::Video),
            blur: project.add_track(TrackKind::Video),
            photo: project.add_track(TrackKind::Video),
            label: project.add_track(TrackKind::Video),
        }
    }
}

/// An evidence card (see the module notes) of image `media` from `start` to
/// `end`, named "<prefix>…"; returns its clips (backdrop, blur, photo, label).
pub fn card(
    project: &mut Project,
    media_id: &str,
    (start, end): (i64, i64),
    label: Option<&str>,
    tracks: &CardTracks,
    prefix: &str,
) -> Result<Vec<String>, String> {
    let media = project
        .media(media_id)
        .cloned()
        .ok_or_else(|| format!("no media {media_id}"))?;
    if media.kind != MediaKind::Image {
        return Err(format!(
            "{media_id} isn't a picture: an evidence card is for found photos and stills"
        ));
    }
    let (width, height) = (
        f64::from(project.settings.width),
        f64::from(project.settings.height),
    );
    let k = height / 1080.0;
    let (w, h) = (
        f64::from(media.width.max(1)),
        f64::from(media.height.max(1)),
    );
    let fit = (width / w).min(height / h);
    // The backdrop fills the frame (and a little more, so the blur's edges never show).
    let cover = (width / (w * fit)).max(height / (h * fit)) * 1.12;
    // The photo: as big as fits in ~68% of the height and ~70% of the width.
    let photo = (0.68 * height / (h * fit)).min(0.70 * width / (w * fit));
    let duration = end - start;
    let last = (duration - 1).max(1) as f64;
    let labelled = label.map(str::trim).filter(|label| !label.is_empty());
    // Room under the photo for its label.
    let y = if labelled.is_some() {
        -0.04 * height
    } else {
        0.0
    };
    let key =
        |frame: f64, value: f64, ease: &str| json!({"frame": frame, "value": value, "ease": ease});
    let settle = 10.0_f64.min(last / 2.0);
    let mut made = Vec::new();
    push(
        project,
        &mut made,
        json!({"type": "video", "name": format!("{prefix}backdrop"), "track": tracks.backdrop,
            "start": start, "duration": duration, "media": media_id, "source_in": 0.0,
            "transform": {"scale": cover},
            "keyframes": {"scale": [key(0.0, cover, "linear"), key(last, cover * 1.04, "linear")]}}),
    )?;
    push(
        project,
        &mut made,
        json!({"type": "adjustment", "name": format!("{prefix}blur"), "track": tracks.blur,
            "start": start, "duration": duration,
            "blur": {"radius": 38.0 * k},
            "grade": {"exposure": -1.3, "saturation": -0.5, "vignette": 0.6}}),
    )?;
    // The photo eases in (a little larger and fading up), then pushes in slowly.
    push(
        project,
        &mut made,
        json!({"type": "video", "name": format!("{prefix}photo"), "track": tracks.photo,
            "start": start, "duration": duration, "media": media_id, "source_in": 0.0,
            "fade_in": 8,
            "transform": {"scale": photo, "y": y, "rotation": -1.2},
            "frame": {"width": 14.0 * k, "color": [0.96, 0.96, 0.94, 1.0], "shadow": 0.65},
            "keyframes": {"scale": [key(0.0, photo * 0.94, "out"), key(settle, photo, "linear"),
                key(last, photo * 1.04, "linear")]}}),
    )?;
    if let Some(text) = labelled {
        let shown = h * fit * photo;
        let from = 8.min(duration / 3);
        push(
            project,
            &mut made,
            json!({"type": "text", "name": format!("{prefix}label"), "track": tracks.label,
                "start": start + from, "duration": duration - from, "fade_out": 6, "text": text,
                "style": label_style(k),
                "transform": {"x": 0.0, "y": y + shown / 2.0 + 64.0 * k},
                "animation": {"preset": "rise", "duration": 10.0, "stagger": 1.5}}),
        )?;
    }
    Ok(made)
}

/// `{"op":"evidence_card","media":"m4","start":F,"end":F,"label":"The building"}`
/// on new tracks above everything there.
pub fn evidence_card(project: &mut Project, args: &Value) -> Result<Value, String> {
    let media = args["media"]
        .as_str()
        .ok_or("evidence_card needs media (a picture's media id)")?;
    let (start, end) = span(args, "evidence_card")?;
    let tracks = CardTracks::on_top(project);
    let made = card(
        project,
        media,
        (start, end),
        args["label"].as_str(),
        &tracks,
        "Evidence card · ",
    )?;
    Ok(json!({"clips": made}))
}

/// Whether some clip above `clip` (a higher track) on screen with it makes a
/// picture part of a designed graphic: a framed photo (a card or a board),
/// a gradient (the outro's charges, a quote's layout) or a blur.
fn designed_over(project: &Project, clip: &Clip) -> bool {
    let level = |track: &str| project.tracks.iter().position(|own| own.id == track);
    let own = level(&clip.track);
    project.clips.iter().any(|other| {
        other.id != clip.id
            && level(&other.track) > own
            && other.start < clip.end()
            && clip.start < other.end()
            && match &other.content {
                ClipContent::Video { frame, .. } => frame.is_some(),
                ClipContent::Solid { gradient, .. } => gradient.is_some(),
                ClipContent::Adjustment { blur, .. } => !blur.is_off(),
                _ => false,
            }
    })
}

/// Pictures on screen as bare stills (the plan's audit): a found photo or a
/// still with no frame of its own and nothing designed over it, as plain
/// B-roll; `letterboxed` when it doesn't even fill the frame.
pub fn bare_stills(project: &Project) -> Vec<Value> {
    let (width, height) = (
        f64::from(project.settings.width),
        f64::from(project.settings.height),
    );
    let mut out = Vec::new();
    for clip in &project.clips {
        let ClipContent::Video {
            media,
            transform,
            frame: None,
            ..
        } = &clip.content
        else {
            continue;
        };
        let Some(media) = project
            .media(media)
            .filter(|media| media.kind == MediaKind::Image)
        else {
            continue;
        };
        if project.track(&clip.track).is_none_or(|track| track.hidden)
            || designed_over(project, clip)
        {
            continue;
        }
        let (w, h) = (
            f64::from(media.width.max(1)),
            f64::from(media.height.max(1)),
        );
        let smallest = clip
            .keyframes
            .get("scale")
            .and_then(|keys| keys.iter().map(|key| key.value).reduce(f32::min))
            .unwrap_or(transform.scale);
        let scale = f64::from(smallest) * (width / w).min(height / h);
        let (half_w, half_h) = (w * scale / 2.0, h * scale / 2.0);
        let letterboxed = f64::from(transform.x).abs() + width / 2.0 > half_w + 1.0
            || f64::from(transform.y).abs() + height / 2.0 > half_h + 1.0;
        out.push(
            json!({"kind": "bare_still", "clip": clip.id, "start": clip.start,
            "media": media.id, "letterboxed": letterboxed}),
        );
    }
    out
}

/// A date shown with a box or a glow (the date cut-in's date is white with
/// only a drop shadow): "July 22, 2023", "March 3rd, 2021".
pub fn date_drift(project: &Project) -> Vec<Value> {
    const MONTHS: [&str; 12] = [
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
    ];
    let mut out = Vec::new();
    for clip in &project.clips {
        let ClipContent::Text { text, style, .. } = &clip.content else {
            continue;
        };
        if style.label.is_some()
            || clip.name.as_deref().is_some_and(|name| {
                name.starts_with("Subtitle") || name.starts_with(crate::captions::CAPTION_PREFIX)
            })
            || text.chars().count() > 32
        {
            continue;
        }
        let lower = text.to_lowercase();
        let words: Vec<&str> = lower
            .split(|c: char| !c.is_alphanumeric())
            .filter(|word| !word.is_empty())
            .collect();
        let dated = words.iter().any(|word| MONTHS.contains(word))
            && words
                .iter()
                .any(|word| word.len() == 4 && word.chars().all(|c| c.is_ascii_digit()));
        let boxed = style
            .background
            .is_some_and(|background| background.opacity > 0.0);
        if dated && (boxed || style.glow.enabled) {
            out.push(
                json!({"kind": "date_style", "clip": clip.id, "start": clip.start,
                "boxed": boxed, "glow": style.glow.enabled,
                "fix": "white text, drop shadow only: rebuild it with the date_title op"}),
            );
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use edit_core::{Media, Settings};

    fn project() -> Project {
        let mut project = Project::new(
            "p".into(),
            "t".into(),
            Settings {
                width: 1920,
                height: 1080,
                fps: 30,
            },
        );
        let mut photo: Media = serde_json::from_value(json!({"id": "m1", "name": "news.jpg",
            "path": "/x/news.jpg", "kind": "image", "duration": 30.0, "width": 895, "height": 671}))
        .unwrap();
        photo.has_audio = false;
        project.media.push(photo);
        project
    }

    #[test]
    fn the_date_is_white_with_a_shadow_and_nothing_else() {
        let mut p = project();
        let made = date_title(
            &mut p,
            &json!({"text": "July 22, 2023", "start": 100, "end": 181}),
        )
        .unwrap();
        let date = p.clip(made["date"].as_str().unwrap()).unwrap();
        let ClipContent::Text {
            style, animation, ..
        } = &date.content
        else {
            panic!("not text");
        };
        assert!(style.background.is_none());
        assert!(!style.glow.enabled);
        let shadow = style.shadow.expect("a drop shadow");
        assert_eq!(
            (shadow.distance, shadow.size, shadow.blur, shadow.opacity),
            (6.0, 10.0, 20.0, 1.0)
        );
        assert_eq!(style.color, edit_core::Rgba::WHITE);
        assert_eq!(style.size, 120.0);
        assert_eq!(animation.preset, edit_core::TextPreset::Rise);
        // The darkening sits beneath it.
        let darken = p.clip(made["darken"].as_str().unwrap()).unwrap();
        let level = |id: &str| p.tracks.iter().position(|track| track.id == id);
        assert!(level(&darken.track) < level(&date.track));
        assert!(date_drift(&p).is_empty());
        p.validate().unwrap();
    }

    #[test]
    fn the_place_label_is_the_house_label_pinned_above_the_building() {
        let mut p = project();
        p.media.push(
            serde_json::from_value(json!({"id": "map", "name": "map.mp4", "path": "/x/map.mp4",
                "kind": "video", "duration": 9.0, "width": 1920, "height": 1080}))
            .unwrap(),
        );
        p.clips.push(
            serde_json::from_value(
                json!({"id": "m", "track": "v2", "start": 2034, "duration": 267,
                "type": "video", "media": "map"}),
            )
            .unwrap(),
        );
        // The label comes in with the reveal, 81 frames into the map.
        let track: Vec<Value> = (0..18)
            .map(|i| json!({"frame": i * 15, "x": 90.0 + i as f64, "top": -60.0 - i as f64}))
            .collect();
        let id = place_label(
            &mut p,
            &json!({"text": "1091 Capitol Avenue", "start": 2115, "end": 2301, "map": "m",
                "building_track": track}),
        )
        .unwrap();
        let label = p.clip(id.as_str().unwrap()).unwrap();
        let ClipContent::Text {
            style, transform, ..
        } = &label.content
        else {
            panic!();
        };
        let background = style.background.expect("a box");
        assert_eq!(
            (background.opacity, background.pad_x, background.border),
            (1.0, 20.0, 2.0)
        );
        assert!(!style.glow.enabled);
        assert_eq!(style.shadow.map(|shadow| shadow.opacity), Some(0.85));
        // On its first frame: between the points at 75 and 90 frames into the map.
        assert!((transform.x - 95.4).abs() < 0.01, "{}", transform.x);
        assert!(transform.y < -60.0 - 5.4 - 30.0);
        let xs = &label.keyframes["x"];
        assert_eq!(xs[0].frame, 0.0);
        assert_eq!(xs[1].frame, 9.0);
        p.validate().unwrap();
    }

    #[test]
    fn a_boxed_or_glowing_date_is_flagged() {
        let mut p = project();
        let made = date_title(
            &mut p,
            &json!({"text": "July 22, 2023", "start": 0, "duration": 81}),
        )
        .unwrap();
        let id = made["date"].as_str().unwrap().to_owned();
        if let Some(ClipContent::Text { style, .. }) = p.clip_mut(&id).map(|clip| &mut clip.content)
        {
            style.glow.enabled = true;
            style.background = Some(edit_core::TextBox {
                opacity: 0.65,
                ..Default::default()
            });
        }
        let flagged = date_drift(&p);
        assert_eq!(flagged.len(), 1);
        assert_eq!(flagged[0]["boxed"], true);
    }

    #[test]
    fn a_found_photo_is_a_card_never_a_bare_still() {
        let mut p = project();
        // As the edit had it: the 4:3 news photo at scale 1, plain B-roll.
        p.clips.push(
            serde_json::from_value(json!({"id": "c9", "track": "v1", "start": 0, "duration": 90,
                "type": "video", "media": "m1",
                "keyframes": {"scale": [{"frame": 0, "value": 1.0}, {"frame": 89, "value": 1.08}]}}))
            .unwrap(),
        );
        let flagged = bare_stills(&p);
        assert_eq!(flagged.len(), 1);
        assert_eq!(flagged[0]["letterboxed"], true);
        // As a card instead.
        p.clips.clear();
        let made = evidence_card(
            &mut p,
            &json!({"media": "m1", "start": 0, "end": 120, "label": "The building on Capitol Avenue"}),
        )
        .unwrap();
        assert_eq!(made["clips"].as_array().map(Vec::len), Some(4));
        assert!(bare_stills(&p).is_empty(), "{:?}", bare_stills(&p));
        // The photo fits inside the frame with its label under it, and the backdrop fills it.
        let photo = p
            .clips
            .iter()
            .find(|clip| clip.name.as_deref() == Some("Evidence card · photo"))
            .unwrap();
        let ClipContent::Video {
            transform, frame, ..
        } = &photo.content
        else {
            panic!();
        };
        assert!(frame.is_some());
        let fit = (1920.0_f32 / 895.0).min(1080.0 / 671.0);
        assert!(671.0 * fit * transform.scale * 1.04 < 1080.0 * 0.75);
        p.validate().unwrap();
        // Footage is never an evidence card.
        assert!(evidence_card(&mut p, &json!({"media": "m2", "start": 0, "end": 30})).is_err());
    }

    #[test]
    fn a_picture_picked_as_a_cut_in_shot_goes_on_as_a_card() {
        let mut p = project();
        p.media.push(
            serde_json::from_value(json!({"id": "m2", "name": "bodycam.mp4", "path": "/x/b.mp4",
                "kind": "video", "duration": 600.0, "width": 1920, "height": 1080, "has_audio": true}))
            .unwrap(),
        );
        p.clips.push(
            serde_json::from_value(
                json!({"id": "card", "track": "v1", "start": 300, "duration": 300,
                "type": "solid", "fill": [0.0, 0.0, 0.0, 1.0]}),
            )
            .unwrap(),
        );
        p.script = Some(edit_core::Script {
            source: None,
            blocks: vec![edit_core::ScriptBlock::Narration {
                text: "The building.".into(),
                notes: Vec::new(),
                clip: Some("card".into()),
                voiceover: None,
            }],
        });
        let (report, _) = crate::cutin::cover(
            &mut p,
            &json!({"cut_in": 1, "shots": [
                {"media": "m2", "source_in": 10.0},
                {"media": "m1", "source_in": 0.0, "at": 15.0, "label": "The building"}
            ]}),
        )
        .unwrap();
        assert_eq!(
            report["shots"][1]["evidence_card"].as_array().map(Vec::len),
            Some(4)
        );
        assert!(bare_stills(&p).is_empty(), "{:?}", bare_stills(&p));
        // The B-roll look greys the footage and the card's backdrop, under the photo.
        let level = |id: &str| p.tracks.iter().position(|track| track.id == id);
        let track_of = |suffix: &str| {
            p.clips
                .iter()
                .find(|clip| {
                    clip.name
                        .as_deref()
                        .is_some_and(|name| name.ends_with(suffix))
                })
                .map(|clip| level(&clip.track))
                .unwrap()
        };
        assert!(track_of("backdrop") < track_of("B-roll look"));
        assert!(track_of("B-roll look") < track_of("photo"));
        assert!(track_of("photo") < track_of("label"));
        p.validate().unwrap();
    }
}
