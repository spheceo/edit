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
            show_as_edit();
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

/// Run as a bare binary rather than from Edit.app, macOS shows the app (Dock,
/// app switcher) by its file name, "edit". Give LaunchServices its display
/// name instead, as Chromium does for its helpers. A bundle would do it too,
/// but then macOS asks for folder access the terminal already has. The calls
/// are private, so they're looked up at run time and skipped if missing.
#[cfg(target_os = "macos")]
fn show_as_edit() {
    use std::ffi::{c_char, c_void, CString};
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            allocator: *const c_void,
            text: *const c_char,
            encoding: u32,
        ) -> *const c_void;
    }
    extern "C" {
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }
    const RTLD_DEFAULT: *mut c_void = -2_isize as *mut c_void;
    const UTF8: u32 = 0x0800_0100;
    const DEFAULT_SESSION: i32 = -2;
    type CurrentApp = unsafe extern "C" fn() -> *const c_void;
    type SetInformation = unsafe extern "C" fn(
        i32,
        *const c_void,
        *const c_void,
        *const c_void,
        *mut *const c_void,
    ) -> i32;
    let find = |name: &str| {
        let name = CString::new(name).expect("symbol name");
        // SAFETY: looking a symbol up by a valid C string.
        unsafe { dlsym(RTLD_DEFAULT, name.as_ptr()) }
    };
    let (current, set, key) = (
        find("_LSGetCurrentApplicationASN"),
        find("_LSSetApplicationInformationItem"),
        find("_kLSDisplayNameKey"),
    );
    if current.is_null() || set.is_null() || key.is_null() {
        return;
    }
    // SAFETY: the symbols have these signatures (as Chromium declares them);
    // `key` points at a CFStringRef; the name string lives for the process.
    unsafe {
        let current: CurrentApp = std::mem::transmute(current);
        let set: SetInformation = std::mem::transmute(set);
        let app = current();
        if app.is_null() {
            return;
        }
        let name = CFStringCreateWithCString(std::ptr::null(), c"Edit".as_ptr(), UTF8);
        set(
            DEFAULT_SESSION,
            app,
            *(key as *const *const c_void),
            name,
            std::ptr::null_mut(),
        );
    }
}

#[cfg(not(target_os = "macos"))]
fn show_as_edit() {}
