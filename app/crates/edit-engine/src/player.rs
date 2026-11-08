//! The native preview (docs/plans/2026-11-06-native-player.md): the edit drawn
//! in Edit.app's window by the engine itself, not in the page. The page's
//! preview decoded every picture in WebCodecs workers and drew it with this
//! same renderer compiled to WebAssembly (crates/edit-wasm); here the pictures
//! come from the Mac's video decoder through the export's readers (a reader
//! just behind a frame decodes forward, anything else seeks), and the frame is
//! presented onto a Core Animation layer under the page. It draws exactly what
//! the page's engine drew: the same scene (`evaluate_seen`), the same
//! compositor, the same letterbox, black around it; the colours are the
//! export's, as its pictures are decoded as the export decodes them.
//!
//! The page still owns the playhead, the sound and everything drawn over the
//! picture; it asks for a frame and hears when it's drawn.
//!
//! The page sends the edit whole once (`set_project`) and then only what
//! changed (`apply_patch`, the page's lib/patch.ts): a drag on Cops Realize
//! sent its 2.4 MB ten times a second, 26 MB/s through the window's IPC, each
//! parsed again here (Nov 8). Every update carries the page's revision, and
//! the player answers with the one it now draws, or why it refused: a refused
//! update leaves the last one on screen, and the page has to know.

use std::collections::HashMap;
use std::ffi::c_void;
use std::path::PathBuf;

use edit_core::{evaluate_seen, Project};
use edit_render::{text::BUNDLED_FONTS, wgpu, Renderer};
use serde::Deserialize;
use serde_json::Value;

use crate::render::{decode_stats, feed_peaks, PreviewPictures};

/// Where one drawn frame's time went, in milliseconds (the decoders' share by kind in `decoders`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DrawTimes {
    pub evaluate: f64,
    pub decode: f64,
    pub upload: f64,
    pub composite: f64,
    pub present: f64,
    pub layers: usize,
    pub decoders: decode_stats::Taken,
}

pub struct Player {
    renderer: Renderer,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    pictures: PreviewPictures,
    project: Option<Project>,
    /// The project as the page sent it (patches apply to this), and the page's revision of it.
    value: Option<Value>,
    revision: u64,
    /// What each media is decoded from: its preview file on this Mac, else a URL the server answers.
    sources: HashMap<String, PathBuf>,
    /// The media cache: waveforms' sound levels.
    cache: PathBuf,
    /// The frame on screen, and whether the project or size changed since.
    drawn: Option<i64>,
    /// The last frame drawn's timings (None when the last ask needed no drawing).
    pub last: Option<DrawTimes>,
}

