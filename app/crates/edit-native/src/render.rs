//! Frame renders and pictures (`edit_engine::render`): the same compositor
//! the browser preview runs, on its own GPU thread, the agent's renders
//! ahead of the UI's.

use std::path::Path;
use std::sync::{Arc, OnceLock};

use edit_core::Media;
use edit_engine::render::{self, FrameRenderer, RgbaImage};
use edit_engine::sheet;
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use parking_lot::Mutex;

/// Contact-sheet cells' longest side.
#[napi]
pub const SHEET_CELL: u32 = render::SHEET_CELL;

/// A contact sheet's model tokens at most unless asked otherwise.
#[napi]
pub const SHEET_BUDGET: u32 = sheet::BUDGET;

/// A sheet of `count` pictures' tokens (`sheet::budget_for`): `fine` for small text, plates and faces.
#[napi]
pub fn sheet_budget(count: u32, fine: bool) -> u32 {
    sheet::budget_for(count as usize, fine)
}

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
    /// Tile the frames into one sheet (left to right, then down), sized for
    /// the model's eyes (`edit_engine::sheet`).
    pub sheet: Option<SheetSpec>,
}

/// A contact sheet: each cell's label, and its time (seconds) when the
/// sheet is in time (a ruler then runs above each row); a budget in model
/// tokens (default `sheet::BUDGET`), or a fixed number across.
#[napi(object)]
pub struct SheetSpec {
    pub labels: Vec<String>,
    pub times: Option<Vec<f64>>,
    pub budget: Option<u32>,
    pub columns: Option<u32>,
}

fn sheet_plan(spec: &SheetSpec, count: usize, source: (u32, u32)) -> sheet::SheetPlan {
    sheet::plan(
        count,
        source,
        spec.budget
            .unwrap_or_else(|| sheet::budget_for(count, false)),
        spec.columns,
        spec.times.is_some(),
    )
}

fn compose(images: &[RgbaImage], spec: &SheetSpec, plan: &sheet::SheetPlan) -> RgbaImage {
    sheet::compose(images, &spec.labels, spec.times.as_deref(), plan)
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
        sheet,
    } = request;
    let project = crate::project::project_of(&project).map_err(crate::fail)?;
    let renderer = renderer().map_err(crate::fail)?;
    let project = (*project).clone();
    let plan = sheet.as_ref().map(|spec| {
        sheet_plan(
            spec,
            frames.len(),
            (project.settings.width, project.settings.height),
        )
    });
    // A sheet's frames are rendered at its cells' size.
    let max_side = plan.map_or(max_side, |plan| plan.cell_width.max(plan.cell_height));
    let images = match priority.as_str() {
        "agent" => renderer.render_for_agent(project, frames, max_side).await,
        "ui" => renderer.render(project, frames, max_side).await,
        other => Err(format!("unknown priority {other} (ui or agent)")),
    }
    .map_err(crate::fail)?;
    crate::blocking("encoding frames", move || match (sheet, plan) {
        (Some(spec), Some(plan)) => Ok(vec![encode(&compose(&images, &spec, &plan), &how)?]),
        _ => images.iter().map(|image| encode(image, &how)).collect(),
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
    /// These times (seconds of the file) instead of `count` evenly spaced ones.
    pub times: Option<Vec<f64>>,
    /// Model tokens for the sheet (default `sheet::BUDGET`).
    pub budget: Option<u32>,
    /// A fixed number across (else the grid drawing frames largest).
    pub columns: Option<u32>,
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
        let count = request
            .times
            .as_ref()
            .map_or(request.count.max(1) as usize, |times| times.len().max(1));
        let mut spec = SheetSpec {
            labels: (1..=count).map(|n| n.to_string()).collect(),
            times: Some(Vec::new()),
            budget: request.budget,
            columns: request.columns,
        };
        let plan = sheet_plan(&spec, count, (media.width.max(2), media.height.max(2)));
        let side = plan.cell_width.max(plan.cell_height);
        let (images, times) = match &request.times {
            // Picked times (frame_picks.ts): each decoded where it is.
            Some(given) if !given.is_empty() => {
                let mut images = Vec::with_capacity(given.len());
                for time in given {
                    let (mut one, _) =
                        render::media_frames(&media, cache.as_deref(), *time, *time, 1, side)?;
                    images.append(&mut one);
                }
                (images, given.clone())
            }
            _ => render::media_frames(
                &media,
                cache.as_deref(),
                request.start,
                request.end,
                count,
                side,
            )?,
        };
        spec.times = Some(times.clone());
        Ok(MediaFrames {
            image: encode(&compose(&images, &spec, &plan), &request.encode)?,
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

/// Tiles pictures into a labelled sheet (`SheetSpec`) and encodes it.
#[napi]
pub async fn compose_sheet(
    images: Vec<RawImage>,
    spec: SheetSpec,
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
        let shape = images.iter().fold((1, 1), |(w, h), image| {
            (w.max(image.width), h.max(image.height))
        });
        let plan = sheet_plan(&spec, images.len(), shape);
        encode(&compose(&images, &spec, &plan), &encoding)
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
