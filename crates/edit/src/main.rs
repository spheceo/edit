mod agent;
mod app;
mod broll;
mod captions;
mod cutin;
mod diag;
mod drive;
mod edit_plan;
mod edit_review;
mod export;
mod footage_search;
mod guard;
mod library;
mod loudness;
#[cfg(target_os = "macos")]
mod mac_media;
mod mcp;
mod media;
mod media_drive;
mod mix;
mod render;
mod research;
mod script;
mod seats;
mod server;
mod sfx;
mod skills;
mod speakers;
mod store;
mod subtitles;
mod tools;
mod track;
mod transcribe;
mod update;
mod voice;
mod voiceover;
mod watch;

use std::path::PathBuf;
use std::sync::Arc;

const DEFAULT_PORT: u16 = 7700;

const HELP: &str = "edit — a local, agent-driven video editor

USAGE
  edit [app] [--port N] [--home DIR]
      Open the editor in its own window (the server below runs inside it; if
      an Edit is already serving on the port, the window opens onto that).
  edit serve [--port N] [--host ADDR] [--home DIR]
      Serve the editor. Binds 127.0.0.1 and this machine's Tailscale IP.
      Open http://localhost:7700 (WebGPU needs localhost or HTTPS; for other
      devices use `tailscale serve --bg http://127.0.0.1:7700`).
  edit mcp
      Print how to connect Codex / Claude Code to the editor.
  edit media [use DIR | off | move --to DIR]
      Keep big media files (downloads, uploads, exports) on another drive;
      `edit media help` says more.
  edit update
      Install the newest release (the editor also offers it, one click).
  edit --version

ENV
  EDIT_HOME   data directory (default ~/.edit)
  EDIT_MEDIA_DIR  keep big media files here instead (overrides the setting)
  EDIT_HOSTS  extra Host names to accept, comma-separated
  GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, GOOGLE_DOCS_REFRESH_TOKEN
              a Google sign-in that can read the team's sound library in Drive
";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| {
        args.iter()
            .position(|arg| arg == name)
            .and_then(|index| args.get(index + 1))
            .cloned()
    };
    let port = || {
        flag("--port")
            .map(|port| {
                port.parse()
                    .unwrap_or_else(|_| fail("--port must be a number"))
            })
            .unwrap_or(DEFAULT_PORT)
    };
    let home = || {
        flag("--home")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("EDIT_HOME").map(PathBuf::from))
            .unwrap_or_else(default_home)
    };
    match args.first().map(String::as_str) {
        Some("serve") => serve(home(), flag("--host"), port()),
        Some("app") | Some("--port" | "--home") | None => app(home(), port()),
        Some("mcp") => {
            let port = flag("--port").unwrap_or_else(|| DEFAULT_PORT.to_string());
            println!(
                "Start the editor with `edit serve`, then register it once:\n\n  claude mcp add --transport http edit http://127.0.0.1:{port}/mcp\n  codex mcp add edit --url http://127.0.0.1:{port}/mcp\n\nAgents then see tools like get_project, add_text, update_clip, set_keyframes,\nrender_frame and contact_sheet, and their edits appear live in the open project."
            );
        }
        Some("media") => media_drive::run_cli(&home(), port(), args.get(1..).unwrap_or_default()),
        Some("update") => update::run_cli(
            &std::env::var_os("EDIT_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(default_home),
        ),
        Some("--version" | "-V" | "version") => println!("edit {}", env!("CARGO_PKG_VERSION")),
        Some("--help" | "-h" | "help") => print!("{HELP}"),
        Some(other) => fail(&format!("unknown command {other}\n\n{HELP}")),
    }
}

pub(crate) fn fail(message: &str) -> ! {
    eprintln!("edit: {message}");
    std::process::exit(2);
}

fn default_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".edit")
}

fn hostname() -> Option<String> {
    let output = std::process::Command::new("hostname")
        .arg("-s")
        .output()
        .ok()?;
    let name = String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_ascii_lowercase();
    (!name.is_empty()).then_some(name)
}

fn serve(home: PathBuf, host: Option<String>, port: u16) {
    let runtime = tokio::runtime::Runtime::new().unwrap_or_else(|error| fail(&error.to_string()));
    runtime.block_on(async move {
        for handle in start(home, host, port).await {
            let _ = handle.await;
        }
    });
}

