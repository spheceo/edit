//! Edit's compositor. One code path renders the browser preview (WebGPU via
//! WASM) and the export (Metal/Vulkan/DX12 natively), so effects match exactly.

pub mod text;

use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use edit_core::{Grade, Layer, Scene, Transform};
use text::{FontBook, GlyphCache, LabelSpec, TextSpec};

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
    /// The Gaussian's sigma in pixels, for a box shadow.
    blur: f32,
    _pad: [u32; 2],
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
    /// Shake now: offset (in frame heights), tilt (radians clockwise), zoom.
    shake_x: f32,
    shake_y: f32,
    shake_turn: f32,
    shake_zoom: f32,
    /// Where it was a shutter earlier (blurred along the way), and 1 to mirror past the edges.
    from_x: f32,
    from_y: f32,
    from_turn: f32,
    mirror: f32,
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
const MODE_BOX_SHADOW: u32 = 5;

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
    /// The label's line box (width, height) and how far its centre sits above the image's.
    label: Option<[f32; 3]>,
    last_used: u64,
}

pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    width: u32,
    height: u32,
    accum: [Target; 2],
    output: Target,
    #[cfg(not(target_arch = "wasm32"))]
    readback: Option<wgpu::Buffer>,
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
    /// Sound levels by media id: one byte (peak, 0..255) per 1/PEAKS_PER_SECOND s.
    peaks: HashMap<String, Vec<u8>>,
    frame_counter: u64,
}