impl Player {
    /// A player drawing into `layer`, `width`×`height` pixels.
    ///
    /// # Safety
    /// `layer` is a `CAMetalLayer` that outlives the player.
    pub unsafe fn new(layer: *mut c_void, width: u32, height: u32) -> Result<Self, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        // SAFETY: the caller keeps the layer alive for as long as the player.
        let surface = unsafe {
            instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(layer))
        }
        .map_err(|error| format!("the window's picture layer: {error}"))?;
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
            apply_limit_buckets: false,
        }))
        .map_err(|error| format!("no GPU for the preview: {error}"))?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("edit preview"),
            required_limits: wgpu::Limits::default().using_resolution(adapter.limits()),
            ..Default::default()
        }))
        .map_err(|error| format!("GPU device: {error}"))?;
        let caps = surface.get_capabilities(&adapter);
        let (Some(&first), Some(&alpha_mode)) = (caps.formats.first(), caps.alpha_modes.first())
        else {
            return Err("this GPU can't draw the preview".to_owned());
        };
        // Pixels are already sRGB-encoded, so present through a non-sRGB view (as the page's canvas).
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|format| !format.is_srgb())
            .unwrap_or(first);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: width.max(1),
            height: height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 1,
            alpha_mode,
            view_formats: vec![],
            color_space: wgpu::SurfaceColorSpace::Auto,
        };
        surface.configure(&device, &config);
        let mut renderer = Renderer::new(device, queue, 1920, 1080);
        for (family, weight, file) in BUNDLED_FONTS {
            if let Some(bytes) = edit_render::text::bundled_font_bytes(file) {
                renderer.fonts_mut().add(family, *weight, bytes)?;
            }
        }
        Ok(Self {
            renderer,
            surface,
            config,
            pictures: PreviewPictures::new(),
            project: None,
            value: None,
            revision: 0,
            sources: HashMap::new(),
            cache: PathBuf::new(),
            drawn: None,
            last: None,
        })
    }

    /// The edit to draw (the page's JSON, as its engine takes it) at the
    /// page's `revision`, what each media is decoded from, the local
    /// excerpts of streamed ones (`crate::excerpts`: a pieced proxy's pieces
    /// on this Mac), and the media cache. Refused, the last edit stays.
    pub fn set_project(
        &mut self,
        json: &str,
        revision: u64,
        sources: HashMap<String, String>,
        excerpts: HashMap<String, Vec<crate::excerpts::Excerpt>>,
        cache: PathBuf,
    ) -> Result<u64, String> {
        let value: Value = serde_json::from_str(json).map_err(|error| error.to_string())?;
        let project = Project::deserialize(&value).map_err(|error| error.to_string())?;
        project.validate()?;
        let sources: HashMap<String, PathBuf> = sources
            .into_iter()
            .map(|(media, path)| (media, PathBuf::from(path)))
            .collect();
        for (media, list) in excerpts {
            if let Some(object) = sources
                .get(&media)
                .and_then(|path| crate::excerpts::object_of(path))
            {
                crate::excerpts::add(&object, list);
            }
        }
        // A media decoded from another file now: its readers of the old one go.
        if sources != self.sources {
            self.pictures.clear();
        }
        self.sources = sources;
        self.cache = cache;
        self.take(project, value, revision);
        Ok(revision)
    }

    /// What changed since `base` (the page's lib/patch.ts), making `revision`.
    /// Refused when the player isn't at `base` or the patch doesn't fit: the
    /// page sends the whole edit then.
    pub fn apply_patch(&mut self, base: u64, revision: u64, patch: &str) -> Result<u64, String> {
        if self.revision != base || self.value.is_none() {
            return Err(format!(
                "the window has revision {}, not {base}",
                self.revision
            ));
        }
        let patch: Value = serde_json::from_str(patch).map_err(|error| error.to_string())?;
        // Applied in place; refused, the window has no edit to patch until the next whole one.
        let mut value = self.value.take().unwrap_or(Value::Null);
        apply(&mut value, &patch)?;
        if let Some(project) = self.project.as_mut().filter(|_| only_clips(&patch)) {
            // A drag, a trim, a title typed: the clips that changed, not the whole edit parsed again
            // (2.4 MB of Cops Realize took 22 ms a patch that way, Nov 8).
            let clips = project.clips.clone();
            if let Err(error) = patch_clips(project, &patch).and_then(|()| project.validate()) {
                project.clips = clips;
                return Err(error);
            }
            if let Some(next) = patch.pointer("/set/next_id").and_then(Value::as_u64) {
                project.next_id = next;
            }
            self.value = Some(value);
            self.revision = revision;
            self.drawn = None;
            return Ok(revision);
        }
        let project = Project::deserialize(&value).map_err(|error| error.to_string())?;
        project.validate()?;
        self.take(project, value, revision);
        Ok(revision)
    }

    /// The revision on screen (0: none yet).
    pub fn revision(&self) -> u64 {
        self.revision
    }

    fn take(&mut self, project: Project, value: Value, revision: u64) {
        if self.project.as_ref().map(|old| &old.id) != Some(&project.id) {
            self.renderer.clear_peaks();
            self.pictures.clear();
        }
        self.renderer
            .resize(project.settings.width, project.settings.height);
        self.project = Some(project);
        self.value = Some(value);
        self.revision = revision;
        self.drawn = None;
    }

    /// The layer's size in pixels changed.
    pub fn resize(&mut self, width: u32, height: u32) {
        let (width, height) = (width.max(1), height.max(1));
        if (width, height) == (self.config.width, self.config.height) {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(self.renderer.device(), &self.config);
        self.drawn = None;
    }

    /// Draws `frame`, unless it's on screen already (nothing changed since).
    pub fn draw(&mut self, frame: i64) -> Result<(), String> {
        self.last = None;
        if self.drawn == Some(frame) {
            return Ok(());
        }
        let Some(project) = &self.project else {
            return Err("no edit to draw yet".to_owned());
        };
        let ms = |since: std::time::Instant| since.elapsed().as_secs_f64() * 1000.0;
        let mut times = DrawTimes::default();
        let started = std::time::Instant::now();
        decode_stats::take();
        let scene = evaluate_seen(project, frame);
        times.evaluate = ms(started);
        // Decoded no bigger than it's shown: the edit's size fitted into the layer.
        let (width, height) = (
            project.settings.width.max(1),
            project.settings.height.max(1),
        );
        let fit = (self.config.width as f32 / width as f32)
            .min(self.config.height as f32 / height as f32)
            .min(1.0);
        let shown = (
            ((width as f32 * fit).round() as u32).max(2),
            ((height as f32 * fit).round() as u32).max(2),
        );
        let started = std::time::Instant::now();
        let pictures = self.pictures.decode(project, &scene, shown, &self.sources);
        times.decoders = decode_stats::take();
        let pictures = pictures?;
        times.decode = ms(started);
        times.layers = pictures.len();
        let started = std::time::Instant::now();
        for (clip, width, height, pixels) in &pictures {
            self.renderer
                .upload_video(clip, *width, *height, pixels, true);
        }
        feed_peaks(&mut self.renderer, project, &scene, &self.cache);
        times.upload = ms(started);
        let started = std::time::Instant::now();
        self.renderer.render(&scene);
        times.composite = ms(started);
        let started = std::time::Instant::now();
        self.present()?;
        times.present = ms(started);
        self.drawn = Some(frame);
        self.last = Some(times);
        Ok(())
    }

    /// The last frame drawn, letterboxed into the layer as the page's canvas was (crates/edit-wasm `present`).
    fn present(&mut self) -> Result<(), String> {
        let texture = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(texture)
            | wgpu::CurrentSurfaceTexture::Suboptimal(texture) => texture,
            other => {
                self.surface.configure(self.renderer.device(), &self.config);
                return Err(format!("the preview's surface: {other:?}"));
            }
        };
        let view = texture
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let (width, height) = self.renderer.size();
        let (cw, ch) = (self.config.width as f32, self.config.height as f32);
        let fit = (cw / width as f32).min(ch / height as f32);
        let w = (width as f32 * fit).round().min(cw);
        let h = (height as f32 * fit).round().min(ch);
        let viewport = [((cw - w) / 2.0).floor(), ((ch - h) / 2.0).floor(), w, h];
        self.renderer
            .present(&view, self.config.format, viewport, wgpu::Color::BLACK);
        self.renderer.queue().present(texture);
        Ok(())
    }

    /// Lets go of the decoders (the preview is hidden); they open again on the next frame.
    pub fn rest(&mut self) {
        self.pictures.clear();
        self.drawn = None;
    }
}

