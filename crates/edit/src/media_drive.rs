//! The media drive: where Edit keeps its big media files when the Mac's own
//! disk is too small. Off unless set (Settings → Media drive, `edit media use
//! DIR`, `edit media move --to DIR`, or `EDIT_MEDIA_DIR`), and then exactly as
//! before: everything in the data folder (~/.edit).
//!
//! With a media folder set, what Edit writes as media goes there: Drive
//! downloads and their excerpts (`media/drive/`), uploads, voice-over takes
//! sent to a project, stills, smoothed shots and map renders (`media/<project>/`),
//! and exports by default (`Exports/`). Projects and their history, the cache
//! (previews, frames, analysis, watch and seats answers, thumbnails), library
//! sounds, logs and settings stay in the data folder.
//!
//! The media folder mirrors the data folder (`media/…`, `uploads/…`), so a
//! file's place on one side is its place on the other:
//! - projects keep absolute paths; [`Layout::resolve`] finds a file that's
//!   on the other side now, so a reference to its old place still opens;
//! - [`Layout::key_path`] names a file on the drive by its data-folder place
//!   for cache keys (`media::media_key`), so previews, transcripts and
//!   analysis made before a move still match (a move keeps sizes and
//!   modification times exactly);
//! - a drive that isn't connected (unplugged, or `/Volumes/X` left behind as
//!   an empty folder) is never written to: new media is refused with an error
//!   saying so rather than put on the internal disk unannounced, and its
//!   files show as missing like any missing file.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

use serde::Serialize;
use serde_json::{json, Value};

use crate::store::Store;

/// Overrides the setting (and can't be changed from the UI).
pub const ENV: &str = "EDIT_MEDIA_DIR";
/// In the media folder: proof it's the folder Edit set up, not an empty
/// mount point left on the internal disk.
pub const MARKER: &str = ".edit-media-drive";
/// The data folder's subfolders that hold media; with a media drive they're
/// mirrored there.
pub const MOVABLE: [&str; 2] = ["media", "uploads"];
/// Edit's app settings, in the data folder.
const SETTINGS: &str = "settings.json";
/// Held by a running server (and by `edit media move`), so a move never runs
/// under a server using the same data folder.
pub const LOCK: &str = "server.lock";
/// A copy being made; renamed to the file's name once it's whole.
const MOVING: &str = ".edit-moving";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layout {
    /// The data folder (canonical).
    pub home: PathBuf,
    /// The media folder, when one is set.
    pub media: Option<PathBuf>,
    /// Set by `EDIT_MEDIA_DIR`.
    pub from_env: bool,
    /// Every media folder ever set, the current one included: files there are
    /// still found, and keep their cache keys, after the setting changes.
    pub known: Vec<PathBuf>,
}

impl Layout {
    /// The data folder's layout: `EDIT_MEDIA_DIR`, else its settings.
    pub fn load(home: &Path) -> Self {
        let env = std::env::var_os(ENV)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        Self::from_settings(home, env)
    }

    fn from_settings(home: &Path, env: Option<PathBuf>) -> Self {
        let home = canonical(home);
        let settings = read_settings(&home);
        let configured = settings
            .get("media_dir")
            .and_then(Value::as_str)
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from);
        let from_env = env.is_some();
        let media = env.or(configured).map(|dir| canonical(&dir));
        let mut known: Vec<PathBuf> = settings
            .get("media_dirs_known")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(PathBuf::from)
            .collect();
        if let Some(dir) = &media {
            if !known.contains(dir) {
                known.push(dir.clone());
            }
        }
        Self {
            home,
            media,
            from_env,
            known,
        }
    }

    /// The media folder when one is set (`Ok(None)` when not), or why it
    /// can't be used now.
    pub fn drive(&self) -> Result<Option<&Path>, String> {
        match &self.media {
            None => Ok(None),
            Some(dir) => check(dir).map(|()| Some(dir.as_path())),
        }
    }

    /// Where new media goes: the media folder, else the data folder; never
    /// the data folder in place of a drive that isn't connected.
    pub fn media_root(&self) -> Result<PathBuf, String> {
        Ok(self
            .drive()?
            .map_or_else(|| self.home.clone(), Path::to_path_buf))
    }

    /// Where exports go unless told otherwise.
    pub fn exports_dir(&self) -> PathBuf {
        match &self.media {
            Some(dir) => dir.join("Exports"),
            None => default_exports_dir(),
        }
    }

    /// Refuses a write into the media folder while its drive isn't connected.
    pub fn writable(&self, path: &Path) -> Result<(), String> {
        match &self.media {
            Some(dir) if path.starts_with(dir) => check(dir),
            _ => Ok(()),
        }
    }

    /// Every other place a media file could be now: the same place under
    /// the media folder, the data folder and earlier media folders.
    fn places(&self, path: &Path) -> Vec<PathBuf> {
        let mut roots: Vec<&Path> = Vec::new();
        if let Some(dir) = &self.media {
            roots.push(dir);
        }
        roots.push(&self.home);
        for dir in &self.known {
            if !roots.contains(&dir.as_path()) {
                roots.push(dir);
            }
        }
        for root in &roots {
            for sub in MOVABLE {
                if let Ok(rest) = path.strip_prefix(root.join(sub)) {
                    return roots
                        .iter()
                        .map(|other| other.join(sub).join(rest))
                        .filter(|place| place != path)
                        .collect();
                }
            }
        }
        Vec::new()
    }

    /// Where a project's file is now when it isn't where the project says
    /// (moved to the media drive, or back): `None` when it's there, or isn't
    /// anywhere (then it shows as missing, as before).
    pub fn resolve(&self, path: &str) -> Option<String> {
        let path = Path::new(path);
        if path.exists() {
            return None;
        }
        self.places(path)
            .into_iter()
            .find(|place| place.is_file())
            .map(|place| place.to_string_lossy().into_owned())
    }

    /// Points a project's media at where the files are now.
    pub fn resolve_project(&self, project: &mut edit_core::Project) {
        for media in &mut project.media {
            if let Some(found) = self.resolve(&media.path) {
                crate::diag::info(
                    "media",
                    format!(
                        "{} ({}): {} is at {found} now",
                        project.id, media.id, media.path
                    ),
                );
                media.path = found;
            }
        }
    }

    /// The name a file's cache key uses: a file in a media folder is named by
    /// its place in the data folder, so moving it there (or importing it
    /// there in the first place) keeps its key.
    pub fn key_path(&self, path: &Path) -> PathBuf {
        for dir in &self.known {
            if let Ok(rest) = path.strip_prefix(dir) {
                return self.home.join(rest);
            }
        }
        path.to_path_buf()
    }

    /// Where a data-folder file goes on the media drive.
    fn on_drive(&self, drive: &Path, path: &Path) -> Option<PathBuf> {
        let rest = path.strip_prefix(&self.home).ok()?;
        MOVABLE
            .iter()
            .any(|sub| rest.starts_with(sub))
            .then(|| drive.join(rest))
    }
}

