//! The "desktop" profile screen: a person's photo in a dark Photo Viewer
//! window and a few lines about them typed into a Notepad window beside it,
//! on a blue desktop with light beams, the whole screen slowly pushing in.
//! It's how the team's videos show someone when the only picture is a
//! mugshot or a still (a lone still never sits on black).
//!
//! The wallpaper and the two windows' frames (title bar, menus, buttons)
//! are pictures Edit draws itself (nothing of Microsoft's is shipped: the
//! wallpaper is a lookalike made of gradients and soft beams), written once
//! per size and title to `~/.edit/graphics/`. The photo and the lines are
//! ordinary clips over them, so the preview and the export draw it alike.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use edit_core::{Clip, Project, TrackKind};
use edit_render::text::{FontBook, GlyphCache, TextSpec};
use serde_json::{json, Value};

/// A new look is a new version: its files get new names, so projects using
/// the old ones keep them.
const VERSION: u32 = 1;

/// Where things sit at 1080p (pixels from the frame's top-left), measured
/// off the team's reference frame.
const PHOTO_VIEWER: [f64; 4] = [190.0, 160.0, 575.0, 800.0];
const NOTEPAD: [f64; 4] = [824.0, 230.0, 972.0, 658.0];
const TITLE_BAR: f64 = 43.0;
const MENU_BAR: f64 = 31.0;
/// The content area's inset from the window's sides and bottom.
const INSET: f64 = 10.0;
const LINE_SIZE: f64 = 42.0;
const LINE_STEP: f64 = 74.0;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Window {
    PhotoViewer,
    Notepad,
}

impl Window {
    fn rect(self) -> [f64; 4] {
        match self {
            Window::PhotoViewer => PHOTO_VIEWER,
            Window::Notepad => NOTEPAD,
        }
    }

    fn menus(self) -> &'static [&'static str] {
        match self {
            Window::PhotoViewer => &["File", "Edit", "Image", "View", "Help"],
            Window::Notepad => &["File", "Edit", "Search", "View", "Help"],
        }
    }

    fn slug(self) -> &'static str {
        match self {
            Window::PhotoViewer => "photo-viewer",
            Window::Notepad => "notepad",
        }
    }
}

/// The 1080p layout on a frame of `width` × `height`: scaled to fit and centred.
#[derive(Clone, Copy, Debug)]
pub struct Layout {
    pub width: f64,
    pub height: f64,
    pub k: f64,
    left: f64,
    top: f64,
}

impl Layout {
    pub fn new(width: u32, height: u32) -> Self {
        let (width, height) = (f64::from(width), f64::from(height));
        let k = (width / 1920.0).min(height / 1080.0);
        Layout {
            width,
            height,
            k,
            left: (width - 1920.0 * k) / 2.0,
            top: (height - 1080.0 * k) / 2.0,
        }
    }

    /// A 1080p rect [x, y, w, h] in project pixels.
    fn place(&self, [x, y, w, h]: [f64; 4]) -> [f64; 4] {
        [
            self.left + x * self.k,
            self.top + y * self.k,
            w * self.k,
            h * self.k,
        ]
    }

    /// The window's rect in project pixels.
    pub fn window(&self, window: Window) -> [f64; 4] {
        self.place(window.rect())
    }

    /// The window's content area (under its menus) in project pixels.
    pub fn content(&self, window: Window) -> [f64; 4] {
        let [x, y, w, h] = window.rect();
        let top = TITLE_BAR + MENU_BAR + 2.0;
        self.place([x + INSET, y + top, w - 2.0 * INSET, h - top - INSET])
    }

    /// A point (project pixels from the top-left) as a transform offset from the centre.
    fn centred(&self, x: f64, y: f64) -> (f64, f64) {
        (x - self.width / 2.0, y - self.height / 2.0)
    }
}

