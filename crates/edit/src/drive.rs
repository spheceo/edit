//! Subtitled videos on the team's Google Drive. A whole export of a subtitled
//! video is uploaded to the "Subtitles" folder (Repack's, where its own
//! renders go), anyone with the link may view it, and the project keeps the
//! link (`project.drive`) for as long as the file is on Drive: when the UI
//! shows the link it asks the server, which checks the file still exists and
//! clears the link when it was deleted or trashed. Edit never deletes a file
//! on Drive; a re-export uploads a new one and the project links to that.
//!
//! The sign-in is the sound library's (`Library::token`), and like it every
//! request goes through curl with the token on stdin.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use edit_core::{DriveFile, Project};
use parking_lot::Mutex;
use serde_json::{json, Value};

use crate::export::{ExportOptions, Format, Plan};
use crate::library::{curl, quote, Library};
use crate::store::Store;

/// "Subtitles" (My Drive / [03] Media / Repack / Subtitles): subtitled videos.
const SUBTITLES_FOLDER: &str = "12q4jbYhXI53BYZtTwOxzFEOJV2d1wJTk";
/// "Render": every other edit.
const RENDER_FOLDER: &str = "15Fp5Zq_RKwYRohpE5t_uEho8T2Q1RwwL";
const API: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3/files";
/// A link checked this recently isn't checked again.
const CHECKED_FOR: Duration = Duration::from_secs(5 * 60);

/// Uploads running, by project: the newest one's number, so an older upload
/// finishing late doesn't replace the newer one's link.
static UPLOADS: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(Default::default);
static NEXT_UPLOAD: LazyLock<Mutex<u64>> = LazyLock::new(Default::default);
/// When each file was last found on Drive.
static CHECKED: LazyLock<Mutex<HashMap<String, Instant>>> = LazyLock::new(Default::default);

/// Where a project's exports go: subtitled videos to Subtitles, the rest to Render.
fn folder(subtitled: bool) -> String {
    let (variable, default) = if subtitled {
        ("EDIT_SUBTITLES_FOLDER", SUBTITLES_FOLDER)
    } else {
        ("EDIT_RENDER_FOLDER", RENDER_FOLDER)
    };
    std::env::var(variable)
        .ok()
        .filter(|folder| !folder.is_empty())
        .unwrap_or_else(|| default.to_owned())
}

/// Where a Drive file opens.
pub fn view_url(file_id: &str) -> String {
    format!("https://drive.google.com/file/d/{file_id}/view")
}

/// The file's name on Drive: the project's, without a " (subtitles)" ending.
pub fn upload_name(project: &str, extension: &str) -> String {
    let name = project.trim();
    let name = name
        .strip_suffix("(subtitles)")
        .or_else(|| name.strip_suffix("(Subtitles)"))
        .map_or(name, str::trim_end);
    let name = if name.is_empty() { "Edit" } else { name };
    format!("{name}.{extension}")
}

/// Whether an export is uploaded: a video file (MP4 or MOV) of all of it.
pub fn wanted(project: &Project, options: &ExportOptions, plan: &Plan) -> bool {
    matches!(options.format, Format::H264 | Format::Hevc | Format::Prores)
        && plan.start == 0
        && plan.end >= project.duration()
        && project.duration() > 0
}

/// Whether any upload is running (an update waits for it).
pub fn uploading() -> bool {
    !UPLOADS.lock().is_empty()
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("mov") => "video/quicktime",
        _ => "video/mp4",
    }
}

