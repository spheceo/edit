//! Edit's cloud: footage originals and preview proxies on Cloudflare R2,
//! project files in Convex, all through the relay (apps/relay/src/cloud.ts), which
//! holds the R2 keys and Convex's service token. Edit only ever sees
//! short-lived presigned URLs and the answers of `edit:` Convex functions.
//!
//! Every function blocks (curl subprocesses, like the rest of Edit's network
//! calls): call them from `spawn_blocking` or a thread. Errors are strings
//! fit to show. Cloud calls need `EDIT_RELAY_TOKEN` (the relay's
//! `CLOUD_TOKEN`); [`enabled`] says whether it's set.
//!
//! Keys are R2 object keys, always under `edit/` ([`valid_key`]); the bucket
//! is shared with Repack, and the relay refuses anything else.
//!
//! Big uploads are multipart: fixed-size parts (R2 wants every part but the
//! last the same size), a few in flight at once, each retried with a fresh
//! URL, and the upload aborted if one gives up. [`upload_stream`] takes any
//! reader (a Drive download piped straight through) and holds only the parts
//! in flight in memory, never a temp file.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::sync_channel;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{json, Value};

const MIB: u64 = 1024 * 1024;
/// A file's parts: 64 MiB, four in flight (≤ 320 MiB in memory).
const FILE_PART: u64 = 64 * MIB;
const FILE_PARALLEL: usize = 4;
/// A stream's parts: 32 MiB, two in flight plus the one being read (≤ 96 MiB).
const STREAM_PART: u64 = 32 * MIB;
const STREAM_PARALLEL: usize = 2;
/// S3's (and R2's) limit on parts per upload.
const MAX_PARTS: u64 = 10_000;
/// Tries per part, per single PUT and per download.
const ATTEMPTS: u32 = 4;
/// Keys per relay delete request (the relay's limit).
const DELETE_BATCH: usize = 40;
/// curl gives up on a transfer slower than 1 KB/s for a minute.
const STALL: [&str; 6] = [
    "--speed-limit",
    "1024",
    "--speed-time",
    "60",
    "--connect-timeout",
    "30",
];

/// Whether cloud calls can work: a relay token is set (`EDIT_RELAY_TOKEN`,
/// else the one saved in Settings → Cloud). Cloud is always on with one.
pub fn enabled() -> bool {
    crate::relay::token().is_some()
}

/// POSTs `body` to the relay's `/v1/cloud/<path>` and returns its JSON answer.
pub fn relay_json(path: &str, body: &Value) -> Result<Value, String> {
    crate::relay::json(
        "POST",
        &format!("/v1/cloud/{path}"),
        Some(body),
        "cloud storage",
        120,
    )
}

/// A key Edit may use: under `edit/`, no empty, `.` or `..` segments, no
/// control characters or backslashes (the relay's rule, checked early).
pub fn valid_key(key: &str) -> bool {
    key.len() <= 1024
        && key.starts_with("edit/")
        && !key.chars().any(|c| c.is_control() || c == '\\')
        && key
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn check_key(key: &str) -> Result<(), String> {
    if valid_key(key) {
        Ok(())
    } else {
        Err(format!("not a cloud key Edit may use: {key:?}"))
    }
}

/// What a presigned URL lets its holder do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Put,
    Head,
}

impl Method {
    fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Put => "PUT",
            Method::Head => "HEAD",
        }
    }
}

/// A presigned URL for `key`. `expires` defaults to 6 h for GET, 1 h for PUT
/// and HEAD; the relay caps it at 7 days.
pub fn presign(key: &str, method: Method, expires: Option<Duration>) -> Result<String, String> {
    check_key(key)?;
    let body = match expires {
        Some(expires) => {
            json!({"key": key, "method": method.as_str(), "expires": expires.as_secs().max(1)})
        }
        None => json!({"key": key, "method": method.as_str()}),
    };
    let answer = relay_json("r2/url", &body)?;
    answer
        .get("url")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "the relay gave no URL".to_owned())
}

/// An object's size and identity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Head {
    pub size: u64,
    pub etag: Option<String>,
    pub content_type: Option<String>,
}

/// The object at `key`, or None when there isn't one.
pub fn head(key: &str) -> Result<Option<Head>, String> {
    check_key(key)?;
    crate::diag::time_on("cloud", "cloud: head", key, || {
        let answer = relay_json("r2/head", &json!({"key": key}))?;
        Ok(parse_head(&answer))
    })
}

