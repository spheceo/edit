use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc, Arc,
    },
    thread,
};

use eframe::egui;
use ffmpeg::{Rational, Rescale};
use ffmpeg_next as ffmpeg;
use serde::{Deserialize, Serialize};

use crate::{
    media::{rational_value, VideoAsset},
    project::{
        sequence::{ClipLane, MediaId, SequenceClip},
        Sequence,
    },
};

const AUDIO_RATE: u32 = 48_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ExportResolution {
    Sequence,
    Source,
    Hd1080,
    Hd720,
}

impl ExportResolution {
    pub const ALL: [Self; 4] = [Self::Sequence, Self::Source, Self::Hd1080, Self::Hd720];

    pub fn label(self) -> &'static str {
        match self {
            Self::Sequence => "Project resolution",
            Self::Source => "Source resolution",
            Self::Hd1080 => "Fit within 1080p",
            Self::Hd720 => "Fit within 720p",
        }
    }

    pub fn dimensions(self, video: &VideoAsset, format: SequenceFormat) -> (u32, u32) {
        match self {
            Self::Sequence => (even(format.width), even(format.height)),
            Self::Source => (even(video.source_width), even(video.source_height)),
            Self::Hd1080 => fit_inside(video, 1920, 1080),
            Self::Hd720 => fit_inside(video, 1280, 720),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct SequenceFormat {
    pub width: usize,
    pub height: usize,
    pub frame_rate: f64,
}

impl SequenceFormat {
    #[cfg(test)]
    fn from_video(video: &VideoAsset) -> Self {
        Self {
            width: video.source_width,
            height: video.source_height,
            frame_rate: video.fps,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ExportQuality {
    High,
    Balanced,
    Compact,
}

impl ExportQuality {
    pub const ALL: [Self; 3] = [Self::High, Self::Balanced, Self::Compact];

    pub fn label(self) -> &'static str {
        match self {
            Self::High => "High quality",
            Self::Balanced => "Balanced",
            Self::Compact => "Smaller file",
        }
    }

    fn bits_per_pixel(self) -> f64 {
        match self {
            Self::High => 0.13,
            Self::Balanced => 0.085,
            Self::Compact => 0.052,
        }
    }

    fn audio_bitrate(self) -> usize {
        match self {
            Self::High => 256_000,
            Self::Balanced => 192_000,
            Self::Compact => 128_000,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ExportSettings {
    pub resolution: ExportResolution,
    pub quality: ExportQuality,
    pub include_audio: bool,
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self {
            resolution: ExportResolution::Sequence,
            quality: ExportQuality::High,
            include_audio: true,
        }
    }
}

pub enum ExportResult {
    Finished(PathBuf),
    Cancelled,
    Failed(String),
}

pub struct ExportJob {
    progress: Arc<AtomicU32>,
    cancel: Arc<AtomicBool>,
    receiver: mpsc::Receiver<ExportResult>,
}

impl ExportJob {
    pub fn start(
        videos: Vec<(MediaId, VideoAsset)>,
        sequence: Sequence,
        settings: ExportSettings,
        format: SequenceFormat,
        destination: PathBuf,
        ctx: egui::Context,
    ) -> Self {
        let progress = Arc::new(AtomicU32::new(0));
        let cancel = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = mpsc::channel();
        let worker_progress = Arc::clone(&progress);
        let worker_cancel = Arc::clone(&cancel);
        let worker_destination = destination.clone();
        thread::spawn(move || {
            let result = render_media_sequence(
                &videos,
                &sequence,
                &settings,
                format,
                &worker_destination,
                &worker_progress,
                &worker_cancel,
            );
            let message = match result {
                Ok(()) if worker_cancel.load(Ordering::Acquire) => ExportResult::Cancelled,
                Ok(()) => ExportResult::Finished(worker_destination),
                Err(error) if error == "cancelled" => ExportResult::Cancelled,
                Err(error) => ExportResult::Failed(error),
            };
            let _ = sender.send(message);
            ctx.request_repaint();
        });
        Self {
            progress,
            cancel,
            receiver,
        }
    }

    pub fn progress(&self) -> f32 {
        self.progress.load(Ordering::Acquire) as f32 / 1_000.0
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Release);
    }

    pub fn poll(&self) -> Option<ExportResult> {
        self.receiver.try_recv().ok()
    }
}

fn render_media_sequence(
    videos: &[(MediaId, VideoAsset)],
    sequence: &Sequence,
    settings: &ExportSettings,
    format: SequenceFormat,
    destination: &PathBuf,
    progress: &AtomicU32,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let first = videos
        .first()
        .ok_or_else(|| "There is no source media to export.".to_owned())?;
    let distinct = sequence
        .clips
        .iter()
        .map(|clip| clip.media_id)
        .collect::<std::collections::HashSet<_>>();
    if distinct.len() <= 1 {
        let id = distinct.iter().next().copied().unwrap_or(first.0);
        let video = videos
            .iter()
            .find(|(media_id, _)| *media_id == id)
            .map(|(_, video)| video)
            .unwrap_or(&first.1);
        return render_sequence(
            video,
            sequence,
            settings,
            format,
            destination,
            progress,
            cancel,
        );
    }
    for media_id in &distinct {
        if !videos.iter().any(|(id, _)| id == media_id) {
            return Err(format!("Media {media_id} is offline."));
        }
    }

    let mut video_segments = Vec::new();
    let mut cursor = 0.0;
    for clip in topmost_video_segments(sequence) {
        if clip.timeline_start > cursor + 0.000_001 {
            video_segments.push((first.1.clone(), gap_sequence(clip.timeline_start - cursor)));
        }
        let video = videos
            .iter()
            .find(|(id, _)| *id == clip.media_id)
            .map(|(_, video)| video.clone())
            .ok_or_else(|| format!("Media {} is offline.", clip.media_id))?;
        let mut part = Sequence::empty();
        let mut part_clip = clip.clone();
        let duration = clip.timeline_end - clip.timeline_start;
        part_clip.lane = ClipLane::Video;
        part_clip.timeline_start = 0.0;
        part_clip.timeline_end = duration;
        part.clips.push(part_clip);
        part.duration = duration;
        video_segments.push((video, part));
        cursor = clip.timeline_end;
    }
    if cursor < sequence.duration - 0.000_001 {
        video_segments.push((first.1.clone(), gap_sequence(sequence.duration - cursor)));
    }

    let token = TEMP_EXPORT_ID.fetch_add(1, Ordering::Relaxed);
    let mut video_files = Vec::new();
    let mut segment_settings = settings.clone();
    if segment_settings.resolution == ExportResolution::Source {
        // A mixed-source sequence needs one stable encoded frame size so its
        // independently rendered pieces can be joined without re-encoding.
        segment_settings.resolution = ExportResolution::Sequence;
    }
    // Audio is rendered as its own timeline below because an unlinked audio
    // clip can come from a different source than the visible video clip.
    segment_settings.include_audio = false;
    for (index, (video, part)) in video_segments.iter().enumerate() {
        if cancel.load(Ordering::Acquire) {
            remove_files(&video_files);
            return Err("cancelled".to_owned());
        }
        let path = std::env::temp_dir().join(format!(
            "kuro-export-{}-{token}-{index}.mp4",
            std::process::id()
        ));
        let segment_progress = AtomicU32::new(0);
        if let Err(error) = render_sequence(
            video,
            part,
            &segment_settings,
            format,
            &path,
            &segment_progress,
            cancel,
        ) {
            remove_files(&video_files);
            return Err(error);
        }
        video_files.push(path);
        progress.store(
            (((index + 1) as f32 / (video_segments.len() + 1) as f32) * 700.0) as u32,
            Ordering::Release,
        );
    }

    let render_audio = settings.include_audio
        && sequence.clips.iter().any(|clip| {
            clip.lane.shows_audio()
                && videos
                    .iter()
                    .find(|(id, _)| *id == clip.media_id)
                    .is_some_and(|(_, video)| video.has_audio)
        });
    if !render_audio {
        let result = concatenate_segments(&video_files, destination, cancel);
        remove_files(&video_files);
        if result.is_ok() {
            progress.store(1_000, Ordering::Release);
        }
        return result;
    }

    let audio_fallback = videos
        .iter()
        .find(|(_, video)| video.has_audio)
        .unwrap_or(first);
    let mut audio_segments = Vec::new();
    cursor = 0.0;
    for clip in sequence.clips.iter().filter(|clip| clip.lane.shows_audio()) {
        if clip.timeline_start > cursor + 0.000_001 {
            audio_segments.push((
                audio_fallback.1.clone(),
                gap_sequence(clip.timeline_start - cursor),
            ));
        }
        let video = videos
            .iter()
            .find(|(id, _)| *id == clip.media_id)
            .map(|(_, video)| video.clone())
            .ok_or_else(|| format!("Media {} is offline.", clip.media_id))?;
        let mut part = Sequence::empty();
        let mut part_clip = clip.clone();
        let duration = clip.timeline_end - clip.timeline_start;
        part_clip.lane = ClipLane::Audio;
        part_clip.timeline_start = 0.0;
        part_clip.timeline_end = duration;
        part.clips.push(part_clip);
        part.duration = duration;
        audio_segments.push((video, part));
        cursor = clip.timeline_end;
    }
    if cursor < sequence.duration - 0.000_001 {
        audio_segments.push((
            audio_fallback.1.clone(),
            gap_sequence(sequence.duration - cursor),
        ));
    }

    let mut audio_files = Vec::new();
    let mut audio_settings = segment_settings.clone();
    audio_settings.include_audio = true;
    for (index, (video, part)) in audio_segments.iter().enumerate() {
        if cancel.load(Ordering::Acquire) {
            remove_files(&video_files);
            remove_files(&audio_files);
            return Err("cancelled".to_owned());
        }
        let path = std::env::temp_dir().join(format!(
            "kuro-export-audio-{}-{token}-{index}.mp4",
            std::process::id()
        ));
        let segment_progress = AtomicU32::new(0);
        if let Err(error) = render_sequence(
            video,
            part,
            &audio_settings,
            format,
            &path,
            &segment_progress,
            cancel,
        ) {
            remove_files(&video_files);
            remove_files(&audio_files);
            return Err(error);
        }
        audio_files.push(path);
        progress.store(
            700 + (((index + 1) as f32 / (audio_segments.len() + 1) as f32) * 200.0) as u32,
            Ordering::Release,
        );
    }

    let joined_video = std::env::temp_dir().join(format!(
        "kuro-export-video-{}-{token}.mp4",
        std::process::id()
    ));
    let joined_audio = std::env::temp_dir().join(format!(
        "kuro-export-audio-{}-{token}.mp4",
        std::process::id()
    ));
    let result = concatenate_segments(&video_files, &joined_video, cancel)
        .and_then(|()| concatenate_segments(&audio_files, &joined_audio, cancel))
        .and_then(|()| mux_video_and_audio(&joined_video, &joined_audio, destination, cancel));
    remove_files(&video_files);
    remove_files(&audio_files);
    remove_files(&[joined_video, joined_audio]);
    if result.is_ok() {
        progress.store(1_000, Ordering::Release);
    }
    result
}

static TEMP_EXPORT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn gap_sequence(duration: f64) -> Sequence {
    let mut sequence = Sequence::empty();
    sequence.duration = duration.max(0.0);
    sequence
}

/// Flatten overlapping video tracks into the picture that is actually visible:
/// the highest numbered video track wins for every interval.
fn topmost_video_segments(sequence: &Sequence) -> Vec<SequenceClip> {
    let mut edges = sequence
        .clips
        .iter()
        .filter(|clip| clip.lane.shows_video())
        .flat_map(|clip| [clip.timeline_start, clip.timeline_end])
        .collect::<Vec<_>>();
    edges.sort_by(|left, right| left.total_cmp(right));
    edges.dedup_by(|left, right| (*left - *right).abs() < 0.000_001);

    let mut segments: Vec<SequenceClip> = Vec::new();
    for window in edges.windows(2) {
        let start = window[0];
        let end = window[1];
        if end <= start + 0.000_001 {
            continue;
        }
        let Some(visible) = sequence.clip_at((start + end) * 0.5) else {
            continue;
        };
        let mut segment = visible.clone();
        segment.lane = ClipLane::Video;
        segment.timeline_start = start;
        segment.timeline_end = end;
        segment.source_in = visible.source_time(start);
        segment.source_out = visible.source_time(end);

        if let Some(previous) = segments.last_mut().filter(|previous| {
            previous.id == segment.id
                && (previous.timeline_end - segment.timeline_start).abs() < 0.000_001
                && (previous.source_out - segment.source_in).abs() < 0.000_001
        }) {
            previous.timeline_end = segment.timeline_end;
            previous.source_out = segment.source_out;
        } else {
            segments.push(segment);
        }
    }
    segments
}

fn remove_files(files: &[PathBuf]) {
    for file in files {
        let _ = std::fs::remove_file(file);
    }
}

fn concatenate_segments(
    files: &[PathBuf],
    destination: &PathBuf,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let first_path = files
        .iter()
        .max_by_key(|path| ffmpeg::format::input(path).map_or(0, |input| input.streams().count()))
        .ok_or_else(|| "Nothing was rendered.".to_owned())?;
    let first = ffmpeg::format::input(first_path)
        .map_err(|error| format!("Could not open an export segment: {error}"))?;
    let mut output = ffmpeg::format::output(destination)
        .map_err(|error| format!("Could not create the final export: {error}"))?;
    let mut output_streams = Vec::new();
    for input_stream in first.streams() {
        let medium = input_stream.parameters().medium();
        let codec = ffmpeg::encoder::find(input_stream.parameters().id())
            .ok_or_else(|| "Could not identify an export stream codec.".to_owned())?;
        let mut stream = output
            .add_stream(codec)
            .map_err(|error| format!("Could not create a final export stream: {error}"))?;
        stream.set_parameters(input_stream.parameters());
        stream.set_time_base(input_stream.time_base());
        output_streams.push((medium, stream.index()));
    }
    drop(first);
    output
        .write_header()
        .map_err(|error| format!("Could not write the final export header: {error}"))?;
    let mut elapsed = 0.0_f64;
    let mut last_dts = vec![None; output_streams.len()];
    for path in files {
        let mut input = ffmpeg::format::input(path)
            .map_err(|error| format!("Could not reopen an export segment: {error}"))?;
        let segment_duration = input.duration().max(0) as f64 / 1_000_000.0;
        for (stream, mut packet) in input.packets() {
            if cancel.load(Ordering::Acquire) {
                return Err("cancelled".to_owned());
            }
            let Some(index) = output_streams
                .iter()
                .find(|(medium, _)| *medium == stream.parameters().medium())
                .map(|(_, index)| *index)
            else {
                continue;
            };
            let output_time_base = output
                .stream(index)
                .ok_or_else(|| "A final export stream disappeared.".to_owned())?
                .time_base();
            packet.rescale_ts(stream.time_base(), output_time_base);
            let offset = (elapsed / rational_value(output_time_base)).round() as i64;
            packet.set_pts(packet.pts().map(|pts| pts + offset));
            packet.set_dts(packet.dts().map(|dts| dts + offset));
            if let (Some(previous), Some(current)) = (last_dts[index], packet.dts()) {
                if current <= previous {
                    let correction = previous.saturating_add(1) - current;
                    packet.set_dts(Some(current + correction));
                    packet.set_pts(packet.pts().map(|pts| pts + correction));
                }
            }
            last_dts[index] = packet.dts();
            packet.set_position(-1);
            packet.set_stream(index);
            packet
                .write_interleaved(&mut output)
                .map_err(|error| format!("Could not join export segments: {error}"))?;
        }
        elapsed += segment_duration;
    }
    output
        .write_trailer()
        .map_err(|error| format!("Could not finish the final export: {error}"))
}

fn mux_video_and_audio(
    video_path: &PathBuf,
    audio_path: &PathBuf,
    destination: &PathBuf,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let mut video_input = ffmpeg::format::input(video_path)
        .map_err(|error| format!("Could not reopen the rendered video: {error}"))?;
    let mut audio_input = ffmpeg::format::input(audio_path)
        .map_err(|error| format!("Could not reopen the rendered audio: {error}"))?;
    let video_stream = video_input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or_else(|| "The rendered timeline has no video stream.".to_owned())?;
    let audio_stream = audio_input
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .ok_or_else(|| "The rendered timeline has no audio stream.".to_owned())?;
    let video_input_index = video_stream.index();
    let audio_input_index = audio_stream.index();
    let video_time_base = video_stream.time_base();
    let audio_time_base = audio_stream.time_base();

    let mut output = ffmpeg::format::output(destination)
        .map_err(|error| format!("Could not create the final export: {error}"))?;
    let video_codec = ffmpeg::encoder::find(video_stream.parameters().id())
        .ok_or_else(|| "Could not identify the rendered video codec.".to_owned())?;
    let video_output_index = {
        let mut stream = output
            .add_stream(video_codec)
            .map_err(|error| format!("Could not create the final video stream: {error}"))?;
        stream.set_parameters(video_stream.parameters());
        stream.set_time_base(video_time_base);
        stream.index()
    };
    let audio_codec = ffmpeg::encoder::find(audio_stream.parameters().id())
        .ok_or_else(|| "Could not identify the rendered audio codec.".to_owned())?;
    let audio_output_index = {
        let mut stream = output
            .add_stream(audio_codec)
            .map_err(|error| format!("Could not create the final audio stream: {error}"))?;
        stream.set_parameters(audio_stream.parameters());
        stream.set_time_base(audio_time_base);
        stream.index()
    };
    output
        .write_header()
        .map_err(|error| format!("Could not write the final export header: {error}"))?;
    let video_output_time_base = output
        .stream(video_output_index)
        .ok_or_else(|| "The final video stream disappeared.".to_owned())?
        .time_base();
    let audio_output_time_base = output
        .stream(audio_output_index)
        .ok_or_else(|| "The final audio stream disappeared.".to_owned())?
        .time_base();
    let mut video_packet = read_stream_packet(&mut video_input, video_input_index)?;
    let mut audio_packet = read_stream_packet(&mut audio_input, audio_input_index)?;
    while video_packet.is_some() || audio_packet.is_some() {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".to_owned());
        }
        let take_video = match (&video_packet, &audio_packet) {
            (Some(video), Some(audio)) => {
                packet_time(video, video_time_base) <= packet_time(audio, audio_time_base)
            }
            (Some(_), None) => true,
            (None, Some(_)) => false,
            (None, None) => break,
        };
        if take_video {
            let mut packet = video_packet.take().expect("video packet is available");
            packet.rescale_ts(video_time_base, video_output_time_base);
            packet.set_stream(video_output_index);
            packet.set_position(-1);
            packet
                .write_interleaved(&mut output)
                .map_err(|error| format!("Could not write final video data: {error}"))?;
            video_packet = read_stream_packet(&mut video_input, video_input_index)?;
        } else {
            let mut packet = audio_packet.take().expect("audio packet is available");
            packet.rescale_ts(audio_time_base, audio_output_time_base);
            packet.set_stream(audio_output_index);
            packet.set_position(-1);
            packet
                .write_interleaved(&mut output)
                .map_err(|error| format!("Could not write final audio data: {error}"))?;
            audio_packet = read_stream_packet(&mut audio_input, audio_input_index)?;
        }
    }
    output
        .write_trailer()
        .map_err(|error| format!("Could not finish the final export: {error}"))
}

fn read_stream_packet(
    input: &mut ffmpeg::format::context::Input,
    stream_index: usize,
) -> Result<Option<ffmpeg::Packet>, String> {
    loop {
        let mut packet = ffmpeg::Packet::empty();
        match packet.read(input) {
            Ok(()) if packet.stream() == stream_index => return Ok(Some(packet)),
            Ok(()) => {}
            Err(ffmpeg::Error::Eof) => return Ok(None),
            Err(error) => return Err(format!("Could not read a rendered stream: {error}")),
        }
    }
}

fn packet_time(packet: &ffmpeg::Packet, time_base: Rational) -> f64 {
    packet.pts().or(packet.dts()).unwrap_or(0) as f64 * rational_value(time_base)
}

fn render_sequence(
    video: &VideoAsset,
    sequence: &Sequence,
    settings: &ExportSettings,
    format: SequenceFormat,
    destination: &PathBuf,
    progress: &AtomicU32,
    cancel: &AtomicBool,
) -> Result<(), String> {
    crate::media::initialize_ffmpeg()?;
    if sequence.duration <= 0.0 {
        return Err("There is nothing on the timeline to export.".to_owned());
    }

    let result = render_sequence_inner(
        video,
        sequence,
        settings,
        format,
        destination,
        progress,
        cancel,
    );
    if result.is_err() || cancel.load(Ordering::Acquire) {
        let _ = std::fs::remove_file(destination);
    }
    result
}

fn render_sequence_inner(
    video: &VideoAsset,
    sequence: &Sequence,
    settings: &ExportSettings,
    format: SequenceFormat,
    destination: &PathBuf,
    progress: &AtomicU32,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let mut input = ffmpeg::format::input(&video.path)
        .map_err(|error| format!("Could not open the source video for export: {error}"))?;
    let video_stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or_else(|| "The source no longer contains a video stream.".to_owned())?;
    let video_index = video_stream.index();
    let video_time_base = video_stream.time_base();
    let mut video_decoder =
        ffmpeg::codec::context::Context::from_parameters(video_stream.parameters())
            .and_then(|context| context.decoder().video())
            .map_err(|error| format!("Could not start the video decoder: {error}"))?;
    video_decoder.set_packet_time_base(video_time_base);

    let audio_stream = settings
        .include_audio
        .then(|| input.streams().best(ffmpeg::media::Type::Audio))
        .flatten();
    let audio_index = audio_stream.as_ref().map(|stream| stream.index());
    let audio_time_base = audio_stream.as_ref().map(|stream| stream.time_base());
    let mut audio_decoder = audio_stream
        .as_ref()
        .map(|stream| {
            ffmpeg::codec::context::Context::from_parameters(stream.parameters())
                .and_then(|context| context.decoder().audio())
        })
        .transpose()
        .map_err(|error| format!("Could not start the audio decoder: {error}"))?;
    if let (Some(decoder), Some(time_base)) = (audio_decoder.as_mut(), audio_time_base) {
        decoder.set_packet_time_base(time_base);
        if decoder.channel_layout().is_empty() {
            decoder.set_channel_layout(ffmpeg::ChannelLayout::default(decoder.channels() as i32));
        }
    }

    let mut output = ffmpeg::format::output(destination)
        .map_err(|error| format!("Could not create the export file: {error}"))?;
    let global_header = output
        .format()
        .flags()
        .contains(ffmpeg::format::Flags::GLOBAL_HEADER);
    let (width, height) = settings.resolution.dimensions(video, format);
    let frame_rate = rational_frame_rate(format.frame_rate);
    let video_encoder_time_base = Rational(frame_rate.denominator(), frame_rate.numerator());

    let pixels_per_second = width as f64 * height as f64 * format.frame_rate.max(1.0);
    let video_bitrate = (pixels_per_second * settings.quality.bits_per_pixel())
        .round()
        .clamp(1_500_000.0, 45_000_000.0) as usize;
    let (mut encoded_video, video_codec) = open_video_encoder(
        width,
        height,
        frame_rate,
        video_encoder_time_base,
        video_bitrate,
        global_header,
        video_decoder.color_space(),
        video_decoder.color_range(),
    )?;
    let video_output_index = {
        let mut stream = output
            .add_stream(video_codec)
            .map_err(|error| format!("Could not create the video output stream: {error}"))?;
        stream.set_time_base(video_encoder_time_base);
        stream.set_parameters(&encoded_video);
        stream.index()
    };

    let mut encoded_audio = if audio_decoder.is_some() {
        let (encoder, audio_codec) =
            open_audio_encoder(settings.quality.audio_bitrate(), global_header)?;
        let mut stream = output
            .add_stream(audio_codec)
            .map_err(|error| format!("Could not create the audio output stream: {error}"))?;
        stream.set_time_base((1, AUDIO_RATE as i32));
        stream.set_parameters(&encoder);
        Some((encoder, stream.index()))
    } else {
        None
    };

    let mut video_filter = video_filter_graph(
        &video_decoder,
        video_time_base,
        video,
        sequence,
        width,
        height,
        frame_rate,
    )?;
    let mut audio_filter = match (
        audio_decoder.as_ref(),
        audio_time_base,
        encoded_audio.as_ref(),
    ) {
        (Some(decoder), Some(time_base), Some((encoder, _))) => {
            Some(audio_filter_graph(decoder, time_base, encoder, sequence)?)
        }
        _ => None,
    };

    output
        .write_header()
        .map_err(|error| format!("Could not write the export header: {error}"))?;
    let video_output_time_base = output
        .stream(video_output_index)
        .ok_or_else(|| "The video output stream disappeared.".to_owned())?
        .time_base();
    let audio_output_time_base = encoded_audio
        .as_ref()
        .and_then(|(_, index)| output.stream(*index).map(|stream| stream.time_base()));
    let mut last_video_dts = None;

    for (stream, packet) in input.packets() {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".to_owned());
        }
        if stream.index() == video_index {
            let mut backpressure_waits = 0;
            loop {
                match video_decoder.send_packet(&packet) {
                    Ok(()) => break,
                    Err(error) if is_again(error) => {
                        let drained = drain_video_decoder(
                            &mut video_decoder,
                            &mut video_filter,
                            &mut encoded_video,
                            &mut output,
                            video_output_index,
                            video_encoder_time_base,
                            video_output_time_base,
                            video_time_base,
                            video.duration,
                            progress,
                            &mut last_video_dts,
                        )?;
                        if drained {
                            backpressure_waits = 0;
                        } else {
                            wait_for_decoder("Video", &mut backpressure_waits)?;
                        }
                    }
                    Err(error) => {
                        return Err(format!("Video decoding failed during export: {error}"));
                    }
                }
            }
            drain_video_decoder(
                &mut video_decoder,
                &mut video_filter,
                &mut encoded_video,
                &mut output,
                video_output_index,
                video_encoder_time_base,
                video_output_time_base,
                video_time_base,
                video.duration,
                progress,
                &mut last_video_dts,
            )?;
        } else if Some(stream.index()) == audio_index {
            if let (Some(decoder), Some(filter), Some((encoder, index)), Some(output_time_base)) = (
                audio_decoder.as_mut(),
                audio_filter.as_mut(),
                encoded_audio.as_mut(),
                audio_output_time_base,
            ) {
                let mut backpressure_waits = 0;
                loop {
                    match decoder.send_packet(&packet) {
                        Ok(()) => break,
                        Err(error) if is_again(error) => {
                            let drained = drain_audio_decoder(
                                decoder,
                                filter,
                                encoder,
                                &mut output,
                                *index,
                                output_time_base,
                            )?;
                            if drained {
                                backpressure_waits = 0;
                            } else {
                                wait_for_decoder("Audio", &mut backpressure_waits)?;
                            }
                        }
                        Err(error) => {
                            return Err(format!("Audio decoding failed during export: {error}"));
                        }
                    }
                }
                drain_audio_decoder(
                    decoder,
                    filter,
                    encoder,
                    &mut output,
                    *index,
                    output_time_base,
                )?;
            }
        }
    }

    let mut video_eof_waits = 0;
    loop {
        match video_decoder.send_eof() {
            Ok(()) => break,
            Err(error) if is_again(error) => {
                let drained = drain_video_decoder(
                    &mut video_decoder,
                    &mut video_filter,
                    &mut encoded_video,
                    &mut output,
                    video_output_index,
                    video_encoder_time_base,
                    video_output_time_base,
                    video_time_base,
                    video.duration,
                    progress,
                    &mut last_video_dts,
                )?;
                if drained {
                    video_eof_waits = 0;
                } else {
                    wait_for_decoder("Video", &mut video_eof_waits)?;
                }
            }
            Err(error) => return Err(format!("Could not finish video decoding: {error}")),
        }
    }
    drain_video_decoder(
        &mut video_decoder,
        &mut video_filter,
        &mut encoded_video,
        &mut output,
        video_output_index,
        video_encoder_time_base,
        video_output_time_base,
        video_time_base,
        video.duration,
        progress,
        &mut last_video_dts,
    )?;
    video_filter
        .get("in")
        .ok_or_else(|| "Video filter input disappeared.".to_owned())?
        .source()
        .flush()
        .map_err(|error| format!("Could not finish the video timeline: {error}"))?;
    drain_video_filter(
        &mut video_filter,
        &mut encoded_video,
        &mut output,
        video_output_index,
        video_encoder_time_base,
        video_output_time_base,
        &mut last_video_dts,
    )?;
    loop {
        match encoded_video.send_eof() {
            Ok(()) => break,
            Err(error) if is_again(error) => drain_video_encoder(
                &mut encoded_video,
                &mut output,
                video_output_index,
                video_encoder_time_base,
                video_output_time_base,
                &mut last_video_dts,
            )?,
            Err(error) => return Err(format!("Could not finish video encoding: {error}")),
        }
    }
    drain_video_encoder(
        &mut encoded_video,
        &mut output,
        video_output_index,
        video_encoder_time_base,
        video_output_time_base,
        &mut last_video_dts,
    )?;

    if let (Some(decoder), Some(filter), Some((encoder, index)), Some(output_time_base)) = (
        audio_decoder.as_mut(),
        audio_filter.as_mut(),
        encoded_audio.as_mut(),
        audio_output_time_base,
    ) {
        let mut audio_eof_waits = 0;
        loop {
            match decoder.send_eof() {
                Ok(()) => break,
                Err(error) if is_again(error) => {
                    let drained = drain_audio_decoder(
                        decoder,
                        filter,
                        encoder,
                        &mut output,
                        *index,
                        output_time_base,
                    )?;
                    if drained {
                        audio_eof_waits = 0;
                    } else {
                        wait_for_decoder("Audio", &mut audio_eof_waits)?;
                    }
                }
                Err(error) => return Err(format!("Could not finish audio decoding: {error}")),
            }
        }
        drain_audio_decoder(
            decoder,
            filter,
            encoder,
            &mut output,
            *index,
            output_time_base,
        )?;
        filter
            .get("in")
            .ok_or_else(|| "Audio filter input disappeared.".to_owned())?
            .source()
            .flush()
            .map_err(|error| format!("Could not finish the audio timeline: {error}"))?;
        drain_audio_filter(filter, encoder, &mut output, *index, output_time_base)?;
        loop {
            match encoder.send_eof() {
                Ok(()) => break,
                Err(error) if is_again(error) => {
                    drain_audio_encoder(encoder, &mut output, *index, output_time_base)?;
                }
                Err(error) => return Err(format!("Could not finish audio encoding: {error}")),
            }
        }
        drain_audio_encoder(encoder, &mut output, *index, output_time_base)?;
    }

    if cancel.load(Ordering::Acquire) {
        return Err("cancelled".to_owned());
    }
    output
        .write_trailer()
        .map_err(|error| format!("Could not finalize the export: {error}"))?;
    progress.store(1_000, Ordering::Release);
    Ok(())
}

fn video_filter_graph(
    decoder: &ffmpeg::codec::decoder::Video,
    input_time_base: Rational,
    video: &VideoAsset,
    sequence: &Sequence,
    width: u32,
    height: u32,
    frame_rate: Rational,
) -> Result<ffmpeg::filter::Graph, String> {
    let mut graph = ffmpeg::filter::Graph::new();
    let pixel_format: ffmpeg::ffi::AVPixelFormat = decoder.format().into();
    let colorspace = export_color_space(decoder.color_space())
        .name()
        .expect("the export color space is specified");
    let color_range = decoder.color_range().name().unwrap_or("tv");
    let args = format!(
        "video_size={}x{}:pix_fmt={}:time_base={}:pixel_aspect={}:colorspace={colorspace}:range={color_range}",
        decoder.width(),
        decoder.height(),
        pixel_format as i32,
        input_time_base,
        decoder.aspect_ratio()
    );
    graph
        .add(
            &ffmpeg::filter::find("buffer")
                .ok_or_else(|| "Video filters are unavailable.".to_owned())?,
            "in",
            &args,
        )
        .map_err(|error| format!("Could not create the video filter input: {error}"))?;
    graph
        .add(
            &ffmpeg::filter::find("buffersink")
                .ok_or_else(|| "Video filters are unavailable.".to_owned())?,
            "out",
            "",
        )
        .map_err(|error| format!("Could not create the video filter output: {error}"))?;
    let spec = build_video_filter(video, sequence, width, height, frame_rate);
    graph
        .output("in", 0)
        .and_then(|parser| parser.input("out", 0))
        .and_then(|parser| parser.parse(&spec))
        .and_then(|_| graph.validate())
        .map_err(|error| format!("Could not build the edited video timeline: {error}"))?;
    Ok(graph)
}

fn audio_filter_graph(
    decoder: &ffmpeg::codec::decoder::Audio,
    input_time_base: Rational,
    encoder: &ffmpeg::codec::encoder::audio::Encoder,
    sequence: &Sequence,
) -> Result<ffmpeg::filter::Graph, String> {
    let mut graph = ffmpeg::filter::Graph::new();
    let args = format!(
        "time_base={}:sample_rate={}:sample_fmt={}:channel_layout=0x{:x}",
        input_time_base,
        decoder.rate(),
        decoder.format().name(),
        decoder.channel_layout().bits()
    );
    graph
        .add(
            &ffmpeg::filter::find("abuffer")
                .ok_or_else(|| "Audio filters are unavailable.".to_owned())?,
            "in",
            &args,
        )
        .map_err(|error| format!("Could not create the audio filter input: {error}"))?;
    graph
        .add(
            &ffmpeg::filter::find("abuffersink")
                .ok_or_else(|| "Audio filters are unavailable.".to_owned())?,
            "out",
            "",
        )
        .map_err(|error| format!("Could not create the audio filter output: {error}"))?;
    let spec = build_audio_filter(sequence, encoder.format().name());
    graph
        .output("in", 0)
        .and_then(|parser| parser.input("out", 0))
        .and_then(|parser| parser.parse(&spec))
        .and_then(|_| graph.validate())
        .map_err(|error| format!("Could not build the edited audio timeline: {error}"))?;
    if encoder.frame_size() > 0 {
        graph
            .get("out")
            .expect("audio sink was just created")
            .sink()
            .set_frame_size(encoder.frame_size());
    }
    Ok(graph)
}

fn build_video_filter(
    video: &VideoAsset,
    sequence: &Sequence,
    width: u32,
    height: u32,
    rate: Rational,
) -> String {
    let clips = topmost_video_segments(sequence);
    let mut filters = Vec::new();
    if clips.is_empty() {
        filters.push("nullsink".to_owned());
    } else if clips.len() > 1 {
        let outputs = (0..clips.len())
            .map(|index| format!("[v{index}]"))
            .collect::<String>();
        filters.push(format!(
            "setpts=PTS-STARTPTS,split={}{outputs}",
            clips.len()
        ));
    }
    let rotation = match video.rotation.rem_euclid(360) {
        90 => "transpose=clock,",
        180 => "hflip,vflip,",
        270 => "transpose=cclock,",
        _ => "",
    };
    let mut pieces = Vec::new();
    let mut cursor = 0.0;
    for (index, clip) in clips.iter().enumerate() {
        if clip.timeline_start > cursor + 0.000_001 {
            let label = format!("p{}", pieces.len());
            filters.push(format!(
                "color=c=black:s={width}x{height}:r={}/{}:d={:.9},format=yuv420p[{label}]",
                rate.numerator(),
                rate.denominator(),
                clip.timeline_start - cursor
            ));
            pieces.push(label);
        }
        let label = format!("p{}", pieces.len());
        let input = if clips.len() > 1 {
            format!("[v{index}]trim")
        } else {
            "[in]setpts=PTS-STARTPTS,trim".to_owned()
        };
        let fg = format!("fg{}", pieces.len());
        let bg = format!("bg{}", pieces.len());
        let transform =
            clip_video_transform(clip, video.source_width, video.source_height, rotation);
        filters.push(format!(
            "{input}=start={:.9}:end={:.9},setpts=PTS-STARTPTS,{transform}[{fg}]",
            clip.source_in, clip.source_out
        ));
        // Overlay onto a fixed canvas so scale > 100% and rotation can exceed
        // the frame without breaking pad (which requires iw/ih <= padded size).
        filters.push(format!(
            "color=c=black:s={width}x{height}:r={}/{}[{bg}]",
            rate.numerator(),
            rate.denominator()
        ));
        let x = clip.motion.position_x.round() as i32;
        let y = (-clip.motion.position_y).round() as i32;
        filters.push(format!(
            "[{bg}][{fg}]overlay=x=(main_w-overlay_w)/2+{x}:y=(main_h-overlay_h)/2+{y}:shortest=1,setsar=1,format=yuv420p[{label}]"
        ));
        pieces.push(label);
        cursor = clip.timeline_end;
    }
    if cursor < sequence.duration - 0.000_001 || pieces.is_empty() {
        let label = format!("p{}", pieces.len());
        filters.push(format!(
            "color=c=black:s={width}x{height}:r={}/{}:d={:.9},format=yuv420p[{label}]",
            rate.numerator(),
            rate.denominator(),
            sequence.duration - cursor
        ));
        pieces.push(label);
    }
    let joined = pieces
        .iter()
        .map(|label| format!("[{label}]"))
        .collect::<String>();
    filters.push(format!(
        "{joined}concat=n={}:v=1:a=0,fps={}/{},format=yuv420p",
        pieces.len(),
        rate.numerator(),
        rate.denominator()
    ));
    filters.join(";")
}

fn clip_video_transform(
    clip: &SequenceClip,
    source_width: usize,
    source_height: usize,
    rotation: &str,
) -> String {
    let user_scale = (clip.motion.scale / 100.0).max(0.01);
    // Match preview: 100% keeps native source pixels inside the sequence canvas.
    let scaled_w = even((source_width as f32 * user_scale).round().max(2.0) as usize);
    let scaled_h = even((source_height as f32 * user_scale).round().max(2.0) as usize);
    let angle = clip.motion.rotation.to_radians() as f64;
    let rotate = if angle.abs() > 0.000_1 {
        format!("rotate={angle:.8}:c=black:ow=rotw({angle:.8}):oh=roth({angle:.8}),")
    } else {
        String::new()
    };
    format!(
        "{rotation}scale={scaled_w}:{scaled_h}:force_original_aspect_ratio=decrease,setsar=1,{rotate}format=yuv420p"
    )
}

fn build_audio_filter(sequence: &Sequence, sample_format: &str) -> String {
    let clips = sequence
        .clips
        .iter()
        .filter(|clip| clip.lane.shows_audio())
        .collect::<Vec<_>>();
    let mut filters = Vec::new();
    if clips.is_empty() {
        filters.push("anullsink".to_owned());
    } else if clips.len() > 1 {
        let outputs = (0..clips.len())
            .map(|index| format!("[a{index}]"))
            .collect::<String>();
        filters.push(format!(
            "asetpts=PTS-STARTPTS,asplit={}{outputs}",
            clips.len()
        ));
    }
    let mut pieces = Vec::new();
    let mut cursor = 0.0;
    for (index, clip) in clips.iter().enumerate() {
        if clip.timeline_start > cursor + 0.000_001 {
            let label = format!("q{}", pieces.len());
            filters.push(format!(
                "anullsrc=r={AUDIO_RATE}:cl=stereo:d={:.9}[{label}]",
                clip.timeline_start - cursor
            ));
            pieces.push(label);
        }
        let label = format!("q{}", pieces.len());
        let input = if clips.len() > 1 {
            format!("[a{index}]atrim")
        } else {
            "[in]asetpts=PTS-STARTPTS,atrim".to_owned()
        };
        let volume = if clip.audio.volume_db.abs() > 0.001 {
            format!(",volume={:.6}dB", clip.audio.volume_db)
        } else {
            String::new()
        };
        filters.push(format!(
            "{input}=start={:.9}:end={:.9},asetpts=PTS-STARTPTS{volume},aresample={AUDIO_RATE},aformat=channel_layouts=stereo[{label}]",
            clip.source_in, clip.source_out
        ));
        pieces.push(label);
        cursor = clip.timeline_end;
    }
    if cursor < sequence.duration - 0.000_001 || pieces.is_empty() {
        let label = format!("q{}", pieces.len());
        filters.push(format!(
            "anullsrc=r={AUDIO_RATE}:cl=stereo:d={:.9}[{label}]",
            sequence.duration - cursor
        ));
        pieces.push(label);
    }
    let joined = pieces
        .iter()
        .map(|label| format!("[{label}]"))
        .collect::<String>();
    filters.push(format!(
        "{joined}concat=n={}:v=0:a=1,aformat=sample_fmts={sample_format}:sample_rates={AUDIO_RATE}:channel_layouts=stereo",
        pieces.len(),
    ));
    filters.join(";")
}

#[allow(clippy::too_many_arguments)]
fn drain_video_decoder(
    decoder: &mut ffmpeg::codec::decoder::Video,
    filter: &mut ffmpeg::filter::Graph,
    encoder: &mut ffmpeg::codec::encoder::video::Encoder,
    output: &mut ffmpeg::format::context::Output,
    stream_index: usize,
    encoder_time_base: Rational,
    output_time_base: Rational,
    input_time_base: Rational,
    source_duration: f64,
    progress: &AtomicU32,
    last_dts: &mut Option<i64>,
) -> Result<bool, String> {
    let expected_colorspace = export_color_space(decoder.color_space());
    let expected_color_range = if decoder.color_range() == ffmpeg::color::Range::Unspecified {
        ffmpeg::color::Range::MPEG
    } else {
        decoder.color_range()
    };
    let mut decoded = ffmpeg::frame::Video::empty();
    let mut drained_any = false;
    loop {
        match decoder.receive_frame(&mut decoded) {
            Ok(()) => drained_any = true,
            Err(error) if is_again_or_eof(error) => break,
            Err(error) => return Err(format!("Video decoding failed during export: {error}")),
        }
        if let Some(timestamp) = decoded.timestamp() {
            let seconds = timestamp as f64 * input_time_base.numerator() as f64
                / input_time_base.denominator() as f64;
            let value = (seconds / source_duration.max(0.001) * 850.0).clamp(0.0, 850.0) as u32;
            progress.store(value, Ordering::Release);
        }
        let timestamp = decoded.timestamp();
        decoded.set_pts(timestamp);
        // Some decoders omit these properties on individual frames even when
        // the stream has stable metadata. Keep the buffer source consistent.
        if decoded.color_space() == ffmpeg::color::Space::Unspecified {
            decoded.set_color_space(expected_colorspace);
        }
        if decoded.color_range() == ffmpeg::color::Range::Unspecified {
            decoded.set_color_range(expected_color_range);
        }
        loop {
            let added = filter
                .get("in")
                .ok_or_else(|| "Video filter input disappeared.".to_owned())?
                .source()
                .add(&decoded);
            match added {
                Ok(()) => break,
                Err(error) if is_again(error) => {
                    drain_video_filter(
                        filter,
                        encoder,
                        output,
                        stream_index,
                        encoder_time_base,
                        output_time_base,
                        last_dts,
                    )?;
                }
                Err(ffmpeg::Error::Eof) => return Ok(drained_any),
                Err(error) => {
                    return Err(format!(
                        "Could not add a frame to the video timeline: {error}"
                    ));
                }
            }
        }
        drain_video_filter(
            filter,
            encoder,
            output,
            stream_index,
            encoder_time_base,
            output_time_base,
            last_dts,
        )?;
    }
    Ok(drained_any)
}

fn drain_video_filter(
    filter: &mut ffmpeg::filter::Graph,
    encoder: &mut ffmpeg::codec::encoder::video::Encoder,
    output: &mut ffmpeg::format::context::Output,
    stream_index: usize,
    encoder_time_base: Rational,
    output_time_base: Rational,
    last_dts: &mut Option<i64>,
) -> Result<(), String> {
    let sink_time_base = filter
        .get("out")
        .ok_or_else(|| "Video filter output disappeared.".to_owned())?
        .sink()
        .time_base();
    loop {
        let mut filtered = ffmpeg::frame::Video::empty();
        match filter
            .get("out")
            .expect("video sink exists")
            .sink()
            .frame(&mut filtered)
        {
            Ok(()) => {
                if let Some(pts) = filtered.pts() {
                    filtered.set_pts(Some(pts.rescale(sink_time_base, encoder_time_base)));
                }
                loop {
                    match encoder.send_frame(&filtered) {
                        Ok(()) => break,
                        Err(error) if is_again(error) => drain_video_encoder(
                            encoder,
                            output,
                            stream_index,
                            encoder_time_base,
                            output_time_base,
                            last_dts,
                        )?,
                        Err(error) => return Err(format!("Video encoding failed: {error}")),
                    }
                }
                drain_video_encoder(
                    encoder,
                    output,
                    stream_index,
                    encoder_time_base,
                    output_time_base,
                    last_dts,
                )?;
            }
            Err(error) if is_again_or_eof(error) => break,
            Err(error) => return Err(format!("Video filtering failed: {error}")),
        }
    }
    Ok(())
}

fn drain_video_encoder(
    encoder: &mut ffmpeg::codec::encoder::video::Encoder,
    output: &mut ffmpeg::format::context::Output,
    stream_index: usize,
    encoder_time_base: Rational,
    output_time_base: Rational,
    last_dts: &mut Option<i64>,
) -> Result<(), String> {
    loop {
        let mut packet = ffmpeg::Packet::empty();
        match encoder.receive_packet(&mut packet) {
            Ok(()) => {
                packet.set_stream(stream_index);
                packet.rescale_ts(encoder_time_base, output_time_base);
                normalize_video_packet_timestamps(&mut packet, last_dts);
                packet.set_position(-1);
                packet
                    .write_interleaved(output)
                    .map_err(|error| format!("Could not write video data: {error}"))?;
            }
            Err(error) if is_again_or_eof(error) => break,
            Err(error) => return Err(format!("Video encoding failed: {error}")),
        }
    }
    Ok(())
}

fn normalize_video_packet_timestamps(packet: &mut ffmpeg::Packet, last_dts: &mut Option<i64>) {
    let fallback = last_dts.map_or(0, |last| last.saturating_add(1));
    let requested = packet.pts().or(packet.dts()).unwrap_or(fallback);
    let dts = last_dts.map_or(requested, |last| requested.max(last.saturating_add(1)));
    let pts = packet.pts().unwrap_or(dts).max(dts);
    packet.set_dts(Some(dts));
    packet.set_pts(Some(pts));
    *last_dts = Some(dts);
}

fn drain_audio_decoder(
    decoder: &mut ffmpeg::codec::decoder::Audio,
    filter: &mut ffmpeg::filter::Graph,
    encoder: &mut ffmpeg::codec::encoder::audio::Encoder,
    output: &mut ffmpeg::format::context::Output,
    stream_index: usize,
    output_time_base: Rational,
) -> Result<bool, String> {
    let mut decoded = ffmpeg::frame::Audio::empty();
    let mut drained_any = false;
    loop {
        match decoder.receive_frame(&mut decoded) {
            Ok(()) => drained_any = true,
            Err(error) if is_again_or_eof(error) => break,
            Err(error) => return Err(format!("Audio decoding failed during export: {error}")),
        }
        let timestamp = decoded.timestamp();
        decoded.set_pts(timestamp);
        loop {
            let added = filter
                .get("in")
                .ok_or_else(|| "Audio filter input disappeared.".to_owned())?
                .source()
                .add(&decoded);
            match added {
                Ok(()) => break,
                Err(error) if is_again(error) => {
                    drain_audio_filter(filter, encoder, output, stream_index, output_time_base)?;
                }
                Err(ffmpeg::Error::Eof) => return Ok(drained_any),
                Err(error) => {
                    return Err(format!("Could not add audio to the timeline: {error}"));
                }
            }
        }
        drain_audio_filter(filter, encoder, output, stream_index, output_time_base)?;
    }
    Ok(drained_any)
}

fn drain_audio_filter(
    filter: &mut ffmpeg::filter::Graph,
    encoder: &mut ffmpeg::codec::encoder::audio::Encoder,
    output: &mut ffmpeg::format::context::Output,
    stream_index: usize,
    output_time_base: Rational,
) -> Result<(), String> {
    let sink_time_base = filter
        .get("out")
        .ok_or_else(|| "Audio filter output disappeared.".to_owned())?
        .sink()
        .time_base();
    let encoder_time_base = Rational(1, encoder.rate() as i32);
    loop {
        let mut filtered = ffmpeg::frame::Audio::empty();
        match filter
            .get("out")
            .expect("audio sink exists")
            .sink()
            .frame(&mut filtered)
        {
            Ok(()) => {
                if let Some(pts) = filtered.pts() {
                    filtered.set_pts(Some(pts.rescale(sink_time_base, encoder_time_base)));
                }
                loop {
                    match encoder.send_frame(&filtered) {
                        Ok(()) => break,
                        Err(error) if is_again(error) => {
                            drain_audio_encoder(encoder, output, stream_index, output_time_base)?;
                        }
                        Err(error) => return Err(format!("Audio encoding failed: {error}")),
                    }
                }
                drain_audio_encoder(encoder, output, stream_index, output_time_base)?;
            }
            Err(error) if is_again_or_eof(error) => break,
            Err(error) => return Err(format!("Audio filtering failed: {error}")),
        }
    }
    Ok(())
}

fn drain_audio_encoder(
    encoder: &mut ffmpeg::codec::encoder::audio::Encoder,
    output: &mut ffmpeg::format::context::Output,
    stream_index: usize,
    output_time_base: Rational,
) -> Result<(), String> {
    let encoder_time_base = Rational(1, encoder.rate() as i32);
    loop {
        let mut packet = ffmpeg::Packet::empty();
        match encoder.receive_packet(&mut packet) {
            Ok(()) => {
                packet.set_stream(stream_index);
                packet.rescale_ts(encoder_time_base, output_time_base);
                packet.set_position(-1);
                packet
                    .write_interleaved(output)
                    .map_err(|error| format!("Could not write audio data: {error}"))?;
            }
            Err(error) if is_again_or_eof(error) => break,
            Err(error) => return Err(format!("Audio encoding failed: {error}")),
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn open_video_encoder(
    width: u32,
    height: u32,
    frame_rate: Rational,
    time_base: Rational,
    bit_rate: usize,
    global_header: bool,
    source_colorspace: ffmpeg::color::Space,
    source_color_range: ffmpeg::color::Range,
) -> Result<(ffmpeg::codec::encoder::video::Encoder, ffmpeg::Codec), String> {
    let names = [
        "h264_videotoolbox",
        "h264_mf",
        "h264_nvenc",
        "h264_qsv",
        "h264_amf",
        "mpeg4",
    ];
    let mut last_error = None;
    for name in names {
        let Some(codec) = ffmpeg::encoder::find_by_name(name) else {
            continue;
        };
        let configured = ffmpeg::codec::context::Context::new_with_codec(codec)
            .encoder()
            .video();
        let Ok(mut encoder) = configured else {
            continue;
        };
        if global_header {
            encoder.set_flags(ffmpeg::codec::Flags::GLOBAL_HEADER);
        }
        encoder.set_width(width);
        encoder.set_height(height);
        encoder.set_format(ffmpeg::format::Pixel::YUV420P);
        encoder.set_time_base(time_base);
        encoder.set_frame_rate(Some(frame_rate));
        encoder.set_gop(frame_rate.numerator().unsigned_abs().clamp(12, 240));
        // MP4 requires monotonically ordered decode timestamps. In particular,
        // VideoToolbox can otherwise return reordered packets with PTS < DTS.
        encoder.set_max_b_frames(0);
        encoder.set_bit_rate(bit_rate);
        encoder.set_colorspace(export_color_space(source_colorspace));
        encoder.set_color_range(if source_color_range == ffmpeg::color::Range::Unspecified {
            ffmpeg::color::Range::MPEG
        } else {
            source_color_range
        });
        let opened = if name == "h264_videotoolbox" {
            let mut options = ffmpeg::Dictionary::new();
            options.set("allow_sw", "1");
            encoder.open_as_with(codec, options)
        } else {
            encoder.open_as(codec)
        };
        match opened {
            Ok(encoder) => return Ok((encoder, codec)),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.map_or_else(
        || "This build has no compatible video encoder.".to_owned(),
        |error| format!("Could not open a compatible video encoder: {error}"),
    ))
}

fn open_audio_encoder(
    bit_rate: usize,
    global_header: bool,
) -> Result<(ffmpeg::codec::encoder::audio::Encoder, ffmpeg::Codec), String> {
    let mut last_error = None;
    for name in ["aac_at", "aac"] {
        let Some(codec) = ffmpeg::encoder::find_by_name(name) else {
            continue;
        };
        let Ok(mut encoder) = ffmpeg::codec::context::Context::new_with_codec(codec)
            .encoder()
            .audio()
        else {
            continue;
        };
        let sample_format = codec
            .audio()
            .ok()
            .and_then(|codec| codec.formats())
            .and_then(|mut formats| formats.next())
            .unwrap_or(ffmpeg::format::Sample::F32(
                ffmpeg::format::sample::Type::Planar,
            ));
        if global_header {
            encoder.set_flags(ffmpeg::codec::Flags::GLOBAL_HEADER);
        }
        encoder.set_rate(AUDIO_RATE as i32);
        encoder.set_channel_layout(ffmpeg::ChannelLayout::STEREO);
        encoder.set_format(sample_format);
        encoder.set_bit_rate(bit_rate);
        encoder.set_time_base((1, AUDIO_RATE as i32));
        match encoder.open_as(codec) {
            Ok(encoder) => return Ok((encoder, codec)),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.map_or_else(
        || "This build has no compatible AAC encoder.".to_owned(),
        |error| format!("Could not open a compatible audio encoder: {error}"),
    ))
}

fn is_again_or_eof(error: ffmpeg::Error) -> bool {
    error == ffmpeg::Error::Eof || is_again(error)
}

fn export_color_space(source: ffmpeg::color::Space) -> ffmpeg::color::Space {
    if source == ffmpeg::color::Space::Unspecified {
        // Preview uses libswscale's default matrix for unspecified sources,
        // which is ITU-R BT.601. SMPTE 170M is FFmpeg's matching stream tag.
        ffmpeg::color::Space::SMPTE170M
    } else {
        source
    }
}

fn is_again(error: ffmpeg::Error) -> bool {
    error
        == ffmpeg::Error::Other {
            errno: ffmpeg::error::EAGAIN,
        }
}

fn wait_for_decoder(kind: &str, attempts: &mut usize) -> Result<(), String> {
    const YIELD_ATTEMPTS: usize = 16;
    const MAX_ATTEMPTS: usize = 2_000;

    *attempts += 1;
    if *attempts > MAX_ATTEMPTS {
        return Err(format!(
            "{kind} decoder remained busy for too long during export."
        ));
    }
    if *attempts <= YIELD_ATTEMPTS {
        thread::yield_now();
    } else {
        thread::sleep(std::time::Duration::from_millis(1));
    }
    Ok(())
}

fn rational_frame_rate(fps: f64) -> Rational {
    let scaled = (fps.clamp(1.0, 120.0) * 1_000.0).round() as i32;
    let divisor = gcd(scaled.unsigned_abs(), 1_000) as i32;
    Rational(scaled / divisor, 1_000 / divisor)
}

fn gcd(mut left: u32, mut right: u32) -> u32 {
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    left.max(1)
}

fn fit_inside(video: &VideoAsset, max_width: u32, max_height: u32) -> (u32, u32) {
    let scale = (max_width as f64 / video.source_width.max(1) as f64)
        .min(max_height as f64 / video.source_height.max(1) as f64);
    (
        even((video.source_width as f64 * scale).round() as usize),
        even((video.source_height as f64 * scale).round() as usize),
    )
}

fn even(value: usize) -> u32 {
    (value.max(2) & !1) as u32
}

#[cfg(test)]
mod tests {
    use super::SequenceFormat;
    use super::{
        build_audio_filter, export_color_space, normalize_video_packet_timestamps,
        render_media_sequence, render_sequence, topmost_video_segments, ExportResolution,
        ExportSettings,
    };
    use crate::{media::VideoAsset, project::Sequence};
    use ffmpeg_next::Packet;
    use std::{
        fs,
        path::PathBuf,
        process::Command,
        sync::atomic::{AtomicBool, AtomicU32},
    };

    #[test]
    fn resolution_presets_keep_portrait_aspect_ratio() {
        let video = VideoAsset {
            path: PathBuf::new(),
            name: String::new(),
            source_width: 1080,
            source_height: 1920,
            decode_width: 608,
            decode_height: 1080,
            duration: 10.0,
            fps: 30.0,
            has_audio: true,
            rotation: 0,
            video_codec: "H.264".to_owned(),
            audio_codec: Some("AAC".to_owned()),
            audio_sample_rate: Some(48_000),
            audio_channels: Some(2),
            audio_bitrate: Some(192_000),
            file_size: None,
        };
        assert_eq!(
            ExportResolution::Hd1080.dimensions(&video, SequenceFormat::from_video(&video)),
            (608, 1080)
        );
    }

    #[test]
    fn unspecified_export_color_space_matches_preview_scaling_default() {
        assert_eq!(
            export_color_space(ffmpeg_next::color::Space::Unspecified),
            ffmpeg_next::color::Space::SMPTE170M
        );
        assert_eq!(
            export_color_space(ffmpeg_next::color::Space::BT709),
            ffmpeg_next::color::Space::BT709
        );
    }

    #[test]
    fn export_video_segments_follow_the_topmost_track() {
        let mut sequence = Sequence::from_media(1, 4.0);
        let upper = sequence.duplicate(1).expect("upper clip should duplicate");
        sequence
            .clips
            .iter_mut()
            .find(|clip| clip.id == upper)
            .unwrap()
            .media_id = 2;
        sequence
            .move_clip_to_track(upper, 1.0, 2, 30.0, 0.0)
            .expect("upper clip should move to V2");
        sequence
            .trim_right_snapped(upper, 3.0, 30.0, 4.0, 0.0)
            .expect("upper clip should trim");

        let segments = topmost_video_segments(&sequence);
        assert_eq!(segments.len(), 3);
        assert_eq!(segments[0].media_id, 1);
        assert_eq!(
            (segments[0].timeline_start, segments[0].timeline_end),
            (0.0, 1.0)
        );
        assert_eq!(segments[1].media_id, 2);
        assert_eq!(
            (segments[1].timeline_start, segments[1].timeline_end),
            (1.0, 3.0)
        );
        assert_eq!(segments[2].media_id, 1);
        assert_eq!(
            (segments[2].timeline_start, segments[2].timeline_end),
            (3.0, 4.0)
        );
    }

    #[test]
    fn audio_export_filter_inserts_silence_for_deleted_clips() {
        let mut sequence = Sequence::new(10.0);
        let middle = sequence.split_at(3.0, 30.0).unwrap();
        sequence.split_at(7.0, 30.0).unwrap();
        sequence.delete(middle);
        let filter = build_audio_filter(&sequence, "fltp");
        assert!(filter.contains("anullsrc"));
        assert!(filter.contains("d=4.000000000"));
    }

    #[test]
    fn hardware_encoder_packets_are_safe_for_mp4_muxing() {
        let mut last_dts = None;
        let mut first = Packet::empty();
        first.set_pts(Some(512));
        first.set_dts(Some(1_024));
        normalize_video_packet_timestamps(&mut first, &mut last_dts);
        assert_eq!(first.pts(), Some(512));
        assert_eq!(first.dts(), Some(512));

        let mut second = Packet::empty();
        second.set_pts(Some(512));
        second.set_dts(Some(1_536));
        normalize_video_packet_timestamps(&mut second, &mut last_dts);
        assert_eq!(second.pts(), Some(513));
        assert_eq!(second.dts(), Some(513));
    }

    #[test]
    fn exports_an_edited_mp4_with_audio_in_process() {
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let temp = std::env::temp_dir();
        let source = temp.join(format!("kuro-export-source-{}.mkv", std::process::id()));
        let output = temp.join(format!("kuro-export-result-{}.mp4", std::process::id()));
        let mixed_output = temp.join(format!("kuro-export-mixed-{}.mp4", std::process::id()));
        let generated = Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=180x320:rate=24",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000",
                "-t",
                "1.2",
                "-c:v",
                "ffv1",
                "-c:a",
                "pcm_s16le",
            ])
            .arg(&source)
            .status()
            .expect("test media should be generated");
        assert!(generated.success());

        let video = VideoAsset::load(source.clone()).expect("test media should load");
        let mut sequence = Sequence::new(video.duration);
        let middle = sequence.split_at(0.4, video.fps).expect("first cut");
        sequence.split_at(0.8, video.fps).expect("second cut");
        sequence.delete(middle);
        render_sequence(
            &video,
            &sequence,
            &ExportSettings {
                resolution: ExportResolution::Source,
                ..ExportSettings::default()
            },
            SequenceFormat::from_video(&video),
            &output,
            &AtomicU32::new(0),
            &AtomicBool::new(false),
        )
        .expect("edited sequence should export");
        let exported = VideoAsset::load(output.clone()).expect("export should be readable");
        assert_eq!((exported.source_width, exported.source_height), (180, 320));
        assert!(exported.has_audio);
        assert!((exported.duration - sequence.duration).abs() < 0.1);
        assert!(fs::metadata(&output).expect("export should exist").len() > 1_000);

        let mut mixed = Sequence::empty();
        mixed.insert_media(1, 0.0, 0.6, 24.0, 0.0).unwrap();
        mixed.insert_media(2, 0.6, 0.6, 24.0, 0.0).unwrap();
        render_media_sequence(
            &[(1, video.clone()), (2, video.clone())],
            &mixed,
            &ExportSettings::default(),
            SequenceFormat::from_video(&video),
            &mixed_output,
            &AtomicU32::new(0),
            &AtomicBool::new(false),
        )
        .expect("a sequence with multiple media IDs should export");
        let mixed_export =
            VideoAsset::load(mixed_output.clone()).expect("mixed export should be readable");
        assert!(mixed_export.duration >= 1.1);
        assert!((mixed_export.duration - mixed.duration).abs() < 0.1);
        assert!(mixed_export.has_audio);

        let _ = fs::remove_file(source);
        let _ = fs::remove_file(output);
        let _ = fs::remove_file(mixed_output);
    }

    #[test]
    fn exports_audio_from_a_different_media_than_video() {
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let temp = std::env::temp_dir();
        let video_source = temp.join(format!(
            "kuro-export-foreign-audio-video-{}.mkv",
            std::process::id()
        ));
        let audio_source = temp.join(format!(
            "kuro-export-foreign-audio-source-{}.mkv",
            std::process::id()
        ));
        let output = temp.join(format!(
            "kuro-export-foreign-audio-result-{}.mp4",
            std::process::id()
        ));
        let same_media_output = temp.join(format!(
            "kuro-export-unlinked-same-media-result-{}.mp4",
            std::process::id()
        ));

        let generated_video = Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=180x320:rate=24",
                "-t",
                "1.2",
                "-c:v",
                "ffv1",
            ])
            .arg(&video_source)
            .status()
            .expect("video-only test media should be generated");
        assert!(generated_video.success());
        let generated_audio = Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:size=180x320:rate=24",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=880:sample_rate=48000",
                "-t",
                "1.2",
                "-c:v",
                "ffv1",
                "-c:a",
                "pcm_s16le",
            ])
            .arg(&audio_source)
            .status()
            .expect("audio test media should be generated");
        assert!(generated_audio.success());

        let video = VideoAsset::load(video_source.clone()).expect("video source should load");
        let audio = VideoAsset::load(audio_source.clone()).expect("audio source should load");
        let mut same_media = Sequence::from_media(2, audio.duration);
        same_media.unlink(1).expect("same-media clip should unlink");
        render_media_sequence(
            &[(2, audio.clone())],
            &same_media,
            &ExportSettings::default(),
            SequenceFormat::from_video(&audio),
            &same_media_output,
            &AtomicU32::new(0),
            &AtomicBool::new(false),
        )
        .expect("same-media unlinked video and audio should export");
        assert!(
            VideoAsset::load(same_media_output.clone())
                .expect("same-media export should be readable")
                .has_audio
        );

        let mut sequence = Sequence::from_media(1, video.duration);
        let audio_clip = sequence.unlink(1).expect("linked clip should unlink");
        sequence
            .clips
            .iter_mut()
            .find(|clip| clip.id == audio_clip)
            .expect("unlinked audio clip should exist")
            .media_id = 2;

        render_media_sequence(
            &[(1, video.clone()), (2, audio)],
            &sequence,
            &ExportSettings {
                resolution: ExportResolution::Source,
                ..ExportSettings::default()
            },
            SequenceFormat::from_video(&video),
            &output,
            &AtomicU32::new(0),
            &AtomicBool::new(false),
        )
        .expect("cross-media video and audio should export");

        let exported = VideoAsset::load(output.clone()).expect("export should be readable");
        assert!(exported.has_audio);
        assert!((exported.duration - sequence.duration).abs() < 0.1);
        let color_input = ffmpeg_next::format::input(&output).expect("export should open");
        let color_stream = color_input
            .streams()
            .best(ffmpeg_next::media::Type::Video)
            .expect("export should contain video");
        let color_decoder =
            ffmpeg_next::codec::context::Context::from_parameters(color_stream.parameters())
                .and_then(|context| context.decoder().video())
                .expect("exported video metadata should decode");
        assert_eq!(
            color_decoder.color_space(),
            ffmpeg_next::color::Space::SMPTE170M
        );
        let decoded_audio = Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(&output)
            .args(["-map", "0:a:0", "-ac", "1", "-f", "f32le", "-"])
            .output()
            .expect("exported audio should decode");
        assert!(decoded_audio.status.success());
        assert!(decoded_audio.stdout.chunks_exact(4).any(|sample| {
            f32::from_le_bytes(sample.try_into().expect("a float sample")).abs() > 0.001
        }));

        let _ = fs::remove_file(video_source);
        let _ = fs::remove_file(audio_source);
        let _ = fs::remove_file(output);
        let _ = fs::remove_file(same_media_output);
    }
}