fn fonts() -> &'static FontBook {
    static BOOK: OnceLock<FontBook> = OnceLock::new();
    BOOK.get_or_init(|| {
        let mut book = FontBook::default();
        for (family, weight, file) in edit_render::text::BUNDLED_FONTS {
            if let Some(bytes) = edit_render::text::bundled_font_bytes(file) {
                let _ = book.add(family, *weight, bytes);
            }
        }
        book
    })
}

fn spec<'a>(
    text: &'a str,
    px: f64,
    weight: u16,
    color: [f32; 4],
    line_height: f64,
) -> TextSpec<'a> {
    static STILL: OnceLock<edit_core::TextAnimation> = OnceLock::new();
    TextSpec {
        text,
        align: edit_core::TextAlign::Left,
        family: "Geist",
        weight,
        px: px as f32,
        color: edit_core::Rgba(color),
        tracking: 0.0,
        line_height: line_height as f32,
        animation: STILL.get_or_init(edit_core::TextAnimation::default),
        local_frame: 0.0,
        shown_glyphs: None,
        pad: 2.0,
        max_width: None,
        label: None,
    }
}

/// The laid-out size (width, height) of `text` in Geist at `px`, as the
/// renderer lays it out.
pub fn text_block(text: &str, px: f64, weight: u16, line_height: f64) -> (f64, f64) {
    let mut cache = GlyphCache::default();
    edit_render::text::rasterize(
        fonts(),
        &mut cache,
        &spec(text, px, weight, [1.0; 4], line_height),
    )
    .map_or((0.0, 0.0), |image| {
        (f64::from(image.block[0]), f64::from(image.block[1]))
    })
}

/// Straight-alpha RGBA, drawn on with "over".
struct Canvas {
    width: usize,
    height: usize,
    pixels: Vec<[f32; 4]>,
}

impl Canvas {
    fn new(width: usize, height: usize) -> Self {
        Canvas {
            width,
            height,
            pixels: vec![[0.0; 4]; width * height],
        }
    }

    /// Paints `color` (straight alpha) over a pixel with `coverage` 0..1.
    fn blend(&mut self, x: i64, y: i64, color: [f32; 4], coverage: f32) {
        if x < 0 || y < 0 || x as usize >= self.width || y as usize >= self.height {
            return;
        }
        let Some(pixel) = self.pixels.get_mut(y as usize * self.width + x as usize) else {
            return;
        };
        let a = (color[3] * coverage).clamp(0.0, 1.0);
        let out = a + pixel[3] * (1.0 - a);
        if out <= 0.0 {
            return;
        }
        for channel in 0..3 {
            pixel[channel] = (color[channel] * a + pixel[channel] * pixel[3] * (1.0 - a)) / out;
        }
        pixel[3] = out;
    }

    /// A rectangle with anti-aliased edges (fractional pixels).
    fn rect(&mut self, x0: f64, y0: f64, x1: f64, y1: f64, color: [f32; 4]) {
        for y in (y0.floor() as i64)..(y1.ceil() as i64) {
            let cy = ((y as f64 + 1.0).min(y1) - (y as f64).max(y0)).clamp(0.0, 1.0);
            for x in (x0.floor() as i64)..(x1.ceil() as i64) {
                let cx = ((x as f64 + 1.0).min(x1) - (x as f64).max(x0)).clamp(0.0, 1.0);
                self.blend(x, y, color, (cx * cy) as f32);
            }
        }
    }

    /// The outline of a rectangle, `width` thick, inside its edges.
    fn frame(&mut self, x0: f64, y0: f64, x1: f64, y1: f64, width: f64, color: [f32; 4]) {
        self.rect(x0, y0, x1, y0 + width, color);
        self.rect(x0, y1 - width, x1, y1, color);
        self.rect(x0, y0 + width, x0 + width, y1 - width, color);
        self.rect(x1 - width, y0 + width, x1, y1 - width, color);
    }

