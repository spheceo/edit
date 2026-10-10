//! Edit's compositor. One code path renders the browser preview (WebGPU via
//! WASM) and the export (Metal/Vulkan/DX12 natively), so effects match exactly.

pub mod text;

use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use edit_core::{Grade, Layer, Scene, Transform};
use text::{FontBook, GlyphCache, TextSpec};

pub use wgpu;

/// Composite precision: half floats keep glows and grades free of banding.
const ACCUM_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
/// Decoded video and rasterized text.
pub const SOURCE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
pub const OUTPUT_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const UNIFORM_SLOT: u64 = 256;
const UNIFORM_SLOTS: u64 = 512;
/// Text/glow textures unused for this many frames are freed.
const TEXT_TTL: u64 = 240;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct LayerUniforms {
    center: [f32; 2],
    size: [f32; 2],
    half_canvas: [f32; 2],
    rotation: f32,
    opacity: f32,
    tint: [f32; 4],
    mode: u32,
    _pad: [u32; 3],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct GradeUniforms {
    exposure: f32,
    contrast: f32,
    saturation: f32,
    temperature: f32,
    vignette: f32,
    opacity: f32,
    aspect: f32,
    _pad: f32,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct BlurUniforms {
    dir: [f32; 2],
    texel: [f32; 2],
    sigma: f32,
    taps: f32,
    _pad: [f32; 2],
}

const MODE_STRAIGHT: u32 = 0;
const MODE_SOLID: u32 = 1;
const MODE_GLOW: u32 = 2;
const MODE_PREMULTIPLIED: u32 = 3;
const MODE_SHADOW: u32 = 4;

struct Target {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    width: u32,
    height: u32,
}

impl Target {
    fn new(
        device: &wgpu::Device,
        label: &str,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
        extra: wgpu::TextureUsages,
    ) -> Self {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width: width.max(1),
                height: height.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::RENDER_ATTACHMENT
                | extra,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Self {
            texture,
            view,
            width: width.max(1),
            height: height.max(1),
        }
    }
}

struct TextSlot {
    key: u64,
    glow_key: u64,
    image: Target,
    /// Blurred copies of the text, each (scratch, result): the glow's close
    /// and wide layers first (`glow_layers` of them), then the shadow if any.
    glows: Vec<(Target, Target)>,
    glow_layers: usize,
    shadow_layer: Option<usize>,
    /// Output pixels the text image covers (equal to its texel size).
    size: [f32; 2],
    /// The lines' box inside the image (for the background).
    block: [f32; 2],
    last_used: u64,
}

pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    width: u32,
    height: u32,
    accum: [Target; 2],
    output: Target,
    layer_layout: wgpu::BindGroupLayout,
    over_pipeline: wgpu::RenderPipeline,
    adjust_pipeline: wgpu::RenderPipeline,
    blur_pipeline: wgpu::RenderPipeline,
    present_pipelines: HashMap<wgpu::TextureFormat, wgpu::RenderPipeline>,
    present_shader: wgpu::ShaderModule,
    pipeline_layout: wgpu::PipelineLayout,
    uniforms: wgpu::Buffer,
    sampler: wgpu::Sampler,
    blank: Target,
    videos: HashMap<String, Target>,
    texts: HashMap<String, TextSlot>,
    fonts: FontBook,
    glyphs: GlyphCache,
    frame_counter: u64,
}

fn fullscreen_source(body: &str) -> String {
    format!("{}\n{}", include_str!("shaders/fullscreen.wgsl"), body)
}

impl Renderer {
    pub fn new(device: wgpu::Device, queue: wgpu::Queue, width: u32, height: u32) -> Self {
        let layer_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("edit layer"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: true,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("edit"),
            bind_group_layouts: &[Some(&layer_layout)],
            immediate_size: 0,
        });
        let shader = |label: &str, source: String| {
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(label),
                source: wgpu::ShaderSource::Wgsl(source.into()),
            })
        };
        let layer_shader = shader("edit layer", include_str!("shaders/layer.wgsl").to_owned());
        let adjust_shader = shader(
            "edit adjust",
            fullscreen_source(include_str!("shaders/adjust.wgsl")),
        );
        let blur_shader = shader(
            "edit blur",
            fullscreen_source(include_str!("shaders/blur.wgsl")),
        );
        let present_shader = shader(
            "edit present",
            fullscreen_source(include_str!("shaders/present.wgsl")),
        );

        let premultiplied_over = wgpu::BlendState {
            color: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
            alpha: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
        };
        let over_pipeline = make_pipeline(
            &device,
            &pipeline_layout,
            &layer_shader,
            ACCUM_FORMAT,
            Some(premultiplied_over),
            "edit over",
        );
        let adjust_pipeline = make_pipeline(
            &device,
            &pipeline_layout,
            &adjust_shader,
            ACCUM_FORMAT,
            None,
            "edit adjust",
        );
        let blur_pipeline = make_pipeline(
            &device,
            &pipeline_layout,
            &blur_shader,
            SOURCE_FORMAT,
            None,
            "edit blur",
        );

        let uniforms = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("edit uniforms"),
            size: UNIFORM_SLOT * UNIFORM_SLOTS,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("edit linear"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let blank = Target::new(
            &device,
            "edit blank",
            1,
            1,
            SOURCE_FORMAT,
            wgpu::TextureUsages::COPY_DST,
        );
        let accum = [
            Target::new(
                &device,
                "edit accum a",
                width,
                height,
                ACCUM_FORMAT,
                wgpu::TextureUsages::empty(),
            ),
            Target::new(
                &device,
                "edit accum b",
                width,
                height,
                ACCUM_FORMAT,
                wgpu::TextureUsages::empty(),
            ),
        ];
        let output = Target::new(
            &device,
            "edit output",
            width,
            height,
            OUTPUT_FORMAT,
            wgpu::TextureUsages::COPY_SRC,
        );
        Self {
            device,
            queue,
            width: width.max(1),
            height: height.max(1),
            accum,
            output,
            layer_layout,
            over_pipeline,
            adjust_pipeline,
            blur_pipeline,
            present_pipelines: HashMap::new(),
            present_shader,
            pipeline_layout,
            uniforms,
            sampler,
            blank,
            videos: HashMap::new(),
            texts: HashMap::new(),
            fonts: FontBook::default(),
            glyphs: GlyphCache::default(),
            frame_counter: 0,
        }
    }

    pub fn device(&self) -> &wgpu::Device {
        &self.device
    }

    pub fn queue(&self) -> &wgpu::Queue {
        &self.queue
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn fonts_mut(&mut self) -> &mut FontBook {
        &mut self.fonts
    }

    /// Changes the composite resolution (project settings changed).
    pub fn resize(&mut self, width: u32, height: u32) {
        let (width, height) = (width.max(1), height.max(1));
        if (width, height) == (self.width, self.height) {
            return;
        }
        self.width = width;
        self.height = height;
        self.accum = [
            Target::new(
                &self.device,
                "edit accum a",
                width,
                height,
                ACCUM_FORMAT,
                wgpu::TextureUsages::empty(),
            ),
            Target::new(
                &self.device,
                "edit accum b",
                width,
                height,
                ACCUM_FORMAT,
                wgpu::TextureUsages::empty(),
            ),
        ];
        self.output = Target::new(
            &self.device,
            "edit output",
            width,
            height,
            OUTPUT_FORMAT,
            wgpu::TextureUsages::COPY_SRC,
        );
        self.texts.clear();
    }

    /// The texture a media's current frame should be uploaded into, sized
    /// `width`×`height`. Usable as a `copy_external_image_to_texture` target.
    pub fn video_texture(&mut self, media: &str, width: u32, height: u32) -> &wgpu::Texture {
        let stale = self
            .videos
            .get(media)
            .is_none_or(|target| target.width != width.max(1) || target.height != height.max(1));
        if stale {
            let target = Target::new(
                &self.device,
                "edit video",
                width,
                height,
                SOURCE_FORMAT,
                wgpu::TextureUsages::COPY_DST,
            );
            self.videos.insert(media.to_owned(), target);
        }
        &self.videos[media].texture
    }

    /// Native path: upload a decoded RGBA8 frame.
    pub fn upload_video_rgba(&mut self, media: &str, width: u32, height: u32, rgba: &[u8]) {
        let texture = self.video_texture(media, width, height).clone();
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
    }

    pub fn forget_video(&mut self, media: &str) {
        self.videos.remove(media);
    }

    pub fn has_video(&self, media: &str) -> bool {
        self.videos.contains_key(media)
    }

    /// Composites `scene` into the internal output. Present or read it back afterwards.
    pub fn render(&mut self, scene: &Scene) {
        if (scene.width, scene.height) != (self.width, self.height) {
            self.resize(scene.width, scene.height);
        }
        self.frame_counter += 1;
        let half_canvas = [self.width as f32 / 2.0, self.height as f32 / 2.0];
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("edit frame"),
            });
        let mut slots = SlotWriter::default();
        let mut current = 0_usize;

        clear(&mut encoder, &self.accum[current].view);

        for layer in &scene.layers {
            match layer {
                Layer::Video {
                    media,
                    transform,
                    opacity,
                    ..
                } => {
                    let Some(video) = self.videos.get(media) else {
                        continue;
                    };
                    if *opacity <= 0.0 {
                        continue;
                    }
                    let fit = (self.width as f32 / video.width as f32)
                        .min(self.height as f32 / video.height as f32);
                    let size = [video.width as f32 * fit, video.height as f32 * fit];
                    let uniforms = quad_uniforms(
                        transform,
                        size,
                        half_canvas,
                        *opacity,
                        [1.0; 4],
                        MODE_STRAIGHT,
                    );
                    let offset =
                        slots.push(&self.queue, &self.uniforms, bytemuck::bytes_of(&uniforms));
                    let group = self.bind(&video.view);
                    draw(
                        &mut encoder,
                        &self.over_pipeline,
                        &self.accum[current].view,
                        &group,
                        offset,
                        4,
                        None,
                    );
                }
                Layer::Solid { color, opacity } => {
                    if *opacity <= 0.0 {
                        continue;
                    }
                    let uniforms = LayerUniforms {
                        center: [0.0, 0.0],
                        size: [self.width as f32, self.height as f32],
                        half_canvas,
                        rotation: 0.0,
                        opacity: *opacity,
                        tint: color.0,
                        mode: MODE_SOLID,
                        _pad: [0; 3],
                    };
                    let offset =
                        slots.push(&self.queue, &self.uniforms, bytemuck::bytes_of(&uniforms));
                    let group = self.bind(&self.blank.view);
                    draw(
                        &mut encoder,
                        &self.over_pipeline,
                        &self.accum[current].view,
                        &group,
                        offset,
                        4,
                        None,
                    );
                }
                Layer::Text {
                    clip,
                    text,
                    style,
                    transform,
                    animation,
                    local_frame,
                    opacity,
                } => {
                    if *opacity <= 0.0 || text.is_empty() || self.fonts.is_empty() {
                        continue;
                    }
                    if !self.prepare_text(
                        &mut encoder,
                        &mut slots,
                        clip,
                        text,
                        style,
                        transform,
                        animation,
                        *local_frame,
                    ) {
                        continue;
                    }
                    let slot = &self.texts[clip];
                    let placed = Transform {
                        scale: 1.0,
                        ..*transform
                    };
                    let scale = transform.scale.max(0.0);
                    // 1. The box behind the lines.
                    if let Some(background) = style.background {
                        let size = [
                            slot.block[0] + 2.0 * background.pad_x * scale,
                            slot.block[1] + 2.0 * background.pad_y * scale,
                        ];
                        let mut tint = background.color.0;
                        tint[3] *= background.opacity;
                        let uniforms =
                            quad_uniforms(&placed, size, half_canvas, *opacity, tint, MODE_SOLID);
                        let offset =
                            slots.push(&self.queue, &self.uniforms, bytemuck::bytes_of(&uniforms));
                        let group = self.bind(&self.blank.view);
                        draw(
                            &mut encoder,
                            &self.over_pipeline,
                            &self.accum[current].view,
                            &group,
                            offset,
                            4,
                            None,
                        );
                    }
                    // 2. The drop shadow, offset along its angle (clockwise from up).
                    if let (Some(shadow), Some(index)) = (style.shadow, slot.shadow_layer) {
                        if let Some((_, blurred)) = slot.glows.get(index) {
                            let angle = shadow.angle.to_radians();
                            let moved = Transform {
                                x: transform.x + shadow.distance * scale * angle.sin(),
                                y: transform.y - shadow.distance * scale * angle.cos(),
                                ..placed
                            };
                            let mut tint = shadow.color.0;
                            tint[3] *= shadow.opacity;
                            let uniforms = quad_uniforms(
                                &moved,
                                slot.size,
                                half_canvas,
                                *opacity,
                                tint,
                                MODE_SHADOW,
                            );
                            let offset = slots.push(
                                &self.queue,
                                &self.uniforms,
                                bytemuck::bytes_of(&uniforms),
                            );
                            let group = self.bind(&blurred.view);
                            draw(
                                &mut encoder,
                                &self.over_pipeline,
                                &self.accum[current].view,
                                &group,
                                offset,
                                4,
                                None,
                            );
                        }
                    }
                    // 3. The glow: wide first, then close, under the text (repack's glow).
                    if style.glow.enabled && style.glow.strength > 0.0 {
                        let mut tint = style.glow.color.unwrap_or(style.color).0;
                        tint[3] *= style.glow.strength;
                        for (_, glow) in slot.glows[..slot.glow_layers.min(slot.glows.len())]
                            .iter()
                            .rev()
                        {
                            let uniforms = quad_uniforms(
                                &placed,
                                slot.size,
                                half_canvas,
                                *opacity,
                                tint,
                                MODE_GLOW,
                            );
                            let offset = slots.push(
                                &self.queue,
                                &self.uniforms,
                                bytemuck::bytes_of(&uniforms),
                            );
                            let group = self.bind(&glow.view);
                            draw(
                                &mut encoder,
                                &self.over_pipeline,
                                &self.accum[current].view,
                                &group,
                                offset,
                                4,
                                None,
                            );
                        }
                    }
                    // 4. The text.
                    let uniforms = quad_uniforms(
                        &placed,
                        slot.size,
                        half_canvas,
                        *opacity,
                        [1.0; 4],
                        MODE_PREMULTIPLIED,
                    );
                    let offset =
                        slots.push(&self.queue, &self.uniforms, bytemuck::bytes_of(&uniforms));
                    let group = self.bind(&slot.image.view);
                    draw(
                        &mut encoder,
                        &self.over_pipeline,
                        &self.accum[current].view,
                        &group,
                        offset,
                        4,
                        None,
                    );
                }
                Layer::Adjustment { grade, opacity } => {
                    if *opacity <= 0.0 || *grade == Grade::default() {
                        continue;
                    }
                    let uniforms = GradeUniforms {
                        exposure: grade.exposure,
                        contrast: grade.contrast,
                        saturation: grade.saturation,
                        temperature: grade.temperature,
                        vignette: grade.vignette,
                        opacity: opacity.clamp(0.0, 1.0),
                        aspect: self.width as f32 / self.height as f32,
                        _pad: 0.0,
                    };
                    let offset =
                        slots.push(&self.queue, &self.uniforms, bytemuck::bytes_of(&uniforms));
                    let group = self.bind(&self.accum[current].view);
                    draw(
                        &mut encoder,
                        &self.adjust_pipeline,
                        &self.accum[1 - current].view,
                        &group,
                        offset,
                        3,
                        Some(wgpu::Color::BLACK),
                    );
                    current = 1 - current;
                }
            }
        }

        let present = self.present_pipeline(OUTPUT_FORMAT);
        let group = self.bind(&self.accum[current].view);
        let offset = slots.push(&self.queue, &self.uniforms, &[0; 16]);
        draw(
            &mut encoder,
            &present,
            &self.output.view,
            &group,
            offset,
            3,
            Some(wgpu::Color::BLACK),
        );
        self.queue.submit([encoder.finish()]);

        let frame = self.frame_counter;
        self.texts
            .retain(|_, slot| frame - slot.last_used < TEXT_TTL);
    }

    /// Draws the last rendered frame into `view` (e.g. a canvas surface),
    /// letterboxed to `viewport` (x, y, width, height in target pixels).
    pub fn present(
        &mut self,
        view: &wgpu::TextureView,
        format: wgpu::TextureFormat,
        viewport: [f32; 4],
        background: wgpu::Color,
    ) {
        let pipeline = self.present_pipeline(format);
        let group = self.bind(&self.output.view);
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("edit present"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("edit present"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(background),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_viewport(
                viewport[0],
                viewport[1],
                viewport[2].max(1.0),
                viewport[3].max(1.0),
                0.0,
                1.0,
            );
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &group, &[0]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit([encoder.finish()]);
    }

    /// Native path: copy the last rendered frame out as tightly packed RGBA8.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn read_output(&self) -> Result<Vec<u8>, String> {
        let (width, height) = (self.width, self.height);
        let padded = (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
            * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("edit readback"),
            size: u64::from(padded) * u64::from(height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("edit readback"),
            });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.output.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit([encoder.finish()]);
        let slice = buffer.slice(..);
        let (sender, receiver) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("GPU readback failed: {error}"))?;
        receiver
            .recv()
            .map_err(|_| "GPU readback was dropped".to_owned())?
            .map_err(|error| format!("GPU readback failed: {error}"))?;
        let mapped = slice
            .get_mapped_range()
            .map_err(|error| format!("GPU readback failed: {error}"))?;
        let mut pixels = Vec::with_capacity((width * height * 4) as usize);
        for row in 0..height as usize {
            let start = row * padded as usize;
            pixels.extend_from_slice(&mapped[start..start + width as usize * 4]);
        }
        drop(mapped);
        buffer.unmap();
        Ok(pixels)
    }

    #[allow(clippy::too_many_arguments)]
    fn prepare_text(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        slots: &mut SlotWriter,
        clip: &str,
        text: &str,
        style: &edit_core::TextStyle,
        transform: &Transform,
        animation: &edit_core::TextAnimation,
        local_frame: f32,
    ) -> bool {
        let scale = transform.scale.max(0.0);
        let px = style.size * scale;
        let glow_radius = if style.glow.enabled {
            style.glow.radius.max(0.0) * scale
        } else {
            0.0
        };
        // Room around the letters so glow, shadow and animated glyphs never clip.
        let shadow_reach = style.shadow.map_or(0.0, |shadow| {
            (shadow.distance + shadow.size + shadow.blur * 1.5) * scale
        });
        let pad = glow_radius * 2.0 + shadow_reach + px * 0.5 + 2.0;
        let animating = text_animating(animation, local_frame, text);
        // Blur passes: glow close & wide (CSS text-shadow radii r/2 and r, i.e.
        // sigma r/4 and r/2), then the shadow (grown by `size`, blurred by `blur`).
        let mut sigmas: Vec<f32> = Vec::new();
        if glow_radius > 0.0 {
            sigmas.extend([glow_radius / 4.0, glow_radius / 2.0]);
        }
        let glow_layers = sigmas.len();
        let shadow_layer = style.shadow.map(|shadow| {
            sigmas.push(((shadow.blur / 2.0 + shadow.size / 2.0) * scale).max(0.5));
            glow_layers
        });

        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        text.hash(&mut hasher);
        style.font.hash(&mut hasher);
        style.weight.hash(&mut hasher);
        for value in [
            px,
            style.tracking,
            style.line_height,
            pad,
            style.max_width.unwrap_or(0.0) * scale,
        ] {
            value.to_bits().hash(&mut hasher);
        }
        for value in style.color.0 {
            value.to_bits().hash(&mut hasher);
        }
        format!("{animation:?}").hash(&mut hasher);
        if animating {
            local_frame.to_bits().hash(&mut hasher);
        }
        let key = hasher.finish();
        let glow_key = {
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            key.hash(&mut hasher);
            for sigma in &sigmas {
                sigma.to_bits().hash(&mut hasher);
            }
            hasher.finish()
        };

        let frame = self.frame_counter;
        let fresh = self.texts.get(clip).is_none_or(|slot| slot.key != key);
        if fresh {
            let Some(image) = text::rasterize(
                &self.fonts,
                &mut self.glyphs,
                &TextSpec {
                    text,
                    family: &style.font,
                    weight: style.weight,
                    px,
                    color: style.color,
                    tracking: style.tracking * scale,
                    line_height: style.line_height,
                    animation,
                    local_frame,
                    pad,
                    max_width: style.max_width.map(|width| width * scale),
                },
            ) else {
                return false;
            };
            let reuse = self.texts.get(clip).is_some_and(|slot| {
                slot.image.width == image.width && slot.image.height == image.height
            });
            if !reuse {
                let target = Target::new(
                    &self.device,
                    "edit text",
                    image.width,
                    image.height,
                    SOURCE_FORMAT,
                    wgpu::TextureUsages::COPY_DST,
                );
                self.texts.insert(
                    clip.to_owned(),
                    TextSlot {
                        key,
                        glow_key: 0,
                        image: target,
                        glows: Vec::new(),
                        glow_layers: 0,
                        shadow_layer: None,
                        size: [image.width as f32, image.height as f32],
                        block: image.block,
                        last_used: frame,
                    },
                );
            }
            let slot = self.texts.get_mut(clip).expect("text slot");
            slot.key = key;
            slot.glow_key = 0;
            slot.block = image.block;
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &slot.image.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                &image.pixels,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(image.width * 4),
                    rows_per_image: Some(image.height),
                },
                wgpu::Extent3d {
                    width: image.width,
                    height: image.height,
                    depth_or_array_layers: 1,
                },
            );
        }

        let slot = self.texts.get_mut(clip).expect("text slot");
        slot.last_used = frame;
        slot.glow_layers = glow_layers;
        slot.shadow_layer = shadow_layer;
        if !sigmas.is_empty() && slot.glow_key != glow_key {
            slot.glow_key = glow_key;
            let (image_w, image_h) = (slot.image.width, slot.image.height);
            let image_view = slot.image.view.clone();
            let mut layers = std::mem::take(&mut slot.glows);
            for (index, sigma) in sigmas.iter().copied().enumerate() {
                let sigma = sigma.max(0.5);
                // Blur wide glows at reduced resolution: same look, fixed cost.
                let shrink = (8.0 / sigma).clamp(0.25, 1.0);
                let gw = ((image_w as f32 * shrink).ceil() as u32).max(1);
                let gh = ((image_h as f32 * shrink).ceil() as u32).max(1);
                let fits = layers
                    .get(index)
                    .is_some_and(|(scratch, _)| scratch.width == gw && scratch.height == gh);
                if !fits {
                    let make = |label| {
                        Target::new(
                            &self.device,
                            label,
                            gw,
                            gh,
                            SOURCE_FORMAT,
                            wgpu::TextureUsages::empty(),
                        )
                    };
                    let pair = (make("edit glow scratch"), make("edit glow"));
                    if index < layers.len() {
                        layers[index] = pair;
                    } else {
                        layers.push(pair);
                    }
                }
                let horizontal = BlurUniforms {
                    dir: [1.0, 0.0],
                    texel: [1.0 / image_w as f32, 1.0 / image_h as f32],
                    sigma,
                    taps: (3.0 * sigma).ceil().clamp(1.0, 48.0),
                    _pad: [0.0; 2],
                };
                let small_sigma = (sigma * shrink).max(0.5);
                let vertical = BlurUniforms {
                    dir: [0.0, 1.0],
                    texel: [1.0 / gw as f32, 1.0 / gh as f32],
                    sigma: small_sigma,
                    taps: (3.0 * small_sigma).ceil().clamp(1.0, 48.0),
                    _pad: [0.0; 2],
                };
                let h_offset =
                    slots.push(&self.queue, &self.uniforms, bytemuck::bytes_of(&horizontal));
                let v_offset =
                    slots.push(&self.queue, &self.uniforms, bytemuck::bytes_of(&vertical));
                let (scratch, out) = &layers[index];
                let first = self.bind(&image_view);
                draw(
                    encoder,
                    &self.blur_pipeline,
                    &scratch.view,
                    &first,
                    h_offset,
                    3,
                    Some(wgpu::Color::TRANSPARENT),
                );
                let second = self.bind(&scratch.view);
                draw(
                    encoder,
                    &self.blur_pipeline,
                    &out.view,
                    &second,
                    v_offset,
                    3,
                    Some(wgpu::Color::TRANSPARENT),
                );
            }
            layers.truncate(sigmas.len());
            self.texts.get_mut(clip).expect("text slot").glows = layers;
        }
        true
    }

    fn bind(&self, view: &wgpu::TextureView) -> wgpu::BindGroup {
        self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.layer_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &self.uniforms,
                        offset: 0,
                        size: wgpu::BufferSize::new(UNIFORM_SLOT),
                    }),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        })
    }

    fn present_pipeline(&mut self, format: wgpu::TextureFormat) -> wgpu::RenderPipeline {
        if let Some(pipeline) = self.present_pipelines.get(&format) {
            return pipeline.clone();
        }
        let pipeline = make_pipeline(
            &self.device,
            &self.pipeline_layout,
            &self.present_shader,
            format,
            None,
            "edit present",
        );
        self.present_pipelines.insert(format, pipeline.clone());
        pipeline
    }
}

