//! The "desktop" profile screen laid out on the timeline: a person's photo
//! in a dark Photo Viewer window and a few lines about them typed into a
//! Notepad window beside it, on a blue desktop with light beams, the whole
//! screen slowly pushing in. The pictures (wallpaper, window frames) are
//! drawn by `edit_engine::desktop` (re-exported here).

use edit_core::{Clip, Project, TrackKind};
use serde_json::{json, Value};

pub use edit_engine::desktop::*;

/// The window titles a desktop_profile operation asks for (defaults filled in).
pub fn titles(args: &Value) -> (String, String) {
    let title = |key: &str, default: &str| {
        args[key]
            .as_str()
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .unwrap_or(default)
            .chars()
            .take(60)
            .collect::<String>()
    };
    (
        title("photo_title", "Photo Viewer"),
        title("title", "Notepad"),
    )
}

/// One desktop's pictures, already the project's media.
#[derive(Clone, Debug)]
pub struct Art {
    pub photo_title: String,
    pub notepad_title: String,
    pub wallpaper: String,
    pub photo_viewer: String,
    pub notepad: String,
}

/// Window pop-in: frames to scale up, and the scale it starts from.
const POP: f64 = 12.0;
const POP_FROM: f64 = 0.96;
/// ...and the fade with it.
const POP_FADE: f64 = 8.0;
/// The push-in over the whole screen.
const PUSH: f64 = 0.035;
/// The windows leave over this many frames at the end.
const EXIT: f64 = 8.0;

