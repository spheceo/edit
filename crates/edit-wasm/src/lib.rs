//! The preview engine the browser drives. JS owns decoding (WebCodecs workers)
//! and timing; this owns evaluation and drawing so they match the export.

#![cfg(target_arch = "wasm32")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use edit_core::{evaluate, Layer, Project, Scene};
use edit_render::{wgpu, Renderer};
use wasm_bindgen::prelude::*;
use web_sys::{HtmlCanvasElement, VideoFrame};

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[wasm_bindgen]
pub struct Engine {
    renderer: Renderer,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    project: Option<Project>,
    evaluated: Option<(i64, Scene)>,
    /// Set when the browser takes the GPU device away (see `is_lost`).
    lost: Arc<AtomicBool>,
}

/// Creates the engine on `canvas`. Fails when the browser has no WebGPU.
#[wasm_bindgen(js_name = createEngine)]
pub async fn create_engine(canvas: HtmlCanvasElement) -> Result<Engine, JsValue> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::BROWSER_WEBGPU,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let surface = instance
        .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
        .map_err(js_error)?;
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
            apply_limit_buckets: false,
        })
        .await
        .map_err(js_error)?;
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("edit"),
            required_limits: wgpu::Limits::default().using_resolution(adapter.limits()),
            ..Default::default()
        })
        .await
        .map_err(js_error)?;
    let lost = Arc::new(AtomicBool::new(false));
    {
        let lost = Arc::clone(&lost);
        device.set_device_lost_callback(move |reason, message| {
            // Freeing an engine destroys its device too; only an unexpected loss is news.
            if reason != wgpu::DeviceLostReason::Destroyed {
                web_sys::console::warn_1(&format!("edit: GPU device lost: {message}").into());
            }
            lost.store(true, Ordering::Release);
        });
    }
    // Read the size only now: the canvas may have resized while the GPU was being set up.
    let (width, height) = (canvas.width().max(1), canvas.height().max(1));
    let caps = surface.get_capabilities(&adapter);
    // Empty when this GPU can't draw to the canvas at all.
    let (Some(&first_format), Some(&alpha_mode)) = (caps.formats.first(), caps.alpha_modes.first())
    else {
        return Err(js_error("this GPU can't draw to the canvas"));
    };
    // Pixels are already sRGB-encoded, so present through a non-sRGB view.
    let format = caps
        .formats
        .iter()
        .copied()
        .find(|format| !format.is_srgb())
        .unwrap_or(first_format);
    let config = wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format,
        width,
        height,
        present_mode: wgpu::PresentMode::Fifo,
        desired_maximum_frame_latency: 1,
        alpha_mode,
        view_formats: vec![],
        color_space: wgpu::SurfaceColorSpace::Auto,
    };
    surface.configure(&device, &config);
    Ok(Engine {
        renderer: Renderer::new(device, queue, 1920, 1080),
        surface,
        config,
        project: None,
        evaluated: None,
        lost,
    })
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(js_name = addFont)]
    pub fn add_font(&mut self, family: &str, weight: u16, bytes: &[u8]) -> Result<(), JsValue> {
        self.renderer
            .fonts_mut()
            .add(family, weight, bytes)
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = setProject)]
    pub fn set_project(&mut self, json: &str) -> Result<(), JsValue> {
        let project: Project = serde_json::from_str(json).map_err(js_error)?;
        project.validate().map_err(js_error)?;
        self.renderer
            .resize(project.settings.width, project.settings.height);
        self.project = Some(project);
        self.evaluated = None;
        Ok(())
    }

    /// JSON: the project's intro, B-roll spots, story and outro (edit_core::sections).
    pub fn sections(&self) -> String {
        self.project
            .as_ref()
            .and_then(|project| serde_json::to_string(&edit_core::sections(project)).ok())
            .unwrap_or_else(|| "null".to_owned())
    }

    /// JSON `[{clip, media, time}]`: the video frames `frame` needs.
    pub fn sources(&mut self, frame: f64) -> String {
        self.evaluate(frame.floor() as i64);
        let Some((_, scene)) = &self.evaluated else {
            return "[]".to_owned();
        };
        let list: Vec<_> = scene
            .layers
            .iter()
            .filter_map(|layer| match layer {
                Layer::Video {
                    clip,
                    media,
                    source_time,
                    ..
                } => Some(serde_json::json!({ "clip": clip, "media": media, "time": source_time })),
                _ => None,
            })
            .collect();
        serde_json::Value::Array(list).to_string()
    }

    /// Copies a decoded frame into the GPU texture for `media`.
    ///
    /// Takes a WebCodecs `VideoFrame` transferred from the decoder worker.
    /// JS retains ownership in its bounded cache; uploading does not close it.
    #[wasm_bindgen(js_name = uploadFrame)]
    pub fn upload_frame(&mut self, media: &str, frame: VideoFrame) {
        let (width, height) = (frame.display_width(), frame.display_height());
        if width == 0 || height == 0 {
            return;
        }
        let texture = self.renderer.video_texture(media, width, height).clone();
        self.renderer.queue().copy_external_image_to_texture(
            &wgpu::CopyExternalImageSourceInfo {
                source: wgpu::ExternalImageSource::VideoFrame(frame),
                origin: wgpu::Origin2d::ZERO,
                flip_y: false,
            },
            wgpu::CopyExternalImageDestInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
                color_space: wgpu::PredefinedColorSpace::Srgb,
                premultiplied_alpha: false,
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
    }

    /// A media's sound levels for waveforms: its peaks (one byte per 10 ms).
    #[wasm_bindgen(js_name = setPeaks)]
    pub fn set_peaks(&mut self, media: &str, peaks: &[u8]) {
        self.renderer.set_peaks(media, peaks.to_vec());
    }

    #[wasm_bindgen(js_name = clearPeaks)]
    pub fn clear_peaks(&mut self) {
        self.renderer.clear_peaks();
    }

    #[wasm_bindgen(js_name = forgetVideo)]
    pub fn forget_video(&mut self, media: &str) {
        self.renderer.forget_video(media);
    }

    /// Whether the GPU device is gone: the browser can drop it (a tab left in
    /// the background, a GPU switch or driver reset), after which drawing
    /// silently does nothing. The page then builds a new engine.
    #[wasm_bindgen(js_name = isLost)]
    pub fn is_lost(&self) -> bool {
        self.lost.load(Ordering::Acquire)
    }

    /// Canvas backing-store size changed.
    pub fn resize(&mut self, width: u32, height: u32) {
        let (width, height) = (width.max(1), height.max(1));
        if (width, height) == (self.config.width, self.config.height) {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(self.renderer.device(), &self.config);
    }

    /// Evaluates and draws `frame`, letterboxed into the canvas.
    pub fn render(&mut self, frame: f64) -> Result<(), JsValue> {
        self.evaluate(frame.floor() as i64);
        let Some((_, scene)) = &self.evaluated else {
            return Ok(());
        };
        self.renderer.render(scene);
        self.present()
    }

    fn evaluate(&mut self, frame: i64) {
        if self
            .evaluated
            .as_ref()
            .is_none_or(|(cached, _)| *cached != frame)
        {
            self.evaluated = self
                .project
                .as_ref()
                .map(|project| (frame, evaluate(project, frame)));
        }
    }

    fn present(&mut self) -> Result<(), JsValue> {
        let texture = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(texture)
            | wgpu::CurrentSurfaceTexture::Suboptimal(texture) => texture,
            other => {
                self.surface.configure(self.renderer.device(), &self.config);
                return Err(js_error(format!("surface unavailable: {other:?}")));
            }
        };
        let view = texture
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let (width, height) = self.renderer.size();
        let (cw, ch) = (self.config.width as f32, self.config.height as f32);
        let fit = (cw / width as f32).min(ch / height as f32);
        // Round and clamp before centring: a hair over the canvas would floor
        // the offset to -1, and WebKit rejects a viewport that leaves the
        // target, dropping the whole frame (Chrome allows it).
        let w = (width as f32 * fit).round().min(cw);
        let h = (height as f32 * fit).round().min(ch);
        let viewport = [((cw - w) / 2.0).floor(), ((ch - h) / 2.0).floor(), w, h];
        self.renderer
            .present(&view, self.config.format, viewport, wgpu::Color::BLACK);
        self.renderer.queue().present(texture);
        Ok(())
    }
}
