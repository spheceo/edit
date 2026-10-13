//! Self-update from the repo's GitHub Releases (built by the release
//! workflow). `GET /api/update` says whether a newer version is out;
//! `POST /api/update` downloads it, checks its SHA-256, swaps it in for the
//! running binary and restarts in place. On Unix that's an
//! exec, so `edit serve` keeps its terminal, PID and flags, and the open
//! editor reloads once the new version answers.
//!
//! Only release builds update themselves (the workflow builds with
//! EDIT_RELEASE=1); a dev build would otherwise swap out target/debug/edit.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

const REPO: &str = "spheceo/edit";

/// A new release shows up within this long of the editor asking.
const CHECK_EVERY: Duration = Duration::from_secs(10 * 60);

/// Whether this build installs updates itself.
pub fn enabled() -> bool {
    cfg!(unix) && option_env!("EDIT_RELEASE").is_some()
}

/// The release archive for this machine, as the release workflow names it.
fn asset_target() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(target_os = "macos") {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "aarch64-unknown-linux-gnu"
    } else {
        "x86_64-unknown-linux-gnu"
    }
}

/// The newest release with a build for this machine.
#[derive(Clone, Debug)]
pub struct Release {
    pub tag: String,
    url: String,
    size: u64,
    sha256: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    #[default]
    Idle,
    Downloading,
    /// Swapped in; the server is about to exec the new binary.
    Restarting,
}

#[derive(Serialize)]
pub struct Status {
    current: &'static str,
    /// A newer version's tag ("v0.2.0"), if there is one.
    latest: Option<String>,
    phase: Phase,
    /// 0–1 while downloading.
    progress: f32,
    error: Option<String>,
    /// False for builds that don't update themselves (dev builds).
    enabled: bool,
}

#[derive(Default)]
struct State {
    latest: Option<Release>,
    checked: Option<Instant>,
    checking: bool,
    phase: Phase,
    progress: f32,
    error: Option<String>,
}

pub struct Updater {
    /// Downloads are staged in `<home>/updates`.
    home: PathBuf,
    state: Mutex<State>,
}

impl Updater {
    pub fn new(home: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            home,
            state: Mutex::default(),
        })
    }

    /// The current state, asking the relay first if it's been a while.
    pub async fn status(self: &Arc<Self>) -> Status {
        let due = {
            let mut state = self.state.lock().unwrap();
            let due = enabled()
                && !state.checking
                && state.phase == Phase::Idle
                && state.checked.is_none_or(|at| at.elapsed() >= CHECK_EVERY);
            state.checking |= due;
            due
        };
        if due {
            // Offline or a relay hiccup just means no update to offer; retry next time.
            let found = tokio::task::spawn_blocking(check)
                .await
                .ok()
                .and_then(Result::ok);
            let mut state = self.state.lock().unwrap();
            state.checking = false;
            if let Some(found) = found {
                state.latest = found;
                state.checked = Some(Instant::now());
            }
        }
        self.snapshot()
    }

    fn snapshot(&self) -> Status {
        let state = self.state.lock().unwrap();
        Status {
            current: VERSION,
            latest: state.latest.as_ref().map(|release| release.tag.clone()),
            phase: state.phase,
            progress: state.progress,
            error: state.error.clone(),
            enabled: enabled(),
        }
    }

    /// Starts installing the newest release; the server restarts into it when done.
    pub fn start(self: &Arc<Self>) -> Result<Status, String> {
        if !enabled() {
            return Err("this build doesn't update itself; pull and rebuild".to_owned());
        }
        let release = {
            let mut state = self.state.lock().unwrap();
            if state.phase != Phase::Idle {
                drop(state);
                return Ok(self.snapshot());
            }
            let release = state.latest.clone().ok_or("Edit is up to date")?;
            state.phase = Phase::Downloading;
            state.progress = 0.0;
            state.error = None;
            release
        };
        let this = Arc::clone(self);
        std::thread::spawn(move || {
            let staged = this.home.join("updates");
            let result = install(&release, &staged, |progress| {
                this.state.lock().unwrap().progress = progress;
            });
            match result {
                Ok(exe) => {
                    this.state.lock().unwrap().phase = Phase::Restarting;
                    println!("edit: updated to {}; restarting", release.tag);
                    // Let the request that started this (and a status poll) answer first.
                    std::thread::sleep(Duration::from_millis(500));
                    restart(&exe);
                }
                Err(error) => {
                    eprintln!("edit: update to {} failed: {error}", release.tag);
                    let mut state = this.state.lock().unwrap();
                    state.phase = Phase::Idle;
                    state.progress = 0.0;
                    state.error = Some(error);
                }
            }
        });
        Ok(self.snapshot())
    }
}

