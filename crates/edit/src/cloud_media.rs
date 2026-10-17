//! Footage of cloud projects: originals and proxies on R2 (`crate::cloud`),
//! only the small proxies on this machine. A media's `cloud` says where its
//! files are; its `path` is this machine's copy of the proxy.
//!
//! Cloud mode is on when `cloud::enabled()` (EDIT_RELAY_TOKEN is set);
//! without it nothing here runs and media work as before.
//!
//! **Sources** (the keys of Convex's footage registry, `edit:getMedia` /
//! `putMedia`, one record per thing on R2, shared by every project and
//! machine, so nothing is uploaded or encoded twice):
//! - `drive:<file id>` — a Google Drive file, whole.
//! - `drive:<file id>#<start ms>-<end ms>` — an excerpt of one (a script
//!   uses minutes of hours of footage): `start` is the keyframe it begins on,
//!   both in whole milliseconds of the Drive file.
//! - `sha256:<hex>` — a file from a disk (added files, browser uploads,
//!   voice-over takes, library sounds, stills), by its content.
//!
//! **R2 keys** (all under `edit/`):
//! - `edit/originals/drive/<file id>/<name>` and `edit/originals/sha256/<hex>/<name>`:
//!   full-quality originals, as they came.
//! - `edit/excerpts/drive/<file id>/<start ms>-<end ms>.<ext>`: full-quality
//!   excerpts (picture copied, sound AAC 192k: what `script::cut` makes).
//! - `edit/proxies/drive/<file id>.mp4`, `edit/proxies/drive/<file id>/<start ms>-<end ms>.mp4`,
//!   `edit/proxies/sha256/<hex>.mp4`: proxies (`media::make_cloud_proxy`:
//!   ≤1080p H.264 at 4 Mbit/s with half-second keyframes, no B-frames, BT.709,
//!   AAC 160k stereo; ~31 MB a minute). The proxy is also the media's preview
//!   (linked, not encoded again) and what transcription, the watcher, frame
//!   grabs and the agent's looks read.
//!
//! Sounds and pictures (no proxy needed: they're small) keep their own file
//! as `path`, and their `proxy` is the original's key.
//!
//! This machine's copy of a key is `<cache>/cloud/<key without edit/>`
//! ([`local_path`]), so another machine finds (or fetches) the same file in its
//! own cache: [`ensure_local`]. Exports read the originals ([`for_export`]).
//! Scratch files (an excerpt between cutting and uploading) live in
//! `<cache>/cloud/tmp` and are removed when done or failed.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use edit_core::{ClipContent, CloudMedia, MediaKind, Project};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::cloud::{self, Method};
use crate::media::Probe;
use crate::script::Excerpt;
use crate::server::App;

const HOUR: Duration = Duration::from_secs(3600);
/// Free space an export leaves on the disk when it downloads originals;
/// past that it reads the rest straight from R2.
/// Proxies fetched at once.
const PARALLEL: usize = 3;

/// One media to add: its file here, its name, what it is, where it is on R2.
#[derive(Clone, Debug)]
pub struct Made {
    pub path: PathBuf,
    pub name: String,
    pub probe: Probe,
    pub cloud: Option<CloudMedia>,
}

// ---------------------------------------------------------------------------
// The footage registry (Convex, `edit:` functions through the relay).

/// A registry record (`edit:getMedia`).
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Record {
    pub source: String,
    pub name: String,
    pub original_key: String,
    pub original_ready: bool,
    pub proxy_key: Option<String>,
    pub proxy_ready: bool,
    pub size: f64,
    pub duration: Option<f64>,
}

impl Record {
    fn ready_proxy(&self) -> Option<&str> {
        self.proxy_key
            .as_deref()
            .filter(|key| self.proxy_ready && cloud::valid_key(key))
    }
    fn ready_original(&self) -> Option<&str> {
        Some(self.original_key.as_str()).filter(|key| self.original_ready && cloud::valid_key(key))
    }
}

pub fn get_record(source: &str) -> Result<Option<Record>, String> {
    let value = cloud::query("edit:getMedia", json!({ "source": source }))?;
    if value.is_null() {
        return Ok(None);
    }
    serde_json::from_value(value)
        .map(Some)
        .map_err(|error| format!("the footage registry answered oddly: {error}"))
}

pub fn list_records(sources: &[String]) -> Result<Vec<Record>, String> {
    let value = cloud::query("edit:listMedia", json!({ "sources": sources }))?;
    Ok(value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|record| !record.is_null())
        .filter_map(|record| serde_json::from_value(record.clone()).ok())
        .collect())
}

/// Upserts a record by `fields.source` (a new one needs name, originalKey, size).
fn put_record(fields: Value) -> Result<(), String> {
    cloud::mutation("edit:putMedia", fields).map(|_| ())
}

#[cfg(test)]
pub fn delete_record(source: &str) -> Result<(), String> {
    cloud::mutation("edit:deleteMedia", json!({ "source": source })).map(|_| ())
}

// ---------------------------------------------------------------------------
// Sources, keys and local copies.

fn drive_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn millis(seconds: f64) -> u64 {
    (seconds * 1000.0).round().max(0.0) as u64
}

pub fn excerpt_source(file: &str, start: f64, end: f64) -> String {
    format!("drive:{file}#{}-{}", millis(start), millis(end))
}

/// The proxy's key for a source (see the module's notes).
pub fn proxy_key(source: &str) -> Option<String> {
    let key = if let Some(drive) = source.strip_prefix("drive:") {
        match drive.split_once('#') {
            Some((file, span)) => format!("edit/proxies/drive/{file}/{span}.mp4"),
            None => format!("edit/proxies/drive/{drive}.mp4"),
        }
    } else {
        let hex = source.strip_prefix("sha256:")?;
        format!("edit/proxies/sha256/{hex}.mp4")
    };
    cloud::valid_key(&key).then_some(key)
}

/// A file name fit for a key's last segment (and a file here).
fn segment(name: &str) -> String {
    let cleaned: String = crate::script::safe_name(name)
        .chars()
        .filter(|c| !c.is_control() && *c != '\\' && *c != '/')
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.chars().count() <= 120 {
        return cleaned.to_owned();
    }
    // Long names keep their extension.
    let path = Path::new(cleaned);
    let extension = path
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy()))
        .filter(|ext| ext.len() <= 10)
        .unwrap_or_default();
    let stem: String = cleaned.chars().take(110).collect();
    format!("{}{extension}", stem.trim())
}

/// A file extension fit for a key: letters and digits, else mp4.
fn extension_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .filter(|ext| {
            !ext.is_empty() && ext.len() <= 8 && ext.chars().all(|c| c.is_ascii_alphanumeric())
        })
        .unwrap_or_else(|| "mp4".to_owned())
}

/// This machine's copy of `key`: `<cache>/cloud/<key without edit/>`.
pub fn local_path(cache: &Path, key: &str) -> PathBuf {
    cache
        .join("cloud")
        .join(key.strip_prefix("edit/").unwrap_or(key))
}

/// Whether `path` is one of this machine's copies of cloud files (a proxy,
/// which then is a preview already).
pub fn is_local_copy(cache: &Path, path: &Path) -> bool {
    path.starts_with(cache.join("cloud"))
        || cache
            .canonicalize()
            .is_ok_and(|cache| path.starts_with(cache.join("cloud")))
}

/// `<cache>/cloud/tmp`, for files on their way up; anything left there by a
/// run that died over half a day ago is removed.
pub fn scratch_dir(cache: &Path) -> Result<PathBuf, String> {
    let dir = cache.join("cloud").join("tmp");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > 12 * HOUR);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(dir)
}

/// A scratch file, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new(dir: &Path, extension: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        Self(dir.join(format!(
            "{}-{}-{}.{extension}",
            std::process::id(),
            crate::store::now_ms(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// `text` with every URL replaced: presigned URLs are credentials, never
/// shown or logged.
pub fn scrub(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = ["https://", "http://"]
        .iter()
        .filter_map(|scheme| rest.find(scheme))
        .min()
    {
        let Some((before, tail)) = rest.split_at_checked(at) else {
            break;
        };
        out.push_str(before);
        out.push_str("<url>");
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, '\'' | '"' | '<' | '>'))
            .unwrap_or(tail.len());
        rest = tail.split_at_checked(end).map_or("", |(_, after)| after);
    }
    out.push_str(rest);
    out
}

fn get_url(key: &str, lasting: Duration) -> Result<String, String> {
    cloud::presign(key, Method::Get, Some(lasting))
}

/// Probes the object at a presigned URL.
fn probe_url(url: &str) -> Result<Probe, String> {
    crate::media::probe(Path::new(url)).map_err(|error| scrub(&error))
}

/// Downloads `key` to `local` unless it's there already. One download per
/// file at a time (two would write the same partial file); a second ask waits
/// for the first and finds the file.
fn fetch(key: &str, local: &Path) -> Result<(), String> {
    use std::sync::Weak;
    static FETCHING: LazyLock<parking_lot::Mutex<HashMap<PathBuf, Weak<parking_lot::Mutex<()>>>>> =
        LazyLock::new(Default::default);
    let lock = {
        let mut fetching = FETCHING.lock();
        fetching.retain(|_, lock| lock.strong_count() > 0);
        let lock = fetching
            .get(local)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| Arc::new(parking_lot::Mutex::new(())));
        fetching.insert(local.to_path_buf(), Arc::downgrade(&lock));
        lock
    };
    let _held = lock.lock();
    if local.is_file() {
        return Ok(());
    }
    cloud::download(key, local, &|_, _| {})
}

