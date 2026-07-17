use std::{
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver},
        Arc,
    },
    thread,
};

use eframe::egui::Context;
use ffmpeg_next as ffmpeg;

use crate::media::{initialize_ffmpeg, rational_value};

const WAVEFORM_BINS: usize = 8_192;
const WAVEFORM_SAMPLE_RATE: u32 = 8_000;

pub struct Waveform {
    peaks: Vec<f32>,
    duration: f64,
}

impl Waveform {
    pub fn peak_at(&self, time: f64) -> f32 {
        if self.peaks.is_empty() || self.duration <= 0.0 {
            return 0.0;
        }
        let index = ((time.clamp(0.0, self.duration) / self.duration)
            * (self.peaks.len() - 1) as f64)
            .round() as usize;
        self.peaks[index]
    }
}

pub struct WaveformGenerator {
    receiver: Option<Receiver<Result<Waveform, String>>>,
    generation: Arc<AtomicU64>,
}

impl WaveformGenerator {
    pub fn new() -> Self {
        Self {
            receiver: None,
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn request(&mut self, path: &Path, duration: f64, ctx: Context) {
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let current_generation = Arc::clone(&self.generation);
        let path = path.to_path_buf();
        let (sender, receiver) = mpsc::channel();
        self.receiver = Some(receiver);
        thread::spawn(move || {
            let result = decode_waveform(&path, duration, || {
                current_generation.load(Ordering::Acquire) != generation
            });
            if current_generation.load(Ordering::Acquire) == generation {
                let _ = sender.send(result);
                ctx.request_repaint();
            }
        });
    }

    pub fn poll(&mut self) -> Option<Result<Waveform, String>> {
        self.receiver.as_ref()?.try_recv().ok()
    }
}

fn decode_waveform<C>(path: &Path, duration: f64, mut cancelled: C) -> Result<Waveform, String>
where
    C: FnMut() -> bool,
{
    initialize_ffmpeg()?;
    let mut input = ffmpeg::format::input(path)
        .map_err(|error| format!("could not open waveform input: {error}"))?;
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .ok_or_else(|| "no audio stream was found".to_owned())?;
    let stream_index = stream.index();
    let time_base = rational_value(stream.time_base());
    let context = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
        .map_err(|error| format!("could not configure waveform decoder: {error}"))?;
    let mut decoder = context
        .decoder()
        .audio()
        .map_err(|error| format!("could not open waveform decoder: {error}"))?;
    decoder.set_packet_time_base(stream.time_base());
    let output_layout = ffmpeg::ChannelLayout::default(1);
    let mut resampler = None;
    let bin_count = (duration * 120.0).ceil().clamp(64.0, WAVEFORM_BINS as f64) as usize;
    let mut peaks = vec![0.0_f32; bin_count];
    let mut fallback_sample = 0_u64;

    for (stream, packet) in input.packets() {
        if cancelled() {
            return Err("waveform generation was cancelled".to_owned());
        }
        if stream.index() != stream_index {
            continue;
        }
        decoder
            .send_packet(&packet)
            .map_err(|error| format!("waveform packet failed: {error}"))?;
        drain_audio_peaks(
            &mut decoder,
            &mut resampler,
            output_layout,
            time_base,
            duration,
            &mut fallback_sample,
            &mut peaks,
            &mut cancelled,
        )?;
    }
    let _ = decoder.send_eof();
    drain_audio_peaks(
        &mut decoder,
        &mut resampler,
        output_layout,
        time_base,
        duration,
        &mut fallback_sample,
        &mut peaks,
        &mut cancelled,
    )?;
    Ok(Waveform { peaks, duration })
}

#[allow(clippy::too_many_arguments)]
fn drain_audio_peaks<C>(
    decoder: &mut ffmpeg::decoder::Audio,
    resampler: &mut Option<ffmpeg::software::resampling::Context>,
    output_layout: ffmpeg::ChannelLayout,
    time_base: f64,
    duration: f64,
    fallback_sample: &mut u64,
    peaks: &mut [f32],
    cancelled: &mut C,
) -> Result<(), String>
where
    C: FnMut() -> bool,
{
    let mut decoded = ffmpeg::frame::Audio::empty();
    while decoder.receive_frame(&mut decoded).is_ok() {
        if cancelled() {
            return Err("waveform generation was cancelled".to_owned());
        }
        let input_layout = if decoded.channel_layout().is_empty() {
            ffmpeg::ChannelLayout::default(decoded.channels() as i32)
        } else {
            decoded.channel_layout()
        };
        if decoded.channel_layout().is_empty() {
            decoded.set_channel_layout(input_layout);
        }
        let changed = resampler.as_ref().is_none_or(|context| {
            context.input().format != decoded.format()
                || context.input().channel_layout != input_layout
                || context.input().rate != decoded.rate()
        });
        if changed {
            *resampler = Some(
                ffmpeg::software::resampling::Context::get(
                    decoded.format(),
                    input_layout,
                    decoded.rate(),
                    ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
                    output_layout,
                    WAVEFORM_SAMPLE_RATE,
                )
                .map_err(|error| format!("could not create waveform resampler: {error}"))?,
            );
        }
        let resampler = resampler
            .as_mut()
            .ok_or_else(|| "waveform resampler was not initialized".to_owned())?;
        let capacity = ((decoded.samples() as u64 * WAVEFORM_SAMPLE_RATE as u64)
            / decoded.rate().max(1) as u64) as usize
            + 256;
        let mut converted = ffmpeg::frame::Audio::new(
            ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
            capacity,
            output_layout,
        );
        converted.set_rate(WAVEFORM_SAMPLE_RATE);
        resampler
            .run(&decoded, &mut converted)
            .map_err(|error| format!("waveform conversion failed: {error}"))?;

        let start_time = decoded
            .timestamp()
            .map(|timestamp| timestamp as f64 * time_base)
            .unwrap_or(*fallback_sample as f64 / WAVEFORM_SAMPLE_RATE as f64);
        let bytes = converted.data(0);
        let available = converted.samples().min(bytes.len() / 4);
        for (index, sample) in bytes[..available * 4].chunks_exact(4).enumerate() {
            let time = start_time + index as f64 / WAVEFORM_SAMPLE_RATE as f64;
            let bin = ((time / duration.max(f64::EPSILON)) * peaks.len() as f64) as usize;
            if let Some(peak) = peaks.get_mut(bin) {
                let value = f32::from_ne_bytes([sample[0], sample[1], sample[2], sample[3]]).abs();
                *peak = peak.max(value.min(1.0));
            }
        }
        *fallback_sample += available as u64;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{fs, process::Command};

    use super::decode_waveform;

    #[test]
    fn decodes_real_waveform_peaks_in_process() {
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let path =
            std::env::temp_dir().join(format!("kuro-waveform-test-{}.m4a", std::process::id()));
        let generated = Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000",
                "-t",
                "0.25",
                "-c:a",
                "aac",
            ])
            .arg(&path)
            .status()
            .expect("test audio should be generated");
        assert!(generated.success());

        let waveform =
            decode_waveform(&path, 0.25, || false).expect("waveform should decode in process");
        assert!(waveform.peaks.iter().any(|peak| *peak > 0.01));
        assert!(waveform.peak_at(0.1) > 0.01);
        let _ = fs::remove_file(path);
    }
}