/// The desktop app: the same server, in this process, with a window onto it.
fn app(home: PathBuf, port: u16) {
    app::run_as_edit(&home);
    app::adopt_shell_env();
    let runtime = tokio::runtime::Runtime::new().unwrap_or_else(|error| fail(&error.to_string()));
    // Something already on the port is most likely another Edit (`edit serve`,
    // `just dev`, the app opened twice): open onto it rather than run a second
    // server over the same projects.
    let taken = std::net::TcpListener::bind(("127.0.0.1", port)).is_err();
    if !taken {
        runtime.block_on(start(home, None, port));
    }
    let url = format!("http://127.0.0.1:{port}/")
        .parse()
        .unwrap_or_else(|_| fail("bad URL"));
    app::run(url);
}

/// Opens the store and starts listening; the server runs on the handles.
async fn start(home: PathBuf, host: Option<String>, port: u16) -> Vec<tokio::task::JoinHandle<()>> {
    diag::open(&home);
    for (tool, path) in [("ffmpeg", tools::ffmpeg()), ("ffprobe", tools::ffprobe())] {
        if std::process::Command::new(path)
            .arg("-version")
            .output()
            .is_err()
        {
            diag::warn(
                "edit",
                format!("{tool} not found; importing and export need FFmpeg"),
            );
        }
    }
    diag::info(
        "edit",
        format!(
            "FFmpeg: {} ({})",
            tools::ffmpeg().to_string_lossy(),
            if tools::bundled() {
                "shipped with Edit"
            } else {
                "from PATH"
            }
        ),
    );
    let store = Arc::new(
        store::Store::open(home.clone())
            .unwrap_or_else(|error| fail(&format!("{}: {error}", home.display()))),
    );
    tools::use_cache_dir(store.cache_dir());
    store.publish_layout();
    media_drive::hold_lock(&home);
    match store.layout().drive() {
        Ok(Some(dir)) => diag::info("media", format!("media drive: {}", dir.display())),
        Ok(None) => {}
        Err(problem) => diag::warn("media", problem),
    }
    let mut allowed = vec![
        "localhost".to_owned(),
        "127.0.0.1".to_owned(),
        "::1".to_owned(),
    ];
    if let Some(name) = hostname() {
        allowed.push(name);
    }
    if let Some(ip) = server::tailscale_ip() {
        allowed.push(ip.to_string());
    }
    if let Some(name) = server::tailscale_name() {
        allowed.push(name);
    }
    if let Some(host) = &host {
        allowed.push(host.to_ascii_lowercase());
    }
    if let Ok(extra) = std::env::var("EDIT_HOSTS") {
        allowed.extend(
            extra
                .split(',')
                .map(|host| host.trim().to_ascii_lowercase())
                .filter(|host| !host.is_empty()),
        );
    }
    let cache = store.cache_dir();
    let app = server::App {
        updater: update::Updater::new(home.clone()),
        voices: Arc::new(voice::Voices::new(&home)),
        agents: agent::Agents::new(Arc::clone(&store), home.clone(), port),
        scripts: Arc::new(script::Jobs::default()),
        library: Arc::new(library::Library::default()),
        media: media::Processor::new(Arc::clone(&store)),
        store,
        frames: render::FrameRenderer::start(cache),
        exports: Arc::new(render::Exports::default()),
        allowed_hosts: Arc::new(allowed),
        machine: hostname()
            .unwrap_or_else(|| "this machine".to_owned())
            .into(),
    };
    speakers::watch(app.clone());
    let router = server::router(app);
    let mut handles = Vec::new();
    for address in server::bind_addresses(host.as_deref(), port) {
        match tokio::net::TcpListener::bind(address).await {
            Ok(listener) => {
                println!("edit: http://{address}");
                let _ = broll::LISTENING.set(listener.local_addr().unwrap_or(address));
                let router = router.clone();
                handles.push(tokio::spawn(async move {
                    if let Err(error) = axum::serve(listener, router).await {
                        eprintln!("edit: {address}: {error}");
                    }
                }));
            }
            Err(error) => eprintln!("edit: could not bind {address}: {error}"),
        }
    }
    if handles.is_empty() {
        fail(&format!("nothing to listen on (is port {port} taken?)"));
    }
    println!("edit: data in {}", home.display());
    if update::enabled() {
        std::thread::spawn(|| {
            if let Ok(Some(release)) = update::check() {
                println!(
                    "edit: {} is out (this is {}); update from the editor or run `edit update`",
                    release.tag,
                    update::VERSION
                );
            }
        });
    }
    handles
}
