//! A chunk's video file written by FFmpeg, off macOS: what `mac_media::Writer`
//! (AVAssetWriter on the media engine) is to a Mac, with the same calls, so a
//! chunked export (`chunks.rs`) runs the same everywhere. Frames go in as RGBA
//! on FFmpeg's stdin; it converts them to BT.709 TV-range 4:2:0 as every
//! FFmpeg export does (`export::video_graph`) and encodes them on NVENC where an
//! NVIDIA card answers, else with libx264, at the bitrate the export asks.

use std::io::{BufWriter, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};

use crate::render::Order;

#[derive(Clone, Copy, Debug)]
pub struct WriterOptions {
    pub hevc: bool,
    pub bitrate: u64,
    pub key_interval: i32,
    /// A finished export (as on a Mac: kept for the same settings).
    pub finished: bool,
    /// The index at the front of the file; only when nothing remuxes it after.
    pub faststart: bool,
}

pub struct Writer {
    child: Child,
    stdin: Option<BufWriter<ChildStdin>>,
    stderr: Option<std::thread::JoinHandle<String>>,
    width: u32,
    height: u32,
    written: i64,
}

/// FFmpeg's `-framerate` for `fps`: NTSC rates as their exact fraction.
fn rate(fps: f64) -> String {
    let ntsc = (fps * 1001.0).round();
    if (fps - fps.round()).abs() > 1e-6 && (ntsc / 1001.0 - fps).abs() < 1e-6 {
        format!("{}/1001", ntsc as i64)
    } else {
        format!("{}", fps.round() as i64)
    }
}

impl Writer {
    pub fn open(
        path: &Path,
        width: u32,
        height: u32,
        fps: f64,
        options: WriterOptions,
    ) -> Result<Self, String> {
        let encoders = crate::export::encoders();
        let mut command = Command::new(crate::util::ffmpeg());
        command
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgba",
                "-s",
                &format!("{width}x{height}"),
                "-framerate",
                &rate(fps),
                "-i",
                "pipe:0",
                "-vf",
                "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
            ])
            .args(if encoders.nvenc {
                crate::export::nvenc_args(options.hevc, options.bitrate)
            } else {
                let rate = options.bitrate.to_string();
                let buffer = (options.bitrate * 2).to_string();
                [
                    "-c:v",
                    if options.hevc { "libx265" } else { "libx264" },
                    "-preset",
                    "medium",
                    "-b:v",
                    &rate,
                    "-maxrate",
                    &rate,
                    "-bufsize",
                    &buffer,
                ]
                .map(str::to_owned)
                .to_vec()
            })
            .args([
                "-g",
                &options.key_interval.max(1).to_string(),
                "-colorspace",
                "bt709",
                "-color_primaries",
                "bt709",
                "-color_trc",
                "bt709",
                "-color_range",
                "tv",
            ])
            .args(if options.hevc { &["-tag:v", "hvc1"][..] } else { &[] })
            .args(if options.faststart { &["-movflags", "+faststart"][..] } else { &[] })
            .args(["-threads", "2", "-f", "mp4"])
            .arg(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| format!("ffmpeg: {error}"))?;
        let stdin = child.stdin.take().ok_or("ffmpeg stdin")?;
        let stderr = child.stderr.take().map(|mut stderr| {
            std::thread::spawn(move || {
                let mut text = String::new();
                let _ = stderr.read_to_string(&mut text);
                text
            })
        });
        Ok(Self {
            child,
            stdin: Some(BufWriter::with_capacity(1 << 20, stdin)),
            stderr,
            width,
            height,
            written: 0,
        })
    }

    /// Frame `index` of the file (rows `stride` bytes apart), in order.
    pub fn frame(
        &mut self,
        index: i64,
        pixels: &[u8],
        stride: usize,
        order: Order,
    ) -> Result<(), String> {
        if order != Order::Rgba {
            return Err("the chunk writer takes RGBA".to_owned());
        }
        if index != self.written {
            return Err(format!("frame {index} came after {}", self.written - 1));
        }
        let stdin = self.stdin.as_mut().ok_or("the encoder was finished")?;
        let row = self.width as usize * 4;
        let mut sent = Ok(());
        for line in pixels.chunks(stride).take(self.height as usize) {
            sent = match line.get(..row) {
                Some(line) => stdin.write_all(line).map_err(|_| "the encoder stopped early"),
                None => Err("GPU readback came back short"),
            };
            if sent.is_err() {
                break;
            }
        }
        if let Err(what) = sent {
            return Err(self.failed(what));
        }
        self.written += 1;
        Ok(())
    }

    /// Ends the file at `frames` frames; FFmpeg's own error when it failed.
    pub fn finish(&mut self, frames: i64) -> Result<(), String> {
        if frames != self.written {
            return Err(format!("{} frames written, not {frames}", self.written));
        }
        if let Some(mut stdin) = self.stdin.take() {
            stdin
                .flush()
                .map_err(|_| self.failed("the encoder stopped early"))?;
        }
        let status = self.child.wait().map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(self.failed("the encoder failed"))
        }
    }

    /// `what`, with FFmpeg's last words when it has said any.
    fn failed(&mut self, what: &str) -> String {
        self.stdin = None;
        let _ = self.child.wait();
        let said = self
            .stderr
            .take()
            .and_then(|thread| thread.join().ok())
            .and_then(|text| text.lines().rev().find(|line| !line.trim().is_empty()).map(str::to_owned));
        match said {
            Some(line) => format!("{what}: {line}"),
            None => what.to_owned(),
        }
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        // Cut short (cancelled, or the chunk failed): FFmpeg is stopped, its partial file is the caller's to remove.
        if self.stdin.take().is_some() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}
