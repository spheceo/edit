//! Where Edit's direct calls to Google (Drive, Docs, sign-in) and to the AI
//! Gateway go: the real services, or a stand-in for parity runs and tests.
//!
//! - `EDIT_GOOGLE_API_URL=http://127.0.0.1:7900` sends `https://<host>/<path>`
//!   for every Google host to `http://127.0.0.1:7900/<host>/<path>` (one mock
//!   can answer all of them and still tell them apart).
//! - `EDIT_AI_GATEWAY_URL=http://127.0.0.1:7901` posts chat completions to
//!   `http://127.0.0.1:7901/v1/chat/completions`.
//!
//! Unset (always, outside tests and parity runs), nothing changes. A stand-in
//! over plain http is allowed only while one is set.

/// The Vercel AI Gateway Edit asks models through (watch, seats).
const GATEWAY: &str = "https://ai-gateway.vercel.sh";

fn set(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// A stand-in's base URL, as given (no trailing slash), if one is set.
fn base(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().trim_end_matches('/').to_owned())
        .filter(|value| !value.is_empty())
}

/// `url` (a Google `https://` URL) as this run reaches it.
pub fn google(url: &str) -> String {
    google_through(base(set("EDIT_GOOGLE_API_URL")), url)
}

fn google_through(base: Option<String>, url: &str) -> String {
    match (base, url.strip_prefix("https://")) {
        (Some(base), Some(rest)) => format!("{base}/{rest}"),
        _ => url.to_owned(),
    }
}

/// The protocols curl may use for Google calls (`--proto`): HTTPS only,
/// unless a stand-in over http is set.
pub fn google_proto() -> &'static str {
    protocols(base(set("EDIT_GOOGLE_API_URL")))
}

/// The AI Gateway's chat completions URL.
pub fn gateway() -> String {
    gateway_through(base(set("EDIT_AI_GATEWAY_URL")))
}

fn gateway_through(base: Option<String>) -> String {
    format!(
        "{}/v1/chat/completions",
        base.unwrap_or_else(|| GATEWAY.to_owned())
    )
}

/// `--proto` for the gateway.
pub fn gateway_proto() -> &'static str {
    protocols(base(set("EDIT_AI_GATEWAY_URL")))
}

fn protocols(stand_in: Option<String>) -> &'static str {
    match stand_in {
        Some(base) if base.starts_with("http://") => "=http,https",
        _ => "=https",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stand_ins_take_every_google_host_and_the_gateway() {
        let drive = "https://www.googleapis.com/drive/v3/files?q=x";
        assert_eq!(google_through(None, drive), drive);
        assert_eq!(protocols(None), "=https");
        assert_eq!(
            gateway_through(None),
            "https://ai-gateway.vercel.sh/v1/chat/completions"
        );
        let mock = || base(Some(" http://127.0.0.1:7900/ ".to_owned()));
        assert_eq!(base(Some(String::new())), None);
        assert_eq!(
            google_through(mock(), drive),
            "http://127.0.0.1:7900/www.googleapis.com/drive/v3/files?q=x"
        );
        assert_eq!(
            google_through(mock(), "https://oauth2.googleapis.com/token"),
            "http://127.0.0.1:7900/oauth2.googleapis.com/token"
        );
        assert_eq!(protocols(mock()), "=http,https");
        assert_eq!(protocols(Some("https://mock.example".into())), "=https");
        assert_eq!(
            gateway_through(mock()),
            "http://127.0.0.1:7900/v1/chat/completions"
        );
    }
}