fn parse_head(answer: &Value) -> Option<Head> {
    if answer["exists"].as_bool() != Some(true) {
        return None;
    }
    Some(Head {
        size: answer["size"].as_u64().unwrap_or(0),
        etag: answer["etag"].as_str().map(str::to_owned),
        content_type: answer["contentType"].as_str().map(str::to_owned),
    })
}

/// One listed object.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Object {
    pub key: String,
    pub size: u64,
}

/// Every object whose key starts with `prefix` (which must start with `edit/`).
pub fn list(prefix: &str) -> Result<Vec<Object>, String> {
    if !prefix.starts_with("edit/") {
        return Err(format!("not a cloud prefix Edit may use: {prefix:?}"));
    }
    crate::diag::time_on("cloud", "cloud: list", prefix, || {
        let mut objects = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let body = match &cursor {
                Some(cursor) => json!({"prefix": prefix, "cursor": cursor}),
                None => json!({"prefix": prefix}),
            };
            let answer = relay_json("r2/list", &body)?;
            let answer = &answer;
            for object in answer["objects"].as_array().into_iter().flatten() {
                if let Some(key) = object["key"].as_str() {
                    objects.push(Object {
                        key: key.to_owned(),
                        size: object["size"].as_u64().unwrap_or(0),
                    });
                }
            }
            match answer["cursor"].as_str() {
                Some(next) if !next.is_empty() => cursor = Some(next.to_owned()),
                _ => return Ok(objects),
            }
        }
    })
}

/// Deletes `keys` (missing ones are fine).
pub fn delete(keys: &[String]) -> Result<(), String> {
    for key in keys {
        check_key(key)?;
    }
    let subject = format!("{} keys", keys.len());
    crate::diag::time_on("cloud", "cloud: delete", &subject, || {
        for batch in keys.chunks(DELETE_BATCH) {
            relay_json("r2/delete", &json!({"keys": batch}))?;
        }
        Ok(())
    })
}

/// Uploads the file at `path` to `key`: one PUT under 64 MiB, else multipart.
/// `progress(sent, total)` is called as bytes go (from several threads).
pub fn upload_file(
    path: &Path,
    key: &str,
    progress: &(dyn Fn(u64, u64) + Sync),
) -> Result<(), String> {
    check_key(key)?;
    let subject = format!("{} → {key}", path.display());
    crate::diag::time_on("cloud", "cloud: upload file", &subject, || {
        let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
        let size = file.metadata().map_err(|error| error.to_string())?.len();
        let sent = upload(
            &mut file,
            key,
            Some(size),
            part_size(FILE_PART, Some(size)),
            FILE_PARALLEL,
            progress,
        )?;
        if sent != size {
            return Err(format!(
                "{} changed while uploading ({size} bytes, sent {sent})",
                path.display()
            ));
        }
        Ok(())
    })
}

/// Uploads everything `reader` gives to `key`, without a temp file: parts of
/// 32 MiB, two in flight (≤ 96 MiB in memory); one PUT if it all fits in the
/// first part. `size_hint` is the expected size (for progress and part size;
/// 0 total when unknown). Returns the bytes uploaded.
pub fn upload_stream(
    mut reader: impl Read,
    key: &str,
    size_hint: Option<u64>,
    progress: &(dyn Fn(u64, u64) + Sync),
) -> Result<u64, String> {
    check_key(key)?;
    crate::diag::time_on("cloud", "cloud: upload stream", key, || {
        upload(
            &mut reader,
            key,
            size_hint,
            part_size(STREAM_PART, size_hint),
            STREAM_PARALLEL,
            progress,
        )
    })
}

/// `base`, or bigger (whole MiB) when the size would need over 10,000 parts.
fn part_size(base: u64, size: Option<u64>) -> u64 {
    let needed = size.unwrap_or(0).div_ceil(MAX_PARTS).div_ceil(MIB) * MIB;
    base.max(needed)
}

/// Progress over parts in flight: never goes backwards (a retried part's
/// bytes count again only once they pass what was already reported).
struct Progress<'a> {
    sent: AtomicU64,
    reported: AtomicU64,
    total: u64,
    report: &'a (dyn Fn(u64, u64) + Sync),
}

impl Progress<'_> {
    fn add(&self, bytes: u64) {
        let sent = self.sent.fetch_add(bytes, Ordering::Relaxed) + bytes;
        if self.reported.fetch_max(sent, Ordering::Relaxed) < sent {
            (self.report)(sent, self.total);
        }
    }
    fn take_back(&self, bytes: u64) {
        self.sent.fetch_sub(bytes, Ordering::Relaxed);
    }
}

