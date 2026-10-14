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
