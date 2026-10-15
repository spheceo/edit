use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path as UrlPath, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use edit_core::{Clip, ClipColor, ClipContent, MediaKind, Project, Settings, TrackKind, Transform};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::media::{self, Processor};
use crate::render::{encode_png, Exports, FrameRenderer};
use crate::store::{Store, UpdateError};

#[derive(Clone)]
pub struct App {
    pub store: Arc<Store>,
    pub media: Arc<Processor>,
    pub frames: Arc<FrameRenderer>,
    pub exports: Arc<Exports>,
    pub allowed_hosts: Arc<Vec<String>>,
    /// Short host name of the machine running Edit (shown in the UI).
    pub machine: Arc<str>,
    pub agents: Arc<crate::agent::Agents>,
    pub scripts: Arc<crate::script::Jobs>,
    pub library: Arc<crate::library::Library>,
    pub updater: Arc<crate::update::Updater>,
    pub voices: Arc<crate::voice::Voices>,
}

#[derive(rust_embed::Embed)]
#[folder = "../../web/dist"]
struct WebAssets;

type ApiResult = Result<Response, ApiError>;

pub struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

fn bad(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}

fn not_found(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::NOT_FOUND, message.into())
}

pub fn router(app: App) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/diagnostics", get(diagnostics))
        .route("/api/setup", get(setup))
        .route("/api/voice", get(voice_list).post(voice_create))
        .route("/api/voice/voices", get(voice_voices))
        .route(
            "/api/voice/{id}",
            get(voice_get).put(voice_update).delete(voice_delete),
        )
        .route("/api/voice/{id}/full.mp3", get(voice_full))
        .route("/api/voice/{id}/send", post(voice_send))
        .route(
            "/api/voice/{id}/lines/{line}/generate",
            post(voice_generate),
        )
        .route(
            "/api/voice/{id}/lines/{line}/takes/{take}",
            get(voice_take).delete(voice_delete_take),
        )
        .route("/api/diagnostics/client", post(client_log))
        .route("/api/update", get(update_status).post(update_install))
        .route("/api/projects", get(list_projects).post(create_project))
        .route(
            "/api/projects/{id}",
            get(get_project).put(put_project).delete(delete_project),
        )
        .route("/api/projects/{id}/import", post(import_media))
        .route(
            "/api/projects/{id}/upload",
            post(upload_media).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/projects/{id}/media-status", get(media_status))
        .route("/api/library", get(library))
        .route("/api/projects/{id}/library", post(library_import))
        .route(
            "/api/projects/{id}/research",
            get(research_items).post(research_collect),
        )
        .route("/api/projects/{id}/research/clear", post(research_clear))
        .route("/api/projects/{id}/research/{item}", post(research_review))
        .route(
            "/api/projects/{id}/research/{item}/image",
            get(research_image),
        )
        .route(
            "/api/projects/{id}/media/{media}/transcribe",
            post(transcribe_media),
        )
        .route(
            "/api/projects/{id}/media/{media}/speakers",
            post(set_speaker),
        )
        .route("/api/projects/{id}/media/{media}/{kind}", get(media_file))
        .route("/api/projects/{id}/frame/{frame}", get(frame_png))
        .route("/api/projects/{id}/export", post(start_export))
        .route("/api/projects/{id}/export/cancel", post(cancel_export))
        .route(
            "/api/projects/{id}/drive",
            get(drive_link).post(drive_upload),
        )
        .route("/api/export/encoders", get(export_encoders))
        .route("/api/exports/file", get(exported_file))
        .route("/api/exports/reveal", post(reveal_export))
        .route("/api/agent", get(agent_status))
        .route("/api/agent/models", get(agent_models))
        .route("/api/projects/{id}/agent", get(agent_chat).post(agent_send))
        .route("/api/projects/{id}/agent/stop", post(agent_stop))
        .route("/api/projects/{id}/agent/reset", post(agent_reset))
        .route("/api/projects/{id}/captions", post(captions))
        .route(
            "/api/projects/{id}/repack-subtitles",
            post(repack_subtitles),
        )
        .route("/api/projects/{id}/watch", post(watch_footage))
        .route("/api/scripts/preview", post(script_preview))
        .route("/api/projects/{id}/script", post(script_attach))
        .route(
            "/api/projects/{id}/script/job",
            get(script_job).post(script_resume),
        )
        .route(
            "/api/maps/{token}",
            get(crate::broll::map_page)
                .post(crate::broll::map_shot)
                .layer(DefaultBodyLimit::max(64 << 20)),
        )
        .route(
            "/api/maps/{token}/frame/{index}",
            post(crate::broll::map_frame).layer(DefaultBodyLimit::max(64 << 20)),
        )
        .route("/api/fs", get(browse))
        .route("/api/ws", get(websocket))
        .route("/fonts/{file}", get(font))
        .route("/mcp", post(crate::mcp::handle).get(crate::mcp::reject_get))
        .fallback(get(static_asset))
        .layer(middleware::from_fn_with_state(app.clone(), check_host))
        // A handler that panics answers with an error; the server carries on.
        .layer(tower_http::catch_panic::CatchPanicLayer::custom(
            crate::guard::panic_response,
        ))
        // Outermost, so it also sees requests the others turned away or that crashed.
        .layer(middleware::from_fn(log_requests))
        .with_state(app)
}

/// Times every request (by route) and logs the ones that failed, with why.
async fn log_requests(request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let route = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map_or_else(|| "(static)".to_owned(), |path| path.as_str().to_owned());
    let path = request.uri().path().to_owned();
    let started = std::time::Instant::now();
    let response = next.run(request).await;
    let took = started.elapsed();
    let status = response.status();
    let name = format!("{method} {route}");
    if !status.is_client_error() && !status.is_server_error() {
        crate::diag::record("http", &name, took, None);
        return response;
    }
    // Errors answer with a small JSON body: read it for the log, then pass it on.
    let (parts, body) = response.into_parts();
    let bytes = axum::body::to_bytes(body, 64 << 10)
        .await
        .unwrap_or_default();
    let why = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| String::from_utf8_lossy(&bytes).chars().take(300).collect());
    let failure = format!("{} {path}: {why}", status.as_u16());
    if status.is_server_error() {
        crate::diag::record("http", &name, took, Some(&failure));
    } else {
        crate::diag::record("http", &name, took, None);
        // A missing thumbnail or frame is routine; other refusals are worth seeing.
        if status != StatusCode::NOT_FOUND || method != axum::http::Method::GET {
            crate::diag::warn("http", format!("{method} {failure}"));
        }
    }
    Response::from_parts(parts, Body::from(bytes))
}

/// Host protects against DNS rebinding; Origin also protects local APIs and
/// websockets from a malicious page making requests to an allowed localhost.
async fn check_host(State(app): State<App>, request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let Ok(authority) = host.parse::<axum::http::uri::Authority>() else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let name = authority
        .host()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    let allowed = app.allowed_hosts.contains(&name) || name.ends_with(".localhost");
    if !allowed {
        return (
            StatusCode::FORBIDDEN,
            format!("host {name} is not allowed; set EDIT_HOSTS"),
        )
            .into_response();
    }
    if let Some(origin) = request.headers().get(header::ORIGIN) {
        if !origin
            .to_str()
            .ok()
            .is_some_and(|origin| same_origin(origin, host))
        {
            return (
                StatusCode::FORBIDDEN,
                "cross-origin requests are not allowed",
            )
                .into_response();
        }
    }
    if request
        .headers()
        .get("sec-fetch-site")
        .is_some_and(|site| site == "cross-site")
    {
        return (StatusCode::FORBIDDEN, "cross-site requests are not allowed").into_response();
    }
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
        .headers_mut()
        .insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    response
}

