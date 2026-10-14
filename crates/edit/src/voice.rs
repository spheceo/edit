//! Voice-over projects (for now apart from the video projects): a script of
//! lines, each spoken by an ElevenLabs voice through Edit's relay, kept as
//! takes to listen to and choose between. Each lives in
//! `~/.edit/voice/<id>/` (project.json, takes/<take>.mp3).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use edit_core::ScriptBlock;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::store::{now_ms, write_atomic};

/// How a voice speaks (ElevenLabs' voice settings, plus which voice and model).
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct VoiceSettings {
    #[serde(default)]
    pub voice_id: Option<String>,
    #[serde(default)]
    pub voice_name: Option<String>,
    #[serde(default = "default_model")]
    pub model_id: String,
    #[serde(default = "half")]
    pub stability: f32,
    #[serde(default = "similarity")]
    pub similarity_boost: f32,
    #[serde(default)]
    pub style: f32,
    #[serde(default = "yes")]
    pub use_speaker_boost: bool,
    #[serde(default = "one")]
    pub speed: f32,
}

fn default_model() -> String {
    "eleven_multilingual_v2".to_owned()
}
fn half() -> f32 {
    0.5
}
fn similarity() -> f32 {
    0.75
}
fn yes() -> bool {
    true
}
fn one() -> f32 {
    1.0
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            voice_id: None,
            voice_name: None,
            model_id: default_model(),
            stability: half(),
            similarity_boost: similarity(),
            style: 0.0,
            use_speaker_boost: true,
            speed: 1.0,
        }
    }
}