/// The running server's layout, for cache keys (`media::media_key` has no
/// store at hand). Unset (tests, CLI) means keys are plain paths.
static PUBLISHED: std::sync::RwLock<Option<Layout>> = std::sync::RwLock::new(None);

pub fn publish(layout: &Layout) {
    *PUBLISHED
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(layout.clone());
}

/// [`Layout::key_path`] with the running server's layout.
pub fn key_path(path: &Path) -> PathBuf {
    match &*PUBLISHED
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
    {
        Some(layout) => layout.key_path(path),
        None => path.to_path_buf(),
    }
}

/// Whether the media folder can be used: its drive is mounted and the folder
/// is the one Edit set up.
pub fn check(dir: &Path) -> Result<(), String> {
    check_under(dir, Path::new("/Volumes"))
}

fn check_under(dir: &Path, volumes: &Path) -> Result<(), String> {
    mounted(dir, volumes)?;
    if !dir.join(MARKER).is_file() {
        return Err(not_connected(
            dir,
            &format!(
                "it has no {MARKER} in it (set it again in Settings, or with `edit media use`)"
            ),
        ));
    }
    Ok(())
}

/// A folder under `/Volumes/<drive>` needs that drive mounted: when it
/// isn't, macOS can leave `/Volumes/<drive>` behind as an empty folder on
/// the internal disk, which must not be mistaken for the drive.
fn mounted(dir: &Path, volumes: &Path) -> Result<(), String> {
    let Ok(rest) = dir.strip_prefix(volumes) else {
        return Ok(());
    };
    let Some(name) = rest.components().next() else {
        return Ok(());
    };
    let volume = volumes.join(name);
    #[cfg(unix)]
    let mounted = {
        use std::os::unix::fs::MetadataExt;
        match (std::fs::metadata(&volume), std::fs::metadata(volumes)) {
            (Ok(drive), Ok(parent)) => drive.dev() != parent.dev(),
            _ => false,
        }
    };
    #[cfg(not(unix))]
    let mounted = volume.is_dir();
    if mounted {
        Ok(())
    } else {
        Err(not_connected(
            dir,
            &format!("{} isn't mounted", volume.display()),
        ))
    }
}

fn not_connected(dir: &Path, why: &str) -> String {
    format!(
        "The media drive ({}) isn't connected: {why}. Plug it in, or turn the media drive off in Settings to keep new media on this Mac.",
        dir.display()
    )
}

/// Makes `dir` the media folder: its drive must be connected; the folder is
/// made (only its last part: never a whole path inside an empty mount point)
/// and marked. Returns it canonical.
pub fn prepare(home: &Path, dir: &Path) -> Result<PathBuf, String> {
    if !dir.is_absolute() {
        return Err(format!(
            "Give the media folder's full path, not {}.",
            dir.display()
        ));
    }
    mounted(dir, Path::new("/Volumes"))?;
    let parent = dir
        .parent()
        .ok_or_else(|| "The media folder can't be the root of the disk.".to_owned())?;
    if !parent.is_dir() {
        return Err(format!(
            "{} doesn't exist (is the drive connected?).",
            parent.display()
        ));
    }
    let name = dir
        .file_name()
        .ok_or_else(|| format!("{} has no folder name", dir.display()))?;
    let target = canonical(parent).join(name);
    let home = canonical(home);
    if target.starts_with(&home) || home.starts_with(&target) {
        return Err(format!(
            "The media folder must be outside Edit's data folder ({}).",
            home.display()
        ));
    }
    if !target.is_dir() {
        std::fs::create_dir(&target).map_err(|error| format!("{}: {error}", target.display()))?;
    }
    let dir = canonical(&target);
    let marker = dir.join(MARKER);
    if !marker.is_file() {
        let note = json!({
            "about": "Edit keeps its media here (Settings → Media drive). Keep this file: without it Edit takes the folder for an unplugged drive.",
            "home": home,
            "created_ms": crate::store::now_ms(),
        });
        crate::store::write_atomic(&marker, note.to_string().as_bytes())
            .map_err(|error| format!("{}: {error}", marker.display()))?;
    }
    Ok(dir)
}

