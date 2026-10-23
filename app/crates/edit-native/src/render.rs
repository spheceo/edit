//! Frame renders and pictures (`edit_engine::render`): the same compositor
//! the browser preview runs, on its own GPU thread, the agent's renders
//! ahead of the UI's.

use std::path::Path;
use std::sync::{Arc, OnceLock};

use edit_core::Media;
use edit_engine::render::{self, FrameRenderer, RgbaImage};
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use parking_lot::Mutex;

/// Contact-sheet cells' longest side.
#[napi]
pub const SHEET_CELL: u32 = render::SHEET_CELL;

static RENDERER: OnceLock<Mutex<Option<Arc<FrameRenderer>>>> = OnceLock::new();

fn renderer() -> Result<Arc<FrameRenderer>, String> {
    let slot = RENDERER.get_or_init(|| Mutex::new(None));
    let mut slot = slot.lock();
    if let Some(renderer) = slot.as_ref() {
        return Ok(Arc::clone(renderer));
    }
    let renderer = FrameRenderer::start(crate::cache_dir()?);
    *slot = Some(Arc::clone(&renderer));
    Ok(renderer)
}

/// Stops the renderer's thread (`shutdown`); the next render starts another.
pub(crate) fn stop() {
    if let Some(slot) = RENDERER.get() {
        if let Some(renderer) = slot.lock().take() {
            renderer.stop();
        }
    }
}

/// An encoded picture.
#[napi(object)]
pub struct EncodedImage {
    pub data: Buffer,
    #[napi(ts_type = "\"image/png\" | \"image/jpeg\"")]
    pub mime: String,
    pub width: u32,
    pub height: u32,
}

/// Raw RGBA pixels, `width` × `height` × 4 bytes.
#[napi(object)]
pub struct RawImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Buffer,
}

/// "png" (the UI's frames) or "agent" (JPEG where ImageIO is, else PNG).
fn encode(image: &RgbaImage, how: &str) -> Result<EncodedImage, String> {
    let (bytes, mime) = match how {
        "png" => (render::encode_png(image)?, "image/png"),
        "agent" => render::encode_for_agent(image)?,
        other => return Err(format!("unknown encoding {other} (png or agent)")),
    };
    Ok(EncodedImage {
        data: bytes.into(),
        mime: mime.to_owned(),
        width: image.width,
        height: image.height,
    })
}

#[napi(object)]
pub struct RenderRequest {
    #[napi(ts_type = "ProjectInput")]
    pub project: crate::project::ProjectInput,
    pub frames: Vec<i64>,
    /// Longest side of each picture; 0 = the project's size.
    pub max_side: u32,
    /// "agent" goes ahead of "ui".
    #[napi(ts_type = "\"ui\" | \"agent\"")]
    pub priority: String,
    #[napi(ts_type = "\"png\" | \"agent\"")]
    pub encode: String,
    /// Tile the frames into one sheet this many across (left to right, then down).
    pub sheet_columns: Option<u32>,
}

/// Renders frames of a project: one picture per frame, or one sheet of
/// them. "renderer busy; try again shortly" when too many are waiting
/// (agent 16, UI 8).
#[napi]
pub async fn render_frames(request: RenderRequest) -> napi::Result<Vec<EncodedImage>> {
    let RenderRequest {
        project,
        frames,
        max_side,
        priority,
        encode: how,
        sheet_columns,
    } = request;
    let project = crate::project::project_of(&project).map_err(crate::fail)?;
    let renderer = renderer().map_err(crate::fail)?;
    let project = (*project).clone();
    let images = match priority.as_str() {
        "agent" => renderer.render_for_agent(project, frames, max_side).await,
        "ui" => renderer.render(project, frames, max_side).await,
        other => Err(format!("unknown priority {other} (ui or agent)")),
    }
    .map_err(crate::fail)?;
    crate::blocking("encoding frames", move || match sheet_columns {
        Some(columns) => Ok(vec![encode(&render::tile(&images, columns), &how)?]),
        None => images.iter().map(|image| encode(image, &how)).collect(),
    })
    .await
}

