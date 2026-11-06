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

use std::collections::HashMap;
use std::ffi::c_void;
use std::path::PathBuf;

use edit_core::{evaluate_seen, Project};
use edit_render::{text::BUNDLED_FONTS, wgpu, Renderer};

use crate::render::{feed_peaks, PreviewPictures};

pub struct Player {
    renderer: Renderer,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    pictures: PreviewPictures,
    project: Option<Project>,
    /// What each media is decoded from: its preview file on this Mac, else a URL the server answers.
    sources: HashMap<String, PathBuf>,
    /// The media cache: waveforms' sound levels.
    cache: PathBuf,
    /// The frame on screen, and whether the project or size changed since.
    drawn: Option<i64>,
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
            sources: HashMap::new(),
            cache: PathBuf::new(),
            drawn: None,
        })
    }

    /// The edit to draw (the page's JSON, as its engine takes it), what each
    /// media is decoded from, and the media cache.
    pub fn set_project(
        &mut self,
        json: &str,
        sources: HashMap<String, String>,
        cache: PathBuf,
    ) -> Result<(), String> {
        let project: Project = serde_json::from_str(json).map_err(|error| error.to_string())?;
        project.validate()?;
        if self.project.as_ref().map(|old| &old.id) != Some(&project.id) {
            self.renderer.clear_peaks();
            self.pictures.clear();
        }
        let sources: HashMap<String, PathBuf> = sources
            .into_iter()
            .map(|(media, path)| (media, PathBuf::from(path)))
            .collect();
        // A media decoded from another file now: its readers of the old one go.
        if sources != self.sources {
            self.pictures.clear();
        }
        self.renderer
            .resize(project.settings.width, project.settings.height);
        self.project = Some(project);
        self.sources = sources;
        self.cache = cache;
        self.drawn = None;
        Ok(())
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
        if self.drawn == Some(frame) {
            return Ok(());
        }
        let Some(project) = &self.project else {
            return Err("no edit to draw yet".to_owned());
        };
        let scene = evaluate_seen(project, frame);
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
        let pictures = self
            .pictures
            .decode(project, &scene, shown, &self.sources)?;
        for (clip, width, height, pixels) in &pictures {
            self.renderer
                .upload_video(clip, *width, *height, pixels, true);
        }
        feed_peaks(&mut self.renderer, project, &scene, &self.cache);
        self.renderer.render(&scene);
        self.present()?;
        self.drawn = Some(frame);
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
