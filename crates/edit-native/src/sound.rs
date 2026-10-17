//! Sound measurement (`edit_engine::loudness`): one decode per file makes its
//! analysis (10 ms blocks of K-weighted energy and peak, cached on disk and in
//! memory); every measurement after that is arithmetic over it.

use std::path::{Path, PathBuf};

use napi_derive::napi;

#[napi(object)]
pub struct Stretch {
    /// Seconds into the sound.
    pub from: f64,
    pub seconds: f64,
}

/// How loud a stretch is, as FFmpeg's `ebur128` measures it padded with
/// 0.5 s of silence.
#[napi(object)]
pub struct Loudness {
    /// Integrated loudness (LUFS; -Infinity when silent).
    pub integrated: f64,
    /// The loudest momentary loudness (LUFS).
    pub loudest: f64,
    /// Sample peak (dBFS).
    pub peak: f64,
}

/// The loudness of each stretch of the sound at `path` (the first call on a
/// file decodes it; later ones take microseconds).
#[napi]
pub async fn loudness_spans(path: String, spans: Vec<Stretch>) -> napi::Result<Vec<Loudness>> {
    crate::blocking("measuring loudness", move || {
        let blocks = edit_engine::loudness::blocks(Path::new(&path))?;
        Ok(spans
            .iter()
            .map(|stretch| {
                let span = blocks.span(stretch.from, stretch.seconds);
                Loudness {
                    integrated: span.integrated,
                    loudest: span.loudest,
                    peak: span.peak,
                }
            })
            .collect())
    })
    .await
}

/// Seconds into the sound at `path` of its loudest moment.
#[napi]
pub async fn loudest_moment(path: String) -> napi::Result<f64> {
    crate::blocking("finding the loudest moment", move || {
        Ok(edit_engine::loudness::blocks(Path::new(&path))?.loudest_moment())
    })
    .await
}

/// Analyses several files, three at a time (a failure shows again, with its
/// reason, where it's measured).
#[napi]
pub async fn loudness_prepare(paths: Vec<String>) -> napi::Result<()> {
    crate::blocking("analysing sound", move || {
        let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        edit_engine::loudness::prepare(&paths);
        Ok(())
    })
    .await
}

/// Analyses a sound in the background (one at a time), so its first
/// measurement is instant: for media just imported.
#[napi]
pub fn loudness_warm(path: String) {
    napi::bindgen_prelude::within_runtime_if_available(|| {
        edit_engine::loudness::warm(PathBuf::from(path));
    });
}