/// Reads up to `size` bytes (fewer only at the end of the stream).
fn read_part(reader: &mut dyn Read, size: u64) -> Result<Vec<u8>, String> {
    let mut part = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
    reader
        .take(size)
        .read_to_end(&mut part)
        .map_err(|error| format!("reading the upload: {error}"))?;
    Ok(part)
}

fn content_type(key: &str) -> String {
    mime_guess::from_path(key)
        .first_or_octet_stream()
        .essence_str()
        .to_owned()
}

fn upload(
    reader: &mut dyn Read,
    key: &str,
    total: Option<u64>,
    part: u64,
    parallel: usize,
    report: &(dyn Fn(u64, u64) + Sync),
) -> Result<u64, String> {
    let progress = Progress {
        sent: AtomicU64::new(0),
        reported: AtomicU64::new(0),
        total: total.unwrap_or(0),
        report,
    };
    let kind = content_type(key);
    let first = read_part(reader, part)?;
    if (first.len() as u64) < part {
        // It all fits in one request.
        retry(&format!("upload of {key}"), || {
            let url = presign(key, Method::Put, None)?;
            put(&url, &first, Some(&kind), &progress).map(|_| ())
        })?;
        let size = first.len() as u64;
        report(size, total.unwrap_or(size));
        return Ok(size);
    }
    let created = relay_json(
        "r2/multipart/create",
        &json!({"key": key, "contentType": kind}),
    )?;
    let upload_id = created
        .get("uploadId")
        .and_then(Value::as_str)
        .ok_or("the relay gave no upload id")?
        .to_owned();
    let result = multipart(reader, key, &upload_id, first, part, parallel, &progress);
    match result {
        Ok(size) => {
            report(size, total.unwrap_or(size));
            Ok(size)
        }
        Err(error) => {
            if let Err(abort) = relay_json(
                "r2/multipart/abort",
                &json!({"key": key, "uploadId": upload_id}),
            ) {
                crate::diag::warn(
                    "cloud",
                    format!("couldn't abort the upload of {key}: {abort}"),
                );
            }
            Err(error)
        }
    }
}

/// Sends the parts (the first already read) through `parallel` workers and
/// completes the upload; the total size.
fn multipart(
    reader: &mut dyn Read,
    key: &str,
    upload_id: &str,
    first: Vec<u8>,
    part: u64,
    parallel: usize,
    progress: &Progress,
) -> Result<u64, String> {
    let failed = AtomicBool::new(false);
    let error: Mutex<Option<String>> = Mutex::new(None);
    let etags: Mutex<Vec<(u64, String)>> = Mutex::new(Vec::new());
    let mut size = 0u64;
    let (sender, receiver) = sync_channel::<(u64, Vec<u8>)>(0);
    let receiver = Mutex::new(receiver);
    std::thread::scope(|scope| {
        for _ in 0..parallel.max(1) {
            scope.spawn(|| loop {
                let Ok((number, data)) = receiver.lock().recv() else {
                    return;
                };
                // After a failure, keep taking parts (so the reader never
                // waits on nobody) but drop them.
                if failed.load(Ordering::Relaxed) {
                    continue;
                }
                match put_part(key, upload_id, number, &data, progress) {
                    Ok(etag) => etags.lock().push((number, etag)),
                    Err(why) => {
                        failed.store(true, Ordering::Relaxed);
                        error.lock().get_or_insert(why);
                    }
                }
            });
        }
        let mut number = 1u64;
        let mut data = first;
        loop {
            let length = data.len() as u64;
            size += length;
            if sender.send((number, data)).is_err() {
                break;
            }
            if length < part || failed.load(Ordering::Relaxed) {
                break;
            }
            data = match read_part(reader, part) {
                Ok(next) if next.is_empty() => break,
                Ok(next) => next,
                Err(why) => {
                    failed.store(true, Ordering::Relaxed);
                    error.lock().get_or_insert(why);
                    break;
                }
            };
            number += 1;
            if number > MAX_PARTS {
                failed.store(true, Ordering::Relaxed);
                error
                    .lock()
                    .get_or_insert(format!("{key} needs more than {MAX_PARTS} parts"));
                break;
            }
        }
        drop(sender);
    });
    if let Some(why) = error.into_inner() {
        return Err(why);
    }
    let mut etags = etags.into_inner();
    etags.sort_by_key(|(number, _)| *number);
    let parts: Vec<Value> = etags
        .iter()
        .map(|(number, etag)| json!({"partNumber": number, "etag": etag}))
        .collect();
    let done = relay_json(
        "r2/multipart/complete",
        &json!({"key": key, "uploadId": upload_id, "parts": parts}),
    )?;
    match done.get("size").and_then(Value::as_u64) {
        Some(stored) if stored != size => Err(format!(
            "{key} came out {stored} bytes in the cloud, not {size}"
        )),
        _ => Ok(size),
    }
}

