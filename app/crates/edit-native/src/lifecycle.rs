//! Lifecycle and process: `init`, the media folders, `shutdown`, the data
//! folder's lock, and exec-in-place for updates.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use edit_engine::log::{Level, Sink};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use parking_lot::Mutex;

/// A line of the engine's log, or a timing (`timing: true`).
#[napi(object)]
#[derive(Clone)]
pub struct NativeLog {
    /// Absent on timings.
    #[napi(ts_type = "\"info\" | \"warn\" | \"error\"")]
    pub level: Option<String>,
    /// What it's about: "media", "render", "export", …
    pub area: String,
    pub message: Option<String>,
    pub timing: Option<bool>,
    /// The operation timed ("render: frame", "media: waveform", …).
    pub name: Option<String>,
    pub ms: Option<f64>,
    /// Why it failed, when it did.
    pub failure: Option<String>,
}

type LogFn = ThreadsafeFunction<NativeLog, (), NativeLog, napi::Status, false, true>;

struct ToJs(LogFn);

impl Sink for ToJs {
    fn log(&self, level: Level, area: &str, message: String) {
        self.0.call(
            NativeLog {
                level: Some(level.name().to_owned()),
                area: area.to_owned(),
                message: Some(message),
                timing: None,
                name: None,
                ms: None,
                failure: None,
            },
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    }

    fn record(&self, area: &str, name: &str, took: Duration, failure: Option<&str>) {
        self.0.call(
            NativeLog {
                level: None,
                area: area.to_owned(),
                message: None,
                timing: Some(true),
                name: Some(name.to_owned()),
                ms: Some(took.as_secs_f64() * 1000.0),
                failure: failure.map(str::to_owned),
            },
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    }
}

#[napi(object, object_to_js = false)]
pub struct InitOptions {
    /// The data folder (`~/.edit`).
    pub home: String,
    /// The media cache (`<home>/cache`).
    pub cache_dir: String,
    pub ffmpeg: String,
    pub ffprobe: String,
    /// Every media folder ever set (`media_drive` `Layout.known`): files there
    /// keep the cache keys of their place in the data folder.
    pub media_folders: Vec<String>,
    #[napi(ts_type = "(line: NativeLog) => void")]
    pub log: LogFn,
}

static HOME: OnceLock<PathBuf> = OnceLock::new();

/// The data folder `init` gave.
pub(crate) fn home() -> Result<PathBuf, String> {
    HOME.get()
        .cloned()
        .ok_or_else(|| "the native engine isn't initialised (call init first)".to_owned())
}

/// Sets the engine up: FFmpeg, the cache, the media folders and where its log
/// lines go. Call once, before anything else; later calls change only the
/// media folders.
#[napi]
pub fn init(options: InitOptions) -> napi::Result<()> {
    let InitOptions {
        home,
        cache_dir,
        ffmpeg,
        ffprobe,
        media_folders,
        log,
    } = options;
    edit_engine::log::use_sink(Box::new(ToJs(log)));
    edit_engine::util::use_tools(ffmpeg.into(), ffprobe.into());
    edit_engine::util::use_cache_dir(cache_dir.into());
    let home = PathBuf::from(home);
    edit_engine::util::use_media_folders(
        home.clone(),
        media_folders.into_iter().map(PathBuf::from).collect(),
    );
    let _ = HOME.set(home);
    Ok(())
}

/// The media folders changed (`store.publish_layout` / `set_media_dir`).
#[napi]
pub fn set_media_folders(known: Vec<String>) -> napi::Result<()> {
    let home = home().map_err(crate::fail)?;
    edit_engine::util::use_media_folders(home, known.into_iter().map(PathBuf::from).collect());
    Ok(())
}

/// Stops the frame renderer's thread and cancels running exports (the
/// server is quitting).
#[napi]
pub fn shutdown() {
    crate::render::stop();
    crate::export::cancel_all();
}

/// Locks held for the life of the process, by path.
static HELD: Mutex<Option<HashMap<PathBuf, std::fs::File>>> = Mutex::new(None);

fn lock_file(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)
}

/// Takes `path`'s lock (flock) for the life of the process: false when
/// another process holds it (or it can't be opened).
#[napi]
pub fn hold_lock(path: String) -> bool {
    let path = PathBuf::from(path);
    let mut held = HELD.lock();
    let held = held.get_or_insert_with(HashMap::new);
    if held.contains_key(&path) {
        return true;
    }
    let Ok(file) = lock_file(&path) else {
        return false;
    };
    if file.try_lock().is_err() {
        return false;
    }
    held.insert(path, file);
    true
}

/// Whether another process holds `path`'s lock (`edit media move` asks
/// before touching a data folder).
#[napi]
pub fn is_locked(path: String) -> bool {
    let path = PathBuf::from(path);
    if HELD
        .lock()
        .as_ref()
        .is_some_and(|held| held.contains_key(&path))
    {
        return false;
    }
    let Ok(file) = lock_file(&path) else {
        return false;
    };
    // Dropping the file lets go of the lock just taken.
    file.try_lock().is_err()
}

/// Becomes `exe` with `args`, in place (same pid, terminal and flags), after
/// marking every descriptor above stderr close-on-exec so no listener leaks
/// into the new server. Returns only if the exec failed.
#[napi(ts_return_type = "never")]
pub fn reexec(exe: String, args: Vec<String>) -> napi::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        close_on_exec_above_stderr();
        let error = std::process::Command::new(&exe).args(&args).exec();
        Err(crate::fail(format!("could not restart as {exe}: {error}")))
    }
    #[cfg(not(unix))]
    {
        let _ = args;
        Err(crate::fail(format!(
            "restarting as {exe} needs a Unix system"
        )))
    }
}

#[cfg(unix)]
fn close_on_exec_above_stderr() {
    // SAFETY: getrlimit only writes the struct it's given.
    let limit = unsafe {
        let mut limit = std::mem::zeroed::<libc::rlimit>();
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) == 0 {
            limit.rlim_cur
        } else {
            1024
        }
    };
    let highest = libc::c_int::try_from(limit.min(65_536)).unwrap_or(1024);
    for fd in 3..highest {
        // SAFETY: fcntl on a descriptor that may not be open just fails (EBADF).
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFD);
            if flags >= 0 {
                libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
            }
        }
    }
}
