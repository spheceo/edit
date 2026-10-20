use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const PROJECT_VERSION: u32 = 1;

/// A whole edit. Times on the timeline are integer frames at `settings.fps`;
/// source offsets are seconds because sources keep their own frame rates.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Project {
    pub version: u32,
    pub id: String,
    pub name: String,
    /// The kind of video: which teaching the agent gets.
    #[serde(default)]
    pub style: Style,
    pub settings: Settings,
    #[serde(default)]
    pub media: Vec<Media>,
    /// Video tracks composite in list order (first = bottom). Audio tracks mix.
    #[serde(default)]
    pub tracks: Vec<Track>,
    #[serde(default)]
    pub clips: Vec<Clip>,
    #[serde(default)]
    pub next_id: u64,
    /// The script the edit follows (e.g. imported from a Google Doc).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub script: Option<Script>,
    /// In point (I): the first frame of the span that export renders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub mark_in: Option<i64>,
    /// Out point (O): the last frame of that span (shown, inclusive); playback stops on it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub mark_out: Option<i64>,
    /// A subtitled video's stretches and what each is (footage to subtitle,
    /// picture already subtitled, narration…): sorted, never overlapping.
    /// Empty: all of it is footage.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub segments: Vec<Segment>,
    /// The last whole export of a subtitled video, uploaded to the team's
    /// "Subtitles" folder on Google Drive. Cleared when the file is gone from Drive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub drive: Option<DriveFile>,
    /// Moments marked on the timeline itself (frames): what happens there
    /// ("photo lands", "door slam"), for lining sounds up on. A moment of a
    /// source goes on its media instead (`Media::markers`), so it moves with
    /// every clip that shows it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub markers: Vec<TimelineMarker>,
    /// Who speaks in it: each person's words on screen (subtitles, their
    /// label, intro captions, quotes) are text clips naming them by
    /// `Clip::person`, all in the person's one colour (`validate` holds every
    /// writer to it). Made by the subtitlers and kept by `people` in the
    /// server; empty for projects from before.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub people: Vec<Person>,
}

/// Someone whose words are on screen.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Person {
    /// Stable within the project ("p1"): clips name them by it.
    pub id: String,
    /// Who they are, as the footage's transcripts name them ("Lauren Wambles (Suspect)").
    pub name: String,
    /// Their subtitles' label as shown ("Lauren:"); empty when their subtitles carry none.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    /// officer, leader, suspect, victim, witness…; "other" when unknown.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub role: String,
    /// Their one colour, "#rrggbb": by their role (the team's code); white or a near-white grey only for a bystander or a witness.
    pub color: String,
    /// The transcripts' names their words came from ("Agent", "Travis Lawson (Agent)").
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub names: Vec<String>,
}

/// "#rrggbb" as bytes.
pub fn parse_hex(color: &str) -> Option<[u8; 3]> {
    let digits = color.strip_prefix('#')?.as_bytes();
    if digits.len() != 6 {
        return None;
    }
    let nibble = |c: u8| (c as char).to_digit(16).map(|v| v as u8);
    let byte = |at: usize| Some(nibble(*digits.get(at)?)? * 16 + nibble(*digits.get(at + 1)?)?);
    Some([byte(0)?, byte(2)?, byte(4)?])
}

impl Rgba {
    /// Its colour as "#rrggbb" bytes (alpha aside): channels clamped and rounded.
    pub fn bytes(&self) -> [u8; 3] {
        let byte = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        [byte(self.0[0]), byte(self.0[1]), byte(self.0[2])]
    }
}

/// White or a near-white grey (CIELAB lightness over 85, chroma under 15):
/// never a person's colour, since the words they say are white.
pub fn whitish(color: [u8; 3]) -> bool {
    let channel = |v: u8| {
        let v = f64::from(v) / 255.0;
        if v > 0.04045 {
            ((v + 0.055) / 1.055).powf(2.4)
        } else {
            v / 12.92
        }
    };
    let [r, g, b] = color.map(channel);
    let f = |t: f64| {
        if t > 0.008856 {
            t.cbrt()
        } else {
            7.787 * t + 16.0 / 116.0
        }
    };
    let x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
    let y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
    let z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
    let (l, a, bb) = (116.0 * y - 16.0, 500.0 * (x - y), 200.0 * (y - z));
    l > 85.0 && (a * a + bb * bb).sqrt() < 15.0
}

/// A marked moment on the timeline.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct TimelineMarker {
    pub frame: i64,
    #[serde(default)]
    pub name: String,
    /// What it's for, for people (and agents) reading it.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

/// The kind of video a project is. Each gets its own teaching for the agent
/// (`apps/server/src/styles.ts`); projects from before styles are bodycam.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "lowercase")]
pub enum Style {
    #[default]
    Bodycam,
    Interrogation,
    Courtroom,
}

impl Style {
    pub const ALL: [Style; 3] = [Style::Bodycam, Style::Interrogation, Style::Courtroom];

    pub fn name(self) -> &'static str {
        match self {
            Style::Bodycam => "bodycam",
            Style::Interrogation => "interrogation",
            Style::Courtroom => "courtroom",
        }
    }
}

/// A file on Google Drive.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct DriveFile {
    pub file_id: String,
    /// Where it opens: `https://drive.google.com/file/d/<file_id>/view`.
    pub url: String,
    pub name: String,
    pub uploaded_ms: u64,
}

/// A stretch of a subtitled video (frames, `end` exclusive).
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Segment {
    pub start: i64,
    pub end: i64,
    pub kind: SegmentKind,
    /// What's in it ("cold open", "map of the bank"), for people reading it.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum SegmentKind {
    /// Footage that gets subtitles.
    Footage,
    /// The picture already has subtitles burned in (an intro made before).
    Captioned,
    /// The narrator (a voice-over, never subtitled).
    Narration,
    /// Anything else not to subtitle: title cards, maps, music.
    Other,
}

impl SegmentKind {
    /// Whether lines said in it get subtitles.
    pub fn subtitled(self) -> bool {
        self == SegmentKind::Footage
    }

    pub fn label(self) -> &'static str {
        match self {
            SegmentKind::Footage => "Footage",
            SegmentKind::Captioned => "Already subtitled",
            SegmentKind::Narration => "Narration",
            SegmentKind::Other => "Not subtitled",
        }
    }
}

/// A script: footage ranges and the narration between them, in order.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Script {
    /// Where it came from (a Google Doc link).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub source: Option<String>,
    #[serde(default)]
    pub blocks: Vec<ScriptBlock>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScriptBlock {
    /// A range of linked footage, in seconds of that file.
    Footage {
        /// The link as written (a Google Drive file or a YouTube video).
        url: String,
        /// The file's id (a Drive file id, or `youtube:<video id>`): ranges of one file share it.
        file: String,
        start: f64,
        end: f64,
        /// The range as the script wrote it ("01:31 - 01:37").
        label: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        notes: Vec<String>,
        /// The media this range plays from, once downloaded.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        media: Option<String>,
        /// Seconds into the file where `media` begins, when it's an excerpt of it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        media_start: Option<f64>,
        /// The range's first and last spoken words, from the Doc's "word....word" comment.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        words: Option<[String; 2]>,
        /// Where the range really plays (seconds of the file): just before its
        /// first word and just after its last, as the transcript times them.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        cut: Option<[f64; 2]>,
        /// The clip that plays it on the timeline.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        clip: Option<String>,
    },
    /// Words between footage: shown as a cut-in card until there's a voice-over.
    Narration {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        notes: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        clip: Option<String>,
        /// The voice-over clip reading it, once placed: it stands in for the
        /// card once the card is gone.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        voiceover: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Settings {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// The NTSC rate near `fps`: ×1000/1001 (24 → 23.976, 30 → 29.97), the
    /// rate of footage shot that way, so its every frame is shown once.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ntsc: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: 30,
            ntsc: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Video,
    Audio,
    Image,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Media {
    pub id: String,
    pub name: String,
    pub path: String,
    pub kind: MediaKind,
    /// Seconds.
    pub duration: f64,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default)]
    pub fps: f64,
    #[serde(default)]
    pub has_audio: bool,
    /// Points marked in the source, carried by every clip of it (a sound's hit, a beat).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub markers: Vec<Marker>,
    /// Footage kept in the cloud (R2): the original stays there and `path`
    /// is this machine's copy of its small proxy (`crate::cloud_media` in edit).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub cloud: Option<CloudMedia>,
}

/// Where a cloud media's files are on R2 (keys under `edit/`).
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct CloudMedia {
    /// What it was made from, the key of Convex's footage registry (`edit:getMedia`):
    /// `drive:<file id>`, or `sha256:<hex>` for a file from a disk.
    pub source: String,
    /// The full-quality file, read by export.
    pub original: String,
    /// The proxy every machine edits with, once it's made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub proxy: Option<String>,
    /// Bytes of the original.
    #[serde(default)]
    pub size: u64,
}