/// One part, retried with a fresh URL; its ETag.
fn put_part(
    key: &str,
    upload_id: &str,
    number: u64,
    data: &[u8],
    progress: &Progress,
) -> Result<String, String> {
    retry(&format!("part {number} of {key}"), || {
        let answer = relay_json(
            "r2/multipart/urls",
            &json!({"key": key, "uploadId": upload_id, "parts": [number]}),
        )?;
        let url = answer
            .pointer(&format!("/urls/{number}"))
            .and_then(Value::as_str)
            .ok_or("the relay gave no part URL")?;
        put(url, data, None, progress)?.ok_or_else(|| "R2 gave no ETag for the part".to_owned())
    })
}

/// Runs `attempt` up to ATTEMPTS times, waiting 2, 4, 8 s between.
fn retry<T>(what: &str, mut attempt: impl FnMut() -> Result<T, String>) -> Result<T, String> {
    let mut tries = 0;
    loop {
        tries += 1;
        match attempt() {
            Ok(value) => return Ok(value),
            Err(why) if tries >= ATTEMPTS => return Err(why),
            Err(why) => {
                crate::diag::warn("cloud", format!("{what} failed (try {tries}): {why}"));
                std::thread::sleep(Duration::from_secs(1 << tries));
            }
        }
    }
}

