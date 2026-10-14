//! Transcription through Edit's relay (relay/), which holds the ElevenLabs
//! key. Edit sends small mono Opus audio and keeps Scribe's words, cached per
//! source file so the same footage is never paid for twice.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const DEFAULT_RELAY: &str = "https://edit-relay.sphe-g-personal.workers.dev";

pub(crate) fn relay() -> String {
    std::env::var("EDIT_RELAY_URL").unwrap_or_else(|_| DEFAULT_RELAY.to_owned())
}

/// One spoken word. Times are seconds into the source.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Word {
    pub text: String,
    pub start: f64,
    pub end: f64,
    /// Scribe's voice number, if it heard more than one person.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Transcript {
    pub model: String,
    #[serde(default)]
    pub language: Option<String>,
    pub words: Vec<Word>,
    /// Who each voice is ("speaker_0" → "Officer", "Jane Doe (Mother)"),
    /// read from the conversation by a model once the words are in.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub speakers: std::collections::BTreeMap<String, String>,
    /// Each voice's role in Repack's colour code (officer, suspect, witness…).
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub roles: std::collections::BTreeMap<String, String>,
    /// Each voice's colour ("#00e5c7"), from its role (see speakers.rs).
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub colors: std::collections::BTreeMap<String, String>,
}

/// Extracts audio, sends it to the relay, writes `target` (transcript JSON).
pub fn run(source: &Path, target: &Path) -> Result<(), String> {
    let config = relay_config(std::env::var("EDIT_RELAY_TOKEN").ok().as_deref())?;
    let audio = target.with_extension("ogg");
    let encoded = Command::new(crate::tools::ffmpeg())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
        ])
        .arg(source)
        .args([
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "libopus",
            "-b:a",
            "32k",
            "-application",
            "voip",
        ])
        .arg(&audio)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    if !encoded.status.success() {
        let _ = std::fs::remove_file(&audio);
        return Err(format!(
            "could not extract audio: {}",
            String::from_utf8_lossy(&encoded.stderr).trim()
        ));
    }
    // curl streams the file (-T) and is on every Mac and Linux box; no TLS stack in Edit.
    let response = (|| -> std::io::Result<std::process::Output> {
        let mut child = Command::new("curl")
            .args([
                "-sS",
                "--config",
                "-",
                "-X",
                "POST",
                "-H",
                "content-type: audio/ogg",
                "--max-time",
                "1800",
                "-w",
                "\n%{http_code}",
                "-T",
            ])
            .arg(&audio)
            .arg(format!("{}/v1/transcribe", relay()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let result = child
            .stdin
            .take()
            .ok_or_else(|| std::io::Error::other("curl stdin"))?
            .write_all(config.as_bytes());
        if let Err(error) = result {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        child.wait_with_output()
    })()
    .map_err(|error| format!("curl: {error}"));
    let _ = std::fs::remove_file(&audio);
    let response = response?;
    if !response.status.success() {
        return Err(format!(
            "could not reach the transcription relay: {}",
            String::from_utf8_lossy(&response.stderr).trim()
        ));
    }
    let text = String::from_utf8_lossy(&response.stdout);
    let (body, code) = text.rsplit_once('\n').unwrap_or((&text, "0"));
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if code.trim() != "200" {
        let message = value
            .get("error")
            .and_then(Value::as_str)
            .or_else(|| value.pointer("/detail/message").and_then(Value::as_str))
            .unwrap_or(body.trim());
        return Err(format!("transcription failed ({}): {message}", code.trim()));
    }
    let transcript = parse_scribe(&value)?;
    crate::store::write_atomic(
        target,
        &serde_json::to_vec(&transcript).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

/// Optional private-relay authentication. Feed curl's config through stdin so
/// the token isn't exposed in process arguments. Reject config/header injection.
fn relay_config(token: Option<&str>) -> Result<String, String> {
    match token.filter(|token| !token.is_empty()) {
        Some(token) if token.chars().any(char::is_control) => {
            Err("EDIT_RELAY_TOKEN contains a control character".to_owned())
        }
        Some(token) => Ok(format!(
            "header = \"Authorization: Bearer {}\"\n",
            token.replace('\\', "\\\\").replace('"', "\\\"")
        )),
        None => Ok(String::new()),
    }
}

#[cfg(test)]
mod relay_auth_tests {
    use super::relay_config;
    #[test]
    fn private_relay_token_is_escaped_and_cannot_add_headers() {
        assert_eq!(relay_config(None).unwrap(), "");
        assert_eq!(
            relay_config(Some("test-token")).unwrap(),
            "header = \"Authorization: Bearer test-token\"\n"
        );
        assert_eq!(
            relay_config(Some("a\"b\\c")).unwrap(),
            "header = \"Authorization: Bearer a\\\"b\\\\c\"\n"
        );
        assert!(relay_config(Some("token\nheader = evil")).is_err());
    }
}

/// Scribe's answer, keeping only spoken words (not spacing or sound events).
pub fn parse_scribe(value: &Value) -> Result<Transcript, String> {
    let words = value["words"]
        .as_array()
        .ok_or("the transcription service returned no words")?
        .iter()
        .filter(|word| word["type"] == "word")
        .filter_map(|word| {
            let text = word["text"].as_str()?.trim();
            let start = word["start"].as_f64()?;
            let end = word["end"].as_f64()?;
            (!text.is_empty()).then(|| Word {
                text: text.to_owned(),
                start: start.max(0.0),
                end: end.max(start),
                speaker: word["speaker_id"].as_str().map(str::to_owned),
            })
        })
        .collect();
    Ok(Transcript {
        model: "scribe_v2".to_owned(),
        language: value["language_code"].as_str().map(str::to_owned),
        words,
        speakers: Default::default(),
        roles: Default::default(),
        colors: Default::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::parse_scribe;
    use serde_json::json;

    #[test]
    fn keeps_spoken_words_only() {
        let transcript = parse_scribe(&json!({
            "language_code": "eng",
            "words": [
                { "text": "Hello", "start": 0.1, "end": 0.4, "type": "word", "speaker_id": "speaker_0" },
                { "text": " ", "start": 0.4, "end": 0.5, "type": "spacing" },
                { "text": "(laughs)", "start": 0.5, "end": 0.9, "type": "audio_event" },
                { "text": "there", "start": 0.9, "end": 1.2, "type": "word", "speaker_id": "speaker_0" }
            ]
        }))
        .unwrap();
        assert_eq!(transcript.words.len(), 2);
        assert_eq!(transcript.words[1].text, "there");
        assert_eq!(transcript.language.as_deref(), Some("eng"));
    }
}