/// A point in a media file.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Marker {
    /// Seconds into the source.
    pub time: f64,
    #[serde(default)]
    pub name: String,
    /// What happens there ("the door slams"), for planning sounds on it.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum TrackKind {
    Video,
    Audio,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Track {
    pub id: String,
    pub kind: TrackKind,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub locked: bool,
    /// The subtitles' own track: the top video track (drawn over everything,
    /// shown slim under the ruler). New tracks go beneath it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub subtitles: bool,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ClipColor {
    #[default]
    Blue,
    Cyan,
    Green,
    Yellow,
    Orange,
    Red,
    Purple,
    Pink,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Clip {
    pub id: String,
    pub track: String,
    /// First frame on the timeline.
    pub start: i64,
    /// Length in frames.
    pub duration: i64,
    #[serde(default)]
    pub color: ClipColor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub name: Option<String>,
    /// Clips sharing a link id move, trim and delete together (picture + sound).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub link: Option<String>,
    /// Frames.
    #[serde(default)]
    pub fade_in: i64,
    /// Frames.
    #[serde(default)]
    pub fade_out: i64,
    /// Animated parameters keyed by path (see [`Clip::param`]); frames are
    /// relative to the clip start.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub keyframes: BTreeMap<String, Vec<Keyframe>>,
    /// Whose words a text clip shows (a `Project::people` id): it's in their
    /// colour, its label's when it has one, else its text's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub person: Option<String>,
    #[serde(flatten)]
    pub content: ClipContent,
}

impl Clip {
    pub fn end(&self) -> i64 {
        self.start.saturating_add(self.duration)
    }

    pub fn contains(&self, frame: i64) -> bool {
        frame >= self.start && frame < self.end()
    }

    /// An adjustment or solid that belongs to the cut at `frame` and moves with
    /// it: one ending on it (a dip into it) or centred on it (a whip through it).
    pub fn marks_cut(&self, frame: i64) -> bool {
        matches!(
            self.content,
            ClipContent::Adjustment { .. } | ClipContent::Solid { .. }
        ) && (self.end() == frame
            || (self.start < frame && self.start + self.duration / 2 == frame))
    }

    pub fn media_id(&self) -> Option<&str> {
        match &self.content {
            ClipContent::Video { media, .. } | ClipContent::Audio { media, .. } => Some(media),
            _ => None,
        }
    }
}

/// A printed photo's border and drop shadow (project pixels).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct PhotoFrame {
    #[serde(default = "frame_width")]
    pub width: f32,
    #[serde(default = "frame_color")]
    pub color: Rgba,
    /// How dark the shadow is under the photo (0 none, 1 black).
    #[serde(default = "frame_shadow")]
    pub shadow: f32,
}

fn frame_width() -> f32 {
    12.0
}

fn frame_color() -> Rgba {
    Rgba([0.08, 0.08, 0.08, 1.0])
}

fn frame_shadow() -> f32 {
    0.55
}

/// A muted stretch of an audio clip's source, in seconds of the media.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Mute {
    pub from: f64,
    pub to: f64,
}

/// How long a mute takes to fade out and back in, outside its stretch
/// (seconds): a cosine ramp, as Repack's renderer does.
pub const MUTE_FADE_SECONDS: f64 = 0.012;

/// The gain a clip's mutes leave at `time` (seconds of the source): 1 away
/// from every mute, 0 inside one, a cosine ramp within MUTE_FADE_SECONDS of one.
pub fn mute_gain(mutes: &[Mute], time: f64) -> f64 {
    mutes.iter().fold(1.0, |gain: f64, mute| {
        let distance = (mute.from - time).max(time - mute.to).max(0.0);
        let ramp =
            (1.0 - (std::f64::consts::PI * (distance / MUTE_FADE_SECONDS).min(1.0)).cos()) / 2.0;
        gain.min(ramp)
    })
}

/// How much of a picture is cut off each side, as shares of its width and height.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Crop {
    #[serde(default)]
    pub left: f32,
    #[serde(default)]
    pub right: f32,
    #[serde(default)]
    pub top: f32,
    #[serde(default)]
    pub bottom: f32,
}

impl Crop {
    pub fn is_none(&self) -> bool {
        *self == Self::default()
    }
}

/// A solid that fades across the frame, left to right: clear at `from` and
/// full at `to` (shares of the frame width, 0 the left edge, 1 the right; `to`
/// below `from` fades the other way).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Gradient {
    pub from: f32,
    pub to: f32,
}

// Text carries the most settings; a project holds a few hundred clips, so the
// size is fine and boxing it would only add a hop to every match.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClipContent {
    Video {
        media: String,
        /// Seconds into the source at the clip's first frame.
        #[serde(default)]
        source_in: f64,
        #[serde(default = "one")]
        speed: f64,
        #[serde(default)]
        transform: Transform,
        #[serde(default = "one_f32")]
        opacity: f32,
        /// Cut off the picture's edges (a split screen's halves).
        #[serde(default, skip_serializing_if = "Crop::is_none")]
        crop: Crop,
        /// A border and soft drop shadow around the picture: a printed photo
        /// on an evidence board.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        frame: Option<PhotoFrame>,
    },
    Audio {
        media: String,
        #[serde(default)]
        source_in: f64,
        #[serde(default = "one")]
        speed: f64,
        #[serde(default)]
        volume_db: f32,
        /// Stretches of the source silenced (a swear word): seconds of the
        /// media, like source_in, each ramped over MUTE_FADE_SECONDS outside it.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        mutes: Vec<Mute>,
    },
    Text {
        text: String,
        #[serde(default)]
        style: TextStyle,
        #[serde(default)]
        transform: Transform,
        #[serde(default)]
        animation: TextAnimation,
        #[serde(default = "one_f32")]
        opacity: f32,
        /// Frames from the clip start at which each word appears (the `words` preset).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        word_times: Vec<f32>,
    },
    /// Applies a blur, a grade, camera shake and a glitch to everything composited beneath it.
    Adjustment {
        #[serde(default)]
        grade: Grade,
        #[serde(default, skip_serializing_if = "Shake::is_off")]
        shake: Shake,
        #[serde(default, skip_serializing_if = "Glitch::is_off")]
        glitch: Glitch,
        #[serde(default, skip_serializing_if = "Blur::is_off")]
        blur: Blur,
        #[serde(default = "one_f32")]
        opacity: f32,
    },
    /// Full-frame colour: flashes, fades to black, backgrounds.
    Solid {
        #[serde(default = "white")]
        fill: Rgba,
        #[serde(default = "one_f32")]
        opacity: f32,
        /// Fades across the frame instead of covering it evenly.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        gradient: Option<Gradient>,
    },
    /// A glowing waveform of the sound heard on the timeline (phone calls,
    /// voice notes): mirrored bars over a stretch of time centred on now.
    Waveform {
        /// Only this media's sound; everything heard when absent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        media: Option<String>,
        #[serde(default)]
        style: WaveformStyle,
        #[serde(default)]
        transform: Transform,
        #[serde(default = "one_f32")]
        opacity: f32,
    },
}

/// How a waveform looks. Sizes are project pixels.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct WaveformStyle {
    #[serde(default)]
    pub kind: WaveformKind,
    #[serde(default = "default_wave_color")]
    pub color: Rgba,
    /// Bars across the width (bars).
    #[serde(default = "default_wave_bars")]
    pub bars: u32,
    /// Tangled strands (line).
    #[serde(default = "default_wave_strands")]
    pub strands: u32,
    /// Across all the bars.
    #[serde(default = "default_wave_width")]
    pub width: f32,
    /// The tallest bar, top to bottom.
    #[serde(default = "default_wave_height")]
    pub height: f32,
    /// Each bar's share of its slot (the rest is the gap), 0..1.
    #[serde(default = "default_wave_fill")]
    pub fill: f32,
    /// Seconds of sound across the width, centred on now.
    #[serde(default = "default_wave_window")]
    pub window: f32,
    /// Multiplies the sound's level before drawing.
    #[serde(default = "one_f32")]
    pub gain: f32,
    /// The house glow, in the waveform's colour unless set.
    #[serde(default)]
    pub glow: Glow,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum WaveformKind {
    /// Glowing strands that zigzag with the sound, tangled together, like a real signal.
    #[default]
    Line,
    /// Mirrored bars with round ends.
    Bars,
}

fn default_wave_color() -> Rgba {
    Rgba([1.0, 0.03, 0.03, 1.0])
}

fn default_wave_bars() -> u32 {
    48
}

fn default_wave_strands() -> u32 {
    2
}

fn default_wave_width() -> f32 {
    1400.0
}

fn default_wave_height() -> f32 {
    360.0
}

fn default_wave_fill() -> f32 {
    0.5
}

