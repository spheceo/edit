//! The team's sound library: a Google Drive folder ("Music & SFX Library",
//! a folder per category under "Music" and "Sound effects") is the source of
//! truth. Edit lists it through the Drive API and downloads a sound the first
//! time it's used, into `<home>/library/<music|sfx>/<checksum>/`. Nothing is
//! bundled with Edit.
//!
//! The folder is private, so Edit needs a Google sign-in that can read it:
//! GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET and
//! GOOGLE_DOCS_REFRESH_TOKEN. For testing these are Repack's (same names),
//! which `just dev` reads from Infisical.
//!
//! Beside the sounds sit an index (a .txt with a note per file, "first ~20
//! seconds, low volume") and a usage guide (a Doc on what each category is
//! for); both are read with the listing.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::server::App;

/// "Music & SFX Library" in the team's Drive.
const DEFAULT_FOLDER: &str = "1GngDWLQUNOYEnI068QsEkoAfHPAuZAyM";
const API: &str = "https://www.googleapis.com/drive/v3";
const FOLDER: &str = "application/vnd.google-apps.folder";
const DOC: &str = "application/vnd.google-apps.document";
/// Drive is read again after this, so a sound added there shows up without a restart.
const FRESH: Duration = Duration::from_secs(120);
const AUDIO: &[&str] = &["wav", "mp3", "m4a", "aif", "aiff", "flac", "ogg", "aac"];
/// Longer sound effects are beds (drones, heartbeats): no hit to line up.
const HIT_SECONDS: f64 = 15.0;

