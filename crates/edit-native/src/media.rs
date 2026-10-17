//! Cache keys, probing and preview making (`edit_engine::media`).

use std::path::{Path, PathBuf};

use edit_engine::media::{self, CachePaths as Paths, Probe};
use napi_derive::napi;

/// A media file's cache key: a hash of its name (a file on the media drive
/// named by its place in the data folder), size and modification time. The
/// only implementation: TS never hashes these itself.
#[napi]
pub fn media_key(path: String) -> String {
    media::media_key(Path::new(&path))
}

/// The key of `file` (its size and modification time) under `name`.
#[napi]
pub fn key_of(name: String, file: String) -> String {
    media::key_of(Path::new(&name), Path::new(&file))
}

/// A media file's cache folder, once `init` has given the cache.
#[napi]
pub fn media_cache(path: String) -> Option<String> {
    edit_engine::util::media_cache(Path::new(&path)).map(|dir| dir.to_string_lossy().into_owned())
}

/// The light preview of `source` in the media cache, if it's been made.
#[napi]
pub fn light_preview(source: String) -> Option<String> {
    let cache = crate::cache_dir().ok()?;
    media::light_preview(&cache, Path::new(&source)).map(|path| path.to_string_lossy().into_owned())
}

/// Where a media file's preview files go (the server's `Processor::paths`).
#[napi(object)]
pub struct CachePaths {
    /// Preview picture (video sources only, no sound).
    pub proxy: String,
    /// Preview sound (sources with audio).
    pub audio: String,
    /// Written once both preview files are complete.
    pub proxy_done: String,
    pub thumbs: String,
    pub thumbs_meta: String,
    pub peaks: String,
    pub transcript: String,
    /// The light preview picture, made from the preview once it's done.
    pub light: String,
}

fn paths(paths: CachePaths) -> Paths {
    Paths {
        proxy: paths.proxy.into(),
        audio: paths.audio.into(),
        proxy_done: paths.proxy_done.into(),
        thumbs: paths.thumbs.into(),
        thumbs_meta: paths.thumbs_meta.into(),
        peaks: paths.peaks.into(),
        transcript: paths.transcript.into(),
        light: paths.light.into(),
    }
}

fn probe_of(value: serde_json::Value) -> Result<Probe, String> {
    serde_json::from_value(value).map_err(|error| format!("probe: {error}"))
}

/// What a media file is: kind, duration, size, frame rate, sound (ImageIO
/// for images on the Mac, ffprobe otherwise).
#[napi(ts_return_type = "Promise<Probe>")]
pub async fn probe(path: String) -> napi::Result<serde_json::Value> {
    crate::blocking("probing", move || {
        let probe = media::probe(Path::new(&path))?;
        serde_json::to_value(probe).map_err(|error| error.to_string())
    })
    .await
}

/// An image's pixel size (ImageIO; macOS only).
#[napi(ts_return_type = "Promise<[number, number]>")]
pub async fn image_size(path: String) -> napi::Result<Vec<u32>> {
    crate::blocking("reading an image's size", move || {
        #[cfg(target_os = "macos")]
        {
            let (width, height) = edit_engine::mac_media::image_size(Path::new(&path))?;
            Ok(vec![width, height])
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(format!("can't read {path}'s size here: images need macOS"))
        }
    })
    .await
}

#[napi(object)]
pub struct PreviewJob {
    pub source: String,
    #[napi(ts_type = "Probe")]
    pub probe: serde_json::Value,
    pub paths: CachePaths,
    /// The source is this machine's copy of a cloud proxy, which already is
    /// a preview: linked, not encoded again (`cloud_media::is_local_copy`).
    pub from_cloud_proxy: bool,
}

/// Makes `source`'s preview (picture and sound), reporting 0–1.
#[napi(ts_args_type = "job: PreviewJob, onProgress: (progress: number) => void")]
pub async fn make_preview(job: PreviewJob, on_progress: crate::Progress) -> napi::Result<()> {
    crate::blocking("making a preview", move || {
        let probe = probe_of(job.probe)?;
        let source = PathBuf::from(&job.source);
        let paths = paths(job.paths);
        if job.from_cloud_proxy && probe.kind == edit_core::MediaKind::Video {
            return media::preview_from_cloud_proxy(&source, &probe, &paths);
        }
        media::make_proxy(&source, &probe, &paths, |progress| {
            crate::report(&on_progress, f64::from(progress));
        })
    })
    .await
}

/// The 720p light preview, from the preview (or the source).
#[napi(ts_args_type = "source: string, paths: CachePaths, probe: Probe")]
pub async fn make_light_preview(
    source: String,
    paths: CachePaths,
    probe: serde_json::Value,
) -> napi::Result<()> {
    crate::blocking("making a light preview", move || {
        let probe = probe_of(probe)?;
        media::make_light(Path::new(&source), &self::paths(paths), &probe)
    })
    .await
}

/// A still image's thumbnail (ImageIO on the Mac); resolves to the count (1).
#[napi]
pub async fn make_image_thumbs(source: String, paths: CachePaths) -> napi::Result<u32> {
    crate::blocking("making a thumbnail", move || {
        media::make_image_thumbs(Path::new(&source), &self::paths(paths))
    })
    .await
}

/// The waveform: one byte per 1/100 s, the peak scaled to 0..255.
#[napi]
pub async fn make_peaks(source: String, out: String) -> napi::Result<()> {
    crate::blocking("making a waveform", move || {
        media::make_peaks(Path::new(&source), Path::new(&out))
    })
    .await
}

/// The proxy every machine edits a cloud media with, at `out`. `source` may
/// be a presigned URL: the error isn't scrubbed of it (the caller does that).
#[napi(ts_args_type = "source: string, probe: Probe, out: string")]
pub async fn make_cloud_proxy(
    source: String,
    probe: serde_json::Value,
    out: String,
) -> napi::Result<()> {
    crate::blocking("making a cloud proxy", move || {
        let probe = probe_of(probe)?;
        media::make_cloud_proxy(Path::new(&source), &probe, Path::new(&out))
    })
    .await
}

/// The cloud proxy's bitrate (bits/s) for a `width` × `height` picture.
#[napi]
pub fn cloud_proxy_bitrate(width: u32, height: u32) -> f64 {
    media::cloud_proxy_bitrate(width, height) as f64
}
