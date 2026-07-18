use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, TryRecvError},
        Arc,
    },
    thread,
};

use eframe::egui::Context;
use ffmpeg_next as ffmpeg;

use crate::media::{initialize_ffmpeg, rational_value, VideoAsset};

pub struct DecodedFrame {
    pub width: usize,
    pub height: usize,
    pub time: f64,
    pub rgb: Vec<u8>,
}

struct PreviewRequest {
    path: PathBuf,
    time: f64,
    fps: f64,
    width: usize,
    height: usize,
    rotation: i32,
    generation: u64,
    current_generation: Arc<AtomicU64>,
    ctx: Context,
}

impl PreviewRequest {
    fn is_current(&self) -> bool {
        self.current_generation.load(Ordering::Acquire) == self.generation
    }
}

pub struct PlaybackEngine {
    playback_rx: Option<Receiver<DecodedFrame>>,
    playback_stop: Option<Arc<AtomicBool>>,
    queued_frame: Option<DecodedFrame>,
    playback_ready: bool,
    playback_just_started: bool,
    preview_tx: mpsc::Sender<PreviewRequest>,
    preview_rx: Receiver<DecodedFrame>,
    preview_generation: Arc<AtomicU64>,
    last_preview_request: Option<(PathBuf, f64)>,
}

impl PlaybackEngine {
    pub fn new() -> Self {
        let (request_tx, request_rx) = mpsc::channel::<PreviewRequest>();
        let (frame_tx, frame_rx) = mpsc::channel();
        thread::spawn(move || preview_worker(request_rx, frame_tx));

        Self {
            playback_rx: None,
            playback_stop: None,
            queued_frame: None,
            playback_ready: false,
            playback_just_started: false,
            preview_tx: request_tx,
            preview_rx: frame_rx,
            preview_generation: Arc::new(AtomicU64::new(0)),
            last_preview_request: None,
        }
    }

    pub fn start(&mut self, video: &VideoAsset, at: f64, ctx: &Context) -> Result<(), String> {
        initialize_ffmpeg()?;
        if !video.path.is_file() {
            return Err(format!(
                "The source media is unavailable: {}",
                video.path.display()
            ));
        }
        self.stop();
        self.cancel_preview();
        let (receiver, stop) = spawn_video_decoder(video, at, ctx.clone());
        self.playback_rx = Some(receiver);
        self.playback_stop = Some(stop);

        Ok(())
    }

    pub fn stop(&mut self) {
        if let Some(stop) = self.playback_stop.take() {
            stop.store(true, Ordering::Release);
        }
        self.playback_rx = None;
        self.queued_frame = None;
        self.playback_ready = false;
        self.playback_just_started = false;
    }

    pub fn request_preview(&mut self, video: &VideoAsset, time: f64, ctx: &Context) {
        if !video.path.is_file() {
            self.clear_preview();
            return;
        }
        let frame_interval = 1.0 / video.fps.max(1.0);
        if self
            .last_preview_request
            .as_ref()
            .is_some_and(|(path, last)| {
                path == &video.path && (last - time).abs() < frame_interval * 0.45
            })
        {
            return;
        }
        self.last_preview_request = Some((video.path.clone(), time));
        let generation = self.preview_generation.fetch_add(1, Ordering::AcqRel) + 1;
        let _ = self.preview_tx.send(PreviewRequest {
            path: video.path.clone(),
            time,
            fps: video.fps,
            width: video.decode_width,
            height: video.decode_height,
            rotation: video.rotation,
            generation,
            current_generation: Arc::clone(&self.preview_generation),
            ctx: ctx.clone(),
        });
    }

    pub fn poll_preview(&mut self) -> Option<DecodedFrame> {
        let mut latest = None;
        while let Ok(frame) = self.preview_rx.try_recv() {
            latest = Some(frame);
        }
        latest
    }