#[derive(Clone, Debug, Serialize)]
pub struct Sound {
    /// The Drive file id.
    pub id: String,
    /// The file name without its extension (or an "- Epidemic Sound" ending).
    pub name: String,
    /// "music" or "sfx".
    pub kind: &'static str,
    /// The folder it's in ("Hits", "Investigative"); nested folders are joined with " / ".
    pub category: String,
    /// What the index says about it ("first ~20 seconds, low volume").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub bytes: u64,
    #[serde(skip)]
    file: String,
    #[serde(skip)]
    md5: String,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Listing {
    pub sounds: Vec<Sound>,
    /// The usage guide, as plain text.
    pub guide: String,
}

impl Listing {
    pub fn find(&self, id: &str) -> Option<&Sound> {
        self.sounds.iter().find(|sound| sound.id == id)
    }
}

#[derive(Default)]
pub struct Library {
    token: Mutex<Option<(String, Instant)>>,
    listing: Mutex<Option<(Instant, Arc<Listing>)>>,
    refreshing: AtomicBool,
    /// One download per file at a time.
    downloads: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Library {
    /// What's in the library. Once read, it answers at once; when the listing
    /// is a couple of minutes old, Drive is read again behind the answer.
    pub fn list(self: &Arc<Self>, refresh: bool) -> Result<Arc<Listing>, String> {
        if !refresh {
            if let Some((at, listing)) = &*self.listing.lock().unwrap() {
                if at.elapsed() >= FRESH && !self.refreshing.swap(true, Ordering::SeqCst) {
                    let library = Arc::clone(self);
                    std::thread::spawn(move || {
                        let _ = library.reread();
                        library.refreshing.store(false, Ordering::SeqCst);
                    });
                }
                return Ok(Arc::clone(listing));
            }
        }
        self.reread()
    }

    fn reread(&self) -> Result<Arc<Listing>, String> {
        let listing = Arc::new(self.read()?);
        *self.listing.lock().unwrap() = Some((Instant::now(), Arc::clone(&listing)));
        Ok(listing)
    }

    fn read(&self) -> Result<Listing, String> {
        let root = std::env::var("EDIT_LIBRARY_FOLDER").unwrap_or_else(|_| DEFAULT_FOLDER.into());
        let mut sounds = Vec::new();
        let (mut index, mut guide) = (String::new(), String::new());
        let mut level = vec![(root, Vec::<String>::new())];
        while !level.is_empty() {
            // Each folder is a request: read a level of them at once.
            let read: Vec<_> = std::thread::scope(|scope| {
                let reads: Vec<_> = level
                    .iter()
                    .map(|(folder, _)| scope.spawn(|| self.children(folder)))
                    .collect();
                reads
                    .into_iter()
                    .map(|read| {
                        read.join()
                            .unwrap_or_else(|_| Err("reading Drive failed".into()))
                    })
                    .collect()
            });
            let mut next = Vec::new();
            for ((_, path), children) in level.into_iter().zip(read) {
                for entry in children? {
                    let id = entry["id"].as_str().unwrap_or_default().to_owned();
                    let name = entry["name"].as_str().unwrap_or_default().to_owned();
                    let mime = entry["mimeType"].as_str().unwrap_or_default();
                    if mime == FOLDER {
                        next.push((id, [path.clone(), vec![name]].concat()));
                    } else if path.is_empty() && mime == DOC {
                        guide =
                            self.text(&format!("{API}/files/{id}/export?mimeType=text/plain"))?;
                    } else if path.is_empty() && name.ends_with(".txt") {
                        index = self.text(&format!("{API}/files/{id}?alt=media"))?;
                    } else if let (Some((stem, extension)), false) =
                        (name.rsplit_once('.'), path.is_empty())
                    {
                        if !AUDIO.contains(&extension.to_lowercase().as_str()) {
                            continue;
                        }
                        sounds.push(Sound {
                            // Every Epidemic download ends in its name; it says nothing.
                            name: stem.trim_end_matches(" - Epidemic Sound").to_owned(),
                            kind: if path[0].eq_ignore_ascii_case("music") {
                                "music"
                            } else {
                                "sfx"
                            },
                            category: path[1..].join(" / "),
                            note: None,
                            bytes: entry["size"]
                                .as_str()
                                .and_then(|size| size.parse().ok())
                                .unwrap_or(0),
                            md5: entry["md5Checksum"].as_str().unwrap_or(&id).to_owned(),
                            file: name,
                            id,
                        });
                    }
                }
            }
            level = next;
        }
        let notes = notes(&index);
        for sound in &mut sounds {
            sound.note = notes
                .get(sound.id.as_str())
                .or_else(|| notes.get(sound.file.as_str()))
                .cloned();
        }
        sounds.sort_by(|a, b| (a.kind, &a.category, &a.name).cmp(&(b.kind, &b.category, &b.name)));
        Ok(Listing {
            sounds,
            guide: guide.trim_start_matches('\u{feff}').trim().to_owned(),
        })
    }

    fn children(&self, folder: &str) -> Result<Vec<Value>, String> {
        let mut files = Vec::new();
        let mut page = String::new();
        loop {
            let query = format!("'{folder}' in parents and trashed = false");
            let mut url = format!(
                "{API}/files?q={}&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=nextPageToken,files(id,name,mimeType,size,md5Checksum)",
                encode(&query)
            );
            if !page.is_empty() {
                url.push_str(&format!("&pageToken={}", encode(&page)));
            }
            let value: Value =
                serde_json::from_str(&self.text(&url)?).map_err(|error| error.to_string())?;
            files.extend(value["files"].as_array().cloned().unwrap_or_default());
            match value["nextPageToken"].as_str() {
                Some(next) => page = next.to_owned(),
                None => return Ok(files),
            }
        }
    }

    /// A Drive API answer as text.
    fn text(&self, url: &str) -> Result<String, String> {
        let config = format!(
            "header = {}\n",
            quote(&format!("Authorization: Bearer {}", self.token()?))?
        );
        let (code, body) = curl(&config, &["--max-time", "60", url])?;
        let body = String::from_utf8_lossy(&body).into_owned();
        if code != 200 {
            return Err(drive_error(code, &body));
        }
        Ok(body)
    }

    fn token(&self) -> Result<String, String> {
        let mut cached = self.token.lock().unwrap();
        if let Some((token, until)) = &*cached {
            if Instant::now() < *until {
                return Ok(token.clone());
            }
        }
        let [id, secret, refresh] = [
            "GOOGLE_DRIVE_CLIENT_ID",
            "GOOGLE_DRIVE_CLIENT_SECRET",
            "GOOGLE_DOCS_REFRESH_TOKEN",
        ]
        .map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()));
        let (Some(id), Some(secret), Some(refresh)) = (id, secret, refresh) else {
            return Err("The sound library needs a Google Drive sign-in: start Edit with GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET and GOOGLE_DOCS_REFRESH_TOKEN set (`just dev` reads Repack's from Infisical).".into());
        };
        let config = [
            ("client_id", id),
            ("client_secret", secret),
            ("refresh_token", refresh),
            ("grant_type", "refresh_token".to_owned()),
        ]
        .iter()
        .map(|(name, value)| {
            Ok(format!(
                "data-urlencode = {}\n",
                quote(&format!("{name}={value}"))?
            ))
        })
        .collect::<Result<String, String>>()?;
        let (code, body) = curl(
            &config,
            &["--max-time", "30", "https://oauth2.googleapis.com/token"],
        )?;
        let value: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let token = value["access_token"]
            .as_str()
            .filter(|_| code == 200)
            .ok_or_else(|| format!("Google refused the Drive sign-in ({code})."))?
            .to_owned();
        let lasts = value["expires_in"]
            .as_u64()
            .unwrap_or(3600)
            .saturating_sub(120);
        *cached = Some((token.clone(), Instant::now() + Duration::from_secs(lasts)));
        Ok(token)
    }