fn default_wave_window() -> f32 {
    1.6
}

impl Default for WaveformStyle {
    fn default() -> Self {
        Self {
            kind: WaveformKind::default(),
            color: default_wave_color(),
            bars: default_wave_bars(),
            strands: default_wave_strands(),
            width: default_wave_width(),
            height: default_wave_height(),
            fill: default_wave_fill(),
            window: default_wave_window(),
            gain: 1.0,
            glow: Glow::default(),
        }
    }
}

fn one() -> f64 {
    1.0
}

fn one_f32() -> f32 {
    1.0
}

fn white() -> Rgba {
    Rgba::WHITE
}

/// Straight (not premultiplied) sRGB colour, 0..1.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Rgba(pub [f32; 4]);

impl Rgba {
    pub const WHITE: Self = Self([1.0, 1.0, 1.0, 1.0]);
    pub const BLACK: Self = Self([0.0, 0.0, 0.0, 1.0]);
}

/// Offsets are project pixels from the frame centre; scale is a multiplier.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Transform {
    #[serde(default)]
    pub x: f32,
    #[serde(default)]
    pub y: f32,
    #[serde(default = "one_f32")]
    pub scale: f32,
    /// Degrees, clockwise.
    #[serde(default)]
    pub rotation: f32,
    /// A little handheld camera shake: how far it wanders, in project pixels (0 = still).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub shake: f32,
}

fn is_zero(value: &f32) -> bool {
    *value == 0.0
}

fn is_one(value: &f32) -> bool {
    *value == 1.0
}

impl Default for Transform {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            scale: 1.0,
            rotation: 0.0,
            shake: 0.0,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct TextStyle {
    #[serde(default = "default_font")]
    pub font: String,
    #[serde(default = "default_weight")]
    pub weight: u16,
    /// Project pixels.
    #[serde(default = "default_size")]
    pub size: f32,
    #[serde(default = "white")]
    pub color: Rgba,
    /// Extra pixels between glyphs.
    #[serde(default)]
    pub tracking: f32,
    #[serde(default = "default_line_height")]
    pub line_height: f32,
    #[serde(default)]
    pub glow: Glow,
    /// Wrap lines wider than this many project pixels (subtitles). `None` = only at newlines.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub max_width: Option<f32>,
    /// A box behind the text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub background: Option<TextBox>,
    /// A soft drop shadow (the text grown, blurred and offset).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub shadow: Option<TextShadow>,
    /// A small line above the text, in its own colour (and box, when the
    /// text has one): who's speaking ("Officer:").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub label: Option<TextLabel>,
    /// A straight line from a point in the picture (a person's chin) to the
    /// text's box, drawn in from the point when the clip starts: a callout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub leader: Option<Box<Leader>>,
    /// How lines line up with each other (the block stays where it's placed).
    #[serde(default, skip_serializing_if = "TextAlign::is_center")]
    pub align: TextAlign,
    /// Shown in capitals (the text itself is kept as written: transcripts,
    /// starring and word times still read it): a courtroom's subtitles.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub uppercase: bool,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    Left,
    #[default]
    Center,
    Right,
}

impl TextAlign {
    pub fn is_center(&self) -> bool {
        *self == Self::Center
    }
}

/// A callout's line: from (x, y) to the nearest edge of the text's box.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Leader {
    /// The point it starts from: project pixels from the frame centre (y down).
    #[serde(default)]
    pub x: f32,
    #[serde(default)]
    pub y: f32,
    /// Project pixels.
    #[serde(default = "default_leader_width")]
    pub width: f32,
    #[serde(default = "default_leader_color")]
    pub color: Rgba,
    /// Frames from the clip's start it takes to draw from the point to the box.
    #[serde(default = "default_leader_draw")]
    pub draw: f32,
    /// Where it meets the box.
    #[serde(default)]
    pub attach: LeaderAttach,
    /// Frames the box (and its words, which start their animation then)
    /// takes to fade in once the line reaches it.
    #[serde(default = "default_leader_fade")]
    pub fade: f32,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum LeaderAttach {
    /// The nearest point of the box's edge, on the way to its centre.
    #[default]
    Nearest,
    /// The middle of the box's side facing the point (a box off to the side).
    Side,
}

fn default_leader_fade() -> f32 {
    8.0
}

fn default_leader_width() -> f32 {
    3.0
}

fn default_leader_color() -> Rgba {
    Rgba([1.0, 0.1, 0.1, 1.0])
}

fn default_leader_draw() -> f32 {
    10.0
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct TextLabel {
    pub text: String,
    #[serde(default = "white")]
    pub color: Rgba,
    /// Project pixels.
    #[serde(default = "default_label_size")]
    pub size: f32,
}

fn default_label_size() -> f32 {
    26.0
}

/// Behind-the-text box, sized to the lines plus padding (project pixels).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct TextBox {
    #[serde(default = "black")]
    pub color: Rgba,
    #[serde(default = "default_box_opacity")]
    pub opacity: f32,
    #[serde(default = "default_pad_x")]
    pub pad_x: f32,
    #[serde(default = "default_pad_y")]
    pub pad_y: f32,
    /// A line around the box, outside it (project pixels; 0 = none).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub border: f32,
    #[serde(default = "white")]
    pub border_color: Rgba,
}

fn black() -> Rgba {
    Rgba::BLACK
}

fn default_box_opacity() -> f32 {
    0.75
}

fn default_pad_x() -> f32 {
    12.0
}

fn default_pad_y() -> f32 {
    8.0
}

impl Default for TextBox {
    fn default() -> Self {
        Self {
            color: Rgba::BLACK,
            opacity: default_box_opacity(),
            pad_x: default_pad_x(),
            pad_y: default_pad_y(),
            border: 0.0,
            border_color: Rgba::WHITE,
        }
    }
}

/// Drop shadow as Premiere/Repack describe it (project pixels, degrees clockwise from up).
/// Text in a box: the box casts it.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct TextShadow {
    #[serde(default = "black")]
    pub color: Rgba,
    #[serde(default = "default_shadow_opacity")]
    pub opacity: f32,
    #[serde(default = "default_shadow_distance")]
    pub distance: f32,
    #[serde(default = "default_shadow_angle")]
    pub angle: f32,
    /// How far the text is grown before blurring.
    #[serde(default = "default_shadow_size")]
    pub size: f32,
    /// Blur radius.
    #[serde(default = "default_shadow_blur")]
    pub blur: f32,
}

fn default_shadow_opacity() -> f32 {
    0.65
}

fn default_shadow_distance() -> f32 {
    3.0
}

fn default_shadow_angle() -> f32 {
    112.0
}

fn default_shadow_size() -> f32 {
    6.0
}

fn default_shadow_blur() -> f32 {
    8.0
}

impl Default for TextShadow {
    fn default() -> Self {
        Self {
            color: Rgba::BLACK,
            opacity: default_shadow_opacity(),
            distance: default_shadow_distance(),
            angle: default_shadow_angle(),
            size: default_shadow_size(),
            blur: default_shadow_blur(),
        }
    }
}

fn default_font() -> String {
    "Geist".to_owned()
}

fn default_weight() -> u16 {
    700
}

fn default_size() -> f32 {
    96.0
}

fn default_line_height() -> f32 {
    1.15
}

impl Default for TextStyle {
    fn default() -> Self {
        Self {
            font: default_font(),
            weight: default_weight(),
            size: default_size(),
            color: Rgba::WHITE,
            tracking: 0.0,
            line_height: default_line_height(),
            glow: Glow::default(),
            max_width: None,
            background: None,
            shadow: None,
            label: None,
            leader: None,
            align: TextAlign::Center,
            uppercase: false,
        }
    }
}

/// A soft glow in the text's colour, drawn close and wide under the letters
/// (the house style carried over from Repack's subtitles).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Glow {
    #[serde(default = "yes")]
    pub enabled: bool,
    /// `None` follows the text colour.
    #[serde(default)]
    pub color: Option<Rgba>,
    /// Blur in project pixels at 1080p scale (CSS text-shadow radius of the wide layer).
    #[serde(default = "default_glow_radius")]
    pub radius: f32,
    /// Opacity of each layer: 0 = invisible, 1 = solid.
    #[serde(default = "default_glow_strength")]
    pub strength: f32,
}

fn yes() -> bool {
    true
}

fn default_glow_radius() -> f32 {
    46.0
}

fn default_glow_strength() -> f32 {
    0.5
}

