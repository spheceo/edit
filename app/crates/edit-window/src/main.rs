//! Edit's desktop window: a native webview (Tauri) onto the server `edit`
//! runs, so the UI, REST, websocket and MCP all work exactly as in a browser.
//! (crates/edit's app.rs::run, as its own program.)
//!
//! - `edit-window --url http://127.0.0.1:7700/`: what `edit app` starts (as
//!   `<home>/bin/Edit`, the name the Dock shows). It quits when its stdin
//!   closes, so a server that dies (or execs into an update) leaves no window.
//! - No `--url`: Edit.app (`just bundle`), opened from Finder. The server is
//!   `Resources/edit serve`, started here unless something already answers on
//!   the port, and stopped (Ctrl-C, so its cloud projects are let go) when the
//!   window closes.

use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use tauri::webview::NewWindowResponse;
use tauri::{RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

const DEFAULT_PORT: u16 = 7700;

fn fail(message: &str) -> ! {
    eprintln!("edit: {message}");
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| {
        args.iter()
            .position(|arg| arg == name)
            .and_then(|index| args.get(index + 1))
            .cloned()
    };
    match flag("--url") {
        Some(url) => run(&url, None, true),
        None => {
            let port = flag("--port")
                .map(|port| {
                    port.parse()
                        .unwrap_or_else(|_| fail("--port must be a number"))
                })
                .unwrap_or(DEFAULT_PORT);
            let server = start_server(port);
            run(&format!("http://127.0.0.1:{port}/"), server, false);
        }
    }
}

/// Opens the editor at `url` and runs until the window closes (or, with
/// `watch_stdin`, until stdin closes).
fn run(url: &str, server: Option<Child>, watch_stdin: bool) -> ! {
    let url: Url = url.parse().unwrap_or_else(|_| fail("bad URL"));
    let local = url.clone();
    let app = tauri::Builder::default()
        .setup(move |app| {
            if watch_stdin {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let mut stdin = std::io::stdin();
                    let mut sink = [0_u8; 4096];
                    while matches!(stdin.read(&mut sink), Ok(read) if read > 0) {}
                    handle.exit(0);
                });
            }
            let stays_inside = local.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(local.clone()))
                .title("Edit")
                // The page shows its own title; the bar keeps just the traffic lights.
                .hidden_title(true)
                // A see-through bar over a black window: black, like the page.
                .title_bar_style(tauri::TitleBarStyle::Transparent)
                .background_color(tauri::webview::Color(0, 0, 0, 255))
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 600.0)
                // Let the page take file drops itself (the timeline uploads them).
                .disable_drag_drop_handler()
                // Links out (articles, sources) belong in the browser, not the editor's window.
                .on_navigation(move |url| {
                    let inside = url.origin() == stays_inside.origin();
                    if !inside {
                        open_in_browser(url);
                    }
                    inside
                })
                .on_new_window(|url, _| {
                    open_in_browser(&url);
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| fail(&format!("could not open the window: {error}")));
    let mut server = server;
    app.run(move |_, event| {
        if let RunEvent::Exit = event {
            if let Some(child) = server.take() {
                stop(child);
            }
        }
    });
    std::process::exit(0);
}

fn open_in_browser(url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = Command::new("open").arg(url.as_str()).spawn();
    }
}

/// Edit.app's server: `Resources/edit serve` beside this program, unless an
/// Edit already serves on the port (then the window opens onto that one).
fn start_server(port: u16) -> Option<Child> {
    if TcpListener::bind(("127.0.0.1", port)).is_err() {
        return None;
    }
    let exe = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .unwrap_or_else(|error| fail(&format!("could not find this program: {error}")));
    let edit = exe
        .parent()
        .and_then(|macos| macos.parent())
        .map(|contents| contents.join("Resources").join("edit"))
        .unwrap_or_else(|| fail("Edit.app has no Resources/edit"));
    let child = Command::new(&edit)
        .args(["serve", "--port", &port.to_string()])
        // Opened from Finder: the server borrows the login shell's PATH and keys.
        .env("EDIT_ADOPT_SHELL_ENV", "1")
        .stdin(Stdio::null())
        .spawn()
        .unwrap_or_else(|error| fail(&format!("could not start {}: {error}", edit.display())));
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(30) {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Some(child)
}

/// Stops the server as Ctrl-C would (it pushes its cloud projects and lets
/// their locks go), and kills it if it hasn't gone after ten seconds.
fn stop(mut child: Child) {
    let _ = Command::new("kill")
        .args(["-INT", &child.id().to_string()])
        .status();
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(10) {
        if matches!(child.try_wait(), Ok(Some(_)) | Err(_)) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}