/// Asks GitHub for the newest release; `None` when this one is current (or
/// the newest has no build for this machine).
pub fn check() -> Result<Option<Release>, String> {
    let (code, body) = fetch(&format!(
        "https://api.github.com/repos/{REPO}/releases/latest"
    ))?;
    if code == 404 {
        return Ok(None); // nothing released yet
    }
    if code != 200 {
        return Err(format!("GitHub answered {code}: {}", body.trim()));
    }
    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|error| format!("unexpected answer: {error}"))?;
    let tag = value["tag_name"]
        .as_str()
        .ok_or("a release without a tag")?;
    if !newer(tag, VERSION) {
        return Ok(None);
    }
    let name = format!("edit-{}.tar.gz", asset_target());
    let Some(asset) = value["assets"]
        .as_array()
        .and_then(|assets| assets.iter().find(|asset| asset["name"] == name.as_str()))
    else {
        return Ok(None);
    };
    let url = asset["browser_download_url"]
        .as_str()
        .ok_or("an asset without a download link")?
        .to_owned();
    // GitHub hashes uploads itself; the .sha256 beside the archive is the fallback.
    let sha256 = match asset["digest"]
        .as_str()
        .and_then(|digest| digest.strip_prefix("sha256:"))
    {
        Some(digest) => digest.to_owned(),
        None => {
            let (code, body) = fetch(&format!("{url}.sha256"))?;
            let digest = body.split_whitespace().next().unwrap_or_default();
            if code != 200 || digest.is_empty() {
                return Err(format!("{tag} has no checksum for {name}"));
            }
            digest.to_owned()
        }
    };
    Ok(Some(Release {
        tag: tag.to_owned(),
        url,
        size: asset["size"].as_u64().unwrap_or(0),
        sha256,
    }))
}

/// GETs `url` with curl (following redirects): the status code and body.
fn fetch(url: &str) -> Result<(u16, String), String> {
    let output = Command::new("curl")
        .args(["-sSL", "--max-time", "10", "-w", "\n%{http_code}", url])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("curl: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "could not reach GitHub: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let (body, code) = text.rsplit_once('\n').unwrap_or((&text, "0"));
    Ok((code.trim().parse().unwrap_or(0), body.to_owned()))
}

/// Whether `version` ("0.2.0") is newer than `current`.
fn newer(version: &str, current: &str) -> bool {
    let parse = |text: &str| -> Option<(u64, u64, u64)> {
        let mut parts = text.trim_start_matches('v').split('.').map(str::parse);
        let version = (
            parts.next()?.ok()?,
            parts.next()?.ok()?,
            parts.next()?.ok()?,
        );
        parts.next().is_none().then_some(version)
    };
    matches!((parse(version), parse(current)), (Some(version), Some(current)) if version > current)
}

/// Downloads, verifies and swaps in `release`; returns the binary to restart into.
pub fn install(
    release: &Release,
    staged: &Path,
    progress: impl Fn(f32),
) -> Result<PathBuf, String> {
    let _ = std::fs::remove_dir_all(staged);
    std::fs::create_dir_all(staged).map_err(|error| format!("{}: {error}", staged.display()))?;
    let archive = staged.join("edit.tar.gz");
    download(&release.url, &archive, release.size, &progress)?;

    let digest = sha256(&archive)?;
    if !digest.eq_ignore_ascii_case(&release.sha256) {
        return Err(format!(
            "the download is corrupt (SHA-256 {digest}, expected {})",
            release.sha256
        ));
    }
    let unpacked = Command::new("tar")
        .arg("-xzf")
        .arg(&archive)
        .arg("-C")
        .arg(staged)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("tar: {error}"))?;
    if !unpacked.status.success() {
        return Err(format!(
            "could not unpack the update: {}",
            String::from_utf8_lossy(&unpacked.stderr).trim()
        ));
    }
    let binary = staged.join("edit");
    if !binary.is_file() {
        return Err("the update has no edit binary".to_owned());
    }
    let exe = swap_in(&binary)?;
    let _ = std::fs::remove_dir_all(staged);
    progress(1.0);
    Ok(exe)
}