/// Makes the env's media folder usable at startup (it's set on purpose).
pub fn prepare_env(layout: &Layout) {
    if let (true, Some(dir)) = (layout.from_env, &layout.media) {
        if check(dir).is_err() {
            if let Err(error) = prepare(&layout.home, dir) {
                crate::diag::warn("media", format!("{ENV}: {error}"));
            }
        }
    }
}

fn read_settings(home: &Path) -> Value {
    std::fs::read(home.join(SETTINGS))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

/// Saves the media folder setting (other settings kept as they are).
pub fn save(layout: &Layout) -> Result<(), String> {
    let mut settings = read_settings(&layout.home);
    if let Some(fields) = settings.as_object_mut() {
        if !layout.from_env {
            fields.insert("media_dir".to_owned(), json!(layout.media));
        }
        fields.insert("media_dirs_known".to_owned(), json!(layout.known));
    }
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|error| error.to_string())?;
    crate::store::write_atomic(&layout.home.join(SETTINGS), &bytes)
        .map_err(|error| format!("saving {SETTINGS}: {error}"))
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

pub fn default_exports_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let movies = home.join("Movies");
    if movies.is_dir() {
        movies.join("Edit")
    } else {
        home.join("Videos").join("Edit")
    }
}

/// The status the UI's settings show.
pub fn status(layout: &Layout) -> Value {
    let (state, problem) = match layout.drive() {
        Ok(None) => ("off", None),
        Ok(Some(_)) => ("connected", None),
        Err(problem) => ("offline", Some(problem)),
    };
    let internal: u64 = sources(&layout.home)
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok())
        .map(|meta| meta.len())
        .sum();
    json!({
        "dir": layout.media,
        "env": layout.from_env,
        "state": state,
        "problem": problem,
        "home": layout.home,
        "exports": layout.exports_dir(),
        "internal_bytes": internal,
        "move_command": layout.media.as_ref().map(|dir| move_command(&layout.home, dir)),
        "volumes": volumes(),
    })
}

/// The command that moves what's still in the data folder to `dir`.
pub fn move_command(home: &Path, dir: &Path) -> String {
    let quote = |path: &Path| {
        let text = path.to_string_lossy();
        if text
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "/._-".contains(ch))
        {
            text.into_owned()
        } else {
            format!("'{}'", text.replace('\'', r"'\''"))
        }
    };
    let mut command = format!("edit media move --to {}", quote(dir));
    let standard = std::env::var_os("HOME")
        .map(|user| canonical(&PathBuf::from(user).join(".edit")))
        .is_some_and(|standard| standard == home);
    if !standard {
        command.push_str(&format!(" --home {}", quote(home)));
    }
    command
}

/// Drives mounted under /Volumes (suggestions for the setting).
fn volumes() -> Vec<Value> {
    let root = Path::new("/Volumes");
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<Value> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .filter(|path| mounted(path, root).is_ok())
        .map(|path| {
            json!({
                "name": path.file_name().map(|name| name.to_string_lossy().into_owned()),
                "path": path,
            })
        })
        .collect();
    out.sort_by_key(Value::to_string);
    out
}

// ---------------------------------------------------------------------------
// Moving what's in the data folder to the media drive (`edit media move`).

#[derive(Debug, Default, Serialize)]
pub struct MoveReport {
    pub to: PathBuf,
    /// Files in the data folder's media folders when the move started.
    pub files: usize,
    pub bytes: u64,
    /// Copied this time.
    pub copied: usize,
    pub copied_bytes: u64,
    /// Already on the drive, whole, from an earlier run.
    pub already: usize,
    /// Originals removed once their copy was checked.
    pub removed: usize,
    /// Projects now pointing at the drive.
    pub projects: usize,
    /// Files left where they were, and why.
    pub problems: Vec<String>,
}

/// Every file in the data folder's media folders (not following links;
/// half-made copies of an earlier move left out).
fn sources(home: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                walk(&path, out);
            } else if kind.is_file() && !path.to_string_lossy().ends_with(MOVING) {
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    for sub in MOVABLE {
        walk(&home.join(sub), &mut out);
    }
    out.sort();
    out
}

enum Copied {
    Made(u64),
    Already,
}

fn same_file(meta: &std::fs::Metadata, len: u64, modified: SystemTime) -> bool {
    meta.is_file() && meta.len() == len && meta.modified().ok() == Some(modified)
}

