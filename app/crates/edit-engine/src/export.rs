//! What an export makes (the export dialog's options): format, span, frame
//! shape, size, quality or target size, hardware encoding, sound and
//! chapters, and how FFmpeg encodes the rendered frames to match.

use std::sync::OnceLock;

use edit_core::Project;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum Format {
    /// MP4, H.264 + AAC: plays everywhere.
    #[default]
    H264,
    /// MP4, HEVC + AAC: about half the size at the same quality.
    Hevc,
    /// MOV, ProRes 422 HQ + PCM: a master for further editing.
    Prores,
    Gif,
    Wav,
    Mp3,
    /// One frame (the span's first) as a PNG.
    Png,
}

impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Format::H264 | Format::Hevc => "mp4",
            Format::Prores => "mov",
            Format::Gif => "gif",
            Format::Wav => "wav",
            Format::Mp3 => "mp3",
            Format::Png => "png",
        }
    }

    pub fn has_video(self) -> bool {
        !matches!(self, Format::Wav | Format::Mp3)
    }

    fn has_audio(self) -> bool {
        !matches!(self, Format::Gif | Format::Png)
    }

    fn has_chapters(self) -> bool {
        matches!(self, Format::H264 | Format::Hevc | Format::Prores)
    }
}

/// The picture's shape.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum Shape {
    /// The project's own.
    #[default]
    Original,
    /// 9:16 (Shorts, Reels, TikTok).
    Vertical,
    /// 1:1.
    Square,
    /// 4:5 (feed posts).
    Portrait,
}

/// How the edit fills a different shape.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum Fill {
    /// The whole picture, over a blurred, zoomed copy of itself.
    #[default]
    Blur,
    /// Zoomed in to fill it, the sides cut off.
    Crop,
    /// The whole picture, black bars around it.
    Black,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum Quality {
    #[default]
    High,
    Balanced,
    Small,
}

/// What an export is for: the house export, or a file to upload to YouTube
/// (Sphe, Nov 2: H.264 High, 4:2:0, BT.709, a keyframe every half second,
/// AAC-LC 48 kHz stereo at 384 kbps, the High bitrate, −14 LUFS with peaks
/// under −1 dBTP through the mixer's limiter).
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum Preset {
    #[default]
    House,
    Youtube,
}

/// YouTube's loudness (LUFS), unless the export asks for another.
pub const YOUTUBE_LUFS: f64 = -14.0;
/// YouTube's sound bitrate (AAC-LC stereo): YouTube asks 384 kbps, but no
/// encoder here makes it. Apple's AAC tops out at 320 kbps for 48 kHz stereo
/// ("Cannot Encode Media" past it), and FFmpeg's own, asked for 384, spends
/// ~250 even on pink noise (Nov 3). So the most there is: Apple's at 320.
const YOUTUBE_AUDIO: u32 = 320_000;

/// A chapter mark: frame on the timeline (not in the span) and its title.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Chapter {
    pub start: i64,
    pub title: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(default)]
pub struct ExportOptions {
    pub format: Format,
    /// Frames `[start, end)` of the edit; when absent, the in to out points, else all of it.
    pub range: Option<[i64; 2]>,
    pub shape: Shape,
    pub fill: Fill,
    /// The output's short side in px; the project's when absent.
    pub size: Option<u32>,
    /// Output frame rate; the project's when absent. Frames are dropped or
    /// repeated to get there (a 30 fps timeline doesn't gain motion at 60).
    pub fps: Option<u32>,
    pub quality: Quality,
    /// Aim for a file about this big (MB) instead of a quality (MP4 only).
    pub target_mb: Option<f64>,
    /// Encode on the video hardware: the Mac's media engine (VideoToolbox), or
    /// an NVIDIA card's NVENC elsewhere. Much faster, a little bigger.
    pub hardware: bool,
    /// Explicitly wait for optional optical flow; normally export the current snapshot immediately.
    pub wait_for_smoothing: bool,
    pub audio: bool,
    /// Bring the sound to this integrated loudness (LUFS), e.g. -14 for YouTube.
    pub loudness: Option<f64>,
    pub chapters: Vec<Chapter>,
    /// The house export, or YouTube's settings over these (`Preset`).
    pub preset: Preset,
}

