//! The desktop app: a native window (Tauri) onto the same server `edit serve`
//! runs, so the UI, REST, websocket and MCP all work exactly as in a browser.

use std::process::Command;
use std::time::Duration;

use tauri::webview::NewWindowResponse;
use tauri::{Url, WebviewUrl, WebviewWindowBuilder};

/// Opens the editor at `url` and runs until the window closes.
pub fn run(url: Url) -> ! {
    let local = url.clone();
    let result = tauri::Builder::default()
        .setup(move |app| {
            let stays_inside = local.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(local.clone()))
                .title("Edit")
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
        .run(tauri::generate_context!());
    if let Err(error) = result {
        crate::fail(&format!("could not open the window: {error}"));
    }
    std::process::exit(0);
}

fn open_in_browser(url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = Command::new("open").arg(url.as_str()).spawn();
    }
}

/// Opened from Finder, the app gets launchd's bare environment: no Homebrew on
/// PATH (FFmpeg, Codex) and none of the shell's keys. Borrow them from the
/// user's login shell, as a terminal would have them.
pub fn adopt_shell_env() {
    use std::io::IsTerminal;
    if std::io::stdin().is_terminal() {
        return;
    }
    const KEYS: [&str; 4] = [
        "PATH",
        "GOOGLE_DRIVE_CLIENT_ID",
        "GOOGLE_DRIVE_CLIENT_SECRET",
        "GOOGLE_DOCS_REFRESH_TOKEN",
    ];
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned());
    let Ok(mut child) = Command::new(shell)
        .args(["-ilc", "env -0"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return;
    };
    let mut stdout = child.stdout.take().expect("piped stdout");
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut env = Vec::new();
        let _ = std::io::Read::read_to_end(&mut stdout, &mut env);
        let _ = sender.send(env);
    });
    // A shell profile that waits on something mustn't keep the app from opening.
    let Ok(env) = receiver.recv_timeout(Duration::from_secs(3)) else {
        let _ = child.kill();
        return;
    };
    let _ = child.wait();
    for entry in env.split(|byte| *byte == 0) {
        let entry = String::from_utf8_lossy(entry);
        let Some((key, value)) = entry.split_once('=') else {
            continue;
        };
        let missing = std::env::var_os(key).is_none_or(|current| current.is_empty());
        if KEYS.contains(&key) && (key == "PATH" || missing) && !value.is_empty() {
            std::env::set_var(key, value);
        }
    }
}