    /// The sound's file on disk, downloaded if missing. The folder is named
    /// after the file's checksum, so a sound replaced in Drive is a new file
    /// and projects using the old one keep it.
    pub fn file(&self, home: &Path, sound: &Sound) -> Result<PathBuf, String> {
        let dir = home
            .join("library")
            .join(sound.kind)
            .join(sound.md5.get(..12).unwrap_or(&sound.md5));
        let path = dir.join(safe_name(&sound.file));
        let lock = Arc::clone(
            self.downloads
                .lock()
                .unwrap()
                .entry(sound.id.clone())
                .or_default(),
        );
        let _guard = lock.lock().unwrap();
        if path.is_file() {
            return Ok(path);
        }
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        let part = dir.join(".download");
        let config = format!(
            "header = {}\n",
            quote(&format!("Authorization: Bearer {}", self.token()?))?
        );
        let url = format!("{API}/files/{}?alt=media&supportsAllDrives=true", sound.id);
        let (code, _) = curl(
            &config,
            &[
                "--retry",
                "3",
                "--connect-timeout",
                "20",
                "-o",
                &part.to_string_lossy(),
                &url,
            ],
        )?;
        if code != 200 {
            let body = std::fs::read_to_string(&part).unwrap_or_default();
            let _ = std::fs::remove_file(&part);
            return Err(drive_error(code, &body));
        }
        std::fs::rename(&part, &path).map_err(|error| error.to_string())?;
        Ok(path)
    }
}