    /// An anti-aliased line `width` thick.
    fn line(&mut self, from: (f64, f64), to: (f64, f64), width: f64, color: [f32; 4]) {
        let (dx, dy) = (to.0 - from.0, to.1 - from.1);
        let length = dx.hypot(dy).max(1e-6);
        let reach = width / 2.0 + 1.0;
        let (x0, x1) = (from.0.min(to.0) - reach, from.0.max(to.0) + reach);
        let (y0, y1) = (from.1.min(to.1) - reach, from.1.max(to.1) + reach);
        for y in (y0.floor() as i64)..=(y1.ceil() as i64) {
            for x in (x0.floor() as i64)..=(x1.ceil() as i64) {
                let (px, py) = (x as f64 + 0.5 - from.0, y as f64 + 0.5 - from.1);
                let along = ((px * dx + py * dy) / length).clamp(0.0, length);
                let (nx, ny) = (from.0 + dx * along / length, from.1 + dy * along / length);
                let distance = (x as f64 + 0.5 - nx).hypot(y as f64 + 0.5 - ny);
                let coverage = (width / 2.0 + 0.5 - distance).clamp(0.0, 1.0);
                if coverage > 0.0 {
                    self.blend(x, y, color, coverage as f32);
                }
            }
        }
    }

    /// Text with its block's left edge at `x` and its middle at `y`.
    fn text(&mut self, text: &str, x: f64, y: f64, px: f64, color: [f32; 4]) -> f64 {
        let mut cache = GlyphCache::default();
        let Some(image) =
            edit_render::text::rasterize(fonts(), &mut cache, &spec(text, px, 400, color, 1.2))
        else {
            return 0.0;
        };
        let block = f64::from(image.block[0]);
        let left = (x + block / 2.0 - f64::from(image.width) / 2.0).round() as i64;
        let top = (y - f64::from(image.height) / 2.0).round() as i64;
        for row in 0..image.height as usize {
            for column in 0..image.width as usize {
                let at = (row * image.width as usize + column) * 4;
                let Some(&[r, g, b, a]) = image.pixels.get(at..at + 4) else {
                    continue;
                };
                if a == 0 {
                    continue;
                }
                // Premultiplied to straight.
                let alpha = f32::from(a) / 255.0;
                let color = [
                    f32::from(r) / 255.0 / alpha,
                    f32::from(g) / 255.0 / alpha,
                    f32::from(b) / 255.0 / alpha,
                    1.0,
                ];
                self.blend(left + column as i64, top + row as i64, color, alpha);
            }
        }
        block
    }

    fn png(&self, alpha: bool) -> Result<Vec<u8>, String> {
        let channels = if alpha { 4 } else { 3 };
        let mut bytes = Vec::with_capacity(self.width * self.height * channels);
        // A whisper of noise so the gradients never band.
        let mut seed = 0x2545_f491_u32;
        for pixel in &self.pixels {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let dither = (f32::from((seed & 0xff) as u8) / 255.0 - 0.5) / 255.0 * 1.5;
            for channel in pixel.iter().take(3) {
                bytes.push(((channel + dither).clamp(0.0, 1.0) * 255.0).round() as u8);
            }
            if alpha {
                bytes.push((pixel[3].clamp(0.0, 1.0) * 255.0).round() as u8);
            }
        }
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, self.width as u32, self.height as u32);
            encoder.set_color(if alpha {
                png::ColorType::Rgba
            } else {
                png::ColorType::Rgb
            });
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
            writer
                .write_image_data(&bytes)
                .map_err(|error| error.to_string())?;
        }
        Ok(out)
    }
}

fn hex(value: u32) -> [f32; 4] {
    [
        ((value >> 16) & 0xff) as f32 / 255.0,
        ((value >> 8) & 0xff) as f32 / 255.0,
        (value & 0xff) as f32 / 255.0,
        1.0,
    ]
}

