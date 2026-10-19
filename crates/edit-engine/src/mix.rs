//! The export's sound, mixed here rather than by one FFmpeg graph with an
//! input per clip (which opened every clip's file and ran every stream the
//! whole length: minutes and gigabytes for an edit with hundreds of clips).
//!
//! Each heard clip is decoded for its own stretch only (AVFoundation on the
//! Mac; FFmpeg for other files, for clips at another speed (atempo) and on
//! other systems), its mutes, volume and fades applied exactly as the FFmpeg
//! graph did (`edit_core::mute_gain`'s cosine ramps on the source's clock,
//! afade's linear ramps on the clip's), and summed in a few seconds' window
//! at a time, so memory stays flat however long the edit is. Loudness
//! normalisation measures the whole mix (EBU R128) and applies one gain kept
//! under a -1 dBTP true peak. FFmpeg encodes the result once.

#[cfg(target_os = "macos")]
use std::collections::HashMap;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[cfg(any(target_os = "macos", test))]
use edit_core::{mute_gain, Mute};
use edit_core::{AudioSegment, MUTE_FADE_SECONDS};

pub const RATE: usize = 48_000;
/// Frames mixed at a time (4 s: 1.5 MB of stereo float).
const WINDOW: usize = RATE * 4;

/// One heard clip cut to the export's span.
#[derive(Clone, Debug)]
pub struct Part {
    pub path: PathBuf,
    /// `start` is seconds into the span and `duration` what plays of it;
    /// `source_in` is where that starts in the source.
    pub segment: AudioSegment,
    /// Seconds of the clip already played before the span: fades run on the clip's own clock.
    pub elapsed: f64,
    /// The whole clip's length on the timeline.
    pub original: f64,
}

/// `segments` (timeline seconds) cut to the span `[offset, offset + seconds)`.
pub fn parts(
    segments: &[AudioSegment],
    path: impl Fn(&str) -> Option<PathBuf>,
    offset: f64,
    seconds: f64,
) -> Vec<Part> {
    segments
        .iter()
        .filter_map(|original| {
            let from = original.start.max(offset);
            let to = (original.start + original.duration).min(offset + seconds);
            if to <= from {
                return None;
            }
            let elapsed = from - original.start;
            let mut segment = original.clone();
            segment.source_in += elapsed * segment.speed;
            segment.start = (from - offset).max(0.0);
            segment.duration = to - from;
            Some(Part {
                path: path(&original.media)?,
                segment,
                elapsed,
                original: original.duration,
            })
        })
        .collect()
}

/// The gain of a clip's fades at `time` seconds into it (as FFmpeg's afade:
/// linear ramps from the clip's start and to its end); volume is applied apart.
///
/// This is the reference for a sound's fades: the preview's gain automation
/// (apps/web playback.ts) computes the same `time / fade` and
/// `(length - time) / fade` in seconds and multiplies them, as here. Picture
/// fades (`edit_core::eval`'s `fade_factor`) differ on purpose: they count
/// whole frames (`(local + 1) / (fade + 1)`) and take the lower of the two
/// where a fade in and a fade out overlap, rather than multiplying.
fn fade_gain(segment: &AudioSegment, original: f64, time: f64) -> f32 {
    let mut gain = 1.0;
    if segment.fade_in > 0.0 {
        gain *= (time / segment.fade_in).clamp(0.0, 1.0);
    }
    if segment.fade_out > 0.0 {
        gain *= ((original - time) / segment.fade_out).clamp(0.0, 1.0);
    }
    gain as f32
}

/// `,aeval=…` silencing a segment's mutes sample by sample, each ramped over
/// MUTE_FADE_SECONDS with a cosine (as `edit_core::mute_gain`); None without
/// any in the part it plays. Times are from the start of the decoded stretch.
pub(crate) fn mute_filter(segment: &AudioSegment) -> Option<String> {
    let fade = MUTE_FADE_SECONDS;
    let length = segment.duration * segment.speed;
    let gains: Vec<String> = segment
        .mutes
        .iter()
        .map(|mute| (mute.from - segment.source_in, mute.to - segment.source_in))
        .filter(|&(from, to)| to > -fade && from < length + fade)
        .map(|(from, to)| {
            format!("if(between(t,{:.6},{:.6}),(1-cos(PI*min(max(max(({from:.6})-t,t-({to:.6})),0)/{fade:.6},1)))/2,1)", from-fade, to+fade)
        })
        .collect();
    let gain = gains
        .into_iter()
        .reduce(|all, next| format!("min({all},{next})"))?;
    // c=same keeps the stereo layout, which encoders (AAC) need named.
    Some(format!(",aeval=exprs='val(0)*{gain}|val(1)*{gain}':c=same"))
}

/// The FFmpeg chain decoding a stretch already sought to its `source_in`:
/// format, length, mutes and tempo (volume and fades are applied in the mix).
fn decode_chain(segment: &AudioSegment) -> String {
    let mut sought = segment.clone();
    sought.source_in = 0.0;
    for mute in &mut sought.mutes {
        mute.from -= segment.source_in;
        mute.to -= segment.source_in;
    }
    let mut chain = format!(
        "aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=stereo,atrim=duration={:.6}",
        segment.duration * segment.speed
    );
    if let Some(mute) = mute_filter(&sought) {
        chain.push_str(&mute);
    }
    let mut tempo = segment.speed;
    while (tempo - 1.0).abs() > 1e-6 {
        let step = tempo.clamp(0.5, 2.0);
        chain.push_str(&format!(",atempo={step:.6}"));
        tempo /= step;
    }
    chain
}

trait Source {
    /// Fills `out` (interleaved stereo); returns the frames written, 0 at the end.
    fn read(&mut self, out: &mut [f32]) -> Result<usize, String>;
}

/// A stretch decoded by AVFoundation, its mutes applied here on the source's clock.
#[cfg(target_os = "macos")]
struct NativeSource {
    reader: crate::mac_media::SoundReader,
    mutes: Vec<Mute>,
    /// Source seconds of the next frame.
    time: f64,
}

