//! Rendering is `edit_engine::render`'s (re-exported here); this is the
//! server's export registry: one export at a time, its `export` events, the
//! files it may hand out, and the Drive upload after a subtitled video.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use edit_core::Project;
use serde_json::json;

pub use edit_engine::render::*;

use crate::export::ExportOptions;
use crate::store::Store;

#[derive(Default)]
pub struct Exports {
    jobs: Mutex<HashMap<String, ExportJob>>,
    /// Files exported since the server started, newest last: the only ones it hands out or reveals.
    finished: Mutex<Vec<PathBuf>>,
}

struct ExportJob {
    cancel: Arc<AtomicBool>,
    output: PathBuf,
}

impl Exports {
    /// Whether `path` is a file this server exported (and so may be downloaded or revealed).
    pub fn exported(&self, path: &Path) -> bool {
        self.finished.lock().iter().any(|done| done == path)
    }

    pub fn running(&self) -> bool {
        !self.jobs.lock().is_empty()
    }

    pub fn cancel(&self, project: &str) -> bool {
        self.jobs
            .lock()
            .get(project)
            .map(|job| job.cancel.store(true, Ordering::Release))
            .is_some()
    }

    /// Starts exporting `project` as `options` ask; returns the file it will write
    /// (`output` with the format's extension). A whole subtitled video is then
    /// uploaded to the team's Drive (`crate::drive`).
    pub fn start(
        self: &Arc<Self>,
        store: Arc<Store>,
        library: Arc<crate::library::Library>,
        project: Project,
        options: ExportOptions,
        output: PathBuf,
    ) -> Result<PathBuf, String> {
        let plan = export_plan(&project, &options)?;
        let output = crate::export::with_extension(&output, options.format);
        // Never into an unplugged media drive's folder (or the empty mount
        // point it leaves behind).
        store.layout().writable(&output)?;
        let parent = output
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let output = parent
            .canonicalize()
            .map_err(|error| error.to_string())?
            .join(output.file_name().ok_or("export needs a file name")?);
        if let Ok(existing) = output.canonicalize() {
            if project.media.iter().any(|media| {
                Path::new(&media.path)
                    .canonicalize()
                    .is_ok_and(|path| path == existing)
            }) {
                return Err("export would overwrite source footage; choose another file".to_owned());
            }
        }
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut jobs = self.jobs.lock();
            if !jobs.is_empty() {
                return Err("an export is already running; wait for it or cancel it before starting another".to_owned());
            }
            if jobs.values().any(|job| job.output == output) {
                return Err("another export is writing to that file".to_owned());
            }
            jobs.insert(
                project.id.clone(),
                ExportJob {
                    cancel: Arc::clone(&cancel),
                    output: output.clone(),
                },
            );
        }
        let final_path = output.clone();
        let cache = store.cache_dir();
        let upload = crate::drive::wanted(&project, &options, &plan);
        let this = Arc::clone(self);
        std::thread::spawn(move || {
            let id = project.id.clone();
            let emit = |state: &str, progress: f32, extra: serde_json::Value| {
                let mut event = json!({
                    "type": "export",
                    "id": id,
                    "state": state,
                    "progress": progress,
                    "path": output.to_string_lossy(),
                });
                if let (Some(event), Some(extra)) = (event.as_object_mut(), extra.as_object()) {
                    event.extend(extra.clone());
                }
                store.emit(event);
            };
            emit("running", 0.0, json!({}));
            let started = Instant::now();
            let result = crate::guard::catch("the export", || {
                // Everything is written beside the destination; only a complete
                // export replaces it. Failure/cancellation cannot destroy an older file.
                let path = partial_path(&output, &id, options.format);
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                    .map_err(|error| error.to_string())?;
                let temporary = ExportFile(path);
                // Cloud footage: the originals, not the proxies (downloaded
                // for the export and removed after it, or read from R2).
                let (project, _originals) =
                    crate::cloud_media::for_export(&project, plan.start, plan.end, &cache)?;
                let pending = crate::broll::smoothing_pending(&project.id);
                if !pending.is_empty() {
                    crate::diag::info("export", format!("exporting current timeline snapshot; {} optional optical-flow renders still pending", pending.len()));
                }
                export(
                    &project,
                    &options,
                    &plan,
                    &temporary.0,
                    &cache,
                    &cancel,
                    |progress| emit("running", progress, json!({})),
                )?;
                if cancel.load(Ordering::Acquire) {
                    return Err("cancelled".to_owned());
                }
                std::fs::rename(&temporary.0, &output).map_err(|error| error.to_string())?;
                let mut finished = this.finished.lock();
                finished.retain(|done| done != &output);
                finished.push(output.clone());
                let excess = finished.len().saturating_sub(50);
                finished.drain(..excess);
                Ok(())
            })
            .and_then(|result| result);
            let frames = (plan.end - plan.start).max(0);
            let took = started.elapsed();
            match &result {
                Ok(()) => crate::diag::info(
                    "export",
                    format!(
                        "{} exported {frames} frames in {} ({:.1} frames/s) to {}",
                        project.name,
                        crate::diag::human(took),
                        frames as f64 / took.as_secs_f64().max(1e-3),
                        output.display()
                    ),
                ),
                Err(_) if cancel.load(Ordering::Acquire) => {
                    crate::diag::info("export", format!("{} export cancelled", project.name));
                }
                Err(error) => crate::diag::record(
                    "export",
                    "export",
                    took,
                    Some(&format!("{}: {error}", project.name)),
                ),
            }
            if result.is_ok() {
                crate::diag::record("export", "export", took, None);
            }
            let done = result.is_ok();
            match result {
                Ok(()) => emit(
                    "done",
                    1.0,
                    json!({
                        "seconds": started.elapsed().as_secs_f32(),
                        "bytes": std::fs::metadata(&output).map(|meta| meta.len()).ok(),
                        "drive": upload,
                    }),
                ),
                Err(error) if cancel.load(Ordering::Acquire) => {
                    emit("cancelled", 0.0, json!({ "error": error }));
                }
                Err(error) => emit("failed", 0.0, json!({ "error": error })),
            }
            this.jobs.lock().remove(&id);
            if upload && done {
                crate::drive::start(store, library, &project, output);
            }
        });
        Ok(final_path)
    }
}