fn canonical(path: PathBuf) -> PathBuf {
    path.canonicalize().unwrap_or(path)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::Digest;
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = sha2::Sha256::new();
    let mut buffer = vec![0; 1 << 20];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(buffer.get(..read).unwrap_or_default());
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// Uploads a local original (unless it's up already) while its proxy is made
/// at `local` (unless it's here already), then uploads the proxy, recording
/// each in the registry as it's done. A proxy made here is removed again when
/// anything fails, so a failure leaves nothing behind.
#[allow(clippy::too_many_arguments)]
fn publish(
    file: &Path,
    probe: &Probe,
    source: &str,
    original_key: &str,
    upload_original: bool,
    proxy_key: &str,
    local: &Path,
) -> Result<(), String> {
    let make_here = !local.is_file();
    let (sent, proxied) = std::thread::scope(|scope| {
        let upload = scope.spawn(|| {
            if upload_original {
                cloud::upload_file(file, original_key, &|_, _| {})
            } else {
                Ok(())
            }
        });
        let proxied = if make_here {
            crate::diag::time_on("cloud", "cloud: make proxy", source, || {
                crate::media::make_cloud_proxy(file, probe, local)
            })
        } else {
            Ok(())
        };
        let sent = upload
            .join()
            .unwrap_or_else(|_| Err("the upload crashed".to_owned()));
        (sent, proxied)
    });
    let result = (|| {
        sent?;
        if upload_original {
            let size = std::fs::metadata(file).map_or(0, |meta| meta.len());
            put_record(json!({
                "source": source,
                "originalReady": true,
                "size": size,
                "duration": probe.duration,
            }))?;
        }
        proxied?;
        cloud::upload_file(local, proxy_key, &|_, _| {})?;
        put_record(json!({ "source": source, "proxyKey": proxy_key, "proxyReady": true }))
    })();
    if result.is_err() && make_here {
        let _ = std::fs::remove_file(local);
    }
    result
}

// ---------------------------------------------------------------------------
// Files from a disk (`server::import_paths`).

/// Puts a file from this machine in the cloud (deduplicated by content) and
/// returns the media to add: footage as its proxy (made here, or fetched when
/// the cloud has it already), a sound or picture as the file itself. The file
/// is never changed or removed.
pub fn import_local(cache: &Path, path: &Path, probe: &Probe, name: &str) -> Result<Made, String> {
    put_local(cache, path, probe, name, probe.kind != MediaKind::Video)
}

/// `import_local`; `own`: the file goes up as it is and is its own proxy
/// (sounds, pictures, short renders Edit made), else it gets a proxy.
fn put_local(
    cache: &Path,
    path: &Path,
    probe: &Probe,
    name: &str,
    own: bool,
) -> Result<Made, String> {
    let hex = sha256_file(path)?;
    let source = format!("sha256:{hex}");
    let size = std::fs::metadata(path).map_or(0, |meta| meta.len());
    let record = get_record(&source)?;
    let original_key = record
        .as_ref()
        .map(|record| record.original_key.clone())
        .filter(|key| cloud::valid_key(key))
        .unwrap_or_else(|| format!("edit/originals/sha256/{hex}/{}", segment(name)));
    if record.is_none() {
        put_record(json!({
            "source": source,
            "name": name,
            "originalKey": original_key,
            "size": size,
        }))?;
    }
    let need_original = record.as_ref().and_then(Record::ready_original).is_none();
    if own {
        if need_original {
            cloud::upload_file(path, &original_key, &|_, _| {})?;
        }
        if need_original || record.as_ref().and_then(Record::ready_proxy).is_none() {
            put_record(json!({
                "source": source,
                "originalReady": true,
                "proxyKey": original_key,
                "proxyReady": true,
                "duration": probe.duration,
            }))?;
        }
        return Ok(Made {
            path: path.to_path_buf(),
            name: name.to_owned(),
            probe: probe.clone(),
            cloud: Some(CloudMedia {
                source,
                original: original_key.clone(),
                proxy: Some(original_key),
                size,
            }),
        });
    }
    let ready_proxy = record
        .as_ref()
        .and_then(Record::ready_proxy)
        .map(str::to_owned);
    let proxy = match &ready_proxy {
        Some(key) => key.clone(),
        None => proxy_key(&source).ok_or("no proxy key")?,
    };
    let local = local_path(cache, &proxy);
    if ready_proxy.is_some() {
        if need_original {
            cloud::upload_file(path, &original_key, &|_, _| {})?;
            put_record(json!({ "source": source, "originalReady": true, "size": size }))?;
        }
        fetch(&proxy, &local)?;
    } else {
        publish(
            path,
            probe,
            &source,
            &original_key,
            need_original,
            &proxy,
            &local,
        )?;
    }
    Ok(Made {
        path: canonical(local),
        name: name.to_owned(),
        probe: probe.clone(),
        cloud: Some(CloudMedia {
            source,
            original: original_key,
            proxy: Some(proxy),
            size,
        }),
    })
}

// ---------------------------------------------------------------------------
// Google Drive footage (`script::start` in cloud mode).

/// A Drive file on R2.
#[derive(Clone, Debug)]
pub struct Original {
    pub file: String,
    pub source: String,
    pub key: String,
    pub name: String,
    pub size: u64,
}

/// Puts Drive file `file` on R2, streamed from Drive straight into the upload
/// (no copy on this disk), unless the registry has it already.
/// `progress(bytes, total, name)` as it goes.
pub fn drive_original(
    file: &str,
    scratch: &Path,
    progress: &(dyn Fn(u64, Option<u64>, &str) + Sync),
) -> Result<Original, String> {
    if !drive_id_ok(file) {
        return Err(format!("{file:?} isn't a Drive file id"));
    }
    let source = format!("drive:{file}");
    let record = get_record(&source)?;
    if let Some(record) = &record {
        if let Some(key) = record.ready_original() {
            let size = record.size as u64;
            progress(size, Some(size), &record.name);
            return Ok(Original {
                file: file.to_owned(),
                source,
                key: key.to_owned(),
                name: record.name.clone(),
                size,
            });
        }
    }
    let (url, head) = crate::script::resolve(file, &scratch.join(format!(".probe-{file}")))?;
    let name = crate::script::safe_name(head.name.as_deref().unwrap_or(&format!("{file}.mp4")));
    let key = record
        .as_ref()
        .map(|record| record.original_key.clone())
        .filter(|key| cloud::valid_key(key))
        .unwrap_or_else(|| format!("edit/originals/drive/{file}/{}", segment(&name)));
    if record.is_none() {
        put_record(json!({
            "source": source,
            "name": name,
            "originalKey": key,
            "size": head.total.unwrap_or(0),
        }))?;
    }
    progress(0, head.total, &name);
    let size = stream_drive(&url, &key, head.total, &|sent| {
        progress(sent, head.total, &name)
    })?;
    let duration = get_url(&key, HOUR)
        .ok()
        .and_then(|url| crate::script::duration_of(Path::new(&url)).ok());
    let mut done = json!({ "source": source, "originalReady": true, "size": size });
    if let (Some(fields), Some(duration)) = (done.as_object_mut(), duration) {
        fields.insert("duration".to_owned(), json!(duration));
    }
    put_record(done)?;
    Ok(Original {
        file: file.to_owned(),
        source,
        key,
        name,
        size,
    })
}

/// curl's download as a reader: an early end (curl failed) is an error, so a
/// cut-off download never completes an upload.
struct CurlReader {
    child: Child,
    stdout: ChildStdout,
    stderr: Option<ChildStderr>,
    finished: bool,
}

impl Read for CurlReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let read = self.stdout.read(buf)?;
        if read == 0 && !buf.is_empty() && !self.finished {
            self.finished = true;
            let status = self.child.wait()?;
            if !status.success() {
                let mut detail = String::new();
                if let Some(stderr) = self.stderr.as_mut() {
                    let _ = stderr.read_to_string(&mut detail);
                }
                return Err(std::io::Error::other(format!(
                    "the Drive download stopped ({})",
                    scrub(detail.trim().trim_start_matches("curl: "))
                )));
            }
        }
        Ok(read)
    }
}

impl Drop for CurlReader {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// Streams `url` (Drive) into R2 at `key`; the bytes stored. A short or failed
/// download aborts the upload (nothing is stored).
fn stream_drive(
    url: &str,
    key: &str,
    total: Option<u64>,
    progress: &(dyn Fn(u64) + Sync),
) -> Result<u64, String> {
    let mut child = Command::new("curl")
        .args([
            "-sS",
            "-L",
            "--fail",
            "--proto",
            crate::endpoints::google_proto(),
            "--proto-redir",
            crate::endpoints::google_proto(),
            "--connect-timeout",
            "20",
            "--speed-limit",
            "1024",
            "--speed-time",
            "60",
        ])
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("curl: {error}"))?;
    let stdout = child.stdout.take().ok_or("curl gave no output")?;
    let stderr = child.stderr.take();
    let mut reader = CurlReader {
        child,
        stdout,
        stderr,
        finished: false,
    };
    let sent = cloud::upload_stream(&mut reader, key, total, &|sent, _| progress(sent))?;
    drop(reader);
    if total.is_some_and(|total| total != sent) {
        let _ = cloud::delete(&[key.to_owned()]);
        return Err("The download ended early. Retry to start it again.".into());
    }
    Ok(sent)
}

/// The media a script plays from Drive file `original`: an excerpt per span
/// the `ranges` need (cut from R2 through a presigned URL, so only those bytes
/// are fetched), or the whole file when it's mostly used, as `script::excerpts`
/// does on a disk. Each is on R2 at full quality with its proxy; only the
/// proxies are kept here.
pub fn drive_excerpts(
    cache: &Path,
    original: &Original,
    ranges: &[(f64, f64)],
) -> Result<Vec<Excerpt>, String> {
    let url = get_url(&original.key, 6 * HOUR)?;
    let source = Path::new(&url);
    // Read here even when the registry knows it: a URL FFmpeg can't read would
    // otherwise only show as keyframes not found (excerpts from the start).
    let duration = crate::script::duration_of(source)?;
    let spans = crate::script::spans(ranges, duration);
    let used: f64 = spans.iter().map(|(from, to)| to - from).sum();
    if spans.is_empty() || used >= duration * 0.6 {
        let made = whole_media(cache, original, &url)?;
        return Ok(vec![Excerpt {
            path: made.path.clone(),
            from: 0.0,
            to: duration,
            cloud: Some(made),
        }]);
    }
    let stem: String = Path::new(&original.name)
        .file_stem()
        .map_or_else(
            || "footage".into(),
            |stem| stem.to_string_lossy().to_string(),
        )
        .chars()
        .take(40)
        .collect();
    let extension = extension_of(&original.name);
    let mut out = Vec::new();
    for (from, to) in spans {
        let start = crate::script::keyframe_before(source, from);
        let made = excerpt_media(cache, original, source, (start, to), &stem, &extension)?;
        out.push(Excerpt {
            path: made.path.clone(),
            from: start,
            to,
            cloud: Some(made),
        });
    }
    Ok(out)
}

