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

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

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
            // Brought to the front when the server asks (the browser's sign-in came back).
            if let (Some(host), Some(port)) = (local.host_str(), local.port_or_known_default()) {
                let handle = app.handle().clone();
                let host = host.to_owned();
                std::thread::spawn(move || follow_focus(&handle, &host, port));
            }
            let stays_inside = local.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(local.clone()))
                .title("Edit")
                // The page shows its own title; the bar keeps just the traffic lights.
                .hidden_title(true)
                // A see-through bar over the page's own colour (the kit's #0b0b0b).
                .title_bar_style(tauri::TitleBarStyle::Transparent)
                .background_color(tauri::webview::Color(11, 11, 11, 255))
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 600.0)
                // Opens filling the screen (zoomed, not macOS full screen: the
                // menu bar and Dock stay); the size above is what un-zooming gives.
                .maximized(true)
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

/// Asks the server, again and again, whether the window should come to the
/// front (`GET /api/window/next`, a long poll: `{"focus":true}` when it should,
/// `{"focus":false}` after ~25 s to ask again), and brings it forward when told.
/// A server without the route (older) or not answering is asked again later.
fn follow_focus(handle: &AppHandle, host: &str, port: u16) {
    loop {
        match ask_focus(host, port) {
            Ok(true) => {
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            Ok(false) => {}
            Err(()) => std::thread::sleep(Duration::from_secs(5)),
        }
    }
}

/// One long poll: whether the server wants the window in front.
fn ask_focus(host: &str, port: u16) -> Result<bool, ()> {
    let mut stream = TcpStream::connect((host, port)).map_err(|_| ())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(40)))
        .map_err(|_| ())?;
    write!(
        stream,
        "GET /api/window/next HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    )
    .map_err(|_| ())?;
    let mut answer = String::new();
    stream.read_to_string(&mut answer).map_err(|_| ())?;
    if !answer.starts_with("HTTP/1.1 200") {
        return Err(());
    }
    Ok(answer.contains("\"focus\":true"))
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

#[cfg(test)]
mod tests {
    use super::ask_focus;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// A server answering one request with `answer`; what it was asked comes back.
    fn serve_once(answer: &'static str) -> (u16, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let asked = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            // The whole request first, as a server does: closing with some of
            // it unread resets the connection under the answer.
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            while !request.windows(4).any(|end| end == b"\r\n\r\n") {
                let read = stream.read(&mut chunk).unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
            }
            stream.write_all(answer.as_bytes()).unwrap();
            String::from_utf8_lossy(&request).into_owned()
        });
        (port, asked)
    }

    #[test]
    fn the_window_comes_forward_only_when_the_server_says_so() {
        let (port, asked) =
            serve_once("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"focus\":true}");
        assert_eq!(ask_focus("127.0.0.1", port), Ok(true));
        assert!(asked
            .join()
            .unwrap()
            .starts_with("GET /api/window/next HTTP/1.1\r\n"));
        let (port, _) = serve_once("HTTP/1.1 200 OK\r\n\r\n{\"focus\":false}");
        assert_eq!(ask_focus("127.0.0.1", port), Ok(false));
        // An older server without the route: asked again later.
        let (port, _) = serve_once("HTTP/1.1 404 Not Found\r\n\r\nnot found");
        assert_eq!(ask_focus("127.0.0.1", port), Err(()));
    }
}
