//! Edit's relay (relay/): the Cloudflare Worker that holds every API key, so
//! Edit installs never do. Requests go through curl (on every Mac and Linux
//! box; no TLS stack in Edit). `EDIT_RELAY_URL` points at another relay (e.g.
//! `wrangler dev`), and `EDIT_RELAY_TOKEN` is sent as `Authorization: Bearer`.
//! The token and any JSON body go to curl through its config on stdin, never
//! in process arguments.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::Value;

const DEFAULT_RELAY: &str = "https://edit-relay.sphe-g-personal.workers.dev";

/// The relay's base URL.
pub(crate) fn url() -> String {
    std::env::var("EDIT_RELAY_URL").unwrap_or_else(|_| DEFAULT_RELAY.to_owned())
}

/// The start of every error that means the relay couldn't be reached at all
/// (offline), as opposed to one it answered.
pub(crate) const UNREACHABLE: &str = "could not reach Edit's relay";

/// The token saved in Settings → Cloud (`crate::cloud_projects`).
static SAVED_TOKEN: parking_lot::RwLock<Option<String>> = parking_lot::RwLock::new(None);

/// `EDIT_RELAY_TOKEN`, when set and not empty, else the token saved in
/// Settings → Cloud.
pub(crate) fn token() -> Option<String> {
    env_token().or_else(|| SAVED_TOKEN.read().clone())
}

/// `EDIT_RELAY_TOKEN`, when set and not empty (it wins over the setting).
pub(crate) fn env_token() -> Option<String> {
    std::env::var("EDIT_RELAY_TOKEN")
        .ok()
        .filter(|token| !token.is_empty())
}

/// The token to use when `EDIT_RELAY_TOKEN` isn't set (Settings → Cloud).
pub(crate) fn set_saved_token(token: Option<String>) {
    *SAVED_TOKEN.write() = token.filter(|token| !token.is_empty());
}

/// curl config lines that authenticate with `token` (none without one).
/// Rejects a token that could add config or headers.
pub(crate) fn auth_config(token: Option<&str>) -> Result<String, String> {
    match token.filter(|token| !token.is_empty()) {
        Some(token) if token.chars().any(char::is_control) => {
            Err("EDIT_RELAY_TOKEN contains a control character".to_owned())
        }
        Some(token) => Ok(format!(
            "header = \"Authorization: Bearer {}\"\n",
            quote(token)
        )),
        None => Ok(String::new()),
    }
}

/// The relay's auth (from the environment) plus `body` as JSON, as curl config.
fn request_config(body: Option<&Value>) -> Result<String, String> {
    let mut config = auth_config(token().as_deref())?;
    if let Some(body) = body {
        // serde_json escapes control characters, so the body is one line; it
        // never starts with '@' (which would make curl read a file).
        config.push_str("header = \"content-type: application/json\"\n");
        config.push_str(&format!("data-binary = \"{}\"\n", quote(&body.to_string())));
    }
    Ok(config)
}

/// Escapes a value for a double-quoted curl config string.
fn quote(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Runs curl with `config` on stdin (it starts with `-K -`); stdout, stderr.
fn curl(args: &[&str], config: &str) -> Result<std::process::Output, String> {
    let mut child = Command::new("curl")
        .args(["-sS", "-K", "-"])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("curl: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(error) = stdin.write_all(config.as_bytes()) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("curl: {error}"));
        }
    }
    child
        .wait_with_output()
        .map_err(|error| format!("curl: {error}"))
}

/// The relay's reason for a failed request: its `{error}`, else the start of
/// the body. A 404 `not found` from the relay itself means it predates
/// `feature` (it needs deploying).
fn failure(code: &str, answer: &[u8], feature: &str) -> String {
    let message = serde_json::from_slice::<Value>(answer)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| String::from_utf8_lossy(answer).chars().take(300).collect());
    if code == "404" && message == "not found" {
        format!("Edit's relay doesn't do {feature} yet (it needs deploying).")
    } else {
        format!("{message} ({code})")
    }
}

/// One relay request: the answer goes to `out`; a failure comes back with the
/// relay's (or the service behind it's) reason. On success, the request id
/// the relay passed on (`x-request-id`), if any.
pub(crate) fn call(
    method: &str,
    route: &str,
    body: Option<&Value>,
    out: &Path,
    feature: &str,
) -> Result<Option<String>, String> {
    let config = request_config(body)?;
    let out_arg = out.to_string_lossy();
    let target = format!("{}{route}", url());
    let output = curl(
        &[
            "-X",
            method,
            "--max-time",
            "300",
            "-w",
            "%{http_code} %header{x-request-id}",
            "-o",
            &out_arg,
            &target,
        ],
        &config,
    )?;
    if !output.status.success() {
        return Err(format!(
            "{UNREACHABLE}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let written = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let (code, request) = written.split_once(' ').unwrap_or((&written, ""));
    let request = request.trim();
    if code == "200" {
        return Ok((!request.is_empty()).then(|| request.to_owned()));
    }
    let answer = std::fs::read(out).unwrap_or_default();
    let _ = std::fs::remove_file(out);
    Err(failure(code, &answer, feature))
}

/// A relay request whose answer is JSON (held in memory, no scratch file).
/// `timeout` is in seconds.
pub(crate) fn json(
    method: &str,
    route: &str,
    body: Option<&Value>,
    feature: &str,
    timeout: u64,
) -> Result<Value, String> {
    let config = request_config(body)?;
    let target = format!("{}{route}", url());
    let timeout = timeout.to_string();
    let output = curl(
        &[
            "-X",
            method,
            "--max-time",
            &timeout,
            "-w",
            "\n%{http_code}",
            &target,
        ],
        &config,
    )?;
    if !output.status.success() {
        return Err(format!(
            "{UNREACHABLE}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let text = output.stdout;
    let split = text
        .iter()
        .rposition(|&byte| byte == b'\n')
        .unwrap_or(text.len());
    let (answer, code) = text.split_at(split);
    let code = String::from_utf8_lossy(code).trim().to_owned();
    if code != "200" {
        return Err(failure(&code, answer, feature));
    }
    serde_json::from_slice(answer).map_err(|error| format!("the relay's answer: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_relay_token_is_escaped_and_cannot_add_headers() {
        assert_eq!(auth_config(None).unwrap(), "");
        assert_eq!(
            auth_config(Some("test-token")).unwrap(),
            "header = \"Authorization: Bearer test-token\"\n"
        );
        assert_eq!(
            auth_config(Some("a\"b\\c")).unwrap(),
            "header = \"Authorization: Bearer a\\\"b\\\\c\"\n"
        );
        assert!(auth_config(Some("token\nheader = evil")).is_err());
    }

    #[test]
    fn failures_say_what_the_relay_said() {
        assert_eq!(
            failure("404", br#"{"error":"not found"}"#, "cloud storage"),
            "Edit's relay doesn't do cloud storage yet (it needs deploying)."
        );
        assert_eq!(
            failure(
                "401",
                br#"{"error":"This relay needs Edit's cloud token."}"#,
                "x"
            ),
            "This relay needs Edit's cloud token. (401)"
        );
        assert_eq!(failure("502", b"Bad gateway", "x"), "Bad gateway (502)");
    }
}