/// The whole Drive file as one media: its proxy made straight from R2.
fn whole_media(cache: &Path, original: &Original, url: &str) -> Result<Made, String> {
    let probe = probe_url(url)?;
    let record = get_record(&original.source)?;
    let ready = record
        .as_ref()
        .and_then(Record::ready_proxy)
        .map(str::to_owned);
    let proxy = match &ready {
        Some(key) => key.clone(),
        None => proxy_key(&original.source).ok_or("no proxy key")?,
    };
    let local = local_path(cache, &proxy);
    match &ready {
        Some(_) => fetch(&proxy, &local)?,
        None => {
            let made_here = !local.is_file();
            let result = (|| {
                if made_here {
                    crate::diag::time_on("cloud", "cloud: make proxy", &original.source, || {
                        crate::media::make_cloud_proxy(Path::new(url), &probe, &local)
                    })?;
                }
                cloud::upload_file(&local, &proxy, &|_, _| {})?;
                put_record(
                    json!({ "source": original.source, "proxyKey": proxy, "proxyReady": true }),
                )
            })();
            if result.is_err() && made_here {
                let _ = std::fs::remove_file(&local);
            }
            result?;
        }
    }
    Ok(Made {
        path: canonical(local),
        name: original.name.clone(),
        probe,
        cloud: Some(CloudMedia {
            source: original.source.clone(),
            original: original.key.clone(),
            proxy: Some(proxy),
            size: original.size,
        }),
    })
}

/// One excerpt (`start`..`end` seconds of the Drive file) as media: reused
/// when the registry has it, else cut into a scratch file, uploaded with its
/// proxy, and the scratch file removed.
fn excerpt_media(
    cache: &Path,
    original: &Original,
    url: &Path,
    (start, end): (f64, f64),
    stem: &str,
    extension: &str,
) -> Result<Made, String> {
    let source = excerpt_source(&original.file, start, end);
    let name = format!(
        "{stem} {}-{}.{extension}",
        crate::script::clock(start),
        crate::script::clock(end)
    );
    let record = get_record(&source)?;
    if let Some(record) = &record {
        if let (Some(key), Some(proxy)) = (record.ready_original(), record.ready_proxy()) {
            // Its full-quality file says what the media is (the proxy is smaller).
            let probe = probe_url(&get_url(key, HOUR)?)?;
            let local = local_path(cache, proxy);
            fetch(proxy, &local)?;
            return Ok(Made {
                path: canonical(local),
                name: record.name.clone(),
                probe,
                cloud: Some(CloudMedia {
                    source,
                    original: key.to_owned(),
                    proxy: Some(proxy.to_owned()),
                    size: record.size as u64,
                }),
            });
        }
    }
    let key = format!(
        "edit/excerpts/drive/{}/{}-{}.{extension}",
        original.file,
        millis(start),
        millis(end)
    );
    let proxy = proxy_key(&source).ok_or("no proxy key")?;
    let local = local_path(cache, &proxy);
    let scratch = Scratch::new(&scratch_dir(cache)?, extension);
    crate::diag::time_on("cloud", "cloud: cut excerpt", &source, || {
        crate::script::cut(url, start, end, &scratch.0)
    })?;
    let probe = crate::media::probe(&scratch.0)?;
    let size = std::fs::metadata(&scratch.0).map_or(0, |meta| meta.len());
    put_record(json!({
        "source": source,
        "name": name,
        "originalKey": key,
        "size": size,
    }))?;
    publish(&scratch.0, &probe, &source, &key, true, &proxy, &local)?;
    drop(scratch);
    Ok(Made {
        path: canonical(local),
        name,
        probe,
        cloud: Some(CloudMedia {
            source,
            original: key,
            proxy: Some(proxy),
            size,
        }),
    })
}

// ---------------------------------------------------------------------------
// Opening a cloud project here.

/// Makes every cloud media of project `id` playable here: fetches proxies this
/// machine doesn't have yet and points their `path` at them. Called when a
/// cloud project is opened (it may have been edited on another machine).
/// Media whose file is here are left alone; a proxy already in this machine's
/// cache isn't fetched again. The analysis other machines shared comes too
/// (`fetch_analysis`). Media that are neither here nor in the cloud (made on
/// a machine that hasn't backfilled them yet) are named in the error and in
/// the project's cloud status (`missing`), never silently left out.
pub async fn ensure_local(app: &App, id: &str) -> Result<(), String> {
    let fetched = fetch_proxies(app, id).await;
    fetch_analysis(app, id).await;
    let stranded = app
        .store
        .get(id)
        .map(|live| stranded(&live.project))
        .unwrap_or_default();
    let missing = (!stranded.is_empty()).then(|| {
        format!(
            "{} {} on this machine and not in the cloud ({}): open the project on the machine that made {} so {} upload{}",
            stranded.len(),
            if stranded.len() == 1 { "file isn't" } else { "files aren't" },
            stranded.join(", "),
            if stranded.len() == 1 { "it" } else { "them" },
            if stranded.len() == 1 { "it" } else { "they" },
            if stranded.len() == 1 { "s" } else { "" },
        )
    });
    if let Some(cloud) = app.store.cloud() {
        cloud.set_missing(&app.store, id, missing.clone());
    }
    match (fetched, missing) {
        (Ok(()), None) => Ok(()),
        (Ok(()), Some(missing)) => {
            crate::diag::warn("cloud", format!("{id}: {missing}"));
            Err(missing)
        }
        (Err(error), None) => Err(error),
        (Err(error), Some(missing)) => {
            crate::diag::warn("cloud", format!("{id}: {missing}"));
            Err(format!("{error}; {missing}"))
        }
    }
}

