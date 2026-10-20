//! What the engine needs from its host: where FFmpeg is, where the media
//! cache is, the media folders cache keys are named through, atomic writes,
//! and containing panics. The Rust server re-exports these as its own
//! (`tools`, `store::write_atomic`, `guard::catch`); the native addon sets
//! them from `init`.

use std::any::Any;
use std::ffi::OsString;
use std::io::Write;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------------
// FFmpeg

/// The FFmpeg Edit runs. Releases ship it beside the `edit` binary as
/// `edit-ffmpeg` / `edit-ffprobe` (named so they never shadow the user's own
/// on PATH), or in Edit.app's Resources; a dev build falls back to the ones
/// on PATH. `EDIT_FFMPEG` / `EDIT_FFPROBE` point at others, and a host that
/// knows better ([`use_tools`], called before the first use) says where.
pub fn ffmpeg() -> &'static OsString {
    static PATH: OnceLock<OsString> = OnceLock::new();
    PATH.get_or_init(|| chosen(0).unwrap_or_else(|| find("ffmpeg", "EDIT_FFMPEG")))
}

pub fn ffprobe() -> &'static OsString {
    static PATH: OnceLock<OsString> = OnceLock::new();
    PATH.get_or_init(|| chosen(1).unwrap_or_else(|| find("ffprobe", "EDIT_FFPROBE")))
}

/// FFmpeg and ffprobe as the host found them. Only the first call counts,
/// and only before [`ffmpeg`] / [`ffprobe`] are first asked.
pub fn use_tools(ffmpeg: OsString, ffprobe: OsString) {
    let _ = CHOSEN.set([ffmpeg, ffprobe]);
}

static CHOSEN: OnceLock<[OsString; 2]> = OnceLock::new();

fn chosen(index: usize) -> Option<OsString> {
    CHOSEN
        .get()
        .and_then(|tools| tools.get(index))
        .filter(|path| !path.is_empty())
        .cloned()
}

/// Whether the FFmpeg in use is the one shipped with Edit.
pub fn bundled() -> bool {
    PathBuf::from(ffmpeg()).is_absolute()
}

/// The `edit` binary as installed: `EDIT_EXE` when this process is the same
/// program run under another name (the desktop app's "Edit"), else this one.
pub fn original_exe() -> std::io::Result<PathBuf> {
    match std::env::var_os("EDIT_EXE") {
        Some(path) => Ok(PathBuf::from(path)),
        None => std::env::current_exe(),
    }
}

fn find(tool: &str, variable: &str) -> OsString {
    if let Some(path) = std::env::var_os(variable).filter(|path| !path.is_empty()) {
        return path;
    }
    let beside = original_exe()
        .and_then(std::fs::canonicalize)
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from));
    let shipped = format!("edit-{tool}");
    let candidates = beside
        .iter()
        .flat_map(|dir| [dir.join(&shipped), dir.join("../Resources").join(&shipped)]);
    for candidate in candidates {
        if candidate.is_file() {
            return candidate.into_os_string();
        }
    }
    tool.into()
}

/// Whether `path` is an http(s) URL (a cloud original read through a
/// presigned URL, `cloud_media`) rather than a file.
pub fn is_url(path: &Path) -> bool {
    path.to_str()
        .is_some_and(|text| text.starts_with("https://") || text.starts_with("http://"))
}

/// The protocols FFmpeg may use to read `path`: files and pipes, plus HTTPS
/// for a URL (never for a file, so a crafted playlist can't reach the network).
pub fn protocols(path: &Path) -> &'static str {
    if is_url(path) {
        "file,pipe,http,https,tcp,tls,crypto"
    } else {
        "file,pipe"
    }
}

/// FFmpeg's input options for reading `path` over HTTPS: the system's
/// certificates (the shipped static FFmpeg's OpenSSL doesn't know where macOS
/// keeps them, so without them every HTTPS read fails verification), and
/// picking a long read from R2 back up when the connection drops.
pub fn url_args(path: &Path) -> &'static [&'static str] {
    const SYSTEM: &str = "/etc/ssl/cert.pem";
    static FOUND: OnceLock<bool> = OnceLock::new();
    // A read that gets nothing for 30 s fails (and reconnects) rather than
    // waiting forever on a connection that went quiet.
    const RECONNECT: [&str; 8] = [
        "-reconnect",
        "1",
        "-reconnect_on_network_error",
        "1",
        "-reconnect_delay_max",
        "10",
        "-rw_timeout",
        "30000000",
    ];
    if !is_url(path) {
        &[]
    } else if *FOUND.get_or_init(|| Path::new(SYSTEM).is_file()) {
        &[
            "-ca_file",
            SYSTEM,
            RECONNECT[0],
            RECONNECT[1],
            RECONNECT[2],
            RECONNECT[3],
            RECONNECT[4],
            RECONNECT[5],
            RECONNECT[6],
            RECONNECT[7],
        ]
    } else {
        &RECONNECT
    }
}