#[cfg(target_os = "macos")]
impl Source for NativeSource {
    fn read(&mut self, out: &mut [f32]) -> Result<usize, String> {
        let frames = self.reader.read(out)?;
        let (from, to) = (self.time, self.time + frames as f64 / RATE as f64);
        let fade = MUTE_FADE_SECONDS;
        let near: Vec<Mute> = self
            .mutes
            .iter()
            .filter(|mute| mute.to + fade > from && mute.from - fade < to)
            .copied()
            .collect();
        if !near.is_empty() {
            for (index, frame) in out
                .as_chunks_mut::<2>()
                .0
                .iter_mut()
                .take(frames)
                .enumerate()
            {
                let gain = mute_gain(&near, from + index as f64 / RATE as f64) as f32;
                for sample in frame {
                    *sample *= gain;
                }
            }
        }
        self.time = to;
        Ok(frames)
    }
}

/// A stretch decoded by FFmpeg (other formats, other speeds, other systems).
/// Its end is checked: a decoder that failed (a missing or broken file) is an
/// error, never a stretch of silence in an export that looks fine.
struct FfmpegSource {
    child: crate::util::Watched,
    stdout: BufReader<ChildStdout>,
    /// FFmpeg's complaints, read as they come (so a full pipe never blocks it).
    stderr: Option<std::thread::JoinHandle<String>>,
    path: PathBuf,
    ended: bool,
    bytes: Vec<u8>,
}

impl FfmpegSource {
    fn open(path: &Path, segment: &AudioSegment) -> Result<Self, String> {
        let mut child = Command::new(crate::util::ffmpeg())
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-threads",
                "1",
            ])
            .args(["-ss", &format!("{:.6}", segment.source_in)])
            .args([
                "-t",
                &format!("{:.6}", segment.duration * segment.speed + 0.05),
            ])
            .args(["-protocol_whitelist", crate::util::protocols(path)])
            .args(crate::util::url_args(path))
            .arg("-i")
            .arg(path)
            .args([
                "-vn",
                "-af",
                &decode_chain(segment),
                "-f",
                "f32le",
                "pipe:1",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("ffmpeg: {error}"))?;
        let stdout = child.stdout.take().ok_or("ffmpeg stdout")?;
        let stderr = child.stderr.take().map(|mut pipe| {
            std::thread::spawn(move || {
                let mut text = String::new();
                let _ = pipe.read_to_string(&mut text);
                text
            })
        });
        Ok(Self {
            child: crate::util::Watched::new(child),
            stdout: BufReader::with_capacity(1 << 16, stdout),
            stderr,
            path: path.to_owned(),
            ended: false,
            bytes: Vec::new(),
        })
    }

    /// At the end of its output: whether FFmpeg finished or failed.
    fn finish(&mut self) -> Result<(), String> {
        if self.ended {
            return Ok(());
        }
        self.ended = true;
        let status = self.child.wait().map_err(|error| error.to_string())?;
        if status.success() {
            return Ok(());
        }
        let stderr = self
            .stderr
            .take()
            .and_then(|thread| thread.join().ok())
            .unwrap_or_default();
        let why = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .map_or_else(|| status.to_string(), |line| line.trim().to_owned());
        Err(format!(
            "could not decode the sound of {}: {why}",
            self.path.display()
        ))
    }
}

impl Source for FfmpegSource {
    fn read(&mut self, out: &mut [f32]) -> Result<usize, String> {
        self.bytes.resize(out.len() * 4, 0);
        let mut filled = 0;
        while filled < self.bytes.len() {
            match self
                .stdout
                .read(self.bytes.get_mut(filled..).unwrap_or_default())
            {
                Ok(0) => {
                    self.finish()?;
                    break;
                }
                Ok(n) => filled += n,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(error) => return Err(format!("decoding sound: {error}")),
            }
        }
        let frames = filled / 8;
        for (sample, bytes) in out
            .iter_mut()
            .zip(self.bytes.as_chunks::<4>().0)
            .take(frames * 2)
        {
            *sample = f32::from_le_bytes(*bytes);
        }
        Ok(frames)
    }
}

/// A part's volume, sampled once a frame from its keyframes and ramped
/// linearly between (`AudioSegment::volume_at`), without solving the curve
/// for every sample.
struct Volume<'a> {
    segment: &'a AudioSegment,
    /// The frame (into the clip) the gains below are for, and its gain and the next frame's.
    below: f64,
    from: f32,
    to: f32,
}

impl<'a> Volume<'a> {
    fn new(segment: &'a AudioSegment) -> Self {
        let gain = segment.volume_at(0.0);
        Self {
            segment,
            below: f64::NAN,
            from: gain,
            to: gain,
        }
    }

    /// The gain `time` seconds into the clip.
    fn at(&mut self, time: f64) -> f32 {
        if self.segment.volume_keys.is_empty() {
            return self.from;
        }
        let frame = time * self.segment.fps;
        let below = frame.floor();
        if below != self.below {
            let gain = |frame: f64| 10_f32.powf(self.segment.volume_db_at(frame as f32) / 20.0);
            self.below = below;
            self.from = gain(below);
            self.to = gain(below + 1.0);
        }
        self.from + (self.to - self.from) * (frame - below) as f32
    }
}

/// Opens the decoder for a part: native at speed 1 where AVFoundation reads
/// the file, FFmpeg otherwise.
struct Sources {
    native: bool,
    /// Each file's sound, opened once (None: AVFoundation can't read it).
    #[cfg(target_os = "macos")]
    sounds: HashMap<PathBuf, Option<crate::mac_media::Sound>>,
}

impl Sources {
    fn new(native: bool) -> Self {
        Self {
            native,
            #[cfg(target_os = "macos")]
            sounds: HashMap::new(),
        }
    }