/// The wallpaper: dark navy at the edges, lit blue through the middle by a
/// light off the right edge that throws broad soft beams across the whole
/// picture (one across the top, one along the bottom, a thin bright streak
/// between, with crisp bright edges), brightest near the light, like light
/// through a window. Drawn, not copied: no logo, no Microsoft artwork.
pub fn wallpaper(width: u32, height: u32) -> Result<Vec<u8>, String> {
    let (w, h) = (width as usize, height as usize);
    let mut canvas = Canvas::new(w, h);
    let aspect = f64::from(width) / f64::from(height);
    // The light: well off the right edge, a little below the middle (units
    // of the frame's height).
    let source = (1.25 * aspect, 0.55);
    // Beams, by where their middle crosses the left edge and how wide they
    // are there (frame heights), and how strong.
    let beams: [(f64, f64, f64); 4] = [
        (-0.08, 0.24, 1.1),
        (0.74, 0.07, 0.22),
        (1.34, 0.26, 1.0),
        (0.36, 0.05, 0.18),
    ];
    // Crisp bright lines along some of their edges.
    let edges: [(f64, f64, f64); 5] = [
        (0.155, 0.006, 0.55),
        (0.472, 0.004, 0.75),
        (0.53, 0.01, 0.2),
        (0.99, 0.008, 0.45),
        (-0.33, 0.01, 0.3),
    ];
    let smooth = |edge0: f64, edge1: f64, x: f64| {
        let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    };
    for y in 0..h {
        let v = (y as f64 + 0.5) / h as f64;
        for x in 0..w {
            let u = (x as f64 + 0.5) / h as f64;
            // Where the line from the light through this pixel crosses the
            // left edge: beams are straight lines from the light.
            let along = (source.0 - u).max(1e-3);
            let left = source.1 + (v - source.1) * source.0 / along;
            // Stronger near the light.
            let near = (u / aspect).clamp(0.0, 1.0);
            let reach = 0.3 + 0.7 * near.powf(1.4);
            let mut light = 0.0;
            for (middle, half, strength) in beams {
                let off = (left - middle).abs() / half;
                light += strength * (1.0 - smooth(0.35, 1.0, off)) * reach;
            }
            for (at, sharp, strength) in edges {
                // Sharper near the light, where the lines converge.
                let off = (left - at) / (sharp * (0.4 + 0.6 * (1.0 - near)) + 0.002);
                light += strength * (-off * off).exp() * (0.25 + 0.75 * near);
            }
            // The light itself, just off the right edge: panes of white.
            let (gx, gy) = (aspect - u, (v - source.1) * 1.6);
            light += 1.5 * (-(gx.hypot(gy) / 0.24).powi(2)).exp();
            // The base: dark at the edges and corners, deep blue in the middle.
            let middle = (-((u / aspect - 0.55) / 0.42).powi(2)).exp();
            let band = (-((v - 0.4) / 0.42).powi(2)).exp();
            let base_light = 0.25 + 0.75 * middle * band;
            let base = [
                0.008 + 0.03 * base_light,
                0.035 + 0.15 * base_light,
                0.06 + 0.27 * base_light,
            ];
            let light = light.min(2.2);
            // Light is cyan-blue, turning white where it's strongest.
            let white = smooth(0.8, 1.8, light);
            let tint = [0.08 + 0.85 * white, 0.42 + 0.55 * white, 0.70 + 0.3 * white];
            let pixel = canvas.pixels.get_mut(y * w + x).ok_or("wallpaper pixel")?;
            for channel in 0..3 {
                let lit = base[channel] + tint[channel] * light * 0.6;
                // A soft shoulder so the brightest light rolls off to white.
                pixel[channel] = (1.0 - (-lit * 1.3).exp()) as f32;
            }
            pixel[3] = 1.0;
        }
    }
    canvas.png(false)
}