// ---------------------------------------------------------------------------
// The media cache and cache keys

/// Edit's media cache (`Store::cache_dir`), set once the server starts.
static CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn use_cache_dir(dir: PathBuf) {
    let _ = CACHE_DIR.set(dir);
}

/// The media cache, once set.
pub fn cache_dir() -> Option<&'static Path> {
    CACHE_DIR.get().map(PathBuf::as_path)
}

/// A media file's cache folder (where the server keeps its previews and
/// waveform), for work that has no store at hand.
pub fn media_cache(source: &Path) -> Option<PathBuf> {
    Some(CACHE_DIR.get()?.join(crate::media::media_key(source)))
}

/// The data folder and every media folder ever set (the server's
/// `media_drive::Layout`: `home` and `known`), for cache keys.
struct Folders {
    home: PathBuf,
    known: Vec<PathBuf>,
}

/// Unset (tests, CLI) means keys are plain paths.
static FOLDERS: RwLock<Option<Folders>> = RwLock::new(None);

/// Says where the data folder and the media folders are; called again
/// whenever the media drive changes.
pub fn use_media_folders(home: PathBuf, known: Vec<PathBuf>) {
    *FOLDERS
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Folders { home, known });
}

/// [`key_path_in`] with the folders the host gave ([`use_media_folders`]).
pub fn key_path(path: &Path) -> PathBuf {
    match &*FOLDERS
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
    {
        Some(folders) => key_path_in(&folders.home, &folders.known, path),
        None => path.to_path_buf(),
    }
}

/// The name a file's cache key uses: a file in a media folder (`known`) is
/// named by its place in the data folder (`home`), so moving it there (or
/// importing it there in the first place) keeps its key.
pub fn key_path_in(home: &Path, known: &[PathBuf], path: &Path) -> PathBuf {
    for dir in known {
        if let Ok(rest) = path.strip_prefix(dir) {
            return home.join(rest);
        }
    }
    path.to_path_buf()
}

// ---------------------------------------------------------------------------
// Files

/// Writes `bytes` to `path` through a temporary file beside it, synced and
/// renamed into place, so a reader sees the old file or the new one.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{}-{}.tmp", std::process::id(), next_file_id()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// The file `path` is written to before it's renamed into place
/// (`preview-light.<pid>-<n>.partial.mp4`), its own for each writer: an FFmpeg
/// left running by a server that died kept writing the same
/// `preview-light.partial.mp4` as the next server's, and the light preview
/// renamed into place had its index pointing at the wrong bytes ("Decoder
/// error." from the start to the end of the 57-minute Sabrina Limon 2nd).
/// Ones left behind (untouched for an hour) are removed.
pub fn partial(path: &Path, extension: &str) -> PathBuf {
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let prefix = format!("{stem}.");
    let suffix = format!("partial.{extension}");
    let left = |entry: &std::fs::DirEntry| {
        entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(3600))
    };
    if let Some(entries) = path.parent().and_then(|dir| std::fs::read_dir(dir).ok()) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let ours = name
                .strip_prefix(&prefix)
                .and_then(|rest| rest.strip_suffix(&suffix))
                .is_some_and(|tag| {
                    tag.is_empty()
                        || tag
                            .trim_end_matches('.')
                            .bytes()
                            .all(|b| b.is_ascii_digit() || b == b'-')
                });
            if ours && left(&entry) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    path.with_extension(format!(
        "{}-{}.{suffix}",
        std::process::id(),
        next_file_id()
    ))
}

/// A number no other call in this process gets (temporary files, new ids).
pub fn next_file_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

// ---------------------------------------------------------------------------
// Decoders a cancel kills

/// The FFmpeg decoders an export started. A decoder blocked in a read (a
/// stalled network, a hung FFmpeg) never looks at the cancel flag, so
/// [`killed_on_cancel`] kills them: the blocked read ends and the export
/// stops. A pid is listed only until its child is reaped (taken out first,
/// under the same lock), so a kill never reaches a reused pid.
#[derive(Default)]
pub struct Decoders {
    pids: parking_lot::Mutex<std::collections::HashSet<u32>>,
}

impl Decoders {
    fn kill_all(&self) {
        for pid in self.pids.lock().iter() {
            // SAFETY: signalling our own child, listed only until it's reaped.
            unsafe {
                libc::kill(*pid as i32, libc::SIGKILL);
            }
        }
    }
}

std::thread_local! {
    static DECODERS: std::cell::RefCell<Option<std::sync::Arc<Decoders>>> =
        const { std::cell::RefCell::new(None) };
}

/// This thread's export's decoders, to carry into the threads it starts.
pub fn decoders() -> Option<std::sync::Arc<Decoders>> {
    DECODERS.with(|current| current.borrow().clone())
}

