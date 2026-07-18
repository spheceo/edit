use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    io::Write,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver},
        Arc,
    },
    thread,
};

use eframe::egui::Context;
use ffmpeg_next as ffmpeg;

use crate::media::{initialize_ffmpeg, rational_value};

const WAVEFORM_BINS: usize = 8_192;
const MAX_WAVEFORM_SAMPLE_RATE: u32 = 8_000;
const MIN_WAVEFORM_SAMPLE_RATE: u32 = 50;
const SAMPLES_PER_BIN: f64 = 24.0;
const CACHE_MAGIC: &[u8; 9] = b"KUROWAVE1";

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

    pub fn max_peak(&self) -> f32 {
        self.peaks.iter().copied().fold(0.0, f32::max)
    }
}

pub struct WaveformGenerator {
    receiver: Option<Receiver<Result<Waveform, String>>>,
    generation: Arc<AtomicU64>,
    playback_active: Arc<AtomicBool>,
}

impl WaveformGenerator {
    pub fn new() -> Self {
        Self {
            receiver: None,
            generation: Arc::new(AtomicU64::new(0)),
            playback_active: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn request(&mut self, path: &Path, duration: f64, ctx: Context) {
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let current_generation = Arc::clone(&self.generation);
        let playback_active = Arc::clone(&self.playback_active);
        let path = path.to_path_buf();
        let (sender, receiver) = mpsc::channel();
        self.receiver = Some(receiver);
        thread::spawn(move || {
            let result = load_cached_waveform(&path, duration)
                .or_else(|| {
                    let result = decode_waveform(
                        &path,
                        duration,
                        || current_generation.load(Ordering::Acquire) != generation,
                        || playback_active.load(Ordering::Acquire),
                    );
                    if let Ok(waveform) = &result {
                        let _ = save_cached_waveform(&path, waveform);
                    }
                    Some(result)
                })
                .expect("waveform decode always produces a result");
            if current_generation.load(Ordering::Acquire) == generation {
                let _ = sender.send(result);
                ctx.request_repaint();
            }
        });
    }

    pub fn poll(&mut self) -> Option<Result<Waveform, String>> {
        self.receiver.as_ref()?.try_recv().ok()
    }

    pub fn set_playback_active(&self, active: bool) {
        self.playback_active.store(active, Ordering::Release);
    }
}

fn decode_waveform<C, P>(
    path: &Path,
    duration: f64,
    mut cancelled: C,
    mut playback_active: P,
) -> Result<Waveform, String>
where
    C: FnMut() -> bool,
    P: FnMut() -> bool,
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
    let sample_rate = waveform_sample_rate(duration, bin_count);
    let mut peaks = vec![0.0_f32; bin_count];
    let mut fallback_sample = 0_u64;

    for (stream, packet) in input.packets() {
        if cancelled() {
            return Err("waveform generation was cancelled".to_owned());
        }
        while playback_active() {
            if cancelled() {
                return Err("waveform generation was cancelled".to_owned());
            }
            thread::sleep(std::time::Duration::from_millis(12));
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
            sample_rate,
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
        sample_rate,
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
    sample_rate: u32,
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
                    sample_rate,
                )
                .map_err(|error| format!("could not create waveform resampler: {error}"))?,
            );
        }
        let resampler = resampler
            .as_mut()
            .ok_or_else(|| "waveform resampler was not initialized".to_owned())?;
        let capacity = ((decoded.samples() as u64 * sample_rate as u64)
            / decoded.rate().max(1) as u64) as usize
            + 256;
        let mut converted = ffmpeg::frame::Audio::new(
            ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
            capacity,
            output_layout,
        );
        converted.set_rate(sample_rate);
        resampler
            .run(&decoded, &mut converted)
            .map_err(|error| format!("waveform conversion failed: {error}"))?;