/// One recording of a line.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Take {
    pub id: String,
    pub created_ms: u64,
    /// The words as they were when it was made (the line may have changed since).
    pub text: String,
    pub settings: VoiceSettings,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub characters: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Line {
    pub id: String,
    #[serde(default)]
    pub text: String,
    /// Where it came from ("Cut-in 3"), when imported from a video project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default)]
    pub takes: Vec<Take>,
    /// The take to use.
    #[serde(default)]
    pub chosen: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct VoiceProject {
    pub id: String,
    pub name: String,
    pub created_ms: u64,
    pub modified_ms: u64,
    #[serde(default)]
    pub voice: VoiceSettings,
    /// The video project its lines came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default)]
    pub lines: Vec<Line>,
    #[serde(default)]
    pub next_id: u64,
}

impl VoiceProject {
    fn fresh_id(&mut self, prefix: &str) -> String {
        self.next_id += 1;
        format!("{prefix}{}", self.next_id)
    }
}

#[derive(Serialize)]
pub struct Summary {
    pub id: String,
    pub name: String,
    pub modified_ms: u64,
    pub lines: usize,
    /// Lines with a chosen take.
    pub done: usize,
    pub voice_name: Option<String>,
}

/// What the UI may change: names, the voice, and the lines' words, order and
/// chosen takes. Takes themselves only come from generating.
#[derive(Deserialize)]
pub struct Changes {
    pub name: String,
    pub voice: VoiceSettings,
    pub lines: Vec<LineChange>,
}

#[derive(Deserialize)]
pub struct LineChange {
    /// None for a new line.
    #[serde(default)]
    pub id: Option<String>,
    pub text: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub chosen: Option<String>,
}

pub struct Voices {
    home: PathBuf,
    /// Read-modify-write of any voice project.
    lock: Mutex<()>,
    listing: Mutex<Option<(Instant, Value)>>,
}

const MAX_LINE_CHARS: usize = 5000;

impl Voices {
    pub fn new(home: &Path) -> Self {
        Self {
            home: home.join("voice"),
            lock: Mutex::new(()),
            listing: Mutex::new(None),
        }
    }

    fn dir(&self, id: &str) -> Result<PathBuf, String> {
        if !crate::store::valid_id(id) {
            return Err("no such voice-over".to_owned());
        }
        Ok(self.home.join(id))
    }

    pub fn take_path(&self, id: &str, take: &str) -> Result<PathBuf, String> {
        if !crate::store::valid_id(take) {
            return Err("no such take".to_owned());
        }
        Ok(self.dir(id)?.join("takes").join(format!("{take}.mp3")))
    }

    pub fn get(&self, id: &str) -> Result<VoiceProject, String> {
        let path = self.dir(id)?.join("project.json");
        let bytes = std::fs::read(&path).map_err(|_| "no such voice-over".to_owned())?;
        serde_json::from_slice(&bytes)
            .map_err(|error| format!("{} can't be read: {error}", path.display()))
    }

    fn save(&self, project: &mut VoiceProject) -> Result<(), String> {
        project.modified_ms = now_ms();
        let path = self.dir(&project.id)?.join("project.json");
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir.join("takes")).map_err(|error| error.to_string())?;
        }
        let bytes = serde_json::to_vec_pretty(project).map_err(|error| error.to_string())?;
        write_atomic(&path, &bytes).map_err(|error| error.to_string())
    }

    pub fn list(&self) -> Vec<Summary> {
        let mut out: Vec<Summary> = std::fs::read_dir(&self.home)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| {
                let id = entry.file_name().to_str()?.to_owned();
                let project = self.get(&id).ok()?;
                Some(Summary {
                    done: project
                        .lines
                        .iter()
                        .filter(|line| line.chosen.is_some())
                        .count(),
                    lines: project.lines.len(),
                    voice_name: project.voice.voice_name.clone(),
                    id: project.id,
                    name: project.name,
                    modified_ms: project.modified_ms,
                })
            })
            .collect();
        out.sort_by_key(|summary| std::cmp::Reverse(summary.modified_ms));
        out
    }

    /// A new voice-over; with `lines`, one line each (e.g. a video project's cut-ins).
    pub fn create(
        &self,
        name: &str,
        source: Option<String>,
        lines: Vec<(String, Option<String>)>,
    ) -> Result<VoiceProject, String> {
        let _guard = self.lock.lock();
        let now = now_ms();
        let mut project = VoiceProject {
            id: format!("v{now}"),
            name: if name.trim().is_empty() {
                "Untitled voice-over".to_owned()
            } else {
                name.trim().to_owned()
            },
            created_ms: now,
            modified_ms: now,
            voice: VoiceSettings::default(),
            source,
            lines: Vec::new(),
            next_id: 0,
        };
        let lines = if lines.is_empty() {
            vec![(String::new(), None)]
        } else {
            lines
        };
        for (text, label) in lines {
            let id = project.fresh_id("l");
            project.lines.push(Line {
                id,
                text,
                label,
                takes: Vec::new(),
                chosen: None,
            });
        }
        while self.dir(&project.id)?.exists() {
            project.id = format!("v{}-{}", now, project.next_id);
            project.next_id += 1;
        }
        self.save(&mut project)?;
        crate::diag::info(
            "voice",
            format!(
                "created voice-over {} ({} lines)",
                project.name,
                project.lines.len()
            ),
        );
        Ok(project)
    }

    pub fn update(&self, id: &str, changes: Changes) -> Result<VoiceProject, String> {
        let _guard = self.lock.lock();
        let mut project = self.get(id)?;
        project.name = if changes.name.trim().is_empty() {
            project.name
        } else {
            changes.name.trim().to_owned()
        };
        project.voice = clamp(changes.voice);
        let mut old: Vec<Line> = std::mem::take(&mut project.lines);
        for change in changes.lines {
            let existing = change
                .id
                .as_deref()
                .and_then(|id| old.iter().position(|line| line.id == id))
                .map(|index| old.remove(index));
            let mut line = match existing {
                Some(line) => line,
                None => {
                    let id = project.fresh_id("l");
                    Line {
                        id,
                        text: String::new(),
                        label: None,
                        takes: Vec::new(),
                        chosen: None,
                    }
                }
            };
            line.text = change.text.chars().take(MAX_LINE_CHARS).collect();
            line.label = change.label;
            line.chosen = change
                .chosen
                .filter(|chosen| line.takes.iter().any(|take| &take.id == chosen));
            project.lines.push(line);
        }
        // Lines left out were deleted: their takes go too.
        for line in old {
            for take in line.takes {
                let _ = std::fs::remove_file(self.take_path(id, &take.id)?);
            }
        }
        self.save(&mut project)?;
        Ok(project)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let _guard = self.lock.lock();
        let dir = self.dir(id)?;
        let bin = self.home.join("deleted");
        std::fs::create_dir_all(&bin).map_err(|error| error.to_string())?;
        // Kept aside, like video projects, so a deletion can be undone by hand.
        std::fs::rename(&dir, bin.join(format!("{id}-{}", now_ms())))
            .map_err(|error| error.to_string())
    }

    pub fn delete_take(&self, id: &str, line_id: &str, take: &str) -> Result<VoiceProject, String> {
        let _guard = self.lock.lock();
        let mut project = self.get(id)?;
        let line = project
            .lines
            .iter_mut()
            .find(|line| line.id == line_id)
            .ok_or("no such line")?;
        line.takes.retain(|candidate| candidate.id != take);
        if line.chosen.as_deref() == Some(take) {
            line.chosen = line.takes.last().map(|take| take.id.clone());
        }
        let _ = std::fs::remove_file(self.take_path(id, take)?);
        self.save(&mut project)?;
        Ok(project)
    }

    /// Speaks a line with the project's voice: a new take, chosen.
    pub fn generate(&self, id: &str, line_id: &str) -> Result<VoiceProject, String> {
        let (project, index) = {
            let project = self.get(id)?;
            let index = project
                .lines
                .iter()
                .position(|line| line.id == line_id)
                .ok_or("no such line")?;
            (project, index)
        };
        let settings = project.voice.clone();
        let voice = settings.voice_id.clone().ok_or("Choose a voice first.")?;
        let line = project.lines.get(index).ok_or("no such line")?;
        let text = line.text.trim().to_owned();
        if text.is_empty() {
            return Err("This line has no words yet.".to_owned());
        }
        // The lines around it, so the delivery flows from one into the next.
        let neighbour = |offset: isize| {
            index
                .checked_add_signed(offset)
                .and_then(|at| project.lines.get(at))
                .map(|line| line.text.trim().to_owned())
                .filter(|text| !text.is_empty())
        };
        let body = json!({
            "voice_id": voice,
            "model_id": settings.model_id,
            "text": text,
            "voice_settings": {
                "stability": settings.stability,
                "similarity_boost": settings.similarity_boost,
                "style": settings.style,
                "use_speaker_boost": settings.use_speaker_boost,
                "speed": settings.speed,
            },
            "previous_text": neighbour(-1),
            "next_text": neighbour(1),
            "output_format": "mp3_44100_128",
        });
        let take_id = format!("t{}", now_ms());
        let path = self.take_path(id, &take_id)?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        }
        let subject = format!("{} line {}", project.name, index + 1);
        crate::diag::time_on("voice", "voice: generate a line", &subject, || {
            speak(&body, &path)
        })?;
        let duration = crate::media::probe(&path).ok().map(|probe| probe.duration);

        let _guard = self.lock.lock();
        // Read again: the words or other lines may have changed while it spoke.
        let mut project = self.get(id)?;
        let Some(line) = project.lines.iter_mut().find(|line| line.id == line_id) else {
            let _ = std::fs::remove_file(&path);
            return Err("The line was deleted while it was being spoken.".to_owned());
        };
        line.takes.push(Take {
            id: take_id.clone(),
            created_ms: now_ms(),
            characters: text.chars().count(),
            text,
            settings,
            duration,
        });
        line.chosen = Some(take_id);
        self.save(&mut project)?;
        Ok(project)
    }

    /// The account's voices (from the relay), kept for ten minutes.
    pub fn voices(&self, refresh: bool) -> Result<Value, String> {
        if !refresh {
            if let Some((at, listing)) = &*self.listing.lock() {
                if at.elapsed() < Duration::from_secs(600) {
                    return Ok(listing.clone());
                }
            }
        }
        let listing = crate::diag::time_on("voice", "voice: list voices", "relay", || {
            relay_json("GET", "/v1/voices", None)
        })?;
        *self.listing.lock() = Some((Instant::now(), listing.clone()));
        Ok(listing)
    }

    /// Every chosen take, in order, as one file (lines without one are skipped).
    pub fn full(&self, id: &str) -> Result<PathBuf, String> {
        let project = self.get(id)?;
        let takes: Vec<PathBuf> = project
            .lines
            .iter()
            .filter_map(|line| line.chosen.as_deref())
            .filter_map(|take| self.take_path(id, take).ok())
            .filter(|path| path.is_file())
            .collect();
        if takes.is_empty() {
            return Err("No lines have been spoken yet.".to_owned());
        }
        let out = self.dir(id)?.join("full.mp3");
        let list = self.dir(id)?.join("full.txt");
        let entries: String = takes
            .iter()
            .map(|path| format!("file '{}'\n", path.to_string_lossy().replace('\'', "'\\''")))
            .collect();
        std::fs::write(&list, entries).map_err(|error| error.to_string())?;
        let output = Command::new(crate::tools::ffmpeg())
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
            ])
            .arg(&list)
            .args(["-c:a", "libmp3lame", "-b:a", "192k"])
            .arg(&out)
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("ffmpeg: {error}"))?;
        let _ = std::fs::remove_file(&list);
        if !output.status.success() {
            return Err(format!(
                "joining the takes failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(out)
    }
}

/// Keeps settings within what ElevenLabs accepts.
fn clamp(mut voice: VoiceSettings) -> VoiceSettings {
    voice.stability = voice.stability.clamp(0.0, 1.0);
    voice.similarity_boost = voice.similarity_boost.clamp(0.0, 1.0);
    voice.style = voice.style.clamp(0.0, 1.0);
    voice.speed = voice.speed.clamp(0.7, 1.2);
    voice
}

/// The lines of a video project's script narration (its cut-ins), in order.
pub fn narration_lines(project: &edit_core::Project) -> Vec<(String, Option<String>)> {
    project
        .script
        .iter()
        .flat_map(|script| &script.blocks)
        .filter_map(|block| match block {
            ScriptBlock::Narration { text, .. } => Some(text.trim().to_owned()),
            _ => None,
        })
        .filter(|text| !text.is_empty())
        .enumerate()
        .map(|(index, text)| (text, Some(format!("Cut-in {}", index + 1))))
        .collect()
}

/// Sends `body` to the relay's /v1/speech and writes the audio to `path`.
fn speak(body: &Value, path: &Path) -> Result<(), String> {
    let partial = path.with_extension("partial");
    let result = relay_call("POST", "/v1/speech", Some(body), &partial);
    match result {
        Ok(()) => std::fs::rename(&partial, path).map_err(|error| error.to_string()),
        Err(error) => {
            let _ = std::fs::remove_file(&partial);
            Err(error)
        }
    }
}

fn relay_json(method: &str, route: &str, body: Option<&Value>) -> Result<Value, String> {
    let scratch = std::env::temp_dir().join(format!(
        "edit-relay-{}-{}.json",
        std::process::id(),
        now_ms()
    ));
    let result = relay_call(method, route, body, &scratch).and_then(|()| {
        let bytes = std::fs::read(&scratch).map_err(|error| error.to_string())?;
        serde_json::from_slice(&bytes).map_err(|error| format!("the relay's answer: {error}"))
    });
    let _ = std::fs::remove_file(&scratch);
    result
}

/// One relay request through curl (like transcription): the answer goes to
/// `out`; a failure comes back with the relay's (or ElevenLabs') reason.
fn relay_call(method: &str, route: &str, body: Option<&Value>, out: &Path) -> Result<(), String> {
    let mut config =
        crate::transcribe::relay_config(std::env::var("EDIT_RELAY_TOKEN").ok().as_deref())?;
    let mut command = Command::new("curl");
    command
        .args([
            "-sS",
            "-K",
            "-",
            "-X",
            method,
            "--max-time",
            "300",
            "-w",
            "%{http_code}",
            "-o",
        ])
        .arg(out);
    if let Some(body) = body {
        command.args(["-H", "content-type: application/json", "--data-binary"]);
        command.arg(body.to_string());
    }
    command
        .arg(format!("{}{route}", crate::transcribe::relay()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| format!("curl: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        config.push('\n');
        let _ = stdin.write_all(config.as_bytes());
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("curl: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "could not reach Edit's relay: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let code = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if code == "200" {
        return Ok(());
    }
    let answer = std::fs::read(out).unwrap_or_default();
    let message = serde_json::from_slice::<Value>(&answer)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| String::from_utf8_lossy(&answer).chars().take(300).collect());
    let _ = std::fs::remove_file(out);
    Err(if code == "404" {
        "Edit's relay doesn't do voices yet (it needs deploying).".to_owned()
    } else {
        format!("{message} ({code})")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_keep_their_takes_and_drop_the_deleted() {
        let home = std::env::temp_dir().join(format!(
            "edit-voice-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let voices = Voices::new(&home);
        let project = voices
            .create(
                "Test",
                None,
                vec![("One.".into(), None), ("Two.".into(), None)],
            )
            .unwrap();
        let (first, second) = (project.lines[0].id.clone(), project.lines[1].id.clone());
        // Pretend the second line was spoken.
        let mut stored = voices.get(&project.id).unwrap();
        stored.lines[1].takes.push(Take {
            id: "t1".into(),
            created_ms: 0,
            text: "Two.".into(),
            settings: VoiceSettings::default(),
            duration: Some(1.0),
            characters: 4,
        });
        voices.save(&mut stored).unwrap();
        std::fs::write(voices.take_path(&project.id, "t1").unwrap(), b"mp3").unwrap();

        // Reordered, the second keeps its take; a made-up chosen take is refused.
        let updated = voices
            .update(
                &project.id,
                Changes {
                    name: "Renamed".into(),
                    voice: VoiceSettings {
                        speed: 5.0,
                        ..VoiceSettings::default()
                    },
                    lines: vec![
                        LineChange {
                            id: Some(second.clone()),
                            text: "Two!".into(),
                            label: None,
                            chosen: Some("t1".into()),
                        },
                        LineChange {
                            id: Some(first.clone()),
                            text: "One.".into(),
                            label: None,
                            chosen: Some("t9".into()),
                        },
                        LineChange {
                            id: None,
                            text: "Three.".into(),
                            label: None,
                            chosen: None,
                        },
                    ],
                },
            )
            .unwrap();
        assert_eq!(updated.name, "Renamed");
        assert_eq!(updated.voice.speed, 1.2);
        assert_eq!(updated.lines[0].id, second);
        assert_eq!(updated.lines[0].chosen.as_deref(), Some("t1"));
        assert_eq!(updated.lines[1].chosen, None);
        assert_eq!(updated.lines.len(), 3);

        // Deleting the line deletes its take's file.
        voices
            .update(
                &project.id,
                Changes {
                    name: "Renamed".into(),
                    voice: VoiceSettings::default(),
                    lines: vec![LineChange {
                        id: Some(first),
                        text: "One.".into(),
                        label: None,
                        chosen: None,
                    }],
                },
            )
            .unwrap();
        assert!(!voices.take_path(&project.id, "t1").unwrap().exists());
        assert_eq!(voices.list().len(), 1);
        let _ = std::fs::remove_dir_all(home);
    }
}