/// Downloads a library sound and adds it to the project's media (once). A
/// short sound effect comes with a "hit" marker on its loudest moment, for
/// lining it up on a cut.
pub async fn import(
    app: &App,
    project: &str,
    sound: &str,
    origin: &str,
) -> Result<(String, Sound), String> {
    let library = Arc::clone(&app.library);
    let home = app.store.home().to_path_buf();
    let id = sound.to_owned();
    let (sound, path) = tokio::task::spawn_blocking(move || {
        let listing = library.list(false)?;
        let sound = match listing.find(&id) {
            Some(sound) => sound.clone(),
            // Just added in Drive.
            None => library.list(true)?.find(&id).cloned().ok_or_else(|| {
                format!("no sound {id} in the library; list_library shows what's there")
            })?,
        };
        let path = library.file(&home, &sound)?;
        Ok::<_, String>((sound, path))
    })
    .await
    .map_err(|error| error.to_string())??;
    let (_, added, errors) = crate::server::import_paths(
        app,
        project,
        vec![path.to_string_lossy().into_owned()],
        false,
        origin,
    )
    .await?;
    let media_id = added
        .into_iter()
        .next()
        .ok_or_else(|| format!("couldn't import {}: {errors:?}", sound.name))?;
    let duration = app.store.get(project).and_then(|live| {
        live.project
            .media(&media_id)
            .map(|media| (media.duration, media.markers.is_empty()))
    });
    if let Some((duration, true)) = duration {
        if sound.kind == "sfx" && duration <= HIT_SECONDS {
            let hit = tokio::task::spawn_blocking(move || loudest(&path))
                .await
                .map_err(|error| error.to_string())??;
            app.store.update(project, origin, |project| {
                if let Some(media) = project.media.iter_mut().find(|media| media.id == media_id) {
                    if media.markers.is_empty() {
                        media.markers = vec![edit_core::Marker {
                            time: hit,
                            name: crate::sfx::HIT.to_owned(),
                        }];
                    }
                }
                Ok(())
            })?;
        }
    }
    Ok((media_id, sound))
}

/// How loud `seconds` of a sound from `from` are, in LUFS: integrated over
/// the stretch when it's longer than 3 s, else its loudest 400 ms (a hit is
/// heard at its peak). Padded with silence so a click shorter than the
/// window still measures.
pub fn loudness(path: &Path, from: f64, seconds: f64) -> Result<f64, String> {
    levels(path, from, seconds).map(|(lufs, _)| lufs)
}

/// The loudness as `loudness` measures it, and the sample peak (dBFS).
pub fn levels(path: &Path, from: f64, seconds: f64) -> Result<(f64, f64), String> {
    let output = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-nostats",
            "-protocol_whitelist",
            "file,pipe",
        ])
        .args([
            "-ss",
            &format!("{:.3}", from.max(0.0)),
            "-t",
            &format!("{:.3}", seconds.max(0.05)),
        ])
        .arg("-i")
        .arg(path)
        .args([
            "-map",
            "0:a:0",
            "-af",
            "apad=pad_dur=0.5,ebur128=peak=sample",
            "-f",
            "null",
            "-",
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    let log = String::from_utf8_lossy(&output.stderr);
    let value = |line: &str, key: &str| {
        line.split(key)
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|number| number.parse::<f64>().ok())
    };
    let loudest = log
        .lines()
        .filter(|line| line.contains(" M:"))
        .filter_map(|line| value(line, " M:"))
        .fold(f64::NEG_INFINITY, f64::max);
    let summary = |key: &str| {
        log.lines()
            .rev()
            .find(|line| line.trim_start().starts_with(key))
            .and_then(|line| value(line, key))
    };
    let peak = summary("Peak:").unwrap_or(0.0);
    match summary("I:") {
        Some(integrated) if seconds > 3.0 && integrated > -70.0 => Ok((integrated, peak)),
        _ if loudest > -70.0 => Ok((loudest, peak)),
        _ => Err("that stretch of the sound is silent".into()),
    }
}

/// The gain (dB) that brings an audio clip to `target` LUFS as heard, kept
/// so its peaks stay at or under -1 dBFS.
pub fn gain_to(
    project: &edit_core::Project,
    clip: &edit_core::Clip,
    target: f64,
) -> Result<f64, String> {
    let edit_core::ClipContent::Audio {
        media,
        source_in,
        speed,
        ..
    } = &clip.content
    else {
        return Err(format!("{} isn't audio", clip.id));
    };
    let media = project.media(media).ok_or("missing media")?;
    let seconds = clip.duration as f64 / project.fps() * speed;
    let (lufs, peak) = levels(Path::new(&media.path), *source_in, seconds)?;
    Ok((target - lufs).min(-1.0 - peak).clamp(-40.0, 36.0))
}