fn same_origin(origin: &str, host: &str) -> bool {
    let Ok(uri) = origin.parse::<axum::http::Uri>() else {
        return false;
    };
    let Some(scheme @ ("http" | "https")) = uri.scheme_str() else {
        return false;
    };
    let Some(authority) = uri.authority() else {
        return false;
    };
    let Ok(host) = host.parse::<axum::http::uri::Authority>() else {
        return false;
    };
    let default_port = if scheme == "https" { 443 } else { 80 };
    authority.host().eq_ignore_ascii_case(host.host())
        && authority.port_u16().unwrap_or(default_port) == host.port_u16().unwrap_or(default_port)
        && uri.path() == "/"
        && uri.query().is_none()
}

async fn health(State(app): State<App>) -> Json<Value> {
    Json(json!({ "name": "edit", "version": env!("CARGO_PKG_VERSION"), "machine": &*app.machine }))
}

/// Everything a problem report needs from the server side.
async fn diagnostics(State(app): State<App>) -> Json<Value> {
    let tool_version = |tool: &std::ffi::OsStr| {
        std::process::Command::new(tool)
            .arg("-version")
            .output()
            .ok()
            .and_then(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .map(str::to_owned)
            })
    };
    Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "machine": &*app.machine,
        "os": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        "uptime": crate::diag::human(crate::diag::uptime()),
        "home": app.store.home(),
        "ffmpeg": tool_version(crate::tools::ffmpeg()).map(|version| {
            let from = if crate::tools::bundled() { "shipped with Edit" } else { "from PATH" };
            format!("{version} ({from})")
        }),
        "lines": crate::diag::lines(400),
        "timings": crate::diag::timings(),
    }))
}

// ---------------------------------------------------------------------------
// Voice-overs (crate::voice): their own projects, for now.

async fn voice_list(State(app): State<App>) -> Json<Value> {
    Json(json!({ "projects": app.voices.list() }))
}

#[derive(Deserialize)]
struct VoiceCreate {
    #[serde(default)]
    name: String,
    /// A video project whose cut-ins become the lines.
    #[serde(default)]
    from_project: Option<String>,
}

async fn voice_create(State(app): State<App>, Json(body): Json<VoiceCreate>) -> ApiResult {
    let (name, lines) = match &body.from_project {
        Some(id) => {
            let live = app
                .store
                .get(id)
                .ok_or_else(|| not_found("no such project"))?;
            let lines = crate::voice::narration_lines(&live.project);
            if lines.is_empty() {
                return Err(bad("That project's script has no cut-ins to voice."));
            }
            let name = if body.name.trim().is_empty() {
                format!("{} (voice-over)", live.project.name)
            } else {
                body.name.clone()
            };
            (name, lines)
        }
        None => (body.name.clone(), Vec::new()),
    };
    let project = app
        .voices
        .create(&name, body.from_project.clone(), lines)
        .map_err(bad)?;
    Ok(Json(json!({ "project": project })).into_response())
}

async fn voice_get(State(app): State<App>, UrlPath(id): UrlPath<String>) -> ApiResult {
    let project = app.voices.get(&id).map_err(not_found)?;
    Ok(Json(json!({ "project": project })).into_response())
}

async fn voice_update(
    State(app): State<App>,
    UrlPath(id): UrlPath<String>,
    Json(changes): Json<crate::voice::Changes>,
) -> ApiResult {
    let project = app.voices.update(&id, changes).map_err(bad)?;
    Ok(Json(json!({ "project": project })).into_response())
}

async fn voice_delete(State(app): State<App>, UrlPath(id): UrlPath<String>) -> ApiResult {
    app.voices.delete(&id).map_err(bad)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn voice_generate(
    State(app): State<App>,
    UrlPath((id, line)): UrlPath<(String, String)>,
) -> ApiResult {
    let voices = Arc::clone(&app.voices);
    let project = tokio::task::spawn_blocking(move || voices.generate(&id, &line))
        .await
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .map_err(bad)?;
    Ok(Json(json!({ "project": project })).into_response())
}

async fn voice_delete_take(
    State(app): State<App>,
    UrlPath((id, line, take)): UrlPath<(String, String, String)>,
) -> ApiResult {
    let project = app.voices.delete_take(&id, &line, &take).map_err(bad)?;
    Ok(Json(json!({ "project": project })).into_response())
}

async fn voice_take(
    State(app): State<App>,
    UrlPath((id, _line, take)): UrlPath<(String, String, String)>,
    request: Request,
) -> ApiResult {
    let path = app.voices.take_path(&id, &take).map_err(not_found)?;
    if !path.is_file() {
        return Err(not_found("no such take"));
    }
    Ok(ServeFile::new(&path)
        .oneshot(request)
        .await
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .into_response())
}

async fn voice_full(
    State(app): State<App>,
    UrlPath(id): UrlPath<String>,
    request: Request,
) -> ApiResult {
    let voices = Arc::clone(&app.voices);
    let path = tokio::task::spawn_blocking(move || voices.full(&id))
        .await
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .map_err(bad)?;
    Ok(ServeFile::new(&path)
        .oneshot(request)
        .await
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .into_response())
}

#[derive(Deserialize)]
struct VoiceSend {
    project: String,
}

/// Puts a voice-over's chosen takes into a video project and lays them on its
/// cut-ins (matched by their words, as with any recorded voice-over).
async fn voice_send(
    State(app): State<App>,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<VoiceSend>,
) -> ApiResult {
    let voice = app.voices.get(&id).map_err(not_found)?;
    let takes = app.voices.chosen_takes(&id).map_err(bad)?;
    if takes.is_empty() {
        return Err(bad("No lines have a chosen take yet."));
    }
    app.store
        .get(&body.project)
        .ok_or_else(|| not_found("no such project"))?;
    let dir = app.store.uploads_dir(&body.project).join("voice-over");
    std::fs::create_dir_all(&dir).map_err(|error| bad(error.to_string()))?;
    let mut paths = Vec::new();
    for (number, label, take) in takes {
        let name = label.unwrap_or_else(|| format!("Line {number}"));
        let file = dir.join(format!("{} - {name}.mp3", voice.name.replace('/', "-")));
        std::fs::copy(&take, &file).map_err(|error| bad(error.to_string()))?;
        paths.push(file.to_string_lossy().into_owned());
    }
    let (_, added, errors) = import_paths(&app, &body.project, paths, false, "voice")
        .await
        .map_err(bad)?;
    if added.is_empty() {
        return Err(bad(format!("Couldn't import the takes: {errors:?}")));
    }
    let report = crate::diag::time_async(
        "voice",
        "voice: place in a project",
        crate::voiceover::place(&app, &body.project, Some(added.clone())),
    )
    .await
    .map_err(bad)?;
    Ok(Json(json!({ "media": added, "report": report })).into_response())
}

#[derive(Deserialize)]
struct VoicesQuery {
    #[serde(default)]
    refresh: bool,
}

async fn voice_voices(State(app): State<App>, Query(query): Query<VoicesQuery>) -> ApiResult {
    let voices = Arc::clone(&app.voices);
    let listing = tokio::task::spawn_blocking(move || voices.voices(query.refresh))
        .await
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .map_err(bad)?;
    Ok(Json(listing).into_response())
}

/// What this machine still needs before everything in Edit works.
async fn setup(State(app): State<App>) -> Json<Value> {
    let ffmpeg = tokio::task::spawn_blocking(|| {
        std::process::Command::new(crate::tools::ffmpeg())
            .arg("-version")
            .output()
            .is_ok_and(|output| output.status.success())
    })
    .await
    .unwrap_or(false);
    let agents = app.agents.clone();
    let codex = tokio::task::spawn_blocking(move || agents.status())
        .await
        .unwrap_or_else(|_| json!({ "ready": false, "state": "missing" }));
    let chrome = crate::broll::chrome().is_some();
    let codex_fix = match codex.get("state").and_then(Value::as_str) {
        Some("logged_out") => "codex login",
        _ => "npm install -g @openai/codex && codex login",
    };
    Json(json!({ "checks": [
        {
            "id": "ffmpeg",
            "ok": ffmpeg,
            "title": "FFmpeg",
            "why": "Importing footage, previews and export. Reinstalling Edit brings it back.",
            "fix": "curl -fsSL https://raw.githubusercontent.com/spheceo/edit/main/install.sh | sh",
        },
        {
            "id": "codex",
            "ok": codex.get("ready").and_then(Value::as_bool).unwrap_or(false),
            "title": if codex.get("state").and_then(Value::as_str) == Some("logged_out") { "Codex sign-in" } else { "Codex" },
            "why": "The agent panel.",
            "fix": codex_fix,
        },
        {
            "id": "chrome",
            "ok": chrome,
            "title": "Google Chrome (or Chromium)",
            "why": "Map shots and research.",
            "fix": "https://www.google.com/chrome/",
        },
    ]}))
}

#[derive(Deserialize)]
struct ClientLog {
    level: String,
    message: String,
}

/// The UI's own problems, kept with the server's so one report has both.
async fn client_log(Json(body): Json<ClientLog>) -> Json<Value> {
    let message: String = body.message.chars().take(2000).collect();
    match body.level.as_str() {
        "error" => crate::diag::error("ui", message),
        "warn" => crate::diag::warn("ui", message),
        _ => crate::diag::info("ui", message),
    }
    Json(json!({ "ok": true }))
}

async fn update_status(State(app): State<App>) -> Json<crate::update::Status> {
    Json(app.updater.status().await)
}

/// Downloads the newest release and restarts into it.
async fn update_install(State(app): State<App>) -> ApiResult {
    if app.exports.running() || crate::drive::uploading() {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "an export or Drive upload is running; update when it's done".to_owned(),
        ));
    }
    let status = app.updater.start().map_err(bad)?;
    Ok(Json(status).into_response())
}

