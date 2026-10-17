//! The desktop app: a native window (Tauri) onto the same server `edit serve`
//! runs, so the UI, REST, websocket and MCP all work exactly as in a browser.

use std::path::{Path, PathBuf};
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
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        return;
    };
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

/// Where `run_as_edit` came from: the binary to update.
const ORIGINAL: &str = "EDIT_EXE";

/// The binary that was started (not the `Edit` link `run_as_edit` runs as).
pub fn original_exe() -> std::io::Result<PathBuf> {
    match std::env::var_os(ORIGINAL) {
        Some(path) => Ok(PathBuf::from(path)),
        None => std::env::current_exe(),
    }
}

/// macOS shows a bare binary in the Dock by its file name, so the `edit`
/// binary would hover as "edit". Outside an app bundle, the window becomes the
/// same program run as `Edit`: a hard link (a copy across disks) in the data
/// folder, exec'd in place, so it keeps this process, its terminal and the
/// terminal's folder access (a wrapper bundle would ask for its own). Returns
/// only if that couldn't be done.
pub fn run_as_edit(home: &Path) {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::process::CommandExt;
        let Ok(exe) = std::env::current_exe().and_then(std::fs::canonicalize) else {
            return;
        };
        if exe.file_name().is_some_and(|name| name == "Edit")
            || exe.to_string_lossy().contains(".app/Contents/MacOS/")
        {
            return;
        }
        // Its own folder: "Edit" and "edit" are one name on a case-insensitive disk.
        let link = home.join("bin").join("Edit");
        let fresh = || -> std::io::Result<()> {
            if let Some(folder) = link.parent() {
                std::fs::create_dir_all(folder)?;
            }
            let _ = std::fs::remove_file(&link);
            std::fs::hard_link(&exe, &link).or_else(|_| std::fs::copy(&exe, &link).map(|_| ()))
        };
        let same = std::fs::metadata(&link)
            .ok()
            .zip(std::fs::metadata(&exe).ok())
            .is_some_and(|(link, exe)| {
                use std::os::unix::fs::MetadataExt;
                link.ino() == exe.ino() && link.dev() == exe.dev()
            });
        if !same && fresh().is_err() {
            return;
        }
        let error = Command::new(&link)
            .args(std::env::args_os().skip(1))
            .env(ORIGINAL, &exe)
            .exec();
        eprintln!("edit: couldn't run as Edit ({error})");
    }
    #[cfg(not(target_os = "macos"))]
    let _ = home;
}