/// How loud the footage's own sound is across the timeline, in LUFS: its
/// clips (sound from video, not effects or voice-overs) averaged by energy
/// over their length, each as heard.
pub fn footage_loudness(project: &edit_core::Project) -> Result<f64, String> {
    let fps = project.fps();
    let (mut energy, mut seconds) = (0.0, 0.0);
    for clip in &project.clips {
        let edit_core::ClipContent::Audio {
            media,
            source_in,
            speed,
            volume_db,
        } = &clip.content
        else {
            continue;
        };
        let Some(media) = project.media(media) else {
            continue;
        };
        let length = clip.duration as f64 / fps;
        if media.kind != edit_core::MediaKind::Video || media.is_sound_effect() || length < 1.0 {
            continue;
        }
        if let Ok((lufs, _)) = levels(Path::new(&media.path), *source_in, length * speed) {
            energy += length * 10f64.powf((lufs + f64::from(*volume_db)) / 10.0);
            seconds += length;
        }
    }
    if seconds == 0.0 {
        return Err("no footage sound on the timeline to match".into());
    }
    Ok(10.0 * (energy / seconds).log10())
}

/// Seconds into the sound of its loudest 10 ms.
fn loudest(path: &Path) -> Result<f64, String> {
    const RATE: usize = 8000;
    let output = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
        ])
        .arg(path)
        .args([
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            &RATE.to_string(),
            "-f",
            "f32le",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    let samples: Vec<f32> = output
        .stdout
        .as_chunks::<4>()
        .0
        .iter()
        .map(|bytes| f32::from_le_bytes(*bytes))
        .collect();
    let window = RATE / 100;
    let loudest = samples
        .chunks(window)
        .map(|chunk| chunk.iter().map(|sample| sample * sample).sum::<f32>())
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map_or(0, |(index, _)| index);
    Ok((loudest * window) as f64 / RATE as f64 + 0.005)
}

/// The index's note for each file, by Drive id and by file name. An entry:
///
/// ```text
/// [Music / Investigative]
/// Out There - Out To The World.wav
/// Source note: First ~20 seconds: Epidemic Sound
/// Source: https://www.epidemicsound.com/…
/// Drive file: https://drive.google.com/file/d/<id>/view?usp=drivesdk
/// ```
fn notes(index: &str) -> HashMap<String, String> {
    let mut notes = HashMap::new();
    for entry in index.replace("\r\n", "\n").split("\n\n") {
        let lines: Vec<&str> = entry.lines().map(str::trim).collect();
        if !lines.first().is_some_and(|line| line.starts_with('[')) {
            continue;
        }
        let Some(note) = lines
            .iter()
            .find_map(|line| line.strip_prefix("Source note:"))
            .and_then(clean_note)
        else {
            continue;
        };
        if let Some(file) = lines.get(1) {
            notes.insert((*file).to_owned(), note.clone());
        }
        if let Some(id) = lines
            .iter()
            .find_map(|line| line.strip_prefix("Drive file:"))
            .and_then(|url| url.split("/d/").nth(1))
            .and_then(|rest| rest.split('/').next())
        {
            notes.insert(id.to_owned(), note);
        }
    }
    notes
}

/// "Whoosh 1, very low volume: Epidemic Sound" → "very low volume". Where it
/// came from and a bare label ("Hit 2") say nothing about the sound.
fn clean_note(note: &str) -> Option<String> {
    let note = note.trim();
    let note = match note.rsplit_once(": ") {
        Some((note, _source)) => note,
        None => note,
    };
    let label = |part: &str| {
        part.rsplit_once(' ').is_some_and(|(word, number)| {
            !word.is_empty() && number.chars().all(|c| c.is_ascii_digit())
        })
    };
    let parts: Vec<&str> = note.split(", ").collect();
    let parts = if parts.first().is_some_and(|part| label(part)) {
        &parts[1..]
    } else {
        &parts[..]
    };
    let note = parts.join(", ");
    (!note.is_empty()).then_some(note)
}

/// Runs curl with `config` (headers, form fields) on stdin so the sign-in
/// never shows in process arguments. Returns the status and the body (empty
/// when `args` writes it to a file).
fn curl(config: &str, args: &[&str]) -> Result<(u16, Vec<u8>), String> {
    let mut child = Command::new("curl")
        .args([
            "-sS",
            "-L",
            "--proto",
            "=https",
            "--config",
            "-",
            "-w",
            "\n%{http_code}",
        ])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("curl: {error}"))?;
    let written = child
        .stdin
        .take()
        .ok_or("curl stdin")
        .and_then(|mut stdin| stdin.write_all(config.as_bytes()).map_err(|_| "curl stdin"));
    let output = child
        .wait_with_output()
        .map_err(|error| format!("curl: {error}"))?;
    written?;
    if !output.status.success() {
        return Err(format!(
            "couldn't reach Google Drive: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let mut body = output.stdout;
    let split = body.iter().rposition(|byte| *byte == b'\n').unwrap_or(0);
    let code = String::from_utf8_lossy(&body[split..])
        .trim()
        .parse()
        .unwrap_or(0);
    body.truncate(split);
    Ok((code, body))
}

fn drive_error(code: u16, body: &str) -> String {
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let message = value["error"]["message"]
        .as_str()
        .unwrap_or("request failed");
    match code {
        401 | 403 => format!("Google Drive refused the sound library ({code}): {message}"),
        404 => "Google Drive can't find the sound library folder (or that file).".into(),
        _ => format!("Google Drive answered {code}: {message}"),
    }
}

/// A value for curl's config file, quoted.
fn quote(value: &str) -> Result<String, String> {
    if value.chars().any(char::is_control) {
        return Err("a Google Drive setting contains a control character".into());
    }
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn safe_name(name: &str) -> String {
    let name: String = name
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '\0') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let name = name.trim().trim_start_matches('.');
    if name.is_empty() {
        "sound.wav".into()
    } else {
        name.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_drop_labels_and_sources() {
        assert_eq!(clean_note("Hit 2: Epidemic Sound"), None);
        assert_eq!(
            clean_note(" Whoosh 1, very low volume: Epidemic Sound").as_deref(),
            Some("very low volume")
        );
        assert_eq!(
            clean_note("End of Luck, first ~9 seconds, good for intros: Epidemic Sound").as_deref(),
            Some("End of Luck, first ~9 seconds, good for intros")
        );
        assert_eq!(
            clean_note("Dark and slow: Epidemic Sound").as_deref(),
            Some("Dark and slow")
        );
    }

    #[test]
    fn index_notes_by_id_and_file() {
        let index = "MUSIC & SFX LIBRARY\n\n[Music / Investigative]\nOut There - Out To The World.wav\nSource note: First ~20 seconds: Epidemic Sound\nSource: https://www.epidemicsound.com/x/\nDrive file: https://drive.google.com/file/d/16fhcGN-KYu/view?usp=drivesdk\n\n[Sound effects / Hits]\nBoom.wav\nSource note: Hit 3: Epidemic Sound\n";
        let notes = notes(index);
        assert_eq!(
            notes.get("16fhcGN-KYu").map(String::as_str),
            Some("First ~20 seconds")
        );
        assert_eq!(
            notes
                .get("Out There - Out To The World.wav")
                .map(String::as_str),
            Some("First ~20 seconds")
        );
        assert!(!notes.contains_key("Boom.wav"));
    }

    #[test]
    fn curl_config_values_cannot_add_lines() {
        assert_eq!(quote("a\"b\\c").unwrap(), "\"a\\\"b\\\\c\"");
        assert!(quote("token\nheader = evil").is_err());
    }
}