/// PUTs `data` to a presigned URL, fed through curl's stdin a MiB at a time
/// (that's the progress); the ETag R2 answered with.
fn put(
    url: &str,
    data: &[u8],
    content_type: Option<&str>,
    progress: &Progress,
) -> Result<Option<String>, String> {
    let mut command = Command::new("curl");
    command
        .args(["-sS", "-X", "PUT", "-T", "-"])
        .args(STALL)
        // An exact length, not chunked: S3 wants Content-Length.
        .args(["-H", &format!("Content-Length: {}", data.len())])
        .args(["-H", "Transfer-Encoding:", "-H", "Expect:"]);
    if let Some(kind) = content_type {
        command.args(["-H", &format!("Content-Type: {kind}")]);
    }
    let mut child = command
        .args(["-w", "\n%{http_code} %header{etag}", url])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("curl: {error}"))?;
    let mut written = 0u64;
    if let Some(mut stdin) = child.stdin.take() {
        for chunk in data.chunks(MIB as usize) {
            // A broken pipe means curl stopped; its output says why.
            if stdin.write_all(chunk).is_err() {
                break;
            }
            written += chunk.len() as u64;
            progress.add(chunk.len() as u64);
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("curl: {error}"));
    let result = output.and_then(|output| {
        if !output.status.success() {
            return Err(format!(
                "could not reach R2: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let (body, status) = text.rsplit_once('\n').unwrap_or(("", &text));
        let (code, etag) = status.split_once(' ').unwrap_or((status, ""));
        if code != "200" {
            return Err(format!(
                "R2 refused the upload ({code}): {}",
                r2_message(body)
            ));
        }
        let etag = etag.trim();
        Ok((!etag.is_empty()).then(|| etag.to_owned()))
    });
    if result.is_err() {
        progress.take_back(written);
    }
    result
}

/// The `<Message>` of an S3 error body, else its start.
fn r2_message(body: &str) -> String {
    let between = |tag: &str| {
        let open = format!("<{tag}>");
        let start = body.find(&open)? + open.len();
        let rest = body.get(start..)?;
        rest.get(..rest.find(&format!("</{tag}>"))?)
    };
    match (between("Code"), between("Message")) {
        (Some(code), Some(message)) => format!("{code}: {message}"),
        _ => body.trim().chars().take(300).collect(),
    }
}

/// Downloads `key` to `dest`, through `dest.partial` (a later call carries on
/// from it while the object is unchanged: `dest.partial.etag` says which
/// version it holds). `progress(received, total)`.
pub fn download(key: &str, dest: &Path, progress: &dyn Fn(u64, u64)) -> Result<(), String> {
    check_key(key)?;
    crate::diag::time_on("cloud", "cloud: download", key, || {
        let object = head(key)?.ok_or_else(|| format!("{key} isn't in the cloud"))?;
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let partial = partial_path(dest);
        let mut version = partial.clone().into_os_string();
        version.push(".etag");
        let version = PathBuf::from(version);
        let etag = object.etag.clone().unwrap_or_default();
        if std::fs::read_to_string(&version).ok().as_deref() != Some(etag.as_str()) {
            // Bytes of another version (or of unknown origin): start over.
            let _ = std::fs::remove_file(&partial);
            std::fs::write(&version, &etag).map_err(|error| error.to_string())?;
        }
        if object.size == 0 {
            // curl writes no file for an empty body.
            std::fs::write(&partial, b"").map_err(|error| error.to_string())?;
        }
        retry(&format!("download of {key}"), || {
            fetch(key, &object, &partial, progress)
        })?;
        let got = std::fs::metadata(&partial)
            .map(|meta| meta.len())
            .unwrap_or(0);
        if got != object.size {
            let _ = std::fs::remove_file(&partial);
            return Err(format!("{key}: got {got} bytes of {}", object.size));
        }
        std::fs::rename(&partial, dest).map_err(|error| error.to_string())?;
        let _ = std::fs::remove_file(&version);
        progress(object.size, object.size);
        Ok(())
    })
}

fn partial_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".partial");
    dest.with_file_name(name)
}

/// One try at getting the rest of `object` into `partial`.
fn fetch(
    key: &str,
    object: &Head,
    partial: &Path,
    progress: &dyn Fn(u64, u64),
) -> Result<(), String> {
    let size_of = |path: &Path| std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    let mut have = size_of(partial);
    if have > object.size {
        let _ = std::fs::remove_file(partial);
        have = 0;
    }
    if have == object.size && partial.exists() {
        return Ok(());
    }
    let url = presign(key, Method::Get, Some(Duration::from_secs(3600)))?;
    let mut command = Command::new("curl");
    command
        .args(["-sS", "--fail"])
        .args(STALL)
        .args(["-w", "%{http_code} %header{etag}", "-o"])
        .arg(partial);
    if have > 0 {
        command.args(["-C", "-"]);
        // S3 sends the whole (changed) object instead; R2 ignores If-Range,
        // so the ETag it answers with is checked below too.
        if let Some(etag) = &object.etag {
            command.args(["-H", &format!("If-Range: {etag}")]);
        }
    }
    let mut child = command
        .arg(&url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("curl: {error}"))?;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                progress(size_of(partial), object.size);
                std::thread::sleep(Duration::from_millis(250));
            }
            Err(error) => return Err(format!("curl: {error}")),
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("curl: {error}"))?;
    let written = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let (code, etag) = written.split_once(' ').unwrap_or((&written, ""));
    let changed = matches!((&object.etag, etag.trim()), (Some(expected), got) if !got.is_empty() && got != expected);
    if changed {
        let _ = std::fs::remove_file(partial);
        return Err(format!(
            "{key} changed while downloading; download it again"
        ));
    }
    if output.status.success() {
        return Ok(());
    }
    // 33: the server ignored the range; 416: nothing past what we have.
    // Either way start again from nothing.
    if output.status.code() == Some(33) || code == "416" || code == "200" {
        let _ = std::fs::remove_file(partial);
    }
    Err(format!(
        "downloading {key} ({code}): {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

/// Calls a Convex function in Edit's `edit` module through the relay (which
/// adds the service token). `kind` is "query", "mutation" or "action";
/// `path` like "edit:getProject"; the function's value, or its error.
pub fn convex(kind: &str, path: &str, args: Value) -> Result<Value, String> {
    convex_call(kind, path, args, 120).map_err(|failure| failure.to_string())
}

/// Why a Convex call failed: the relay couldn't be reached (offline), the
/// relay refused it (a bad token, a bad request), or the function threw;
/// then `code` is its `errorData.code` (Edit's functions use `conflict`,
/// `locked`, `missing_body` and `invalid`) and `data` the whole `errorData`.
#[derive(Clone, Debug, PartialEq)]
pub enum ConvexFailure {
    Unreachable(String),
    Relay(String),
    Function {
        message: String,
        code: Option<String>,
        data: Value,
    },
}

impl ConvexFailure {
    /// The function's error code (`conflict`, `locked`, …), if it threw one.
    pub fn code(&self) -> Option<&str> {
        match self {
            ConvexFailure::Function { code, .. } => code.as_deref(),
            _ => None,
        }
    }
}

impl std::fmt::Display for ConvexFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConvexFailure::Unreachable(message) | ConvexFailure::Relay(message) => {
                f.write_str(message)
            }
            ConvexFailure::Function { message, .. } => write!(f, "Convex: {message}"),
        }
    }
}