    fn open(&mut self, part: &Part) -> Result<Box<dyn Source>, String> {
        let segment = &part.segment;
        #[cfg(target_os = "macos")]
        // AVFoundation only reads local files: a cloud original's URL is FFmpeg's.
        if self.native && (segment.speed - 1.0).abs() < 1e-9 && !crate::util::is_url(&part.path) {
            let sound = self.sounds.entry(part.path.clone()).or_insert_with(|| {
                crate::mac_media::Sound::open(&part.path)
                    .map_err(|error| {
                        crate::log::warn(
                            "export",
                            format!(
                                "native sound of {}: {error}; using FFmpeg",
                                part.path.display()
                            ),
                        );
                    })
                    .ok()
            });
            if let Some(sound) = sound {
                match sound.stretch(segment.source_in, segment.duration) {
                    Ok(reader) => {
                        return Ok(Box::new(NativeSource {
                            reader,
                            mutes: segment.mutes.clone(),
                            time: segment.source_in,
                        }))
                    }
                    Err(error) => crate::log::warn(
                        "export",
                        format!(
                            "native sound of {} at {:.2}s: {error}; using FFmpeg",
                            part.path.display(),
                            segment.source_in
                        ),
                    ),
                }
            }
        }
        Ok(Box::new(FfmpegSource::open(&part.path, segment)?))
    }
}

struct Active {
    part: usize,
    source: Box<dyn Source>,
    /// Output frames the part covers, `[first, end)`, and the next one to mix.
    first: usize,
    end: usize,
    next: usize,
}

/// Mixes `parts` into `total` frames of 48 kHz stereo float, handing each
/// window to `sink` in order.
pub fn mix(
    parts: &[Part],
    total: usize,
    cancel: &AtomicBool,
    progress: impl FnMut(f32),
    sink: impl FnMut(&[f32]) -> Result<(), String>,
) -> Result<(), String> {
    // EDIT_FFMPEG_AUDIO=1 decodes everything with FFmpeg, for diagnosis.
    let native = std::env::var_os("EDIT_FFMPEG_AUDIO").is_none();
    mix_with(Sources::new(native), parts, total, cancel, progress, sink)
}

fn mix_with(
    mut sources: Sources,
    parts: &[Part],
    total: usize,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f32),
    mut sink: impl FnMut(&[f32]) -> Result<(), String>,
) -> Result<(), String> {
    let frame_of = |seconds: f64| ((seconds * RATE as f64).round().max(0.0) as usize).min(total);
    let mut order: Vec<usize> = (0..parts.len()).collect();
    order.sort_by(|a, b| {
        let start = |index: usize| parts.get(index).map_or(0.0, |part| part.segment.start);
        start(*a).total_cmp(&start(*b))
    });
    let mut waiting = order.into_iter().peekable();
    let mut active: Vec<Active> = Vec::new();
    let mut window = vec![0.0_f32; WINDOW * 2];
    let mut scratch = vec![0.0_f32; WINDOW * 2];
    let mut from = 0;
    let (mut opening, mut reading, mut opened) = (Duration::ZERO, Duration::ZERO, 0);
    while from < total {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".to_owned());
        }
        let to = (from + WINDOW).min(total);
        while let Some(&index) = waiting.peek() {
            let Some(part) = parts.get(index) else {
                waiting.next();
                continue;
            };
            let first = frame_of(part.segment.start);
            if first >= to {
                break;
            }
            waiting.next();
            let end = frame_of(part.segment.start + part.segment.duration);
            if end > first {
                let started = Instant::now();
                let source = sources.open(part)?;
                opening += started.elapsed();
                opened += 1;
                active.push(Active {
                    part: index,
                    source,
                    first,
                    end,
                    next: first,
                });
            }
        }
        let out = window.get_mut(..(to - from) * 2).unwrap_or_default();
        out.fill(0.0);
        for sound in &mut active {
            let (start, stop) = (sound.next.max(from), sound.end.min(to));
            if start >= stop {
                continue;
            }
            let Some(part) = parts.get(sound.part) else {
                continue;
            };
            let wanted = stop - start;
            let buffer = scratch.get_mut(..wanted * 2).unwrap_or_default();
            let mut got = 0;
            let started = Instant::now();
            while got < wanted {
                let n = sound
                    .source
                    .read(buffer.get_mut(got * 2..).unwrap_or_default())?;
                if n == 0 {
                    break;
                }
                got += n;
            }
            reading += started.elapsed();
            // A source that ends early (a clip past its file's end) is silent after.
            buffer.get_mut(got * 2..).unwrap_or_default().fill(0.0);
            let offset = start - from;
            let mut volume = Volume::new(&part.segment);
            for (index, (frame, mixed)) in buffer
                .as_chunks::<2>()
                .0
                .iter()
                .zip(
                    out.get_mut(offset * 2..)
                        .unwrap_or_default()
                        .as_chunks_mut::<2>()
                        .0
                        .iter_mut(),
                )
                .enumerate()
            {
                let time = part.elapsed + (start - sound.first + index) as f64 / RATE as f64;
                let gain = volume.at(time) * fade_gain(&part.segment, part.original, time);
                for (value, sample) in mixed.iter_mut().zip(frame) {
                    *value += sample * gain;
                }
            }
            sound.next = stop;
        }
        active.retain(|sound| sound.next < sound.end);
        sink(out)?;
        from = to;
        progress(from as f32 / total.max(1) as f32);
    }
    crate::log::info(
        "export",
        format!(
            "mixed {opened} sounds: {} opening them, {} decoding",
            crate::log::human(opening),
            crate::log::human(reading)
        ),
    );
    Ok(())
}

/// The gain (dB) bringing a mix measured at `integrated` LUFS with a true
/// peak of `peak` (linear) to `target`, held so the peak stays under the ceiling.
pub fn normalising_gain(integrated: f64, target: f64) -> f64 {
    if !integrated.is_finite() {
        return 0.0;
    }
    // Peaks are the limiter's job: capping the gain at the loudest one let a
    // single hit hold a whole video several LU under the target.
    (target - integrated).clamp(-30.0, 40.0)
}