impl ExportOptions {
    fn youtube(&self) -> bool {
        self.preset == Preset::Youtube
    }

    /// The quality the picture is encoded at: always High for YouTube.
    pub fn picture_quality(&self) -> Quality {
        if self.youtube() {
            Quality::High
        } else {
            self.quality
        }
    }

    /// The sound's bitrate: 320 kbps AAC in an MP4 for YouTube (`YOUTUBE_AUDIO`).
    pub fn sound_bitrate(&self) -> u32 {
        if self.youtube() && matches!(self.format, Format::H264 | Format::Hevc) {
            YOUTUBE_AUDIO
        } else {
            audio_bitrate(self.format, self.quality)
        }
    }

    /// The loudness the mix is brought to: −14 LUFS for YouTube unless asked otherwise.
    pub fn target_loudness(&self) -> Option<f64> {
        self.loudness.or(self.youtube().then_some(YOUTUBE_LUFS))
    }

    /// Frames between keyframes at `fps`: half a second for YouTube, else two seconds.
    pub fn key_interval(&self, fps: f64) -> i32 {
        let seconds = if self.youtube() { 0.5 } else { 2.0 };
        ((fps * seconds).round() as i32).max(1)
    }
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            format: Format::default(),
            range: None,
            shape: Shape::default(),
            fill: Fill::default(),
            size: None,
            fps: None,
            quality: Quality::default(),
            target_mb: None,
            hardware: true,
            wait_for_smoothing: false,
            audio: true,
            loudness: None,
            chapters: Vec::new(),
            preset: Preset::default(),
        }
    }
}

/// `path` ending in the format's extension: a known media extension is
/// swapped, anything else (a name with dots in it) kept and the extension added.
pub fn with_extension(path: &std::path::Path, format: Format) -> std::path::PathBuf {
    const MEDIA: [&str; 8] = ["mp4", "m4v", "mov", "gif", "wav", "mp3", "png", "m4a"];
    match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case(format.extension()) => path.to_path_buf(),
        Some(ext) if MEDIA.contains(&ext.to_ascii_lowercase().as_str()) => {
            path.with_extension(format.extension())
        }
        _ => {
            let mut name = path.as_os_str().to_owned();
            name.push(".");
            name.push(format.extension());
            name.into()
        }
    }
}

/// The options worked out against a project.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Plan {
    /// Frames `[start, end)` of the edit to render.
    pub start: i64,
    pub end: i64,
    pub width: u32,
    pub height: u32,
    /// Whether the file has sound (asked for, the format takes it, and something is heard).
    pub audio: bool,
    /// A chunked export renders the chunks from this frame on first, then
    /// the ones before it (smooth playback: where the viewer's playhead is).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub focus: Option<i64>,
}

impl Plan {
    pub fn seconds(&self, fps: f64) -> f64 {
        (self.end - self.start) as f64 / fps
    }
}

pub fn plan(options: &ExportOptions, project: &Project, heard: bool) -> Result<Plan, String> {
    let total = project.duration();
    // Without a span asked for, the in to out points, else the whole edit.
    let [start, end] = options.range.unwrap_or_else(|| {
        let (start, end) = project.in_out().unwrap_or((0, total));
        [start, end]
    });
    let start = start.clamp(0, total);
    let end = if options.format == Format::Png {
        start + 1
    } else {
        end.clamp(start, total)
    };
    if end <= start {
        return Err("there's nothing to export in that span".to_owned());
    }
    let audio = options.audio && options.format.has_audio() && heard;
    if !options.format.has_video() && !audio {
        return Err("there's no sound to export in that span".to_owned());
    }
    let (width, height) = output_size(options, project.settings.width, project.settings.height);
    Ok(Plan {
        start,
        end,
        width,
        height,
        audio,
        focus: None,
    })
}

/// Rounds down to even (H.264, HEVC and ProRes need even sizes), at least 2.
fn even(value: f64) -> u32 {
    ((value.round() as u32) & !1).max(2)
}