/// [`convex`] with its failure kept apart (see [`ConvexFailure`]) and a
/// timeout in seconds.
pub fn convex_call(
    kind: &str,
    path: &str,
    args: Value,
    timeout: u64,
) -> Result<Value, ConvexFailure> {
    if !matches!(kind, "query" | "mutation" | "action") {
        return Err(ConvexFailure::Relay(format!(
            "not a Convex function kind: {kind}"
        )));
    }
    if !args.is_object() {
        return Err(ConvexFailure::Relay(
            "Convex args must be an object".to_owned(),
        ));
    }
    crate::diag::time_on("cloud", &format!("cloud: convex {kind}"), path, || {
        let answer = crate::relay::json(
            "POST",
            "/v1/cloud/convex",
            Some(&json!({"kind": kind, "path": path, "args": args})),
            "cloud storage",
            timeout,
        )
        .map_err(|error| {
            if error.starts_with(crate::relay::UNREACHABLE) {
                ConvexFailure::Unreachable(error)
            } else {
                ConvexFailure::Relay(error)
            }
        })?;
        convex_value(answer)
    })
}

/// A Convex query (see [`convex`]).
pub fn query(path: &str, args: Value) -> Result<Value, String> {
    convex("query", path, args)
}

/// A Convex mutation (see [`convex`]).
pub fn mutation(path: &str, args: Value) -> Result<Value, String> {
    convex("mutation", path, args)
}

/// Convex's `{status: "success", value}` / `{status: "error", errorMessage,
/// errorData}`. A ConvexError's own message (`errorData.message`) is
/// preferred: `errorMessage` wraps it in Convex's "Uncaught ConvexError: …".
fn convex_value(mut answer: Value) -> Result<Value, ConvexFailure> {
    let text = |name: &str| answer.get(name).and_then(Value::as_str);
    match text("status") {
        Some("success") => Ok(answer
            .get_mut("value")
            .map(Value::take)
            .unwrap_or(Value::Null)),
        Some("error") => {
            let data = answer.get("errorData").cloned().unwrap_or(Value::Null);
            let message = data
                .get("message")
                .and_then(Value::as_str)
                .or(text("errorMessage"))
                .unwrap_or("unknown error")
                .to_owned();
            let code = data.get("code").and_then(Value::as_str).map(str::to_owned);
            Err(ConvexFailure::Function {
                message,
                code,
                data,
            })
        }
        _ => Err(ConvexFailure::Relay(format!(
            "unexpected answer from Convex: {}",
            answer.to_string().chars().take(300).collect::<String>()
        ))),
    }
}