/// Uploads `path` (an export of `project`) in the background, reporting to the
/// UI as `{type: "drive", id, state: uploading | done | failed, progress, url, error}`
/// events, and on success links the project to it.
pub fn start(store: Arc<Store>, library: Arc<Library>, project: &Project, path: PathBuf) {
    let id = project.id.clone();
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("mp4")
        .to_ascii_lowercase();
    let name = upload_name(&project.name, &extension);
    // A re-export replaces the file it made before, so its link stays the same.
    let replacing = project.drive.as_ref().map(|file| file.file_id.clone());
    let into = folder(crate::subtitles::is_subtitled(project));
    let number = {
        let mut next = NEXT_UPLOAD.lock();
        *next += 1;
        *next
    };
    UPLOADS.lock().insert(id.clone(), number);
    std::thread::spawn(move || {
        let emit = |state: &str, extra: Value| {
            let mut event = json!({ "type": "drive", "id": id, "state": state, "name": name });
            if let (Some(event), Some(extra)) = (event.as_object_mut(), extra.as_object()) {
                event.extend(extra.clone());
            }
            store.emit(event);
        };
        emit("uploading", json!({ "progress": 0.0 }));
        let subject = format!("{} ({})", path.display(), id);
        let result = crate::diag::time_on("drive", "drive upload", &subject, || {
            crate::guard::catch("the Drive upload", || {
                upload(
                    &library,
                    &path,
                    &name,
                    &into,
                    replacing.as_deref(),
                    |progress| emit("uploading", json!({ "progress": progress })),
                )
            })
            .and_then(|result| result)
        });
        let latest = UPLOADS.lock().get(&id) == Some(&number);
        let result = result.and_then(|file| {
            if latest {
                store.update(&id, "drive", |project| {
                    project.drive = Some(file.clone());
                    Ok(())
                })?;
            }
            Ok(file)
        });
        match result {
            Ok(file) => {
                crate::diag::info("drive", format!("uploaded {} to Drive", path.display()));
                CHECKED.lock().insert(file.file_id.clone(), Instant::now());
                emit("done", json!({ "progress": 1.0, "url": file.url }));
            }
            Err(error) => emit("failed", json!({ "error": error })),
        }
        let mut uploads = UPLOADS.lock();
        if uploads.get(&id) == Some(&number) {
            uploads.remove(&id);
        }
    });
}

/// Drive's resumable upload: a session for the file in the folder (or for new
/// contents of `replacing`, keeping its link; a new file if that one is gone),
/// then its bytes streamed from disk, then a link anyone can view.
fn upload(
    library: &Library,
    path: &Path,
    name: &str,
    into: &str,
    replacing: Option<&str>,
    mut progress: impl FnMut(f32),
) -> Result<DriveFile, String> {
    let size = std::fs::metadata(path)
        .map_err(|error| format!("can't read {}: {error}", path.display()))?
        .len();
    let mime = mime(path);
    let session = |replace: Option<&str>| -> Result<(u16, String), String> {
        let metadata = match replace {
            Some(_) => json!({ "name": name }),
            None => json!({ "name": name, "parents": [into] }),
        }
        .to_string();
        let config = [
            format!("Authorization: Bearer {}", library.token()?),
            "Content-Type: application/json; charset=UTF-8".to_owned(),
            format!("X-Upload-Content-Type: {mime}"),
            format!("X-Upload-Content-Length: {size}"),
        ]
        .iter()
        .map(|header| Ok(format!("header = {}\n", quote(header)?)))
        .chain([Ok(format!("data-binary = {}\n", quote(&metadata)?))])
        .collect::<Result<String, String>>()?;
        let (url, method) = match replace {
            Some(file) => (
                format!(
                    "{UPLOAD}/{}?uploadType=resumable&supportsAllDrives=true&fields=id",
                    crate::library::encode(file)
                ),
                "PATCH",
            ),
            None => (
                format!("{UPLOAD}?uploadType=resumable&supportsAllDrives=true&fields=id"),
                "POST",
            ),
        };
        let (code, answer) = curl(
            &config,
            &["--max-time", "60", "-X", method, "-D", "-", &url],
        )?;
        Ok((code, String::from_utf8_lossy(&answer).into_owned()))
    };
    let mut replaced = replacing.is_some();
    // A dropped connection or a busy Drive mid-upload starts a new session
    // and sends the file again (a few times), rather than failing the export
    // and leaving the user to upload by hand.
    let mut tries = 0;
    let (code, body) = loop {
        tries += 1;
        let (mut code, mut answer) = session(replacing.filter(|_| replaced))?;
        if replaced && code == 404 {
            // Deleted on Drive since: a new file, and a new link.
            (code, answer) = session(None)?;
            replaced = false;
        }
        if code != 200 {
            return Err(drive_error(code, body_of(&answer)));
        }
        let session = location(&answer).ok_or("Google Drive didn't start the upload")?;
        let sent = put(&session, path, mime, &mut progress);
        let retry = match &sent {
            Err(_) => true,
            Ok((code, _)) => *code == 429 || *code >= 500 || *code == 0,
        };
        if !retry || tries >= 3 {
            break sent?;
        }
        crate::diag::warn(
            "drive",
            format!(
                "uploading {name}, try {tries}: {}; trying again",
                match &sent {
                    Err(error) => error.clone(),
                    Ok((code, body)) => drive_error(*code, body),
                }
            ),
        );
        std::thread::sleep(std::time::Duration::from_secs(2 * tries));
    };
    if !(200..300).contains(&code) {
        return Err(drive_error(code, &body));
    }
    let file_id = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|value| value.get("id")?.as_str().map(str::to_owned))
        .ok_or("Google Drive didn't say what the uploaded file is")?;
    // A replaced file's link was shared when it was first uploaded.
    let shared = if replaced {
        Ok(())
    } else {
        share(library, &file_id)
    };
    if let Err(error) = shared {
        // The team still sees it in the folder; only the link for others fails.
        crate::diag::warn(
            "drive",
            format!("sharing {name} ({file_id}) by link: {error}"),
        );
    }
    Ok(DriveFile {
        url: view_url(&file_id),
        file_id,
        name: name.to_owned(),
        uploaded_ms: crate::store::now_ms(),
    })
}

