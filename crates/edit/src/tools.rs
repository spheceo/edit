//! The FFmpeg Edit runs. Releases ship it beside the `edit` binary as
//! `edit-ffmpeg` / `edit-ffprobe` (named so they never shadow the user's own
//! on PATH), or in Edit.app's Resources; a dev build falls back to the ones
//! on PATH. `EDIT_FFMPEG` / `EDIT_FFPROBE` point at others.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::OnceLock;

pub fn ffmpeg() -> &'static OsString {
    static PATH: OnceLock<OsString> = OnceLock::new();
    PATH.get_or_init(|| find("ffmpeg", "EDIT_FFMPEG"))
}

pub fn ffprobe() -> &'static OsString {
    static PATH: OnceLock<OsString> = OnceLock::new();
    PATH.get_or_init(|| find("ffprobe", "EDIT_FFPROBE"))
}

/// Whether the FFmpeg in use is the one shipped with Edit.
pub fn bundled() -> bool {
    PathBuf::from(ffmpeg()).is_absolute()
}

fn find(tool: &str, variable: &str) -> OsString {
    if let Some(path) = std::env::var_os(variable).filter(|path| !path.is_empty()) {
        return path;
    }
    let beside = crate::app::original_exe()
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

/// Edit's media cache (`Store::cache_dir`), set once the server starts.
static CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn use_cache_dir(dir: PathBuf) {
    let _ = CACHE_DIR.set(dir);
}

/// A media file's cache folder (where `media::Processor::paths` keeps its
/// previews and waveform), for work that has no `App` at hand.
pub fn media_cache(source: &std::path::Path) -> Option<PathBuf> {
    Some(CACHE_DIR.get()?.join(crate::media::media_key(source)))
}

/// Whether `path` is an http(s) URL (a cloud original read through a
/// presigned URL, `cloud_media`) rather than a file.
pub fn is_url(path: &std::path::Path) -> bool {
    path.to_str()
        .is_some_and(|text| text.starts_with("https://") || text.starts_with("http://"))
}

/// The protocols FFmpeg may use to read `path`: files and pipes, plus HTTPS
/// for a URL (never for a file, so a crafted playlist can't reach the network).
pub fn protocols(path: &std::path::Path) -> &'static str {
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
pub fn url_args(path: &std::path::Path) -> &'static [&'static str] {
    const SYSTEM: &str = "/etc/ssl/cert.pem";
    static FOUND: OnceLock<bool> = OnceLock::new();
    const RECONNECT: [&str; 6] = [
        "-reconnect",
        "1",
        "-reconnect_on_network_error",
        "1",
        "-reconnect_delay_max",
        "10",
    ];
    if !is_url(path) {
        &[]
    } else if *FOUND.get_or_init(|| std::path::Path::new(SYSTEM).is_file()) {
        &[
            "-ca_file",
            SYSTEM,
            RECONNECT[0],
            RECONNECT[1],
            RECONNECT[2],
            RECONNECT[3],
            RECONNECT[4],
            RECONNECT[5],
        ]
    } else {
        &RECONNECT
    }
}