/// `edit cloud …`: try the cloud by hand (EDIT_RELAY_URL / EDIT_RELAY_TOKEN).
pub fn run_cli(args: &[String]) {
    fn fail(message: String) -> ! {
        crate::fail(&message)
    }
    let arg = |index: usize| args.get(index).map(String::as_str);
    let flag = |name: &str| {
        args.iter()
            .position(|arg| arg == name)
            .and_then(|index| args.get(index + 1))
            .map(String::as_str)
    };
    let need = |index: usize, what: &str| -> String {
        arg(index)
            .map(str::to_owned)
            .unwrap_or_else(|| fail(format!("give {what}\n\n{CLI_HELP}")))
    };
    if !enabled() {
        fail("set EDIT_RELAY_TOKEN (the relay's CLOUD_TOKEN) first".to_owned());
    }
    let show = |sent: u64, total: u64| {
        let mb = |bytes: u64| bytes as f64 / 1e6;
        if total > 0 {
            eprint!("\r{:.1} / {:.1} MB   ", mb(sent), mb(total));
        } else {
            eprint!("\r{:.1} MB   ", mb(sent));
        }
    };
    let result: Result<Value, String> = match arg(0) {
        Some("url") => {
            let method = match arg(2).unwrap_or("GET") {
                "GET" => Method::Get,
                "PUT" => Method::Put,
                "HEAD" => Method::Head,
                other => fail(format!("unknown method {other}")),
            };
            let expires = flag("--expires")
                .map(|secs| secs.parse().map(Duration::from_secs))
                .transpose()
                .unwrap_or_else(|_| fail("--expires takes seconds".to_owned()));
            presign(&need(1, "a key"), method, expires).map(Value::String)
        }
        Some("put") => {
            let (source, key) = (need(1, "a file (or - for stdin)"), need(2, "a key"));
            let size = flag("--size").map(|size| {
                size.parse::<u64>()
                    .unwrap_or_else(|_| fail("--size takes bytes".to_owned()))
            });
            let result = if source == "-" {
                upload_stream(std::io::stdin().lock(), &key, size, &show)
                    .map(|sent| json!({"key": key, "size": sent}))
            } else {
                upload_file(Path::new(&source), &key, &show).map(|()| json!({"key": key}))
            };
            eprintln!();
            result
        }
        Some("get") => {
            let (key, dest) = (need(1, "a key"), need(2, "a destination file"));
            let result = download(&key, Path::new(&dest), &show).map(|()| json!({"saved": dest}));
            eprintln!();
            result
        }
        Some("head") => head(&need(1, "a key")).map(|found| match found {
            Some(head) => {
                json!({"size": head.size, "etag": head.etag, "contentType": head.content_type})
            }
            None => Value::Null,
        }),
        Some("ls") => list(&need(1, "a prefix")).map(|objects| {
            objects
                .iter()
                .map(|object| json!({"key": object.key, "size": object.size}))
                .collect()
        }),
        Some("rm") => {
            let keys: Vec<String> = args.iter().skip(1).cloned().collect();
            delete(&keys).map(|()| json!({"deleted": keys.len()}))
        }
        Some("convex") => {
            let (kind, path) = (
                need(1, "query, mutation or action"),
                need(2, "a path (edit:…)"),
            );
            let args = arg(3)
                .map(serde_json::from_str)
                .transpose()
                .unwrap_or_else(|error| fail(format!("args: {error}")))
                .unwrap_or_else(|| json!({}));
            match kind.as_str() {
                "query" => query(&path, args),
                "mutation" => mutation(&path, args),
                _ => convex(&kind, &path, args),
            }
        }
        _ => {
            print!("{CLI_HELP}");
            return;
        }
    };
    match result {
        Ok(value) => println!(
            "{}",
            serde_json::to_string_pretty(&value).unwrap_or_default()
        ),
        Err(error) => fail(error),
    }
}

const CLI_HELP: &str = "edit cloud — Edit's cloud storage and Convex, through the relay

  edit cloud url KEY [GET|PUT|HEAD] [--expires SECS]   a presigned URL
  edit cloud put FILE KEY                              upload a file
  edit cloud put - KEY [--size BYTES]                  upload stdin (no temp file)
  edit cloud get KEY FILE                              download (resumes)
  edit cloud head KEY | ls PREFIX | rm KEY…
  edit cloud convex query|mutation|action edit:NAME ['{\"args\":1}']