/// Lets anyone with the link view the file.
fn share(library: &Library, file_id: &str) -> Result<(), String> {
    let config = format!(
        "header = {}\nheader = {}\ndata-binary = {}\n",
        quote(&format!("Authorization: Bearer {}", library.token()?))?,
        quote("Content-Type: application/json")?,
        quote(r#"{"type":"anyone","role":"reader"}"#)?
    );
    let url = format!(
        "{API}/files/{}/permissions?supportsAllDrives=true",
        crate::library::encode(file_id)
    );
    let (code, body) = curl(&config, &["--max-time", "30", &url])?;
    if code != 200 {
        return Err(drive_error(code, &String::from_utf8_lossy(&body)));
    }
    Ok(())
}

/// PUTs the file to the upload session (the session's address is all the
/// sign-in it needs), calling `progress` as it goes. Returns the status and body.
fn put(
    session: &str,
    path: &Path,
    mime: &str,
    mut progress: impl FnMut(f32),
) -> Result<(u16, String), String> {
    let config = format!(
        "url = {}\nheader = {}\nheader = {}\n",
        quote(session)?,
        quote(&format!("Content-Type: {mime}"))?,
        // No waiting for a 100 Continue before the bytes.
        quote("Expect:")?
    );
    let mut child = Command::new("curl")
        .args(["-#", "-S", "--proto", "=https", "--config", "-"])
        .args(["--connect-timeout", "30", "-w", "\n%{http_code}"])
        .arg("--upload-file")
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("curl: {error}"))?;
    let written = child
        .stdin
        .take()
        .ok_or("curl stdin")
        .and_then(|mut stdin| stdin.write_all(config.as_bytes()).map_err(|_| "curl stdin"));
    let mut stdout = child.stdout.take().ok_or("curl stdout")?;
    let reading = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    // curl's progress bar: "######     45.2%" lines ended by carriage returns.
    let mut said = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let (mut line, mut buffer, mut last) = (Vec::new(), [0u8; 4096], -1.0f32);
        while let Ok(read) = stderr.read(&mut buffer) {
            if read == 0 {
                break;
            }
            for &byte in buffer.get(..read).unwrap_or_default() {
                if byte != b'\r' && byte != b'\n' {
                    line.push(byte);
                    continue;
                }
                let text = String::from_utf8_lossy(&line).into_owned();
                line.clear();
                match percent(&text) {
                    Some(share) if share - last >= 0.01 || (share >= 1.0 && last < 1.0) => {
                        last = share;
                        progress(share);
                    }
                    Some(_) => {}
                    None if !text.trim().is_empty() => said = text.trim().to_owned(),
                    None => {}
                }
            }
        }
        if percent(&String::from_utf8_lossy(&line)).is_none() && !line.is_empty() {
            said = String::from_utf8_lossy(&line).trim().to_owned();
        }
    }
    let status = child.wait().map_err(|error| format!("curl: {error}"))?;
    let out = reading.join().unwrap_or_default();
    written?;
    if !status.success() {
        return Err(format!("couldn't upload to Google Drive: {said}"));
    }
    let out = String::from_utf8_lossy(&out);
    let (body, code) = out.rsplit_once('\n').unwrap_or(("", &out));
    Ok((code.trim().parse().unwrap_or(0), body.to_owned()))
}