        let start_time = decoded
            .timestamp()
            .map(|timestamp| timestamp as f64 * time_base)
            .unwrap_or(*fallback_sample as f64 / sample_rate as f64);
        let bytes = converted.data(0);
        let available = converted.samples().min(bytes.len() / 4);
        for (index, sample) in bytes[..available * 4].chunks_exact(4).enumerate() {
            let time = start_time + index as f64 / sample_rate as f64;
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

fn waveform_sample_rate(duration: f64, bin_count: usize) -> u32 {
    (((bin_count as f64 * SAMPLES_PER_BIN) / duration.max(0.001)).ceil() as u32)
        .clamp(MIN_WAVEFORM_SAMPLE_RATE, MAX_WAVEFORM_SAMPLE_RATE)
}

fn waveform_cache_path(path: &Path) -> Option<std::path::PathBuf> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified.as_secs().hash(&mut hasher);
    modified.subsec_nanos().hash(&mut hasher);
    let directory = crate::project::default_project_directory().join(".waveform-cache");
    Some(directory.join(format!("{:016x}.waveform", hasher.finish())))
}

fn load_cached_waveform(path: &Path, duration: f64) -> Option<Result<Waveform, String>> {
    let cache = waveform_cache_path(path)?;
    let bytes = fs::read(cache).ok()?;
    if bytes.len() < CACHE_MAGIC.len() + 12 || &bytes[..CACHE_MAGIC.len()] != CACHE_MAGIC {
        return None;
    }
    let mut offset = CACHE_MAGIC.len();
    let cached_duration = f64::from_le_bytes(bytes[offset..offset + 8].try_into().ok()?);
    offset += 8;
    let count = u32::from_le_bytes(bytes[offset..offset + 4].try_into().ok()?) as usize;
    offset += 4;
    if count == 0
        || count > WAVEFORM_BINS
        || bytes.len() != offset + count * 4
        || (cached_duration - duration).abs() > 0.01
    {
        return None;
    }
    let peaks = bytes[offset..]
        .chunks_exact(4)
        .map(|sample| f32::from_le_bytes(sample.try_into().expect("four-byte chunk")))
        .collect();
    Some(Ok(Waveform {
        peaks,
        duration: cached_duration,
    }))
}

fn save_cached_waveform(path: &Path, waveform: &Waveform) -> Result<(), String> {
    let cache =
        waveform_cache_path(path).ok_or_else(|| "media metadata is unavailable".to_owned())?;
    let directory = cache
        .parent()
        .ok_or_else(|| "waveform cache path is invalid".to_owned())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("could not create waveform cache: {error}"))?;
    let mut bytes = Vec::with_capacity(CACHE_MAGIC.len() + 12 + waveform.peaks.len() * 4);
    bytes.extend_from_slice(CACHE_MAGIC);
    bytes.extend_from_slice(&waveform.duration.to_le_bytes());
    bytes.extend_from_slice(&(waveform.peaks.len() as u32).to_le_bytes());
    for peak in &waveform.peaks {
        bytes.extend_from_slice(&peak.to_le_bytes());
    }
    let temporary = cache.with_extension("waveform.tmp");
    let mut file = fs::File::create(&temporary)
        .map_err(|error| format!("could not create waveform cache: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("could not write waveform cache: {error}"))?;
    fs::rename(&temporary, &cache)
        .map_err(|error| format!("could not finish waveform cache: {error}"))
}

#[cfg(test)]
mod tests {
    use std::{fs, process::Command};

    use super::{decode_waveform, waveform_sample_rate};

    #[test]
    fn long_waveforms_use_bounded_sampling_work() {
        assert_eq!(waveform_sample_rate(6.0 * 60.0 * 60.0, 8_192), 50);
        assert_eq!(waveform_sample_rate(0.25, 64), 6_144);
    }

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

        let waveform = decode_waveform(&path, 0.25, || false, || false)
            .expect("waveform should decode in process");
        assert!(waveform.peaks.iter().any(|peak| *peak > 0.01));
        assert!(waveform.peak_at(0.1) > 0.01);
        let _ = fs::remove_file(path);
    }
}
