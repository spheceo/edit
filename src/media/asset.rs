use std::{path::PathBuf, sync::OnceLock};

use ffmpeg_next as ffmpeg;

const DEFAULT_MAX_DECODE_WIDTH: usize = 1920;
const DEFAULT_MAX_DECODE_HEIGHT: usize = 1080;
const AV_TIME_BASE: f64 = 1_000_000.0;

#[derive(Clone)]
pub struct VideoAsset {
    pub path: PathBuf,
    pub name: String,
    pub source_width: usize,
    pub source_height: usize,
    pub decode_width: usize,
    pub decode_height: usize,
    pub duration: f64,
    pub fps: f64,
    pub has_audio: bool,
    pub rotation: i32,
    pub video_codec: String,
    pub audio_codec: Option<String>,
    pub audio_sample_rate: Option<u32>,
    pub audio_channels: Option<u16>,
    pub audio_bitrate: Option<usize>,
    pub file_size: Option<u64>,
}

impl VideoAsset {
    pub fn load(path: PathBuf) -> Result<Self, String> {
        initialize_ffmpeg()?;
        let input = ffmpeg::format::input(&path)
            .map_err(|error| format!("Kuro could not open that video: {error}"))?;
        let container_duration = input.duration();
        let audio_details = input
            .streams()
            .best(ffmpeg::media::Type::Audio)
            .and_then(|stream| {
                let decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
                    .ok()?
                    .decoder()
                    .audio()
                    .ok()?;
                Some((
                    decoder
                        .codec()
                        .map(|codec| codec.description().to_owned())
                        .unwrap_or_else(|| "Unknown audio codec".to_owned()),
                    decoder.rate(),
                    decoder.channels(),
                    decoder.bit_rate(),
                ))
            });
        let has_audio = audio_details.is_some();
        let stream = input
            .streams()
            .best(ffmpeg::media::Type::Video)
            .ok_or_else(|| "This file does not contain a video stream.".to_owned())?;
        let stream_duration = stream.duration();
        let time_base = rational_value(stream.time_base());
        let frame_rate = rational_value(stream.avg_frame_rate());
        let rotation = stream_rotation(&stream);

        let context = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
            .map_err(|error| format!("Kuro could not inspect the video codec: {error}"))?;
        let decoder = context
            .decoder()
            .video()
            .map_err(|error| format!("Kuro could not open the video decoder: {error}"))?;
        let video_codec = decoder
            .codec()
            .map(|codec| codec.description().to_owned())
            .unwrap_or_else(|| "Unknown video codec".to_owned());
        let coded_width = decoder.width().max(2) as usize;
        let coded_height = decoder.height().max(2) as usize;
        let rotated = rotation.rem_euclid(180) != 0;
        let (mut display_width, display_height) = if rotated {
            (coded_height, coded_width)
        } else {
            (coded_width, coded_height)
        };
        let sample_aspect_ratio = rational_value(decoder.aspect_ratio());
        if sample_aspect_ratio.is_finite() && sample_aspect_ratio > 0.0 {
            display_width = ((display_width as f64 * sample_aspect_ratio).round() as usize).max(2);
        }

        let duration = if container_duration > 0 {
            container_duration as f64 / AV_TIME_BASE
        } else {
            stream_duration as f64 * time_base
        };
        if !duration.is_finite() || duration <= 0.0 {
            return Err("This video has no readable duration.".to_owned());
        }

        let (decode_width, decode_height) = decode_dimensions(
            display_width,
            display_height,
            DEFAULT_MAX_DECODE_WIDTH,
            DEFAULT_MAX_DECODE_HEIGHT,
        );
        let fps = if frame_rate.is_finite() && frame_rate > 0.0 {
            frame_rate
        } else {
            30.0
        }
        .clamp(1.0, 60.0);

        let (audio_codec, audio_sample_rate, audio_channels, audio_bitrate) = audio_details
            .map(|(codec, rate, channels, bitrate)| {
                (
                    Some(codec),
                    Some(rate),
                    Some(channels),
                    (bitrate > 0).then_some(bitrate),
                )
            })
            .unwrap_or((None, None, None, None));
        let file_size = std::fs::metadata(&path).ok().map(|metadata| metadata.len());

        Ok(Self {
            name: path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Imported video")
                .to_owned(),
            path,
            source_width: display_width,
            source_height: display_height,
            decode_width,
            decode_height,
            duration,
            fps,
            has_audio,
            rotation,
            video_codec,
            audio_codec,
            audio_sample_rate,
            audio_channels,
            audio_bitrate,
            file_size,
        })
    }