/// Sample-peak ceiling the limiter holds (dBFS): under -1 dBTP with
/// room for peaks between samples and for the encoder.
const LIMIT_CEILING_DB: f32 = -2.0;
/// The limiter's look-ahead (and its attack): 5 ms.
const LIMIT_LOOK: usize = RATE / 200;
/// How quickly it lets go after a peak (time constant, seconds).
const LIMIT_RELEASE: f32 = 0.1;

/// A look-ahead peak limiter, streaming (constant memory however long the
/// mix): each frame's gain is the lowest any frame in the look-ahead needs,
/// averaged over the look-ahead (so it ramps down before a peak and every
/// peak still lands under the ceiling), recovering over ~100 ms. Delays the
/// sound by `LIMIT_LOOK - 1` frames, which `finish` gives back.
pub struct Limiter {
    ceiling: f32,
    release: f32,
    /// Frames waiting for their gain.
    delay: std::collections::VecDeque<[f32; 2]>,
    /// (frame, gain it needs), increasing gains: the window's minimum first.
    mins: std::collections::VecDeque<(usize, f32)>,
    /// The last LIMIT_LOOK window minimums, and their sum.
    boxed: std::collections::VecDeque<f32>,
    sum: f64,
    gain: f32,
    frame: usize,
    /// Frames turned down, and the deepest reduction (linear gain).
    pub limited: usize,
    pub deepest: f32,
}

impl Default for Limiter {
    fn default() -> Self {
        Self {
            ceiling: 10_f32.powf(LIMIT_CEILING_DB / 20.0),
            release: 1.0 - (-1.0 / (LIMIT_RELEASE * RATE as f32)).exp(),
            delay: std::collections::VecDeque::with_capacity(LIMIT_LOOK + 1),
            mins: std::collections::VecDeque::new(),
            boxed: std::collections::VecDeque::with_capacity(LIMIT_LOOK + 1),
            sum: 0.0,
            gain: 1.0,
            frame: 0,
            limited: 0,
            deepest: 1.0,
        }
    }
}

impl Limiter {
    /// Takes interleaved stereo frames, appends the limited ones ready so far to `out`.
    pub fn process(&mut self, samples: &[f32], out: &mut Vec<f32>) {
        for frame in samples.as_chunks::<2>().0 {
            self.push(*frame, out);
        }
    }

    /// The frames still held back (the look-ahead's worth).
    pub fn finish(&mut self, out: &mut Vec<f32>) {
        for _ in 1..LIMIT_LOOK {
            self.push([0.0, 0.0], out);
        }
    }

    fn push(&mut self, frame: [f32; 2], out: &mut Vec<f32>) {
        let [left, right] = frame;
        let peak = left.abs().max(right.abs());
        let needs = if peak > self.ceiling {
            self.ceiling / peak
        } else {
            1.0
        };
        // The lowest gain any frame in the trailing look-ahead needs.
        while self.mins.back().is_some_and(|(_, gain)| *gain >= needs) {
            self.mins.pop_back();
        }
        self.mins.push_back((self.frame, needs));
        while self
            .mins
            .front()
            .is_some_and(|(at, _)| *at + LIMIT_LOOK <= self.frame)
        {
            self.mins.pop_front();
        }
        let lowest = self.mins.front().map_or(1.0, |(_, gain)| *gain);
        // Averaged over the look-ahead: every average covering a peak's frame is at most its need.
        self.boxed.push_back(lowest);
        self.sum += f64::from(lowest);
        if self.boxed.len() > LIMIT_LOOK {
            self.sum -= f64::from(self.boxed.pop_front().unwrap_or(1.0));
        }
        self.delay.push_back(frame);
        self.frame += 1;
        if self.delay.len() < LIMIT_LOOK {
            return;
        }
        let smooth = (self.sum / LIMIT_LOOK as f64) as f32;
        // Down at once, back up gently.
        self.gain = smooth.min(self.gain + (1.0 - self.gain) * self.release);
        if self.gain < 0.999 {
            self.limited += 1;
            self.deepest = self.deepest.min(self.gain);
        }
        let [left, right] = self.delay.pop_front().unwrap_or([0.0, 0.0]);
        out.push(left * self.gain);
        out.push(right * self.gain);
    }
}

/// How the mix is encoded.
pub struct Encoding<'a> {
    /// FFmpeg's codec arguments for the format.
    pub codec: &'a [String],
    /// AAC at this bitrate through AudioToolbox instead, where there is one
    /// (an .m4a output; FFmpeg's own AAC encoder is several times slower).
    pub aac: Option<u32>,
}

trait Sink {
    fn write(&mut self, samples: &[f32]) -> Result<(), String>;
    fn finish(self: Box<Self>) -> Result<(), String>;
}

#[cfg(target_os = "macos")]
impl Sink for crate::mac_media::SoundWriter {
    fn write(&mut self, samples: &[f32]) -> Result<(), String> {
        crate::mac_media::SoundWriter::write(self, samples)
    }
    fn finish(mut self: Box<Self>) -> Result<(), String> {
        crate::mac_media::SoundWriter::finish(&mut self)
    }
}

struct FfmpegSink {
    child: Child,
    stdin: Option<BufWriter<std::process::ChildStdin>>,
    stderr: Option<std::thread::JoinHandle<String>>,
    bytes: Vec<u8>,
}

impl FfmpegSink {
    fn open(codec: &[String], output: &Path) -> Result<Self, String> {
        let mut child = Command::new(crate::util::ffmpeg())
            .args(["-hide_banner", "-loglevel", "error", "-y", "-threads", "2"])
            .args([
                "-f", "f32le", "-ar", "48000", "-ac", "2", "-i", "pipe:0", "-vn",
            ])
            .args(codec)
            .arg(output)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("ffmpeg: {error}"))?;
        let stderr = child.stderr.take();
        let stderr = std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut stderr) = stderr {
                let _ = stderr.read_to_string(&mut text);
            }
            text
        });
        let stdin = child.stdin.take().ok_or("the sound encoder has no input")?;
        Ok(Self {
            child,
            stdin: Some(BufWriter::with_capacity(1 << 20, stdin)),
            stderr: Some(stderr),
            bytes: Vec::new(),
        })
    }
}