/// The output's size: the shape's aspect at the asked-for short side.
pub fn output_size(options: &ExportOptions, width: u32, height: u32) -> (u32, u32) {
    let (aspect_w, aspect_h) = match options.shape {
        Shape::Original => (width as f64, height as f64),
        Shape::Vertical => (9.0, 16.0),
        Shape::Square => (1.0, 1.0),
        Shape::Portrait => (4.0, 5.0),
    };
    let default_short = match options.format {
        Format::Gif => 480,
        _ => width.min(height),
    };
    let short = f64::from(options.size.unwrap_or(default_short).max(2));
    if aspect_w >= aspect_h {
        (even(short * aspect_w / aspect_h), even(short))
    } else {
        (even(short), even(short * aspect_h / aspect_w))
    }
}

/// Frames tagged BT.709 TV range: FFmpeg 8 wrote the primaries and transfer
/// of untagged frames as unknown, -color_primaries and -color_trc or not
/// (Nov 8: every export from Linux; `pipe_writer` tags its chunks the same).
pub const BT709: &str = "setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709";

/// The video filter graph from the rendered frames (`[0:v]`) to `[vout]`.
pub fn video_graph(options: &ExportOptions, source: (u32, u32), output: (u32, u32)) -> String {
    let (w, h) = output;
    let canvas = if options.shape == Shape::Original {
        if source == output {
            "[0:v]null[c]".to_owned()
        } else {
            format!("[0:v]scale={w}:{h}:flags=lanczos[c]")
        }
    } else {
        match options.fill {
            Fill::Crop => format!(
                "[0:v]scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,crop={w}:{h}[c]"
            ),
            Fill::Black => format!(
                "[0:v]scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black[c]"
            ),
            Fill::Blur => format!(
                "[0:v]split[bg][fg];\
                 [bg]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},gblur=sigma=40,eq=brightness=-0.08[bb];\
                 [fg]scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos[ff];\
                 [bb][ff]overlay=(W-w)/2:(H-h)/2[c]"
            ),
        }
    };
    let rate = match options.fps {
        Some(fps) if fps > 0 && !matches!(options.format, Format::Gif | Format::Png) => {
            format!("fps={fps},")
        }
        _ => String::new(),
    };
    let tail = match options.format {
        Format::Prores => {
            format!("[c]{rate}scale=out_color_matrix=bt709:out_range=tv,format=yuv422p10le,{BT709}[vout]")
        }
        Format::Gif => {
            "[c]fps=15,split[g0][g1];[g0]palettegen=stats_mode=diff[gp];[g1][gp]paletteuse=dither=bayer:bayer_scale=4[vout]"
                .to_owned()
        }
        Format::Png => "[c]format=rgb24[vout]".to_owned(),
        _ => format!("[c]{rate}scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,{BT709}[vout]"),
    };
    format!("{canvas};{tail}")
}

/// Bits per pixel per frame for hardware encoding and size estimates (H.264; HEVC needs ~60%).
fn bits_per_pixel(quality: Quality) -> f64 {
    match quality {
        Quality::High => 0.14,
        Quality::Balanced => 0.08,
        Quality::Small => 0.045,
    }
}

pub fn audio_bitrate(format: Format, quality: Quality) -> u32 {
    match (format, quality) {
        (Format::Mp3, Quality::High) => 320_000,
        (Format::Mp3, Quality::Balanced) => 224_000,
        (Format::Mp3, Quality::Small) => 160_000,
        (_, Quality::High) => 256_000,
        (_, Quality::Balanced) => 192_000,
        (_, Quality::Small) => 128_000,
    }
}

/// Shared target for the native writer (a chunk writer off macOS) and FFmpeg's hardware encoder.
pub fn video_bitrate(options: &ExportOptions, plan: &Plan, fps: f64) -> Result<u64, String> {
    if let Some(mb) = options.target_mb {
        let rate = mb * 8_000_000.0 * 0.94 / plan.seconds(fps)
            - if plan.audio {
                f64::from(options.sound_bitrate())
            } else {
                0.0
            };
        if !rate.is_finite() || rate < 150_000.0 {
            return Err("target size is too small".to_owned());
        }
        return Ok(rate.round() as u64);
    }
    Ok((f64::from(plan.width)
        * f64::from(plan.height)
        * fps
        * bits_per_pixel(options.picture_quality())
        * if options.format == Format::Hevc {
            0.6
        } else {
            1.0
        })
    .round() as u64)
}