impl Default for Glow {
    fn default() -> Self {
        Self {
            enabled: true,
            color: None,
            radius: default_glow_radius(),
            strength: default_glow_strength(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum TextPreset {
    #[default]
    None,
    /// Whole block fades in.
    Fade,
    /// Glyphs rise and fade in one after another.
    Rise,
    /// Glyphs scale up from small with a slight overshoot.
    Pop,
    /// Glyphs appear one at a time.
    Typewriter,
    /// Words appear one at a time, no motion: at the clip's `word_times` when
    /// given (synced to speech), else every `stagger` frames.
    Words,
    /// Only the word being said shows, alone, each replacing the last: timed
    /// like `Words`. For punchy lines.
    Word,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct TextAnimation {
    #[serde(default)]
    pub preset: TextPreset,
    /// Frames for one glyph (or the whole block for `fade`) to finish.
    #[serde(default = "default_anim_duration")]
    pub duration: f32,
    /// Frames between consecutive glyph starts.
    #[serde(default = "default_stagger")]
    pub stagger: f32,
}

fn default_anim_duration() -> f32 {
    12.0
}

fn default_stagger() -> f32 {
    1.5
}

impl Default for TextAnimation {
    fn default() -> Self {
        Self {
            preset: TextPreset::None,
            duration: default_anim_duration(),
            stagger: default_stagger(),
        }
    }
}

/// Camera shake on everything beneath an adjustment layer, modelled on
/// Sapphire S_Shake: a fast random wiggle `frequency` times a second,
/// `amount` px at its peak, with real motion blur along the movement and
/// mirrored edges. A preset supplies every number; any given here overrides it.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Shake {
    #[serde(default)]
    pub preset: ShakePreset,
    /// Pixels at its peak, at 1080p (scaled with the frame).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub amount: Option<f32>,
    /// Wiggles per second.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub frequency: Option<f32>,
    /// Degrees of tilt at its peak.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub rotation: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub direction: Option<ShakeDirection>,
    /// How strong it is across the clip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub envelope: Option<ShakeEnvelope>,
    /// Motion blur length in frames of movement (S_Shake's Mo Blur Length): 0 = sharp, 1 = a full frame.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub motion_blur: Option<f32>,
    /// What shows past the frame's edges as it moves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub edges: Option<ShakeEdges>,
    /// A random wiggle, or one fast move in a single direction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub motion: Option<ShakeMotion>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ShakeMotion {
    /// Random jolts `frequency` times a second, shaped by the envelope.
    #[default]
    Wiggle,
    /// A whip through a cut at the clip's middle: the picture accelerates away
    /// until the cut, then the next shot comes in from the other side and
    /// settles; `amount` px is a full move each side. Down (vertical) or right
    /// (horizontal); a negative amount goes up or left.
    Drop,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ShakePreset {
    /// No preset: only the numbers given (none = no shake).
    #[default]
    None,
    /// Slow, gentle drift, like a hand holding the camera.
    Handheld,
    /// A fast, heavily blurred drop: the picture slams downwards into the cut.
    Vertical,
    /// The same, whipping sideways.
    Horizontal,
    /// A violent jolt at the start that dies away, with a little tilt.
    Impact,
    /// Strong, fast and in every direction, throughout.
    Earthquake,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ShakeDirection {
    #[default]
    Both,
    Vertical,
    Horizontal,
}

/// The shake's strength over the clip.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ShakeEnvelope {
    /// Full strength throughout.
    #[default]
    Steady,
    /// Rises to full strength at the end (into a cut).
    Build,
    /// Full strength at the start, eased down to nothing (AE: amplitude keyed down with easy ease).
    Hit,
    /// Up to full strength in the middle and back down.
    Swell,
}

impl ShakeEnvelope {
    /// Strength at `progress` 0..1 through the clip.
    pub fn at(self, progress: f32) -> f32 {
        let p = progress.clamp(0.0, 1.0);
        match self {
            ShakeEnvelope::Steady => 1.0,
            ShakeEnvelope::Build => p * p * (3.0 - 2.0 * p),
            ShakeEnvelope::Hit => (1.0 - p) * (1.0 - p),
            ShakeEnvelope::Swell => (p * std::f32::consts::PI).sin(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ShakeEdges {
    /// Mirror the picture past its edges (S_Shake's Reflect): big moves, no crop.
    #[default]
    Mirror,
    /// Zoom in just enough that the edges never show.
    Zoom,
}

/// A shake with every number filled in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShakeSettings {
    pub amount: f32,
    pub frequency: f32,
    pub rotation: f32,
    pub direction: ShakeDirection,
    pub envelope: ShakeEnvelope,
    pub motion_blur: f32,
    pub edges: ShakeEdges,
    pub motion: ShakeMotion,
}

impl ShakePreset {
    pub const ALL: [ShakePreset; 6] = [
        ShakePreset::None,
        ShakePreset::Handheld,
        ShakePreset::Vertical,
        ShakePreset::Horizontal,
        ShakePreset::Impact,
        ShakePreset::Earthquake,
    ];

    /// The preset's numbers (amount at 1080p).
    pub fn settings(self) -> ShakeSettings {
        use ShakeDirection::{Both, Horizontal, Vertical};
        use ShakeEdges::{Mirror, Zoom};
        use ShakeEnvelope::{Hit, Steady};
        use ShakeMotion::{Drop, Wiggle};
        let (amount, frequency, rotation, direction, envelope, motion_blur, edges, motion) =
            match self {
                ShakePreset::None => (0.0, 8.0, 0.0, Both, Steady, 1.0, Mirror, Wiggle),
                ShakePreset::Handheld => (8.0, 1.2, 0.4, Both, Steady, 0.0, Zoom, Wiggle),
                ShakePreset::Vertical => (540.0, 0.0, 0.0, Vertical, Steady, 2.0, Mirror, Drop),
                ShakePreset::Horizontal => (540.0, 0.0, 0.0, Horizontal, Steady, 2.0, Mirror, Drop),
                ShakePreset::Impact => (160.0, 30.0, 3.0, Both, Hit, 1.5, Mirror, Wiggle),
                ShakePreset::Earthquake => (60.0, 16.0, 1.5, Both, Steady, 1.0, Mirror, Wiggle),
            };
        ShakeSettings {
            amount,
            frequency,
            rotation,
            direction,
            envelope,
            motion_blur,
            edges,
            motion,
        }
    }
}

impl Shake {
    pub fn is_off(&self) -> bool {
        *self == Shake::default()
    }

    /// Every number: the preset's unless given (amount at 1080p).
    pub fn resolved(&self) -> ShakeSettings {
        let preset = self.preset.settings();
        ShakeSettings {
            amount: self.amount.unwrap_or(preset.amount),
            frequency: self.frequency.unwrap_or(preset.frequency),
            rotation: self.rotation.unwrap_or(preset.rotation),
            direction: self.direction.unwrap_or(preset.direction),
            envelope: self.envelope.unwrap_or(preset.envelope),
            motion_blur: self.motion_blur.unwrap_or(preset.motion_blur),
            edges: self.edges.unwrap_or(preset.edges),
            motion: self.motion.unwrap_or(preset.motion),
        }
    }
}

/// A basic grade. All zeros (and a vignette of size 1, round, centred) is identity.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Grade {
    /// Stops.
    #[serde(default)]
    pub exposure: f32,
    /// -1..1.
    #[serde(default)]
    pub contrast: f32,
    /// -1..1 (-1 = greyscale).
    #[serde(default)]
    pub saturation: f32,
    /// -1 (cool) .. 1 (warm).
    #[serde(default)]
    pub temperature: f32,
    /// 0..1.
    #[serde(default)]
    pub vignette: f32,
    /// Where the vignette's light falls: project pixels from the frame centre
    /// (y down), so it can sit on a person and follow them.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub vignette_x: f32,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub vignette_y: f32,
    /// How far the clear area reaches: 1 = the whole frame's vignette, 0.5 = half as far.
    #[serde(default = "one_f32", skip_serializing_if = "is_one")]
    pub vignette_size: f32,
    /// The clear area's width over its height: 1 = round, 0.6 = tall (a standing person).
    #[serde(default = "one_f32", skip_serializing_if = "is_one")]
    pub vignette_aspect: f32,
    /// Stops added inside the vignette's clear area only (lifts the person it's on).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub focus_exposure: f32,
    /// Saturation change where the vignette falls only, -1..1 (-0.7 = the
    /// surroundings nearly grey while the person keeps their colour).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub vignette_saturation: f32,
    /// A light leak: warm light washing over the picture from one side, added
    /// as light (0 = none, 1 = a strong orange glow, 3+ burns to white where
    /// it's brightest). Keyed up and down across a cut it's the courtroom's
    /// and interrogation's transition.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub leak: f32,
    /// Where the leak's light comes from across the frame: -1 the left edge,
    /// 0 the centre, 1 the right edge (keyed to sweep it across).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub leak_x: f32,
    /// Film grain, 0..1: a fine noise that moves every frame (the team's
    /// overlay look on pictures and B-roll).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub grain: f32,
    /// Faint horizontal scan lines, 0..1 (an old monitor or tape).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub scanlines: f32,
    /// A faded print, 0..1: blacks lifted and whites dimmed.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub fade: f32,
}

impl Default for Grade {
    fn default() -> Self {
        Self {
            exposure: 0.0,
            contrast: 0.0,
            saturation: 0.0,
            temperature: 0.0,
            vignette: 0.0,
            vignette_x: 0.0,
            vignette_y: 0.0,
            vignette_size: 1.0,
            vignette_aspect: 1.0,
            focus_exposure: 0.0,
            vignette_saturation: 0.0,
            leak: 0.0,
            leak_x: 0.0,
            grain: 0.0,
            scanlines: 0.0,
            fade: 0.0,
        }
    }
}

/// A digital glitch on everything beneath an adjustment layer: the picture
/// is cut into horizontal bands of uneven height and some slide sideways,
/// a new pattern every frame, with only a touch of colour split.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Glitch {
    /// How far the bands slide at most, in pixels at 1080p (0 = off).
    #[serde(default)]
    pub amount: f32,
    /// How many bands the frame is cut into.
    #[serde(default = "default_glitch_slices")]
    pub slices: f32,
    /// Colour split as a share of each band's slide (0 = none).
    #[serde(default = "default_glitch_rgb")]
    pub rgb: f32,
}

fn default_glitch_slices() -> f32 {
    6.0
}

fn default_glitch_rgb() -> f32 {
    0.08
}

impl Default for Glitch {
    fn default() -> Self {
        Self {
            amount: 0.0,
            slices: default_glitch_slices(),
            rgb: default_glitch_rgb(),
        }
    }
}

impl Glitch {
    pub fn is_off(&self) -> bool {
        self.amount == 0.0
    }
}

/// A blur of the picture beneath an adjustment layer, over a region (a
/// minor's face, a name on screen) or the whole frame: blurred before the
/// grade, so the grade and shake apply to it as to the rest.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Blur {
    /// How strong: the Gaussian's spread in project px, as CSS `blur()`
    /// (0 = off; ~35 at 1080p leaves a face unrecognisable).
    #[serde(default)]
    pub radius: f32,
    /// The region's centre: project px from the frame centre, y down (as transforms).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub x: f32,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub y: f32,
    /// The region's size in project px; 0 (either) = the whole frame.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub width: f32,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub height: f32,
    /// Project px over which the blur fades out beyond the region's edge
    /// (the region itself is always fully blurred).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub feather: f32,
    #[serde(default, skip_serializing_if = "BlurShape::is_ellipse")]
    pub shape: BlurShape,
}

impl Blur {
    pub fn is_off(&self) -> bool {
        self.radius <= 0.0
    }

    /// Whether it covers the whole frame (no region given).
    pub fn is_whole_frame(&self) -> bool {
        self.width <= 0.0 || self.height <= 0.0
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum BlurShape {
    /// Fits a face.
    #[default]
    Ellipse,
    /// A rectangle with slightly rounded corners: a word, a plate, a screen.
    Rect,
}

impl BlurShape {
    fn is_ellipse(&self) -> bool {
        *self == Self::Ellipse
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum Ease {
    Linear,
    #[default]
    InOut,
    In,
    Out,
    /// Jump to the next value at the next keyframe.
    Hold,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Keyframe {
    /// Frame relative to the clip start.
    pub frame: f32,
    pub value: f32,
    /// Easing from this keyframe to the next (a preset; see `handle_out`).
    #[serde(default)]
    pub ease: Ease,
    /// Bezier handle arriving at this keyframe. `None` = from the previous keyframe's `ease`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub handle_in: Option<Handle>,
    /// Bezier handle leaving this keyframe. `None` = from `ease`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub handle_out: Option<Handle>,
}

/// After Effects-style temporal ease: how fast the value moves at the
/// keyframe and how far along the segment that speed pulls the curve.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Handle {
    /// Value units per frame at the keyframe.
    pub speed: f32,
    /// Share of the segment the handle reaches, 0 < influence <= 1.
    pub influence: f32,
}

/// Parameter paths that accept keyframes, per clip type.
pub fn animatable_params(content: &ClipContent) -> &'static [&'static str] {
    match content {
        ClipContent::Video { .. } => &["opacity", "x", "y", "scale", "rotation", "shake"],
        ClipContent::Audio { .. } => &["volume_db"],
        ClipContent::Text { .. } => &[
            "opacity",
            "x",
            "y",
            "scale",
            "rotation",
            "shake",
            "size",
            "tracking",
            "glow.radius",
            "glow.strength",
            "leader.x",
            "leader.y",
        ],
        ClipContent::Adjustment { .. } => &[
            "opacity",
            "shake",
            "exposure",
            "contrast",
            "saturation",
            "temperature",
            "vignette",
            "vignette_x",
            "vignette_y",
            "vignette_size",
            "leak",
            "leak_x",
            "glitch",
            "blur",
            "blur.x",
            "blur.y",
            "blur.width",
            "blur.height",
        ],
        ClipContent::Solid { .. } => &["opacity"],
        ClipContent::Waveform { .. } => &[
            "opacity",
            "x",
            "y",
            "scale",
            "rotation",
            "gain",
            "glow.radius",
            "glow.strength",
        ],
    }
}

impl Project {
    pub fn new(id: String, name: String, settings: Settings) -> Self {
        let mut project = Self {
            version: PROJECT_VERSION,
            id,
            name,
            style: Style::default(),
            settings,
            media: Vec::new(),
            tracks: Vec::new(),
            clips: Vec::new(),
            next_id: 1,
            script: None,
            mark_in: None,
            mark_out: None,
            segments: Vec::new(),
            drive: None,
            markers: Vec::new(),
            people: Vec::new(),
        };
        for kind in [
            TrackKind::Video,
            TrackKind::Video,
            TrackKind::Video,
            TrackKind::Audio,
            TrackKind::Audio,
        ] {
            project.add_track(kind);
        }
        project
    }

    pub fn fresh_id(&mut self, prefix: &str) -> String {
        loop {
            let next = self.next_id.clamp(1, 9_007_199_254_740_991);
            let id = format!("{prefix}{next}");
            self.next_id = if next == 9_007_199_254_740_991 {
                1
            } else {
                next + 1
            };
            if !self.tracks.iter().any(|track| track.id == id)
                && !self.media.iter().any(|media| media.id == id)
                && !self
                    .clips
                    .iter()
                    .any(|clip| clip.id == id || clip.link.as_deref() == Some(&id))
            {
                return id;
            }
        }
    }

    pub fn add_track(&mut self, kind: TrackKind) -> String {
        let id = self.fresh_id(match kind {
            TrackKind::Video => "v",
            TrackKind::Audio => "a",
        });
        let track = Track {
            id: id.clone(),
            kind,
            hidden: false,
            muted: false,
            locked: false,
            subtitles: false,
        };
        // Video goes on top of the rest, but under the subtitles.
        match self.tracks.iter().position(|track| track.subtitles) {
            Some(at) if kind == TrackKind::Video => self.tracks.insert(at, track),
            _ => self.tracks.push(track),
        }
        id
    }

    /// The subtitles' track, made (on top of every video track) if there isn't one.
    pub fn subtitles_track(&mut self) -> String {
        if let Some(track) = self.tracks.iter().find(|track| track.subtitles) {
            return track.id.clone();
        }
        let id = self.fresh_id("v");
        let after = self
            .tracks
            .iter()
            .rposition(|track| track.kind == TrackKind::Video)
            .map_or(0, |at| at + 1);
        self.tracks.insert(
            after,
            Track {
                id: id.clone(),
                kind: TrackKind::Video,
                hidden: false,
                muted: false,
                locked: false,
                subtitles: true,
            },
        );
        id
    }

    pub fn track(&self, id: &str) -> Option<&Track> {
        self.tracks.iter().find(|track| track.id == id)
    }

    pub fn media(&self, id: &str) -> Option<&Media> {
        self.media.iter().find(|media| media.id == id)
    }

    pub fn clip(&self, id: &str) -> Option<&Clip> {
        self.clips.iter().find(|clip| clip.id == id)
    }

    pub fn clip_mut(&mut self, id: &str) -> Option<&mut Clip> {
        self.clips.iter_mut().find(|clip| clip.id == id)
    }

    /// Last frame covered by any clip.
    pub fn duration(&self) -> i64 {
        self.clips.iter().map(Clip::end).max().unwrap_or(0)
    }

    /// Frames per second: `settings.fps`, ×1000/1001 when `settings.ntsc`.
    pub fn fps(&self) -> f64 {
        let fps = f64::from(self.settings.fps.max(1));
        if self.settings.ntsc {
            fps * 1000.0 / 1001.0
        } else {
            fps
        }
    }

    /// One-based display index for a track among tracks of its kind (V1, A2…).
    pub fn track_label(&self, id: &str) -> Option<String> {
        let track = self.track(id)?;
        let index = self
            .tracks
            .iter()
            .filter(|other| other.kind == track.kind)
            .position(|other| other.id == id)?;
        Some(format!(
            "{}{}",
            match track.kind {
                TrackKind::Video => "V",
                TrackKind::Audio => "A",
            },
            index + 1
        ))
    }

    /// Checks references and ranges. Agents write projects, so this runs on every save.
    /// The span between the in and out points as frames `[start, end)`, or
    /// None when neither is set. A missing in is the start; a missing out, the end.
    pub fn in_out(&self) -> Option<(i64, i64)> {
        if self.mark_in.is_none() && self.mark_out.is_none() {
            return None;
        }
        let duration = self.duration();
        let start = self.mark_in.unwrap_or(0).min((duration - 1).max(0));
        let end = self.mark_out.map_or(duration, |out| out + 1).min(duration);
        (end > start).then_some((start, end))
    }

    /// Whether frames `[start, end)` hold anything to subtitle: all of it
    /// without segments, else the frames inside footage segments.
    pub fn subtitled_spans(&self, start: i64, end: i64) -> Vec<(i64, i64)> {
        if self.segments.is_empty() {
            return if end > start {
                vec![(start, end)]
            } else {
                Vec::new()
            };
        }
        self.segments
            .iter()
            .filter(|segment| segment.kind.subtitled())
            .map(|segment| (segment.start.max(start), segment.end.min(end)))
            .filter(|(from, to)| to > from)
            .collect()
    }

    pub fn validate(&self) -> Result<(), String> {
        if self
            .segments
            .iter()
            .any(|segment| segment.start < 0 || segment.end <= segment.start)
            || self
                .segments
                .iter()
                .zip(self.segments.iter().skip(1))
                .any(|(before, after)| after.start < before.end)
        {
            return Err(
                "segments must be sorted, from frame 0, non-empty and never overlap".to_owned(),
            );
        }
        if self.markers.iter().any(|marker| marker.frame < 0) {
            return Err("timeline markers must be frames from 0".to_owned());
        }
        if self.mark_in.is_some_and(|frame| frame < 0)
            || self.mark_out.is_some_and(|frame| frame < 0)
        {
            return Err("mark_in and mark_out must be frames from 0".to_owned());
        }
        if let (Some(start), Some(end)) = (self.mark_in, self.mark_out) {
            if start > end {
                return Err("mark_in must not come after mark_out".to_owned());
            }
        }
        if self
            .drive
            .as_ref()
            .is_some_and(|file| !file.url.starts_with("https://drive.google.com/"))
        {
            return Err("drive.url must be a https://drive.google.com/ link".to_owned());
        }
        if self.next_id > 9_007_199_254_740_991 {
            return Err("next_id must fit in a JavaScript safe integer".to_owned());
        }
        if self.settings.width == 0 || self.settings.height == 0 || self.settings.fps == 0 {
            return Err("settings width, height and fps must be positive".to_owned());
        }
        if self.settings.width > 8192 || self.settings.height > 8192 {
            return Err("settings width and height must be at most 8192".to_owned());
        }
        let mut tracks = std::collections::HashSet::new();
        if let Some(script) = &self.script {
            for block in &script.blocks {
                if let ScriptBlock::Footage {
                    file, start, end, ..
                } = block
                {
                    // A Drive file id, or `youtube:<video id>`.
                    let id_chars = |id: &str| {
                        id.chars()
                            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
                    };
                    let drive = !file.is_empty() && file.len() <= 200 && id_chars(file);
                    let youtube = file
                        .strip_prefix("youtube:")
                        .is_some_and(|id| id.len() == 11 && id_chars(id));
                    if !drive && !youtube {
                        return Err(
                            "script file must be a Google Drive ID or youtube:<video id>, without path separators"
                                .to_owned(),
                        );
                    }
                    if !start.is_finite() || !end.is_finite() || *start < 0.0 || end <= start {
                        return Err(
                            "script footage needs a finite, positive source range".to_owned()
                        );
                    }
                }
            }
        }
        for track in &self.tracks {
            if track.id.is_empty() || !tracks.insert(&track.id) {
                return Err(format!("empty or duplicate track id {}", track.id));
            }
        }
        let subtitles: Vec<&Track> = self.tracks.iter().filter(|track| track.subtitles).collect();
        if subtitles.len() > 1 || subtitles.iter().any(|track| track.kind != TrackKind::Video) {
            return Err("there can be one subtitles track, a video track".to_owned());
        }
        let mut media_ids = std::collections::HashSet::new();
        for media in &self.media {
            if media.id.is_empty() || !media_ids.insert(&media.id) {
                return Err(format!("empty or duplicate media id {}", media.id));
            }
            if !media.duration.is_finite()
                || media.duration < 0.0
                || !media.fps.is_finite()
                || media.fps < 0.0
            {
                return Err(format!("media {} has invalid duration or fps", media.id));
            }
            if media
                .markers
                .iter()
                .any(|marker| !marker.time.is_finite() || marker.time < 0.0)
            {
                return Err(format!("media {} has an invalid marker", media.id));
            }
        }
        let mut ids = std::collections::HashSet::new();
        for clip in &self.clips {
            if clip.id.is_empty() || !ids.insert(clip.id.as_str()) {
                return Err(format!("duplicate clip id {}", clip.id));
            }
            let track = self
                .track(&clip.track)
                .ok_or_else(|| format!("clip {} is on unknown track {}", clip.id, clip.track))?;
            if clip.duration <= 0 {
                return Err(format!("clip {} must have a positive duration", clip.id));
            }
            if clip.start < 0 {
                return Err(format!("clip {} starts before frame 0", clip.id));
            }
            if clip
                .start
                .checked_add(clip.duration)
                .is_none_or(|end| end > 9_007_199_254_740_991)
            {
                return Err(format!(
                    "clip {} exceeds the timeline's integer range",
                    clip.id
                ));
            }
            if clip.fade_in < 0 || clip.fade_out < 0 {
                return Err(format!("clip {} fades must be nonnegative", clip.id));
            }
            let audio_clip = matches!(clip.content, ClipContent::Audio { .. });
            if audio_clip != (track.kind == TrackKind::Audio) {
                return Err(format!(
                    "clip {} is on a {} track",
                    clip.id,
                    if track.kind == TrackKind::Audio {
                        "audio"
                    } else {
                        "video"
                    }
                ));
            }
            if let Some(media) = clip.media_id() {
                if self.media(media).is_none() {
                    return Err(format!("clip {} references unknown media {media}", clip.id));
                }
            }
            if let ClipContent::Waveform { media, style, .. } = &clip.content {
                if let Some(media) = media {
                    if self.media(media).is_none() {
                        return Err(format!("clip {} references unknown media {media}", clip.id));
                    }
                }
                if !(1..=512).contains(&style.bars) {
                    return Err(format!("clip {} waveform bars must be 1 to 512", clip.id));
                }
                if !(1..=8).contains(&style.strands) {
                    return Err(format!("clip {} waveform strands must be 1 to 8", clip.id));
                }
                if style.width <= 0.0 || style.height <= 0.0 || style.window <= 0.0 {
                    return Err(format!(
                        "clip {} waveform width, height and window must be positive",
                        clip.id
                    ));
                }
            }
            if let ClipContent::Video { crop, .. } = &clip.content {
                let sides = [crop.left, crop.right, crop.top, crop.bottom];
                if sides.iter().any(|side| !(0.0..1.0).contains(side))
                    || crop.left + crop.right >= 0.99
                    || crop.top + crop.bottom >= 0.99
                {
                    return Err(format!(
                        "clip {} crop sides must be 0 to 1 and leave some of the picture",
                        clip.id
                    ));
                }
            }
            if let ClipContent::Adjustment { blur, .. } = &clip.content {
                if [blur.radius, blur.width, blur.height, blur.feather]
                    .iter()
                    .any(|value| *value < 0.0)
                {
                    return Err(format!(
                        "clip {} blur radius, width, height and feather can't be negative",
                        clip.id
                    ));
                }
            }
            if let ClipContent::Solid {
                gradient: Some(gradient),
                ..
            } = &clip.content
            {
                if (gradient.from - gradient.to).abs() < 1e-3 {
                    return Err(format!("clip {} gradient from and to must differ", clip.id));
                }
            }
            if let ClipContent::Audio { mutes, .. } = &clip.content {
                if mutes.iter().any(|mute| {
                    !(mute.from.is_finite() && mute.to.is_finite() && mute.from < mute.to)
                }) {
                    return Err(format!(
                        "clip {} mutes must be finite with from before to",
                        clip.id
                    ));
                }
            }
            if let ClipContent::Video {
                speed, source_in, ..
            }
            | ClipContent::Audio {
                speed, source_in, ..
            } = clip.content
            {
                if !source_in.is_finite() || source_in < 0.0 {
                    return Err(format!(
                        "clip {} source_in must be finite and nonnegative",
                        clip.id
                    ));
                }
                if !(0.05..=20.0).contains(&speed) {
                    return Err(format!(
                        "clip {} speed must be between 0.05 and 20",
                        clip.id
                    ));
                }
            }
            let allowed = animatable_params(&clip.content);
            if !content_finite(&clip.content) {
                return Err(format!("clip {} parameters must be finite", clip.id));
            }
            for (param, keys) in &clip.keyframes {
                if !allowed.contains(&param.as_str()) {
                    return Err(format!(
                        "clip {} cannot animate {param}; animatable: {}",
                        clip.id,
                        allowed.join(", ")
                    ));
                }
                if keys.is_empty() {
                    return Err(format!(
                        "clip {} has an empty keyframe list for {param}",
                        clip.id
                    ));
                }
                if keys
                    .iter()
                    .any(|key| !key.frame.is_finite() || !key.value.is_finite())
                    || keys
                        .windows(2)
                        .any(|pair| matches!(pair, [a, b] if a.frame >= b.frame))
                {
                    return Err(format!(
                        "clip {} {param}: keys must be finite and in strictly increasing order",
                        clip.id
                    ));
                }
                for handle in keys
                    .iter()
                    .flat_map(|key| [key.handle_in, key.handle_out])
                    .flatten()
                {
                    if !handle.speed.is_finite()
                        || !(handle.influence > 0.0 && handle.influence <= 1.0)
                    {
                        return Err(format!(
                            "clip {} {param}: handle influence must be in (0, 1] and speed finite",
                            clip.id
                        ));
                    }
                }
            }
        }
        self.validate_people()?;
        let mut ordered: Vec<_> = self.clips.iter().collect();
        ordered.sort_unstable_by(|a, b| (&a.track, a.start).cmp(&(&b.track, b.start)));
        for pair in ordered.windows(2) {
            let [clip, other] = pair else { continue };
            if clip.track == other.track && other.start < clip.end() {
                return Err(format!(
                    "clips {} and {} overlap on track {}",
                    clip.id,
                    other.id,
                    self.track_label(&clip.track).unwrap_or_default()
                ));
            }
        }
        Ok(())
    }

    /// One colour per person: every clip naming a person is a text clip in
    /// their colour, and nobody is white.
    fn validate_people(&self) -> Result<(), String> {
        let mut people = std::collections::HashMap::new();
        for person in &self.people {
            if person.id.is_empty() || people.contains_key(person.id.as_str()) {
                return Err(format!("empty or duplicate person id {}", person.id));
            }
            let color = parse_hex(&person.color).ok_or_else(|| {
                format!(
                    "person {} needs a colour as #rrggbb, not {:?}",
                    person.id, person.color
                )
            })?;
            // The team's code gives white only to a bystander, or a witness
            // when a victim is in it too; anyone else in white reads as nobody's.
            if whitish(color) && !matches!(person.role.as_str(), "bystander" | "witness") {
                return Err(format!(
                    "{} ({}) can't be white or a near-white grey: their words are white (only a bystander's or a witness's may be)",
                    person.name, person.id
                ));
            }
            people.insert(person.id.as_str(), (person, color));
        }
        for clip in &self.clips {
            let Some(id) = &clip.person else { continue };
            let (person, color) = people.get(id.as_str()).ok_or_else(|| {
                format!("clip {} names person {id}, who isn't in people", clip.id)
            })?;
            let ClipContent::Text { style, .. } = &clip.content else {
                return Err(format!("clip {} names a person but isn't text", clip.id));
            };
            let shown = style
                .label
                .as_ref()
                .map_or(style.color, |label| label.color)
                .bytes();
            if shown != *color {
                let [r, g, b] = shown;
                return Err(format!(
                    "clip {} is {}'s ({}), so it must be in their colour {}, not #{r:02x}{g:02x}{b:02x}: recolour the person, not one of their clips",
                    clip.id, person.name, person.id, person.color
                ));
            }
        }
        Ok(())
    }
}

fn content_finite(content: &ClipContent) -> bool {
    let transform_finite = |transform: &Transform| {
        [
            transform.x,
            transform.y,
            transform.scale,
            transform.rotation,
            transform.shake,
        ]
        .iter()
        .all(|value| value.is_finite())
    };
    let finite = |values: &[f32]| values.iter().all(|value| value.is_finite());
    match content {
        ClipContent::Video {
            transform,
            opacity,
            crop,
            ..
        } => {
            transform_finite(transform)
                && opacity.is_finite()
                && finite(&[crop.left, crop.right, crop.top, crop.bottom])
        }
        ClipContent::Audio {
            volume_db, mutes, ..
        } => {
            volume_db.is_finite()
                && mutes
                    .iter()
                    .all(|mute| mute.from.is_finite() && mute.to.is_finite())
        }
        ClipContent::Solid {
            fill,
            opacity,
            gradient,
        } => {
            finite(&fill.0)
                && opacity.is_finite()
                && gradient.is_none_or(|gradient| finite(&[gradient.from, gradient.to]))
        }
        ClipContent::Waveform {
            style,
            transform,
            opacity,
            ..
        } => {
            transform_finite(transform)
                && opacity.is_finite()
                && finite(&style.color.0)
                && finite(&[
                    style.width,
                    style.height,
                    style.fill,
                    style.window,
                    style.gain,
                    style.glow.radius,
                    style.glow.strength,
                ])
                && style.glow.color.is_none_or(|color| finite(&color.0))
        }
        ClipContent::Adjustment {
            grade,
            shake,
            glitch,
            blur,
            opacity,
        } => {
            let shake = shake.resolved();
            finite(&[
                blur.radius,
                blur.x,
                blur.y,
                blur.width,
                blur.height,
                blur.feather,
                grade.exposure,
                grade.contrast,
                grade.saturation,
                grade.temperature,
                grade.vignette,
                grade.vignette_x,
                grade.vignette_y,
                grade.vignette_size,
                grade.vignette_aspect,
                grade.focus_exposure,
                grade.vignette_saturation,
                grade.leak,
                grade.leak_x,
                glitch.amount,
                glitch.slices,
                glitch.rgb,
                shake.amount,
                shake.frequency,
                shake.rotation,
                shake.motion_blur,
                *opacity,
            ])
        }
        ClipContent::Text {
            style,
            transform,
            animation,
            opacity,
            word_times,
            ..
        } => {
            transform_finite(transform)
                && finite(&[
                    style.size,
                    style.tracking,
                    style.line_height,
                    style.glow.radius,
                    style.glow.strength,
                    animation.duration,
                    animation.stagger,
                    *opacity,
                ])
                && finite(&style.color.0)
                && style.glow.color.is_none_or(|color| finite(&color.0))
                && style.max_width.is_none_or(|value| value.is_finite())
                && finite(word_times)
                && style.background.is_none_or(|background| {
                    finite(&background.color.0)
                        && finite(&background.border_color.0)
                        && finite(&[
                            background.opacity,
                            background.pad_x,
                            background.pad_y,
                            background.border,
                        ])
                        && background.border >= 0.0
                })
                && style.leader.as_deref().is_none_or(|leader| {
                    finite(&leader.color.0)
                        && finite(&[leader.x, leader.y, leader.width, leader.draw, leader.fade])
                })
                && style.shadow.is_none_or(|shadow| {
                    finite(&shadow.color.0)
                        && finite(&[
                            shadow.opacity,
                            shadow.distance,
                            shadow.angle,
                            shadow.size,
                            shadow.blur,
                        ])
                })
        }
    }
}

#[cfg(test)]
mod validation_tests {
    use super::*;
    fn project() -> Project {
        let mut project = Project::new("p".into(), "test".into(), Settings::default());
        project.clips.push(Clip {
            id: "c".into(),
            track: project.tracks[0].id.clone(),
            start: 0,
            duration: 30,
            color: ClipColor::Blue,
            name: None,
            link: None,
            fade_in: 0,
            fade_out: 0,
            keyframes: Default::default(),
            person: None,
            content: ClipContent::Solid {
                fill: Rgba::BLACK,
                opacity: 1.0,
                gradient: None,
            },
        });
        project
    }
    #[test]
    fn script_files_are_drive_ids_or_youtube_videos() {
        let with = |file: &str| {
            let mut project = project();
            project.script = Some(Script {
                source: None,
                blocks: vec![serde_json::from_value(serde_json::json!({
                    "kind": "footage", "url": "", "file": file, "start": 1.0, "end": 2.0, "label": ""
                }))
                .unwrap_or_else(|error| panic!("{error}"))],
            });
            project.validate()
        };
        assert!(with("1H9hY3w4LjzWlSAqY8hfp3I5Ft5PP0X9Y").is_ok());
        assert!(with("youtube:MeT7tyZqfiw").is_ok());
        for bad in [
            "youtube:short",
            "youtube:../../etc/x",
            "drive:abc",
            "../x",
            "",
        ] {
            assert!(with(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn an_ntsc_project_runs_at_a_thousand_over_a_thousand_and_one() {
        let mut project: Project = serde_json::from_str(
            r#"{"version":1,"id":"p","name":"p","settings":{"width":1920,"height":1080,"fps":24},"media":[],"tracks":[],"clips":[]}"#,
        )
        .unwrap();
        assert_eq!(project.fps(), 24.0);
        assert!(!serde_json::to_string(&project.settings)
            .unwrap()
            .contains("ntsc"));
        project.settings.ntsc = true;
        assert!((project.fps() - 24000.0 / 1001.0).abs() < 1e-12);
        assert!(serde_json::to_string(&project.settings)
            .unwrap()
            .contains(r#""ntsc":true"#));
    }

    #[test]
    fn a_persons_clips_are_all_in_their_colour_and_nobody_is_white() {
        let mut p = project();
        let track = p.tracks[0].id.clone();
        let line = |id: &str, start: i64, color: Rgba, label: bool| Clip {
            id: id.into(),
            track: track.clone(),
            start,
            duration: 10,
            color: ClipColor::Cyan,
            name: Some("Subtitle · Lauren (Suspect)".into()),
            link: None,
            fade_in: 0,
            fade_out: 0,
            keyframes: Default::default(),
            person: Some("p1".into()),
            content: ClipContent::Text {
                text: "No.".into(),
                style: TextStyle {
                    color: if label { Rgba::WHITE } else { color },
                    label: label.then(|| TextLabel {
                        text: "Lauren:".into(),
                        color,
                        size: 26.0,
                    }),
                    ..Default::default()
                },
                transform: Default::default(),
                animation: Default::default(),
                opacity: 1.0,
                word_times: Vec::new(),
            },
        };
        let yellow = Rgba([1.0, 1.0, 0.0, 1.0]);
        p.clips = vec![line("a", 0, yellow, false), line("b", 10, yellow, true)];
        // Nobody by that id yet.
        assert!(p.validate().unwrap_err().contains("isn't in people"));
        p.people.push(Person {
            id: "p1".into(),
            name: "Lauren (Suspect)".into(),
            color: "#ffff00".into(),
            ..Default::default()
        });
        assert!(p.validate().is_ok(), "{:?}", p.validate());
        // One of her lines in another colour: refused, naming her.
        p.clips[1] = line("b", 10, Rgba([0.0, 0.9, 0.78, 1.0]), true);
        let error = p.validate().unwrap_err();
        assert!(
            error.contains("Lauren (Suspect)") && error.contains("#ffff00"),
            "{error}"
        );
        p.clips[1] = line("b", 10, yellow, true);
        // White isn't anyone's colour.
        p.people[0].color = "#f4f4f4".into();
        p.clips = vec![line("a", 0, Rgba([0.957, 0.957, 0.957, 1.0]), false)];
        assert!(p.validate().unwrap_err().contains("white"));
        p.people[0].color = "yellow".into();
        assert!(p.validate().unwrap_err().contains("#rrggbb"));
        // Two people under one id.
        p.people[0].color = "#ffff00".into();
        p.clips = vec![line("a", 0, yellow, false)];
        p.people.push(p.people[0].clone());
        assert!(p.validate().unwrap_err().contains("duplicate person id"));
    }

    #[test]
    fn fresh_ids_skip_existing_clips_and_links_and_wrap_safely() {
        let mut p = project();
        p.clips[0].id = "c1".into();
        p.clips[0].link = Some("l2".into());
        p.next_id = 1;
        assert_eq!(p.fresh_id("c"), "c2");
        p.next_id = 2;
        assert_eq!(p.fresh_id("l"), "l3");
        p.next_id = 9_007_199_254_740_991;
        assert_eq!(p.fresh_id("c"), "c9007199254740991");
        assert_eq!(p.fresh_id("c"), "c2");
        assert!(p.validate().is_ok());
    }

    #[test]
    fn blur_defaults_off_round_and_whole_frame_and_rejects_negatives() {
        let json = r#"{"type":"adjustment","grade":{"exposure":0,"contrast":0,"saturation":0,"temperature":0,"vignette":0}}"#;
        let content: ClipContent = serde_json::from_str(json).unwrap();
        let ClipContent::Adjustment { blur, .. } = content else {
            panic!("not an adjustment");
        };
        assert!(blur.is_off() && blur.is_whole_frame());
        assert_eq!(blur.shape, BlurShape::Ellipse);
        // Off, it isn't written; on, only what's set is.
        let written = serde_json::to_string(&content).unwrap();
        assert!(!written.contains("blur"), "{written}");
        let json = r#"{"type":"adjustment","grade":{"exposure":0,"contrast":0,"saturation":0,"temperature":0,"vignette":0},"blur":{"radius":35,"x":-120,"width":180,"height":220,"shape":"rect"}}"#;
        let content: ClipContent = serde_json::from_str(json).unwrap();
        let ClipContent::Adjustment { blur, .. } = content else {
            panic!("not an adjustment");
        };
        assert_eq!(
            blur,
            Blur {
                radius: 35.0,
                x: -120.0,
                y: 0.0,
                width: 180.0,
                height: 220.0,
                feather: 0.0,
                shape: BlurShape::Rect,
            }
        );
        assert!(!blur.is_off() && !blur.is_whole_frame());
        let written = serde_json::to_string(&content).unwrap();
        assert!(
            written.contains(
                r#""blur":{"radius":35.0,"x":-120.0,"width":180.0,"height":220.0,"shape":"rect"}"#
            ),
            "{written}"
        );

        let mut p = project();
        p.clips[0].content = content;
        p.clips[0].keyframes.insert(
            "blur.x".into(),
            vec![Keyframe {
                frame: 0.0,
                value: 10.0,
                ease: Ease::Linear,
                handle_in: None,
                handle_out: None,
            }],
        );
        assert!(p.validate().is_ok());
        let ClipContent::Adjustment { blur, .. } = &mut p.clips[0].content else {
            panic!("not an adjustment");
        };
        blur.radius = -1.0;
        assert!(p.validate().is_err());
    }

    #[test]
    fn mutes_ramp_and_must_run_forwards() {
        let mutes = [Mute { from: 2.0, to: 2.5 }];
        assert_eq!(mute_gain(&mutes, 2.2), 0.0);
        assert_eq!(mute_gain(&mutes, 1.9), 1.0);
        assert!((mute_gain(&mutes, 2.506) - 0.5).abs() < 1e-9);
        let json = r#"{"type":"audio","media":"m","mutes":[{"from":1.0,"to":1.5}]}"#;
        let content: ClipContent = serde_json::from_str(json).unwrap();
        assert!(matches!(&content, ClipContent::Audio { mutes, .. } if mutes.len() == 1));
        let silent = serde_json::to_string(&ClipContent::Audio {
            media: "m".into(),
            source_in: 0.0,
            speed: 1.0,
            volume_db: 0.0,
            mutes: Vec::new(),
        })
        .unwrap();
        assert!(!silent.contains("mutes"));
    }

    #[test]
    fn rejects_overflow_and_duplicate_references() {
        let mut p = project();
        p.clips[0].start = i64::MAX;
        assert!(p.validate().is_err());
        assert_eq!(p.duration(), i64::MAX);
        let mut p = project();
        p.tracks.push(p.tracks[0].clone());
        assert!(p.validate().is_err());
    }
    #[test]
    fn rejects_nonfinite_and_unsorted_keys() {
        let mut p = project();
        p.clips[0].content = ClipContent::Solid {
            fill: Rgba::BLACK,
            opacity: f32::NAN,
            gradient: None,
        };
        assert!(p.validate().is_err());
        let mut p = project();
        p.clips[0].keyframes.insert(
            "opacity".into(),
            vec![
                Keyframe {
                    frame: 10.0,
                    value: 1.0,
                    ease: Ease::Linear,
                    handle_in: None,
                    handle_out: None,
                },
                Keyframe {
                    frame: 0.0,
                    value: 0.0,
                    ease: Ease::Linear,
                    handle_in: None,
                    handle_out: None,
                },
            ],
        );
        assert!(p.validate().is_err());
    }
    #[test]
    fn drive_links_go_to_drive() {
        let mut p = project();
        let file = |url: &str| DriveFile {
            file_id: "f".into(),
            url: url.into(),
            name: "Case.mp4".into(),
            uploaded_ms: 1,
        };
        p.drive = Some(file("https://drive.google.com/file/d/f/view"));
        assert!(p.validate().is_ok());
        let text = serde_json::to_string(&p).unwrap();
        assert_eq!(serde_json::from_str::<Project>(&text).unwrap(), p);
        p.drive = Some(file("javascript:alert(1)"));
        assert!(p.validate().is_err());
        p.drive = None;
        assert!(!serde_json::to_string(&p).unwrap().contains("\"drive\""));
    }
}