    pub fn aspect_ratio(&self) -> f32 {
        self.source_width as f32 / self.source_height.max(1) as f32
    }

    pub fn set_decode_budget(&mut self, max_width: usize, max_height: usize) {
        (self.decode_width, self.decode_height) =
            decode_dimensions(self.source_width, self.source_height, max_width, max_height);
    }
}

pub fn initialize_ffmpeg() -> Result<(), String> {
    static INITIALIZED: OnceLock<Result<(), String>> = OnceLock::new();
    INITIALIZED
        .get_or_init(|| {
            ffmpeg::init()
                .map_err(|error| format!("The internal media engine could not start: {error}"))
        })
        .clone()
}

pub fn rational_value(value: ffmpeg::Rational) -> f64 {
    if value.denominator() == 0 {
        0.0
    } else {
        value.numerator() as f64 / value.denominator() as f64
    }
}

fn stream_rotation(stream: &ffmpeg::Stream<'_>) -> i32 {
    if let Some(value) = stream.metadata().get("rotate") {
        if let Ok(rotation) = value.parse::<f64>() {
            return normalize_rotation(rotation.round() as i32);
        }
    }

    for side_data in stream.side_data() {
        if side_data.kind() == ffmpeg::packet::side_data::Type::DisplayMatrix
            && side_data.data().len() >= 9 * std::mem::size_of::<i32>()
        {
            let angle = unsafe {
                ffmpeg::ffi::av_display_rotation_get(side_data.data().as_ptr().cast::<i32>())
            };
            if angle.is_finite() {
                return normalize_rotation(angle.round() as i32);
            }
        }
    }
    0
}

fn normalize_rotation(rotation: i32) -> i32 {
    let normalized = rotation.rem_euclid(360);
    match normalized {
        45..=134 => 90,
        135..=224 => 180,
        225..=314 => 270,
        _ => 0,
    }
}

fn even(value: usize) -> usize {
    value.max(2) & !1
}

fn decode_dimensions(
    width: usize,
    height: usize,
    max_width: usize,
    max_height: usize,
) -> (usize, usize) {
    let width_scale = max_width.max(2) as f64 / width.max(1) as f64;
    let height_scale = max_height.max(2) as f64 / height.max(1) as f64;
    let scale = width_scale.min(height_scale).min(1.0);
    (
        even((width as f64 * scale).round() as usize),
        even((height as f64 * scale).round() as usize),
    )
}

#[cfg(test)]
mod tests {
    use std::{fs, process::Command};

    use super::{decode_dimensions, VideoAsset};

    #[test]
    fn constrains_both_dimensions_for_portrait_playback() {
        let (width, height) = decode_dimensions(1080, 1920, 1920, 1080);
        assert!(width <= 1920);
        assert!(height <= 1080);
        assert!((width as f64 / height as f64 - 1080.0 / 1920.0).abs() < 0.01);
    }

    #[test]
    fn probes_portrait_video_without_launching_ffprobe() {
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let path = std::env::temp_dir().join(format!(
            "kuro-portrait-probe-test-{}.mkv",
            std::process::id()
        ));
        let generated = Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=360x640:rate=30",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000",
                "-t",
                "0.4",
                "-c:v",
                "ffv1",
                "-c:a",
                "pcm_s16le",
            ])
            .arg(&path)
            .status()
            .expect("test video should be generated");
        assert!(generated.success());

        let asset = VideoAsset::load(path.clone()).expect("test video should be probed");
        assert_eq!((asset.source_width, asset.source_height), (360, 640));
        assert!(asset.aspect_ratio() < 1.0);
        assert!(asset.has_audio);
        assert!((asset.fps - 30.0).abs() < 0.01);

        let _ = fs::remove_file(path);
    }
}