/// An upload that sends nothing for this long is abandoned.
const UPLOAD_IDLE: std::time::Duration = std::time::Duration::from_secs(60);

/// Deletes an in-progress upload unless kept, including when the client
/// disconnects and the handler is dropped mid-await.
struct PartialFile(Option<PathBuf>);

impl PartialFile {
    fn keep(mut self) {
        self.0 = None;
    }
}

impl Drop for PartialFile {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[derive(Deserialize)]
struct UploadQuery {
    name: String,
    /// Total bytes the client will send.
    size: Option<u64>,
    #[serde(default)]
    origin: String,
}

/// Streams a file from the browser's device to disk, then imports it.
/// The body is never buffered, so multi-GB footage is fine.
async fn upload_media(
    State(app): State<App>,
    UrlPath(id): UrlPath<String>,
    Query(query): Query<UploadQuery>,
    body: Body,
) -> ApiResult {
    app.store
        .get(&id)
        .ok_or_else(|| not_found("no such project"))?;
    let name = Path::new(&query.name)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty() && !name.starts_with('.'))
        .ok_or_else(|| bad("invalid file name"))?
        .to_owned();
    if !media::is_media_path(Path::new(&name)) {
        return Err(bad(format!(
            "{name} is not a supported video or audio file"
        )));
    }
    let dir = app.store.uploads_dir(&id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| bad(error.to_string()))?;
    let limit = std::env::var("EDIT_MAX_UPLOAD_BYTES")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(100 * 1024 * 1024 * 1024);
    if query.size.is_some_and(|size| size == 0 || size > limit) {
        return Err(ApiError(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("upload must be between 1 and {limit} bytes"),
        ));
    }
    let target = reserve_upload(&dir, &name)
        .await
        .map_err(|error| bad(error.to_string()))?;
    let target_guard = PartialFile(Some(target.clone()));
    let mut temporary = target.as_os_str().to_owned();
    temporary.push(".uploading");
    let temporary = PathBuf::from(temporary);
    let partial = PartialFile(Some(temporary.clone()));
    let result = async {
        let path = temporary.as_path();
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .await?;
        let mut stream = body.into_data_stream();
        let mut received = 0_u64;
        // Stop at the announced size rather than waiting for end-of-body:
        // some proxies (HTTP/2 → HTTP/1.1) can lose it on large uploads.
        while query.size.is_none_or(|size| received < size) {
            let next = tokio::time::timeout(UPLOAD_IDLE, stream.next())
                .await
                .map_err(|_| std::io::Error::other("no data for a minute"))?;
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(std::io::Error::other)?;
            received += chunk.len() as u64;
            if received > limit || query.size.is_some_and(|size| received > size) {
                return Err(std::io::Error::other("upload exceeds its size limit"));
            }
            file.write_all(&chunk).await?;
        }
        if let Some(size) = query.size.filter(|size| *size != received) {
            return Err(std::io::Error::other(format!(
                "received {received} of {size} bytes"
            )));
        }
        file.flush().await?;
        tokio::fs::rename(path, &target).await
    }
    .await;
    if let Err(error) = result {
        return Err(bad(format!("upload of {name} failed: {error}")));
    }
    partial.keep();
    let origin = if query.origin.is_empty() {
        "upload".to_owned()
    } else {
        query.origin
    };
    let (rev, added, errors) = import_paths(
        &app,
        &id,
        vec![target.to_string_lossy().to_string()],
        false,
        &origin,
    )
    .await
    .map_err(bad)?;
    if let Some(error) = errors.first() {
        let _ = tokio::fs::remove_file(&target).await;
        return Err(bad(error.clone()));
    }
    let project = app.store.get(&id).map(|live| live.project);
    target_guard.keep();
    Ok(Json(json!({ "rev": rev, "added": added, "project": project })).into_response())
}