/// Fetches the proxies of `id`'s cloud media that aren't here (`ensure_local`).
async fn fetch_proxies(app: &App, id: &str) -> Result<(), String> {
    let live = app.store.get(id).ok_or("no such project")?;
    let cache = app.store.cache_dir();
    // Media whose file isn't here: (media id, name, source, proxy key if known).
    let missing: Vec<(String, String, String, Option<String>)> = live
        .project
        .media
        .iter()
        .filter(|media| !Path::new(&media.path).is_file())
        .filter_map(|media| {
            let cloud = media.cloud.as_ref()?;
            Some((
                media.id.clone(),
                media.name.clone(),
                cloud.source.clone(),
                cloud.proxy.clone(),
            ))
        })
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    let enabled = cloud::enabled();
    let (jobs, unready) = tokio::task::spawn_blocking(move || {
        // A proxy another machine finished after this project was saved.
        let unknown: Vec<String> = missing
            .iter()
            .filter(|(_, _, _, proxy)| proxy.is_none())
            .map(|(_, _, source, _)| source.clone())
            .collect();
        let records = if enabled && !unknown.is_empty() {
            list_records(&unknown).unwrap_or_else(|error| {
                crate::diag::warn("cloud", format!("listing proxies: {error}"));
                Vec::new()
            })
        } else {
            Vec::new()
        };
        // A media whose upload another machine hasn't finished has no proxy yet.
        let mut unready = Vec::new();
        let jobs: Vec<(String, String, PathBuf)> = missing
            .into_iter()
            .filter_map(|(media, name, source, proxy)| {
                let key = proxy
                    .or_else(|| {
                        records
                            .iter()
                            .find(|record| record.source == source)
                            .and_then(Record::ready_proxy)
                            .map(str::to_owned)
                    })
                    .filter(|key| cloud::valid_key(key));
                let Some(key) = key else {
                    unready.push(name);
                    return None;
                };
                let local = local_path(&cache, &key);
                Some((media, key, local))
            })
            .collect();
        // Three at a time; the ones already in this machine's cache cost nothing.
        let results: Vec<Result<(String, String, PathBuf), String>> = jobs
            .chunks(PARALLEL)
            .flat_map(|batch| {
                std::thread::scope(|scope| {
                    let running: Vec<_> = batch
                        .iter()
                        .map(|(media, key, local)| {
                            scope.spawn(move || {
                                if !local.is_file() && !enabled {
                                    return Err(format!(
                                        "{key} isn't on this machine and the cloud isn't set up (EDIT_RELAY_TOKEN)"
                                    ));
                                }
                                crate::diag::time_on("cloud", "cloud: fetch proxy", key, || {
                                    fetch(key, local)
                                })
                                .map(|()| (media.clone(), key.clone(), canonical(local.clone())))
                            })
                        })
                        .collect();
                    running
                        .into_iter()
                        .map(|job| {
                            job.join()
                                .unwrap_or_else(|_| Err("fetching a proxy crashed".to_owned()))
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        (results, unready)
    })
    .await
    .map_err(|error| error.to_string())?;
    let mut errors = Vec::new();
    if !unready.is_empty() {
        errors.push(format!(
            "still uploading from another machine: {}",
            unready.join(", ")
        ));
    }
    let mut found = Vec::new();
    for result in jobs {
        match result {
            Ok(job) => found.push(job),
            Err(error) => errors.push(error),
        }
    }
    if !found.is_empty() {
        let repoint = |project: &mut Project| {
            for (media_id, key, local) in &found {
                if let Some(media) = project.media.iter_mut().find(|media| media.id == *media_id) {
                    if let Some(cloud) = media.cloud.as_mut() {
                        media.path = local.to_string_lossy().into_owned();
                        cloud.proxy = Some(key.clone());
                    }
                }
            }
        };
        // One change (one undo step, one event), retried if another writer
        // lands in between.
        let mut tries = 0;
        let live = loop {
            tries += 1;
            let result = app.store.update(id, "cloud", |project| {
                repoint(project);
                Ok(())
            });
            match result {
                Ok((live, ())) => break live,
                Err(error) if tries < 3 && error.contains("retry") => continue,
                Err(error) => {
                    // A cloud project another machine is editing is read-only
                    // here, but where its files are on this machine is this
                    // machine's business: saved here only, as a pull is (the
                    // next pull brings the other machine's paths, and this
                    // runs again).
                    let mut project = app.store.get(id).ok_or("no such project")?.project;
                    repoint(&mut project);
                    match app.store.put_from_cloud(project, "cloud") {
                        Ok(live) => break live,
                        Err(local) => return Err(format!("{error}; {local}")),
                    }
                }
            }
        };
        // Previews, thumbnails and waveforms for the files now here.
        for (media_id, _, _) in &found {
            if let Some(media) = live.project.media(media_id) {
                app.media
                    .ensure(PathBuf::from(&media.path), probe_of(media));
            }
        }
    }
    if !errors.is_empty() {
        crate::diag::warn("cloud", format!("{id}: {}", errors.join("; ")));
        return Err(format!(
            "some of the project's files couldn't be fetched: {}",
            errors.join("; ")
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Exports read the originals.

/// What an export made on the side (waveform levels for its originals); removed when dropped.
#[derive(Default)]
pub struct Originals {
    dirs: Vec<PathBuf>,
}

impl Drop for Originals {
    fn drop(&mut self) {
        for dir in &self.dirs {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// The media frames `start..end` of `project` use (pictures, sounds and the
/// waveforms drawn from them).
fn used_media(project: &Project, start: i64, end: i64) -> Vec<String> {
    let mut used = Vec::new();
    for clip in &project.clips {
        if clip.start >= end || clip.start + clip.duration <= start {
            continue;
        }
        let media = match &clip.content {
            ClipContent::Video { media, .. } | ClipContent::Audio { media, .. } => Some(media),
            ClipContent::Waveform { media, .. } => media.as_ref(),
            _ => None,
        };
        if let Some(media) = media {
            if !used.contains(media) {
                used.push(media.clone());
            }
        }
    }
    used
}

/// `project` as an export of frames `start..end` reads it: every cloud media
/// it uses points at its full-quality original on R2 instead of the proxy, as
/// a presigned URL. Nothing big is downloaded: FFmpeg reads just the byte
/// ranges it needs (decoding on the Mac's media engine) and hands the frames to
/// the native renderer and encoder. Sounds and pictures whose own file is here
/// are used as they are.
pub fn for_export(
    project: &Project,
    start: i64,
    end: i64,
    cache: &Path,
) -> Result<(Project, Originals), String> {
    let mut out = project.clone();
    let mut originals = Originals::default();
    let mut needed: Vec<(String, String, u64)> = Vec::new();
    // In an edit with cloud media, one that's neither here nor in the cloud
    // was made on another machine that hasn't uploaded it: say so.
    let cloud_edit = project.media.iter().any(|media| media.cloud.is_some());
    let mut stranded = Vec::new();
    for media_id in used_media(project, start, end) {
        let Some(media) = project.media(&media_id) else {
            continue;
        };
        let Some(cloud) = &media.cloud else {
            if cloud_edit && !Path::new(&media.path).is_file() {
                stranded.push(media.name.clone());
            }
            continue;
        };
        let own = cloud.proxy.as_deref() == Some(cloud.original.as_str());
        if own && Path::new(&media.path).is_file() {
            continue;
        }
        needed.push((media_id, cloud.original.clone(), cloud.size));
    }
    if !stranded.is_empty() {
        return Err(format!(
            "the edit uses files that aren't on this machine or in the cloud ({}): open the project on the machine that made them so they upload, then export again",
            stranded.join(", ")
        ));
    }
    let set_path = |out: &mut Project, media_id: &str, path: String| {
        if let Some(media) = out.media.iter_mut().find(|media| media.id == media_id) {
            media.path = path;
        }
    };
    if needed.is_empty() {
        return Ok((out, originals));
    }
    if !cloud::enabled() {
        return Err(
            "this edit's footage is in the cloud: exporting it needs the cloud (EDIT_RELAY_TOKEN)"
                .to_owned(),
        );
    }
    for (media_id, key, _) in &needed {
        // Long enough for any export.
        let url = get_url(key, 24 * HOUR)?;
        set_path(&mut out, media_id, url);
    }
    // Waveforms read their levels from the proxy's cache: the originals share them.
    for (media, before) in out.media.iter().zip(&project.media) {
        if media.path == before.path {
            continue;
        }
        let from = cache
            .join(crate::media::media_key(Path::new(&before.path)))
            .join("peaks.bin");
        if from.is_file() {
            let to = cache.join(crate::media::media_key(Path::new(&media.path)));
            if std::fs::create_dir_all(&to).is_ok()
                && std::fs::copy(&from, to.join("peaks.bin")).is_ok()
            {
                originals.dirs.push(to);
            }
        }
    }
    crate::diag::info(
        "export",
        format!(
            "{}: reading {} cloud originals straight from the cloud",
            project.id,
            needed.len()
        ),
    );
    Ok((out, originals))
}

// ---------------------------------------------------------------------------
// Everything else a cloud project uses: the backfill.

/// A video Edit made up to this size goes up as it is and is its own proxy
/// (a smoothed shot, a map render); bigger is footage and gets a proxy.
const OWN_FILE_MAX: u64 = 256 << 20;

/// A file that failed to go up isn't tried again for this long (unless asked),
/// and a media's shared analysis isn't looked for again sooner.
const RETRY_AFTER: Duration = Duration::from_secs(600);

/// Puts a file Edit made itself (or one that never went up) in the cloud, as
/// `import_local` does an added file: deduplicated by content; a sound,
/// picture or short render as the file itself, footage-sized video with a
/// proxy (then `Made::path` is the proxy).
pub fn upload_made(cache: &Path, path: &Path, probe: &Probe, name: &str) -> Result<Made, String> {
    let own = probe.kind != MediaKind::Video
        || std::fs::metadata(path).is_ok_and(|meta| meta.len() <= OWN_FILE_MAX);
    put_local(cache, path, probe, name, own)
}

fn probe_of(media: &edit_core::Media) -> Probe {
    Probe {
        kind: media.kind,
        duration: media.duration,
        width: media.width,
        height: media.height,
        fps: media.fps,
        has_audio: media.has_audio,
    }
}

/// Whether `id` is a cloud project on this machine (and cloud is on).
fn cloud_project(app: &App, id: &str) -> bool {
    cloud::enabled() && app.store.cloud().is_some_and(|cloud| cloud.is_cloud(id))
}

#[derive(Default)]
struct Backfills {
    /// Projects waiting for a backfill (one runs at a time, for every project).
    queued: HashSet<String>,
    /// Files that failed to go up, and when.
    failed: HashMap<String, Instant>,
}

fn backfills() -> &'static parking_lot::Mutex<Backfills> {
    static STATE: LazyLock<parking_lot::Mutex<Backfills>> = LazyLock::new(Default::default);
    &STATE
}

/// One backfill at a time: uploads are big and the network is shared.
fn backfill_slot() -> &'static tokio::sync::Mutex<()> {
    static SLOT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    &SLOT
}

/// Starts a backfill of cloud project `id` in the background (one waiting
/// per project is enough: it reads the project when it starts). Called after
/// every push, on opening, and wherever Edit makes media itself (smoothed
/// shots, map renders), so whatever a cloud project uses ends up in the
/// cloud. Nothing happens for a project only on this machine.
pub fn backfill_soon(app: &App, id: &str) {
    if !cloud_project(app, id) || !backfills().lock().queued.insert(id.to_owned()) {
        return;
    }
    let (app, id) = (app.clone(), id.to_owned());
    tokio::spawn(async move {
        let _slot = backfill_slot().lock().await;
        backfills().lock().queued.remove(&id);
        if let Err(error) = backfill_now(&app, &id, false).await {
            crate::diag::warn("cloud", format!("backfill {id}: {error}"));
        }
    });
}

/// `POST /api/projects/{id}/cloud/backfill` (`edit cloud backfill <id>`): a
/// backfill now, failed files tried again; answers what it did.
pub async fn backfill(app: &App, id: &str) -> Result<Value, String> {
    if app.store.get(id).is_none() {
        return Err("no such project".to_owned());
    }
    if !cloud::enabled() {
        return Err("cloud is off here (Settings → Cloud)".to_owned());
    }
    if !cloud_project(app, id) {
        return Err("this isn't a cloud project (Move to cloud first)".to_owned());
    }
    let _slot = backfill_slot().lock().await;
    backfill_now(app, id, true).await
}

/// Uploads every media of cloud project `id` that has no cloud copy but whose
/// file is here (made by Edit, added while cloud was off, an upload that
/// failed), and shares the media's analysis (`share_analysis`). A map shot's
/// first frame standing in for it waits for the footage. Saved one media at a
/// time, so a long backfill keeps what it has done.
async fn backfill_now(app: &App, id: &str, retry_failed: bool) -> Result<Value, String> {
    let live = app.store.get(id).ok_or("no such project")?;
    let now = Instant::now();
    let mut skipped = Vec::new();
    let todo: Vec<(String, PathBuf, Probe, String)> = {
        let mut state = backfills().lock();
        state
            .failed
            .retain(|_, at| now.saturating_duration_since(*at) < RETRY_AFTER);
        live.project
            .media
            .iter()
            .filter(|media| media.cloud.is_none() && Path::new(&media.path).is_file())
            .filter(|media| {
                if crate::broll::is_map_stand_in(&media.path) {
                    skipped.push(format!("{} (a map still rendering)", media.name));
                    return false;
                }
                retry_failed || !state.failed.contains_key(&media.path)
            })
            .map(|media| {
                (
                    media.id.clone(),
                    PathBuf::from(&media.path),
                    probe_of(media),
                    media.name.clone(),
                )
            })
            .collect()
    };
    let missing = stranded(&live.project);
    if !todo.is_empty() {
        // Someone else editing it: refused (their machine has their files).
        let (store, task_id) = (Arc::clone(&app.store), id.to_owned());
        tokio::task::spawn_blocking(move || match store.cloud() {
            Some(cloud) => cloud.may_write(&store, &task_id),
            None => Ok(()),
        })
        .await
        .map_err(|error| error.to_string())??;
    }
    let cache = app.store.cache_dir();
    let mut uploaded = Vec::new();
    let mut failed = Vec::new();
    for (media_id, path, probe, name) in todo {
        let task = (cache.clone(), path.clone(), probe.clone(), name.clone());
        let made = tokio::task::spawn_blocking(move || {
            let (cache, path, probe, name) = task;
            crate::diag::time_on("cloud", "cloud: backfill", &path.to_string_lossy(), || {
                upload_made(&cache, &path, &probe, &name)
            })
        })
        .await
        .unwrap_or_else(|error| Err(error.to_string()));
        let made = match made {
            Ok(made) => made,
            Err(error) => {
                backfills()
                    .lock()
                    .failed
                    .insert(path.to_string_lossy().into_owned(), now);
                failed.push(json!({ "media": media_id, "name": name, "error": scrub(&error) }));
                continue;
            }
        };
        let old_path = path.to_string_lossy().into_owned();
        let new_path = made.path.to_string_lossy().into_owned();
        let up = made.cloud.clone();
        let (store, task_id, task_media) =
            (Arc::clone(&app.store), id.to_owned(), media_id.clone());
        let saved = tokio::task::spawn_blocking(move || {
            let mut tries = 0;
            loop {
                tries += 1;
                let result = store.update(&task_id, "cloud", |project| {
                    // Only while it's still that file with no cloud copy.
                    let Some(media) = project.media.iter_mut().find(|media| {
                        media.id == task_media && media.path == old_path && media.cloud.is_none()
                    }) else {
                        return Ok(false);
                    };
                    media.path.clone_from(&new_path);
                    media.cloud.clone_from(&up);
                    Ok(true)
                });
                match result {
                    Err(error) if tries < 3 && error.contains("retry") => continue,
                    other => break other.map(|(_, changed)| changed),
                }
            }
        })
        .await
        .map_err(|error| error.to_string())?;
        match saved {
            Ok(true) => {
                if made.path != path {
                    app.media.ensure(made.path.clone(), probe);
                }
                uploaded.push(json!({ "media": media_id, "name": name }));
            }
            Ok(false) => skipped.push(format!("{name} (changed meanwhile)")),
            Err(error) => {
                failed.push(json!({ "media": media_id, "name": name, "error": error }));
                break;
            }
        }
    }
    if !uploaded.is_empty() || !failed.is_empty() {
        crate::diag::info(
            "cloud",
            format!(
                "{id}: backfill put {} media in the cloud, {} failed",
                uploaded.len(),
                failed.len()
            ),
        );
    }
    let shared = share_analysis(app, id).await;
    Ok(json!({
        "uploaded": uploaded,
        "failed": failed,
        "skipped": skipped,
        "missing": missing,
        "analysis_shared": shared,
    }))
}

/// Media of `project` that aren't on this machine and have no cloud copy:
/// only the machine that made them has them.
pub fn stranded(project: &Project) -> Vec<String> {
    project
        .media
        .iter()
        .filter(|media| media.cloud.is_none() && !Path::new(&media.path).is_file())
        .map(|media| media.name.clone())
        .collect()
}

// ---------------------------------------------------------------------------
// Analysis that costs money to redo, shared beside the media.

/// Files of a media's cache dir another machine reuses rather than paying for
/// again: its transcript, the faces and seats found in it, the watcher's
/// answers (`watch/<hash>.json`). Under `edit/analysis/<source path>/<file>`.
const ANALYSIS: [&str; 3] = ["transcript.json", "faces-v1.json", "seats-v2.json"];
/// What went up from (or came down to) a cache dir: file → size and mtime,
/// so each version goes once.
const SHARED: &str = "cloud-shared.json";

/// `edit/analysis/drive/<id>[/<s>-<e>]/` or `edit/analysis/sha256/<hex>/`.
fn analysis_prefix(source: &str) -> Option<String> {
    let proxy = proxy_key(source)?;
    let rest = proxy.strip_prefix("edit/proxies/")?.strip_suffix(".mp4")?;
    Some(format!("edit/analysis/{rest}/"))
}

/// Whether `name` (relative to a media's cache dir) is shared analysis.
fn is_analysis(name: &str) -> bool {
    ANALYSIS.contains(&name)
        || name.strip_prefix("watch/").is_some_and(|file| {
            file.ends_with(".json")
                && !file.starts_with('.')
                && file
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
}

/// The shared analysis in a media's cache dir: (name, file).
fn analysis_files(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut files: Vec<(String, PathBuf)> = ANALYSIS
        .iter()
        .map(|name| ((*name).to_owned(), dir.join(name)))
        .filter(|(_, path)| path.is_file())
        .collect();
    for entry in std::fs::read_dir(dir.join("watch"))
        .into_iter()
        .flatten()
        .flatten()
    {
        let name = format!("watch/{}", entry.file_name().to_string_lossy());
        if is_analysis(&name) && entry.path().is_file() {
            files.push((name, entry.path()));
        }
    }
    files
}

fn stamp(path: &Path) -> String {
    let meta = std::fs::metadata(path).ok();
    let modified = meta
        .as_ref()
        .and_then(|meta| meta.modified().ok())
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |at| at.as_millis());
    format!("{}-{modified}", meta.map_or(0, |meta| meta.len()))
}

fn read_shared(dir: &Path) -> serde_json::Map<String, Value> {
    std::fs::read(dir.join(SHARED))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_shared(dir: &Path, shared: &serde_json::Map<String, Value>) {
    if let Ok(bytes) = serde_json::to_vec(shared) {
        let _ = std::fs::write(dir.join(SHARED), bytes);
    }
}

/// `id`'s cloud footage and sounds whose file is here: (source, cache dir).
fn analysis_dirs(app: &App, id: &str) -> Vec<(String, PathBuf)> {
    let Some(live) = app.store.get(id) else {
        return Vec::new();
    };
    let cache = app.store.cache_dir();
    live.project
        .media
        .iter()
        .filter(|media| matches!(media.kind, MediaKind::Video | MediaKind::Audio))
        .filter_map(|media| {
            let cloud = media.cloud.as_ref()?;
            let path = Path::new(&media.path);
            path.is_file().then(|| {
                (
                    cloud.source.clone(),
                    cache.join(crate::media::media_key(path)),
                )
            })
        })
        .collect()
}

/// Uploads the analysis of `id`'s cloud media made here since it last went
/// up. Returns how many files went.
async fn share_analysis(app: &App, id: &str) -> usize {
    let dirs = analysis_dirs(app, id);
    tokio::task::spawn_blocking(move || {
        let mut sent = 0;
        for (source, dir) in dirs {
            let Some(prefix) = analysis_prefix(&source) else {
                continue;
            };
            let mut shared = read_shared(&dir);
            let mut changed = false;
            for (name, path) in analysis_files(&dir) {
                let stamp = stamp(&path);
                if shared.get(&name).and_then(Value::as_str) == Some(stamp.as_str()) {
                    continue;
                }
                match cloud::upload_file(&path, &format!("{prefix}{name}"), &|_, _| {}) {
                    Ok(()) => {
                        shared.insert(name, Value::String(stamp));
                        changed = true;
                        sent += 1;
                    }
                    Err(error) => crate::diag::warn(
                        "cloud",
                        format!("sharing {name} of {source}: {}", scrub(&error)),
                    ),
                }
            }
            if changed {
                write_shared(&dir, &shared);
            }
        }
        sent
    })
    .await
    .unwrap_or(0)
}

/// Fetches the analysis other machines shared for `id`'s cloud media into
/// this machine's cache (what's here already is kept). Each source is looked
/// up at most every ten minutes.
async fn fetch_analysis(app: &App, id: &str) {
    static CHECKED: LazyLock<parking_lot::Mutex<HashMap<String, Instant>>> =
        LazyLock::new(Default::default);
    if !cloud::enabled() {
        return;
    }
    let now = Instant::now();
    let dirs: Vec<(String, PathBuf)> = {
        let mut checked = CHECKED.lock();
        analysis_dirs(app, id)
            .into_iter()
            .filter(|(source, _)| {
                let due = checked
                    .get(source)
                    .is_none_or(|at| now.saturating_duration_since(*at) >= RETRY_AFTER);
                if due {
                    checked.insert(source.clone(), now);
                }
                due
            })
            .collect()
    };
    if dirs.is_empty() {
        return;
    }
    let fetched = tokio::task::spawn_blocking(move || {
        dirs.chunks(PARALLEL)
            .map(|batch| {
                std::thread::scope(|scope| {
                    let running: Vec<_> = batch
                        .iter()
                        .map(|(source, dir)| scope.spawn(move || fetch_analysis_of(source, dir)))
                        .collect();
                    running
                        .into_iter()
                        .map(|job| job.join().unwrap_or(0))
                        .sum::<usize>()
                })
            })
            .sum::<usize>()
    })
    .await
    .unwrap_or(0);
    if fetched > 0 {
        crate::diag::info(
            "cloud",
            format!("{id}: {fetched} analysis files from the cloud"),
        );
    }
}

fn fetch_analysis_of(source: &str, dir: &Path) -> usize {
    let Some(prefix) = analysis_prefix(source) else {
        return 0;
    };
    let objects = match cloud::list(&prefix) {
        Ok(objects) => objects,
        Err(error) => {
            crate::diag::warn("cloud", format!("listing {source}'s analysis: {error}"));
            return 0;
        }
    };
    let mut shared = read_shared(dir);
    let mut fetched = 0;
    for object in objects {
        let Some(name) = object.key.strip_prefix(&prefix) else {
            continue;
        };
        let local = dir.join(name);
        if !is_analysis(name) || local.exists() {
            continue;
        }
        if let Some(parent) = local.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match cloud::download(&object.key, &local, &|_, _| {}) {
            Ok(()) => {
                // Came from the cloud: nothing to send back.
                shared.insert(name.to_owned(), Value::String(stamp(&local)));
                fetched += 1;
            }
            Err(error) => crate::diag::warn(
                "cloud",
                format!("fetching {}: {}", object.key, scrub(&error)),
            ),
        }
    }
    if fetched > 0 {
        write_shared(dir, &shared);
    }
    fetched
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analysis_sits_beside_the_source() {
        assert_eq!(
            analysis_prefix("sha256:abc").as_deref(),
            Some("edit/analysis/sha256/abc/")
        );
        assert_eq!(
            analysis_prefix("drive:F1#100-2000").as_deref(),
            Some("edit/analysis/drive/F1/100-2000/")
        );
        assert!(is_analysis("transcript.json") && is_analysis("watch/7bc98.json"));
        assert!(!is_analysis("preview.mp4") && !is_analysis("watch/../x.json"));
        assert!(!is_analysis("watch/.hidden.json"));
    }

    #[test]
    fn stranded_media_are_named() {
        let mut project = Project::new(
            "p".into(),
            "t".into(),
            edit_core::Settings {
                width: 1920,
                height: 1080,
                fps: 30,
            },
        );
        project.media.push(
            serde_json::from_value(json!({"id": "m1", "name": "map-x.mp4",
                "path": "/nowhere/map-x.mp4", "kind": "video", "duration": 5.0,
                "width": 1920, "height": 1080}))
            .unwrap(),
        );
        assert_eq!(stranded(&project), vec!["map-x.mp4".to_owned()]);
        // No cloud media in it: an ordinary project, left to the export.
        assert!(for_export(&project, 0, 150, &std::env::temp_dir()).is_ok());
    }

    #[test]
    fn sources_name_their_proxies() {
        assert_eq!(
            proxy_key("drive:abc_D-1").as_deref(),
            Some("edit/proxies/drive/abc_D-1.mp4")
        );
        assert_eq!(
            proxy_key(&excerpt_source("abc", 61.4994, 182.0)).as_deref(),
            Some("edit/proxies/drive/abc/61499-182000.mp4")
        );
        assert_eq!(
            proxy_key("sha256:00ff").as_deref(),
            Some("edit/proxies/sha256/00ff.mp4")
        );
        assert_eq!(proxy_key("youtube:x"), None);
        assert_eq!(proxy_key("drive:../x"), None);
    }

    #[test]
    fn proxies_get_bits_for_their_size() {
        use crate::media::cloud_proxy_bitrate;
        assert_eq!(cloud_proxy_bitrate(1920, 1080), 4_000_000);
        assert_eq!(cloud_proxy_bitrate(1080, 1920), 4_000_000);
        assert_eq!(cloud_proxy_bitrate(3840, 2160), 4_000_000);
        assert_eq!(cloud_proxy_bitrate(1280, 720), 1_777_777);
        assert_eq!(cloud_proxy_bitrate(640, 360), 800_000);
    }

    #[test]
    fn local_copies_live_in_the_cache() {
        let cache = Path::new("/home/a/.edit/cache");
        let local = local_path(cache, "edit/proxies/drive/abc/1-2.mp4");
        assert_eq!(
            local,
            PathBuf::from("/home/a/.edit/cache/cloud/proxies/drive/abc/1-2.mp4")
        );
        assert!(is_local_copy(cache, &local));
        assert!(!is_local_copy(
            cache,
            Path::new("/home/a/.edit/media/x.mp4")
        ));
    }

    #[test]
    fn names_fit_keys() {
        assert_eq!(segment("a/b\\c.mov"), "a_b_c.mov");
        assert_eq!(segment(".hidden.mp4"), "hidden.mp4");
        let long = format!("{}.mov", "x".repeat(300));
        let cut = segment(&long);
        assert!(cut.ends_with(".mov") && cut.chars().count() <= 120, "{cut}");
        assert!(cloud::valid_key(&format!(
            "edit/originals/sha256/ab/{}",
            segment("../../x")
        )));
        assert_eq!(extension_of("Clip.MOV"), "mov");
        assert_eq!(extension_of("weird.m?v"), "mp4");
        assert_eq!(extension_of("none"), "mp4");
        assert!(drive_id_ok("1AbC-d_e") && !drive_id_ok("a/b") && !drive_id_ok(""));
    }

    #[test]
    fn urls_never_show() {
        let text = "Server returned 403 for https://acct.r2.cloudflarestorage.com/b/edit/x.mp4?X-Amz-Signature=abc: Forbidden";
        assert_eq!(scrub(text), "Server returned 403 for <url> Forbidden");
        assert!(!scrub(text).contains("Signature"));
        assert_eq!(scrub("'http://a/b' and https://c"), "'<url>' and <url>");
        assert_eq!(scrub("nothing here"), "nothing here");
    }

    #[test]
    fn records_read_convex_values() {
        let record: Record = serde_json::from_value(json!({
            "_id": "x", "source": "sha256:ab", "name": "a.mov", "originalKey": "edit/originals/sha256/ab/a.mov",
            "originalReady": true, "proxyKey": null, "proxyReady": false, "size": 1234.0,
            "duration": null, "createdAt": 1, "updatedAt": 2
        }))
        .unwrap();
        assert_eq!(
            record.ready_original(),
            Some("edit/originals/sha256/ab/a.mov")
        );
        assert_eq!(record.ready_proxy(), None);
        assert_eq!(record.size as u64, 1234);
    }

    #[test]
    fn exports_fetch_only_what_the_span_uses() {
        let mut project: Project = serde_json::from_value(json!({
            "version": 1, "id": "p", "name": "p",
            "settings": {"width": 1920, "height": 1080, "fps": 30},
            "tracks": [{"id": "v1", "kind": "video"}, {"id": "a1", "kind": "audio"}],
            "media": [],
            "clips": [
                {"id": "c1", "track": "v1", "start": 0, "duration": 30, "type": "video", "media": "m1"},
                {"id": "c2", "track": "a1", "start": 30, "duration": 30, "type": "audio", "media": "m2"},
                {"id": "c3", "track": "v1", "start": 60, "duration": 30, "type": "video", "media": "m1"}
            ]
        }))
        .unwrap();
        assert_eq!(used_media(&project, 0, 90), vec!["m1", "m2"]);
        assert_eq!(used_media(&project, 30, 60), vec!["m2"]);
        project.clips.clear();
        assert!(used_media(&project, 0, 90).is_empty());
        // Nothing in the cloud: the project as it is, no cloud needed.
        let (same, _) = for_export(&project, 0, 90, Path::new("/nonexistent")).unwrap();
        assert_eq!(same, project);
    }

    // -----------------------------------------------------------------------
    // Live: against a real relay, R2 and Convex (EDIT_RELAY_URL /
    // EDIT_RELAY_TOKEN, e.g. `bunx wrangler dev` with apps/relay/.dev.vars):
    // `cargo test -p edit cloud_media::tests::live -- --ignored --test-threads 1`.
    // Each removes every object, registry row and file it made.

    use std::sync::Arc;

    fn test_app(home: &Path) -> App {
        let _ = std::fs::remove_dir_all(home);
        let store = Arc::new(crate::store::Store::open(home.to_path_buf()).unwrap());
        App {
            updater: crate::update::Updater::new(home.to_path_buf()),
            voices: Arc::new(crate::voice::Voices::new(home)),
            agents: crate::agent::Agents::new(Arc::clone(&store), home.to_path_buf(), 0),
            scripts: Arc::new(crate::script::Jobs::default()),
            library: Arc::new(crate::library::Library::default()),
            media: crate::media::Processor::new(Arc::clone(&store)),
            frames: crate::render::FrameRenderer::start(store.cache_dir()),
            exports: Arc::new(crate::render::Exports::default()),
            allowed_hosts: Arc::new(Vec::new()),
            machine: "test".into(),
            store,
        }
    }

    fn ffmpeg(args: &[&str], out: &Path) {
        let status = Command::new(crate::tools::ffmpeg())
            .args(["-hide_banner", "-loglevel", "error", "-y"])
            .args(args)
            .arg(out)
            .status()
            .unwrap();
        assert!(status.success());
    }

    /// Test footage: `seconds` of a moving test picture with a tone.
    fn footage(out: &Path, size: &str, seconds: u32, bitrate: &str) {
        ffmpeg(
            &[
                "-f",
                "lavfi",
                "-i",
                &format!("testsrc2=size={size}:rate=30"),
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000",
                "-t",
                &seconds.to_string(),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-b:v",
                bitrate,
                "-g",
                "30",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "96k",
                "-shortest",
            ],
            out,
        );
    }

    /// Removes what a live test put in the cloud, even when it fails.
    #[derive(Default)]
    struct Cleanup {
        prefixes: Vec<String>,
        keys: Vec<String>,
        sources: parking_lot::Mutex<Vec<String>>,
        drive: Option<String>,
    }

    impl Drop for Cleanup {
        fn drop(&mut self) {
            let mut keys = self.keys.clone();
            for prefix in &self.prefixes {
                keys.extend(
                    cloud::list(prefix)
                        .unwrap_or_default()
                        .into_iter()
                        .map(|o| o.key),
                );
            }
            if !keys.is_empty() {
                if let Err(error) = cloud::delete(&keys) {
                    eprintln!("cleanup: {error}");
                }
            }
            for source in self.sources.lock().iter() {
                if let Err(error) = delete_record(source) {
                    eprintln!("cleanup {source}: {error}");
                }
            }
            if let Some(file) = &self.drive {
                if let Err(error) = crate::drive::test_delete(file) {
                    eprintln!("cleanup: {error}");
                }
            }
            if std::thread::panicking() {
                return;
            }
            for key in &keys {
                assert!(cloud::head(key).unwrap().is_none(), "{key} is still there");
            }
            for source in self.sources.lock().iter() {
                assert!(
                    get_record(source).unwrap().is_none(),
                    "{source} is still there"
                );
            }
        }
    }

    fn files_under(dir: &Path) -> Vec<PathBuf> {
        let mut found = Vec::new();
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                found.extend(files_under(&path));
            } else {
                found.push(path);
            }
        }
        found
    }

    async fn wait_for_export(app: &App) {
        for _ in 0..600 {
            if !app.exports.running() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        panic!("the export never finished");
    }

    /// Excerpts cut from R2 (only their bytes fetched), each a full-quality
    /// excerpt and a proxy on R2 and only the proxy here; a second import
    /// reuses them; another machine (paths pointing nowhere, no proxies)
    /// gets them with `ensure_local`; exports read the originals straight
    /// from R2, with the proxies gone.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_excerpts_ensure_local_and_export() {
        assert!(cloud::enabled(), "set EDIT_RELAY_URL / EDIT_RELAY_TOKEN");
        let home = std::env::temp_dir().join(format!("edit-cloud-media-{}", std::process::id()));
        let app = test_app(&home);
        let cache = app.store.cache_dir();
        let file = format!("edittest{}", std::process::id());
        let original_key = format!("edit/originals/drive/{file}/case footage.mp4");
        let cleanup = Cleanup {
            prefixes: vec![
                format!("edit/originals/drive/{file}/"),
                format!("edit/excerpts/drive/{file}/"),
                format!("edit/proxies/drive/{file}/"),
            ],
            keys: Vec::new(),
            sources: parking_lot::Mutex::new(vec![format!("drive:{file}")]),
            drive: None,
        };
        // A "Drive file" already on R2 (as drive_original leaves it): five minutes.
        let long = home.join("case footage.mp4");
        footage(&long, "1280x720", 300, "500k");
        let size = std::fs::metadata(&long).unwrap().len();
        cloud::upload_file(&long, &original_key, &|_, _| {}).unwrap();
        std::fs::remove_file(&long).unwrap();
        put_record(json!({"source": format!("drive:{file}"), "name": "case footage.mp4", "originalKey": original_key, "size": size})).unwrap();
        put_record(
            json!({"source": format!("drive:{file}"), "originalReady": true, "duration": 300.0}),
        )
        .unwrap();
        let original = Original {
            file: file.clone(),
            source: format!("drive:{file}"),
            key: original_key.clone(),
            name: "case footage.mp4".into(),
            size,
        };

        let ranges = [(20.0, 30.0), (250.0, 260.0)];
        let started = std::time::Instant::now();
        let cut = {
            let (cache, original) = (cache.clone(), original.clone());
            tokio::task::spawn_blocking(move || drive_excerpts(&cache, &original, &ranges))
                .await
                .unwrap()
                .unwrap()
        };
        eprintln!("cut and published 2 excerpts in {:?}", started.elapsed());
        assert_eq!(cut.len(), 2);
        for excerpt in &cut {
            cleanup.sources.lock().push(
                excerpt
                    .cloud
                    .as_ref()
                    .unwrap()
                    .cloud
                    .as_ref()
                    .unwrap()
                    .source
                    .clone(),
            );
        }
        let (first, second) = (&cut[0], &cut[1]);
        assert!(first.from <= 10.0 + 1e-6 && first.from > 8.0, "{first:?}");
        assert!((first.to - 40.0).abs() < 1e-6 && (second.to - 270.0).abs() < 1e-6);
        for excerpt in &cut {
            let made = excerpt.cloud.as_ref().unwrap();
            let media = made.cloud.as_ref().unwrap();
            assert!(
                made.path.is_file() && is_local_copy(&cache, &made.path),
                "{made:?}"
            );
            assert_eq!(made.path, excerpt.path);
            // Full quality and proxy both on R2, and in the registry.
            let stored = cloud::head(&media.original).unwrap().unwrap();
            assert_eq!(stored.size, media.size);
            let proxy = media.proxy.as_deref().unwrap();
            assert_eq!(
                cloud::head(proxy).unwrap().unwrap().size,
                std::fs::metadata(&made.path).unwrap().len()
            );
            let record = get_record(&media.source).unwrap().unwrap();
            assert!(record.original_ready && record.proxy_ready, "{record:?}");
            assert_eq!(record.ready_proxy(), Some(proxy));
            // The proxy: H.264 + AAC, the excerpt's length and picture size.
            let probed = crate::media::probe(&made.path).unwrap();
            assert!(probed.has_audio && probed.width == 1280 && probed.height == 720);
            assert!(
                (probed.duration - (excerpt.to - excerpt.from)).abs() < 0.2,
                "{probed:?}"
            );
            assert_eq!((made.probe.width, made.probe.height), (1280, 720));
            assert!(made.name.starts_with("case footage 0h"), "{}", made.name);
        }
        // No full-quality footage on this disk: only the two proxies.
        let files = files_under(&home);
        let cloud_files: Vec<_> = files
            .iter()
            .filter(|path| path.starts_with(cache.join("cloud")))
            .collect();
        assert_eq!(cloud_files.len(), 2, "{cloud_files:?}");

        // Imported again: everything reused from the registry.
        let again = {
            let (cache, original) = (cache.clone(), original.clone());
            tokio::task::spawn_blocking(move || drive_excerpts(&cache, &original, &ranges))
                .await
                .unwrap()
                .unwrap()
        };
        assert_eq!(
            again.iter().map(|e| e.path.clone()).collect::<Vec<_>>(),
            cut.iter().map(|e| e.path.clone()).collect::<Vec<_>>()
        );

        // Into a project, on the timeline.
        let id = app
            .store
            .create("cloud", edit_core::Settings::default())
            .unwrap()
            .project
            .id;
        let made: Vec<Made> = cut.iter().filter_map(|e| e.cloud.clone()).collect();
        let (_, added, errors) = crate::server::import_made(&app, &id, made, true, "script")
            .await
            .unwrap();
        assert!(errors.is_empty() && added.len() == 2, "{errors:?}");

        // Another machine: its paths point nowhere and it has no proxies.
        for excerpt in &cut {
            std::fs::remove_file(&excerpt.path).unwrap();
        }
        app.store
            .update(&id, "test", |project| {
                for media in &mut project.media {
                    media.path =
                        format!("/Users/someone-else/.edit/cache/cloud/x/{}.mp4", media.id);
                }
                Ok(())
            })
            .unwrap();
        ensure_local(&app, &id).await.unwrap();
        let live = app.store.get(&id).unwrap();
        for media in &live.project.media {
            assert!(Path::new(&media.path).is_file(), "{}", media.path);
            assert!(is_local_copy(&cache, Path::new(&media.path)));
        }
        // Nothing to do the second time.
        ensure_local(&app, &id).await.unwrap();
        assert_eq!(app.store.get(&id).unwrap().rev, live.rev);

        // Exports read the originals: with the proxies gone, it still works.
        for media in &live.project.media {
            std::fs::remove_file(&media.path).unwrap();
        }
        {
            let out = home.join("export.mp4");
            let options = crate::export::ExportOptions {
                range: Some([0, 150]),
                ..Default::default()
            };
            let path = app
                .exports
                .start(
                    Arc::clone(&app.store),
                    Arc::clone(&app.library),
                    app.store.get(&id).unwrap().project,
                    options,
                    out.clone(),
                )
                .unwrap();
            wait_for_export(&app).await;
            let probed =
                crate::media::probe(&path).unwrap_or_else(|error| panic!("export failed: {error}"));
            assert!(
                (probed.duration - 5.0).abs() < 0.2 && probed.has_audio,
                "{probed:?}"
            );
            // Nothing was downloaded for it.
            let left: Vec<_> = std::fs::read_dir(cache.join("cloud"))
                .unwrap()
                .flatten()
                .filter(|entry| entry.file_name().to_string_lossy().starts_with("export-"))
                .collect();
            assert!(left.is_empty(), "{left:?}");
        }
        drop(cleanup);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Files from a disk: footage goes up with its proxy (made once: a second
    /// import of the same content reuses it), a sound stays its own file.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_imports_from_disk() {
        assert!(cloud::enabled(), "set EDIT_RELAY_URL / EDIT_RELAY_TOKEN");
        let home = std::env::temp_dir().join(format!("edit-cloud-import-{}", std::process::id()));
        let app = test_app(&home);
        let cache = app.store.cache_dir();
        let user = home.join("Movies");
        std::fs::create_dir_all(&user).unwrap();
        let (video, sound) = (user.join("interview.mov"), user.join("take.wav"));
        footage(&video, "1920x1080", 12, "8M");
        ffmpeg(
            &["-f", "lavfi", "-i", "sine=frequency=300:duration=3"],
            &sound,
        );
        let mut cleanup = Cleanup::default();
        for path in [&video, &sound] {
            let hex = sha256_file(path).unwrap();
            cleanup
                .prefixes
                .push(format!("edit/originals/sha256/{hex}/"));
            cleanup.keys.push(format!("edit/proxies/sha256/{hex}.mp4"));
            cleanup.sources.lock().push(format!("sha256:{hex}"));
        }
        let id = app
            .store
            .create("disk", edit_core::Settings::default())
            .unwrap()
            .project
            .id;
        let paths = vec![
            video.to_string_lossy().into_owned(),
            sound.to_string_lossy().into_owned(),
        ];
        let (_, added, errors) = crate::server::import_paths(&app, &id, paths.clone(), false, "ui")
            .await
            .unwrap();
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(added.len(), 2);
        let live = app.store.get(&id).unwrap();
        let footage_media = live.project.media(&added[0]).unwrap();
        let sound_media = live.project.media(&added[1]).unwrap();
        let cloud_footage = footage_media.cloud.as_ref().unwrap();
        assert_eq!(footage_media.name, "interview.mov");
        assert!(is_local_copy(&cache, Path::new(&footage_media.path)));
        assert_eq!((footage_media.width, footage_media.height), (1920, 1080));
        assert!(cloud::head(&cloud_footage.original).unwrap().is_some());
        assert!(cloud::head(cloud_footage.proxy.as_deref().unwrap())
            .unwrap()
            .is_some());
        assert!(video.is_file() && sound.is_file(), "the user's files stay");
        let cloud_sound = sound_media.cloud.as_ref().unwrap();
        assert_eq!(
            sound_media.path,
            sound.canonicalize().unwrap().to_string_lossy()
        );
        assert_eq!(
            cloud_sound.proxy.as_deref(),
            Some(cloud_sound.original.as_str())
        );
        // The preview is the proxy itself (linked), with its sound beside it.
        let source = PathBuf::from(&footage_media.path);
        for _ in 0..240 {
            if app.media.status(&source).proxy == crate::media::Stage::Ready {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let paths_of = app.media.paths(&source);
        assert!(paths_of.audio.is_file());
        assert_eq!(
            std::fs::metadata(&paths_of.proxy).unwrap().len(),
            std::fs::metadata(&source).unwrap().len()
        );
        // Again, into another project: nothing made or uploaded again.
        let other = app
            .store
            .create("disk 2", edit_core::Settings::default())
            .unwrap()
            .project
            .id;
        let record = get_record(&cloud_footage.source).unwrap().unwrap();
        let started = std::time::Instant::now();
        let (_, again, _) = crate::server::import_paths(&app, &other, paths, false, "ui")
            .await
            .unwrap();
        eprintln!("second import in {:?}", started.elapsed());
        let other_media = app
            .store
            .get(&other)
            .unwrap()
            .project
            .media(&again[0])
            .cloned()
            .unwrap();
        assert_eq!(other_media.path, footage_media.path);
        assert_eq!(get_record(&cloud_footage.source).unwrap().unwrap(), record);
        drop(cleanup);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// `ensure_local` on a cloud project this machine holds (an ordinary
    /// write) and on one someone else holds (read-only here: the paths are
    /// saved on this machine only, as a pull is). No R2 traffic: the proxies
    /// are in this machine's cache already.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_ensure_local_follows_the_lock() {
        assert!(cloud::enabled(), "set EDIT_RELAY_URL / EDIT_RELAY_TOKEN");
        let home = std::env::temp_dir().join(format!("edit-cloud-lock-{}", std::process::id()));
        let app = test_app(&home);
        let cache = app.store.cache_dir();
        let mut ids = Vec::new();
        for name in ["mine", "theirs"] {
            let id = app
                .store
                .create(name, edit_core::Settings::default())
                .unwrap()
                .project
                .id;
            let key = format!("edit/proxies/sha256/{name}.mp4");
            let local = local_path(&cache, &key);
            std::fs::create_dir_all(local.parent().unwrap()).unwrap();
            footage(&local, "320x180", 2, "200k");
            app.store
                .update(&id, "test", |project| {
                    project.media.push(edit_core::Media {
                        id: "m1".into(),
                        name: "clip.mov".into(),
                        path: "/Users/someone-else/.edit/cache/cloud/x.mp4".into(),
                        kind: MediaKind::Video,
                        duration: 2.0,
                        width: 320,
                        height: 180,
                        fps: 30.0,
                        has_audio: true,
                        markers: Vec::new(),
                        cloud: Some(CloudMedia {
                            source: format!("sha256:{name}"),
                            original: format!("edit/originals/sha256/{name}/clip.mov"),
                            proxy: Some(key),
                            size: 1,
                        }),
                    });
                    Ok(())
                })
                .unwrap();
            ids.push(id);
        }
        app.store.attach_cloud(crate::cloud_projects::test_cloud(
            &home,
            &[(&ids[0], None), (&ids[1], Some("kenobi"))],
        ));
        // Someone else's is refused as an edit…
        assert!(app.store.update(&ids[1], "test", |_| Ok(())).is_err());
        for id in &ids {
            ensure_local(&app, id).await.unwrap();
            let project = app.store.get(id).unwrap().project;
            let path = &project.media[0].path;
            assert!(
                is_local_copy(&cache, Path::new(path)) && Path::new(path).is_file(),
                "{path}"
            );
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A whole script import in cloud mode, as the editor runs it: the Drive
    /// file streamed to R2, its two used stretches cut there as excerpts, their
    /// proxies imported and laid out. (Transcription and the voice-over need
    /// the relay's paid keys; without them the job ends "failed" after laying
    /// out, which is all this checks.) Needs the Google sign-in too.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_script_import() {
        assert!(cloud::enabled(), "set EDIT_RELAY_URL / EDIT_RELAY_TOKEN");
        let home = std::env::temp_dir().join(format!("edit-cloud-script-{}", std::process::id()));
        let app = test_app(&home);
        let source = home.join("bodycam.mp4");
        footage(&source, "640x360", 300, "300k");
        let size = std::fs::metadata(&source).unwrap().len();
        let file = crate::drive::test_upload(&source, "edit-cloud-test.mp4").unwrap();
        std::fs::remove_file(&source).unwrap();
        let cleanup = Cleanup {
            prefixes: vec![
                format!("edit/originals/drive/{file}/"),
                format!("edit/excerpts/drive/{file}/"),
                format!("edit/proxies/drive/{file}/"),
            ],
            keys: vec![format!("edit/proxies/drive/{file}.mp4")],
            sources: parking_lot::Mutex::new(vec![format!("drive:{file}")]),
            drive: Some(file.clone()),
        };
        let id = app
            .store
            .create("script", edit_core::Settings::default())
            .unwrap()
            .project
            .id;
        let block = |start: f64, end: f64| edit_core::ScriptBlock::Footage {
            url: format!("https://drive.google.com/file/d/{file}/view"),
            file: file.clone(),
            start,
            end,
            label: format!("{start} - {end}"),
            notes: Vec::new(),
            media: None,
            media_start: None,
            words: None,
            cut: None,
            clip: None,
        };
        app.store
            .update(&id, "test", |project| {
                project.script = Some(edit_core::Script {
                    source: None,
                    blocks: vec![block(20.0, 30.0), block(250.0, 260.0)],
                });
                Ok(())
            })
            .unwrap();
        crate::script::start(&app, &id, false);
        let mut job = None;
        for _ in 0..600 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            job = app.scripts.get(&id);
            if job
                .as_ref()
                .is_some_and(|job| matches!(job.state, "done" | "failed"))
            {
                break;
            }
        }
        let job = job.unwrap();
        eprintln!("job: {}", serde_json::to_string(&job).unwrap());
        assert_eq!(job.files[0].state, "done", "{job:?}");
        assert_eq!(job.files[0].bytes, size);
        let project = app.store.get(&id).unwrap().project;
        for media in &project.media {
            cleanup
                .sources
                .lock()
                .push(media.cloud.as_ref().unwrap().source.clone());
        }
        assert_eq!(project.media.len(), 2);
        let blocks = &project.script.as_ref().unwrap().blocks;
        for (block, media) in blocks.iter().zip(&project.media) {
            let edit_core::ScriptBlock::Footage {
                media: Some(of),
                media_start: Some(at),
                clip: Some(_),
                start,
                ..
            } = block
            else {
                panic!("not laid out: {block:?}");
            };
            assert_eq!(of, &media.id);
            assert!(*at <= start - 9.0, "{at} {start}");
            let cloud = media.cloud.as_ref().unwrap();
            assert!(
                cloud.source.starts_with(&format!("drive:{file}#")),
                "{cloud:?}"
            );
            assert!(
                cloud.original.starts_with("edit/excerpts/") && Path::new(&media.path).is_file()
            );
        }
        // Nothing of the original or the excerpts on this disk: no Drive
        // download folder, no scratch files, and the only footage the proxies.
        assert!(!home.join("media").exists());
        assert!(files_under(&app.store.cache_dir().join("cloud/tmp")).is_empty());
        let cloud_files = files_under(&app.store.cache_dir().join("cloud"));
        assert_eq!(cloud_files.len(), 2, "{cloud_files:?}");
        drop(cleanup);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A real Drive file streamed to R2: nothing of it lands on this disk.
    /// Needs the Google sign-in too (GOOGLE_DRIVE_CLIENT_ID, …SECRET,
    /// GOOGLE_DOCS_REFRESH_TOKEN) to put a small test file in Drive.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_drive_streams_to_r2() {
        assert!(cloud::enabled(), "set EDIT_RELAY_URL / EDIT_RELAY_TOKEN");
        let home = std::env::temp_dir().join(format!("edit-cloud-drive-{}", std::process::id()));
        let app = test_app(&home);
        let cache = app.store.cache_dir();
        let source = home.join("drive-test.mp4");
        footage(&source, "1280x720", 40, "2M");
        let size = std::fs::metadata(&source).unwrap().len();
        let file = crate::drive::test_upload(&source, "edit-cloud-test.mp4").unwrap();
        std::fs::remove_file(&source).unwrap();
        let cleanup = Cleanup {
            prefixes: vec![
                format!("edit/originals/drive/{file}/"),
                format!("edit/excerpts/drive/{file}/"),
            ],
            keys: vec![format!("edit/proxies/drive/{file}.mp4")],
            sources: parking_lot::Mutex::new(vec![format!("drive:{file}")]),
            drive: Some(file.clone()),
        };
        let seen = parking_lot::Mutex::new(Vec::new());
        let original = {
            let (file, scratch) = (file.clone(), scratch_dir(&cache).unwrap());
            let watch = home.clone();
            tokio::task::spawn_blocking(move || {
                // While it streams, nothing near its size appears on this disk.
                let biggest = std::sync::atomic::AtomicU64::new(0);
                let result = drive_original(&file, &scratch, &|bytes, total, _| {
                    seen.lock().push((bytes, total));
                    let most = files_under(&watch)
                        .iter()
                        .filter_map(|path| std::fs::metadata(path).ok())
                        .map(|meta| meta.len())
                        .max()
                        .unwrap_or(0);
                    biggest.fetch_max(most, Ordering::Relaxed);
                });
                (result, seen.into_inner(), biggest.into_inner())
            })
            .await
            .unwrap()
        };
        let (original, seen, biggest) = original;
        let original = original.unwrap();
        eprintln!(
            "streamed {} bytes; progress {seen:?}; biggest local file {biggest}",
            original.size
        );
        assert_eq!(original.size, size);
        assert!(biggest < size / 4, "{biggest} bytes landed on disk");
        assert_eq!(cloud::head(&original.key).unwrap().unwrap().size, size);
        let record = get_record(&original.source).unwrap().unwrap();
        assert!(record.original_ready && record.duration.is_some_and(|d| (d - 40.0).abs() < 0.5));
        // Again: the registry says it's there, nothing is downloaded.
        let again = drive_original(&file, &scratch_dir(&cache).unwrap(), &|_, _, _| {}).unwrap();
        assert_eq!(again.key, original.key);
        // A short file, mostly used: the whole of it is the media.
        let cut = {
            let (cache, original) = (cache.clone(), original.clone());
            tokio::task::spawn_blocking(move || drive_excerpts(&cache, &original, &[(5.0, 30.0)]))
                .await
                .unwrap()
                .unwrap()
        };
        assert_eq!(cut.len(), 1);
        assert_eq!(cut[0].from, 0.0);
        let made = cut[0].cloud.as_ref().unwrap();
        assert_eq!(made.cloud.as_ref().unwrap().original, original.key);
        assert!(made.path.is_file());
        drop(cleanup);
        let _ = std::fs::remove_dir_all(&home);
    }
}