/// A window's frame at the layout's scale: a dark window with a title bar
/// (icon, title, minimise / maximise / close), a menu bar, a 1 px border
/// and its content area (the photo or the lines go over it).
pub fn window(window: Window, title: &str, layout: &Layout) -> Result<Vec<u8>, String> {
    let k = layout.k;
    let [_, _, w, h] = layout.window(window);
    let (w, h) = (w.round(), h.round());
    let mut canvas = Canvas::new(w as usize, h as usize);
    let body = hex(0x302f2e);
    canvas.rect(0.0, 0.0, w, h, body);
    canvas.rect(0.0, 0.0, w, (TITLE_BAR + MENU_BAR) * k, hex(0x393837));
    // The content area.
    let [cx, cy, cw, ch] = layout.content(window);
    let [wx, wy, _, _] = layout.window(window);
    let (cx, cy) = (cx - wx, cy - wy);
    match window {
        Window::PhotoViewer => canvas.rect(cx, cy, cx + cw, cy + ch, hex(0x2a2928)),
        Window::Notepad => {
            canvas.rect(cx, cy, cx + cw, cy + ch, hex(0x3b3937));
            // A little darker towards the bottom, as on a real screen.
            let rows = ch.ceil() as i64;
            for row in 0..rows {
                let shade = 0.2 * row as f64 / rows.max(1) as f64;
                let y = cy + row as f64;
                canvas.rect(
                    cx,
                    y,
                    cx + cw,
                    (y + 1.0).min(cy + ch),
                    [0.0, 0.0, 0.0, shade as f32],
                );
            }
            canvas.frame(cx, cy, cx + cw, cy + ch, k.max(1.0), hex(0x4a4846));
        }
    }
    canvas.frame(0.0, 0.0, w, h, k.max(1.0), hex(0x5a5856));
    // The icon.
    let middle = TITLE_BAR * k / 2.0;
    let icon = 22.0 * k;
    let (ix, iy) = (17.0 * k, middle - icon / 2.0);
    let light = hex(0xc8c8c8);
    let stroke = 1.6 * k;
    match window {
        Window::PhotoViewer => {
            // A picture frame with a person in it.
            canvas.frame(ix, iy, ix + icon, iy + icon, stroke, light);
            let head = (ix + icon / 2.0, iy + icon * 0.42);
            for step in 0..24 {
                let (a, b) = (
                    f64::from(step) / 24.0 * std::f64::consts::TAU,
                    f64::from(step + 1) / 24.0 * std::f64::consts::TAU,
                );
                let r = icon * 0.17;
                canvas.line(
                    (head.0 + r * a.cos(), head.1 + r * a.sin()),
                    (head.0 + r * b.cos(), head.1 + r * b.sin()),
                    stroke * 0.9,
                    light,
                );
            }
            canvas.line(
                (ix + icon * 0.24, iy + icon * 0.86),
                (ix + icon * 0.5, iy + icon * 0.66),
                stroke,
                light,
            );
            canvas.line(
                (ix + icon * 0.5, iy + icon * 0.66),
                (ix + icon * 0.76, iy + icon * 0.86),
                stroke,
                light,
            );
        }
        Window::Notepad => {
            // A notepad: a page with lines on it.
            canvas.frame(
                ix,
                iy + icon * 0.12,
                ix + icon,
                iy + icon * 0.88,
                stroke,
                light,
            );
            canvas.rect(ix, iy + icon * 0.12, ix + icon, iy + icon * 0.3, light);
            for line in 0..3 {
                let y = iy + icon * (0.45 + 0.13 * f64::from(line));
                canvas.line(
                    (ix + icon * 0.22, y),
                    (ix + icon * 0.78, y),
                    stroke * 0.7,
                    light,
                );
            }
        }
    }
    canvas.text(title, 52.0 * k, middle, 19.0 * k, hex(0xcfcfcf));
    // Minimise, maximise, close.
    let glyph = 7.5 * k;
    let grey = hex(0x9a9a9a);
    let thin = 1.2 * k;
    for (index, centre) in [w - 152.0 * k, w - 92.0 * k, w - 32.0 * k]
        .into_iter()
        .enumerate()
    {
        match index {
            0 => canvas.line(
                (centre - glyph, middle),
                (centre + glyph, middle),
                thin,
                grey,
            ),
            1 => canvas.frame(
                centre - glyph * 0.85,
                middle - glyph * 0.85,
                centre + glyph * 0.85,
                middle + glyph * 0.85,
                thin,
                grey,
            ),
            _ => {
                canvas.line(
                    (centre - glyph * 0.8, middle - glyph * 0.8),
                    (centre + glyph * 0.8, middle + glyph * 0.8),
                    thin,
                    grey,
                );
                canvas.line(
                    (centre - glyph * 0.8, middle + glyph * 0.8),
                    (centre + glyph * 0.8, middle - glyph * 0.8),
                    thin,
                    grey,
                );
            }
        }
    }
    // The menus.
    let menu_middle = (TITLE_BAR + MENU_BAR / 2.0) * k;
    let mut x = 18.0 * k;
    for item in window.menus() {
        let drawn = canvas.text(item, x, menu_middle, 18.0 * k, hex(0xd6d6d6));
        x += drawn + 22.0 * k;
    }
    canvas.png(true)
}

