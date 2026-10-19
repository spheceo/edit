//! Exports (`edit_engine::render::export_file`, `edit_engine::export`): the
//! sound mixed first, then the picture pipeline, joined by FFmpeg, written
//! beside the destination and renamed onto it once complete. Which exports
//! run, their events and the Drive upload are the server's.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Instant;

use edit_core::Project;
use edit_engine::export::{ExportOptions, Format, Plan};
use napi_derive::napi;
use parking_lot::Mutex;
use tokio::sync::oneshot;

fn options_of(value: serde_json::Value) -> Result<ExportOptions, String> {
    serde_json::from_value(value).map_err(|error| format!("export options: {error}"))
}

fn json<T: serde::Serialize>(value: &T) -> Result<serde_json::Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

/// The export dialog's defaults (hardware encoding on the Mac).
#[napi(ts_return_type = "ExportOptions")]
pub fn export_defaults() -> napi::Result<serde_json::Value> {
    crate::sync("export defaults", || json(&ExportOptions::default()))
}

#[napi(object)]
pub struct ExportPlan {
    #[napi(ts_type = "Plan")]
    pub plan: serde_json::Value,
    pub fps: f64,
}

/// What exporting `project` as `options` ask will cover, or why it can't:
/// an empty timeline, an invalid project, no sound for a sound-only format,
/// settings that can't work.
#[napi]
pub fn export_plan(
    #[napi(ts_arg_type = "ProjectInput")] project: crate::project::ProjectInput,
    #[napi(ts_arg_type = "ExportOptions")] options: serde_json::Value,
) -> napi::Result<ExportPlan> {
    crate::sync("planning an export", || {
        let project = crate::project::project_of(&project)?;
        let options = options_of(options)?;
        let plan = edit_engine::render::export_plan(&project, &options)?;
        Ok(ExportPlan {
            plan: json(&plan)?,
            fps: project.fps(),
        })
    })
}

/// `path` ending in the format's extension.
#[napi]
pub fn with_extension(
    path: String,
    #[napi(ts_arg_type = "Format")] format: serde_json::Value,
) -> napi::Result<String> {
    crate::sync("naming an export", || {
        let format: Format =
            serde_json::from_value(format).map_err(|error| format!("format: {error}"))?;
        Ok(edit_engine::export::with_extension(path.as_ref(), format)
            .to_string_lossy()
            .into_owned())
    })
}

/// The encoders this FFmpeg has that the export dialog's choices depend on.
#[napi(ts_return_type = "Promise<Encoders>")]
pub async fn encoders() -> napi::Result<serde_json::Value> {
    crate::blocking(
        "listing encoders",
        || json(&edit_engine::export::encoders()),
    )
    .await
}

/// Every export running, so `shutdown` can cancel them.
static RUNNING: Mutex<Vec<Weak<AtomicBool>>> = Mutex::new(Vec::new());

pub(crate) fn cancel_all() {
    for cancel in RUNNING.lock().drain(..) {
        if let Some(cancel) = cancel.upgrade() {
            cancel.store(true, Ordering::Release);
        }
    }
}

#[napi(object)]
pub struct ExportProject {
    /// The project as it's exported (cloud media pointing at originals).
    pub json: String,
}

#[napi(object)]
pub struct ExportStart {
    pub project: ExportProject,
    #[napi(ts_type = "ExportOptions")]
    pub options: serde_json::Value,
    /// From `exportPlan`.
    #[napi(ts_type = "Plan")]
    pub plan: serde_json::Value,
    /// The finished file (with the format's extension, in a folder that exists).
    pub output: String,
    pub cache_dir: String,
    /// Media id → a local copy of its sound to mix instead of its file (a cloud original's).
    pub sounds: Option<std::collections::HashMap<String, String>>,
}

#[napi(object)]
pub struct ExportDone {
    pub seconds: f64,
    pub bytes: f64,
}

type Outcome = Result<ExportDone, String>;

/// One export, running on its own thread.
#[napi]
pub struct ExportJob {
    cancel: Arc<AtomicBool>,
    done: tokio::sync::Mutex<Option<oneshot::Receiver<Outcome>>>,
}

#[napi]
impl ExportJob {
    /// Starts exporting; progress (0–1) comes to `onProgress`.
    #[napi(
        factory,
        ts_args_type = "job: ExportStart, onProgress: (progress: number) => void"
    )]
    pub fn start(job: ExportStart, on_progress: crate::Progress) -> napi::Result<ExportJob> {
        let (project, options, plan) = crate::sync("starting an export", || {
            let project: Project = crate::project::parse(&job.project.json)?;
            let options = options_of(job.options)?;
            let plan: Plan =
                serde_json::from_value(job.plan).map_err(|error| format!("plan: {error}"))?;
            Ok((project, options, plan))
        })?;
        let output = PathBuf::from(job.output);
        let cache = PathBuf::from(job.cache_dir);
        let sounds: std::collections::HashMap<String, PathBuf> = job
            .sounds
            .unwrap_or_default()
            .into_iter()
            .map(|(media, path)| (media, PathBuf::from(path)))
            .collect();
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut running = RUNNING.lock();
            running.retain(|other| other.strong_count() > 0);
            running.push(Arc::downgrade(&cancel));
        }
        let (send, done) = oneshot::channel();
        let stop = Arc::clone(&cancel);
        std::thread::spawn(move || {
            let started = Instant::now();
            let result = edit_engine::util::catch("the export", || {
                edit_engine::render::export_file(
                    &project,
                    &options,
                    &plan,
                    &output,
                    &cache,
                    &sounds,
                    &stop,
                    |progress| crate::report(&on_progress, f64::from(progress)),
                )
            })
            .and_then(|result| result)
            .map(|()| ExportDone {
                seconds: started.elapsed().as_secs_f64(),
                bytes: std::fs::metadata(&output).map_or(0.0, |meta| meta.len() as f64),
            });
            let result = match result {
                Err(_) if stop.load(Ordering::Acquire) => Err("cancelled".to_owned()),
                other => other,
            };
            let _ = send.send(result);
        });
        Ok(ExportJob {
            cancel,
            done: tokio::sync::Mutex::new(Some(done)),
        })
    }

    /// Asks the export to stop; `wait` then rejects with "cancelled".
    #[napi]
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Release);
    }

    /// How long it took and how big the file is; rejects with why it failed
    /// ("cancelled" when cancelled).
    #[napi]
    pub async fn wait(&self) -> napi::Result<ExportDone> {
        let done = self.done.lock().await.take();
        let Some(done) = done else {
            return Err(crate::fail("this export was already waited for"));
        };
        match done.await {
            Ok(result) => result.map_err(crate::fail),
            Err(_) => Err(crate::fail(
                "the export stopped without saying why; this is a bug in Edit",
            )),
        }
    }
}