Keys start with edit/. Needs EDIT_RELAY_TOKEN (the relay's CLOUD_TOKEN);
EDIT_RELAY_URL picks another relay (e.g. http://localhost:8787 for wrangler dev).
";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_stay_under_edit() {
        for key in ["edit/a.mp4", "edit/projects/p1/clip 1.mov"] {
            assert!(valid_key(key), "{key}");
        }
        for key in [
            "",
            "edit",
            "edit/",
            "edit//a",
            "edit/a/",
            "edit/../x",
            "edit/./a",
            "/edit/a",
            "repack/a",
            "editor/a",
            "edit/a\nb",
            "edit\\a",
        ] {
            assert!(!valid_key(key), "{key}");
        }
    }

    #[test]
    fn convex_answers_become_results() {
        assert_eq!(
            convex_value(json!({"status": "success", "value": {"id": 1}, "logLines": []})),
            Ok(json!({"id": 1}))
        );
        assert_eq!(convex_value(json!({"status": "success"})), Ok(Value::Null));
        let plain = convex_value(json!({"status": "error", "errorMessage": "Uncaught Error: no"}))
            .unwrap_err();
        assert_eq!(plain.to_string(), "Convex: Uncaught Error: no");
        assert_eq!(plain.code(), None);
        // A ConvexError keeps its code and data (Edit's `conflict`, `locked`, …).
        let conflict = convex_value(json!({
            "status": "error",
            "errorMessage": "Uncaught ConvexError: {...}",
            "errorData": {"code": "conflict", "message": "saved elsewhere", "rev": 7},
        }))
        .unwrap_err();
        assert_eq!(conflict.code(), Some("conflict"));
        assert_eq!(conflict.to_string(), "Convex: saved elsewhere");
        match conflict {
            ConvexFailure::Function { data, .. } => assert_eq!(data["rev"], 7),
            other => panic!("{other:?}"),
        }
        assert!(convex_value(json!({"what": 1})).is_err());
    }

    #[test]
    fn parts_grow_only_for_huge_uploads() {
        assert_eq!(part_size(FILE_PART, None), FILE_PART);
        assert_eq!(part_size(FILE_PART, Some(200 * MIB)), FILE_PART);
        let huge = 1024 * 1024 * MIB; // 1 TiB
        let part = part_size(FILE_PART, Some(huge));
        assert!(part > FILE_PART && part.is_multiple_of(MIB) && huge.div_ceil(part) <= MAX_PARTS);
    }

    #[test]
    fn parts_read_whole_until_the_end() {
        let data: Vec<u8> = (0..250u32).map(|n| n as u8).collect();
        let mut reader = std::io::Cursor::new(data);
        assert_eq!(read_part(&mut reader, 100).unwrap().len(), 100);
        assert_eq!(read_part(&mut reader, 100).unwrap().len(), 100);
        assert_eq!(read_part(&mut reader, 100).unwrap().len(), 50);
        assert!(read_part(&mut reader, 100).unwrap().is_empty());
    }

    #[test]
    fn progress_never_goes_backwards() {
        let seen = Mutex::new(Vec::new());
        let report = |sent: u64, total: u64| seen.lock().push((sent, total));
        let progress = Progress {
            sent: AtomicU64::new(0),
            reported: AtomicU64::new(0),
            total: 10,
            report: &report,
        };
        progress.add(4);
        progress.take_back(4); // the part failed; its retry sends it again
        progress.add(3);
        progress.add(3);
        assert_eq!(*seen.lock(), vec![(4, 10), (6, 10)]);
    }

    #[test]
    fn r2_errors_read_well() {
        assert_eq!(
            r2_message("<?xml?><Error><Code>NoSuchUpload</Code><Message>gone</Message></Error>"),
            "NoSuchUpload: gone"
        );
        assert_eq!(r2_message(" plain "), "plain");
        assert_eq!(
            partial_path(Path::new("/a/b.mp4")),
            PathBuf::from("/a/b.mp4.partial")
        );
    }

    /// Against a real relay (EDIT_RELAY_URL / EDIT_RELAY_TOKEN; e.g. `wrangler
    /// dev` with apps/relay/.dev.vars): `cargo test -p edit cloud::tests::live -- --ignored`.
    /// Uses and cleans up `edit/test/live-<pid>/`.
    #[test]
    #[ignore]
    fn live_stream_round_trip_and_failed_stream_aborts() {
        let prefix = format!("edit/test/live-{}/", std::process::id());
        // Two whole parts and a bit: a multipart upload from memory.
        let data: Vec<u8> = (0..(2 * STREAM_PART + 12_345))
            .map(|n| (n * 31 % 251) as u8)
            .collect();
        let key = format!("{prefix}stream.bin");
        let sent = upload_stream(&data[..], &key, Some(data.len() as u64), &|_, _| {}).unwrap();
        assert_eq!(sent, data.len() as u64);
        assert_eq!(head(&key).unwrap().unwrap().size, sent);
        let dest = std::env::temp_dir().join(format!("edit-cloud-live-{}", std::process::id()));
        download(&key, &dest, &|_, _| {}).unwrap();
        assert!(std::fs::read(&dest).unwrap() == data);
        let _ = std::fs::remove_file(&dest);

        // A reader that fails after one part: the upload is aborted, nothing stored.
        struct Failing(u64);
        impl Read for Failing {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.0 == 0 {
                    return Err(std::io::Error::other("Drive went away"));
                }
                let n = buf.len().min(self.0 as usize);
                buf[..n].fill(7);
                self.0 -= n as u64;
                Ok(n)
            }
        }
        let broken = format!("{prefix}broken.bin");
        let error =
            upload_stream(Failing(STREAM_PART + 10), &broken, None, &|_, _| {}).unwrap_err();
        assert!(error.contains("Drive went away"), "{error}");
        assert_eq!(head(&broken).unwrap(), None);

        let listed: Vec<String> = list(&prefix).unwrap().into_iter().map(|o| o.key).collect();
        assert_eq!(listed, vec![key.clone()]);
        delete(&listed).unwrap();
        assert!(list(&prefix).unwrap().is_empty());
    }
}