impl Sink for FfmpegSink {
    fn write(&mut self, samples: &[f32]) -> Result<(), String> {
        self.bytes.clear();
        for sample in samples {
            self.bytes.extend_from_slice(&sample.to_le_bytes());
        }
        self.stdin
            .as_mut()
            .ok_or("the sound encoder is closed")?
            .write_all(&self.bytes)
            .map_err(|_| "the sound encoder stopped early".to_owned())
    }

    fn finish(mut self: Box<Self>) -> Result<(), String> {
        if let Some(mut stdin) = self.stdin.take() {
            stdin
                .flush()
                .map_err(|_| "the sound encoder stopped early".to_owned())?;
        }
        let status = self.child.wait().map_err(|error| error.to_string())?;
        let stderr = self
            .stderr
            .take()
            .and_then(|thread| thread.join().ok())
            .unwrap_or_default();
        if !status.success() {
            return Err(stderr
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("sound encode failed")
                .trim()
                .to_owned());
        }
        Ok(())
    }
}

impl Drop for FfmpegSink {
    fn drop(&mut self) {
        // Unfinished (an error or a cancel): stop the encoder.
        if self.stdin.is_some() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn open_sink(encoding: &Encoding, output: &Path) -> Result<Box<dyn Sink>, String> {
    #[cfg(target_os = "macos")]
    if let Some(bitrate) = encoding.aac {
        match crate::mac_media::SoundWriter::open(output, bitrate) {
            Ok(writer) => return Ok(Box::new(writer)),
            Err(error) => crate::log::warn(
                "export",
                format!("native sound encoder unavailable: {error}; using FFmpeg"),
            ),
        }
    }
    Ok(Box::new(FfmpegSink::open(encoding.codec, output)?))
}

/// Mixes `parts` (`total` frames) and encodes the result to `output`. With
/// `loudness`, the mix goes to `scratch` first to be measured, then is
/// encoded at the gain that reaches it.
#[allow(clippy::too_many_arguments)]
pub fn render(
    parts: &[Part],
    total: usize,
    loudness: Option<f64>,
    encoding: &Encoding,
    output: &Path,
    scratch: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f32),
) -> Result<(), String> {
    let mut sink = open_sink(encoding, output)?;
    let Some(target) = loudness else {
        mix(parts, total, cancel, &mut progress, |window| {
            sink.write(window)
        })?;
        return sink.finish();
    };
    let mut meter =
        ebur128::EbuR128::new(2, RATE as u32, ebur128::Mode::I | ebur128::Mode::TRUE_PEAK)
            .map_err(|error| format!("loudness meter: {error}"))?;
    {
        let mut file = BufWriter::with_capacity(
            1 << 20,
            std::fs::File::create(scratch).map_err(|error| error.to_string())?,
        );
        let mut bytes = Vec::with_capacity(WINDOW * 8);
        mix(
            parts,
            total,
            cancel,
            |done| progress(done * 0.85),
            |window| {
                meter
                    .add_frames_f32(window)
                    .map_err(|error| format!("loudness meter: {error}"))?;
                bytes.clear();
                for sample in window {
                    bytes.extend_from_slice(&sample.to_le_bytes());
                }
                file.write_all(&bytes).map_err(|error| error.to_string())
            },
        )?;
        file.flush().map_err(|error| error.to_string())?;
    }
    let integrated = meter
        .loudness_global()
        .map_err(|error| format!("loudness: {error}"))?;
    let peak = (0..2)
        .filter_map(|channel| meter.true_peak(channel).ok())
        .fold(0.0_f64, f64::max);
    // The gain, limited: measured once more after the limiter (its cuts take
    // a little loudness with them) and corrected, then written.
    let mut gain = normalising_gain(integrated, target);
    // With every peak under the limiter's ceiling at this gain (the true
    // peak bounds the samples) it won't touch the mix: nothing to correct.
    let untouched = 20.0 * peak.max(1e-9).log10() + gain <= f64::from(LIMIT_CEILING_DB);
    // Usually one look settles it; a mix whose peaks the limiter works hard
    // gets a second.
    for _ in 0..if untouched { 0 } else { 2 } {
        let mut meter = ebur128::EbuR128::new(2, RATE as u32, ebur128::Mode::I)
            .map_err(|error| format!("loudness meter: {error}"))?;
        limited_pass(scratch, gain, cancel, |window| {
            meter
                .add_frames_f32(window)
                .map_err(|error| format!("loudness meter: {error}"))
        })?;
        let after = meter
            .loudness_global()
            .map_err(|error| format!("loudness: {error}"))?;
        if !after.is_finite() || (target - after).abs() < 0.2 {
            break;
        }
        gain = (gain + (target - after)).clamp(-30.0, 40.0);
    }
    let mut done = 0_usize;
    let limiter = limited_pass(scratch, gain, cancel, |window| {
        done += window.len() / 2;
        progress(0.85 + 0.15 * done as f32 / total.max(1) as f32);
        sink.write(window)
    })?;
    crate::log::info(
        "export",
        format!(
            "loudness {integrated:.1} LUFS, true peak {:.1} dBTP: {gain:+.1} dB to {target:.1} LUFS, the limiter under {LIMIT_CEILING_DB} dBFS on {:.1} s (at most {:.1} dB)",
            20.0 * peak.max(1e-9).log10(),
            limiter.limited as f64 / RATE as f64,
            20.0 * limiter.deepest.max(1e-6).log10(),
        ),
    );
    sink.finish()
}

/// The mix in `scratch` at `gain` dB through a fresh limiter, a window at a
/// time to `each`; returns the limiter (what it did).
fn limited_pass(
    scratch: &Path,
    gain: f64,
    cancel: &AtomicBool,
    mut each: impl FnMut(&[f32]) -> Result<(), String>,
) -> Result<Limiter, String> {
    let factor = 10_f64.powf(gain / 20.0) as f32;
    let mut limiter = Limiter::default();
    let mut limited = Vec::with_capacity(WINDOW * 2 + LIMIT_LOOK * 2);
    let mut file = BufReader::with_capacity(
        1 << 20,
        std::fs::File::open(scratch).map_err(|error| error.to_string())?,
    );
    let mut raw = vec![0_u8; WINDOW * 8];
    let mut samples = vec![0.0_f32; WINDOW * 2];
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".to_owned());
        }
        let mut filled = 0;
        while filled < raw.len() {
            match file.read(raw.get_mut(filled..).unwrap_or_default()) {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(error) => return Err(error.to_string()),
            }
        }
        if filled == 0 {
            break;
        }
        let count = filled / 8 * 2;
        for (sample, bytes) in samples.iter_mut().zip(raw.as_chunks::<4>().0).take(count) {
            *sample = f32::from_le_bytes(*bytes) * factor;
        }
        limited.clear();
        limiter.process(samples.get(..count).unwrap_or_default(), &mut limited);
        each(&limited)?;
    }
    limited.clear();
    limiter.finish(&mut limited);
    each(&limited)?;
    Ok(limiter)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(start: f64, duration: f64, source_in: f64) -> AudioSegment {
        AudioSegment {
            clip: "a".into(),
            media: "m".into(),
            start,
            duration,
            source_in,
            speed: 1.0,
            volume_db: 0.0,
            volume_keys: vec![],
            fps: 30.0,
            fade_in: 0.0,
            fade_out: 0.0,
            mutes: vec![],
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "edit-mix-{name}-{}-{}",
            std::process::id(),
            crate::util::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A stereo file whose left channel is a ramp: sample n of the file is
    /// n / 48000 / 10 (0 to 1 over 10 s), so every sample says where it came from.
    fn ramp(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        let made = Command::new(crate::util::ffmpeg())
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg("aevalsrc='t/10|0.25':s=48000:d=10")
            .args(["-c:a", "pcm_f32le"])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        path
    }

    fn mixed_with(native: bool, parts: &[Part], total: usize) -> Vec<f32> {
        let mut out = Vec::new();
        mix_with(
            Sources::new(native),
            parts,
            total,
            &AtomicBool::new(false),
            |_| {},
            |window| {
                out.extend_from_slice(window);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(out.len(), total * 2);
        out
    }

    fn mixed(parts: &[Part], total: usize) -> Vec<f32> {
        mixed_with(true, parts, total)
    }

    fn left(samples: &[f32], seconds: f64) -> f32 {
        samples[(seconds * RATE as f64).round() as usize * 2]
    }

    fn part(path: &Path, segment: AudioSegment) -> Part {
        let original = segment.duration;
        Part {
            path: path.to_owned(),
            segment,
            elapsed: 0.0,
            original,
        }
    }

    #[test]
    fn places_each_stretch_at_its_time_with_volume_and_fades() {
        let dir = temp_dir("place");
        let path = ramp(&dir, "ramp.wav");
        // 1 s of the source from 2 s, placed at 0.5 s, 6 dB down, 0.2 s fades.
        let mut faded = segment(0.5, 1.0, 2.0);
        faded.volume_db = -6.0;
        faded.fade_in = 0.2;
        faded.fade_out = 0.2;
        let out = mixed(&[part(&path, faded)], RATE * 2);
        let volume = 10_f32.powf(-6.0 / 20.0);
        assert_eq!(left(&out, 0.25), 0.0, "silent before it");
        assert!(left(&out, 0.499).abs() < 1e-6);
        // Halfway through the fade in: source 2.1 s at half gain.
        assert!(
            (left(&out, 0.6) - 0.21 * volume * 0.5).abs() < 2e-4,
            "{}",
            left(&out, 0.6)
        );
        // Fully up in the middle: source 2.5 s.
        assert!(
            (left(&out, 1.0) - 0.25 * volume).abs() < 2e-4,
            "{}",
            left(&out, 1.0)
        );
        // The right channel (0.25) through the fade out: 0.1 s before the end, half gain.
        let right = out[(1.4 * RATE as f64) as usize * 2 + 1];
        assert!((right - 0.25 * volume * 0.5).abs() < 2e-3, "{right}");
        assert_eq!(left(&out, 1.75), 0.0, "silent after it");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn volume_keyframes_shape_the_mix_as_the_preview_hears_them() {
        let dir = temp_dir("keys");
        let path = ramp(&dir, "ramp.wav");
        let key = |frame: f32, value: f32| edit_core::Keyframe {
            frame,
            value,
            ease: edit_core::Ease::Linear,
            handle_in: None,
            handle_out: None,
        };
        // 2 s of the source from 1 s at 0.5 s on the timeline, -20 dB rising
        // to 0 dB over its first second (30 frames), then held.
        let mut keyed = segment(0.5, 2.0, 1.0);
        keyed.volume_db = -40.0;
        keyed.volume_keys = vec![key(0.0, -20.0), key(30.0, 0.0)];
        // Cut to a span starting 0.25 s in: the keys stay on the clip's clock.
        let cut = parts(&[keyed.clone()], |_| Some(path.clone()), 0.75, 2.0);
        for native in [true, false] {
            let out = mixed_with(native, &cut, RATE * 2);
            for clip_time in [0.3, 0.5, 0.51, 0.9, 1.5] {
                let source = (1.0 + clip_time) / 10.0;
                let expected = source as f32 * keyed.volume_at(clip_time);
                let got = left(&out, clip_time - 0.25);
                assert!(
                    (got - expected).abs() < 2e-4,
                    "native {native}, {clip_time} s into the clip: {got} vs {expected}"
                );
            }
            // Halfway up: -10 dB, not the static -40.
            let got = left(&out, 0.25);
            assert!((got - 0.15 * 10_f32.powf(-0.5)).abs() < 2e-4, "{got}");
        }
        std::fs::remove_dir_all(dir).ok();
    }

    fn mix_result(
        native: bool,
        parts: &[Part],
        total: usize,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        mix_with(
            Sources::new(native),
            parts,
            total,
            cancel,
            |_| {},
            |_| Ok(()),
        )
    }

    /// A missing or broken file fails the mix: it never becomes silence in an
    /// export that looks fine.
    #[test]
    fn a_sound_that_cannot_be_decoded_fails_the_mix() {
        let dir = temp_dir("broken");
        let broken = dir.join("broken.wav");
        std::fs::write(&broken, b"not a wav file at all").unwrap();
        for path in [dir.join("missing.wav"), broken] {
            for native in [true, false] {
                let error = mix_result(
                    native,
                    &[part(&path, segment(0.0, 1.0, 0.0))],
                    RATE,
                    &AtomicBool::new(false),
                )
                .unwrap_err();
                assert!(
                    error.contains("could not decode the sound"),
                    "{native} {}: {error}",
                    path.display()
                );
            }
        }
        // A clip running past its file's end is still silence after it.
        let short = ramp(&dir, "ramp.wav");
        let out = mixed_with(false, &[part(&short, segment(0.0, 2.0, 9.5))], RATE * 2);
        assert!((left(&out, 0.25) - 0.975).abs() < 1e-3);
        assert_eq!(left(&out, 1.5), 0.0);
        std::fs::remove_dir_all(dir).ok();
    }

    /// A decoder that never answers (here FFmpeg waits on a pipe nobody
    /// writes to) is killed by the cancel instead of holding the export.
    #[test]
    fn cancel_stops_a_decoder_that_hangs() {
        let dir = temp_dir("hang");
        let fifo = dir.join("never.wav");
        assert!(Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        let cancel = AtomicBool::new(false);
        let started = Instant::now();
        let result = std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(300));
                cancel.store(true, Ordering::Release);
            });
            crate::util::killed_on_cancel(&cancel, || {
                mix_result(false, &[part(&fifo, segment(0.0, 1.0, 0.0))], RATE, &cancel)
            })
        });
        assert!(result.is_err());
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn overlapping_sounds_add_up() {
        let dir = temp_dir("overlap");
        let path = ramp(&dir, "ramp.wav");
        let out = mixed(
            &[
                part(&path, segment(0.0, 1.5, 1.0)),
                part(&path, segment(1.0, 1.0, 5.0)),
            ],
            RATE * 3,
        );
        assert!((left(&out, 0.5) - 0.15).abs() < 2e-4);
        // 1.2 s: the first at source 2.2 s plus the second at 5.2 s.
        assert!(
            (left(&out, 1.2) - (0.22 + 0.52)).abs() < 4e-4,
            "{}",
            left(&out, 1.2)
        );
        assert!((out[(1.2 * RATE as f64) as usize * 2 + 1] - 0.5).abs() < 1e-3);
        assert!((left(&out, 1.8) - 0.58).abs() < 2e-4);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn mutes_silence_the_source_with_cosine_ramps() {
        let dir = temp_dir("mute");
        let path = ramp(&dir, "ramp.wav");
        // The clip plays the source from 1 s; the mute is 2.0–2.5 s of the source.
        let mut muted = segment(0.0, 2.5, 1.0);
        muted.mutes = vec![
            Mute { from: 2.0, to: 2.5 },
            Mute {
                from: 30.0,
                to: 31.0,
            },
        ];
        let out = mixed(&[part(&path, muted.clone())], RATE * 3);
        for seconds in [1.0, 1.2, 1.49] {
            assert!(
                left(&out, seconds).abs() < 1e-6,
                "silent inside at {seconds}"
            );
        }
        assert!((left(&out, 0.5) - 0.15).abs() < 2e-4, "untouched before");
        assert!((left(&out, 1.6) - 0.26).abs() < 2e-4, "untouched after");
        // Each sample as edit_core's ramp has it.
        for seconds in [0.985, 0.994, 1.503, 1.506, 1.511] {
            let source = 1.0 + seconds;
            let expected = source / 10.0 * mute_gain(&muted.mutes, source);
            assert!(
                (f64::from(left(&out, seconds)) - expected).abs() < 2e-4,
                "{seconds}: {} vs {expected}",
                left(&out, seconds)
            );
        }
        std::fs::remove_dir_all(dir).ok();
    }

    /// The FFmpeg path (other speeds, other formats) applies the mutes before
    /// the tempo change, on the source's clock, then the mix does the rest.
    #[test]
    fn other_speeds_go_through_ffmpeg_tempo() {
        let dir = temp_dir("speed");
        let path = ramp(&dir, "ramp.wav");
        let mut fast = segment(0.0, 1.0, 2.0);
        fast.speed = 2.0;
        fast.volume_db = -6.0;
        let out = mixed(&[part(&path, fast)], RATE * 2);
        let volume = 10_f32.powf(-6.0 / 20.0);
        // 1 s on the timeline plays 2 s of the source (2.0 → 4.0) at double speed.
        for (seconds, source) in [(0.25, 2.5), (0.5, 3.0), (0.75, 3.5)] {
            let value = left(&out, seconds);
            assert!(
                (value - source / 10.0 * volume).abs() < 0.01,
                "{seconds}: {value}"
            );
        }
        assert!(left(&out, 1.2).abs() < 1e-6, "ends with the clip");
        std::fs::remove_dir_all(dir).ok();
    }

    /// A span that starts inside a clip keeps a fade already under way.
    #[test]
    fn a_partial_export_preserves_a_fade_already_in_progress() {
        let dir = temp_dir("partial");
        let path = dir.join("flat.wav");
        let made = Command::new(crate::util::ffmpeg())
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg("aevalsrc=0.5|0.5:s=48000:d=5")
            .args(["-c:a", "pcm_f32le"])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        let mut whole = segment(0.0, 4.0, 0.0);
        whole.fade_in = 2.0;
        whole.fade_out = 1.0;
        // The span is 1.0–1.5 s of the timeline.
        let cut = parts(&[whole], |_| Some(path.clone()), 1.0, 0.5);
        assert_eq!(cut.len(), 1);
        let out = mixed(&cut, RATE / 2);
        assert!(
            (out[0] - 0.25).abs() < 0.001,
            "mid-fade starts at its gain: {}",
            out[0]
        );
        assert!((out[out.len() - 2] - 0.375).abs() < 0.001);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn the_ffmpeg_chain_mutes_like_the_mix() {
        // The chain the FFmpeg path runs has a cosine for each mute it plays only.
        let mut muted = segment(0.0, 2.5, 1.0);
        muted.mutes = vec![
            Mute { from: 2.0, to: 2.5 },
            Mute {
                from: 30.0,
                to: 31.0,
            },
        ];
        let chain = decode_chain(&muted);
        assert_eq!(chain.matches("cos(").count(), 2, "{chain}");
        let dir = temp_dir("chain");
        let path = ramp(&dir, "ramp.wav");
        let ffmpeg = mixed_with(false, &[part(&path, muted.clone())], RATE * 3);
        let native = mixed_with(true, &[part(&path, muted)], RATE * 3);
        let worst = ffmpeg
            .iter()
            .zip(&native)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        assert!(worst < 1e-3, "FFmpeg and native paths agree: {worst}");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn normalising_reaches_the_target_and_the_limiter_holds_peaks() {
        assert!((normalising_gain(-24.0, -14.0) - 10.0).abs() < 1e-9);
        assert!((normalising_gain(-8.0, -14.0) - -6.0).abs() < 1e-9);
        assert_eq!(normalising_gain(f64::NEG_INFINITY, -14.0), 0.0);
        // Quiet sound with one full-scale spike: the spike comes down under
        // the ceiling, the rest passes untouched, nothing is lost or added.
        let mut input = vec![0.1_f32; RATE];
        for sample in input.iter_mut().skip(20_000).take(200) {
            *sample = 1.4;
        }
        let mut out = Vec::new();
        let mut limiter = Limiter::default();
        limiter.process(&input, &mut out);
        limiter.finish(&mut out);
        assert_eq!(out.len(), input.len());
        let ceiling = 10_f32.powf(LIMIT_CEILING_DB / 20.0);
        assert!(out.iter().all(|sample| sample.abs() <= ceiling + 1e-6));
        assert!((out[2_000] - 0.1).abs() < 1e-6);
        assert!((out[RATE - 2] - 0.1).abs() < 0.01);
    }

    #[test]
    fn renders_normalised_sound_to_the_target() {
        let dir = temp_dir("loudness");
        let path = dir.join("tone.wav");
        let made = Command::new(crate::util::ffmpeg())
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg("sine=frequency=1000:sample_rate=48000:duration=6")
            .args(["-af", "volume=-20dB", "-ac", "2"])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        // One full-scale hit in it, as a boom on a transition: it must not
        // hold the rest under the target (the limiter takes it).
        let hit = dir.join("hit.wav");
        let made = Command::new(crate::util::ffmpeg())
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg("sine=frequency=200:sample_rate=48000:duration=0.08")
            // lavfi's sine is 1/8 of full scale: this is 20 dB over the tone.
            .args(["-af", "volume=0dB", "-ac", "2"])
            .arg(&hit)
            .status()
            .unwrap();
        assert!(made.success());
        // PCM through FFmpeg, and AAC through AudioToolbox where it's there.
        let pcm = ["-c:a".to_owned(), "pcm_f32le".to_owned()];
        let aac = ["-c:a".to_owned(), "aac".to_owned()];
        for (name, encoding) in [
            (
                "out.wav",
                Encoding {
                    codec: &pcm,
                    aac: None,
                },
            ),
            (
                "out.m4a",
                Encoding {
                    codec: &aac,
                    aac: Some(256_000),
                },
            ),
        ] {
            let output = dir.join(name);
            render(
                &[
                    part(&path, segment(0.0, 6.0, 0.0)),
                    part(&hit, segment(3.0, 0.08, 0.0)),
                ],
                RATE * 6,
                Some(-14.0),
                &encoding,
                &output,
                &dir.join("scratch.f32"),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
            let measured = Command::new(crate::util::ffmpeg())
                .args(["-hide_banner", "-nostats", "-i"])
                .arg(&output)
                .args(["-af", "ebur128=peak=true", "-f", "null", "-"])
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&measured.stderr);
            let summary = text.rsplit("Summary:").next().unwrap();
            let value = |key: &str| -> f64 {
                let line = summary
                    .lines()
                    .find(|line| line.trim_start().starts_with(key))
                    .unwrap();
                line.split_whitespace().nth(1).unwrap().parse().unwrap()
            };
            let integrated = value("I:");
            let peak = value("Peak:");
            assert!(
                (integrated - -14.0).abs() < 0.3,
                "{name}: {integrated} LUFS\n{summary}"
            );
            // Under -1 dBTP, with a little room for the encoder.
            assert!(peak <= -0.8, "{name}: {peak} dBTP");
            // As decoded (the encoder's priming trimmed by the file's edit list).
            let decoded = Command::new(crate::util::ffmpeg())
                .args(["-v", "error", "-i"])
                .arg(&output)
                .args(["-f", "f32le", "-ac", "2", "-"])
                .output()
                .unwrap();
            let frames = decoded.stdout.len() / 8;
            assert!(frames.abs_diff(RATE * 6) < 1100, "{name}: {frames} frames");
        }
        std::fs::remove_dir_all(dir).ok();
    }
}