/// Resolution of the sound levels a waveform reads (as the media cache's peaks.bin).
pub const PEAKS_PER_SECOND: f64 = 100.0;

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
            #[cfg(not(target_arch = "wasm32"))]
            readback: None,
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
            peaks: HashMap::new(),
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
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.readback = None;
        }
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

    /// Sound levels a waveform reads for `media`: peaks.bin from the media cache.
    pub fn set_peaks(&mut self, media: &str, peaks: Vec<u8>) {
        self.peaks.insert(media.to_owned(), peaks);
    }

    pub fn has_peaks(&self, media: &str) -> bool {
        self.peaks.contains_key(media)
    }

    /// Forgets every media's levels (another project's media ids may mean other files).
    pub fn clear_peaks(&mut self) {
        self.peaks.clear();
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
        // Text with glow/shadow uses several slots. Reusing the last slot on
        // overflow makes earlier draws read another layer's final uniforms.
        let needed = (scene.layers.len() as u64 * 12 + 1).max(UNIFORM_SLOTS) * UNIFORM_SLOT;
        if self.uniforms.size() < needed {
            self.uniforms = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("edit uniforms"),
                size: needed.next_power_of_two(),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
        }
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
                    clip,
                    media,
                    transform,
                    opacity,
                    ..
                } => {
                    let Some(video) = self.videos.get(clip).or_else(|| self.videos.get(media))
                    else {
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
                        blur: 0.0,
                        _pad: [0; 2],
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
                        // A shadow, cast by the box (the text's own would be hidden
                        // behind it): the box grown by `size`, blurred by `blur`,
                        // worked out exactly in the shader (a Gaussian-blurred box).
                        if let Some(shadow) = style.shadow {
                            let angle = shadow.angle.to_radians();
                            // The same falloff as the old stack of copies, which faded
                            // linearly over 2 * blur: a Gaussian of equal slope.
                            let sigma = (2.0 * shadow.blur * scale
                                / (2.0 * std::f32::consts::PI).sqrt())
                            .max(0.01);
                            // The quad reaches 3 sigma past the shape, where it's gone.
                            let reach =
                                shadow.size * scale + background.border * scale + 3.0 * sigma;
                            let moved = Transform {
                                x: placed.x + shadow.distance * scale * angle.sin(),
                                y: placed.y - shadow.distance * scale * angle.cos(),
                                ..placed
                            };
                            let mut tint = shadow.color.0;
                            tint[3] *= shadow.opacity;
                            let uniforms = LayerUniforms {
                                blur: sigma,
                                ..quad_uniforms(
                                    &moved,
                                    [size[0] + 2.0 * reach, size[1] + 2.0 * reach],
                                    half_canvas,
                                    *opacity,
                                    tint,
                                    MODE_BOX_SHADOW,
                                )
                            };
                            let offset = slots.push(
                                &self.queue,
                                &self.uniforms,
                                bytemuck::bytes_of(&uniforms),
                            );
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
                        // Its border: four strips just outside it, turned with it.
                        if background.border > 0.0 {
                            let line = background.border * scale;
                            let [w, h] = size;
                            let (sin, cos) = transform.rotation.to_radians().sin_cos();
                            let strips = [
                                ([w + 2.0 * line, line], [0.0, -(h + line) / 2.0]),
                                ([w + 2.0 * line, line], [0.0, (h + line) / 2.0]),
                                ([line, h], [-(w + line) / 2.0, 0.0]),
                                ([line, h], [(w + line) / 2.0, 0.0]),
                            ];
                            for (strip, [dx, dy]) in strips {
                                let edge = Transform {
                                    x: placed.x + dx * cos - dy * sin,
                                    y: placed.y + dx * sin + dy * cos,
                                    ..placed
                                };
                                let uniforms = quad_uniforms(
                                    &edge,
                                    strip,
                                    half_canvas,
                                    *opacity,
                                    background.border_color.0,
                                    MODE_SOLID,
                                );
                                let offset = slots.push(
                                    &self.queue,
                                    &self.uniforms,
                                    bytemuck::bytes_of(&uniforms),
                                );
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
                        // The label's own, smaller box above.
                        if let (Some([label_w, label_h, above]), Some(label)) =
                            (slot.label, style.label.as_ref())
                        {
                            let ratio = label.size / style.size.max(1.0);
                            let size = [
                                label_w + 2.0 * background.pad_x * ratio * scale,
                                label_h + 2.0 * background.pad_y * ratio * scale,
                            ];
                            let lifted = Transform {
                                y: placed.y - above,
                                ..placed
                            };
                            let uniforms = quad_uniforms(
                                &lifted,
                                size,
                                half_canvas,
                                *opacity,
                                tint,
                                MODE_SOLID,
                            );
                            let offset = slots.push(
                                &self.queue,
                                &self.uniforms,
                                bytemuck::bytes_of(&uniforms),
                            );
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
                    // 3. The glow: wide first, then close, under the text (repack's glow). 4. The text.
                    let glow = (style.glow.enabled && style.glow.strength > 0.0).then(|| {
                        let mut tint = style.glow.color.unwrap_or(style.color).0;
                        tint[3] *= style.glow.strength;
                        tint
                    });
                    self.draw_slot(
                        &mut encoder,
                        &mut slots,
                        current,
                        clip,
                        &placed,
                        glow,
                        *opacity,
                        false,
                    );
                }
                Layer::Waveform {
                    clip,
                    sources,
                    seconds,
                    style,
                    transform,
                    opacity,
                } => {
                    if *opacity <= 0.0 {
                        continue;
                    }
                    let levels =
                        waveform_levels(&self.peaks, sources, style, wave_points(style, transform));
                    // Thin strands spread little light when blurred: lift their glow to a neon haze.
                    let boost = match style.kind {
                        edit_core::WaveformKind::Line => 2.6,
                        edit_core::WaveformKind::Bars => 1.0,
                    };
                    self.prepare_waveform(
                        &mut encoder,
                        &mut slots,
                        clip,
                        &levels,
                        style,
                        transform,
                        *seconds,
                    );
                    let placed = Transform {
                        scale: 1.0,
                        ..*transform
                    };
                    let glow = (style.glow.enabled && style.glow.strength > 0.0).then(|| {
                        let mut tint = style.glow.color.unwrap_or(style.color).0;
                        tint[3] *= style.glow.strength * boost;
                        tint
                    });
                    self.draw_slot(
                        &mut encoder,
                        &mut slots,
                        current,
                        clip,
                        &placed,
                        glow,
                        *opacity,
                        style.kind == edit_core::WaveformKind::Line,
                    );
                }
                Layer::Adjustment {
                    grade,
                    shake,
                    opacity,
                } => {
                    let still = *shake == edit_core::ShakeOffset::default();
                    if still && (*opacity <= 0.0 || *grade == Grade::default()) {
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
                        shake_x: shake.x / self.height as f32,
                        shake_y: shake.y / self.height as f32,
                        shake_turn: shake.rotation.to_radians(),
                        shake_zoom: shake.zoom.max(0.01),
                        from_x: shake.from_x / self.height as f32,
                        from_y: shake.from_y / self.height as f32,
                        from_turn: shake.from_rotation.to_radians(),
                        mirror: if shake.mirror { 1.0 } else { 0.0 },
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
        self.videos.retain(|key, _| scene.layers.iter().any(|layer| matches!(layer, Layer::Video { clip, media, .. } if key == clip || key == media)));
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
    pub fn read_output(&mut self) -> Result<Vec<u8>, String> {
        let (width, height) = (self.width, self.height);
        let padded = (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
            * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let buffer = self
            .readback
            .get_or_insert_with(|| {
                self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("edit readback"),
                    size: u64::from(padded) * u64::from(height),
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                    mapped_at_creation: false,
                })
            })
            .clone();
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
        format!("{:?}", style.label).hash(&mut hasher);
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
                    label: style.label.as_ref().map(|label| {
                        // In its own box sitting right on the text's box (no gap); a
                        // little air when there's no box.
                        let ratio = label.size / style.size.max(1.0);
                        let above = style.background.map_or(label.size * 0.3, |background| {
                            background.pad_y * (1.0 + ratio)
                        });
                        LabelSpec {
                            text: &label.text,
                            px: label.size * scale,
                            color: label.color,
                            above: above * scale,
                        }
                    }),
                },
            ) else {
                return false;
            };
            self.upload_image(
                clip,
                key,
                &image.pixels,
                image.width,
                image.height,
                image.block,
            );
            self.texts.get_mut(clip).expect("text slot").label = image.label;
        }
        self.blur_glows(
            encoder,
            slots,
            clip,
            glow_key,
            &sigmas,
            glow_layers,
            shadow_layer,
        );
        true
    }

    /// Puts a rasterized image (premultiplied RGBA) in `clip`'s slot.
    fn upload_image(
        &mut self,
        clip: &str,
        key: u64,
        pixels: &[u8],
        width: u32,
        height: u32,
        block: [f32; 2],
    ) {
        let frame = self.frame_counter;
        let reuse = self
            .texts
            .get(clip)
            .is_some_and(|slot| slot.image.width == width && slot.image.height == height);
        if !reuse {
            let target = Target::new(
                &self.device,
                "edit text",
                width,
                height,
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
                    size: [width as f32, height as f32],
                    block,
                    label: None,
                    last_used: frame,
                },
            );
        }
        let slot = self.texts.get_mut(clip).expect("text slot");
        slot.key = key;
        slot.glow_key = 0;
        slot.block = block;
        slot.label = None;
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &slot.image.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            pixels,
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

    /// Blurred copies of `clip`'s image for its glow (and shadow), redone when they change.
    #[allow(clippy::too_many_arguments)]
    fn blur_glows(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        slots: &mut SlotWriter,
        clip: &str,
        glow_key: u64,
        sigmas: &[f32],
        glow_layers: usize,
        shadow_layer: Option<usize>,
    ) {
        let frame = self.frame_counter;
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
    }

    /// The waveform as an image with room for the glow, and its glow.
    #[allow(clippy::too_many_arguments)]
    fn prepare_waveform(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        slots: &mut SlotWriter,
        clip: &str,
        levels: &[f32],
        style: &edit_core::WaveformStyle,
        transform: &Transform,
        seconds: f32,
    ) {
        let scale = transform.scale.max(0.0);
        let radius = if style.glow.enabled {
            style.glow.radius.max(0.0) * scale
        } else {
            0.0
        };
        let mut sigmas: Vec<f32> = if radius > 0.0 {
            vec![radius / 4.0, radius / 2.0]
        } else {
            Vec::new()
        };
        let glow_layers = sigmas.len();
        // The line is drawn blurred (after its glow layers): no crisp edges anywhere.
        let soft_layer = (style.kind == edit_core::WaveformKind::Line).then(|| {
            sigmas.push(LINE_SOFTNESS * scale.max(0.05));
            glow_layers
        });
        let pad = radius * 2.0 + 2.0 + LINE_SOFTNESS * 3.0 * scale;
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        for level in levels {
            ((level * 1024.0) as u32).hash(&mut hasher);
        }
        for value in [style.width, style.height, style.fill, scale, pad] {
            value.to_bits().hash(&mut hasher);
        }
        format!("{:?}", style.kind).hash(&mut hasher);
        style.strands.hash(&mut hasher);
        let tick = line_tick(seconds);
        if style.kind == edit_core::WaveformKind::Line {
            tick.hash(&mut hasher);
        }
        for value in style.color.0 {
            value.to_bits().hash(&mut hasher);
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
        if self.texts.get(clip).is_none_or(|slot| slot.key != key) {
            let image = match style.kind {
                edit_core::WaveformKind::Bars => rasterize_waveform(levels, style, scale, pad),
                edit_core::WaveformKind::Line => rasterize_line(levels, style, scale, pad, tick),
            };
            self.upload_image(
                clip,
                key,
                &image.pixels,
                image.width,
                image.height,
                [0.0, 0.0],
            );
        }
        self.blur_glows(
            encoder,
            slots,
            clip,
            glow_key,
            &sigmas,
            glow_layers,
            soft_layer,
        );
    }

    /// Draws `clip`'s prepared image at `placed`: its glow first (wide, then
    /// close) when tinted, then the image, or its blurred copy when `soft`.
    #[allow(clippy::too_many_arguments)]
    fn draw_slot(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        slots: &mut SlotWriter,
        current: usize,
        clip: &str,
        placed: &Transform,
        glow: Option<[f32; 4]>,
        opacity: f32,
        soft: bool,
    ) {
        let Some(slot) = self.texts.get(clip) else {
            return;
        };
        let half_canvas = [self.width as f32 / 2.0, self.height as f32 / 2.0];
        if let Some(tint) = glow {
            for (_, layer) in slot.glows[..slot.glow_layers.min(slot.glows.len())]
                .iter()
                .rev()
            {
                let uniforms =
                    quad_uniforms(placed, slot.size, half_canvas, opacity, tint, MODE_GLOW);
                let offset = slots.push(&self.queue, &self.uniforms, bytemuck::bytes_of(&uniforms));
                let group = self.bind(&layer.view);
                draw(
                    encoder,
                    &self.over_pipeline,
                    &self.accum[current].view,
                    &group,
                    offset,
                    4,
                    None,
                );
            }
        }
        let uniforms = quad_uniforms(
            placed,
            slot.size,
            half_canvas,
            opacity,
            [1.0; 4],
            MODE_PREMULTIPLIED,
        );
        let offset = slots.push(&self.queue, &self.uniforms, bytemuck::bytes_of(&uniforms));
        let body = soft
            .then(|| slot.shadow_layer.and_then(|index| slot.glows.get(index)))
            .flatten()
            .map_or(&slot.image.view, |(_, blurred)| &blurred.view);
        let group = self.bind(body);
        draw(
            encoder,
            &self.over_pipeline,
            &self.accum[current].view,
            &group,
            offset,
            4,
            None,
        );
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
        blur: 0.0,
        _pad: [0; 2],
    }
}

#[derive(Default)]
struct SlotWriter {
    next: u64,
}

impl SlotWriter {
    fn push(&mut self, queue: &wgpu::Queue, buffer: &wgpu::Buffer, bytes: &[u8]) -> u32 {
        let slot = self.next;
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

/// Each bar's height (0..1) for a waveform: the loudest moment of the heard
/// sound in its slice of the window around now, eased so speech reads well,
/// and tapered toward the ends.
pub fn waveform_levels(
    peaks: &HashMap<String, Vec<u8>>,
    sources: &[edit_core::WaveSource],
    style: &edit_core::WaveformStyle,
    count: usize,
) -> Vec<f32> {
    let bars = count.clamp(1, 1024);
    let window = f64::from(style.window.max(0.01));
    let slice = window / bars as f64;
    (0..bars)
        .map(|index| {
            let offset = ((index as f64 + 0.5) / bars as f64 - 0.5) * window;
            let loudest = sources
                .iter()
                .filter_map(|source| {
                    let levels = peaks.get(&source.media)?;
                    let from =
                        (source.time + (offset - slice / 2.0) * source.speed).max(source.from);
                    let to = (source.time + (offset + slice / 2.0) * source.speed).min(source.to);
                    if to <= from {
                        return Some(0.0);
                    }
                    let first = (from * PEAKS_PER_SECOND).floor().max(0.0) as usize;
                    let last = ((to * PEAKS_PER_SECOND).ceil() as usize).min(levels.len());
                    let peak = levels
                        .get(first..last.max(first))?
                        .iter()
                        .copied()
                        .max()
                        .unwrap_or(0);
                    Some(f32::from(peak) / 255.0 * source.gain)
                })
                .fold(0.0_f32, f32::max);
            let taper = (std::f32::consts::PI * (index as f32 + 0.5) / bars as f32).sin();
            ((loudest * style.gain).clamp(0.0, 1.0).powf(0.7) * (0.3 + 0.7 * taper)).clamp(0.0, 1.0)
        })
        .collect()
}

/// How many levels a waveform reads across its width: one per bar, or a point every ~24 px of line.
pub fn wave_points(style: &edit_core::WaveformStyle, transform: &Transform) -> usize {
    match style.kind {
        edit_core::WaveformKind::Bars => style.bars.clamp(1, 512) as usize,
        edit_core::WaveformKind::Line => {
            ((style.width * transform.scale.max(0.0) / 24.0).round() as usize).clamp(12, 140)
        }
    }
}

/// The line's blur (sigma, px at scale 1): it's drawn soft, never crisp.
const LINE_SOFTNESS: f32 = 2.8;

/// The line's tangle changes this many times a second (on any frame rate).
const LINE_TICKS: f32 = 24.0;

fn line_tick(seconds: f32) -> u64 {
    (seconds.max(0.0) * LINE_TICKS).floor() as u64
}

/// A repeatable random number in -1..1 for (strand, point, tick).
fn jitter(strand: u32, point: usize, tick: u64, salt: u64) -> f32 {
    let mut x =
        (u64::from(strand) << 48) ^ ((point as u64) << 24) ^ tick.wrapping_mul(0x9E37_79B9) ^ salt;
    x ^= x >> 33;
    x = x.wrapping_mul(0xff51_afd7_ed55_8ccd);
    x ^= x >> 33;
    x = x.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
    x ^= x >> 33;
    (x >> 40) as f32 / (1u64 << 23) as f32 - 1.0
}

/// Tangled strands: each zigzags up and down by the sound's level at each
/// point (a real signal swings both ways), wandering sideways where it's
/// loud, so the strands cross and knot; silence is a flat line.
pub fn rasterize_line(
    levels: &[f32],
    style: &edit_core::WaveformStyle,
    scale: f32,
    pad: f32,
    tick: u64,
) -> WaveImage {
    let span_w = (style.width * scale).max(1.0);
    let span_h = (style.height * scale).max(1.0);
    let width = (span_w + pad * 2.0).ceil() as u32;
    let height = (span_h + pad * 2.0).ceil() as u32;
    let mut pixels = vec![0_u8; (width * height * 4) as usize];
    let count = levels.len().max(2);
    let step = span_w / (count - 1) as f32;
    let middle = height as f32 / 2.0;
    let thickness = (6.0 * scale).max(1.0);
    let strands = style.strands.clamp(1, 8);
    for strand in 0..strands {
        let strength = 1.0 - 0.5 * strand as f32 / strands as f32;
        let points: Vec<(f32, f32)> = levels
            .iter()
            .enumerate()
            .map(|(index, level)| {
                // Below a whisper (room noise, breath) the line lies flat, and
                // quiet sound stays small (an expander): speech and loud sounds spike.
                let level = ((level - 0.24) / 0.76).max(0.0).powf(1.6);
                // Swings mostly alternate, like a signal, but not like clockwork.
                let flip = if jitter(strand, index, tick, 4) > 0.6 {
                    -1.0
                } else {
                    1.0
                };
                let swing = if index % 2 == 0 { flip } else { -flip };
                let amount = 0.25 + 0.75 * jitter(strand, index, tick, 1).abs();
                let y = middle
                    + swing * amount * level * span_h / 2.0
                    + jitter(strand, index, tick, 2) * (0.4 + 1.5 * level) * scale;
                // Loud stretches wander sideways, so strands loop over each other.
                let x =
                    pad + step * index as f32 + jitter(strand, index, tick, 3) * step * 1.2 * level;
                (x, y)
            })
            .collect();
        // Turbulent displace: the whole tangle drifts and buckles where it's loud;
        // in quiet it barely stirs (an almost flat line, just alive).
        let time = tick as f32 / LINE_TICKS;
        let curve: Vec<(f32, f32)> = smooth(&points, 6)
            .into_iter()
            .map(|(x, y)| {
                let loud = ((y - middle).abs() / (span_h / 2.0)).min(1.0);
                let reach = (1.5 + 32.0 * loud) * scale;
                let (u, v) = (x / (70.0 * scale), y / (70.0 * scale));
                // Plus a fine, jittery ripple: kinks all along the strands.
                let (fu, fv) = (x / (18.0 * scale), y / (18.0 * scale));
                let ripple = (0.5 + 6.5 * loud.sqrt()) * scale;
                (
                    x + turbulence(u, v, time, 11) * reach
                        + turbulence(fu, fv, time * 2.0, 21) * ripple * 0.6,
                    y + turbulence(u, v, time, 12) * reach * 1.4
                        + turbulence(fu, fv, time * 2.0, 22) * ripple,
                )
            })
            .collect();
        for pair in curve.windows(2) {
            stroke(
                &mut pixels,
                width,
                height,
                pair[0],
                pair[1],
                (thickness, 3.2 * scale),
                style.color,
                strength,
                false,
            );
        }
    }
    WaveImage {
        width,
        height,
        pixels,
    }
}

/// Smooth noise in -1..1 over (u, v), drifting with `time` (two octaves of value noise).
fn turbulence(u: f32, v: f32, time: f32, salt: u64) -> f32 {
    let octave = |u: f32, v: f32, salt: u64| {
        let (x0, y0) = (u.floor(), v.floor());
        let (fx, fy) = (u - x0, v - y0);
        let (sx, sy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
        let corner = |dx: f32, dy: f32| {
            let (cx, cy) = ((x0 + dx) as i64, (y0 + dy) as i64);
            jitter(
                salt as u32,
                cx.rem_euclid(1 << 20) as usize,
                cy.rem_euclid(1 << 20) as u64,
                salt,
            )
        };
        let top = corner(0.0, 0.0) + (corner(1.0, 0.0) - corner(0.0, 0.0)) * sx;
        let bottom = corner(0.0, 1.0) + (corner(1.0, 1.0) - corner(0.0, 1.0)) * sx;
        top + (bottom - top) * sy
    };
    octave(u + time * 0.35, v - time * 0.2, salt) * 0.65
        + octave(u * 2.3 - time * 0.6, v * 2.3 + time * 0.45, salt + 7) * 0.35
}

/// A Catmull–Rom curve through `points`, `steps` segments between each pair.
fn smooth(points: &[(f32, f32)], steps: usize) -> Vec<(f32, f32)> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let at = |index: isize| points[index.clamp(0, points.len() as isize - 1) as usize];
    let mut out = Vec::with_capacity(points.len() * steps);
    for index in 0..points.len() as isize - 1 {
        let (p0, p1, p2, p3) = (at(index - 1), at(index), at(index + 1), at(index + 2));
        for step in 0..steps {
            let t = step as f32 / steps as f32;
            let (t2, t3) = (t * t, t * t * t);
            let blend = |a: f32, b: f32, c: f32, d: f32| {
                0.5 * (2.0 * b
                    + (-a + c) * t
                    + (2.0 * a - 5.0 * b + 4.0 * c - d) * t2
                    + (-a + 3.0 * b - 3.0 * c + d) * t3)
            };
            out.push((blend(p0.0, p1.0, p2.0, p3.0), blend(p0.1, p1.1, p2.1, p3.1)));
        }
    }
    out.push(*points.last().expect("points"));
    out
}

/// A soft line from `a` to `b`, (width, feather) px: its edges fade over the
/// feather (a blur, as the house look wants). Kept where it's brightest, or
/// `over` what's there.
#[allow(clippy::too_many_arguments)]
fn stroke(
    pixels: &mut [u8],
    width: u32,
    height: u32,
    a: (f32, f32),
    b: (f32, f32),
    (thickness, feather): (f32, f32),
    color: edit_core::Rgba,
    strength: f32,
    over: bool,
) {
    let half = thickness / 2.0;
    let feather = feather.max(0.5);
    let reach = half + feather;
    let x0 = ((a.0.min(b.0) - reach - 1.0).floor().max(0.0)) as u32;
    let x1 = ((a.0.max(b.0) + reach + 1.0).ceil() as u32).min(width);
    let y0 = ((a.1.min(b.1) - reach - 1.0).floor().max(0.0)) as u32;
    let y1 = ((a.1.max(b.1) + reach + 1.0).ceil() as u32).min(height);
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let length = (dx * dx + dy * dy).max(1e-6);
    let [r, g, bl, alpha] = color.0;
    for y in y0..y1 {
        for x in x0..x1 {
            let (px, py) = (x as f32 + 0.5 - a.0, y as f32 + 0.5 - a.1);
            let t = ((px * dx + py * dy) / length).clamp(0.0, 1.0);
            let (ex, ey) = (px - dx * t, py - dy * t);
            let distance = (ex * ex + ey * ey).sqrt();
            // Full inside the line, easing to nothing across the feather.
            let t = ((reach - distance) / (2.0 * feather)).clamp(0.0, 1.0);
            let coverage = t * t * (3.0 - 2.0 * t) * alpha * strength;
            if coverage <= 0.0 {
                continue;
            }
            let at = ((y * width + x) * 4) as usize;
            let existing = f32::from(pixels[at + 3]) / 255.0;
            if over {
                // Over what's there (the core over its strand).
                let keep = 1.0 - coverage;
                let blend = |channel: f32, old: u8| {
                    (channel * coverage * 255.0 + f32::from(old) * keep).round() as u8
                };
                pixels[at] = blend(r, pixels[at]);
                pixels[at + 1] = blend(g, pixels[at + 1]);
                pixels[at + 2] = blend(bl, pixels[at + 2]);
                pixels[at + 3] = ((coverage + existing * keep) * 255.0).round().min(255.0) as u8;
                continue;
            }
            // Strands keep their brightest: joints between segments don't double up.
            if coverage <= existing {
                continue;
            }
            pixels[at] = (r * coverage * 255.0).round() as u8;
            pixels[at + 1] = (g * coverage * 255.0).round() as u8;
            pixels[at + 2] = (bl * coverage * 255.0).round() as u8;
            pixels[at + 3] = (coverage * 255.0).round() as u8;
        }
    }
}

/// A waveform drawn on the CPU: premultiplied RGBA, `pad` px of room around the bars.
pub struct WaveImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

/// Mirrored bars with round ends, anti-aliased; the quietest still shows as a dot.
pub fn rasterize_waveform(
    levels: &[f32],
    style: &edit_core::WaveformStyle,
    scale: f32,
    pad: f32,
) -> WaveImage {
    let span_w = (style.width * scale).max(1.0);
    let span_h = (style.height * scale).max(1.0);
    let width = (span_w + pad * 2.0).ceil() as u32;
    let height = (span_h + pad * 2.0).ceil() as u32;
    let mut pixels = vec![0_u8; (width * height * 4) as usize];
    let slot = span_w / levels.len().max(1) as f32;
    let bar = (slot * style.fill.clamp(0.05, 1.0)).max(1.0);
    let radius = bar / 2.0;
    let middle = height as f32 / 2.0;
    let [r, g, b, a] = style.color.0;
    for (index, level) in levels.iter().enumerate() {
        let center_x = pad + slot * (index as f32 + 0.5);
        // Half the bar's length between the centres of its round ends.
        let half = (level * span_h / 2.0 - radius).max(0.0);
        let x0 = ((center_x - radius - 1.0).floor().max(0.0)) as u32;
        let x1 = ((center_x + radius + 1.0).ceil() as u32).min(width);
        let y0 = ((middle - half - radius - 1.0).floor().max(0.0)) as u32;
        let y1 = ((middle + half + radius + 1.0).ceil() as u32).min(height);
        for y in y0..y1 {
            for x in x0..x1 {
                let px = x as f32 + 0.5 - center_x;
                let py = (y as f32 + 0.5 - middle).abs() - half;
                // Distance to the capsule: a vertical segment grown by the radius.
                let distance = (px * px + py.max(0.0) * py.max(0.0)).sqrt() - radius;
                let coverage = (0.5 - distance).clamp(0.0, 1.0) * a;
                if coverage <= 0.0 {
                    continue;
                }
                let at = ((y * width + x) * 4) as usize;
                let existing = f32::from(pixels[at + 3]) / 255.0;
                let alpha = coverage.max(existing);
                pixels[at] = (r * alpha * 255.0).round() as u8;
                pixels[at + 1] = (g * alpha * 255.0).round() as u8;
                pixels[at + 2] = (b * alpha * 255.0).round() as u8;
                pixels[at + 3] = (alpha * 255.0).round() as u8;
            }
        }
    }
    WaveImage {
        width,
        height,
        pixels,
    }
}

#[cfg(test)]
mod waveform_tests {
    use super::*;
    use edit_core::{WaveSource, WaveformStyle};

    fn source(time: f64) -> WaveSource {
        WaveSource {
            media: "m".into(),
            time,
            speed: 1.0,
            gain: 1.0,
            from: 0.0,
            to: 10.0,
        }
    }

    #[test]
    fn bars_follow_the_sound_around_now() {
        // Silence for a second, then loud.
        let mut levels = vec![0_u8; 100];
        levels.extend(vec![255_u8; 100]);
        let peaks = HashMap::from([("m".to_owned(), levels)]);
        let style = WaveformStyle {
            bars: 10,
            window: 1.0,
            ..WaveformStyle::default()
        };
        let bars = waveform_levels(&peaks, &[source(1.0)], &style, 10);
        // The past half of the window is quiet, the coming half loud.
        assert!(bars[..5].iter().all(|bar| *bar < 0.05), "{bars:?}");
        assert!(bars[5..].iter().all(|bar| *bar > 0.3), "{bars:?}");
        // Nothing heard, or no levels yet: flat.
        assert!(waveform_levels(&peaks, &[], &style, 10)
            .iter()
            .all(|bar| *bar == 0.0));
        assert!(waveform_levels(&HashMap::new(), &[source(1.0)], &style, 10)
            .iter()
            .all(|bar| *bar == 0.0));
        // Outside the clip's stretch of the media is silence.
        let clipped = WaveSource {
            to: 1.0,
            ..source(1.0)
        };
        assert!(waveform_levels(&peaks, &[clipped], &style, 10)
            .iter()
            .all(|bar| *bar < 0.05));
    }

    #[test]
    fn bars_are_drawn_mirrored_with_room_for_the_glow() {
        let style = WaveformStyle {
            kind: edit_core::WaveformKind::Bars,
            bars: 4,
            width: 100.0,
            height: 50.0,
            color: edit_core::Rgba::WHITE,
            ..WaveformStyle::default()
        };
        let image = rasterize_waveform(&[0.0, 1.0, 0.5, 0.0], &style, 1.0, 10.0);
        assert_eq!((image.width, image.height), (120, 70));
        let alpha = |x: u32, y: u32| image.pixels[((y * image.width + x) * 4 + 3) as usize];
        // The full bar reaches from near the top to near the bottom; the empty one is a dot.
        let tall_x = 10 + 25 + 12;
        assert!(alpha(tall_x, 12) > 200 && alpha(tall_x, 57) > 200);
        let quiet_x = 10 + 12;
        assert!(alpha(quiet_x, 35) > 200 && alpha(quiet_x, 25) == 0);
        // Mirrored about the middle.
        assert_eq!(alpha(tall_x, 20), alpha(tall_x, 49));
    }

    #[test]
    fn a_line_is_flat_in_silence_and_swings_with_sound() {
        let style = WaveformStyle {
            width: 200.0,
            height: 100.0,
            strands: 2,
            ..WaveformStyle::default()
        };
        let lit_rows = |image: &WaveImage| {
            (0..image.height)
                .filter(|y| {
                    (0..image.width)
                        .any(|x| image.pixels[((y * image.width + x) * 4 + 3) as usize] > 0)
                })
                .count()
        };
        let quiet = rasterize_line(&[0.0; 30], &style, 1.0, 10.0, 0);
        let loud = rasterize_line(&[1.0; 30], &style, 1.0, 10.0, 0);
        // Quiet drifts a little with the warp; loud swings across the height.
        assert!(lit_rows(&quiet) < 30, "{}", lit_rows(&quiet));
        assert!(lit_rows(&loud) > 60, "{}", lit_rows(&loud));
        // The same moment draws the same tangle (preview and export agree); the next differs.
        assert!(rasterize_line(&[1.0; 30], &style, 1.0, 10.0, 0).pixels == loud.pixels);
        assert!(rasterize_line(&[1.0; 30], &style, 1.0, 10.0, 1).pixels != loud.pixels);
    }
}