/// What curl's progress bar says, as a share (0–1).
fn percent(line: &str) -> Option<f32> {
    let number = line.trim().strip_suffix('%')?.split_whitespace().last()?;
    let number = number.trim_start_matches('#');
    let value: f32 = number.parse().ok()?;
    (0.0..=100.0).contains(&value).then_some(value / 100.0)
}

/// The `Location` header of a response printed headers first (`-D -`).
fn location(answer: &str) -> Option<String> {
    let head = answer.split("\r\n\r\n").next()?;
    let url = head.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("location")
            .then(|| value.trim().to_owned())
    })?;
    // Only ever Google's upload address: the bytes go nowhere else.
    url.starts_with("https://www.googleapis.com/")
        .then_some(url)
}

/// The body of a response printed headers first.
fn body_of(answer: &str) -> &str {
    answer
        .rsplit_once("\r\n\r\n")
        .map_or(answer, |(_, body)| body)
}

fn drive_error(code: u16, body: &str) -> String {
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let message = value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("request failed");
    match code {
        401 | 403 => format!("Google Drive refused the upload ({code}): {message}"),
        404 => "Google Drive can't find the Subtitles folder.".into(),
        _ => format!("Google Drive answered {code}: {message}"),
    }
}

/// Whether the file is still on Drive (not deleted or in the trash). An
/// error means it couldn't be told (offline, no sign-in): keep the link.
fn exists(library: &Library, file_id: &str) -> Result<bool, String> {
    let config = format!(
        "header = {}\n",
        quote(&format!("Authorization: Bearer {}", library.token()?))?
    );
    let url = format!(
        "{API}/files/{}?fields=trashed&supportsAllDrives=true",
        crate::library::encode(file_id)
    );
    let (code, body) = curl(&config, &["--max-time", "20", &url])?;
    answer_exists(code, &String::from_utf8_lossy(&body))
}

fn answer_exists(code: u16, body: &str) -> Result<bool, String> {
    match code {
        404 => Ok(false),
        200 => Ok(!serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|value| value.get("trashed")?.as_bool())
            .unwrap_or(false)),
        _ => Err(drive_error(code, body)),
    }
}

