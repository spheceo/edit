//! Diagnostics: what Edit did, what went wrong and how long things took, so a
//! user can hand over one report when something breaks (the UI's "Report a
//! problem"). Recent lines stay in memory; everything also goes to
//! `~/.edit/logs/edit.log` (rotated), so it survives a crash.

use std::collections::{HashMap, VecDeque};
use std::fmt::Display;
use std::future::Future;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;

/// Lines kept in memory for the report.
const KEEP: usize = 2000;
/// The log file is set aside (as edit.log.1) when it grows past this.
const ROTATE_BYTES: u64 = 8 << 20;
/// Durations kept per operation, for its median.
const RECENT: usize = 64;
/// Finished work slower than this is logged even when it went fine.
const SLOW: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Info,
    Warn,
    Error,
}

#[derive(Clone, Debug, Serialize)]
pub struct Line {
    /// Milliseconds since the Unix epoch.
    pub at: u64,
    pub level: Level,
    /// What it's about: "http", "media", "export", "agent", "ui", …
    pub area: String,
    pub message: String,
}

#[derive(Default)]
struct Stat {
    count: u64,
    failed: u64,
    total_ms: f64,
    max_ms: f64,
    recent: VecDeque<f64>,
}

/// One operation's timings, for the report.
#[derive(Serialize)]
pub struct Timing {
    pub name: String,
    pub count: u64,
    pub failed: u64,
    pub total_ms: f64,
    pub median_ms: f64,
    pub max_ms: f64,
}

struct State {
    lines: Mutex<VecDeque<Line>>,
    timings: Mutex<HashMap<String, Stat>>,
    file: Mutex<Option<(PathBuf, std::fs::File)>>,
    started: Instant,
}

fn state() -> &'static State {
    static STATE: OnceLock<State> = OnceLock::new();
    STATE.get_or_init(|| State {
        lines: Mutex::new(VecDeque::with_capacity(KEEP)),
        timings: Mutex::new(HashMap::new()),
        file: Mutex::new(None),
        started: Instant::now(),
    })
}

/// Starts writing to `~/.edit/logs/edit.log`.
pub fn open(home: &std::path::Path) {
    let dir = home.join("logs");
    let path = dir.join("edit.log");
    let opened = std::fs::create_dir_all(&dir).and_then(|()| {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
    });
    match opened {
        Ok(file) => *state().file.lock() = Some((path, file)),
        Err(error) => eprintln!("edit: can't write {}: {error}", path.display()),
    }
    info(
        "edit",
        format!(
            "started {} ({} {})",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH
        ),
    );
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

pub fn log(level: Level, area: &str, message: impl Into<String>) {
    let line = Line {
        at: now_ms(),
        level,
        area: area.to_owned(),
        message: message.into(),
    };
    // Problems still show in the terminal running Edit.
    if level != Level::Info {
        eprintln!("edit: {}: {}", line.area, line.message);
    }
    write_file(&line);
    let mut lines = state().lines.lock();
    if lines.len() >= KEEP {
        lines.pop_front();
    }
    lines.push_back(line);
}

pub fn info(area: &str, message: impl Into<String>) {
    log(Level::Info, area, message);
}

pub fn warn(area: &str, message: impl Into<String>) {
    log(Level::Warn, area, message);
}

pub fn error(area: &str, message: impl Into<String>) {
    log(Level::Error, area, message);
}

fn write_file(line: &Line) {
    let mut file = state().file.lock();
    let Some((path, handle)) = file.as_mut() else {
        return;
    };
    let level = match line.level {
        Level::Info => "INFO",
        Level::Warn => "WARN",
        Level::Error => "ERROR",
    };
    let _ = writeln!(
        handle,
        "{} {level} [{}] {}",
        line.at, line.area, line.message
    );
    if handle
        .metadata()
        .is_ok_and(|meta| meta.len() > ROTATE_BYTES)
    {
        let _ = std::fs::rename(&*path, path.with_extension("log.1"));
        if let Ok(fresh) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&*path)
        {
            *handle = fresh;
        }
    }
}

