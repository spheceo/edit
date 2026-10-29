//! Chunked exports (speed-plan 4.2): a re-export redoes only what changed.
//!
//! Re-exports are common (15-Year-Old was exported six times, Mom & Teen
//! three) and each redid the whole picture, 5 to 16 minutes. So the picture
//! is encoded in chunks, each its own file starting on a keyframe, named by
//! what's on screen in it: every frame's scene (`evaluate_seen`) with clip ids
//! left out and media named by their content (`media_key`), the picture's
//! settings, and the code that draws and encodes it (`EDIT_RENDER_SOURCE`,
//! build.rs). A chunk ends on a cut whose frame's hash is a multiple of 16
//! (one cut in sixteen: a chunk is about a minute of an edit), at least
//! `MIN_SECONDS` in and at most `MAX_SECONDS`: content decides where chunks
//! end, so trimming a clip changes the chunk around it and the ones after
//! keep their boundaries rather than every chunk after the trim changing.
//!
//! The finished file is the chunks joined without re-encoding (FFmpeg's
//! concat), and the export remembers where each chunk sits in it
//! (`<cache>/export-chunks/<project>/manifest-v1.json`). A re-export copies
//! the chunks that didn't change out of that file (nothing extra is kept on
//! disk) and renders the rest; the sound too when nothing heard changed. The
//! chunks of an export that stopped part-way (cancelled, Edit quit) stay in
//! that folder, so running it again carries on.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use edit_core::{evaluate_seen, Layer, Project, Scene};
use serde::{Deserialize, Serialize};

use crate::export::Plan;

/// A chunk is at least this long unless the export is shorter...
pub const MIN_SECONDS: f64 = 10.0;
/// ...and at most this long.
pub const MAX_SECONDS: f64 = 120.0;
/// A new layout of the manifest or the keys is a new version.
const VERSION: u32 = 1;
const MANIFEST: &str = "manifest-v1.json";

/// Frames `[start, end)` of the timeline and what's in them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chunk {
    pub start: i64,
    pub end: i64,
    pub key: String,
}

impl Chunk {
    pub fn frames(&self) -> i64 {
        self.end - self.start
    }
}

/// What a file holds, as a key: its `media_key`; for a cloud original read
/// through a presigned URL (new every export), its object without the
/// signature: objects are named by their content and never change.
pub fn content_key(path: &Path) -> String {
    if crate::util::is_url(path) {
        let text = path.to_string_lossy();
        return text.split('?').next().unwrap_or_default().to_owned();
    }
    crate::media::media_key(path)
}

fn hasher(seed: &str) -> std::collections::hash_map::DefaultHasher {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    seed.hash(&mut hasher);
    hasher
}

/// A frame's content: the scene without clip ids, its media by content.
fn frame_hash(scene: &Scene, key: &mut dyn FnMut(&str) -> String) -> u64 {
    let mut scene = scene.clone();
    for layer in &mut scene.layers {
        match layer {
            Layer::Video { clip, media, .. } => {
                clip.clear();
                *media = key(media);
            }
            Layer::Text { clip, .. } => clip.clear(),
            Layer::Waveform { clip, sources, .. } => {
                clip.clear();
                for source in sources {
                    source.media = key(&source.media);
                }
            }
            // A glitch's pattern is seeded by the frame's place on the
            // timeline; with no glitch it draws nothing, so it isn't part of
            // what's on screen. Kept, it made every frame under a blur or a
            // vignette new when the timeline shifted: card 1's teasers grew
            // 2.1 s and 105 of its 127 chunks were rendered again (Oct 29).
            Layer::Adjustment { glitch, .. } => {
                if glitch.amount == 0.0 {
                    glitch.seed = 0.0;
                }
            }
            Layer::Solid { .. } => {}
        }
    }
    let mut hasher = hasher("frame");
    format!("{scene:?}").hash(&mut hasher);
    hasher.finish()
}

/// The clips on screen, in order: a change is a cut, where a chunk may end.
fn clips(scene: &Scene) -> Vec<&str> {
    scene
        .layers
        .iter()
        .filter_map(|layer| match layer {
            Layer::Video { clip, .. } | Layer::Text { clip, .. } | Layer::Waveform { clip, .. } => {
                Some(clip.as_str())
            }
            Layer::Adjustment { .. } | Layer::Solid { .. } => None,
        })
        .collect()
}

