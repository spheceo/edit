//! Renders real frames on the local GPU. Writes PNGs to target/render-tests for eyeballing.

use edit_core::*;
use edit_render::{text::BUNDLED_FONTS, Renderer};

fn renderer(width: u32, height: u32) -> Option<Renderer> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
            .ok()?;
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).ok()?;
    let mut renderer = Renderer::new(device, queue, width, height);
    for (family, weight, file) in BUNDLED_FONTS {
        let bytes = edit_render::text::bundled_font_bytes(file).unwrap();
        renderer.fonts_mut().add(family, *weight, bytes).unwrap();
    }
    Some(renderer)
}

fn save(name: &str, width: u32, height: u32, pixels: &[u8]) {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/render-tests");
    std::fs::create_dir_all(&dir).unwrap();
    let file = std::fs::File::create(dir.join(name)).unwrap();
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .unwrap()
        .write_image_data(pixels)
        .unwrap();
}

#[test]
fn renders_gradient_glowing_title_and_grade() {
    let (w, h) = (960, 540);
    let Some(mut renderer) = renderer(w, h) else {
        eprintln!("no GPU adapter; skipping");
        return;
    };
    // A fake "video" frame: horizontal gradient.
    let mut frame = vec![0_u8; (w * h * 4) as usize];
    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            frame[i] = (x * 255 / w) as u8;
            frame[i + 1] = 40;
            frame[i + 2] = (y * 255 / h) as u8;
            frame[i + 3] = 255;
        }
    }
    renderer.upload_video_rgba("m1", w, h, &frame);
    let style = TextStyle {
        size: 110.0,
        weight: 900,
        glow: Glow {
            enabled: true,
            color: Some(Rgba([1.0, 0.3, 0.7, 1.0])),
            radius: 30.0,
            strength: 0.6,
        },
        ..TextStyle::default()
    };
    let scene = Scene {
        width: w,
        height: h,
        layers: vec![
            Layer::Video {
                clip: "c1".into(),
                media: "m1".into(),
                source_time: 0.0,
                transform: Transform::default(),
                opacity: 1.0,
            },
            Layer::Adjustment {
                grade: Grade {
                    exposure: -0.5,
                    contrast: 0.2,
                    saturation: -0.3,
                    temperature: 0.0,
                    vignette: 0.6,
                },
                shake: Default::default(),
                opacity: 1.0,
            },
            Layer::Text {
                clip: "t1".into(),
                text: "Edit\nglow".into(),
                style,
                transform: Transform {
                    x: 0.0,
                    y: 0.0,
                    scale: 1.0,
                    rotation: -4.0,
                    shake: 0.0,
                },
                animation: TextAnimation {
                    preset: TextPreset::Rise,
                    duration: 12.0,
                    stagger: 2.0,
                },
                local_frame: 9.0,
                opacity: 1.0,
            },
        ],
    };
    renderer.render(&scene);
    let pixels = renderer.read_output().unwrap();
    assert_eq!(pixels.len(), (w * h * 4) as usize);
    save("title.png", w, h, &pixels);
    // Centre should be bright (text), a corner dark (vignette).
    let at = |x: u32, y: u32| {
        let i = ((y * w + x) * 4) as usize;
        [pixels[i], pixels[i + 1], pixels[i + 2]]
    };
    let corner = at(2, 2);
    assert!(corner.iter().all(|c| *c < 40), "corner {corner:?}");

    // Rendering the same scene twice is deterministic.
    renderer.render(&scene);
    assert_eq!(renderer.read_output().unwrap(), pixels);
}

#[test]
fn renders_repack_subtitle_style() {
    let (w, h) = (1920, 1080);
    let Some(mut renderer) = renderer(w, h) else {
        eprintln!("no GPU adapter; skipping");
        return;
    };
    let mut frame = vec![0_u8; (w * h * 4) as usize];
    for (i, px) in frame.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        let (x, y) = (
            (i as u32 % w) as f32 / w as f32,
            (i as u32 / w) as f32 / h as f32,
        );
        *px = [
            (90.0 + 120.0 * x) as u8,
            (110.0 + 60.0 * y) as u8,
            (150.0 - 80.0 * x) as u8,
            255,
        ];
    }
    renderer.upload_video_rgba("m1", w, h, &frame);
    let style = TextStyle {
        font: "Montserrat".into(),
        weight: 600,
        size: 48.0,
        line_height: 1.15,
        max_width: Some(1920.0 * 0.8 - 24.0),
        background: Some(TextBox::default()),
        shadow: Some(TextShadow::default()),
        ..TextStyle::default()
    };
    let scene = Scene {
        width: w,
        height: h,
        layers: vec![
            Layer::Video { clip: "c1".into(), media: "m1".into(), source_time: 0.0, transform: Transform::default(), opacity: 1.0 },
            Layer::Text {
                clip: "s1".into(),
                text: "This is how a subtitle looks in Repack's house style, wrapping onto a second line when it runs long".into(),
                style,
                transform: Transform { y: 1080.0 * 0.4, ..Transform::default() },
                animation: TextAnimation::default(),
                local_frame: 0.0,
                opacity: 1.0,
            },
        ],
    };
    renderer.render(&scene);
    let pixels = renderer.read_output().unwrap();
    save("subtitle.png", w, h, &pixels);
    // The box darkens the band behind the subtitle.
    let at = |x: u32, y: u32| {
        let i = ((y * w + x) * 4) as usize;
        pixels[i] as u32 + pixels[i + 1] as u32 + pixels[i + 2] as u32
    };
    assert!(
        at(325, 1028) < at(325, 700) / 2,
        "box should darken the subtitle band"
    );
}
