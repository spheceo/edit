//! The engine's diagnostics: what it did, what went wrong and how long it
//! took, handed to the host's sink (the native addon's log callback, which
//! the server's `diag` writes). The engine never writes the log file itself.
//! Without a sink (tests, tools) problems go to stderr.

use std::fmt::Display;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    pub fn name(self) -> &'static str {
        match self {
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }
}

/// Where the engine's lines and timings go.
pub trait Sink: Send + Sync {
    fn log(&self, level: Level, area: &str, message: String);
    /// `name` took `took` (failed, with why, when `failure` is set).
    fn record(&self, area: &str, name: &str, took: Duration, failure: Option<&str>);
}

static SINK: OnceLock<Box<dyn Sink>> = OnceLock::new();

/// Sends everything from now on to `sink`. Only the first call counts.
pub fn use_sink(sink: Box<dyn Sink>) -> bool {
    SINK.set(sink).is_ok()
}

pub fn log(level: Level, area: &str, message: impl Into<String>) {
    let message = message.into();
    match SINK.get() {
        Some(sink) => sink.log(level, area, message),
        None if level != Level::Info => eprintln!("edit: {area}: {message}"),
        None => {}
    }
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

/// Records that `name` took `took` (the host logs it if it failed or was slow).
pub fn record(area: &str, name: &str, took: Duration, failure: Option<&str>) {
    match SINK.get() {
        Some(sink) => sink.record(area, name, took, failure),
        None => {
            if let Some(why) = failure {
                eprintln!("edit: {area}: {name} failed after {}: {why}", human(took));
            }
        }
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

/// "850 ms", "12.4 s", "3 min 05 s".
pub fn human(took: Duration) -> String {
    let seconds = took.as_secs_f64();
    if seconds < 1.0 {
        format!("{:.0} ms", seconds * 1000.0)
    } else if seconds < 60.0 {
        format!("{seconds:.1} s")
    } else {
        let whole = seconds.round() as u64;
        format!("{} min {:02} s", whole / 60, whole % 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_read_as_people_say_them() {
        assert_eq!(human(Duration::from_millis(850)), "850 ms");
        assert_eq!(human(Duration::from_millis(12_400)), "12.4 s");
        assert_eq!(human(Duration::from_secs(185)), "3 min 05 s");
    }
}