/// The codec arguments for the whole output (after the inputs and maps):
/// picture, sound and, for MP4, the index at the front.
pub fn codec_args(options: &ExportOptions, plan: &Plan, fps: f64) -> Result<Vec<String>, String> {
    let mut args = video_args(options, plan, fps)?;
    if plan.audio {
        args.extend(audio_args(options));
    }
    if matches!(options.format, Format::H264 | Format::Hevc) {
        args.extend(["-movflags".to_owned(), "+faststart".to_owned()]);
    }
    Ok(args)
}

/// The sound's codec arguments for the format.
pub fn audio_args(options: &ExportOptions) -> Vec<String> {
    let rate = options.sound_bitrate().to_string();
    let args: &[&str] = match options.format {
        Format::H264 | Format::Hevc => &["-c:a", "aac", "-b:a", &rate],
        Format::Prores | Format::Wav => &["-c:a", "pcm_s16le"],
        Format::Mp3 => &["-c:a", "libmp3lame", "-b:a", &rate],
        Format::Gif | Format::Png => &[],
    };
    args.iter().map(|arg| (*arg).to_owned()).collect()
}

/// The picture's codec arguments for the format (none for sound-only formats).
pub fn video_args(options: &ExportOptions, plan: &Plan, fps: f64) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = Vec::new();
    let mut push = |items: &[&str]| args.extend(items.iter().map(|item| (*item).to_owned()));
    let format = options.format;
    let audio_rate = options.sound_bitrate();
    let seconds = plan.seconds(fps);
    // A target size sets the video bitrate; otherwise hardware encoders get one from the quality.
    let target = match options
        .target_mb
        .filter(|_| matches!(format, Format::H264 | Format::Hevc))
    {
        Some(mb) => {
            let total = mb * 8_000_000.0 * 0.94 / seconds;
            let video = total
                - if plan.audio {
                    f64::from(audio_rate)
                } else {
                    0.0
                };
            if video < 150_000.0 {
                return Err(format!(
                    "{mb} MB is too small for {seconds:.0} s of video; export a shorter span, a smaller size or allow more MB"
                ));
            }
            Some(video.round() as u64)
        }
        None => None,
    };
    let out_fps = options.fps.filter(|fps| *fps > 0).map_or(fps, f64::from);
    let quality_rate = |scale: f64| {
        (f64::from(plan.width)
            * f64::from(plan.height)
            * out_fps
            * bits_per_pixel(options.picture_quality())
            * scale)
            .round() as u64
    };
    let found = encoders();
    let hardware = options.hardware && found.videotoolbox;
    let nvenc = options.hardware && !hardware && found.nvenc;
    match format {
        Format::H264 | Format::Hevc => {
            let hevc = format == Format::Hevc;
            if nvenc {
                let rate = target.unwrap_or_else(|| quality_rate(if hevc { 0.6 } else { 1.0 }));
                push(
                    &nvenc_args(hevc, rate)
                        .iter()
                        .map(String::as_str)
                        .collect::<Vec<_>>(),
                );
            } else if hardware {
                let rate = target.unwrap_or_else(|| quality_rate(if hevc { 0.6 } else { 1.0 }));
                push(&[
                    "-c:v",
                    if hevc {
                        "hevc_videotoolbox"
                    } else {
                        "h264_videotoolbox"
                    },
                ]);
                push(&["-b:v", &rate.to_string(), "-allow_sw", "1"]);
            } else {
                push(&[
                    "-c:v",
                    if hevc { "libx265" } else { "libx264" },
                    "-preset",
                    "medium",
                ]);
                match target {
                    Some(rate) => {
                        let buffer = (rate * 2).to_string();
                        let rate = rate.to_string();
                        push(&["-b:v", &rate, "-maxrate", &rate, "-bufsize", &buffer]);
                    }
                    None => {
                        let crf = match (hevc, options.picture_quality()) {
                            (false, Quality::High) => "17",
                            (false, Quality::Balanced) => "20",
                            (false, Quality::Small) => "24",
                            (true, Quality::High) => "20",
                            (true, Quality::Balanced) => "23",
                            (true, Quality::Small) => "27",
                        };
                        push(&["-crf", crf]);
                    }
                }
                if hevc {
                    push(&["-x265-params", "log-level=error"]);
                }
            }
            if hevc {
                // Apple's players want the hvc1 tag.
                push(&["-tag:v", "hvc1"]);
            }
            if options.preset == Preset::Youtube {
                // A keyframe every half second, as YouTube asks.
                push(&["-g", &options.key_interval(out_fps).to_string()]);
            }
            push(&[
                "-colorspace",
                "bt709",
                "-color_primaries",
                "bt709",
                "-color_trc",
                "bt709",
            ]);
        }
        Format::Prores => {
            push(&["-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0"]);
            push(&[
                "-colorspace",
                "bt709",
                "-color_primaries",
                "bt709",
                "-color_trc",
                "bt709",
            ]);
        }
        Format::Gif => push(&["-loop", "0"]),
        Format::Png => push(&["-frames:v", "1", "-update", "1"]),
        Format::Wav | Format::Mp3 => {}
    }
    if format.has_video() && format != Format::Png {
        push(&["-t", &format!("{seconds:.6}")]);
    }
    Ok(args)
}

