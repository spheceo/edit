//! The FFmpeg Edit runs and the media cache, as the engine finds them
//! (`edit_engine::util`). Releases ship FFmpeg beside the `edit` binary as
//! `edit-ffmpeg` / `edit-ffprobe` (named so they never shadow the user's own
//! on PATH), or in Edit.app's Resources; a dev build falls back to the ones
//! on PATH. `EDIT_FFMPEG` / `EDIT_FFPROBE` point at others.

pub use edit_engine::util::{
    bundled, ffmpeg, ffprobe, is_url, media_cache, protocols, url_args, use_cache_dir,
};
