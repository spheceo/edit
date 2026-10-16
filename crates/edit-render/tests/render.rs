//! Renders real frames on the local GPU. Writes PNGs to target/render-tests for eyeballing.

use edit_core::*;
use edit_render::{text::BUNDLED_FONTS, Renderer};

// A test helper: failing here should fail the test.
#[allow(clippy::unwrap_used)]
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

// A test helper: failing here should fail the test.
#[allow(clippy::unwrap_used)]
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
fn keeps_uniforms_independent_beyond_512_draws() {
    let Some(mut renderer) = renderer(1200, 2) else {
        return;
    };
    renderer.upload_video_rgba("red", 1, 1, &[255, 0, 0, 255]);
    renderer.upload_video_rgba("blue", 1, 1, &[0, 0, 255, 255]);
    let scene = Scene {
        width: 1200,
        height: 2,
        layers: (0..600)
            .map(|index| Layer::Video {
                clip: format!("c{index}"),
                media: if index % 2 == 0 { "red" } else { "blue" }.into(),
                source_time: 0.0,
                transform: Transform {
                    x: -599.0 + index as f32 * 2.0,
                    ..Default::default()
                },
                opacity: 1.0,
                crop: Default::default(),
                frame: None,
            })
            .collect(),
    };
    renderer.render(&scene);
    let pixels = renderer.read_output().unwrap();
    for index in 0..600 {
        let pixel = &pixels[index * 8..index * 8 + 4];
        let expected = if index % 2 == 0 {
            [255, 0, 0, 255]
        } else {
            [0, 0, 255, 255]
        };
        assert_eq!(pixel, expected, "draw {index}");
    }
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
                crop: Default::default(),
                frame: None,
            },
            Layer::Adjustment {
                grade: Grade {
                    exposure: -0.5,
                    contrast: 0.2,
                    saturation: -0.3,
                    temperature: 0.0,
                    vignette: 0.6,
                    ..Grade::default()
                },
                shake: Default::default(),
                glitch: Default::default(),
                blur: Default::default(),
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
                shown_glyphs: None,
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
            Layer::Video { clip: "c1".into(), media: "m1".into(), source_time: 0.0, transform: Transform::default(), opacity: 1.0, crop: Default::default(), frame: None },
            Layer::Text {
                clip: "s1".into(),
                text: "This is how a subtitle looks in Repack's house style, wrapping onto a second line when it runs long".into(),
                style,
                transform: Transform { y: 1080.0 * 0.4, ..Transform::default() },
                animation: TextAnimation::default(),
                local_frame: 0.0,
                opacity: 1.0,
                shown_glyphs: None,
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

#[test]
fn independent_moments_of_one_source_do_not_share_a_texture() {
    let Some(mut renderer) = renderer(80, 40) else {
        return;
    };
    renderer.upload_video_rgba("left", 2, 2, &[255, 0, 0, 255].repeat(4));
    renderer.upload_video_rgba("right", 2, 2, &[0, 0, 255, 255].repeat(4));
    let layer = |clip: &str, x| Layer::Video {
        clip: clip.into(),
        media: "same-source".into(),
        source_time: 0.0,
        transform: Transform {
            x,
            scale: 0.5,
            ..Default::default()
        },
        opacity: 1.0,
        crop: Default::default(),
        frame: None,
    };
    renderer.render(&Scene {
        width: 80,
        height: 40,
        layers: vec![layer("left", -20.0), layer("right", 20.0)],
    });
    let pixels = renderer.read_output().unwrap();
    let left = (20 * 80 + 20) * 4;
    let right = (20 * 80 + 60) * 4;
    assert!(pixels[left] > 240 && pixels[left + 2] < 10);
    assert!(pixels[right] < 10 && pixels[right + 2] > 240);
}

#[test]
fn crops_a_picture_and_fades_a_gradient() {
    let Some(mut renderer) = renderer(100, 40) else {
        return;
    };
    // Left half red, right half blue.
    let mut picture = Vec::new();
    for _ in 0..2 {
        picture.extend_from_slice(&[255, 0, 0, 255, 0, 0, 255, 255]);
    }
    renderer.upload_video_rgba("halves", 2, 2, &picture);
    renderer.render(&Scene {
        width: 100,
        height: 40,
        layers: vec![
            // Fit to the 40-high frame (40×40, centred), its right half cut off:
            // only red, 20 wide, still where the left half was.
            Layer::Video {
                clip: "c1".into(),
                media: "halves".into(),
                source_time: 0.0,
                transform: Transform::default(),
                opacity: 1.0,
                crop: Crop {
                    right: 0.5,
                    ..Crop::default()
                },
                frame: None,
            },
            // Black, clear at 60% across, full by 90%.
            Layer::Solid {
                color: Rgba([0.0, 0.0, 0.0, 1.0]),
                opacity: 1.0,
                gradient: Some(Gradient { from: 0.6, to: 0.9 }),
            },
        ],
    });
    let pixels = renderer.read_output().unwrap();
    save("crop-gradient.png", 100, 40, &pixels);
    let at = |x: usize| {
        let i = (20 * 100 + x) * 4;
        [pixels[i], pixels[i + 1], pixels[i + 2]]
    };
    // The kept (red) half, where the left half of the picture was.
    assert!(at(40)[0] > 240 && at(40)[2] < 10, "{:?}", at(40));
    // Where the cut-off blue half was: nothing drawn.
    assert!(at(60)[2] < 10, "{:?}", at(60));
    // Clear before the gradient starts.
    assert!(at(35)[0] > 240, "{:?}", at(35));

    // Over white: untouched before 60%, darker on the way, black past 90%.
    renderer.render(&Scene {
        width: 100,
        height: 40,
        layers: vec![
            Layer::Solid {
                color: Rgba::WHITE,
                opacity: 1.0,
                gradient: None,
            },
            Layer::Solid {
                color: Rgba([0.0, 0.0, 0.0, 1.0]),
                opacity: 1.0,
                gradient: Some(Gradient { from: 0.6, to: 0.9 }),
            },
        ],
    });
    let pixels = renderer.read_output().unwrap();
    let grey = |x: usize| pixels[(20 * 100 + x) * 4];
    assert!(grey(50) > 250, "{}", grey(50));
    assert!(grey(75) > 20 && grey(75) < 235, "{}", grey(75));
    assert!(grey(95) < 5, "{}", grey(95));
}

#[test]
fn blurs_only_inside_the_region() {
    let (w, h) = (1920_u32, 1080_u32);
    let Some(mut renderer) = renderer(w, h) else {
        eprintln!("no GPU adapter; skipping");
        return;
    };
    // Busy detail everywhere: an 8 px checker over a colour gradient.
    let mut frame = vec![0_u8; (w * h * 4) as usize];
    for (i, px) in frame.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        let (x, y) = (i as u32 % w, i as u32 / w);
        let on = ((x / 8) + (y / 8)) % 2 == 0;
        let lift = if on { 150 } else { 0 };
        *px = [
            (40 + lift + x * 60 / w) as u8,
            (30 + lift + y * 60 / h) as u8,
            (70 + lift) as u8,
            255,
        ];
    }
    renderer.upload_video_rgba("m1", w, h, &frame);
    let footage = Layer::Video {
        clip: "c1".into(),
        media: "m1".into(),
        source_time: 0.0,
        transform: Transform::default(),
        opacity: 1.0,
        crop: Default::default(),
        frame: None,
    };
    let word = Layer::Text {
        clip: "t1".into(),
        text: "JANE DOE".into(),
        style: TextStyle {
            size: 120.0,
            weight: 900,
            glow: Glow {
                enabled: false,
                ..Glow::default()
            },
            ..TextStyle::default()
        },
        transform: Transform {
            x: 450.0,
            y: 250.0,
            ..Transform::default()
        },
        animation: TextAnimation::default(),
        local_frame: 0.0,
        opacity: 1.0,
        shown_glyphs: None,
    };
    let adjustment = |blur: Blur| Layer::Adjustment {
        grade: Grade::default(),
        shake: Default::default(),
        glitch: Default::default(),
        blur,
        opacity: 1.0,
    };
    // A face-sized ellipse left of centre and a rounded box over the word.
    let face = Blur {
        radius: 35.0,
        x: -400.0,
        y: -100.0,
        width: 360.0,
        height: 440.0,
        feather: 24.0,
        shape: BlurShape::Ellipse,
    };
    let name = Blur {
        radius: 30.0,
        x: 450.0,
        y: 250.0,
        width: 640.0,
        height: 160.0,
        feather: 12.0,
        shape: BlurShape::Rect,
    };
    let sharp = Scene {
        width: w,
        height: h,
        layers: vec![footage.clone(), word.clone()],
    };
    renderer.render(&sharp);
    let before = renderer.read_output().unwrap();
    let blurred = Scene {
        width: w,
        height: h,
        layers: vec![footage, word, adjustment(face), adjustment(name)],
    };
    renderer.render(&blurred);
    let after = renderer.read_output().unwrap();
    save("blur.png", w, h, &after);

    // Variance of the brightness over a 32 px square centred on (cx, cy).
    let variance = |pixels: &[u8], cx: u32, cy: u32| {
        let mut values = Vec::new();
        for y in cy - 16..cy + 16 {
            for x in cx - 16..cx + 16 {
                let i = ((y * w + x) * 4) as usize;
                values.push((pixels[i] as f64 + pixels[i + 1] as f64 + pixels[i + 2] as f64) / 3.0);
            }
        }
        let mean = values.iter().sum::<f64>() / values.len() as f64;
        values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64
    };
    // Inside the face's region (its centre and near its edge): smoothed away.
    let (fx, fy) = (960 - 400, 540 - 100);
    for (cx, cy) in [(fx, fy), (fx + 120, fy), (fx, fy - 160)] {
        let (sharp, soft) = (variance(&before, cx, cy), variance(&after, cx, cy));
        assert!(
            sharp > 1000.0,
            "the checker is busy at ({cx}, {cy}): {sharp}"
        );
        assert!(
            soft < sharp / 50.0,
            "blurred at ({cx}, {cy}): {soft} vs {sharp}"
        );
    }
    // The word under the rounded box: unreadable.
    let (sharp, soft) = (
        variance(&before, 960 + 450, 540 + 250),
        variance(&after, 960 + 450, 540 + 250),
    );
    assert!(
        soft < sharp / 10.0,
        "the word is blurred: {soft} vs {sharp}"
    );
    // Away from both regions (past the feather) every pixel is untouched.
    let touched = |x: u32, y: u32| {
        let (dx, dy) = (x as f32 - fx as f32, y as f32 - fy as f32);
        let in_face = (dx / (180.0 + 30.0)).powi(2) + (dy / (220.0 + 30.0)).powi(2) <= 1.0;
        let in_name =
            (x as f32 - 1410.0).abs() <= 320.0 + 16.0 && (y as f32 - 790.0).abs() <= 80.0 + 16.0;
        in_face || in_name
    };
    let mut checked = 0;
    for y in (0..h).step_by(3) {
        for x in (0..w).step_by(3) {
            if touched(x, y) {
                continue;
            }
            let i = ((y * w + x) * 4) as usize;
            assert_eq!(after[i..i + 4], before[i..i + 4], "({x}, {y}) changed");
            checked += 1;
        }
    }
    assert!(checked > 150_000);
}