/// Copies `from` to `to` through a `.edit-moving` file, keeping its
/// modification time, and only names it `to` once its size and time match
/// the original's. A whole copy already there is left alone; a different
/// file there is never overwritten.
fn copy_checked(from: &Path, to: &Path) -> Result<Copied, String> {
    let original = std::fs::metadata(from).map_err(|error| error.to_string())?;
    let (len, modified) = (
        original.len(),
        original.modified().map_err(|error| error.to_string())?,
    );
    if let Ok(there) = std::fs::metadata(to) {
        return if same_file(&there, len, modified) {
            Ok(Copied::Already)
        } else {
            Err(format!(
                "{} is on the media drive already and differs from this one (size or date): both kept",
                to.display()
            ))
        };
    }
    let parent = to
        .parent()
        .ok_or_else(|| format!("{} has no folder", to.display()))?;
    std::fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
    let mut partial = to.as_os_str().to_owned();
    partial.push(MOVING);
    let partial = PathBuf::from(partial);
    let made = (|| -> Result<(), String> {
        let io = |error: std::io::Error| error.to_string();
        let mut source = std::fs::File::open(from).map_err(io)?;
        // Truncates what an interrupted run left.
        let mut copy = std::fs::File::create(&partial).map_err(io)?;
        let mut buffer = vec![0_u8; 4 << 20];
        loop {
            let read = source.read(&mut buffer).map_err(io)?;
            if read == 0 {
                break;
            }
            copy.write_all(buffer.get(..read).unwrap_or_default())
                .map_err(io)?;
        }
        let mut times = std::fs::FileTimes::new().set_modified(modified);
        if let Ok(accessed) = original.accessed() {
            times = times.set_accessed(accessed);
        }
        copy.set_times(times).map_err(io)?;
        copy.sync_all().map_err(io)?;
        let now = std::fs::metadata(from).map_err(io)?;
        if !same_file(&now, len, modified) {
            return Err("it changed while it was being copied".into());
        }
        let copied = std::fs::metadata(&partial).map_err(io)?;
        if copied.len() != len {
            return Err(format!("the copy has {} of its {len} bytes", copied.len()));
        }
        if copied.modified().ok() != Some(modified) {
            return Err("the media drive didn't keep its modification time exactly (format the drive as APFS); previews and transcripts are found by it".into());
        }
        std::fs::rename(&partial, to).map_err(io)
    })();
    match made {
        Ok(()) => Ok(Copied::Made(len)),
        Err(error) => {
            let _ = std::fs::remove_file(&partial);
            Err(format!("{}: {error}", from.display()))
        }
    }
}

/// Removes the empty folders left under `dir` (not `dir` itself).
fn remove_empty(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            let path = entry.path();
            remove_empty(&path);
            let _ = std::fs::remove_dir(&path);
        }
    }
}

/// Moves the data folder's media (`media/`, `uploads/`) to `to` and makes it
/// the media folder. Every file is copied and checked (size and modification
/// time) first; then projects are pointed at the copies; only then do the
/// originals go, each checked against its copy once more. Run again after
/// an interruption, it carries on: whole copies are kept, half-made ones
/// made again, and nothing is removed that hasn't a checked copy.
pub fn move_media(
    store: &Store,
    to: &Path,
    dry_run: bool,
    say: &mut dyn FnMut(String),
) -> Result<MoveReport, String> {
    let subject = format!("{} → {}", store.layout().home.display(), to.display());
    crate::diag::time_on("media", "media: move", &subject, || {
        move_until(store, to, dry_run, None, say)
    })
}