/// An FFMETADATA file with the chapters that fall in the span, shifted to
/// it, or None without any (or for formats that don't keep them).
pub fn chapters_file(options: &ExportOptions, plan: &Plan, fps: f64) -> Option<String> {
    if !options.format.has_chapters() {
        return None;
    }
    let mut marks: Vec<(i64, &str)> = options
        .chapters
        .iter()
        .filter(|chapter| chapter.start < plan.end)
        .map(|chapter| ((chapter.start - plan.start).max(0), chapter.title.trim()))
        .filter(|(_, title)| !title.is_empty())
        .collect();
    marks.sort_by_key(|(start, _)| *start);
    // Of chapters landing on the same frame (several before the span), keep the last.
    marks.dedup_by(|later, earlier| {
        let same = later.0 == earlier.0;
        if same {
            *earlier = *later;
        }
        same
    });
    if marks.is_empty() {
        return None;
    }
    let length = plan.end - plan.start;
    let ms = |frame: i64| (frame as f64 / fps * 1000.0).round() as i64;
    let mut text = String::from(";FFMETADATA1\n");
    for (index, (start, title)) in marks.iter().enumerate() {
        let end = marks.get(index + 1).map_or(length, |next| next.0);
        let escaped: String = title
            .chars()
            .flat_map(|c| match c {
                '=' | ';' | '#' | '\\' => vec!['\\', c],
                '\n' | '\r' => vec![' '],
                _ => vec![c],
            })
            .collect();
        text.push_str(&format!(
            "[CHAPTER]\nTIMEBASE=1/1000\nSTART={}\nEND={}\ntitle={escaped}\n",
            ms(*start),
            ms(end)
        ));
    }
    Some(text)
}

/// The encoders this FFmpeg has that the dialog's choices depend on.
#[derive(Clone, Copy, Debug, Default, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Encoders {
    pub videotoolbox: bool,
    /// An NVIDIA card's encoder, there and answering (FFmpeg lists it with no card or driver).
    pub nvenc: bool,
    pub hevc: bool,
    pub prores: bool,
    pub mp3: bool,
}

pub fn encoders() -> Encoders {
    static FOUND: OnceLock<Encoders> = OnceLock::new();
    *FOUND.get_or_init(|| {
        let listing = std::process::Command::new(crate::util::ffmpeg())
            .args(["-hide_banner", "-encoders"])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
            .unwrap_or_default();
        let has = |name: &str| {
            listing
                .lines()
                .any(|line| line.split_whitespace().nth(1) == Some(name))
        };
        Encoders {
            videotoolbox: has("h264_videotoolbox") && has("hevc_videotoolbox"),
            nvenc: !cfg!(target_os = "macos")
                && has("h264_nvenc")
                && has("hevc_nvenc")
                && nvenc_answers(),
            hevc: has("libx265"),
            prores: has("prores_ks"),
            mp3: has("libmp3lame"),
        }
    })
}