/// The project's Drive link, after checking (at most every few minutes) that
/// the file is still there; a link to a deleted or trashed file is cleared.
pub fn checked(store: &Store, library: &Library, id: &str) -> Result<Option<DriveFile>, String> {
    let live = store.get(id).ok_or("no such project")?;
    let Some(file) = live.project.drive else {
        return Ok(None);
    };
    let fresh = CHECKED
        .lock()
        .get(&file.file_id)
        .is_some_and(|at| at.elapsed() < CHECKED_FOR);
    if fresh {
        return Ok(Some(file));
    }
    match exists(library, &file.file_id) {
        Ok(true) => {
            CHECKED.lock().insert(file.file_id.clone(), Instant::now());
            Ok(Some(file))
        }
        Ok(false) => {
            crate::diag::info(
                "drive",
                format!("{} is gone from Drive; unlinking it from {id}", file.name),
            );
            store.update(id, "drive", |project| {
                if project
                    .drive
                    .as_ref()
                    .is_some_and(|drive| drive.file_id == file.file_id)
                {
                    project.drive = None;
                }
                Ok(())
            })?;
            Ok(None)
        }
        Err(error) => {
            crate::diag::warn(
                "drive",
                format!("checking {} ({}) on Drive: {error}", file.name, id),
            );
            Ok(Some(file))
        }
    }
}

/// For other live tests (`cloud_media`): puts `path` in the Subtitles folder
/// as `name`, viewable by anyone with the link; its id. [`test_delete`] removes it.
#[cfg(test)]
pub(crate) fn test_upload(path: &Path, name: &str) -> Result<String, String> {
    upload(&Library::default(), path, name, &folder(true), None, |_| {}).map(|file| file.file_id)
}