/// `dir/name`, or `dir/name-2.ext`, `-3`… if taken.
async fn reserve_upload(dir: &Path, name: &str) -> std::io::Result<PathBuf> {
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("upload");
    let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
    for n in 1_u64.. {
        let candidate = dir.join(if n == 1 {
            name.to_owned()
        } else if ext.is_empty() {
            format!("{stem}-{n}")
        } else {
            format!("{stem}-{n}.{ext}")
        });
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
            .await
        {
            Ok(_) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::other("no free name for the upload"))
}

async fn agent_status(State(app): State<App>) -> Json<Value> {
    let agents = Arc::clone(&app.agents);
    Json(
        tokio::task::spawn_blocking(move || agents.status())
            .await
            .unwrap_or_else(|_| json!({ "ready": false })),
    )
}

#[derive(Deserialize)]
struct ModelsQuery {
    #[serde(default)]
    refresh: bool,
}

async fn agent_models(State(app): State<App>, Query(query): Query<ModelsQuery>) -> ApiResult {
    let models = app.agents.models(query.refresh).await.map_err(bad)?;
    Ok(Json(models).into_response())
}

async fn agent_chat(State(app): State<App>, UrlPath(id): UrlPath<String>) -> ApiResult {
    app.store
        .get(&id)
        .ok_or_else(|| not_found("no such project"))?;
    Ok(Json(app.agents.chat(&id)).into_response())
}

#[derive(Deserialize)]
struct AgentMessage {
    text: String,
    model: Option<String>,
    effort: Option<String>,
}

async fn agent_send(
    State(app): State<App>,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<AgentMessage>,
) -> ApiResult {
    let text = body.text.trim().to_owned();
    if text.is_empty() {
        return Err(bad("say something"));
    }
    app.agents
        .send(&id, text, body.model, body.effort)
        .await
        .map_err(bad)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn agent_stop(State(app): State<App>, UrlPath(id): UrlPath<String>) -> ApiResult {
    app.agents.stop(&id).await.map_err(bad)?;
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn agent_reset(State(app): State<App>, UrlPath(id): UrlPath<String>) -> Json<Value> {
    app.agents.reset(&id);
    Json(json!({ "ok": true }))
}

async fn list_projects(State(app): State<App>) -> Json<Value> {
    Json(json!({ "projects": app.store.list() }))
}

#[derive(Deserialize)]
struct CreateProject {
    name: String,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<u32>,
}

async fn create_project(State(app): State<App>, Json(body): Json<CreateProject>) -> ApiResult {
    let defaults = Settings::default();
    let settings = Settings {
        width: body.width.unwrap_or(defaults.width),
        height: body.height.unwrap_or(defaults.height),
        fps: body.fps.unwrap_or(defaults.fps),
    };
    let live = app.store.create(&body.name, settings).map_err(bad)?;
    app.store.set_active(&live.project.id);
    Ok(Json(json!({ "rev": live.rev, "project": live.project })).into_response())
}

async fn get_project(State(app): State<App>, UrlPath(id): UrlPath<String>) -> ApiResult {
    let live = app
        .store
        .get(&id)
        .ok_or_else(|| not_found("no such project"))?;
    app.store.set_active(&id);
    for media in &live.project.media {
        if let Ok(probe) = probe_cached(media) {
            app.media.ensure(PathBuf::from(&media.path), probe);
        }
    }
    Ok(Json(json!({ "rev": live.rev, "project": live.project })).into_response())
}

fn probe_cached(media: &edit_core::Media) -> Result<media::Probe, String> {
    if !Path::new(&media.path).is_file() {
        return Err(format!("{} is missing", media.path));
    }
    Ok(media::Probe {
        kind: media.kind,
        duration: media.duration,
        width: media.width,
        height: media.height,
        fps: media.fps,
        has_audio: media.has_audio,
    })
}

#[derive(Deserialize)]
struct PutProject {
    base_rev: Option<u64>,
    project: Project,
    #[serde(default)]
    origin: String,
}

async fn put_project(
    State(app): State<App>,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<PutProject>,
) -> ApiResult {
    match app
        .store
        .replace(&id, body.base_rev, body.project, &body.origin)
    {
        Ok(live) => Ok(Json(json!({ "rev": live.rev })).into_response()),
        Err(UpdateError::NotFound) => Err(not_found("no such project")),
        Err(UpdateError::Invalid(error)) => Err(bad(error)),
        Err(UpdateError::Conflict(live)) => Ok((
            StatusCode::CONFLICT,
            Json(json!({ "error": "conflict", "rev": live.rev, "project": live.project })),
        )
            .into_response()),
    }
}

async fn delete_project(State(app): State<App>, UrlPath(id): UrlPath<String>) -> ApiResult {
    if app.store.delete(&id) {
        Ok(Json(json!({ "ok": true })).into_response())
    } else {
        Err(not_found("no such project"))
    }
}

#[derive(Deserialize)]
struct ImportBody {
    paths: Vec<String>,
    /// Also append the media to the end of the timeline.
    #[serde(default)]
    place: bool,
    #[serde(default)]
    origin: String,
}

pub async fn import_paths(
    app: &App,
    id: &str,
    paths: Vec<String>,
    place: bool,
    origin: &str,
) -> Result<(u64, Vec<String>, Vec<String>), String> {
    let mut probed = Vec::new();
    let mut errors = Vec::new();
    let mut names: std::collections::HashMap<PathBuf, String> = Default::default();
    for path in paths {
        let path = PathBuf::from(&path);
        let path = match path.canonicalize() {
            Ok(path) if path.is_file() && media::is_media_path(&path) => path,
            #[cfg(target_os = "macos")]
            Ok(path) if path.is_file() && crate::broll::is_image_path(&path) => path,
            // A still becomes 30 s of footage (it then plays, scales and exports like any clip).
            Ok(path) if path.is_file() && crate::broll::is_image_path(&path) => {
                let name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned());
                let dir = app.store.uploads_dir(id).join("stills");
                let image = path.clone();
                match tokio::task::spawn_blocking(move || crate::broll::still_video(&image, &dir))
                    .await
                    .unwrap_or_else(|error| Err(error.to_string()))
                {
                    Ok(video) => {
                        if let Some(name) = name {
                            names.insert(video.clone(), name);
                        }
                        video
                    }
                    Err(error) => {
                        errors.push(error);
                        continue;
                    }
                }
            }
            _ => {
                errors.push(format!(
                    "{} is not a supported local media file",
                    path.display()
                ));
                continue;
            }
        };
        let result = {
            let path = path.clone();
            tokio::task::spawn_blocking(move || media::probe(&path))
                .await
                .unwrap_or_else(|error| Err(error.to_string()))
        };
        match result {
            Ok(probe) => probed.push((path, probe)),
            Err(error) => errors.push(error),
        }
    }
    let (live, added) = app.store.update(id, origin, |project| {
        let mut added = Vec::new();
        for (path, probe) in &probed {
            let path_text = path.to_string_lossy().to_string();
            let media_id = match project.media.iter().find(|media| media.path == path_text) {
                Some(existing) => existing.id.clone(),
                None => {
                    let media_id = project.fresh_id("m");
                    project.media.push(edit_core::Media {
                        id: media_id.clone(),
                        name: names.get(path).cloned().unwrap_or_else(|| {
                            path.file_name().map_or_else(
                                || path_text.clone(),
                                |name| name.to_string_lossy().to_string(),
                            )
                        }),
                        path: path_text.clone(),
                        kind: probe.kind,
                        duration: probe.duration,
                        width: probe.width,
                        height: probe.height,
                        fps: probe.fps,
                        has_audio: probe.has_audio,
                        markers: Vec::new(),
                    });
                    media_id
                }
            };
            if place {
                place_at_end(project, &media_id);
            }
            added.push(media_id);
        }
        Ok(added)
    })?;
    // Footage brought into a project with no script is a subtitled video in
    // the making: its transcript is the first thing it needs, so the
    // transcriber starts now instead of when the watcher first asks for it.
    // (A script's import transcribes its own footage; voice-overs have theirs.)
    let transcribe = live.project.script.is_none() && !matches!(origin, "voice" | "script");
    let mut transcribing = Vec::new();
    for (path, probe) in probed {
        if transcribe && probe.kind == MediaKind::Video && probe.has_audio {
            app.media.transcribe(path.clone(), true);
            transcribing.push(path.clone());
        }
        app.media.ensure(path, probe);
    }
    if !transcribing.is_empty() {
        // Then the watcher, in the background, once the words are in: asking
        // for the subtitles later finds its answers cached.
        let (app, id) = (app.clone(), id.to_owned());
        tokio::spawn(async move {
            let started = std::time::Instant::now();
            while started.elapsed() < std::time::Duration::from_secs(3600) {
                let pending = transcribing
                    .iter()
                    .any(|path| app.media.status(path).transcript == media::Stage::Working);
                if !pending {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            }
            crate::watch::watch_in_background(&app, &id);
        });
    }
    Ok((live.rev, added, errors))
}

/// Appends a media item after the last clip, linking picture and sound.
pub fn place_at_end(project: &mut Project, media_id: &str) {
    let Some(media) = project.media(media_id).cloned() else {
        return;
    };
    let start = project.duration();
    let duration = ((media.duration * project.fps()).floor() as i64).max(1);
    let colors = [
        ClipColor::Blue,
        ClipColor::Purple,
        ClipColor::Cyan,
        ClipColor::Green,
        ClipColor::Orange,
        ClipColor::Pink,
    ];
    let color = colors
        .iter()
        .cycle()
        .nth(project.clips.len() / 2)
        .copied()
        .unwrap_or(ClipColor::Blue);
    let video_track = project
        .tracks
        .iter()
        .find(|track| track.kind == TrackKind::Video)
        .map(|track| track.id.clone());
    let audio_track = project
        .tracks
        .iter()
        .find(|track| track.kind == TrackKind::Audio)
        .map(|track| track.id.clone());
    let link = (media.kind == MediaKind::Video && media.has_audio).then(|| project.fresh_id("l"));
    if media.kind != MediaKind::Audio {
        if let Some(track) = video_track {
            let id = project.fresh_id("c");
            project.clips.push(Clip {
                id,
                track,
                start,
                duration,
                color,
                name: None,
                link: link.clone(),
                fade_in: 0,
                fade_out: 0,
                keyframes: Default::default(),
                content: ClipContent::Video {
                    media: media.id.clone(),
                    source_in: 0.0,
                    speed: 1.0,
                    transform: Transform::default(),
                    opacity: 1.0,
                    crop: Default::default(),
                },
            });
        }
    }
    if media.has_audio {
        if let Some(track) = audio_track {
            let id = project.fresh_id("c");
            project.clips.push(Clip {
                id,
                track,
                start,
                duration,
                color: if media.kind == MediaKind::Audio {
                    ClipColor::Green
                } else {
                    color
                },
                name: None,
                link,
                fade_in: 0,
                fade_out: 0,
                keyframes: Default::default(),
                content: ClipContent::Audio {
                    media: media.id.clone(),
                    source_in: 0.0,
                    speed: 1.0,
                    volume_db: 0.0,
                    mutes: Vec::new(),
                },
            });
        }
    }
}

async fn import_media(
    State(app): State<App>,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<ImportBody>,
) -> ApiResult {
    if body.paths.is_empty() {
        return Err(bad("no paths"));
    }
    let (rev, added, errors) = import_paths(&app, &id, body.paths, body.place, &body.origin)
        .await
        .map_err(bad)?;
    let project = app.store.get(&id).map(|live| live.project);
    Ok(
        Json(json!({ "rev": rev, "added": added, "errors": errors, "project": project }))
            .into_response(),
    )
}

#[derive(Deserialize)]
struct LibraryQuery {
    #[serde(default)]
    refresh: bool,
}

/// The team's sound library (Drive), with its usage guide.
async fn library(State(app): State<App>, Query(query): Query<LibraryQuery>) -> ApiResult {
    let library = Arc::clone(&app.library);
    let listing = tokio::task::spawn_blocking(move || library.list(query.refresh))
        .await
        .map_err(|error| bad(error.to_string()))?
        .map_err(|error| ApiError(StatusCode::SERVICE_UNAVAILABLE, error))?;
    Ok(Json(&*listing).into_response())
}

#[derive(Deserialize)]
struct LibraryImportBody {
    sound: String,
    origin: String,
}

/// Downloads a library sound (first time) and adds it to the project's media.
async fn library_import(
    State(app): State<App>,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<LibraryImportBody>,
) -> ApiResult {
    let (media, _) = crate::library::import(&app, &id, &body.sound, &body.origin)
        .await
        .map_err(bad)?;
    let live = app
        .store
        .get(&id)
        .ok_or_else(|| not_found("no such project"))?;
    Ok(Json(json!({ "rev": live.rev, "media": media, "project": live.project })).into_response())
}

/// Images found for the project, for review.
async fn research_items(State(app): State<App>, UrlPath(id): UrlPath<String>) -> ApiResult {
    app.store
        .get(&id)
        .ok_or_else(|| not_found("no such project"))?;
    let home = app.store.home().to_path_buf();
    Ok(Json(json!({
        "items": crate::research::items(&home, &id),
        "articles": crate::research::articles(&home, &id),
        "collecting": crate::research::collecting(&id),
    }))
    .into_response())
}

#[derive(Deserialize)]
struct CollectBody {
    queries: Vec<String>,
    #[serde(default)]
    per_query: Option<usize>,
}

/// Starts collecting images for searches (in the background; poll the list).
async fn research_collect(
    State(app): State<App>,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<CollectBody>,
) -> ApiResult {
    app.store
        .get(&id)
        .ok_or_else(|| not_found("no such project"))?;
    let queries: Vec<String> = body
        .queries
        .into_iter()
        .map(|query| query.trim().to_owned())
        .filter(|query| !query.is_empty())
        .collect();
    if queries.is_empty() {
        return Err(bad("say what to search for"));
    }
    if crate::research::collecting(&id) {
        return Err(bad("already collecting images for this project"));
    }
    let home = app.store.home().to_path_buf();
    let per_query = body.per_query.unwrap_or(40).clamp(1, 150);
    tokio::task::spawn_blocking(move || {
        let _ = crate::diag::time_on("research", "research: collect images", &id, || {
            crate::research::collect(&home, &id, &queries, per_query)
        });
    });
    Ok(Json(json!({ "started": true })).into_response())
}

#[derive(Deserialize)]
struct ClearQuery {
    #[serde(default = "unreviewed")]
    status: String,
}

fn unreviewed() -> String {
    "new".into()
}

/// Deletes the found images with a status: unreviewed (default) or rejected.
async fn research_clear(
    State(app): State<App>,
    UrlPath(id): UrlPath<String>,
    Query(query): Query<ClearQuery>,
) -> ApiResult {
    app.store
        .get(&id)
        .ok_or_else(|| not_found("no such project"))?;
    let removed = crate::research::clear(app.store.home(), &id, &query.status).map_err(bad)?;
    Ok(Json(json!({ "removed": removed })).into_response())
}

#[derive(Deserialize)]
struct ReviewBody {
    status: String,
    origin: String,
}

/// Keeps (into the media bin) or rejects a found image.
async fn research_review(
    State(app): State<App>,
    UrlPath((id, item)): UrlPath<(String, String)>,
    Json(body): Json<ReviewBody>,
) -> ApiResult {
    if !matches!(body.status.as_str(), "new" | "kept" | "rejected") {
        return Err(bad("status is new, kept or rejected"));
    }
    let updated = review_found(&app, &id, &item, &body.status, &body.origin)
        .await
        .map_err(bad)?;
    let live = app
        .store
        .get(&id)
        .ok_or_else(|| not_found("no such project"))?;
    Ok(Json(json!({ "item": updated, "rev": live.rev, "project": live.project })).into_response())
}

/// Sets a found image's status; kept the first time, it goes into the media
/// bin, named after its caption. Returns it (with its media, once kept).
pub async fn review_found(
    app: &App,
    id: &str,
    item: &str,
    status: &str,
    origin: &str,
) -> Result<crate::research::Item, String> {
    let home = app.store.home().to_path_buf();
    let found = crate::research::items(&home, id)
        .into_iter()
        .find(|found| found.id == item)
        .ok_or("no such found image")?;
    let mut media = found.media.clone();
    if status == "kept" && media.is_none() {
        let (_, added, errors) =
            import_paths(app, id, vec![found.file.clone()], false, origin).await?;
        let media_id = added
            .into_iter()
            .next()
            .ok_or_else(|| format!("couldn't add it to the media bin: {errors:?}"))?;
        let name: String = found.title.chars().take(80).collect();
        if !name.trim().is_empty() {
            app.store.update(id, origin, |project| {
                if let Some(media) = project.media.iter_mut().find(|media| media.id == media_id) {
                    media.name = name.clone();
                }
                Ok(())
            })?;
        }
        media = Some(media_id);
    }
    crate::research::update(&home, id, item, |found| {
        found.status = status.to_owned();
        found.media = media.clone();
    })
}

async fn research_image(
    State(app): State<App>,
    UrlPath((id, item)): UrlPath<(String, String)>,
    request: Request,
) -> ApiResult {
    let home = app.store.home().to_path_buf();
    let found = crate::research::items(&home, &id)
        .into_iter()
        .find(|found| found.id == item)
        .ok_or_else(|| not_found("no such found image"))?;
    Ok(ServeFile::new(&found.file)
        .oneshot(request)
        .await
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .into_response())
}

async fn media_status(State(app): State<App>, UrlPath(id): UrlPath<String>) -> ApiResult {
    let live = app
        .store
        .get(&id)
        .ok_or_else(|| not_found("no such project"))?;
    let statuses: serde_json::Map<String, Value> = live
        .project
        .media
        .iter()
        .map(|media| {
            let source = Path::new(&media.path);
            let mut status = json!(app.media.status(source));
            // Which version of each preview file is there: the client puts it in
            // the file's URL, so the browser can keep what it read for good.
            let paths = app.media.paths(source);
            if let Some(fields) = status.as_object_mut() {
                fields.insert(
                    "stamps".to_owned(),
                    json!({ "preview": file_stamp(&paths.proxy_done), "light": file_stamp(&paths.light) }),
                );
            }
            (media.id.clone(), status)
        })
        .collect();
    Ok(Json(json!({ "media": statuses })).into_response())
}

/// A file's version: its length and modification time (a remade preview is a
/// new stamp).
fn file_stamp(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some(format!("{:x}-{modified:x}", meta.len()))
}

async fn media_file(
    State(app): State<App>,
    UrlPath((id, media_id, kind)): UrlPath<(String, String, String)>,
    request: Request,
) -> ApiResult {
    let live = app
        .store
        .get(&id)
        .ok_or_else(|| not_found("no such project"))?;
    let media = live
        .project
        .media(&media_id)
        .ok_or_else(|| not_found("no such media"))?;
    let source = PathBuf::from(&media.path);
    let paths = app.media.paths(&source);
    // `v=<preview|light>~<stamp>`: the URL names one version of the file, so
    // when it's that version the browser may keep it (no round trip to check).
    let named = request
        .uri()
        .query()
        .and_then(|query| query.split('&').find_map(|pair| pair.strip_prefix("v=")))
        .map(|version| version.replace("%7E", "~").replace("%7e", "~"));
    let lasting = named
        .as_deref()
        .and_then(|version| version.split_once('~'))
        .is_some_and(|(which, stamp)| match (which, kind.as_str()) {
            ("light", "light") => file_stamp(&paths.light).as_deref() == Some(stamp),
            ("preview", "proxy" | "audio") => {
                file_stamp(&paths.proxy_done).as_deref() == Some(stamp)
            }
            _ => false,
        });
    let file = match kind.as_str() {
        // Until the proxy exists, stream the original (fine for H.264/HEVC MP4/MOV).
        "proxy" | "audio" => {
            let proxy = if kind == "proxy" {
                paths.proxy
            } else {
                paths.audio
            };
            if paths.proxy_done.is_file() && proxy.is_file() {
                proxy
            } else {
                source
            }
        }
        // Only once it exists: the client asks for it by name when it's ready, so
        // one URL never serves two different files.
        "light" => paths.light,
        "thumbs" => paths.thumbs,
        "peaks" => paths.peaks,
        "transcript" => {
            // Transcripts from before speaker names get them now.
            crate::speakers::ensure(&app, &source);
            paths.transcript
        }
        _ => return Err(not_found("unknown media file")),
    };
    if !file.is_file() {
        return Err(not_found("not ready"));
    }
    let mut response = ServeFile::new(&file)
        .oneshot(request)
        .await
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .into_response();
    if kind == "peaks" {
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        );
    }
    // Never the original standing in while the preview is missing.
    let lasting = lasting && file != Path::new(&media.path) && response.status().is_success();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if lasting {
            "private, max-age=31536000, immutable"
        } else {
            "no-cache"
        }),
    );
    Ok(response)
}

