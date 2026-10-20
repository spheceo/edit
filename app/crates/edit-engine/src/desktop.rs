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
//! This is the drawing (and the layout and text measures it shares with
//! the profile); laying the profile out on the timeline is the server's.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use edit_render::text::{FontBook, GlyphCache, TextSpec};

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
pub const LINE_SIZE: f64 = 42.0;
pub const LINE_STEP: f64 = 74.0;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Window {
    PhotoViewer,
    Notepad,
    VideoPlayer,
}

/// The height of the Video Player's controls under its picture (1080p pixels).
pub const CONTROLS: f64 = 46.0;

impl Window {
    fn rect(self) -> [f64; 4] {
        match self {
            Window::PhotoViewer | Window::VideoPlayer => PHOTO_VIEWER,
            Window::Notepad => NOTEPAD,
        }
    }

    /// Its title, as the team names it on screen.
    pub fn title(self) -> &'static str {
        match self {
            Window::PhotoViewer => "Photo Viewer",
            Window::Notepad => "Notepad",
            Window::VideoPlayer => "Video Player",
        }
    }

    pub fn parse(kind: &str) -> Option<Self> {
        match kind {
            "photo_viewer" => Some(Window::PhotoViewer),
            "notepad" => Some(Window::Notepad),
            "video_player" => Some(Window::VideoPlayer),
            _ => None,
        }
    }

    fn menus(self) -> &'static [&'static str] {
        match self {
            Window::PhotoViewer => &["File", "Edit", "Image", "View", "Help"],
            Window::Notepad => &["File", "Edit", "Search", "View", "Help"],
            Window::VideoPlayer => &["File", "Edit", "Playback", "Audio", "Video", "View", "Help"],
        }
    }

    fn slug(self) -> &'static str {
        match self {
            Window::PhotoViewer => "photo-viewer",
            Window::Notepad => "notepad",
            Window::VideoPlayer => "video-player",
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
    pub fn centred(&self, x: f64, y: f64) -> (f64, f64) {
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
        let below = pixel[3];
        for (channel, new) in pixel.iter_mut().zip(color).take(3) {
            *channel = (new * a + *channel * below * (1.0 - a)) / out;
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
            for ((channel, base), tint) in pixel.iter_mut().zip(base).zip(tint) {
                let lit = base + tint * light * 0.6;
                // A soft shoulder so the brightest light rolls off to white.
                *channel = (1.0 - (-lit * 1.3).exp()) as f32;
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
    let [_, _, w, h] = layout.window(window);
    frame(window, title, w.round(), h.round(), layout.k)
}

/// A window's content area inside a `w` × `h` frame at scale `k` (frame
/// pixels from its top-left): under the title and menu bars, inset from the
/// sides and bottom, and over the Video Player's controls.
pub fn content_in(window: Window, w: f64, h: f64, k: f64) -> [f64; 4] {
    let top = (TITLE_BAR + MENU_BAR + 2.0) * k;
    let bottom = match window {
        Window::VideoPlayer => (CONTROLS + INSET) * k,
        _ => INSET * k,
    };
    [INSET * k, top, w - 2.0 * INSET * k, h - top - bottom]
}

/// A window's frame of any size `w` × `h` (pixels) at scale `k`.
pub fn frame(window: Window, title: &str, w: f64, h: f64, k: f64) -> Result<Vec<u8>, String> {
    let mut canvas = Canvas::new(w as usize, h as usize);
    let body = hex(0x302f2e);
    canvas.rect(0.0, 0.0, w, h, body);
    canvas.rect(0.0, 0.0, w, (TITLE_BAR + MENU_BAR) * k, hex(0x393837));
    // The content area.
    let [cx, cy, cw, ch] = content_in(window, w, h, k);
    match window {
        Window::PhotoViewer => canvas.rect(cx, cy, cx + cw, cy + ch, hex(0x2a2928)),
        Window::VideoPlayer => {
            canvas.rect(cx, cy, cx + cw, cy + ch, hex(0x000000));
            controls(&mut canvas, cx, cy + ch, cw, k);
        }
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
        Window::VideoPlayer => {
            // A play button in a frame.
            canvas.frame(ix, iy + icon * 0.12, ix + icon, iy + icon * 0.88, stroke, light);
            let (left, right) = (ix + icon * 0.38, ix + icon * 0.68);
            let (top, bottom) = (iy + icon * 0.32, iy + icon * 0.68);
            canvas.line((left, top), (right, iy + icon / 2.0), stroke, light);
            canvas.line((right, iy + icon / 2.0), (left, bottom), stroke, light);
            canvas.line((left, bottom), (left, top), stroke, light);
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


/// The Video Player's controls along the bottom of its picture: a progress
/// bar (green, part played) over a row of buttons and a volume slider.
fn controls(canvas: &mut Canvas, x: f64, y: f64, w: f64, k: f64) {
    let grey = hex(0x9a9a9a);
    let light = hex(0xd6d6d6);
    let green = hex(0x36c24a);
    // The progress bar.
    let bar = y + 9.0 * k;
    canvas.rect(x, bar, x + w, bar + 4.0 * k, hex(0x55524f));
    canvas.rect(x, bar, x + w * 0.42, bar + 4.0 * k, green);
    // Buttons: play, previous, stop, next.
    let middle = y + 30.0 * k;
    let size = 8.0 * k;
    let thin = 1.6 * k;
    let mut cx = x + 16.0 * k;
    canvas.line((cx, middle - size), (cx + size * 1.4, middle), thin, light);
    canvas.line((cx + size * 1.4, middle), (cx, middle + size), thin, light);
    canvas.line((cx, middle + size), (cx, middle - size), thin, light);
    cx += 34.0 * k;
    for _ in 0..3 {
        canvas.frame(cx, middle - size * 0.8, cx + size * 1.6, middle + size * 0.8, thin, grey);
        cx += 30.0 * k;
    }
    // The volume slider on the right.
    let (vx, vw) = (x + w - 110.0 * k, 80.0 * k);
    canvas.rect(vx, middle - 1.5 * k, vx + vw, middle + 1.5 * k, hex(0x55524f));
    canvas.rect(vx, middle - 1.5 * k, vx + vw * 0.6, middle + 1.5 * k, green);
    canvas.rect(vx + vw * 0.6 - 4.0 * k, middle - 5.0 * k, vx + vw * 0.6 + 4.0 * k, middle + 5.0 * k, light);
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
    crate::util::write_atomic(path, &make()?).map_err(|error| error.to_string())
}

/// A `kind` window's frame `w` × `h` pixels at scale `k` (its title the
/// team's name for it), drawn into `<home>/graphics/` if missing.
pub fn window_file(home: &Path, kind: &str, w: u32, h: u32, k: f64) -> Result<PathBuf, String> {
    let window = Window::parse(kind).ok_or_else(|| format!("no window {kind}: photo_viewer, notepad or video_player"))?;
    if w < 40 || h < 40 || w > 8000 || h > 8000 {
        return Err(format!("a window {w} × {h} is out of range"));
    }
    let path = home.join("graphics").join(format!(
        "desktop-window-{}-v{VERSION}-{w}x{h}-{:08x}.png",
        window.slug(),
        hash(&[&format!("{k:.4}")])
    ));
    ensure(&path, || frame(window, window.title(), f64::from(w), f64::from(h), k))?;
    Ok(path)
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

    #[test]
    fn a_window_frame_is_drawn_at_its_size() {
        let layout = Layout::new(960, 540);
        let png = window(Window::Notepad, "Notepad", &layout).unwrap();
        let decoder = png::Decoder::new(std::io::Cursor::new(png));
        let reader = decoder.read_info().unwrap();
        let info = reader.info();
        assert_eq!((info.width, info.height), (486, 329));
    }

    #[test]
    fn a_video_player_of_any_size_has_its_controls_under_the_picture() {
        let png = frame(Window::VideoPlayer, "Video Player", 800.0, 520.0, 1.0).unwrap();
        let decoder = png::Decoder::new(std::io::Cursor::new(png));
        let reader = decoder.read_info().unwrap();
        assert_eq!((reader.info().width, reader.info().height), (800, 520));
        let [_, y, _, h] = content_in(Window::VideoPlayer, 800.0, 520.0, 1.0);
        assert!((520.0 - (y + h) - (CONTROLS + INSET)).abs() < 1e-9);
        assert_eq!(Window::parse("video_player").map(Window::title), Some("Video Player"));
    }
}