/// NVENC at `rate` bits a second: the rate VideoToolbox gets, at NVENC's
/// high-quality preset, with adaptive quantisation in space and time, a
/// lookahead and B-frames (an RTX 4060 runs p5 at several times real time for
/// 1080p, Nov 7). Exports and a chunked export's chunks (`pipe_writer`) alike.
pub fn nvenc_args(hevc: bool, rate: u64) -> Vec<String> {
    let mut args: Vec<String> = [
        "-c:v",
        if hevc { "hevc_nvenc" } else { "h264_nvenc" },
        "-preset",
        "p5",
        "-tune",
        "hq",
        "-rc",
        "vbr",
    ]
    .map(str::to_owned)
    .to_vec();
    args.extend([
        "-b:v".to_owned(),
        rate.to_string(),
        "-maxrate".to_owned(),
        (rate * 3 / 2).to_string(),
        "-bufsize".to_owned(),
        (rate * 2).to_string(),
    ]);
    args.extend(
        [
            "-spatial-aq",
            "1",
            "-temporal-aq",
            "1",
            "-rc-lookahead",
            "32",
            "-bf",
            "3",
        ]
        .map(str::to_owned),
    );
    if !hevc {
        args.extend(["-profile:v", "high"].map(str::to_owned));
    }
    args
}