/// Splits `plan`'s frames into chunks keyed by their content and `settings`
/// (whatever else changes the encoded picture: size, codec, bitrate).
pub fn split(project: &Project, plan: &Plan, settings: &str) -> Vec<Chunk> {
    let fps = project.fps();
    let shortest = (MIN_SECONDS * fps).round() as i64;
    let longest = (MAX_SECONDS * fps).round() as i64;
    let mut keys: HashMap<String, String> = HashMap::new();
    let mut key = |media: &str| -> String {
        keys.entry(media.to_owned())
            .or_insert_with(|| {
                project.media(media).map_or_else(
                    || format!("missing:{media}"),
                    |found| content_key(Path::new(&found.path)),
                )
            })
            .clone()
    };
    let begin = || {
        let mut one = hasher(env!("EDIT_RENDER_SOURCE"));
        VERSION.hash(&mut one);
        settings.hash(&mut one);
        let mut two = hasher("second");
        settings.hash(&mut two);
        (one, two)
    };
    let mut out = Vec::new();
    let mut start = plan.start;
    let mut hashes = begin();
    let mut previous: Vec<String> = Vec::new();
    for frame in plan.start..plan.end {
        let scene = evaluate_seen(project, frame);
        let hash = frame_hash(&scene, &mut key);
        let now: Vec<String> = clips(&scene).into_iter().map(str::to_owned).collect();
        let length = frame - start;
        let cut = now != previous;
        if length >= longest || (length >= shortest && cut && hash.is_multiple_of(16)) {
            out.push(finish(start, frame, hashes));
            start = frame;
            hashes = begin();
        }
        hashes.0.write_u64(hash);
        hashes
            .1
            .write_u64(hash.rotate_left(17) ^ 0x9e37_79b9_7f4a_7c15);
        previous = now;
    }
    out.push(finish(start, plan.end, hashes));
    out
}

fn finish(
    start: i64,
    end: i64,
    (mut one, mut two): (
        std::collections::hash_map::DefaultHasher,
        std::collections::hash_map::DefaultHasher,
    ),
) -> Chunk {
    (end - start).hash(&mut one);
    (end - start).hash(&mut two);
    Chunk {
        start,
        end,
        key: format!("{:016x}{:016x}", one.finish(), two.finish()),
    }
}

/// One chunk of a finished export: where it sits in the file (frames).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Saved {
    pub key: String,
    pub at: i64,
    pub frames: i64,
}

/// The last finished export of a project, as the next one can reuse it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    pub output: PathBuf,
    /// The file as it was written: changed or gone, nothing is reused.
    pub size: u64,
    pub modified_ns: u64,
    pub fps: f64,
    pub chunks: Vec<Saved>,
    /// The sound's key, when the file has sound.
    pub sound: Option<String>,
}

/// The folder a project's chunks and manifest live in.
pub fn folder(cache: &Path, project: &str) -> PathBuf {
    let safe: String = project
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    cache.join("export-chunks").join(safe)
}

fn stamp(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some((meta.len(), u64::try_from(modified.as_nanos()).ok()?))
}

impl Manifest {
    /// The last export's manifest when its file is still as it was written.
    pub fn load(dir: &Path, fps: f64) -> Option<Manifest> {
        let text = std::fs::read_to_string(dir.join(MANIFEST)).ok()?;
        let manifest: Manifest = serde_json::from_str(&text).ok()?;
        let (size, modified_ns) = stamp(&manifest.output)?;
        (manifest.version == VERSION
            && manifest.fps == fps
            && manifest.size == size
            && manifest.modified_ns == modified_ns)
            .then_some(manifest)
    }

    /// Remembers `output` (finished, in its place) as made of `chunks`.
    pub fn save(
        dir: &Path,
        output: &Path,
        fps: f64,
        chunks: &[Chunk],
        sound: Option<String>,
    ) -> Result<(), String> {
        let (size, modified_ns) = stamp(output).ok_or("the export isn't there")?;
        let first = chunks.first().map_or(0, |chunk| chunk.start);
        let manifest = Manifest {
            version: VERSION,
            output: output.to_owned(),
            size,
            modified_ns,
            fps,
            chunks: chunks
                .iter()
                .map(|chunk| Saved {
                    key: chunk.key.clone(),
                    at: chunk.start - first,
                    frames: chunk.frames(),
                })
                .collect(),
            sound,
        };
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        let text = serde_json::to_string(&manifest).map_err(|error| error.to_string())?;
        let temporary = dir.join(format!("{MANIFEST}.partial"));
        std::fs::write(&temporary, text).map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, dir.join(MANIFEST)).map_err(|error| error.to_string())
    }

    /// Where chunk `key` sits in the file, if it's there.
    pub fn find(&self, key: &str) -> Option<&Saved> {
        self.chunks.iter().find(|saved| saved.key == key)
    }
}

/// A chunk made by an earlier run (finished: written to `.partial` first).
pub fn made(dir: &Path, key: &str, extension: &str) -> PathBuf {
    dir.join(format!("{key}.{extension}"))
}