    pub fn poll_playback(&mut self, clock: f64, frame_interval: f64) -> Option<DecodedFrame> {
        let Some(receiver) = &self.playback_rx else {
            return None;
        };
        let mut selected = None;

        loop {
            if let Some(frame) = self.queued_frame.take() {
                if frame.time <= clock + frame_interval * 0.55 {
                    selected = Some(frame);
                } else {
                    self.queued_frame = Some(frame);
                    break;
                }
            }

            match receiver.try_recv() {
                Ok(frame) if frame.time <= clock + frame_interval * 0.55 => selected = Some(frame),
                Ok(frame) => {
                    self.queued_frame = Some(frame);
                    break;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    self.playback_rx = None;
                    break;
                }
            }
        }
        if selected.is_some() && !self.playback_ready {
            self.playback_ready = true;
            self.playback_just_started = true;
        }
        selected
    }

    pub fn prebuffer_playback(&mut self) {
        if self.queued_frame.is_some() {
            return;
        }
        let Some(receiver) = &self.playback_rx else {
            return;
        };
        match receiver.try_recv() {
            Ok(frame) => self.queued_frame = Some(frame),
            Err(TryRecvError::Disconnected) => self.playback_rx = None,
            Err(TryRecvError::Empty) => {}
        }
    }

    #[cfg(test)]
    pub fn is_ready(&self) -> bool {
        self.playback_ready || self.queued_frame.is_some()
    }

    pub fn take_just_started(&mut self) -> bool {
        std::mem::take(&mut self.playback_just_started)
    }

    pub fn clear_preview(&mut self) {
        self.cancel_preview();
    }

    fn cancel_preview(&mut self) {
        self.preview_generation.fetch_add(1, Ordering::AcqRel);
        self.last_preview_request = None;
        while self.preview_rx.try_recv().is_ok() {}
    }
}

impl Drop for PlaybackEngine {
    fn drop(&mut self) {
        self.stop();
    }
}

fn spawn_video_decoder(
    video: &VideoAsset,
    at: f64,
    ctx: Context,
) -> (Receiver<DecodedFrame>, Arc<AtomicBool>) {
    let (sender, receiver) = mpsc::sync_channel(8);
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let path = video.path.clone();
    let width = video.decode_width;
    let height = video.decode_height;
    let rotation = video.rotation;
    let fps = video.fps;

    thread::spawn(move || {
        let result = decode_video(
            &path,
            at,
            fps,
            width,
            height,
            rotation,
            |frame| {
                if thread_stop.load(Ordering::Acquire) || sender.send(frame).is_err() {
                    return false;
                }
                ctx.request_repaint();
                true
            },
            || thread_stop.load(Ordering::Acquire),
        );
        if let Err(error) = result {
            eprintln!("Kuro video decoder stopped: {error}");
        }
    });
    (receiver, stop)
}

fn preview_worker(requests: Receiver<PreviewRequest>, frames: mpsc::Sender<DecodedFrame>) {
    while let Ok(mut request) = requests.recv() {
        while let Ok(newer) = requests.try_recv() {
            request = newer;
        }
        if let Ok(Some(frame)) = decode_preview(&request) {
            if !request.is_current() {
                continue;
            }
            if frames.send(frame).is_err() {
                break;
            }
            request.ctx.request_repaint();
        }
    }
}

fn decode_preview(request: &PreviewRequest) -> Result<Option<DecodedFrame>, String> {
    let mut chosen = None;
    decode_video(
        &request.path,
        request.time,
        request.fps,
        request.width,
        request.height,
        request.rotation,
        |frame| {
            let reached_target = frame.time + 0.5 / request.fps.max(1.0) >= request.time;
            chosen = Some(frame);
            !reached_target
        },
        || !request.is_current(),
    )?;
    Ok(chosen)
}