fn text_animating(animation: &edit_core::TextAnimation, local_frame: f32, text: &str) -> bool {
    use edit_core::TextPreset;
    match animation.preset {
        TextPreset::None => false,
        TextPreset::Fade => local_frame < animation.duration,
        _ => {
            let glyphs = text.chars().filter(|ch| !ch.is_whitespace()).count() as f32;
            local_frame < animation.stagger.max(0.0) * glyphs + animation.duration
        }
    }
}

fn quad_uniforms(
    transform: &Transform,
    size: [f32; 2],
    half_canvas: [f32; 2],
    opacity: f32,
    tint: [f32; 4],
    mode: u32,
) -> LayerUniforms {
    LayerUniforms {
        center: [transform.x, transform.y],
        size: [size[0] * transform.scale, size[1] * transform.scale],
        half_canvas,
        rotation: transform.rotation.to_radians(),
        opacity: opacity.clamp(0.0, 1.0),
        tint,
        mode,
        _pad: [0; 3],
    }
}

#[derive(Default)]
struct SlotWriter {
    next: u64,
}

impl SlotWriter {
    fn push(&mut self, queue: &wgpu::Queue, buffer: &wgpu::Buffer, bytes: &[u8]) -> u32 {
        let slot = self.next.min(UNIFORM_SLOTS - 1);
        self.next += 1;
        let offset = slot * UNIFORM_SLOT;
        queue.write_buffer(buffer, offset, bytes);
        offset as u32
    }
}

fn clear(encoder: &mut wgpu::CommandEncoder, view: &wgpu::TextureView) {
    encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("edit clear"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    });
}

fn draw(
    encoder: &mut wgpu::CommandEncoder,
    pipeline: &wgpu::RenderPipeline,
    target: &wgpu::TextureView,
    group: &wgpu::BindGroup,
    offset: u32,
    vertices: u32,
    clear: Option<wgpu::Color>,
) {
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: None,
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: target,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: clear.map_or(wgpu::LoadOp::Load, wgpu::LoadOp::Clear),
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, group, &[offset]);
    pass.draw(0..vertices, 0..1);
}

fn make_pipeline(
    device: &wgpu::Device,
    layout: &wgpu::PipelineLayout,
    shader: &wgpu::ShaderModule,
    format: wgpu::TextureFormat,
    blend: Option<wgpu::BlendState>,
    label: &str,
) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(label),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vs"),
            buffers: &[],
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        },
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleStrip,
            ..Default::default()
        },
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some("fs"),
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend,
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        }),
        multiview_mask: None,
        cache: None,
    })
}