/// Removes everything in `dir` but the manifest and the chunks in `keep`.
pub fn tidy(dir: &Path, keep: &[&Chunk], extension: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == MANIFEST {
            continue;
        }
        if keep
            .iter()
            .any(|chunk| name == format!("{}.{extension}", chunk.key))
        {
            continue;
        }
        let _ = std::fs::remove_file(entry.path());
    }
}

/// Where a chunk's frames come from.
#[derive(Clone, Debug, PartialEq)]
pub enum Piece {
    /// A file of its own (rendered now or by an earlier run).
    File(PathBuf),
    /// Copied out of the last export, `at` frames in.
    Old { file: PathBuf, at: i64 },
}

/// What a stretch copied out of the last export needs to know of it: how
/// far a keyframe's decoding time leads its presentation (the out point of a
/// stretch is the next chunk's keyframe's decoding time, not its frame's), and
/// where its keyframes are shown (seconds), so each stretch starts on its own.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OldFile {
    pub lead: f64,
    pub keyframes: Vec<f64>,
}

/// Reads `file`'s picture packets (not decoded) for [`OldFile`].
pub fn old_file(file: &Path) -> Result<OldFile, String> {
    let output = Command::new(crate::util::ffprobe())
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=pts_time,dts_time,flags",
            "-of",
            "csv=p=0",
        ])
        .arg(file)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffprobe: {error}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut old = OldFile::default();
    for (index, line) in text.lines().enumerate() {
        let mut parts = line.split(',').map(str::trim);
        let pts: Option<f64> = parts.next().and_then(|value| value.parse().ok());
        let dts: Option<f64> = parts.next().and_then(|value| value.parse().ok());
        let key = parts.next().is_some_and(|flags| flags.starts_with('K'));
        let Some(pts) = pts else { continue };
        if index == 0 {
            old.lead = (pts - dts.unwrap_or(pts)).max(0.0);
        }
        if key {
            old.keyframes.push(pts);
        }
    }
    if old.keyframes.is_empty() {
        return Err("the last export has no picture".to_owned());
    }
    Ok(old)
}

/// A path as FFmpeg's concat list quotes it.
fn quoted(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

/// The concat list joining `pieces` (with their chunks' lengths) at `fps`;
/// `old` is the last export's ([`old_file`]), when anything comes from it.
/// Fails when a stretch to copy doesn't start on one of its keyframes.
pub fn concat_list(pieces: &[(Piece, i64)], fps: f64, old: &OldFile) -> Result<String, String> {
    // Only the picture (track 1 in a chunk and in the joined file): the last
    // export's sound starts early (AAC's priming), and concat would shift the
    // picture by that much if it counted it.
    let mut text = String::from("ffconcat version 1.0\nstream\nexact_stream_id 1\n");
    for (piece, frames) in pieces {
        let duration = *frames as f64 / fps;
        match piece {
            Piece::File(path) => {
                text.push_str(&format!("file {}\nduration {duration}\n", quoted(path)));
            }
            Piece::Old { file, at } => {
                // Just past the keyframe the chunk starts on, as the file has
                // it: seeking to its exact time can land on the keyframe
                // before (a stretch copied out of 97 s came out 12 frames
                // long), and copies drift from the frame's own time by ticks.
                let shown = *at as f64 / fps;
                let keyframe = old
                    .keyframes
                    .iter()
                    .copied()
                    .find(|time| (time - shown).abs() < 0.5 / fps)
                    .ok_or_else(|| format!("the last export has no keyframe at frame {at}"))?;
                let inpoint = keyframe + 0.000_002;
                // Stops before the next chunk's keyframe, which is decoded
                // `lead` before it's shown; half a frame for rounding.
                let outpoint = (*at + frames) as f64 / fps - old.lead - 0.5 / fps;
                text.push_str(&format!(
                    "file {}\ninpoint {inpoint}\noutpoint {outpoint}\nduration {duration}\n",
                    quoted(file)
                ));
            }
        }
    }
    Ok(text)
}

/// The video packets in `file`'s first picture stream (read, not decoded).
pub fn frames_in(file: &Path) -> Result<i64, String> {
    let output = Command::new(crate::util::ffprobe())
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_packets",
            "-show_entries",
            "stream=nb_read_packets",
            "-of",
            "csv=p=0",
        ])
        .arg(file)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffprobe: {error}"))?;
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .map_err(|_| "couldn't count the export's frames".to_owned())
}