#[napi(object)]
pub struct MediaFramesRequest {
    #[napi(ts_type = "Media")]
    pub media: serde_json::Value,
    /// Seconds of the file.
    pub start: f64,
    pub end: f64,
    pub count: u32,
    pub max_side: u32,
    pub sheet_columns: u32,
    #[napi(ts_type = "\"png\" | \"agent\"")]
    pub encode: String,
}

#[napi(object)]
pub struct MediaFrames {
    pub image: EncodedImage,
    /// Where each frame is (seconds of the file).
    pub times: Vec<f64>,
}

/// Evenly spaced frames of a media file between `start` and `end`, decoded
/// side by side (from the light preview when it's made), as one sheet.
#[napi]
pub async fn media_frames(request: MediaFramesRequest) -> napi::Result<MediaFrames> {
    crate::blocking("looking at media", move || {
        let media: Media =
            serde_json::from_value(request.media).map_err(|error| format!("media: {error}"))?;
        let cache = crate::cache_dir().ok();
        let (images, times) = render::media_frames(
            &media,
            cache.as_deref(),
            request.start,
            request.end,
            request.count as usize,
            request.max_side,
        )?;
        Ok(MediaFrames {
            image: encode(
                &render::tile(&images, request.sheet_columns),
                &request.encode,
            )?,
            times,
        })
    })
    .await
}

/// Saves the frame of `media` at `time` (seconds) as a PNG at `out`.
#[napi(ts_args_type = "media: Media, time: number, out: string")]
pub async fn save_still(media: serde_json::Value, time: f64, out: String) -> napi::Result<()> {
    crate::blocking("saving a still", move || {
        let media: Media =
            serde_json::from_value(media).map_err(|error| format!("media: {error}"))?;
        render::save_still(&media, time, Path::new(&out))
    })
    .await
}

/// Tiles pictures into a sheet `columns` across and encodes it.
#[napi]
pub async fn compose_sheet(
    images: Vec<RawImage>,
    columns: u32,
    #[napi(ts_arg_type = "\"png\" | \"agent\"")] encoding: String,
) -> napi::Result<EncodedImage> {
    let images: Vec<RgbaImage> = images
        .into_iter()
        .map(|image| RgbaImage {
            width: image.width,
            height: image.height,
            pixels: image.pixels.to_vec(),
        })
        .collect();
    crate::blocking("composing a sheet", move || {
        for image in &images {
            if image.pixels.len() != image.width as usize * image.height as usize * 4 {
                return Err(format!(
                    "a {}×{} picture needs {} bytes of RGBA, not {}",
                    image.width,
                    image.height,
                    image.width as usize * image.height as usize * 4,
                    image.pixels.len()
                ));
            }
        }
        encode(&render::tile(&images, columns), &encoding)
    })
    .await
}

/// A font bundled with the renderer ("Geist-Regular.ttf", …), for `/fonts/:file`.
#[napi]
pub fn bundled_font(file: String) -> Option<Buffer> {
    edit_render::text::bundled_font_bytes(&file).map(|bytes| bytes.to_vec().into())
}

/// The lines `text` takes in a text style (`font`, `weight`, `size`, `tracking`,
/// wrapped at `maxWidth`; project pixels), exactly as the renderer wraps it:
/// what the subtitles' one-line rule (apps/server/src/one_line.ts) measures.
#[napi]
pub fn text_lines(
    text: String,
    font: String,
    weight: u32,
    size: f64,
    tracking: f64,
    max_width: Option<f64>,
) -> Vec<String> {
    static BOOK: std::sync::OnceLock<edit_render::text::FontBook> = std::sync::OnceLock::new();
    let book = BOOK.get_or_init(|| {
        let mut book = edit_render::text::FontBook::default();
        for (family, weight, file) in edit_render::text::BUNDLED_FONTS {
            if let Some(bytes) = edit_render::text::bundled_font_bytes(file) {
                let _ = book.add(family, *weight, bytes);
            }
        }
        book
    });
    let weight = u16::try_from(weight).unwrap_or(u16::MAX);
    edit_render::text::wrap_lines(
        book,
        &font,
        weight,
        size as f32,
        tracking as f32,
        max_width.map(|width| width as f32),
        &text,
    )
    .unwrap_or_else(|| vec![text])
}