/// [`move_media`], stopping (as if interrupted) before copying file
/// `stop_before` when given.
fn move_until(
    store: &Store,
    to: &Path,
    dry_run: bool,
    stop_before: Option<usize>,
    say: &mut dyn FnMut(String),
) -> Result<MoveReport, String> {
    let layout = store.layout();
    let files = sources(&layout.home);
    let mut report = MoveReport {
        to: to.to_path_buf(),
        files: files.len(),
        bytes: files
            .iter()
            .filter_map(|path| std::fs::metadata(path).ok())
            .map(|meta| meta.len())
            .sum(),
        ..MoveReport::default()
    };
    if dry_run {
        say(format!(
            "{} files ({}) in {} would move to {}",
            report.files,
            size(report.bytes),
            MOVABLE
                .map(|sub| layout.home.join(sub).display().to_string())
                .join(" and "),
            to.display()
        ));
        if let Err(problem) = mounted(to, Path::new("/Volumes")) {
            say(problem);
        }
        return Ok(report);
    }
    let layout = if layout.from_env {
        if layout.media.as_deref() != Some(canonical(to).as_path()) {
            return Err(format!(
                "{ENV} is set to {}; move to that, or change it",
                layout
                    .media
                    .as_deref()
                    .map(Path::display)
                    .map(|dir| dir.to_string())
                    .unwrap_or_default()
            ));
        }
        prepare(&layout.home, to)?;
        layout
    } else {
        // New media goes to the drive from now on, so nothing new lands
        // behind the move.
        store.set_media_dir(Some(to))?
    };
    let drive = layout
        .media
        .clone()
        .ok_or_else(|| "no media folder".to_owned())?;
    check(&drive)?;
    report.to = drive.clone();
    say(format!(
        "moving {} files ({}) to {}",
        report.files,
        size(report.bytes),
        drive.display()
    ));
    let mut checked: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (index, from) in files.iter().enumerate() {
        if stop_before == Some(index) {
            return Err("stopped".into());
        }
        let Some(to) = layout.on_drive(&drive, from) else {
            continue;
        };
        let started = Instant::now();
        let copied = copy_checked(from, &to);
        let took = started.elapsed();
        crate::diag::record(
            "media",
            "media: move file",
            took,
            copied.as_ref().err().map(String::as_str),
        );
        match copied {
            Ok(Copied::Made(bytes)) => {
                report.copied += 1;
                report.copied_bytes += bytes;
                say(format!(
                    "[{}/{}] copied {} ({} in {}, {}/s)",
                    index + 1,
                    report.files,
                    from.display(),
                    size(bytes),
                    crate::diag::human(took),
                    size((bytes as f64 / took.as_secs_f64().max(0.001)) as u64)
                ));
                checked.push((from.clone(), to));
            }
            Ok(Copied::Already) => {
                report.already += 1;
                checked.push((from.clone(), to));
            }
            Err(problem) => {
                say(format!("[{}/{}] kept {problem}", index + 1, report.files));
                report.problems.push(problem);
                if let Err(gone) = check(&drive) {
                    return Err(format!(
                        "{gone} Nothing was removed; run the move again once it's back."
                    ));
                }
            }
        }
    }

    // Projects point at the copies before any original goes. (A project
    // that can't be opened now, or an old version in its history, still
    // finds its files: `Layout::resolve` looks on both sides.)
    let moved: HashMap<String, String> = checked
        .iter()
        .map(|(from, to)| {
            (
                from.to_string_lossy().into_owned(),
                to.to_string_lossy().into_owned(),
            )
        })
        .collect();
    let mut keep: HashSet<String> = HashSet::new();
    for summary in store.list() {
        let Some(live) = store.get(&summary.id) else {
            continue;
        };
        let uses: Vec<String> = live
            .project
            .media
            .iter()
            .filter(|media| moved.contains_key(&media.path))
            .map(|media| media.path.clone())
            .collect();
        if uses.is_empty() {
            continue;
        }
        let pointed = store.update(&summary.id, "media-move", |project| {
            for media in &mut project.media {
                if let Some(to) = moved.get(&media.path) {
                    media.path.clone_from(to);
                }
            }
            Ok(())
        });
        match pointed {
            Ok(_) => report.projects += 1,
            Err(error) => {
                let problem = format!(
                    "{}: couldn't point it at the drive ({error}); its {} files kept here",
                    summary.id,
                    uses.len()
                );
                say(problem.clone());
                report.problems.push(problem);
                keep.extend(uses);
            }
        }
    }

    for (from, to) in &checked {
        if keep.contains(from.to_string_lossy().as_ref()) {
            continue;
        }
        let matches = match (std::fs::metadata(from), std::fs::metadata(to)) {
            (Ok(original), Ok(copy)) => original
                .modified()
                .is_ok_and(|modified| same_file(&copy, original.len(), modified)),
            _ => false,
        };
        if !matches {
            let problem = format!("{}: kept, its copy no longer matches it", from.display());
            report.problems.push(problem);
            continue;
        }
        match std::fs::remove_file(from) {
            Ok(()) => report.removed += 1,
            Err(error) => report
                .problems
                .push(format!("{}: couldn't remove it: {error}", from.display())),
        }
    }
    for sub in MOVABLE {
        remove_empty(&layout.home.join(sub));
    }
    say(format!(
        "done: {} copied ({}), {} already there, {} originals removed, {} projects pointed at {}{}",
        report.copied,
        size(report.copied_bytes),
        report.already,
        report.removed,
        report.projects,
        drive.display(),
        if report.problems.is_empty() {
            String::new()
        } else {
            format!("; {} kept here (above)", report.problems.len())
        }
    ));
    crate::diag::info(
        "media",
        format!(
            "moved media to {}: {} copied ({}), {} already there, {} removed, {} projects, {} problems",
            drive.display(),
            report.copied,
            size(report.copied_bytes),
            report.already,
            report.removed,
            report.projects,
            report.problems.len()
        ),
    );
    Ok(report)
}

pub fn size(bytes: u64) -> String {
    let bytes = bytes as f64;
    if bytes >= 1e9 {
        format!("{:.1} GB", bytes / 1e9)
    } else if bytes >= 1e6 {
        format!("{:.0} MB", bytes / 1e6)
    } else {
        format!(
            "{:.0} KB",
            (bytes / 1e3).max(if bytes > 0.0 { 1.0 } else { 0.0 })
        )
    }
}

// ---------------------------------------------------------------------------
// `edit media …`

/// Takes the data folder's lock for the life of the process (a server). A
/// move holding it shows as a warning, not a refusal to start.
pub fn hold_lock(home: &Path) {
    static HELD: std::sync::OnceLock<std::fs::File> = std::sync::OnceLock::new();
    let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(home.join(LOCK))
    else {
        return;
    };
    match file.try_lock() {
        Ok(()) => {
            let _ = HELD.set(file);
        }
        Err(_) => crate::diag::warn(
            "media",
            format!(
                "another Edit is using {} (a server, or `edit media move`)",
                home.display()
            ),
        ),
    }
}

/// Why it isn't safe to change `home`'s media now: a server is using it.
/// Returns the lock to hold meanwhile.
fn take_lock(home: &Path, port: u16) -> Result<std::fs::File, String> {
    std::fs::create_dir_all(home).map_err(|error| error.to_string())?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(home.join(LOCK))
        .map_err(|error| error.to_string())?;
    let running = || {
        format!(
            "Edit is running with {} — quit it (or stop `edit serve`) first",
            home.display()
        )
    };
    if file.try_lock().is_err() {
        return Err(running());
    }
    // An Edit from before the lock: ask the port what data folder it serves.
    if served_home(port).is_some_and(|served| canonical(&served) == canonical(home)) {
        return Err(format!("{} on port {port}", running()));
    }
    Ok(file)
}