#[allow(clippy::too_many_arguments)]
fn decode_video<F, C>(
    path: &Path,
    at: f64,
    fps: f64,
    output_width: usize,
    output_height: usize,
    rotation: i32,
    mut on_frame: F,
    mut cancelled: C,
) -> Result<(), String>
where
    F: FnMut(DecodedFrame) -> bool,
    C: FnMut() -> bool,
{
    initialize_ffmpeg()?;
    if cancelled() {
        return Ok(());
    }
    let mut input = ffmpeg::format::input(path)
        .map_err(|error| format!("could not open video input: {error}"))?;
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or_else(|| "no video stream was found".to_owned())?;
    let stream_index = stream.index();
    let time_base = rational_value(stream.time_base());
    let mut context = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
        .map_err(|error| format!("could not configure video decoder: {error}"))?;
    enable_hardware_decoding(&mut context);
    let mut decoder = context
        .decoder()
        .video()
        .map_err(|error| format!("could not open video decoder: {error}"))?;
    let mut scaler = None;

    if at > 0.0 {
        let target = (at * 1_000_000.0).round() as i64;
        input
            .seek(target, ..target)
            .map_err(|error| format!("video seek failed: {error}"))?;
        decoder.flush();
    }

    let mut fallback_index = 0_u64;
    for (stream, packet) in input.packets() {
        if cancelled() {
            return Ok(());
        }
        if stream.index() != stream_index {
            continue;
        }
        decoder
            .send_packet(&packet)
            .map_err(|error| format!("video packet failed: {error}"))?;
        if !drain_video_frames(
            &mut decoder,
            &mut scaler,
            time_base,
            at,
            fps,
            output_width,
            output_height,
            rotation,
            &mut fallback_index,
            &mut on_frame,
            &mut cancelled,
        )? {
            return Ok(());
        }
    }
    let _ = decoder.send_eof();
    let _ = drain_video_frames(
        &mut decoder,
        &mut scaler,
        time_base,
        at,
        fps,
        output_width,
        output_height,
        rotation,
        &mut fallback_index,
        &mut on_frame,
        &mut cancelled,
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn drain_video_frames<F, C>(
    decoder: &mut ffmpeg::decoder::Video,
    scaler: &mut Option<ffmpeg::software::scaling::Context>,
    time_base: f64,
    requested_start: f64,
    fps: f64,
    output_width: usize,
    output_height: usize,
    rotation: i32,
    fallback_index: &mut u64,
    on_frame: &mut F,
    cancelled: &mut C,
) -> Result<bool, String>
where
    F: FnMut(DecodedFrame) -> bool,
    C: FnMut() -> bool,
{
    let mut decoded = ffmpeg::frame::Video::empty();
    while decoder.receive_frame(&mut decoded).is_ok() {
        if cancelled() {
            return Ok(false);
        }
        let time = decoded
            .timestamp()
            .map(|timestamp| timestamp as f64 * time_base)
            .unwrap_or(requested_start + *fallback_index as f64 / fps.max(1.0));
        *fallback_index += 1;
        if time + 0.5 / fps.max(1.0) < requested_start {
            continue;
        }

        let mut transferred = ffmpeg::frame::Video::empty();
        let source = if is_hardware_frame(&decoded) {
            let result = unsafe {
                ffmpeg::ffi::av_hwframe_transfer_data(transferred.as_mut_ptr(), decoded.as_ptr(), 0)
            };
            if result < 0 {
                return Err(format!(
                    "hardware frame transfer failed: {:?}",
                    ffmpeg::Error::from(result)
                ));
            }
            &transferred
        } else {
            &decoded
        };
        let input_changed = scaler.as_ref().is_none_or(|context| {
            context.input().format != source.format()
                || context.input().width != source.width()
                || context.input().height != source.height()
        });
        if input_changed {
            let rotated = rotation.rem_euclid(180) != 0;
            *scaler = Some(
                ffmpeg::software::scaling::Context::get(
                    source.format(),
                    source.width(),
                    source.height(),
                    ffmpeg::format::Pixel::RGB24,
                    if rotated {
                        output_height as u32
                    } else {
                        output_width as u32
                    },
                    if rotated {
                        output_width as u32
                    } else {
                        output_height as u32
                    },
                    ffmpeg::software::scaling::Flags::LANCZOS
                        | ffmpeg::software::scaling::Flags::ACCURATE_RND,
                )
                .map_err(|error| format!("could not create video scaler: {error}"))?,
            );
        }
        let scaler = scaler
            .as_mut()
            .ok_or_else(|| "video scaler was not initialized".to_owned())?;
        let mut scaled = ffmpeg::frame::Video::empty();
        scaler
            .run(source, &mut scaled)
            .map_err(|error| format!("video conversion failed: {error}"))?;
        let packed = copy_rgb_rows(&scaled);
        let rgb = rotate_rgb(
            packed,
            scaled.width() as usize,
            scaled.height() as usize,
            rotation,
        );
        if !on_frame(DecodedFrame {
            width: output_width,
            height: output_height,
            time,
            rgb,
        }) {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(target_os = "macos")]
fn enable_hardware_decoding(context: &mut ffmpeg::codec::context::Context) {
    unsafe {
        let mut device = std::ptr::null_mut();
        let result = ffmpeg::ffi::av_hwdevice_ctx_create(
            &mut device,
            ffmpeg::ffi::AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX,
            std::ptr::null(),
            std::ptr::null_mut(),
            0,
        );
        if result >= 0 && !device.is_null() {
            (*context.as_mut_ptr()).hw_device_ctx = device;
            (*context.as_mut_ptr()).get_format = Some(select_hardware_format);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn enable_hardware_decoding(_context: &mut ffmpeg::codec::context::Context) {}

#[cfg(target_os = "macos")]
unsafe extern "C" fn select_hardware_format(
    _context: *mut ffmpeg::ffi::AVCodecContext,
    formats: *const ffmpeg::ffi::AVPixelFormat,
) -> ffmpeg::ffi::AVPixelFormat {
    let mut current = formats;
    let fallback = *current;
    while *current != ffmpeg::ffi::AVPixelFormat::AV_PIX_FMT_NONE {
        if *current == ffmpeg::ffi::AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX {
            return *current;
        }
        current = current.add(1);
    }
    fallback
}

fn is_hardware_frame(frame: &ffmpeg::frame::Video) -> bool {
    unsafe { !(*frame.as_ptr()).hw_frames_ctx.is_null() }
}

fn copy_rgb_rows(frame: &ffmpeg::frame::Video) -> Vec<u8> {
    let row_bytes = frame.width() as usize * 3;
    let mut packed = Vec::with_capacity(row_bytes * frame.height() as usize);
    let data = frame.data(0);
    let stride = frame.stride(0);
    for row in 0..frame.height() as usize {
        let start = row * stride;
        packed.extend_from_slice(&data[start..start + row_bytes]);
    }
    packed
}

fn rotate_rgb(source: Vec<u8>, width: usize, height: usize, rotation: i32) -> Vec<u8> {
    match rotation.rem_euclid(360) {
        90 => {
            let mut output = vec![0; source.len()];
            for y in 0..height {
                for x in 0..width {
                    copy_pixel(&source, &mut output, width, height, x, y, height - 1 - y, x);
                }
            }
            output
        }
        180 => {
            let mut output = vec![0; source.len()];
            for y in 0..height {
                for x in 0..width {
                    copy_pixel(
                        &source,
                        &mut output,
                        width,
                        width,
                        x,
                        y,
                        width - 1 - x,
                        height - 1 - y,
                    );
                }
            }
            output
        }
        270 => {
            let mut output = vec![0; source.len()];
            for y in 0..height {
                for x in 0..width {
                    copy_pixel(&source, &mut output, width, height, x, y, y, width - 1 - x);
                }
            }
            output
        }
        _ => source,
    }
}

#[allow(clippy::too_many_arguments)]
fn copy_pixel(
    source: &[u8],
    output: &mut [u8],
    source_width: usize,
    output_width: usize,
    source_x: usize,
    source_y: usize,
    output_x: usize,
    output_y: usize,
) {
    let source_index = (source_y * source_width + source_x) * 3;
    let output_index = (output_y * output_width + output_x) * 3;
    output[output_index..output_index + 3].copy_from_slice(&source[source_index..source_index + 3]);
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        process::Command,
        sync::{
            atomic::{AtomicU64, Ordering},
            mpsc, Arc,
        },
        thread,
        time::Duration,
    };

    use super::{
        decode_preview, preview_worker, rotate_rgb, spawn_video_decoder, PlaybackEngine,
        PreviewRequest,
    };
    use crate::media::VideoAsset;

    #[test]
    fn rotates_rgb_frames_without_changing_pixel_data() {
        let source = vec![1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0, 5, 0, 0, 6, 0, 0];
        let rotated = rotate_rgb(source, 2, 3, 90);
        let values: Vec<u8> = rotated.chunks_exact(3).map(|pixel| pixel[0]).collect();
        assert_eq!(values, vec![5, 3, 1, 6, 4, 2]);
    }

    #[test]
    fn decodes_preview_and_continuous_playback_frames_in_process() {
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let path =
            std::env::temp_dir().join(format!("kuro-playback-test-{}.mkv", std::process::id()));
        let generated = Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=640x360:rate=24",
                "-t",
                "0.5",
                "-c:v",
                "ffv1",
            ])
            .arg(&path)
            .status()
            .expect("test video should be generated");
        assert!(generated.success());

        let asset = VideoAsset::load(path.clone()).expect("test video should be probed");
        let ctx = eframe::egui::Context::default();
        let preview_generation = Arc::new(AtomicU64::new(1));
        let preview = decode_preview(&PreviewRequest {
            path: path.clone(),
            time: 0.2,
            fps: asset.fps,
            width: asset.decode_width,
            height: asset.decode_height,
            rotation: asset.rotation,
            generation: 1,
            current_generation: Arc::clone(&preview_generation),
            ctx: ctx.clone(),
        })
        .expect("preview decode should run")
        .expect("preview should decode");
        assert_eq!(preview.rgb.len(), preview.width * preview.height * 3);

        let (receiver, stop) = spawn_video_decoder(&asset, 0.0, ctx.clone());
        let first = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("first playback frame should arrive");
        let second = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("second playback frame should arrive");
        assert!(second.time > first.time);
        assert_eq!(first.rgb.len(), first.width * first.height * 3);

        stop.store(true, std::sync::atomic::Ordering::Release);
        drop(receiver);

        let (request_tx, request_rx) = mpsc::channel();
        let (frame_tx, frame_rx) = mpsc::channel();
        let worker = thread::spawn(move || preview_worker(request_rx, frame_tx));
        preview_generation.store(2, Ordering::Release);
        request_tx
            .send(PreviewRequest {
                path: path.clone(),
                time: 0.05,
                fps: asset.fps,
                width: asset.decode_width,
                height: asset.decode_height,
                rotation: asset.rotation,
                generation: 1,
                current_generation: Arc::clone(&preview_generation),
                ctx: ctx.clone(),
            })
            .expect("stale request should be queued");
        request_tx
            .send(PreviewRequest {
                path: path.clone(),
                time: 0.35,
                fps: asset.fps,
                width: asset.decode_width,
                height: asset.decode_height,
                rotation: asset.rotation,
                generation: 2,
                current_generation: Arc::clone(&preview_generation),
                ctx,
            })
            .expect("latest request should be queued");
        let latest = frame_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("latest preview should arrive");
        assert!((latest.time - 0.35).abs() <= 1.5 / asset.fps);
        assert!(frame_rx.try_recv().is_err());
        drop(request_tx);
        worker.join().expect("preview worker should stop");
        let _ = fs::remove_file(path);
        let mut playback = PlaybackEngine::new();
        let error = playback
            .start(&asset, 0.0, &eframe::egui::Context::default())
            .expect_err("missing media should fail before a worker is spawned");
        assert!(error.contains("source media is unavailable"));
    }
}
