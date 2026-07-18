use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig, I24, U24,
};
use ffmpeg_next as ffmpeg;

use crate::{
    media::{initialize_ffmpeg, rational_value},
    project::{sequence::MediaId, Sequence},
};

const MAX_BUFFER_SECONDS: usize = 3;
const PREBUFFER_FRAMES: usize = 2_048;

pub struct SequenceAudioOutput {
    _stream: Stream,
    stop: Arc<AtomicBool>,
    played_frames: Arc<AtomicU64>,
    start_time: f64,
    duration: f64,
    sample_rate: u32,
}

impl SequenceAudioOutput {
    pub fn prepare_sources(
        sources: HashMap<MediaId, PathBuf>,
        sequence: &Sequence,
        at: f64,
    ) -> Result<Self, String> {
        initialize_ffmpeg()?;
        if let Some(path) = sources.values().find(|path| !path.is_file()) {
            return Err(format!(
                "The source media is unavailable: {}",
                path.display()
            ));
        }
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| "No audio output device is available.".to_owned())?;
        let supported = device
            .default_output_config()
            .map_err(|error| format!("Kuro could not configure audio output: {error}"))?;
        let sample_format = supported.sample_format();
        let config: StreamConfig = supported.into();
        let sample_rate = config.sample_rate;
        let channels = config.channels as usize;
        let queue = Arc::new(Mutex::new(VecDeque::<f32>::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let decode_finished = Arc::new(AtomicBool::new(false));
        let played_frames = Arc::new(AtomicU64::new(0));

        let decode_queue = Arc::clone(&queue);
        let decode_stop = Arc::clone(&stop);
        let worker_finished = Arc::clone(&decode_finished);
        let sequence = sequence.clone();
        let sequence_duration = sequence.duration;
        let start_time = at.clamp(0.0, sequence.duration);
        thread::spawn(move || {
            if let Err(error) = decode_sequence_audio(
                sources,
                &sequence,
                start_time,
                sample_rate,
                channels,
                decode_queue,
                Arc::clone(&decode_stop),
            ) {
                eprintln!("Kuro sequence audio decoder stopped: {error}");
            }
            worker_finished.store(true, Ordering::Release);
        });

        let stream = build_output_stream(
            &device,
            &config,
            sample_format,
            Arc::clone(&queue),
            Arc::clone(&played_frames),
            channels,
        )?;
        for _ in 0..100 {
            if queue.lock().map_or(0, |samples| samples.len()) >= channels * PREBUFFER_FRAMES
                || decode_finished.load(Ordering::Acquire)
            {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        Ok(Self {
            _stream: stream,
            stop,
            played_frames,
            start_time,
            duration: sequence_duration,
            sample_rate,
        })
    }

    pub fn play(&self) -> Result<(), String> {
        self._stream
            .play()
            .map_err(|error| format!("Kuro could not start audio playback: {error}"))
    }

    pub fn timeline_time(&self) -> f64 {
        let elapsed =
            self.played_frames.load(Ordering::Acquire) as f64 / self.sample_rate.max(1) as f64;
        (self.start_time + elapsed).min(self.duration)
    }
}

impl Drop for SequenceAudioOutput {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}

fn build_output_stream(
    device: &Device,
    config: &StreamConfig,
    format: SampleFormat,
    queue: Arc<Mutex<VecDeque<f32>>>,
    played_frames: Arc<AtomicU64>,
    channels: usize,
) -> Result<Stream, String> {
    match format {
        SampleFormat::I8 => {
            build_typed_stream::<i8>(device, config, queue, played_frames, channels)
        }
        SampleFormat::I16 => {
            build_typed_stream::<i16>(device, config, queue, played_frames, channels)
        }
        SampleFormat::I24 => {
            build_typed_stream::<I24>(device, config, queue, played_frames, channels)
        }
        SampleFormat::I32 => {
            build_typed_stream::<i32>(device, config, queue, played_frames, channels)
        }
        SampleFormat::I64 => {
            build_typed_stream::<i64>(device, config, queue, played_frames, channels)
        }
        SampleFormat::U8 => {
            build_typed_stream::<u8>(device, config, queue, played_frames, channels)
        }
        SampleFormat::U16 => {
            build_typed_stream::<u16>(device, config, queue, played_frames, channels)
        }
        SampleFormat::U24 => {
            build_typed_stream::<U24>(device, config, queue, played_frames, channels)
        }
        SampleFormat::U32 => {
            build_typed_stream::<u32>(device, config, queue, played_frames, channels)
        }
        SampleFormat::U64 => {
            build_typed_stream::<u64>(device, config, queue, played_frames, channels)
        }
        SampleFormat::F32 => {
            build_typed_stream::<f32>(device, config, queue, played_frames, channels)
        }
        SampleFormat::F64 => {
            build_typed_stream::<f64>(device, config, queue, played_frames, channels)
        }
        other => Err(format!(
            "The audio device uses an unsupported sample format: {other}"
        )),
    }
}

fn build_typed_stream<T>(
    device: &Device,
    config: &StreamConfig,
    queue: Arc<Mutex<VecDeque<f32>>>,
    played_frames: Arc<AtomicU64>,
    channels: usize,
) -> Result<Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    device
        .build_output_stream(
            *config,
            move |output: &mut [T], _| {
                write_audio(output, &queue);
                played_frames.fetch_add((output.len() / channels.max(1)) as u64, Ordering::Release);
            },
            |error| eprintln!("Kuro audio output error: {error}"),
            None,
        )
        .map_err(|error| format!("Kuro could not create an audio stream: {error}"))
}

fn write_audio<T>(output: &mut [T], queue: &Mutex<VecDeque<f32>>)
where
    T: Sample + FromSample<f32>,
{
    let Ok(mut queue) = queue.lock() else {
        output.fill(T::from_sample(0.0));
        return;
    };
    for sample in output {
        *sample = T::from_sample(queue.pop_front().unwrap_or(0.0));
    }
}

fn decode_sequence_audio(
    sources: HashMap<MediaId, PathBuf>,
    sequence: &Sequence,
    at: f64,
    output_rate: u32,
    output_channels: usize,
    queue: Arc<Mutex<VecDeque<f32>>>,
    stop: Arc<AtomicBool>,
) -> Result<(), String> {
    let mut cursor = at.clamp(0.0, sequence.duration);
    for clip in &sequence.clips {
        if clip.timeline_end <= cursor {
            continue;
        }
        if stop.load(Ordering::Acquire) {
            return Ok(());
        }
        if clip.timeline_start > cursor {
            push_silence(
                clip.timeline_start - cursor,
                output_rate,
                output_channels,
                &queue,
                &stop,
            )?;
            cursor = clip.timeline_start;
        }
        let timeline_start = cursor.max(clip.timeline_start);
        let timeline_end = clip.timeline_end;
        if timeline_end <= timeline_start {
            continue;
        }
        let source_start = clip.source_in + (timeline_start - clip.timeline_start);
        let source_end = clip.source_out;
        let expected_samples =
            duration_samples(timeline_end - timeline_start, output_rate, output_channels);
        let gain = clip.audio.linear_gain();
        let written = if let Some(path) = sources.get(&clip.media_id) {
            decode_audio_segment(
                path.clone(),
                source_start,
                source_end,
                expected_samples,
                output_rate,
                output_channels,
                gain,
                Arc::clone(&queue),
                Arc::clone(&stop),
            )
            .unwrap_or(0)
        } else {
            0
        };
        if written < expected_samples {
            push_silence_samples(
                expected_samples - written,
                &queue,
                &stop,
                output_rate,
                output_channels,
            )?;
        }
        cursor = timeline_end;
    }
    if cursor < sequence.duration {
        push_silence(
            sequence.duration - cursor,
            output_rate,
            output_channels,
            &queue,
            &stop,
        )?;
    }
    Ok(())
}

fn push_silence(
    duration: f64,
    output_rate: u32,
    output_channels: usize,
    queue: &Mutex<VecDeque<f32>>,
    stop: &AtomicBool,
) -> Result<(), String> {
    push_silence_samples(
        duration_samples(duration, output_rate, output_channels),
        queue,
        stop,
        output_rate,
        output_channels,
    )
}

fn push_silence_samples(
    mut remaining: usize,
    queue: &Mutex<VecDeque<f32>>,
    stop: &AtomicBool,
    output_rate: u32,
    output_channels: usize,
) -> Result<(), String> {
    while remaining > 0 {
        wait_for_queue_capacity(queue, stop, output_rate, output_channels)?;
        if stop.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut samples = queue
            .lock()
            .map_err(|_| "audio queue was interrupted".to_owned())?;
        let capacity = output_rate as usize * output_channels * MAX_BUFFER_SECONDS;
        let count = remaining.min(capacity.saturating_sub(samples.len()).max(1));
        samples.extend(std::iter::repeat_n(0.0, count));
        remaining -= count;
    }
    Ok(())
}

fn duration_samples(duration: f64, output_rate: u32, output_channels: usize) -> usize {
    (duration.max(0.0) * output_rate as f64).round() as usize * output_channels
}

#[cfg(test)]
fn decode_audio(
    path: PathBuf,
    at: f64,
    output_rate: u32,
    output_channels: usize,
    queue: Arc<Mutex<VecDeque<f32>>>,
    stop: Arc<AtomicBool>,
) -> Result<(), String> {
    decode_audio_segment(
        path,
        at,
        f64::INFINITY,
        usize::MAX,
        output_rate,
        output_channels,
        1.0,
        queue,
        stop,
    )
    .map(|_| ())
}

#[allow(clippy::too_many_arguments)]
fn decode_audio_segment(
    path: PathBuf,
    at: f64,
    end: f64,
    max_samples: usize,
    output_rate: u32,
    output_channels: usize,
    gain: f32,
    queue: Arc<Mutex<VecDeque<f32>>>,
    stop: Arc<AtomicBool>,
) -> Result<usize, String> {
    let mut input = ffmpeg::format::input(&path)
        .map_err(|error| format!("could not open audio input: {error}"))?;
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .ok_or_else(|| "no audio stream was found".to_owned())?;
    let stream_index = stream.index();
    let time_base = rational_value(stream.time_base());
    let context = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
        .map_err(|error| format!("could not configure audio decoder: {error}"))?;
    let mut decoder = context
        .decoder()
        .audio()
        .map_err(|error| format!("could not open audio decoder: {error}"))?;
    decoder.set_packet_time_base(stream.time_base());
    let output_layout = ffmpeg::ChannelLayout::default(output_channels as i32);
    let mut resampler = None;

    if at > 0.0 {
        let target = (at * 1_000_000.0).round() as i64;
        input
            .seek(target, ..target)
            .map_err(|error| format!("audio seek failed: {error}"))?;
        decoder.flush();
    }

    let mut written = 0;
    for (stream, packet) in input.packets() {
        if stop.load(Ordering::Acquire) {
            break;
        }
        if stream.index() != stream_index {
            continue;
        }
        decoder
            .send_packet(&packet)
            .map_err(|error| format!("audio packet failed: {error}"))?;
        written += drain_audio_frames(
            &mut decoder,
            &mut resampler,
            output_layout,
            time_base,
            at,
            end,
            max_samples.saturating_sub(written),
            output_rate,
            output_channels,
            gain,
            &queue,
            &stop,
        )?;
        if written >= max_samples {
            break;
        }
    }
    if written < max_samples {
        let _ = decoder.send_eof();
        written += drain_audio_frames(
            &mut decoder,
            &mut resampler,
            output_layout,
            time_base,
            at,
            end,
            max_samples.saturating_sub(written),
            output_rate,
            output_channels,
            gain,
            &queue,
            &stop,
        )?;
    }
    Ok(written)
}

#[allow(clippy::too_many_arguments)]
fn drain_audio_frames(
    decoder: &mut ffmpeg::decoder::Audio,
    resampler: &mut Option<ffmpeg::software::resampling::Context>,
    output_layout: ffmpeg::ChannelLayout,
    time_base: f64,
    requested_start: f64,
    requested_end: f64,
    max_samples: usize,
    output_rate: u32,
    output_channels: usize,
    gain: f32,
    queue: &Mutex<VecDeque<f32>>,
    stop: &AtomicBool,
) -> Result<usize, String> {
    let mut written = 0;
    let mut decoded = ffmpeg::frame::Audio::empty();
    while decoder.receive_frame(&mut decoded).is_ok() {
        if stop.load(Ordering::Acquire) {
            return Ok(written);
        }
        let frame_time = decoded.timestamp().map(|pts| pts as f64 * time_base);
        let input_layout = if decoded.channel_layout().is_empty() {
            ffmpeg::ChannelLayout::default(decoded.channels() as i32)
        } else {
            decoded.channel_layout()
        };
        if decoded.channel_layout().is_empty() {
            decoded.set_channel_layout(input_layout);
        }
        let input_changed = resampler.as_ref().is_none_or(|context| {
            context.input().format != decoded.format()
                || context.input().channel_layout != input_layout
                || context.input().rate != decoded.rate()
        });
        if input_changed {
            *resampler = Some(
                ffmpeg::software::resampling::Context::get(
                    decoded.format(),
                    input_layout,
                    decoded.rate(),
                    ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
                    output_layout,
                    output_rate,
                )
                .map_err(|error| format!("could not create audio resampler: {error}"))?,
            );
        }
        let resampler = resampler
            .as_mut()
            .ok_or_else(|| "audio resampler was not initialized".to_owned())?;
        let output_definition = *resampler.output();
        let output_capacity = ((decoded.samples() as u64 * output_rate as u64)
            / decoded.rate().max(1) as u64) as usize
            + 256;
        let mut converted = ffmpeg::frame::Audio::new(
            output_definition.format,
            output_capacity,
            output_definition.channel_layout,
        );
        converted.set_rate(output_rate);
        resampler
            .run(&decoded, &mut converted)
            .map_err(|error| {
                format!(
                    "audio conversion failed: {error:?} (frame: {:?}, {:?}, {} Hz; expected: {:?}, {:?}, {} Hz)",
                    decoded.format(),
                    decoded.channel_layout(),
                    decoded.rate(),
                    resampler.input().format,
                    resampler.input().channel_layout,
                    resampler.input().rate
                )
            })?;
        let sample_count = converted.samples() * output_channels;
        let bytes = converted.data(0);
        let available = sample_count.min(bytes.len() / 4);
        let skip_frames = frame_time
            .map(|time| ((requested_start - time).max(0.0) * output_rate as f64).round() as usize)
            .unwrap_or(0)
            .min(available / output_channels);
        let take_frames = frame_time
            .filter(|_| requested_end.is_finite())
            .map(|time| ((requested_end - time).max(0.0) * output_rate as f64).round() as usize)
            .unwrap_or(available / output_channels)
            .min(available / output_channels)
            .saturating_sub(skip_frames);
        let skip = skip_frames * output_channels;
        let take = (take_frames * output_channels).min(max_samples.saturating_sub(written));
        if take == 0 {
            continue;
        }

        wait_for_queue_capacity(queue, stop, output_rate, output_channels)?;
        if stop.load(Ordering::Acquire) {
            return Ok(written);
        }
        let mut samples = queue
            .lock()
            .map_err(|_| "audio queue was interrupted".to_owned())?;
        for chunk in bytes[..available * 4].chunks_exact(4).skip(skip).take(take) {
            let sample = f32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) * gain;
            samples.push_back(sample);
        }
        written += take;
        if written >= max_samples {
            break;
        }
    }
    Ok(written)
}

fn wait_for_queue_capacity(
    queue: &Mutex<VecDeque<f32>>,
    stop: &AtomicBool,
    output_rate: u32,
    output_channels: usize,
) -> Result<(), String> {
    let capacity = output_rate as usize * output_channels * MAX_BUFFER_SECONDS;
    while queue.lock().map_or(0, |samples| samples.len()) >= capacity {
        if stop.load(Ordering::Acquire) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(4));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        fs,
        process::Command,
        sync::{atomic::AtomicBool, Arc, Mutex},
    };

