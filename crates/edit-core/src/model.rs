use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const PROJECT_VERSION: u32 = 1;

/// A whole edit. Times on the timeline are integer frames at `settings.fps`;
/// source offsets are seconds because sources keep their own frame rates.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Project {
    pub version: u32,
    pub id: String,
    pub name: String,
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
    pub script: Option<Script>,
    /// In point (I): the first frame of the span that export renders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mark_in: Option<i64>,
    /// Out point (O): the last frame of that span (shown, inclusive); playback stops on it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mark_out: Option<i64>,
}

/// A script: footage ranges and the narration between them, in order.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Script {
    /// Where it came from (a Google Doc link).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default)]
    pub blocks: Vec<ScriptBlock>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScriptBlock {
    /// A range of linked footage, in seconds of that file.
    Footage {
        /// The link as written (a Google Drive file).
        url: String,
        /// The file's id (Drive file id): ranges of one file share it.
        file: String,
        start: f64,
        end: f64,
        /// The range as the script wrote it ("01:31 - 01:37").
        label: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        notes: Vec<String>,
        /// The media this range plays from, once downloaded.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        media: Option<String>,
        /// Seconds into the file where `media` begins, when it's an excerpt of it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        media_start: Option<f64>,
        /// The range's first and last spoken words, from the Doc's "word....word" comment.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        words: Option<[String; 2]>,
        /// Where the range really plays (seconds of the file): just before its
        /// first word and just after its last, as the transcript times them.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cut: Option<[f64; 2]>,
        /// The clip that plays it on the timeline.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        clip: Option<String>,
    },
    /// Words between footage: shown as a cut-in card until there's a voice-over.
    Narration {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        notes: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        clip: Option<String>,
        /// The voice-over clip reading it, once placed: it stands in for the
        /// card once the card is gone.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        voiceover: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct Settings {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: 30,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Video,
    Audio,
    Image,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
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
}

/// A point in a media file.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Marker {
    /// Seconds into the source.
    pub time: f64,
    #[serde(default)]
    pub name: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TrackKind {
    Video,
    Audio,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
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
    pub name: Option<String>,
    /// Clips sharing a link id move, trim and delete together (picture + sound).
    #[serde(default, skip_serializing_if = "Option::is_none")]
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

    pub fn media_id(&self) -> Option<&str> {
        match &self.content {
            ClipContent::Video { media, .. } | ClipContent::Audio { media, .. } => Some(media),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
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
    },
    Audio {
        media: String,
        #[serde(default)]
        source_in: f64,
        #[serde(default = "one")]
        speed: f64,
        #[serde(default)]
        volume_db: f32,
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
    /// Applies a grade, and camera shake, to everything composited beneath it.
    Adjustment {
        #[serde(default)]
        grade: Grade,
        #[serde(default, skip_serializing_if = "Shake::is_off")]
        shake: Shake,
        #[serde(default = "one_f32")]
        opacity: f32,
    },
    /// Full-frame colour: flashes, fades to black, backgrounds.
    Solid {
        #[serde(default = "white")]
        fill: Rgba,
        #[serde(default = "one_f32")]
        opacity: f32,
    },
    /// A glowing waveform of the sound heard on the timeline (phone calls,
    /// voice notes): mirrored bars over a stretch of time centred on now.
    Waveform {
        /// Only this media's sound; everything heard when absent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
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
pub struct Rgba(pub [f32; 4]);

impl Rgba {
    pub const WHITE: Self = Self([1.0, 1.0, 1.0, 1.0]);
    pub const BLACK: Self = Self([0.0, 0.0, 0.0, 1.0]);
}

/// Offsets are project pixels from the frame centre; scale is a multiplier.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
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
    pub max_width: Option<f32>,
    /// A box behind the text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<TextBox>,
    /// A soft drop shadow (the text grown, blurred and offset).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow: Option<TextShadow>,
    /// A small line above the text, in its own colour (and box, when the
    /// text has one): who's speaking ("Officer:").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<TextLabel>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
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
        }
    }
}

/// A soft glow in the text's colour, drawn close and wide under the letters
/// (the house style carried over from Repack's subtitles).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
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
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
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
pub struct Shake {
    #[serde(default)]
    pub preset: ShakePreset,
    /// Pixels at its peak, at 1080p (scaled with the frame).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<f32>,
    /// Wiggles per second.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frequency: Option<f32>,
    /// Degrees of tilt at its peak.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<ShakeDirection>,
    /// How strong it is across the clip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub envelope: Option<ShakeEnvelope>,
    /// Motion blur length in frames of movement (S_Shake's Mo Blur Length): 0 = sharp, 1 = a full frame.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motion_blur: Option<f32>,
    /// What shows past the frame's edges as it moves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edges: Option<ShakeEdges>,
    /// A random wiggle, or one fast move in a single direction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motion: Option<ShakeMotion>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ShakeMotion {
    /// Random jolts `frequency` times a second, shaped by the envelope.
    #[default]
    Wiggle,
    /// One move that accelerates across the clip, `amount` px by its end:
    /// down (vertical) or right (horizontal); a negative amount goes up or
    /// left. With motion blur it's a slam into the next shot.
    Drop,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
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
#[serde(rename_all = "snake_case")]
pub enum ShakeDirection {
    #[default]
    Both,
    Vertical,
    Horizontal,
}

/// The shake's strength over the clip.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
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

/// A basic grade. All zeros is identity.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
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
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
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
pub struct Keyframe {
    /// Frame relative to the clip start.
    pub frame: f32,
    pub value: f32,
    /// Easing from this keyframe to the next (a preset; see `handle_out`).
    #[serde(default)]
    pub ease: Ease,
    /// Bezier handle arriving at this keyframe. `None` = from the previous keyframe's `ease`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle_in: Option<Handle>,
    /// Bezier handle leaving this keyframe. `None` = from `ease`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle_out: Option<Handle>,
}

/// After Effects-style temporal ease: how fast the value moves at the
/// keyframe and how far along the segment that speed pulls the curve.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
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
        ],
        ClipContent::Adjustment { .. } => &[
            "opacity",
            "shake",
            "exposure",
            "contrast",
            "saturation",
            "temperature",
            "vignette",
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
            settings,
            media: Vec::new(),
            tracks: Vec::new(),
            clips: Vec::new(),
            next_id: 1,
            script: None,
            mark_in: None,
            mark_out: None,
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

    pub fn fps(&self) -> f64 {
        f64::from(self.settings.fps.max(1))
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

    pub fn validate(&self) -> Result<(), String> {
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
                    if file.is_empty()
                        || file.len() > 200
                        || !file
                            .chars()
                            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
                    {
                        return Err(
                            "script file must be a Google Drive ID, without path separators"
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
                    || keys.windows(2).any(|pair| pair[0].frame >= pair[1].frame)
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
        let mut ordered: Vec<_> = self.clips.iter().collect();
        ordered.sort_unstable_by(|a, b| (&a.track, a.start).cmp(&(&b.track, b.start)));
        for pair in ordered.windows(2) {
            let [clip, other] = pair else { unreachable!() };
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
            transform, opacity, ..
        } => transform_finite(transform) && opacity.is_finite(),
        ClipContent::Audio { volume_db, .. } => volume_db.is_finite(),
        ClipContent::Solid { fill, opacity } => finite(&fill.0) && opacity.is_finite(),
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
            opacity,
        } => {
            let shake = shake.resolved();
            finite(&[
                grade.exposure,
                grade.contrast,
                grade.saturation,
                grade.temperature,
                grade.vignette,
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
            content: ClipContent::Solid {
                fill: Rgba::BLACK,
                opacity: 1.0,
            },
        });
        project
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
}