/// Records that `name` took `took`, and logs it if it failed or was slow.
pub fn record(area: &str, name: &str, took: Duration, failure: Option<&str>) {
    let ms = took.as_secs_f64() * 1000.0;
    {
        let mut timings = state().timings.lock();
        let stat = timings.entry(name.to_owned()).or_default();
        stat.count += 1;
        stat.total_ms += ms;
        stat.max_ms = stat.max_ms.max(ms);
        if failure.is_some() {
            stat.failed += 1;
        }
        if stat.recent.len() >= RECENT {
            stat.recent.pop_front();
        }
        stat.recent.push_back(ms);
    }
    match failure {
        Some(why) => error(area, format!("{name} failed after {}: {why}", human(took))),
        None if took >= SLOW => info(area, format!("{name} took {}", human(took))),
        None => {}
    }
}

/// Times `work`, recording it under `name` (failed if it returns an error);
/// the log line names what it worked on (a file, a project).
pub fn time_on<T, E: Display>(
    area: &str,
    name: &str,
    subject: &str,
    work: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    let started = Instant::now();
    let result = work();
    let failure = result
        .as_ref()
        .err()
        .map(|error| format!("{subject}: {error}"));
    record(area, name, started.elapsed(), failure.as_deref());
    result
}

/// Times a future, recording it under `name`.
pub async fn time_async<T, E: Display>(
    area: &str,
    name: &str,
    work: impl Future<Output = Result<T, E>>,
) -> Result<T, E> {
    let started = Instant::now();
    let result = work.await;
    let failure = result.as_ref().err().map(ToString::to_string);
    record(area, name, started.elapsed(), failure.as_deref());
    result
}

/// "850 ms", "12.4 s", "3 min 05 s".
pub use edit_engine::log::human;

/// Where the engine's lines and timings go: here, as if the server's own.
pub struct Engine;

impl edit_engine::log::Sink for Engine {
    fn log(&self, level: edit_engine::log::Level, area: &str, message: String) {
        let level = match level {
            edit_engine::log::Level::Info => Level::Info,
            edit_engine::log::Level::Warn => Level::Warn,
            edit_engine::log::Level::Error => Level::Error,
        };
        log(level, area, message);
    }

    fn record(&self, area: &str, name: &str, took: Duration, failure: Option<&str>) {
        record(area, name, took, failure);
    }
}

/// The most recent lines (oldest first).
pub fn lines(limit: usize) -> Vec<Line> {
    let lines = state().lines.lock();
    lines
        .iter()
        .skip(lines.len().saturating_sub(limit))
        .cloned()
        .collect()
}

/// Every operation timed so far, the most time spent first.
pub fn timings() -> Vec<Timing> {
    let timings = state().timings.lock();
    let mut out: Vec<Timing> = timings
        .iter()
        .map(|(name, stat)| {
            let mut recent: Vec<f64> = stat.recent.iter().copied().collect();
            recent.sort_by(f64::total_cmp);
            Timing {
                name: name.clone(),
                count: stat.count,
                failed: stat.failed,
                total_ms: stat.total_ms.round(),
                median_ms: recent.get(recent.len() / 2).copied().unwrap_or(0.0).round(),
                max_ms: stat.max_ms.round(),
            }
        })
        .collect();
    out.sort_by(|a, b| b.total_ms.total_cmp(&a.total_ms));
    out
}

pub fn uptime() -> Duration {
    state().started.elapsed()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_failures_and_timings() {
        let ok: Result<u8, String> = time_on("test", "diag ok", "x", || Ok(1));
        assert_eq!(ok, Ok(1));
        let failed: Result<u8, String> = time_on("test", "diag fails", "x", || Err("boom".into()));
        assert!(failed.is_err());
        let timings = timings();
        let fails = timings
            .iter()
            .find(|timing| timing.name == "diag fails")
            .unwrap();
        assert_eq!((fails.count, fails.failed), (1, 1));
        assert!(lines(KEEP)
            .iter()
            .any(|line| line.level == Level::Error && line.message.contains("diag fails failed")));
        assert_eq!(human(Duration::from_millis(850)), "850 ms");
        assert_eq!(human(Duration::from_secs(185)), "3 min 05 s");
    }
}