/// Deletes a file [`test_upload`] made (only tests delete Drive files).
#[cfg(test)]
pub(crate) fn test_delete(file_id: &str) -> Result<(), String> {
    let config = format!(
        "header = {}\n",
        quote(&format!(
            "Authorization: Bearer {}",
            Library::default().token()?
        ))?
    );
    let url = format!("{API}/files/{file_id}?supportsAllDrives=true");
    match curl(&config, &["--max-time", "20", "-X", "DELETE", &url])? {
        (204, _) => Ok(()),
        (code, body) => Err(format!(
            "deleting {file_id}: {code} {}",
            String::from_utf8_lossy(&body)
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_links() {
        assert_eq!(
            upload_name("Teen Hit-And-Run (subtitles)", "mp4"),
            "Teen Hit-And-Run.mp4"
        );
        assert_eq!(upload_name("  Case  ", "mov"), "Case.mov");
        assert_eq!(upload_name("(subtitles)", "mp4"), "Edit.mp4");
        assert_eq!(view_url("abc"), "https://drive.google.com/file/d/abc/view");
        assert_eq!(mime(Path::new("a.MOV")), "video/quicktime");
        assert_eq!(mime(Path::new("a.mp4")), "video/mp4");
    }

    #[test]
    fn reads_curl_progress() {
        assert_eq!(percent("######                      45.0%"), Some(0.45));
        assert_eq!(
            percent("##########################################  100.0%"),
            Some(1.0)
        );
        assert_eq!(percent("curl: (56) Recv failure"), None);
        assert_eq!(percent(""), None);
    }

    #[test]
    fn finds_the_upload_session() {
        let answer = "HTTP/2 200\r\nx-guploader-uploadid: abc\r\nLocation: https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=xyz\r\ncontent-length: 0\r\n\r\n";
        assert_eq!(
            location(answer).as_deref(),
            Some("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=xyz")
        );
        assert_eq!(
            location("HTTP/2 200\r\nlocation: https://evil.example/\r\n\r\n"),
            None
        );
        assert_eq!(
            body_of("HTTP/2 404\r\na: b\r\n\r\n{\"error\":{}}"),
            "{\"error\":{}}"
        );
    }

    #[test]
    fn tells_whether_a_file_is_still_there() {
        assert_eq!(answer_exists(200, r#"{"trashed":false}"#), Ok(true));
        assert_eq!(answer_exists(200, r#"{"trashed":true}"#), Ok(false));
        assert_eq!(answer_exists(404, ""), Ok(false));
        assert!(answer_exists(401, "").is_err());
        assert!(answer_exists(500, "").is_err());
    }

    #[test]
    fn uploads_whole_videos_only() {
        use edit_core::Settings;
        let plan = |start, end| Plan {
            start,
            end,
            width: 1920,
            height: 1080,
            audio: true,
        };
        let mut project = Project::new("p".into(), "Case".into(), Settings::default());
        project.media.push(serde_json::from_value(json!({
            "id": "m", "name": "bodycam", "path": "/tmp/bodycam.mp4", "kind": "video", "duration": 10.0
        })).unwrap());
        let clip = |id: &str, name: &str, content: Value| -> edit_core::Clip {
            let mut clip = json!({
                "id": id, "track": project.tracks[0].id, "start": 0, "duration": 300,
                "color": "blue", "name": name
            });
            if let (Some(clip), Some(content)) = (clip.as_object_mut(), content.as_object()) {
                clip.extend(content.clone());
            }
            serde_json::from_value(clip).unwrap()
        };
        let footage = clip("c1", "bodycam", json!({ "type": "video", "media": "m" }));
        let line = clip(
            "c2",
            "Subtitle · Hands up",
            json!({ "type": "solid", "fill": [0, 0, 0, 1] }),
        );
        project.clips.push(footage);
        let whole = plan(0, project.duration());
        // Any whole edit, subtitled (to Subtitles) or not (to Render).
        assert!(wanted(&project, &ExportOptions::default(), &whole));
        project.clips.push(line);
        assert!(wanted(&project, &ExportOptions::default(), &whole));
        // Part of it, or not a video file: no.
        assert!(!wanted(
            &project,
            &ExportOptions::default(),
            &plan(30, project.duration())
        ));
        assert!(!wanted(&project, &ExportOptions::default(), &plan(0, 100)));
        let gif = ExportOptions {
            format: Format::Gif,
            ..Default::default()
        };
        assert!(!wanted(&project, &gif, &whole));
        let prores = ExportOptions {
            format: Format::Prores,
            ..Default::default()
        };
        assert!(wanted(&project, &prores, &whole));
    }

    /// Uploads a small test file named "edit-upload-test.mp4" to the Subtitles
    /// folder, checks it, then deletes that file. Needs the Google sign-in:
    /// `infisical run … -- cargo test -p edit --bin edit drive -- --ignored`.
    #[test]
    #[ignore]
    fn uploads_to_drive() {
        let dir = std::env::temp_dir().join(format!("edit-drive-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("edit-upload-test.mp4");
        let status = Command::new(crate::tools::ffmpeg())
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=640x360:rate=30",
            ])
            .args(["-t", "4", "-pix_fmt", "yuv420p", "-b:v", "3M"])
            .arg(&path)
            .status()
            .unwrap();
        assert!(status.success());
        let library = Library::default();
        let mut seen = Vec::new();
        let file = upload(
            &library,
            &path,
            "edit-upload-test.mp4",
            &folder(true),
            None,
            |share| seen.push(share),
        )
        .unwrap();
        eprintln!(
            "uploaded {} bytes, progress {seen:?}",
            std::fs::metadata(&path).unwrap().len()
        );
        assert_eq!(file.name, "edit-upload-test.mp4");
        assert!(exists(&library, &file.file_id).unwrap());
        // Viewable by anyone with the link.
        let config = format!(
            "header = {}\n",
            quote(&format!(
                "Authorization: Bearer {}",
                library.token().unwrap()
            ))
            .unwrap()
        );
        let url = format!(
            "{API}/files/{}/permissions?supportsAllDrives=true",
            file.file_id
        );
        let (code, body) = curl(&config, &["--max-time", "20", &url]).unwrap();
        assert_eq!(code, 200);
        assert!(String::from_utf8_lossy(&body).contains("\"anyone\""));
        // Delete only the test file.
        let delete = format!("{API}/files/{}?supportsAllDrives=true", file.file_id);
        let (code, _) = curl(&config, &["--max-time", "20", "-X", "DELETE", &delete]).unwrap();
        assert_eq!(code, 204);
        assert!(!exists(&library, &file.file_id).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