/// Runs `work` with the decoders it starts listed in `decoders`.
pub fn with_decoders<T>(decoders: Option<std::sync::Arc<Decoders>>, work: impl FnOnce() -> T) -> T {
    let before = DECODERS.with(|current| current.replace(decoders));
    let result = work();
    DECODERS.with(|current| current.replace(before));
    result
}

/// Runs `work` (an export), killing the decoders it starts once `cancel` is set.
pub fn killed_on_cancel<T>(cancel: &std::sync::atomic::AtomicBool, work: impl FnOnce() -> T) -> T {
    let decoders = std::sync::Arc::new(Decoders::default());
    let done = std::sync::atomic::AtomicBool::new(false);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            while !done.load(Ordering::Acquire) {
                if cancel.load(Ordering::Acquire) {
                    decoders.kill_all();
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        });
        let result = with_decoders(Some(std::sync::Arc::clone(&decoders)), work);
        done.store(true, Ordering::Release);
        result
    })
}

/// A decoder child listed with this thread's export (if any) until it's reaped.
pub struct Watched {
    pub child: std::process::Child,
    decoders: Option<std::sync::Arc<Decoders>>,
}

impl Watched {
    pub fn new(child: std::process::Child) -> Self {
        let decoders = decoders();
        if let Some(decoders) = &decoders {
            decoders.pids.lock().insert(child.id());
        }
        Self { child, decoders }
    }

    fn unlist(&mut self) {
        if let Some(decoders) = self.decoders.take() {
            decoders.pids.lock().remove(&self.child.id());
        }
    }

    /// Waits for it to exit (it's no longer killed on cancel).
    pub fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.unlist();
        self.child.wait()
    }

    pub fn stop(&mut self) {
        self.unlist();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Watched {
    fn drop(&mut self) {
        self.stop();
    }
}

// ---------------------------------------------------------------------------
// Panics

/// What a panic said, for logs and the job's error.
pub fn message(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".to_owned())
}

/// Logs a crash in `what` and words it as the error the caller returns.
pub fn crashed(what: &str, payload: &(dyn Any + Send)) -> String {
    let message = message(payload);
    crate::log::error("crash", format!("{what} crashed: {message}"));
    format!("{what} crashed ({message}); this is a bug in Edit")
}

/// Runs `work`, turning a panic into an error naming `what`: a bug in one
/// job must not take the server down or leave the job "working" forever.
pub fn catch<T>(what: &str, work: impl FnOnce() -> T) -> Result<T, String> {
    std::panic::catch_unwind(AssertUnwindSafe(work)).map_err(|payload| crashed(what, &*payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_writer_has_its_own_partial_file() {
        let dir = std::env::temp_dir().join(format!(
            "edit-partial-{}-{}",
            std::process::id(),
            next_file_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let light = dir.join("preview-light.mp4");
        let (first, second) = (partial(&light, "mp4"), partial(&light, "mp4"));
        assert_ne!(first, second);
        let name = first.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with("preview-light.") && name.ends_with(".partial.mp4"),
            "{name}"
        );
        // Left behind an hour ago (the old shared name, another process's), or another file's: only the first two go.
        let old = SystemTime::now() - Duration::from_secs(7200);
        for file in [
            "preview-light.partial.mp4",
            "preview-light.1-0.partial.mp4",
            "preview.1-0.partial.mp4",
            "preview-light.mp4",
        ] {
            let file = std::fs::File::create(dir.join(file)).unwrap();
            file.set_modified(old).unwrap();
        }
        std::fs::write(dir.join("preview-light.2-0.partial.mp4"), b"").unwrap();
        partial(&light, "mp4");
        let mut left: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "preview-light.2-0.partial.mp4",
                "preview-light.mp4",
                "preview.1-0.partial.mp4"
            ]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn panics_become_errors() {
        assert_eq!(catch("sum", || 1 + 1), Ok(2));
        let error = catch("job", || -> u8 { panic!("boom") }).unwrap_err();
        assert!(error.contains("job crashed (boom)"), "{error}");
        let error = catch("job", || -> u8 { panic!("{}", String::from("owned")) }).unwrap_err();
        assert!(error.contains("owned"), "{error}");
    }

    #[test]
    fn keys_are_named_through_the_media_folders() {
        let (home, known) = (Path::new("/home/me/.edit"), ["/Volumes/Drive/Edit".into()]);
        assert_eq!(
            key_path_in(home, &known, Path::new("/Volumes/Drive/Edit/media/a.mp4")),
            PathBuf::from("/home/me/.edit/media/a.mp4")
        );
        assert_eq!(
            key_path_in(home, &known, Path::new("/elsewhere/a.mp4")),
            PathBuf::from("/elsewhere/a.mp4")
        );
    }
}