/// Starts transcription (costs money via the relay, so only on request).
async fn transcribe_media(
    State(app): State<App>,
    UrlPath((id, media_id)): UrlPath<(String, String)>,
) -> ApiResult {
    let live = app
        .store
        .get(&id)
        .ok_or_else(|| not_found("no such project"))?;
    let media = live
        .project
        .media(&media_id)
        .ok_or_else(|| not_found("no such media"))?;
    if !media.has_audio {
        return Err(bad(format!("{} has no audio to transcribe", media.name)));
    }
    if media.is_sound_effect() {
        return Err(bad(format!(
            "{} is a sound effect; there's nothing said to transcribe",
            media.name
        )));
    }
    let status = app
        .media
        .transcribe(PathBuf::from(&media.path), media.has_audio);
    Ok(Json(json!({ "status": status })).into_response())
}

#[derive(Deserialize)]
struct FrameQuery {
    max: Option<u32>,
}

async fn frame_png(
    State(app): State<App>,
    UrlPath((id, frame)): UrlPath<(String, String)>,
    Query(query): Query<FrameQuery>,
) -> ApiResult {
    let frame: i64 = frame
        .trim_end_matches(".png")
        .parse()
        .map_err(|_| bad("frame must be a number"))?;
    let live = app
        .store
        .get(&id)
        .ok_or_else(|| not_found("no such project"))?;
    let images = app
        .frames
        .render(live.project, vec![frame], query.max.unwrap_or(0))
        .await
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    let image = images.first().ok_or_else(|| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "the frame didn't render".to_owned(),
        )
    })?;
    let png =
        encode_png(image).map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    Ok(([(header::CONTENT_TYPE, "image/png")], png).into_response())
}