/// FNV-1a over a few strings, for file names.
fn hash(parts: &[&str]) -> u32 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for part in parts {
        for byte in part.bytes().chain(std::iter::once(0)) {
            hash = (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3);
        }
    }
    hash as u32
}

/// Writes `bytes` from `make` to `path` unless it's there already.
fn ensure(path: &Path, make: impl FnOnce() -> Result<Vec<u8>, String>) -> Result<(), String> {
    if path.is_file() {
        return Ok(());
    }
    let dir = path.parent().ok_or("graphics folder")?;
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    crate::store::write_atomic(path, &make()?).map_err(|error| error.to_string())
}

/// The files a desktop profile on a `width` × `height` frame needs, made
/// if missing: [wallpaper, photo viewer, notepad].
pub fn files(
    home: &Path,
    width: u32,
    height: u32,
    photo_title: &str,
    notepad_title: &str,
) -> Result<[PathBuf; 3], String> {
    let dir = home.join("graphics");
    let layout = Layout::new(width, height);
    let wallpaper_path = dir.join(format!("desktop-wallpaper-v{VERSION}-{width}x{height}.png"));
    ensure(&wallpaper_path, || wallpaper(width, height))?;
    let mut windows = Vec::new();
    for (kind, title) in [
        (Window::PhotoViewer, photo_title),
        (Window::Notepad, notepad_title),
    ] {
        let path = dir.join(format!(
            "desktop-{}-v{VERSION}-{width}x{height}-{:08x}.png",
            kind.slug(),
            hash(&[title])
        ));
        ensure(&path, || window(kind, title, &layout))?;
        windows.push(path);
    }
    let [photo_viewer, notepad]: [PathBuf; 2] = windows
        .try_into()
        .map_err(|_| "desktop windows".to_owned())?;
    Ok([wallpaper_path, photo_viewer, notepad])
}

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

    #[test]
    fn the_layout_matches_the_reference_and_scales() {
        let hd = Layout::new(1920, 1080);
        assert_eq!(hd.window(Window::PhotoViewer), PHOTO_VIEWER);
        let [x, y, w, h] = hd.content(Window::Notepad);
        assert!(x > NOTEPAD[0] && y > NOTEPAD[1] + TITLE_BAR && w < NOTEPAD[2] && h < NOTEPAD[3]);
        let uhd = Layout::new(3840, 2160);
        assert_eq!(uhd.window(Window::Notepad)[2], NOTEPAD[2] * 2.0);
        // Text measures as the renderer lays it out.
        let (one, height) = text_block("- Aggravated burglary", 42.0, 400, 1.76);
        let (two, taller) = text_block(
            "- Aggravated burglary\n- Aggravated assault",
            42.0,
            400,
            1.76,
        );
        assert!(
            one > 300.0 && (one - two).abs() < 1e-6 && taller > height * 1.8,
            "{one} {two} {height} {taller}"
        );
    }

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

    #[test]
    fn a_window_frame_is_drawn_at_its_size() {
        let layout = Layout::new(960, 540);
        let png = window(Window::Notepad, "Notepad", &layout).unwrap();
        let decoder = png::Decoder::new(std::io::Cursor::new(png));
        let reader = decoder.read_info().unwrap();
        let info = reader.info();
        assert_eq!((info.width, info.height), (486, 329));
    }
}
