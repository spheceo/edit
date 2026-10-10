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
        .route("/api/agent", get(agent_status))
        .route("/api/agent/models", get(agent_models))
        .route("/api/projects/{id}/agent", get(agent_chat).post(agent_send))
        .route("/api/projects/{id}/agent/stop", post(agent_stop))
        .route("/api/projects/{id}/agent/reset", post(agent_reset))
        .route("/api/projects/{id}/captions", post(captions))
        .route("/api/scripts/preview", post(script_preview))
        .route("/api/projects/{id}/script", post(script_attach))
        .route(
            "/api/projects/{id}/script/job",
            get(script_job).post(script_resume),
        )
        .route("/api/fs", get(browse))
        .route("/api/ws", get(websocket))
        .route("/fonts/{file}", get(font))
        .route("/mcp", post(crate::mcp::handle).get(crate::mcp::reject_get))
        .fallback(get(static_asset))
        .layer(middleware::from_fn_with_state(app.clone(), check_host))
        .with_state(app)
}

/// Rejects requests whose Host isn't this machine (DNS-rebinding guard).
async fn check_host(State(app): State<App>, request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let name = host.rsplit_once(':').map_or(host, |(name, port)| {
        if port.chars().all(|ch| ch.is_ascii_digit()) {
            name
        } else {
            host
        }
    });
    let name = name
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    let allowed = app.allowed_hosts.contains(&name)
        || name.ends_with(".ts.net")
        || name.ends_with(".localhost");
    if !allowed {
        return (
            StatusCode::FORBIDDEN,
            format!("host {name} is not allowed; set EDIT_HOSTS"),
        )
            .into_response();
    }
    next.run(request).await
}

async fn health(State(app): State<App>) -> Json<Value> {
    Json(json!({ "name": "edit", "version": env!("CARGO_PKG_VERSION"), "machine": &*app.machine }))
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
    let target = unique_path(&dir, &name);
    let partial = PartialFile(Some(target.with_extension("uploading")));
    let result = async {
        let path = partial.0.as_deref().expect("armed");
        let mut file = tokio::fs::File::create(path).await?;
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
    Ok(Json(json!({ "rev": rev, "added": added, "project": project })).into_response())
}

/// `dir/name`, or `dir/name-2.ext`, `-3`… if taken.
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("upload");
    let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
    (2..)
        .map(|n| {
            dir.join(if ext.is_empty() {
                format!("{stem}-{n}")
            } else {
                format!("{stem}-{n}.{ext}")
            })
        })
        .find(|path| !path.exists())
        .expect("a free name")
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
    for path in paths {
        let path = PathBuf::from(&path);
        let path = path.canonicalize().unwrap_or(path);
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
                        name: path.file_name().map_or_else(
                            || path_text.clone(),
                            |name| name.to_string_lossy().to_string(),
                        ),
                        path: path_text.clone(),
                        kind: probe.kind,
                        duration: probe.duration,
                        width: probe.width,
                        height: probe.height,
                        fps: probe.fps,
                        has_audio: probe.has_audio,
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
    for (path, probe) in probed {
        app.media.ensure(path, probe);
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
    let color = colors[project.clips.len() / 2 % colors.len()];
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
    if media.kind == MediaKind::Video {
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
            let status = app.media.status(Path::new(&media.path));
            (media.id.clone(), json!(status))
        })
        .collect();
    Ok(Json(json!({ "media": statuses })).into_response())
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
    let file = match kind.as_str() {
        // Until the proxy exists, stream the original (fine for H.264/HEVC MP4/MOV).
        "proxy" => {
            if paths.proxy.is_file() {
                paths.proxy
            } else {
                source
            }
        }
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
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
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
    let png = encode_png(&images[0])
        .map_err(|error| ApiError(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    Ok(([(header::CONTENT_TYPE, "image/png")], png).into_response())
}

#[derive(Deserialize, Default)]
struct ExportBody {
    path: Option<String>,
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
    let live = app
        .store
        .get(&id)
        .ok_or_else(|| not_found("no such project"))?;
    let path = body
        .and_then(|Json(body)| body.path)
        .filter(|path| !path.trim().is_empty())
        .map(|path| expand_home(&path))
        .unwrap_or_else(|| default_export_path(&live.project));
    app.exports
        .start(Arc::clone(&app.store), live.project, path.clone())
        .map_err(bad)?;
    Ok(Json(json!({ "path": path })).into_response())
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
    /// Timeline seconds; default the intro (start to the first cut-in).
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