/// Whether NVENC encodes a frame: the driver loads and the card takes a session.
fn nvenc_answers() -> bool {
    ["h264_nvenc", "hevc_nvenc"].iter().all(|codec| {
        std::process::Command::new(crate::util::ffmpeg())
            .args([
                "-hide_banner",
                "-v",
                "error",
                "-nostdin",
                "-f",
                "lavfi",
                "-i",
                "color=black:s=256x144:r=30:d=0.1",
                "-frames:v",
                "1",
                "-c:v",
                codec,
                "-f",
                "null",
                "/dev/null",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    })
}

#[cfg(test)]
mod tests {

    #[test]
    fn the_youtube_preset_is_high_with_320k_sound_a_keyframe_each_half_second_and_minus_14_lufs() {
        let house = options(Format::H264);
        let youtube = ExportOptions {
            preset: Preset::Youtube,
            quality: Quality::Small,
            ..options(Format::H264)
        };
        assert_eq!(house.sound_bitrate(), 256_000);
        assert_eq!(youtube.sound_bitrate(), 320_000);
        assert_eq!(youtube.picture_quality(), Quality::High);
        assert_eq!(youtube.target_loudness(), Some(-14.0));
        assert_eq!(house.target_loudness(), None);
        let asked = ExportOptions {
            loudness: Some(-16.0),
            ..youtube.clone()
        };
        assert_eq!(asked.target_loudness(), Some(-16.0));
        assert_eq!(youtube.key_interval(30.0), 15);
        assert_eq!(youtube.key_interval(29.97), 15);
        assert_eq!(house.key_interval(30.0), 60);
        // The house export: as it was, a 1080p30 picture at ~8.7 Mbit/s.
        let plan = Plan {
            start: 0,
            end: 300,
            width: 1920,
            height: 1080,
            audio: true,
            focus: None,
        };
        assert_eq!(
            video_bitrate(&youtube, &plan, 30.0).unwrap(),
            video_bitrate(&house, &plan, 30.0).unwrap()
        );
        let args = video_args(
            &ExportOptions {
                hardware: false,
                ..youtube.clone()
            },
            &plan,
            30.0,
        )
        .unwrap();
        assert!(args.windows(2).any(|pair| pair == ["-g", "15"]), "{args:?}");
        assert!(audio_args(&youtube).contains(&"320000".to_owned()));
    }

    use super::*;

    fn options(format: Format) -> ExportOptions {
        ExportOptions {
            format,
            ..Default::default()
        }
    }

    #[test]
    fn sizes_follow_the_shape_and_short_side() {
        let mut vertical = options(Format::H264);
        vertical.shape = Shape::Vertical;
        assert_eq!(output_size(&vertical, 1920, 1080), (1080, 1920));
        vertical.size = Some(720);
        assert_eq!(output_size(&vertical, 1920, 1080), (720, 1280));
        let mut square = options(Format::H264);
        square.shape = Shape::Square;
        assert_eq!(output_size(&square, 1920, 1080), (1080, 1080));
        assert_eq!(
            output_size(&options(Format::H264), 1920, 1080),
            (1920, 1080)
        );
        let mut smaller = options(Format::H264);
        smaller.size = Some(720);
        assert_eq!(output_size(&smaller, 1920, 1080), (1280, 720));
        // GIFs default small; odd sizes come out even.
        assert_eq!(output_size(&options(Format::Gif), 1920, 1080), (852, 480));
        assert_eq!(output_size(&options(Format::H264), 1281, 721), (1280, 720));
    }

    #[test]
    fn graphs_reframe_and_encode() {
        assert!(
            video_graph(&options(Format::H264), (1920, 1080), (1920, 1080))
                .starts_with("[0:v]null[c];")
        );
        let mut vertical = options(Format::H264);
        vertical.shape = Shape::Vertical;
        let graph = video_graph(&vertical, (1920, 1080), (1080, 1920));
        assert!(
            graph.contains("gblur")
                && graph.contains("overlay")
                && graph.ends_with(&format!("format=yuv420p,{BT709}[vout]"))
        );
        vertical.fps = Some(60);
        assert!(video_graph(&vertical, (1920, 1080), (1080, 1920)).contains("[c]fps=60,scale="));
        vertical.fill = Fill::Crop;
        assert!(video_graph(&vertical, (1920, 1080), (1080, 1920)).contains("crop=1080:1920"));
        assert!(video_graph(&options(Format::Gif), (1920, 1080), (852, 480)).contains("paletteuse"));
    }

    #[test]
    fn a_target_size_sets_the_bitrate() {
        let mut small = options(Format::H264);
        small.target_mb = Some(25.0);
        let plan = Plan {
            start: 0,
            end: 60 * 30,
            width: 1280,
            height: 720,
            audio: true,
            focus: None,
        };
        let args = codec_args(&small, &plan, 30.0).unwrap();
        let rate: f64 = args[args.iter().position(|arg| arg == "-b:v").unwrap() + 1]
            .parse()
            .unwrap();
        // 25 MB over a minute, less a little headroom and the sound.
        assert!((2_800_000.0..2_950_000.0).contains(&rate), "{rate}");
        small.target_mb = Some(1.0);
        let long = Plan {
            end: 600 * 30,
            ..plan
        };
        assert!(codec_args(&small, &long, 30.0).is_err());
    }

    #[test]
    fn chapters_shift_into_the_span() {
        let mut with = options(Format::H264);
        with.chapters = vec![
            Chapter {
                start: 0,
                title: "Intro".into(),
            },
            Chapter {
                start: 300,
                title: "On July 13; police".into(),
            },
            Chapter {
                start: 900,
                title: "Outro".into(),
            },
        ];
        let plan = Plan {
            start: 150,
            end: 600,
            width: 1920,
            height: 1080,
            audio: true,
            focus: None,
        };
        let text = chapters_file(&with, &plan, 30.0).unwrap();
        assert_eq!(
            text,
            ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=5000\ntitle=Intro\n\
             [CHAPTER]\nTIMEBASE=1/1000\nSTART=5000\nEND=15000\ntitle=On July 13\\; police\n"
        );
        assert!(chapters_file(&options(Format::Mp3), &plan, 30.0).is_none());
    }

    #[test]
    fn spans_and_sound() {
        let project: Project = serde_json::from_value(serde_json::json!({
            "version": 1, "id": "p", "name": "t",
            "settings": {"width": 1920, "height": 1080, "fps": 30},
            "media": [{"id": "m", "name": "a", "path": "/a.mp4", "kind": "video", "duration": 100.0}],
            "tracks": [{"id": "v1", "kind": "video"}],
            "clips": [{"id": "c", "track": "v1", "start": 0, "duration": 300, "type": "video", "media": "m", "source_in": 0.0}],
        }))
        .unwrap();
        let mut ranged = options(Format::H264);
        ranged.range = Some([30, 9999]);
        let plan = plan(&ranged, &project, true).unwrap();
        assert_eq!((plan.start, plan.end, plan.audio), (30, 300, true));
        let mut still = options(Format::Png);
        still.range = Some([42, 300]);
        assert_eq!(
            super::plan(&still, &project, true).map(|plan| (plan.start, plan.end, plan.audio)),
            Ok((42, 43, false))
        );
        assert!(super::plan(&options(Format::Wav), &project, false).is_err());
    }
}
