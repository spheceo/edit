//! Edit's native addon: `edit-engine` and `edit-core` for the TypeScript
//! server, through napi-rs. Bindings only:
//! every function here converts its arguments, calls the engine, and turns a
//! `Result<T, String>` into a value or an `Error` with the same message (the
//! agent reads these strings).
//!
//! How each call runs: sync calls take microseconds to a few
//! milliseconds; async ones run on napi's tokio runtime in `spawn_blocking`;
//! long jobs report through an unref'd `ThreadsafeFunction`. Every entry
//! point contains panics (`edit_engine::util::catch`): a crash becomes
//! "<what> crashed (…); this is a bug in Edit", never a dead server.

// napi-derive registers the bindings only outside `cargo test`, so a test
// build sees them as unused; the bun tests (`test/`) exercise them.
#![cfg_attr(test, allow(dead_code))]

mod analysis;
mod export;
mod lifecycle;
mod media;
mod project;
mod render;
mod sound;

/// An `Error` whose message is exactly `message`.
pub(crate) fn fail(message: impl Into<String>) -> napi::Error {
    napi::Error::from_reason(message.into())
}

/// Runs quick work on the calling (JS) thread, a panic contained.
pub(crate) fn sync<T>(what: &str, work: impl FnOnce() -> Result<T, String>) -> napi::Result<T> {
    edit_engine::util::catch(what, work)
        .and_then(|result| result)
        .map_err(fail)
}

/// Runs blocking work on the runtime's blocking pool, a panic contained.
pub(crate) async fn blocking<T: Send + 'static>(
    what: &'static str,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> napi::Result<T> {
    tokio::task::spawn_blocking(move || {
        edit_engine::util::catch(what, work).and_then(|result| result)
    })
    .await
    .map_err(|error| fail(format!("{what} crashed ({error}); this is a bug in Edit")))?
    .map_err(fail)
}

/// A progress callback: called with 0–1 as work goes, never keeping the
/// process alive (weak), never blocking the native side (non-blocking calls).
pub(crate) type Progress =
    napi::threadsafe_function::ThreadsafeFunction<f64, (), f64, napi::Status, false, true>;

pub(crate) fn report(progress: &Progress, value: f64) {
    progress.call(
        value,
        napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
    );
}

/// The media cache `init` gave.
pub(crate) fn cache_dir() -> Result<std::path::PathBuf, String> {
    edit_engine::util::cache_dir()
        .map(std::path::Path::to_path_buf)
        .ok_or_else(|| "the native engine isn't initialised (call init first)".to_owned())
}