/// Whether `patch` changes nothing but clips (and the next id handed out).
fn only_clips(patch: &Value) -> bool {
    let set_ok = patch
        .get("set")
        .and_then(Value::as_object)
        .is_none_or(|set| set.keys().all(|key| key == "next_id"));
    let unset_ok = patch
        .get("unset")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty);
    let lists_ok = patch
        .get("lists")
        .and_then(Value::as_object)
        .is_none_or(|lists| lists.keys().all(|key| key == "clips"));
    set_ok && unset_ok && lists_ok
}

/// A clips-only patch into the parsed project's clips, as `apply` does to the JSON.
fn patch_clips(project: &mut Project, patch: &Value) -> Result<(), String> {
    let Some(change) = patch.pointer("/lists/clips") else {
        return Ok(());
    };
    let strings = |field: &str| -> Vec<String> {
        change
            .get(field)
            .and_then(Value::as_array)
            .map(|all| {
                all.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    let gone: std::collections::HashSet<String> = strings("remove").into_iter().collect();
    project.clips.retain(|clip| !gone.contains(&clip.id));
    let mut at: HashMap<String, usize> = project
        .clips
        .iter()
        .enumerate()
        .map(|(index, clip)| (clip.id.clone(), index))
        .collect();
    for item in change
        .get("put")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let clip = edit_core::Clip::deserialize(item).map_err(|error| error.to_string())?;
        match at.get(&clip.id) {
            Some(&index) => {
                if let Some(slot) = project.clips.get_mut(index) {
                    *slot = clip;
                }
            }
            None => {
                at.insert(clip.id.clone(), project.clips.len());
                project.clips.push(clip);
            }
        }
    }
    if change.get("order").is_some() {
        let order = strings("order");
        if order.len() != project.clips.len() || order.iter().any(|one| !at.contains_key(one)) {
            return Err("clips' new order doesn't match its items".to_owned());
        }
        let mut clips: HashMap<String, edit_core::Clip> = project
            .clips
            .drain(..)
            .map(|clip| (clip.id.clone(), clip))
            .collect();
        project.clips = order.iter().filter_map(|one| clips.remove(one)).collect();
    }
    Ok(())
}

/// `base` with `patch` applied, as the page's lib/patch.ts `apply`: fields
/// set and removed, and for a list of things with ids the ones put (changed
/// in place, new ones at the end), removed, and the new order when it moved.
pub fn apply(base: &mut Value, patch: &Value) -> Result<(), String> {
    let object = base.as_object_mut().ok_or("the project isn't an object")?;
    if let Some(set) = patch.get("set").and_then(Value::as_object) {
        for (key, value) in set {
            object.insert(key.clone(), value.clone());
        }
    }
    if let Some(unset) = patch.get("unset").and_then(Value::as_array) {
        for key in unset.iter().filter_map(Value::as_str) {
            object.remove(key);
        }
    }
    let Some(lists) = patch.get("lists").and_then(Value::as_object) else {
        return Ok(());
    };
    let id = |item: &Value| item.get("id").and_then(Value::as_str).map(str::to_owned);
    for (key, change) in lists {
        let list = object
            .entry(key.clone())
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| format!("{key} isn't a list of things with ids"))?;
        let strings = |field: &str| -> Vec<String> {
            change
                .get(field)
                .and_then(Value::as_array)
                .map(|all| {
                    all.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default()
        };
        let gone: std::collections::HashSet<String> = strings("remove").into_iter().collect();
        list.retain(|item| id(item).is_none_or(|one| !gone.contains(&one)));
        let mut at: HashMap<String, usize> = HashMap::new();
        for (index, item) in list.iter().enumerate() {
            let one = id(item).ok_or_else(|| format!("a {key} item has no id"))?;
            at.insert(one, index);
        }
        for item in change
            .get("put")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let one = id(item).ok_or_else(|| format!("a changed {key} item has no id"))?;
            match at.get(&one) {
                Some(&index) => {
                    if let Some(slot) = list.get_mut(index) {
                        *slot = item.clone();
                    }
                }
                None => {
                    at.insert(one, list.len());
                    list.push(item.clone());
                }
            }
        }
        if change.get("order").is_some() {
            let order = strings("order");
            if order.len() != list.len() || order.iter().any(|one| !at.contains_key(one)) {
                return Err(format!("{key}'s new order doesn't match its items"));
            }
            let mut items: HashMap<String, Value> = list
                .drain(..)
                .filter_map(|item| id(&item).map(|one| (one, item)))
                .collect();
            *list = order.iter().filter_map(|one| items.remove(one)).collect();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_patch_applies_as_the_pages_does() {
        let mut project = json!({
            "name": "a", "next_id": 3, "gone": true,
            "clips": [{"id": "c1", "start": 0}, {"id": "c2", "start": 5}, {"id": "c3", "start": 9}],
        });
        apply(
            &mut project,
            &json!({
                "set": {"name": "b"}, "unset": ["gone"],
                "lists": {"clips": {"put": [{"id": "c2", "start": 6}, {"id": "c4", "start": 1}], "remove": ["c3"]}},
            }),
        )
        .unwrap();
        assert_eq!(
            project,
            json!({"name": "b", "next_id": 3,
                "clips": [{"id": "c1", "start": 0}, {"id": "c2", "start": 6}, {"id": "c4", "start": 1}]})
        );
        apply(
            &mut project,
            &json!({"set": {}, "unset": [], "lists": {"clips": {"put": [], "remove": [], "order": ["c4", "c1", "c2"]}}}),
        )
        .unwrap();
        let ids: Vec<&str> = project["clips"]
            .as_array()
            .unwrap()
            .iter()
            .map(|clip| clip["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["c4", "c1", "c2"]);
        // A clips-only patch into the parsed project lands where the JSON's does.
        let base = json!({
            "version": 1, "id": "p", "name": "t", "settings": {"width": 320, "height": 180, "fps": 30},
            "tracks": [{"id": "v", "kind": "video"}],
            "clips": [
                {"id": "a", "track": "v", "type": "solid", "start": 0, "duration": 10, "fill": [1, 0, 0, 1]},
                {"id": "b", "track": "v", "type": "solid", "start": 10, "duration": 10, "fill": [0, 1, 0, 1]},
            ],
        });
        let change = json!({"set": {"next_id": 9}, "unset": [], "lists": {"clips": {
            "put": [{"id": "b", "track": "v", "type": "solid", "start": 12, "duration": 8, "fill": [0, 1, 0, 1]},
                    {"id": "c", "track": "v", "type": "solid", "start": 30, "duration": 5, "fill": [0, 0, 1, 1]}],
            "remove": ["a"], "order": ["c", "b"]}}});
        assert!(only_clips(&change));
        let mut parsed = Project::deserialize(&base).unwrap();
        patch_clips(&mut parsed, &change).unwrap();
        let mut value = base.clone();
        apply(&mut value, &change).unwrap();
        let whole = Project::deserialize(&value).unwrap();
        assert_eq!(
            serde_json::to_value(&parsed.clips).unwrap(),
            serde_json::to_value(&whole.clips).unwrap()
        );
        assert!(!only_clips(
            &json!({"set": {"name": "x"}, "unset": [], "lists": {}})
        ));
        // An order naming what isn't there doesn't fit.
        assert!(apply(
            &mut project,
            &json!({"set": {}, "unset": [], "lists": {"clips": {"put": [], "remove": [], "order": ["c1"]}}}),
        )
        .is_err());
    }
}
