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
        self.start + self.duration
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
        }
    }
}

/// Drop shadow as Premiere/Repack describe it (project pixels, degrees clockwise from up).
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
        let id = format!("{prefix}{}", self.next_id.max(1));
        self.next_id = self.next_id.max(1) + 1;
        id
    }

    pub fn add_track(&mut self, kind: TrackKind) -> String {
        let id = self.fresh_id(match kind {
            TrackKind::Video => "v",
            TrackKind::Audio => "a",
        });
        self.tracks.push(Track {
            id: id.clone(),
            kind,
            hidden: false,
            muted: false,
            locked: false,
        });
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
    pub fn validate(&self) -> Result<(), String> {
        if self.settings.width == 0 || self.settings.height == 0 || self.settings.fps == 0 {
            return Err("settings width, height and fps must be positive".to_owned());
        }
        if self.settings.width > 8192 || self.settings.height > 8192 {
            return Err("settings width and height must be at most 8192".to_owned());
        }
        let mut ids = std::collections::HashSet::new();
        for clip in &self.clips {
            if !ids.insert(clip.id.as_str()) {
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
            if let ClipContent::Video { speed, .. } | ClipContent::Audio { speed, .. } =
                clip.content
            {
                if !(0.05..=20.0).contains(&speed) {
                    return Err(format!(
                        "clip {} speed must be between 0.05 and 20",
                        clip.id
                    ));
                }
            }
            let allowed = animatable_params(&clip.content);
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
        for (index, clip) in self.clips.iter().enumerate() {
            for other in &self.clips[index + 1..] {
                if clip.track == other.track && clip.start < other.end() && other.start < clip.end()
                {
                    return Err(format!(
                        "clips {} and {} overlap on track {}",
                        clip.id,
                        other.id,
                        self.track_label(&clip.track).unwrap_or_default()
                    ));
                }
            }
        }
        Ok(())
    }
}