#[derive(Deserialize, Default)]
struct ExportBody {
    path: Option<String>,
    #[serde(default)]
    options: crate::export::ExportOptions,
}

pub fn default_export_path(project: &Project) -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let movies = home.join("Movies");
    let dir = if movies.is_dir() {
        movies.join("Edit")
    } else {
        home.join("Videos").join("Edit")
    };
    let safe: String = project
        .name
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || " -_".contains(ch) {
                ch
            } else {
                '_'
            }
        })
        .collect();
    dir.join(format!("{}.mp4", safe.trim().if_empty("Edit")))
}

trait IfEmpty {
    fn if_empty<'a>(&'a self, fallback: &'a str) -> &'a str;
}

impl IfEmpty for str {
    fn if_empty<'a>(&'a self, fallback: &'a str) -> &'a str {
        if self.is_empty() {
            fallback
        } else {
            self
        }
    }
}

async fn start_export(
    State(app): State<App>,
    UrlPath(id): UrlPath<String>,
    body: Option<Json<ExportBody>>,
) -> ApiResult {
    let (path, options) = body.map_or((None, Default::default()), |Json(body)| {
        (body.path, body.options)
    });
    if options.wait_for_smoothing
        && !crate::broll::wait_for_smoothing(&id, std::time::Duration::from_secs(120)).await
    {
        return Err(bad("optional optical flow is still running; export the current timeline with wait_for_smoothing false or wait for it to finish"));
    }
    let live = app
        .store
        .get(&id)
        .ok_or_else(|| not_found("no such project"))?;
    let path = path
        .filter(|path| !path.trim().is_empty())
        .map(|path| expand_home(&path))
        .unwrap_or_else(|| default_export_path(&live.project));
    let path = app
        .exports
        .start(
            Arc::clone(&app.store),
            Arc::clone(&app.library),
            live.project,
            options,
            path,
        )
        .map_err(bad)?;
    Ok(Json(json!({ "path": path })).into_response())
}

/// Which export formats and encoders this machine's FFmpeg offers.
async fn export_encoders() -> Json<crate::export::Encoders> {
    Json(
        tokio::task::spawn_blocking(crate::export::encoders)
            .await
            .unwrap_or_default(),
    )
}