    use super::{decode_audio, decode_sequence_audio};
    use crate::project::Sequence;

    #[test]
    fn decodes_and_resamples_audio_in_process() {
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let path = std::env::temp_dir().join(format!("kuro-audio-test-{}.m4a", std::process::id()));
        let generated = Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=44100",
                "-t",
                "0.25",
                "-c:a",
                "aac",
            ])
            .arg(&path)
            .status()
            .expect("test audio should be generated");
        assert!(generated.success());

        let queue = Arc::new(Mutex::new(VecDeque::new()));
        decode_audio(
            path.clone(),
            0.0,
            48_000,
            2,
            Arc::clone(&queue),
            Arc::new(AtomicBool::new(false)),
        )
        .expect("audio should decode and resample");
        let samples = queue.lock().expect("audio queue should be readable");
        assert!(samples.len() > 20_000);
        assert!(samples.iter().any(|sample| sample.abs() > 0.01));

        drop(samples);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn sequence_audio_inserts_exact_silence_for_timeline_gaps() {
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let path = std::env::temp_dir().join(format!(
            "kuro-sequence-audio-test-{}.m4a",
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
                "sine=frequency=440:sample_rate=48000",
                "-t",
                "0.6",
                "-c:a",
                "aac",
            ])
            .arg(&path)
            .status()
            .expect("test audio should be generated");
        assert!(generated.success());

        let mut sequence = Sequence::new(0.6);
        let middle = sequence.split_at(0.2, 30.0).expect("first cut");
        sequence.split_at(0.4, 30.0).expect("second cut");
        sequence.delete(middle);
        let queue = Arc::new(Mutex::new(VecDeque::new()));
        decode_sequence_audio(
            std::iter::once((1, path.clone())).collect(),
            &sequence,
            0.0,
            48_000,
            2,
            Arc::clone(&queue),
            Arc::new(AtomicBool::new(false)),
        )
        .expect("edited sequence audio should decode");
        let samples = queue.lock().expect("audio queue should be readable");
        assert_eq!(samples.len(), 57_600);
        assert!(samples
            .iter()
            .take(19_200)
            .any(|sample| sample.abs() > 0.01));
        assert!(samples
            .iter()
            .skip(19_200)
            .take(19_200)
            .all(|sample| *sample == 0.0));
        assert!(samples
            .iter()
            .skip(38_400)
            .any(|sample| sample.abs() > 0.01));

        drop(samples);
        let gap_start_queue = Arc::new(Mutex::new(VecDeque::new()));
        decode_sequence_audio(
            std::iter::once((1, path.clone())).collect(),
            &sequence,
            0.3,
            48_000,
            2,
            Arc::clone(&gap_start_queue),
            Arc::new(AtomicBool::new(false)),
        )
        .expect("audio should also render when playback starts inside a gap");
        let gap_start_samples = gap_start_queue
            .lock()
            .expect("gap-start queue should be readable");
        assert_eq!(gap_start_samples.len(), 28_800);
        assert!(gap_start_samples
            .iter()
            .take(9_600)
            .all(|sample| *sample == 0.0));
        assert!(gap_start_samples
            .iter()
            .skip(9_600)
            .any(|sample| sample.abs() > 0.01));

        drop(gap_start_samples);
        let _ = fs::remove_file(path);
    }
}
