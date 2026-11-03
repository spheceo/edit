//! Local excerpts of cloud originals, so an export decodes files on this Mac
//! instead of footage over HTTPS (off Modal, step 2; Sphe, Nov 2).
//!
//! An export of a cloud edit read every original through a presigned URL, one
//! FFmpeg process per clip, each restart paying R2's ~0.25–0.5 s from South
//! Africa: Kroger (148k frames, 414 clips, 63 originals) took 65 minutes. The
//! server now cuts the stretches the timeline uses into local files first
//! (picture copied, never re-encoded; `apps/server/src/export_excerpts.ts`) and
//! names them here by the object they were cut from. A reader of that object
//! (`render::VideoReader`) asked for a time inside one reads the excerpt with
//! AVFoundation instead; anywhere else, or if the excerpt won't open, it reads
//! the URL as before.
//!
//! An excerpt starts on the original's frame grid (`from` is a whole number of
//! frames), and FFmpeg's stream copy writes an edit list so the excerpt's time
//! 0 is the original's `from` exactly (checked frame for frame, Nov 2), so a
//! frame of the original at `t` is the excerpt's frame at `t - from`.
//!
//! Objects are named by their content and never change, so what's known here
//! is shared by every export and kept for the process's life; a file the
//! cache's cleaner took is skipped when a reader looks.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;

/// Seconds `from..to` of an original, in a local file whose time 0 is `from`.
#[derive(Clone, Debug, PartialEq)]
pub struct Excerpt {
    pub from: f64,
    pub to: f64,
    pub path: PathBuf,
}

fn known() -> &'static Mutex<HashMap<String, Arc<Vec<Excerpt>>>> {
    static KNOWN: OnceLock<Mutex<HashMap<String, Arc<Vec<Excerpt>>>>> = OnceLock::new();
    KNOWN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The object a cloud URL reads, without its signature (new every export).
pub fn object_of(path: &Path) -> Option<String> {
    if !crate::util::is_url(path) {
        return None;
    }
    let text = path.to_string_lossy();
    Some(text.split('?').next().unwrap_or_default().to_owned())
}

/// Adds `excerpts` of `object` (a URL without its query) to what readers use.
pub fn add(object: &str, excerpts: impl IntoIterator<Item = Excerpt>) {
    let mut known = known().lock();
    let mut all: Vec<Excerpt> = known
        .get(object)
        .map(|list| list.as_ref().clone())
        .unwrap_or_default();
    for excerpt in excerpts {
        if excerpt.to > excerpt.from && !all.contains(&excerpt) {
            all.push(excerpt);
        }
    }
    all.sort_by(|a, b| a.from.total_cmp(&b.from));
    known.insert(object.to_owned(), Arc::new(all));
}

/// The excerpts of what `path` reads, if it's a cloud URL with any.
pub fn of(path: &Path) -> Option<Arc<Vec<Excerpt>>> {
    let object = object_of(path)?;
    known().lock().get(&object).cloned()
}

/// Which of `excerpts` holds `time` (the latest starting at or before it),
/// leaving out those in `skip`.
pub fn covering(excerpts: &[Excerpt], time: f64, skip: &[usize]) -> Option<usize> {
    excerpts
        .iter()
        .enumerate()
        .filter(|(index, excerpt)| {
            !skip.contains(index) && excerpt.from <= time + 1e-6 && time <= excerpt.to + 1e-6
        })
        .max_by(|(_, a), (_, b)| a.from.total_cmp(&b.from))
        .map(|(index, _)| index)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excerpts_are_found_by_object_and_time() {
        let url = Path::new("https://r2.example/edit/originals/drive/abc/a.mp4?X-Amz-Signature=1");
        assert_eq!(
            object_of(url).as_deref(),
            Some("https://r2.example/edit/originals/drive/abc/a.mp4")
        );
        assert_eq!(object_of(Path::new("/footage/a.mp4")), None);
        let excerpt = |from: f64, to: f64| Excerpt {
            from,
            to,
            path: PathBuf::from(format!("/cache/{from}.mp4")),
        };
        add(
            "https://r2.example/edit/originals/drive/abc/a.mp4",
            [excerpt(30.0, 60.0), excerpt(0.0, 30.0)],
        );
        // Signed again: the same object.
        let list = of(Path::new(
            "https://r2.example/edit/originals/drive/abc/a.mp4?X-Amz-Signature=2",
        ))
        .unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].from, 0.0);
        assert_eq!(covering(&list, 12.0, &[]), Some(0));
        // On the seam, the later one.
        assert_eq!(covering(&list, 30.0, &[]), Some(1));
        assert_eq!(covering(&list, 30.0, &[1]), Some(0));
        assert_eq!(covering(&list, 61.0, &[]), None);
        assert!(of(Path::new("https://r2.example/other.mp4")).is_none());
    }
}