#[derive(Deserialize)]
struct ExportedQuery {
    path: String,
}

/// A finished export, downloaded to the device the editor is open on.
async fn exported_file(
    State(app): State<App>,
    Query(query): Query<ExportedQuery>,
    request: Request,
) -> ApiResult {
    let path = PathBuf::from(&query.path);
    if !app.exports.exported(&path) {
        return Err(not_found("not an export from this session"));
    }
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().replace('"', "'"))
        .unwrap_or_else(|| "export".to_owned());
    let mut response = ServeFile::new(&path)
        .oneshot(request)
        .await
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .into_response();
    if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")) {
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, value);
    }
    Ok(response)
}

/// Shows a finished export in Finder (or the file manager) on the machine running Edit.
async fn reveal_export(State(app): State<App>, Json(body): Json<ExportedQuery>) -> ApiResult {
    let path = PathBuf::from(&body.path);
    if !app.exports.exported(&path) {
        return Err(not_found("not an export from this session"));
    }
    let opened = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .status()
    } else {
        std::process::Command::new("xdg-open")
            .arg(path.parent().unwrap_or(&path))
            .status()
    };
    match opened {
        Ok(status) if status.success() => Ok(Json(json!({ "ok": true })).into_response()),
        _ => Err(bad("couldn't open a file browser on this machine")),
    }
}

/// The project's link to its export on Drive, once checked that the file is
/// still there (a deleted or trashed one is unlinked).
async fn drive_link(State(app): State<App>, UrlPath(id): UrlPath<String>) -> ApiResult {
    let (store, library) = (Arc::clone(&app.store), Arc::clone(&app.library));
    let drive = tokio::task::spawn_blocking(move || crate::drive::checked(&store, &library, &id))
        .await
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .map_err(not_found)?;
    Ok(Json(json!({ "drive": drive })).into_response())
}

/// Uploads a finished export to Drive again (after a failed upload); progress
/// comes as `drive` events.
async fn drive_upload(
    State(app): State<App>,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<ExportedQuery>,
) -> ApiResult {
    let live = app
        .store
        .get(&id)
        .ok_or_else(|| not_found("no such project"))?;
    let path = PathBuf::from(&body.path);
    if !app.exports.exported(&path) {
        return Err(not_found("not an export from this session"));
    }
    crate::drive::start(
        Arc::clone(&app.store),
        Arc::clone(&app.library),
        &live.project,
        path,
    );
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn cancel_export(State(app): State<App>, UrlPath(id): UrlPath<String>) -> Json<Value> {
    Json(json!({ "cancelled": app.exports.cancel(&id) }))
}

pub fn expand_home(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default()
            .join(rest),
        None => PathBuf::from(path),
    }
}

#[derive(Deserialize)]
struct BrowseQuery {
    path: Option<String>,
}

async fn browse(Query(query): Query<BrowseQuery>) -> ApiResult {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    let dir = query
        .path
        .filter(|path| !path.is_empty())
        .map(|path| expand_home(&path))
        .unwrap_or(home.clone());
    let dir = dir
        .canonicalize()
        .map_err(|_| not_found("folder not found"))?;
    let entries = tokio::task::spawn_blocking({
        let dir = dir.clone();
        move || -> std::io::Result<Vec<Value>> {
            let mut out = Vec::new();
            for entry in std::fs::read_dir(&dir)?.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let path = entry.path();
                let Ok(meta) = std::fs::metadata(&path) else {
                    continue;
                };
                let is_dir = meta.is_dir();
                let is_media = !is_dir && media::is_media_path(&path);
                if !is_dir && !is_media {
                    continue;
                }
                out.push(json!({
                    "name": name,
                    "path": path.to_string_lossy(),
                    "dir": is_dir,
                    "size": meta.len(),
                }));
            }
            out.sort_by(|a, b| {
                (
                    !a["dir"].as_bool().unwrap_or(false),
                    a["name"].as_str().unwrap_or("").to_lowercase(),
                )
                    .cmp(&(
                        !b["dir"].as_bool().unwrap_or(false),
                        b["name"].as_str().unwrap_or("").to_lowercase(),
                    ))
            });
            Ok(out)
        }
    })
    .await
    .map_err(|error| bad(error.to_string()))?
    .map_err(|error| bad(error.to_string()))?;
    let places: Vec<Value> = ["Desktop", "Movies", "Downloads", "Documents", "Videos", "Music"]
        .iter()
        .map(|name| home.join(name))
        .filter(|path| path.is_dir())
        .map(|path| json!({ "name": path.file_name().map(|n| n.to_string_lossy().to_string()), "path": path.to_string_lossy() }))
        .chain(std::iter::once(json!({ "name": "Home", "path": home.to_string_lossy() })))
        .collect();
    Ok(Json(json!({
        "path": dir.to_string_lossy(),
        "parent": dir.parent().map(|parent| parent.to_string_lossy().to_string()),
        "entries": entries,
        "places": places,
    }))
    .into_response())
}

async fn websocket(State(app): State<App>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| pump_events(socket, app))
}

async fn pump_events(mut socket: WebSocket, app: App) {
    let mut events = app.store.subscribe();
    loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok(event) => {
                    if socket.send(Message::Text(event.to_string().into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let _ = socket.send(Message::Text(json!({ "type": "resync" }).to_string().into())).await;
                }
                Err(_) => break,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
        }
    }
}

async fn font(UrlPath(file): UrlPath<String>) -> ApiResult {
    let bytes =
        edit_render::text::bundled_font_bytes(&file).ok_or_else(|| not_found("no such font"))?;
    Ok((
        [
            (header::CONTENT_TYPE, "font/ttf"),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        bytes,
    )
        .into_response())
}

async fn static_asset(request: Request) -> Response {
    let path = request.uri().path().trim_start_matches('/');
    let (file, path) = match WebAssets::get(path) {
        Some(file) if !path.is_empty() => (file, path.to_owned()),
        // SPA routes fall back to the shell.
        _ => match WebAssets::get("index.html") {
            Some(file) => (file, "index.html".to_owned()),
            None => {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Edit's web UI is not built. Run `just web` (or `bun run --cwd web build`) and restart.",
                )
                    .into_response()
            }
        },
    };
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime.as_ref())
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    (headers, Body::from(file.data.into_owned())).into_response()
}

pub fn bind_addresses(host: Option<&str>, port: u16) -> Vec<SocketAddr> {
    if let Some(host) = host {
        return format!("{host}:{port}").parse().into_iter().collect();
    }
    let mut out: Vec<SocketAddr> = vec![([127, 0, 0, 1], port).into()];
    if let Some(ip) = tailscale_ip() {
        out.push(SocketAddr::new(ip, port));
    }
    out
}