fn served_home(port: u16) -> Option<PathBuf> {
    use std::net::{SocketAddr, TcpStream};
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream =
        TcpStream::connect_timeout(&address, std::time::Duration::from_millis(500)).ok()?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .ok()?;
    write!(
        stream,
        "GET /api/diagnostics HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .ok()?;
    let mut answer = Vec::new();
    let _ = stream.read_to_end(&mut answer);
    let text = String::from_utf8_lossy(&answer);
    let (_, body) = text.split_once("\r\n\r\n")?;
    let value: Value = serde_json::from_str(body).ok()?;
    value.get("home")?.as_str().map(PathBuf::from)
}

pub const HELP: &str = "edit media — where Edit keeps its big media files

  edit media
      Where new media goes, and whether the media drive is connected.
  edit media use DIR
      Keep new media (downloads, uploads, exports) in DIR, e.g. a folder on an
      external drive. Projects, cache, library and logs stay in the data folder.
  edit media off
      Keep new media in the data folder again (files already on the drive stay
      there and keep working while it's connected).
  edit media move --to DIR [--dry-run]
      Move what's in the data folder's media/ and uploads/ to DIR and use it:
      every file is copied and checked (size, modification time) before its
      original is removed, and projects are pointed at the copies. Safe to stop
      and run again. Quit Edit first.

  --home DIR   data folder (default ~/.edit, or EDIT_HOME)
  --port N     the port Edit serves on, to check it isn't running (default 7700)
  EDIT_MEDIA_DIR overrides the setting.
";

pub fn run_cli(home: &Path, port: u16, args: &[String]) {
    let flag = |name: &str| {
        args.iter()
            .position(|arg| arg == name)
            .and_then(|index| args.get(index + 1))
            .cloned()
    };
    let positional = args.get(1).filter(|arg| !arg.starts_with("--")).cloned();
    match args.first().map(String::as_str) {
        None | Some("status") => {
            let layout = Layout::load(home);
            let status = status(&layout);
            match layout.media.as_deref() {
                None => println!(
                    "Media stays in {} (no media drive set).",
                    layout.home.display()
                ),
                Some(dir) => {
                    println!(
                        "New media goes to {}{}.",
                        dir.display(),
                        if layout.from_env {
                            format!(" ({ENV})")
                        } else {
                            String::new()
                        }
                    );
                    if let Some(problem) = status.get("problem").and_then(Value::as_str) {
                        println!("{problem}");
                    }
                }
            }
            let internal = status
                .get("internal_bytes")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if internal > 0 {
                println!(
                    "{} of media is in {}.",
                    size(internal),
                    MOVABLE
                        .map(|sub| layout.home.join(sub).display().to_string())
                        .join(" and ")
                );
                if let Some(dir) = layout.media.as_deref() {
                    println!("Move it with: {}", move_command(&layout.home, dir));
                }
            }
        }
        Some("use") => {
            let dir = positional.unwrap_or_else(|| crate::fail("edit media use DIR"));
            let _lock = take_lock(home, port).unwrap_or_else(|error| crate::fail(&error));
            let store = open_store(home);
            match store.set_media_dir(Some(Path::new(&dir))) {
                Ok(layout) => println!(
                    "New media goes to {} from now on.",
                    layout
                        .media
                        .as_deref()
                        .map(Path::display)
                        .map(|dir| dir.to_string())
                        .unwrap_or_default()
                ),
                Err(error) => crate::fail(&error),
            }
        }
        Some("off") => {
            let _lock = take_lock(home, port).unwrap_or_else(|error| crate::fail(&error));
            let store = open_store(home);
            match store.set_media_dir(None) {
                Ok(layout) => println!("New media stays in {} from now on.", layout.home.display()),
                Err(error) => crate::fail(&error),
            }
        }
        Some("move") => {
            let to = flag("--to")
                .or(positional)
                .unwrap_or_else(|| crate::fail("edit media move --to DIR"));
            let dry_run = args.iter().any(|arg| arg == "--dry-run");
            let _lock = take_lock(home, port).unwrap_or_else(|error| crate::fail(&error));
            crate::diag::open(home);
            let store = open_store(home);
            match move_media(&store, Path::new(&to), dry_run, &mut |line| {
                println!("{line}")
            }) {
                Ok(report) if report.problems.is_empty() => {}
                Ok(report) => {
                    eprintln!(
                        "edit: {} files were kept in the data folder (above); run the move again to retry them",
                        report.problems.len()
                    );
                    std::process::exit(1);
                }
                Err(error) => crate::fail(&error),
            }
        }
        Some("--help" | "-h" | "help") => print!("{HELP}"),
        Some(other) => crate::fail(&format!("unknown media command {other}\n\n{HELP}")),
    }
}

fn open_store(home: &Path) -> Store {
    Store::open(home.to_path_buf())
        .unwrap_or_else(|error| crate::fail(&format!("{}: {error}", home.display())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use edit_core::Settings;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "edit-media-drive-{name}-{}-{}",
                std::process::id(),
                crate::store::now_ms()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir.canonicalize().unwrap())
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
        // An old file, so a copy that loses its date is caught.
        let old =
            SystemTime::UNIX_EPOCH + std::time::Duration::from_nanos(1_700_000_000_123_456_789);
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(old)
            .unwrap();
    }

    fn project_with(store: &Store, paths: &[&Path]) -> String {
        let live = store.create("p", Settings::default()).unwrap();
        let id = live.project.id.clone();
        store
            .update(&id, "test", |project| {
                for (index, path) in paths.iter().enumerate() {
                    project.media.push(
                        serde_json::from_value(json!({
                            "id": format!("m{index}"), "name": "m", "path": path,
                            "kind": "video", "duration": 10.0,
                        }))
                        .unwrap(),
                    );
                }
                Ok(())
            })
            .unwrap();
        id
    }

    fn paths_of(store: &Store, id: &str) -> Vec<String> {
        store
            .get(id)
            .unwrap()
            .project
            .media
            .iter()
            .map(|media| media.path.clone())
            .collect()
    }

    #[test]
    fn files_are_found_on_either_side_and_keep_their_cache_keys() {
        let scratch = Scratch::new("resolve");
        let home = scratch.0.join("home");
        let drive = scratch.0.join("drive");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&drive).unwrap();
        let drive = prepare(&home, &drive).unwrap();
        let mut layout = Layout::from_settings(&home, None);
        assert_eq!(layout.media, None);
        // Off: new media in the data folder, exactly as before.
        assert_eq!(layout.media_root().unwrap(), layout.home);
        assert_eq!(
            layout.key_path(Path::new("/a/b.mp4")),
            PathBuf::from("/a/b.mp4")
        );
        layout.media = Some(drive.clone());
        layout.known = vec![drive.clone()];
        assert_eq!(layout.media_root().unwrap(), drive);
        assert_eq!(layout.exports_dir(), drive.join("Exports"));

        let at_home = layout.home.join("media/drive/abc/clip.mp4");
        let on_drive = drive.join("media/drive/abc/clip.mp4");
        write(&at_home, b"footage");
        let key_before = crate::media::key_of(&layout.key_path(&at_home), &at_home);
        // Still at home: nothing to resolve.
        assert_eq!(layout.resolve(&at_home.to_string_lossy()), None);
        assert!(matches!(
            copy_checked(&at_home, &on_drive),
            Ok(Copied::Made(7))
        ));
        std::fs::remove_file(&at_home).unwrap();
        // A project naming the old place finds the copy, and its key is the same.
        assert_eq!(
            layout.resolve(&at_home.to_string_lossy()),
            Some(on_drive.to_string_lossy().into_owned())
        );
        assert_eq!(layout.key_path(&on_drive), at_home);
        assert_eq!(
            crate::media::key_of(&layout.key_path(&on_drive), &on_drive),
            key_before
        );
        // And back: a file named on the drive that's at home again.
        let uploaded = drive.join("uploads/p1/x.mp4");
        write(&layout.home.join("uploads/p1/x.mp4"), b"x");
        assert_eq!(
            layout.resolve(&uploaded.to_string_lossy()),
            Some(
                layout
                    .home
                    .join("uploads/p1/x.mp4")
                    .to_string_lossy()
                    .into_owned()
            )
        );
        // Missing on both sides, or not Edit's media: shown missing as before.
        assert_eq!(
            layout.resolve(&drive.join("media/gone.mp4").to_string_lossy()),
            None
        );
        assert_eq!(layout.resolve("/Users/someone/Movies/gone.mp4"), None);

        // The store opens a project that names the old place at the new one.
        save(&layout).unwrap();
        let store = Store::open(home.clone()).unwrap();
        let moved = drive.join("media/p9/b.mp4");
        write(&moved, b"b");
        let id = project_with(&store, &[&layout.home.join("media/p9/b.mp4")]);
        let reopened = Store::open(home.clone()).unwrap();
        assert_eq!(
            paths_of(&reopened, &id),
            vec![moved.to_string_lossy().into_owned()]
        );
        assert_eq!(
            reopened.uploads_dir(&id).unwrap(),
            drive.join("media").join(&id)
        );
    }

    #[test]
    fn an_unplugged_drive_is_never_written_to() {
        let scratch = Scratch::new("unplugged");
        let home = scratch.0.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let drive = scratch.0.join("drive");
        std::fs::create_dir_all(&drive).unwrap();
        let store = Store::open(home.clone()).unwrap();
        let drive = store
            .set_media_dir(Some(drive.as_path()))
            .unwrap()
            .media
            .unwrap();
        assert!(store.drive_dir().unwrap().starts_with(&drive));

        // Unplugged: the folder is gone (or its marker isn't there).
        std::fs::remove_file(drive.join(MARKER)).unwrap();
        let error = store.uploads_dir("p1").unwrap_err();
        assert!(error.contains("isn't connected"), "{error}");
        assert!(store.drive_dir().is_err());
        assert!(store
            .layout()
            .writable(&drive.join("Exports/a.mp4"))
            .is_err());
        assert!(store
            .layout()
            .writable(Path::new("/elsewhere/a.mp4"))
            .is_ok());
        assert!(!store.layout().home.join("media").exists());
        // The setting survives a restart, still refusing.
        let reopened = Store::open(home.clone()).unwrap();
        assert_eq!(reopened.layout().media.as_deref(), Some(drive.as_path()));
        assert!(reopened.uploads_dir("p1").is_err());
        assert_eq!(status(&reopened.layout())["state"], "offline");

        // A /Volumes/<drive> folder left on the internal disk isn't the drive,
        // even with Edit's folder and marker in it.
        let volumes = scratch.0.join("Volumes");
        let stub = volumes.join("External").join("Edit");
        std::fs::create_dir_all(&stub).unwrap();
        std::fs::write(stub.join(MARKER), "{}").unwrap();
        let error = check_under(&stub, &volumes).unwrap_err();
        assert!(error.contains("isn't mounted"), "{error}");
        // Plugged in again (here: a folder that's no mount point needs only its marker).
        std::fs::write(drive.join(MARKER), "{}").unwrap();
        assert_eq!(reopened.uploads_dir("p1").unwrap(), drive.join("media/p1"));
        // Turned off: the data folder again.
        reopened.set_media_dir(None).unwrap();
        assert_eq!(
            reopened.uploads_dir("p1").unwrap(),
            reopened.layout().home.join("media/p1")
        );
        assert!(prepare(&home, Path::new("relative/dir")).is_err());
        assert!(prepare(&home, &home.join("media")).is_err());
        assert!(prepare(&home, &scratch.0.join("no/such/parent")).is_err());
    }

    #[test]
    fn a_move_survives_interruption_and_never_loses_a_file() {
        let scratch = Scratch::new("move");
        let home = scratch.0.join("home");
        let target = scratch.0.join("drive");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        let store = Store::open(home.clone()).unwrap();
        let home = store.layout().home;
        let files = [
            home.join("media/drive/f1/excerpts/a.mp4"),
            home.join("media/drive/f1/.done"),
            home.join("media/p1/upload.mov"),
            home.join("media/p1/stills/s.png"),
            home.join("uploads/p1/source-footage/b.mp4"),
            home.join("uploads/p1/source-footage/c.mp4"),
        ];
        for (index, file) in files.iter().enumerate() {
            write(file, format!("file {index}").repeat(index + 1).as_bytes());
        }
        let refs: Vec<&Path> = files.iter().map(PathBuf::as_path).collect();
        let id = project_with(&store, &refs);
        let keys: Vec<String> = files
            .iter()
            .map(|file| crate::media::key_of(file, file))
            .collect();
        let mut lines = Vec::new();
        let mut say = |line: String| lines.push(line);

        // A dry run touches nothing.
        let report = move_media(&store, &target, true, &mut say).unwrap();
        assert_eq!(report.files, files.len());
        assert!(files.iter().all(|file| file.is_file()));
        assert!(store.layout().media.is_none());

        // Interrupted after two copies: nothing removed, the project untouched.
        assert!(move_until(&store, &target, false, Some(2), &mut say).is_err());
        let drive = store.layout().media.unwrap();
        assert!(files.iter().all(|file| file.is_file()));
        assert_eq!(
            paths_of(&store, &id),
            files
                .iter()
                .map(|f| f.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        );
        // ...and one copy cut off mid-way, and one file already on the drive but different.
        let half = drive.join("media/p1/upload.mov.edit-moving");
        std::fs::create_dir_all(half.parent().unwrap()).unwrap();
        std::fs::write(&half, b"half").unwrap();
        let clash = drive.join("uploads/p1/source-footage/c.mp4");
        std::fs::create_dir_all(clash.parent().unwrap()).unwrap();
        std::fs::write(&clash, b"someone else's").unwrap();

        let report = move_media(&store, &target, false, &mut say).unwrap();
        assert_eq!(report.already, 2);
        assert_eq!(report.copied, 3);
        assert_eq!(report.removed, 5);
        assert_eq!(report.projects, 1);
        assert_eq!(report.problems.len(), 1, "{:?}", report.problems);
        assert!(!half.exists());
        // The clash: both kept, the project still on the original.
        assert!(files[5].is_file());
        assert_eq!(std::fs::read(&clash).unwrap(), b"someone else's");
        let now = paths_of(&store, &id);
        for (index, file) in files.iter().enumerate() {
            let moved = drive.join(file.strip_prefix(&home).unwrap());
            if index == 5 {
                assert_eq!(now[index], file.to_string_lossy());
                continue;
            }
            assert!(!file.exists(), "{}", file.display());
            assert_eq!(now[index], moved.to_string_lossy());
            assert_eq!(
                std::fs::read(&moved).unwrap(),
                format!("file {index}").repeat(index + 1).as_bytes()
            );
            // Same size and time, named by its old place: the same cache key.
            assert_eq!(
                crate::media::key_of(&store.layout().key_path(&moved), &moved),
                keys[index]
            );
        }
        // Empty folders gone, the ones still holding something kept.
        assert!(!home.join("media/p1").exists());
        assert!(home.join("uploads/p1/source-footage").is_dir());

        // Once the clash is cleared, running it again finishes the job.
        std::fs::remove_file(&clash).unwrap();
        let report = move_media(&store, &target, false, &mut say).unwrap();
        assert_eq!((report.copied, report.removed, report.projects), (1, 1, 1));
        assert!(report.problems.is_empty());
        assert!(!home.join("uploads/p1").exists());
        let report = move_media(&store, &target, false, &mut say).unwrap();
        assert_eq!((report.files, report.copied, report.removed), (0, 0, 0));
        // History and deleted projects naming the old places still find their files.
        let reopened = Store::open(home.clone()).unwrap();
        let mut old = reopened.get(&id).unwrap().project;
        old.media[0].path = files[0].to_string_lossy().into_owned();
        reopened.layout().resolve_project(&mut old);
        assert_eq!(
            old.media[0].path,
            drive
                .join("media/drive/f1/excerpts/a.mp4")
                .to_string_lossy()
        );
    }
}