/// Fetches `url` into `path` with curl, reporting 0–1 as the file grows.
fn download(url: &str, path: &Path, size: u64, progress: &impl Fn(f32)) -> Result<(), String> {
    let mut curl = Command::new("curl")
        .args([
            "-fsSL",
            "--retry",
            "2",
            "--connect-timeout",
            "15",
            "--max-time",
            "1800",
            "-o",
        ])
        .arg(path)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("curl: {error}"))?;
    let status = loop {
        if let Some(status) = curl.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        let have = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        progress((have as f32 / size.max(1) as f32).min(0.99));
        std::thread::sleep(Duration::from_millis(200));
    };
    if !status.success() {
        let mut stderr = String::new();
        if let Some(mut pipe) = curl.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        return Err(format!("download failed: {}", stderr.trim()));
    }
    Ok(())
}

fn sha256(path: &Path) -> Result<String, String> {
    use sha2::Digest;
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = sha2::Sha256::new();
    let mut buffer = vec![0; 1 << 20];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// Replaces the running binary with `new`. The copy lands beside it first so
/// the final rename is atomic (and works when ~/.edit is on another disk); a
/// fresh file rather than an overwrite also keeps macOS's signature check happy.
fn swap_in(new: &Path) -> Result<PathBuf, String> {
    // The binary that was started, not the `Edit` link the app runs as.
    let exe = crate::app::original_exe()
        .and_then(std::fs::canonicalize)
        .map_err(|error| format!("could not find the running binary: {error}"))?;
    let dir = exe.parent().ok_or("the running binary has no folder")?;
    let temp = dir.join(".edit-update");
    let unwritable = |error: std::io::Error| {
        format!(
            "can't write to {} ({error}); reinstall with the install script",
            dir.display()
        )
    };
    std::fs::copy(new, &temp).map_err(unwritable)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o755))
            .map_err(unwritable)?;
    }
    std::fs::rename(&temp, &exe).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        unwritable(error)
    })?;
    Ok(exe)
}

/// Becomes `exe`, with the same arguments. Sockets are close-on-exec, so the
/// new server binds the same ports straight away.
fn restart(exe: &Path) -> ! {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = Command::new(exe).args(std::env::args_os().skip(1)).exec();
        eprintln!("edit: could not restart ({error}); start `edit serve` again");
    }
    #[cfg(not(unix))]
    eprintln!("edit: updated {}; start `edit serve` again", exe.display());
    std::process::exit(1);
}

/// `edit update`.
pub fn run_cli(home: &Path) {
    if !enabled() {
        println!("This build of Edit ({VERSION}) doesn't update itself; pull and rebuild.");
        return;
    }
    let release = match check() {
        Ok(Some(release)) => release,
        Ok(None) => return println!("Edit is up to date ({VERSION})."),
        Err(error) => {
            eprintln!("edit: could not check for updates: {error}");
            std::process::exit(1);
        }
    };
    println!("Updating Edit {VERSION} → {}…", release.tag);
    match install(&release, &home.join("updates"), |_| {}) {
        Ok(_) => println!("Done. Restart `edit serve` if it's running."),
        Err(error) => {
            eprintln!("edit: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_compares_numerically() {
        assert!(newer("0.1.10", "0.1.9"));
        assert!(newer("v1.0.0", "0.9.9"));
        assert!(!newer("0.1.0", "0.1.0"));
        assert!(!newer("0.0.9", "0.1.0"));
        assert!(!newer("0.2.0-beta", "0.1.0"));
        assert!(!newer("garbage", "0.1.0"));
    }
}