/// The whole profile screen in one go:
/// `{"op":"desktop_profile","start":F,"duration":F,"media":"m1","lines":["36-year-old mother","Charged with …"]}`
/// (`end` instead of duration; `title` names the Notepad window ("Notepad"),
/// `photo_title` the Photo Viewer's; `line_at` the timeline frame each line types
/// on (default: one after another across the first ~60%); `exit: false`
/// keeps the windows to the last frame). The wallpaper fills the frame; the
/// Photo Viewer scales and fades up from 96% a few frames in, the Notepad a
/// few frames later; each line types on word by word; the whole screen
/// pushes in slowly; the windows shrink and fade away over the last 8 frames.
pub fn profile(project: &mut Project, args: &Value, art: &Art) -> Result<Value, String> {
    let start = args["start"]
        .as_i64()
        .ok_or("desktop_profile needs start (frames)")?
        .max(0);
    let duration = match (args["duration"].as_i64(), args["end"].as_i64()) {
        (Some(duration), _) => duration,
        (None, Some(end)) => end - start,
        _ => return Err("desktop_profile needs duration or end (frames)".to_owned()),
    };
    let fps_scale = project.fps() / 30.0;
    if (duration as f64) < 60.0 * fps_scale {
        return Err("desktop_profile needs at least 2 seconds to read".to_owned());
    }
    let photo = args["media"]
        .as_str()
        .ok_or("desktop_profile needs media (the person's photo: an image or video media id)")?;
    let photo = project
        .media(photo)
        .cloned()
        .ok_or_else(|| format!("no media {photo}"))?;
    let lines: Vec<String> = args["lines"]
        .as_array()
        .map(|lines| {
            lines
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(|line| {
                    if line.starts_with('-') || line.starts_with('•') {
                        line.to_owned()
                    } else {
                        format!("- {line}")
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    if lines.is_empty() || lines.len() > 6 {
        return Err("desktop_profile needs lines: 1 to 6 short lines about the person (as a source states them)".to_owned());
    }
    let layout = Layout::new(project.settings.width, project.settings.height);
    let k = layout.k;
    let total = duration as f64;
    let pop = POP * fps_scale;
    let fade = POP_FADE * fps_scale;
    let exit = if args["exit"].as_bool().unwrap_or(true) {
        EXIT * fps_scale
    } else {
        0.0
    };
    // When each window comes in (frames into the profile).
    let photo_in = (4.0 * fps_scale).round();
    let notepad_in = (10.0 * fps_scale).round();
    let first_line = notepad_in + pop + 2.0 * fps_scale;
    let line_at: Vec<f64> = match args["line_at"].as_array() {
        Some(at) => {
            if at.len() != lines.len() {
                return Err(format!(
                    "desktop_profile: line_at needs one frame per line ({} lines)",
                    lines.len()
                ));
            }
            at.iter()
                .map(|frame| {
                    frame
                        .as_i64()
                        .map(|frame| ((frame - start) as f64).clamp(first_line, total - exit - 1.0))
                        .ok_or("desktop_profile: line_at must be frames".to_owned())
                })
                .collect::<Result<_, _>>()?
        }
        None => {
            let last = (0.6 * total).max(first_line);
            let step = if lines.len() > 1 {
                ((last - first_line) / (lines.len() - 1) as f64).max(12.0 * fps_scale)
            } else {
                0.0
            };
            (0..lines.len())
                .map(|index| {
                    (first_line + step * index as f64)
                        .min(total - exit - 1.0)
                        .round()
                })
                .collect()
        }
    };
    let push = |frame: f64| 1.0 + PUSH * (frame / total).clamp(0.0, 1.0);
    let ease_out = |t: f64| 1.0 - (1.0 - t.clamp(0.0, 1.0)).powi(3);
    let ease_in = |t: f64| t.clamp(0.0, 1.0).powi(3);
    // A window's scale and opacity at a frame of the profile.
    let window_state = |enter: f64, leave: f64, frame: f64| -> (f64, f64) {
        if frame >= leave && exit > 0.0 {
            let t = (frame - leave) / exit;
            (1.0 - (1.0 - 0.97) * ease_in(t), 1.0 - ease_in(t))
        } else {
            let t = (frame - enter) / pop;
            (
                POP_FROM + (1.0 - POP_FROM) * ease_out(t),
                ease_out((frame - enter) / fade),
            )
        }
    };
    // The frames keys go on: every frame while a window moves, the ends of
    // the steady push between.
    let key_frames = |enter: f64, leave: f64| -> Vec<f64> {
        let mut frames: Vec<f64> = (0..=pop.ceil() as i64)
            .map(|step| enter + step as f64)
            .collect();
        if exit > 0.0 {
            frames.extend((0..=exit.ceil() as i64).map(|step| leave + step as f64));
        }
        frames.push(total - 1.0);
        frames.retain(|frame| *frame >= enter && *frame <= total - 1.0);
        frames.sort_by(f64::total_cmp);
        frames.dedup();
        frames
    };
    let key = |frame: f64, value: f64| json!({"frame": frame, "value": value, "ease": "linear"});
    // Keyframes for an element at (ex, ey) (centre offsets) and base scale,
    // in a window whose centre is (gx, gy) and which enters/leaves then
    // (on screen from `from`: its clip's first frame).
    let animated = |(ex, ey): (f64, f64),
                    scale: f64,
                    (gx, gy): (f64, f64),
                    enter: f64,
                    leave: f64,
                    from: f64|
     -> Value {
        let (mut xs, mut ys, mut ss, mut os) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        for frame in key_frames(enter.max(from), leave) {
            let (s, o) = window_state(enter, leave, frame);
            let p = push(frame);
            let local = frame - from;
            xs.push(key(local, p * (gx + (ex - gx) * s)));
            ys.push(key(local, p * (gy + (ey - gy) * s)));
            ss.push(key(local, scale * p * s));
            os.push(key(local, o));
        }
        json!({"x": xs, "y": ys, "scale": ss, "opacity": os})
    };
    let mut made = Vec::new();
    let mut add = |project: &mut Project, fields: Value| -> Result<String, String> {
        let id = project.fresh_id("c");
        let mut fields = fields.as_object().cloned().ok_or("desktop clip")?;
        fields.insert("id".to_owned(), json!(id));
        fields.insert(
            "track".to_owned(),
            json!(project.add_track(TrackKind::Video)),
        );
        let clip: Clip = serde_json::from_value(Value::Object(fields))
            .map_err(|error| format!("desktop_profile: {error}"))?;
        project.clips.push(clip);
        made.push(id.clone());
        Ok(id)
    };
    // An image shown at its own pixel size times `zoom`: its scale.
    let native = |media: &edit_core::Media, zoom: f64| -> f64 {
        let (w, h) = (
            f64::from(media.width.max(1)),
            f64::from(media.height.max(1)),
        );
        zoom / (layout.width / w).min(layout.height / h)
    };
    let media_of = |id: &str| {
        project
            .media(id)
            .cloned()
            .ok_or_else(|| format!("desktop art {id} is missing"))
    };
    let (wallpaper, photo_viewer, notepad) = (
        media_of(&art.wallpaper)?,
        media_of(&art.photo_viewer)?,
        media_of(&art.notepad)?,
    );
    // The wallpaper: the whole frame, pushing in.
    let cover = {
        let (w, h) = (
            f64::from(wallpaper.width.max(1)),
            f64::from(wallpaper.height.max(1)),
        );
        let fit = (layout.width / w).min(layout.height / h);
        (layout.width / (w * fit)).max(layout.height / (h * fit))
    };
    add(
        project,
        json!({"type": "video", "name": "Desktop profile · wallpaper", "media": wallpaper.id,
        "source_in": 0.0, "start": start, "duration": duration,
        "keyframes": {"scale": [key(0.0, cover), key(total - 1.0, cover * push(total - 1.0))]}}),
    )?;
    // Gone on the last frame, the Notepad a few frames before the Photo Viewer.
    let leave_photo = total - 1.0 - exit;
    let leave_notepad = leave_photo - (3.0 * fps_scale).round().min(exit);
    let notepad_exit = if exit > 0.0 { leave_notepad } else { total };
    let centre_of = |[x, y, w, h]: [f64; 4]| layout.centred(x + w / 2.0, y + h / 2.0);
    // The Photo Viewer and the photo in it (cropped to fill its content area).
    let pv_rect = layout.window(Window::PhotoViewer);
    let pv_centre = centre_of(pv_rect);
    let clip_from = |enter: f64| enter.round() as i64;
    add(
        project,
        json!({"type": "video", "name": "Desktop profile · photo viewer", "media": photo_viewer.id,
        "source_in": 0.0, "start": start + clip_from(photo_in), "duration": duration - clip_from(photo_in),
        "frame": {"width": 0.0, "shadow": 0.6},
        "keyframes": animated(pv_centre, native(&photo_viewer, 1.0), pv_centre, photo_in, leave_photo, photo_in)}),
    )?;
    let [cx, cy, cw, ch] = layout.content(Window::PhotoViewer);
    let (pw, ph) = (
        f64::from(photo.width.max(1)),
        f64::from(photo.height.max(1)),
    );
    let fit = (layout.width / pw).min(layout.height / ph);
    let (crop, scale) = if pw / ph > cw / ch {
        let side = (1.0 - (cw / ch) / (pw / ph)) / 2.0;
        (json!({"left": side, "right": side}), ch / (ph * fit))
    } else {
        let side = (1.0 - (pw / ph) / (cw / ch)) / 2.0;
        (json!({"top": side, "bottom": side}), cw / (pw * fit))
    };
    add(
        project,
        json!({"type": "video", "name": "Desktop profile · photo", "media": photo.id,
        "source_in": 0.0, "start": start + clip_from(photo_in), "duration": duration - clip_from(photo_in),
        "crop": crop,
        "keyframes": animated(layout.centred(cx + cw / 2.0, cy + ch / 2.0), scale, pv_centre, photo_in, leave_photo, photo_in)}),
    )?;
    // The Notepad and its lines.
    let np_centre = centre_of(layout.window(Window::Notepad));
    add(
        project,
        json!({"type": "video", "name": "Desktop profile · notepad", "media": notepad.id,
        "source_in": 0.0, "start": start + clip_from(notepad_in), "duration": duration - clip_from(notepad_in),
        "frame": {"width": 0.0, "shadow": 0.6},
        "keyframes": animated(np_centre, native(&notepad, 1.0), np_centre, notepad_in, notepad_exit, notepad_in)}),
    )?;
    let text = lines.join("\n");
    let size = LINE_SIZE * k;
    let line_height = LINE_STEP / LINE_SIZE;
    let (block_w, block_h) = text_block(&text, size, 400, line_height);
    let [nx, ny, _, _] = layout.content(Window::Notepad);
    let text_centre = layout.centred(nx + 12.0 * k + block_w / 2.0, ny + 22.0 * k + block_h / 2.0);
    let text_from = line_at.first().copied().unwrap_or(first_line).floor();
    // Each line's words a couple of frames apart, from its frame.
    let word_times: Vec<f64> = lines
        .iter()
        .zip(&line_at)
        .flat_map(|(line, at)| {
            line.split_whitespace()
                .enumerate()
                .map(move |(index, _)| at - text_from + index as f64 * 2.0 * fps_scale)
        })
        .collect();
    add(
        project,
        json!({"type": "text", "name": "Desktop profile · notes", "text": text,
        "start": start + text_from as i64, "duration": duration - text_from as i64,
        "style": {"font": "Geist", "weight": 400, "size": size, "color": [0.93, 0.93, 0.93, 1.0],
            "line_height": line_height, "align": "left",
            "glow": {"enabled": true, "radius": 10.0 * k, "strength": 0.3}},
        "transform": {"x": text_centre.0, "y": text_centre.1},
        "animation": {"preset": "words", "duration": 1.0, "stagger": 2.0},
        "word_times": word_times,
        "keyframes": animated(text_centre, 1.0, np_centre, notepad_in, notepad_exit, text_from)}),
    )?;
    // The film look over all of it: a vignette, a touch less colour.
    add(
        project,
        json!({"type": "adjustment", "name": "Desktop profile · film", "start": start, "duration": duration,
        "grade": {"vignette": 0.42, "saturation": -0.12, "contrast": 0.06}}),
    )?;
    // Moments to put sounds on (a soft click as each window opens).
    for enter in [photo_in, notepad_in] {
        crate::markers::add_timeline(project, start + enter as i64, "desktop window opens", "");
    }
    for (line, at) in lines.iter().zip(&line_at) {
        crate::markers::add_timeline(project, start + *at as i64, "desktop line", line);
    }
    let lines_at: Vec<i64> = line_at.iter().map(|at| start + *at as i64).collect();
    Ok(
        json!({"clips": made, "end": start + duration, "lines_at": lines_at,
        "windows_open": [start + photo_in as i64, start + notepad_in as i64]}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Renders a profile to PNGs for eyeballing against the reference:
    /// `DESKTOP_PHOTO=<image or video> DESKTOP_OUT=<dir> cargo test -p edit
    /// desktop::tests::render_a_profile -- --ignored`.
    #[test]
    #[ignore = "needs a GPU and a photo"]
    fn render_a_profile() {
        let photo = std::env::var("DESKTOP_PHOTO").expect("DESKTOP_PHOTO");
        let out = PathBuf::from(std::env::var("DESKTOP_OUT").expect("DESKTOP_OUT"));
        std::fs::create_dir_all(&out).unwrap();
        let mut project = Project::new(
            "desktop-test".into(),
            "desktop".into(),
            edit_core::Settings {
                width: 1920,
                height: 1080,
                fps: 30,
            },
        );
        let home = out.join("home");
        let (photo_title, notepad_title) = titles(&json!({}));
        let paths = files(&home, 1920, 1080, &photo_title, &notepad_title).unwrap();
        let mut ids = Vec::new();
        for path in paths.iter().chain(std::iter::once(&PathBuf::from(&photo))) {
            let probe = crate::media::probe(path).unwrap();
            let id = project.fresh_id("m");
            project.media.push(edit_core::Media {
                id: id.clone(),
                name: path.file_name().unwrap().to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                kind: probe.kind,
                duration: probe.duration,
                width: probe.width,
                height: probe.height,
                fps: probe.fps,
                has_audio: false,
                markers: Vec::new(),
                cloud: None,
            });
            ids.push(id);
        }
        let assets = crate::edit_plan::Assets {
            shutter: None,
            desktops: vec![Art {
                photo_title,
                notepad_title,
                wallpaper: ids[0].clone(),
                photo_viewer: ids[1].clone(),
                notepad: ids[2].clone(),
            }],
        };
        let result = crate::edit_plan::apply_with(
            &mut project,
            &[
                json!({"op":"desktop_profile", "start":0, "duration":180, "media":ids[3],
                "lines":["36-year-old mother", "Charged with murder", "Abuse of a corpse"]}),
            ],
            &assets,
        )
        .unwrap();
        eprintln!("{}", result.results[0]);
        let frames: Vec<i64> = std::env::var("DESKTOP_FRAMES")
            .ok()
            .map(|frames| frames.split(',').filter_map(|f| f.parse().ok()).collect())
            .unwrap_or_else(|| vec![0, 6, 12, 20, 40, 100, 150, 175]);
        let renderer = crate::render::FrameRenderer::start(out.join("cache"));
        let images = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(renderer.render(project, frames.clone(), 0))
            .unwrap();
        for (frame, image) in frames.iter().zip(images) {
            std::fs::write(
                out.join(format!("frame-{frame:03}.png")),
                crate::render::encode_png(&image).unwrap(),
            )
            .unwrap();
        }
    }
}