pub fn tailscale_ip() -> Option<std::net::IpAddr> {
    let candidates = [
        "tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ];
    candidates.iter().find_map(|binary| {
        let output = std::process::Command::new(binary)
            .args(["ip", "-4"])
            .output()
            .ok()?;
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()?
            .trim()
            .parse()
            .ok()
    })
}

pub fn tailscale_name() -> Option<String> {
    [
        "tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ]
    .iter()
    .find_map(|binary| {
        let output = std::process::Command::new(binary)
            .args(["status", "--json"])
            .output()
            .ok()?;
        let status: Value = serde_json::from_slice(&output.stdout).ok()?;
        let name = status
            .pointer("/Self/DNSName")?
            .as_str()?
            .trim_end_matches('.')
            .to_ascii_lowercase();
        (!name.is_empty()).then_some(name)
    })
}

// --- scripts -------------------------------------------------------------------

#[derive(Deserialize)]
struct ScriptBody {
    url: String,
}

/// Reads a Google Doc script on this machine (it fetches as the Doc's public link).
async fn read_script(url: &str) -> Result<crate::script::Parsed, ApiError> {
    let id = crate::script::doc_id(url)
        .ok_or_else(|| bad("Paste a Google Docs link (docs.google.com/document/d/…)."))?;
    let (html, title) = tokio::task::spawn_blocking(move || crate::script::fetch_doc(&id))
        .await
        .map_err(|error| bad(error.to_string()))?
        .map_err(bad)?;
    let mut parsed = crate::script::parse(&html);
    if parsed.title.is_empty() {
        parsed.title = title;
    }
    if !parsed
        .blocks
        .iter()
        .any(|block| matches!(block, edit_core::ScriptBlock::Footage { .. }))
    {
        return Err(bad(
            "No footage timestamps linked to Google Drive files were found in that Doc.",
        ));
    }
    Ok(parsed)
}

async fn script_preview(Json(body): Json<ScriptBody>) -> ApiResult {
    let parsed = read_script(&body.url).await?;
    Ok(Json(crate::script::summary(&parsed)).into_response())
}

/// Attaches a Doc's script to the project and starts downloading its footage.
async fn script_attach(
    State(app): State<App>,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<ScriptBody>,
) -> ApiResult {
    let parsed = read_script(&body.url).await?;
    let (live, ()) = app
        .store
        .update(&id, "script", |project| {
            crate::script::attach(project, body.url.trim(), parsed);
            Ok(())
        })
        .map_err(bad)?;
    crate::script::start(&app, &id, false);
    Ok(
        Json(json!({ "rev": live.rev, "project": live.project, "job": app.scripts.get(&id) }))
            .into_response(),
    )
}

async fn script_job(State(app): State<App>, UrlPath(id): UrlPath<String>) -> ApiResult {
    let live = app
        .store
        .get(&id)
        .ok_or_else(|| not_found("no such project"))?;
    Ok(Json(json!({ "job": app.scripts.get(&id), "unfinished": crate::script::unfinished(&live.project) })).into_response())
}

#[derive(Deserialize)]
struct ResumeQuery {
    /// Lay the script out again from scratch (fresh transcript cuts).
    #[serde(default)]
    recut: bool,
}

/// Picks up where a script import stopped (a restart, a failed download), or re-cuts it.
async fn script_resume(
    State(app): State<App>,
    UrlPath(id): UrlPath<String>,
    Query(query): Query<ResumeQuery>,
) -> ApiResult {
    app.store
        .get(&id)
        .ok_or_else(|| not_found("no such project"))?;
    crate::script::start(&app, &id, query.recut);
    Ok(Json(json!({ "job": app.scripts.get(&id) })).into_response())
}

#[derive(Deserialize, Default)]
struct CaptionsBody {
    /// Timeline seconds; default the intro (start to the cut-in before the full footage).
    start: Option<f64>,
    end: Option<f64>,
}

/// Speaker captions for a span (the intro by default), as the agent's caption_speakers tool.
async fn captions(
    State(app): State<App>,
    UrlPath(id): UrlPath<String>,
    body: Option<Json<CaptionsBody>>,
) -> ApiResult {
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let live = app
        .store
        .get(&id)
        .ok_or_else(|| not_found("no such project"))?;
    let fps = live.project.fps();
    let (from, to) = crate::captions::intro(&live.project).unwrap_or((0, live.project.duration()));
    let from = body
        .start
        .map_or(from, |seconds| (seconds * fps).round() as i64);
    let to = body
        .end
        .map_or(to, |seconds| (seconds * fps).round() as i64);
    let summary = crate::captions::caption_speakers(&app, &id, from, to)
        .await
        .map_err(bad)?;
    Ok(Json(summary).into_response())
}

#[derive(Default, Deserialize)]
struct RepackSubtitlesBody {
    /// Timeline seconds; default the whole timeline.
    start: Option<f64>,
    end: Option<f64>,
    #[serde(default)]
    neglect: bool,
    hold_ms: Option<f64>,
    #[serde(default)]
    overlap: bool,
}

/// Repack's subtitles and mutes for a span (all of it by default), as the agent's repack_subtitles tool.
async fn repack_subtitles(
    State(app): State<App>,
    UrlPath(id): UrlPath<String>,
    body: Option<Json<RepackSubtitlesBody>>,
) -> ApiResult {
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let live = app
        .store
        .get(&id)
        .ok_or_else(|| not_found("no such project"))?;
    let fps = live.project.fps();
    let options = crate::subtitles::Options {
        from: body
            .start
            .map_or(0, |seconds| (seconds * fps).round() as i64),
        to: body.end.map_or(live.project.duration(), |seconds| {
            (seconds * fps).round() as i64
        }),
        neglect: body.neglect,
        hold_ms: body
            .hold_ms
            .filter(|hold| hold.is_finite() && (0.0..=3000.0).contains(hold))
            .unwrap_or(crate::subtitles::DEFAULT_HOLD_MS),
        overlap: body.overlap,
    };
    let summary = crate::diag::time_async(
        "subtitles",
        "repack subtitles",
        crate::subtitles::repack_subtitles(&app, &id, options),
    )
    .await
    .map_err(bad)?;
    Ok(Json(summary).into_response())
}

#[derive(Default, Deserialize)]
struct WatchBody {
    /// Watch again even where an answer is cached.
    #[serde(default)]
    force: bool,
    /// Set the segments; default only for a subtitled video.
    segments: Option<bool>,
}

/// The watcher over a subtitled video's footage, as the agent's watch_footage tool.
async fn watch_footage(
    State(app): State<App>,
    UrlPath(id): UrlPath<String>,
    body: Option<Json<WatchBody>>,
) -> ApiResult {
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let options = crate::watch::Options {
        force: body.force,
        segments: body.segments,
    };
    let summary = crate::diag::time_async(
        "watch",
        "watch footage",
        crate::watch::watch_footage(&app, &id, options),
    )
    .await
    .map_err(bad)?;
    Ok(Json(summary).into_response())
}

#[derive(Deserialize)]
struct SpeakerBody {
    voice: String,
    role: String,
    #[serde(default)]
    label: Option<String>,
}

/// Sets who a voice is (its role, which decides its colour) by hand.
async fn set_speaker(
    State(app): State<App>,
    UrlPath((id, media_id)): UrlPath<(String, String)>,
    Json(body): Json<SpeakerBody>,
) -> ApiResult {
    let live = app
        .store
        .get(&id)
        .ok_or_else(|| not_found("no such project"))?;
    let media = live
        .project
        .media(&media_id)
        .ok_or_else(|| not_found("no such media"))?;
    let transcript = crate::speakers::set_role(
        &app,
        Path::new(&media.path),
        &body.voice,
        &body.role,
        body.label.as_deref(),
    )
    .map_err(bad)?;
    Ok(Json(transcript).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_must_match_host_and_port() {
        assert!(same_origin("http://localhost:7700", "localhost:7700"));
        assert!(same_origin("https://kenobi.example", "kenobi.example:443"));
        assert!(same_origin("http://[::1]:7700", "[::1]:7700"));
        for origin in [
            "null",
            "https://evil.example",
            "http://localhost:5173",
            "http://localhost:7700/path",
            "http://localhost:7700?x=1",
        ] {
            assert!(!same_origin(origin, "localhost:7700"), "{origin}");
        }
    }

    #[tokio::test]
    async fn concurrent_uploads_reserve_different_names() {
        let dir = std::env::temp_dir().join(format!(
            "edit-upload-test-{}-{}",
            std::process::id(),
            crate::store::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b) = tokio::join!(
            reserve_upload(&dir, "clip.mp4"),
            reserve_upload(&dir, "clip.mp4")
        );
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_ne!(a, b);
        assert!(a.exists() && b.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
