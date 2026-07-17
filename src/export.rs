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

use crate::{media::VideoAsset, sequence::Sequence};

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
        video: VideoAsset,
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
            let result = render_sequence(
                &video,
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
            video_decoder
                .send_packet(&packet)
                .map_err(|error| format!("Video decoding failed during export: {error}"))?;
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
                decoder
                    .send_packet(&packet)
                    .map_err(|error| format!("Audio decoding failed during export: {error}"))?;
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

    video_decoder
        .send_eof()
        .map_err(|error| format!("Could not finish video decoding: {error}"))?;
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
    encoded_video
        .send_eof()
        .map_err(|error| format!("Could not finish video encoding: {error}"))?;
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
        decoder
            .send_eof()
            .map_err(|error| format!("Could not finish audio decoding: {error}"))?;
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
        encoder
            .send_eof()
            .map_err(|error| format!("Could not finish audio encoding: {error}"))?;
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
    let colorspace = decoder.color_space().name().unwrap_or("bt709");
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
    let clips = &sequence.clips;
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
    let scale = format!(
        "{rotation}scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p"
    );
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
        filters.push(format!(
            "{input}=start={:.9}:end={:.9},setpts=PTS-STARTPTS,{scale}[{label}]",
            clip.source_in, clip.source_out
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

fn build_audio_filter(sequence: &Sequence, sample_format: &str) -> String {
    let clips = &sequence.clips;
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
        filters.push(format!(
            "{input}=start={:.9}:end={:.9},asetpts=PTS-STARTPTS,aresample={AUDIO_RATE},aformat=channel_layouts=stereo[{label}]",
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
) -> Result<(), String> {
    let expected_colorspace = if decoder.color_space() == ffmpeg::color::Space::Unspecified {
        ffmpeg::color::Space::BT709
    } else {
        decoder.color_space()
    };
    let expected_color_range = if decoder.color_range() == ffmpeg::color::Range::Unspecified {
        ffmpeg::color::Range::MPEG
    } else {
        decoder.color_range()
    };
    let mut decoded = ffmpeg::frame::Video::empty();
    while decoder.receive_frame(&mut decoded).is_ok() {
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
        filter
            .get("in")
            .ok_or_else(|| "Video filter input disappeared.".to_owned())?
            .source()
            .add(&decoded)
            .map_err(|error| format!("Could not add a frame to the video timeline: {error}"))?;
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
    Ok(())
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
                encoder
                    .send_frame(&filtered)
                    .map_err(|error| format!("Video encoding failed: {error}"))?;
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
) -> Result<(), String> {
    let mut decoded = ffmpeg::frame::Audio::empty();
    while decoder.receive_frame(&mut decoded).is_ok() {
        let timestamp = decoded.timestamp();
        decoded.set_pts(timestamp);
        filter
            .get("in")
            .ok_or_else(|| "Audio filter input disappeared.".to_owned())?
            .source()
            .add(&decoded)
            .map_err(|error| format!("Could not add audio to the timeline: {error}"))?;
        drain_audio_filter(filter, encoder, output, stream_index, output_time_base)?;
    }
    Ok(())
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
                encoder
                    .send_frame(&filtered)
                    .map_err(|error| format!("Audio encoding failed: {error}"))?;
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
        encoder.set_colorspace(if source_colorspace == ffmpeg::color::Space::Unspecified {
            ffmpeg::color::Space::BT709
        } else {
            source_colorspace
        });
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
    error == ffmpeg::Error::Eof
        || error
            == ffmpeg::Error::Other {
                errno: ffmpeg::error::EAGAIN,
            }
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
        build_audio_filter, normalize_video_packet_timestamps, render_sequence, ExportResolution,
        ExportSettings,
    };
    use crate::{media::VideoAsset, sequence::Sequence};
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
        let blank_output = temp.join(format!("kuro-export-blank-{}.mp4", std::process::id()));
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
        assert!(fs::metadata(&output).expect("export should exist").len() > 1_000);

        let remaining: Vec<_> = sequence.clips.iter().map(|clip| clip.id).collect();
        for id in remaining {
            sequence.delete(id);
        }
        render_sequence(
            &video,
            &sequence,
            &ExportSettings {
                resolution: ExportResolution::Source,
                ..ExportSettings::default()
            },
            SequenceFormat::from_video(&video),
            &blank_output,
            &AtomicU32::new(0),
            &AtomicBool::new(false),
        )
        .expect("an empty timeline should export black video and silence");
        let blank =
            VideoAsset::load(blank_output.clone()).expect("blank export should be readable");
        assert!(blank.duration >= 1.0);
        assert!(blank.has_audio);

        let _ = fs::remove_file(source);
        let _ = fs::remove_file(output);
        let _ = fs::remove_file(blank_output);
    }
}