/// The picture's codec setup (SPS/PPS) in `file`, hashed: chunks joined
/// without re-encoding must all have the same.
pub fn setup_hash(file: &Path) -> Result<String, String> {
    let output = Command::new(crate::util::ffprobe())
        .args([
            "-v",
            "error",
            "-show_data_hash",
            "CRC32",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=extradata_hash,codec_name,width,height",
            "-of",
            "csv=p=0",
        ])
        .arg(file)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("ffprobe: {error}"))?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if text.is_empty() {
        return Err("a chunk has no picture".to_owned());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_concat_list_copies_old_stretches_up_to_the_next_keyframe() {
        let pieces = vec![
            (Piece::File(PathBuf::from("/c/a b.mp4")), 120),
            (
                Piece::Old {
                    file: PathBuf::from("/out/it's.mp4"),
                    at: 120,
                },
                120,
            ),
        ];
        let old = OldFile {
            lead: 1.0 / 30.0,
            keyframes: vec![0.0, 2.0, 4.0001],
        };
        let text = concat_list(&pieces, 30.0, &old).unwrap();
        assert!(text.contains("file '/c/a b.mp4'\nduration 4\n"));
        assert!(text.contains("file '/out/it'\\''s.mp4'\ninpoint 4.000102\noutpoint 7.95"));
        assert!(text.contains("duration 4\n"));
        // A stretch that doesn't start on a keyframe can't be copied.
        let none = OldFile {
            lead: 0.0,
            keyframes: vec![0.0],
        };
        assert!(concat_list(&pieces, 30.0, &none).is_err());
    }

    #[test]
    fn a_cloud_original_is_keyed_by_its_object_not_its_signature() {
        let one = Path::new("https://r2.example/edit/originals/sha256/ab/x.mp4?X-Amz-Signature=1");
        let two = Path::new("https://r2.example/edit/originals/sha256/ab/x.mp4?X-Amz-Signature=2");
        assert_eq!(content_key(one), content_key(two));
        assert_eq!(
            content_key(one),
            "https://r2.example/edit/originals/sha256/ab/x.mp4"
        );
    }

    #[test]
    fn a_frame_under_a_blur_hashes_the_same_wherever_it_is_on_the_timeline() {
        use edit_core::{
            evaluate_seen, Blur, Clip, ClipColor, ClipContent, Glitch, Grade, Media, MediaKind,
            Settings, Shake, Transform,
        };
        let project = |at: i64| {
            let mut project = Project::new("p".into(), "t".into(), Settings::default());
            project.media.push(Media {
                id: "m1".into(),
                name: "a.mp4".into(),
                path: "https://r2.example/edit/originals/a.mp4".into(),
                kind: MediaKind::Video,
                duration: 600.0,
                width: 1920,
                height: 1080,
                fps: 30.0,
                has_audio: true,
                markers: Vec::new(),
                cloud: None,
                library: None,
            });
            let (v1, v2) = (project.tracks[0].id.clone(), project.tracks[1].id.clone());
            let clip = |id: &str, track: String, content: ClipContent| Clip {
                id: id.into(),
                track,
                start: at,
                duration: 900,
                color: ClipColor::Blue,
                name: None,
                link: None,
                fade_in: 0,
                fade_out: 0,
                keyframes: Default::default(),
                person: None,
                content,
            };
            project.clips.push(clip(
                "c1",
                v1,
                ClipContent::Video {
                    media: "m1".into(),
                    source_in: 10.0,
                    speed: 1.0,
                    transform: Transform::default(),
                    opacity: 1.0,
                    crop: Default::default(),
                    frame: None,
                    blend: Default::default(),
                },
            ));
            project.clips.push(clip(
                "c2",
                v2,
                ClipContent::Adjustment {
                    grade: Grade::default(),
                    shake: Shake::default(),
                    glitch: Glitch::default(),
                    blur: Blur { radius: 30.0, width: 200.0, height: 100.0, ..Blur::default() },
                    opacity: 1.0,
                },
            ));
            project
        };
        let key = |media: &str| media.to_owned();
        let (before, after) = (project(0), project(63));
        for frame in [0, 100, 500] {
            assert_eq!(
                frame_hash(&evaluate_seen(&before, frame), &mut { key }),
                frame_hash(&evaluate_seen(&after, frame + 63), &mut { key }),
            );
        }
    }

    #[test]
    fn tidy_keeps_the_manifest_and_the_chunks_asked_for() {
        let dir = std::env::temp_dir().join(format!("edit-chunks-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in [MANIFEST, "aa.mp4", "bb.mp4", "cc.mp4.partial"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let keep = Chunk {
            start: 0,
            end: 1,
            key: "aa".to_owned(),
        };
        tidy(&dir, &[&keep], "mp4");
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec!["aa.mp4".to_owned(), MANIFEST.to_owned()]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
