//! Loudness analysis kept per media file: one FFmpeg decode makes, for every
//! 10 ms of the sound, its K-weighted energy (ITU-R BS.1770, channels summed)
//! and its sample peak. That's ~800 bytes a second, written beside the
//! media's other cache files (`<cache>/<media key>/loudness-v1.bin`), so any
//! stretch's gated loudness and peak afterwards is a sum over blocks:
//! microseconds instead of an FFmpeg run per measurement.
//!
//! The measures follow FFmpeg's `ebur128` filter, which they replace: the
//! momentary loudness every 100 ms over the last 400 ms, and the integrated
//! loudness over 400 ms blocks every 100 ms gated at -70 LUFS and then 10 LU
//! under the ungated level.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::f64::consts::PI;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};
use std::time::Instant;

/// The analysis's file name; a new layout or method is a new version.
const FILE: &str = "loudness-v1.bin";
const MAGIC: &[u8; 8] = b"EDLOUD01";
/// Blocks a second (10 ms each, so spans line up within 5 ms).
const PER_SECOND: f64 = 100.0;
/// Analysis kept in memory, at most (bytes); about 6 hours of sound.
const MEMORY: usize = 16 << 20;
/// LUFS of a mean square of 1 (BS.1770's -0.691 offset).
const OFFSET: f64 = -0.691;

/// A whole file's analysis.
#[derive(Debug, PartialEq)]
pub struct Blocks {
    /// Blocks a second (100, or a hair off when the sample rate isn't a multiple of 100).
    pub rate: f64,
    /// K-weighted mean square of each block, channels summed.
    pub energy: Vec<f32>,
    /// Largest absolute sample in each block (linear, 1 = full scale).
    pub peak: Vec<f32>,
}

#[derive(Default)]
struct Memory {
    blocks: HashMap<String, (Arc<Blocks>, Instant)>,
    /// One analysis per file at a time; a second ask waits and reuses it.
    working: HashMap<String, Arc<Mutex<()>>>,
}

fn memory() -> &'static Mutex<Memory> {
    static MEMORY: OnceLock<Mutex<Memory>> = OnceLock::new();
    MEMORY.get_or_init(Default::default)
}

/// The analysis of the sound at `path`: from memory, else from its file in
/// the cache, else made now (one FFmpeg decode of the first audio stream).
pub fn blocks(path: &Path) -> Result<Arc<Blocks>, String> {
    let key = crate::media::media_key(path);
    if let Some(found) = remembered(&key) {
        return Ok(found);
    }
    let lock = Arc::clone(memory().lock().working.entry(key.clone()).or_default());
    let _working = lock.lock();
    if let Some(found) = remembered(&key) {
        return Ok(found);
    }
    let made = load_or_analyse(path).map(Arc::new);
    if let Ok(blocks) = &made {
        remember(key.clone(), Arc::clone(blocks));
    }
    // Only this analysis's own lock: after a failure, a later ask may have
    // put a new one there that others are waiting on.
    let mut memory = memory().lock();
    if memory
        .working
        .get(&key)
        .is_some_and(|working| Arc::ptr_eq(working, &lock))
    {
        memory.working.remove(&key);
    }
    drop(memory);
    made
}

fn load_or_analyse(path: &Path) -> Result<Blocks, String> {
    let file = crate::tools::media_cache(path).map(|dir| dir.join(FILE));
    if let Some(blocks) = file.as_deref().and_then(read) {
        return Ok(blocks);
    }
    let blocks = crate::diag::time_on(
        "audio",
        "audio: loudness analysis",
        &path.to_string_lossy(),
        || analyse(path),
    )?;
    if let Some(file) = &file {
        if let Err(error) = write(file, &blocks) {
            crate::diag::warn(
                "audio",
                format!("keeping the loudness of {}: {error}", path.display()),
            );
        }
    }
    Ok(blocks)
}

fn remembered(key: &str) -> Option<Arc<Blocks>> {
    let mut memory = memory().lock();
    let (blocks, used) = memory.blocks.get_mut(key)?;
    *used = Instant::now();
    Some(Arc::clone(blocks))
}

fn remember(key: String, blocks: Arc<Blocks>) {
    let mut memory = memory().lock();
    memory.blocks.insert(key, (blocks, Instant::now()));
    let size = |blocks: &Blocks| blocks.energy.len() * 8;
    while memory.blocks.len() > 1
        && memory
            .blocks
            .values()
            .map(|(blocks, _)| size(blocks))
            .sum::<usize>()
            > MEMORY
    {
        let Some(oldest) = memory
            .blocks
            .iter()
            .min_by_key(|(_, (_, used))| *used)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        memory.blocks.remove(&oldest);
    }
}

/// Makes the analyses of several files at once (a few at a time), so a
/// measurement across a timeline isn't one decode after another.
pub fn prepare(paths: &[PathBuf]) {
    let mut paths: Vec<&PathBuf> = paths.iter().collect();
    paths.sort();
    paths.dedup();
    let next = std::sync::atomic::AtomicUsize::new(0);
    let workers = paths.len().clamp(1, 3);
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(path) = paths.get(index) else {
                    break;
                };
                // A failure shows again (with its reason) where it's measured.
                let _ = blocks(path);
            });
        }
    });
}

/// Analyses a sound in the background (one at a time), so its first
/// measurement is instant. For media that has just been imported.
pub fn warm(path: PathBuf) {
    static SLOT: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return;
    };
    runtime.spawn(async move {
        let Ok(_slot) = SLOT
            .get_or_init(|| tokio::sync::Semaphore::new(1))
            .acquire()
            .await
        else {
            return;
        };
        let _ = tokio::task::spawn_blocking(move || blocks(&path)).await;
    });
}

/// How loud `seconds` from `from` are, as FFmpeg's `ebur128` measures the
/// stretch padded with 0.5 s of silence: the integrated loudness (LUFS),
/// the loudest momentary loudness (LUFS) and the sample peak (dBFS).
#[derive(Clone, Copy, Debug)]
pub struct Span {
    pub integrated: f64,
    pub loudest: f64,
    pub peak: f64,
}

impl Blocks {
    pub fn span(&self, from: f64, seconds: f64) -> Span {
        let (from, seconds) = (from.max(0.0), seconds.max(0.0));
        let first = (from * self.rate).round() as usize;
        let count = (seconds * self.rate).round() as usize;
        let pad = (0.5 * self.rate).round() as usize;
        let window = ((0.4 * self.rate).round() as usize).max(1);
        let step = ((0.1 * self.rate).round() as usize).max(1);
        let energy = |index: usize| -> f64 {
            if index < count {
                self.energy
                    .get(first + index)
                    .copied()
                    .map_or(0.0, f64::from)
            } else {
                0.0
            }
        };
        let total = count + pad;
        // Running sums over the stretch (zeros before it and past its end).
        let mut sums = Vec::with_capacity(total + 1);
        sums.push(0.0_f64);
        for index in 0..total {
            let last = *sums.last().unwrap_or(&0.0);
            sums.push(last + energy(index));
        }
        let mean = |start: isize, end: usize| -> f64 {
            let start = start.max(0) as usize;
            let sum = |at: usize| sums.get(at).copied().unwrap_or(0.0);
            ((sum(end) - sum(start.min(end))) / window as f64).max(0.0)
        };
        let lufs = |power: f64| {
            if power > 0.0 {
                OFFSET + 10.0 * power.log10()
            } else {
                f64::NEG_INFINITY
            }
        };
        // Momentary: every 100 ms, the last 400 ms.
        let loudest = (1..=total / step)
            .map(|tick| tick * step)
            .map(|end| lufs(mean(end as isize - window as isize, end)))
            .fold(f64::NEG_INFINITY, f64::max);
        // Integrated: 400 ms blocks every 100 ms, gated.
        let gating: Vec<f64> = (0..)
            .map(|index: usize| index * step)
            .take_while(|start| start + window <= total)
            .map(|start| mean(start as isize, start + window))
            .filter(|power| lufs(*power) > -70.0)
            .collect();
        let integrated = if gating.is_empty() {
            -70.0
        } else {
            let relative = lufs(gating.iter().sum::<f64>() / gating.len() as f64) - 10.0;
            let kept: Vec<f64> = gating
                .into_iter()
                .filter(|power| lufs(*power) > relative)
                .collect();
            if kept.is_empty() {
                -70.0
            } else {
                lufs(kept.iter().sum::<f64>() / kept.len() as f64).max(-70.0)
            }
        };
        let peak = self
            .peak
            .get(first.min(self.peak.len())..(first + count).min(self.peak.len()))
            .unwrap_or_default()
            .iter()
            .fold(0.0_f32, |top, peak| top.max(*peak));
        Span {
            integrated,
            loudest,
            peak: if peak > 0.0 {
                20.0 * f64::from(peak).log10()
            } else {
                f64::NEG_INFINITY
            },
        }
    }

    /// Seconds into the sound of its loudest block's middle.
    pub fn loudest_moment(&self) -> f64 {
        let index = self
            .energy
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .map_or(0, |(index, _)| index);
        (index as f64 + 0.5) / self.rate
    }
}

/// The K-weighting filter (BS.1770's shelf, then its high-pass) for a sample
/// rate, as libebur128 derives it: `[b0, b1, b2, a1, a2]` for each stage.
fn k_weighting(rate: f64) -> [[f64; 5]; 2] {
    let (f0, gain, q) = (1681.974450955533, 3.999843853973347, 0.7071752369554196);
    let k = (PI * f0 / rate).tan();
    let vh = 10f64.powf(gain / 20.0);
    let vb = vh.powf(0.4996667741545416);
    let a0 = 1.0 + k / q + k * k;
    let shelf = [
        (vh + vb * k / q + k * k) / a0,
        2.0 * (k * k - vh) / a0,
        (vh - vb * k / q + k * k) / a0,
        2.0 * (k * k - 1.0) / a0,
        (1.0 - k / q + k * k) / a0,
    ];
    let (f0, q) = (38.13547087602444, 0.5003270373238773);
    let k = (PI * f0 / rate).tan();
    let a0 = 1.0 + k / q + k * k;
    let high_pass = [
        1.0,
        -2.0,
        1.0,
        2.0 * (k * k - 1.0) / a0,
        (1.0 - k / q + k * k) / a0,
    ];
    [shelf, high_pass]
}

/// One channel's filter state (direct form II transposed, both stages).
#[derive(Clone, Copy, Default)]
struct Channel {
    state: [[f64; 2]; 2],
}

impl Channel {
    #[inline]
    fn weigh(&mut self, filter: &[[f64; 5]; 2], sample: f64) -> f64 {
        let mut value = sample;
        for (stage, state) in filter.iter().zip(&mut self.state) {
            let [b0, b1, b2, a1, a2] = *stage;
            let out = b0 * value + state[0];
            state[0] = b1 * value - a1 * out + state[1];
            state[1] = b2 * value - a2 * out;
            value = out;
        }
        value
    }
}

/// Builds blocks from interleaved samples as they arrive.
struct Analyser {
    filter: [[f64; 5]; 2],
    channels: Vec<Channel>,
    /// Samples (per channel) a block.
    length: usize,
    filled: usize,
    sum: f64,
    peak: f32,
    blocks: Blocks,
}

impl Analyser {
    fn new(rate: u32, channels: usize) -> Self {
        let length = ((f64::from(rate) / PER_SECOND).round() as usize).max(1);
        Self {
            filter: k_weighting(f64::from(rate)),
            channels: vec![Channel::default(); channels.max(1)],
            length,
            filled: 0,
            sum: 0.0,
            peak: 0.0,
            blocks: Blocks {
                rate: f64::from(rate) / length as f64,
                energy: Vec::new(),
                peak: Vec::new(),
            },
        }
    }

    /// Whole frames (one sample per channel) of interleaved samples.
    fn push(&mut self, samples: &[f32]) {
        let count = self.channels.len();
        for frame in samples.chunks_exact(count) {
            for (channel, sample) in self.channels.iter_mut().zip(frame) {
                let weighted = channel.weigh(&self.filter, f64::from(*sample));
                self.sum += weighted * weighted;
                self.peak = self.peak.max(sample.abs());
            }
            self.filled += 1;
            if self.filled == self.length {
                self.close();
            }
        }
    }

    fn close(&mut self) {
        self.blocks
            .energy
            .push((self.sum / self.length as f64) as f32);
        self.blocks.peak.push(self.peak);
        (self.filled, self.sum, self.peak) = (0, 0.0, 0.0);
    }

    fn finish(mut self) -> Blocks {
        if self.filled > 0 {
            // The rest of the last block is silence.
            self.close();
        }
        self.blocks
    }
}

/// Decodes the first audio stream (as 32-bit float WAV, mono or stereo:
/// more channels are mixed down) and analyses it.
fn analyse(path: &Path) -> Result<Blocks, String> {
    let mut child = Command::new(crate::tools::ffmpeg())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
        ])
        .arg(path)
        .args([
            "-map",
            "0:a:0",
            "-af",
            "aformat=sample_fmts=flt:channel_layouts=mono|stereo",
            "-c:a",
            "pcm_f32le",
            "-f",
            "wav",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    let stdout = child.stdout.take().ok_or("ffmpeg stdout")?;
    let read = analyse_wav(BufReader::with_capacity(1 << 20, stdout));
    if read.is_err() {
        let _ = child.kill();
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("ffmpeg: {error}"))?;
    let blocks = read?;
    if !output.status.success() && blocks.energy.is_empty() {
        return Err(format!(
            "couldn't measure {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(blocks)
}

/// Little-endian numbers in a byte slice, if it's long enough.
fn le<const N: usize>(bytes: &[u8], at: usize) -> Option<[u8; N]> {
    bytes.get(at..at.checked_add(N)?)?.try_into().ok()
}

/// Reads a float WAV stream (as FFmpeg writes one to a pipe: the data size
/// unknown, read to the end).
fn analyse_wav(mut input: impl Read) -> Result<Blocks, String> {
    let mut header = [0_u8; 12];
    input
        .read_exact(&mut header)
        .map_err(|_| "no audio to measure".to_owned())?;
    if header.get(0..4) != Some(b"RIFF") || header.get(8..12) != Some(b"WAVE") {
        return Err("the audio decoder didn't answer with WAV".into());
    }
    let mut format: Option<(u16, usize, u32)> = None;
    loop {
        let mut chunk = [0_u8; 8];
        input
            .read_exact(&mut chunk)
            .map_err(|_| "no audio to measure".to_owned())?;
        let size = le::<4>(&chunk, 4).map_or(0, u32::from_le_bytes) as usize;
        match chunk.get(0..4) {
            Some(b"fmt ") => {
                let mut body = vec![0_u8; size + size % 2];
                input
                    .read_exact(&mut body)
                    .map_err(|error| error.to_string())?;
                let (Some(tag), Some(channels), Some(rate)) = (
                    le::<2>(&body, 0).map(u16::from_le_bytes),
                    le::<2>(&body, 2).map(u16::from_le_bytes),
                    le::<4>(&body, 4).map(u32::from_le_bytes),
                ) else {
                    return Err("the audio decoder's WAV has no format".into());
                };
                format = Some((tag, usize::from(channels), rate));
            }
            Some(b"data") => break,
            _ => {
                std::io::copy(
                    &mut (&mut input).take((size + size % 2) as u64),
                    &mut std::io::sink(),
                )
                .map_err(|error| error.to_string())?;
            }
        }
    }
    let (tag, channels, rate) = format.ok_or("the audio decoder's WAV has no format")?;
    // 3 = IEEE float; 0xFFFE = extensible (FFmpeg's for float, by the sub-format).
    if !(tag == 3 || tag == 0xFFFE) || channels == 0 || rate == 0 {
        return Err(format!(
            "unexpected audio format from the decoder ({tag}, {channels} ch, {rate} Hz)"
        ));
    }
    let mut analyser = Analyser::new(rate, channels);
    let frame = 4 * channels;
    let mut buffer = vec![0_u8; frame * 16384];
    let mut held = 0;
    let mut samples: Vec<f32> = Vec::with_capacity(buffer.len() / 4);
    while let Some(space) = buffer.get_mut(held..) {
        let read = match input.read(space) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.to_string()),
        };
        held += read;
        let whole = held / frame * frame;
        samples.clear();
        samples.extend(
            buffer
                .get(..whole)
                .unwrap_or_default()
                .as_chunks::<4>()
                .0
                .iter()
                .map(|bytes| f32::from_le_bytes(*bytes)),
        );
        analyser.push(&samples);
        buffer.copy_within(whole..held, 0);
        held -= whole;
    }
    Ok(analyser.finish())
}

fn read(file: &Path) -> Option<Blocks> {
    let bytes = std::fs::read(file).ok()?;
    if bytes.get(..8)? != MAGIC {
        return None;
    }
    let rate = f64::from_le_bytes(le::<8>(&bytes, 8)?);
    let count = u64::from_le_bytes(le::<8>(&bytes, 16)?) as usize;
    let body = bytes.get(24..)?;
    if body.len() != count.checked_mul(8)?
        || rate.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater)
    {
        return None;
    }
    let values: Vec<f32> = body
        .as_chunks::<4>()
        .0
        .iter()
        .map(|bytes| f32::from_le_bytes(*bytes))
        .collect();
    Some(Blocks {
        rate,
        energy: values.iter().step_by(2).copied().collect(),
        peak: values.iter().skip(1).step_by(2).copied().collect(),
    })
}

fn write(file: &Path, blocks: &Blocks) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    let mut bytes = Vec::with_capacity(24 + blocks.energy.len() * 8);
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&blocks.rate.to_le_bytes());
    bytes.extend_from_slice(&(blocks.energy.len() as u64).to_le_bytes());
    for (energy, peak) in blocks.energy.iter().zip(&blocks.peak) {
        bytes.extend_from_slice(&energy.to_le_bytes());
        bytes.extend_from_slice(&peak.to_le_bytes());
    }
    let partial = file.with_extension("partial");
    let mut out = std::fs::File::create(&partial).map_err(|error| error.to_string())?;
    out.write_all(&bytes).map_err(|error| error.to_string())?;
    drop(out);
    std::fs::rename(&partial, file).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn k_weighting_at_48k_is_bs1770s() {
        let [shelf, high_pass] = k_weighting(48_000.0);
        let close = |a: f64, b: f64| (a - b).abs() < 1e-9;
        assert!(close(shelf[0], 1.53512485958697), "{shelf:?}");
        assert!(close(shelf[1], -2.69169618940638), "{shelf:?}");
        assert!(close(shelf[2], 1.19839281085285), "{shelf:?}");
        assert!(close(shelf[3], -1.69065929318241), "{shelf:?}");
        assert!(close(shelf[4], 0.73248077421585), "{shelf:?}");
        assert!(close(high_pass[3], -1.99004745483398), "{high_pass:?}");
        assert!(close(high_pass[4], 0.99007225036621), "{high_pass:?}");
    }

    fn sine(rate: u32, channels: usize, seconds: f64, amplitude: f32) -> Blocks {
        let mut analyser = Analyser::new(rate, channels);
        let samples: Vec<f32> = (0..(seconds * f64::from(rate)) as usize)
            .flat_map(|index| {
                let value =
                    amplitude * (2.0 * PI * 997.0 * index as f64 / f64::from(rate)).sin() as f32;
                std::iter::repeat_n(value, channels)
            })
            .collect();
        analyser.push(&samples);
        analyser.finish()
    }

    /// BS.1770's check: a full-scale 997 Hz sine in one channel reads -3.01
    /// LUFS, so in both channels of a stereo signal about 0.
    #[test]
    fn a_full_scale_stereo_sine_is_about_zero_lufs() {
        let blocks = sine(48_000, 2, 5.0, 1.0);
        let span = blocks.span(0.0, 5.0);
        assert!(span.integrated.abs() < 0.2, "{span:?}");
        assert!(span.peak.abs() < 0.01, "{span:?}");
        // -20 dBFS: 20 LU down.
        let quiet = sine(44_100, 2, 5.0, 0.1).span(1.0, 3.5);
        assert!((quiet.integrated + 20.0).abs() < 0.2, "{quiet:?}");
    }

    #[test]
    fn blocks_survive_the_disk() {
        let blocks = sine(22_050, 1, 1.234, 0.5);
        let dir = std::env::temp_dir().join(format!("edit-loudness-{}", std::process::id()));
        let file = dir.join(FILE);
        write(&file, &blocks).unwrap();
        assert_eq!(read(&file).as_ref(), Some(&blocks));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn silence_gates_out() {
        let span = sine(48_000, 1, 2.0, 0.0).span(0.0, 2.0);
        assert_eq!(span.integrated, -70.0);
        assert_eq!(span.loudest, f64::NEG_INFINITY);
    }

    /// Against FFmpeg's own ebur128 on synthetic sounds (what `levels` used
    /// to run for every measurement).
    #[test]
    fn matches_ffmpeg_ebur128() {
        let dir = std::env::temp_dir().join(format!("edit-loudness-ff-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sounds = [
            // Speech-like: noise bursts with gaps (the gate matters), stereo 48 kHz.
            (
                "bursts.wav",
                "anoisesrc=d=20:c=pink:r=48000:a=0.3,volume='if(lt(mod(t,2),1.2),1,0.02)':eval=frame,aformat=channel_layouts=stereo",
            ),
            // Mono 44.1 kHz tone with a fade.
            (
                "tone.wav",
                "sine=f=220:r=44100:d=12,afade=t=in:d=4,volume=0.4",
            ),
            // A click.
            (
                "click.wav",
                "sine=f=2000:r=48000:d=0.04,volume=0.8,apad=pad_dur=1",
            ),
        ];
        for (name, filter) in sounds {
            let path = dir.join(name);
            let made = Command::new(crate::tools::ffmpeg())
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    filter,
                ])
                .arg(&path)
                .status()
                .unwrap();
            assert!(made.success(), "{name}");
            let blocks = analyse(&path).unwrap();
            for (from, seconds) in [(0.0, 8.0), (3.3, 6.1), (0.0, 0.3), (1.0, 2.5), (0.0, 40.0)] {
                let ours = blocks.span(from, seconds);
                let theirs = ebur128(&path, from, seconds);
                let ours_lufs = if seconds > 3.0 && ours.integrated > -70.0 {
                    ours.integrated
                } else {
                    ours.loudest
                };
                // Silent either way (the tool calls both silent).
                if ours_lufs <= -70.0 && theirs.0 <= -70.0 {
                    continue;
                }
                assert!(
                    (ours_lufs - theirs.0).abs() < 0.5,
                    "{name} {from}+{seconds}: ours {ours:?}, ffmpeg {theirs:?}"
                );
                assert!(
                    (ours.peak - theirs.1).abs() < 0.5 || ours.peak < -60.0,
                    "{name} {from}+{seconds}: peak ours {ours:?}, ffmpeg {theirs:?}"
                );
            }
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A real file against FFmpeg, with timings:
    /// `EDIT_LOUDNESS_FILE=/path/to/footage.mp4 cargo test -p edit real_file -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_file() {
        let Some(path) = std::env::var_os("EDIT_LOUDNESS_FILE").map(PathBuf::from) else {
            return;
        };
        let started = Instant::now();
        let blocks = analyse(&path).unwrap();
        let analysed = started.elapsed();
        let length = blocks.energy.len() as f64 / blocks.rate;
        println!("analysed {length:.0} s of sound in {analysed:?}");
        for (from, seconds) in [
            (0.0, length.min(60.0)),
            (length * 0.3, 12.5),
            (length * 0.5, 2.0),
            (0.0, length),
        ] {
            let started = Instant::now();
            let ours = blocks.span(from, seconds);
            let ours_took = started.elapsed();
            let started = Instant::now();
            let theirs = ebur128(&path, from, seconds);
            let theirs_took = started.elapsed();
            println!(
                "{from:.1}+{seconds:.1}s: ours I {:.2} M {:.2} peak {:.2} in {ours_took:?}; ffmpeg {:.2} peak {:.2} in {theirs_took:?}",
                ours.integrated, ours.loudest, ours.peak, theirs.0, theirs.1
            );
        }
    }

    /// FFmpeg's measurement as `library::levels` used to make it.
    fn ebur128(path: &Path, from: f64, seconds: f64) -> (f64, f64) {
        let output = Command::new(crate::tools::ffmpeg())
            .args(["-hide_banner", "-nostats"])
            .args(["-ss", &format!("{from:.3}"), "-t", &format!("{seconds:.3}")])
            .arg("-i")
            .arg(path)
            .args([
                "-map",
                "0:a:0",
                "-af",
                "apad=pad_dur=0.5,ebur128=peak=sample",
                "-f",
                "null",
                "-",
            ])
            .output()
            .unwrap();
        let log = String::from_utf8_lossy(&output.stderr);
        let value = |line: &str, key: &str| {
            line.split(key)
                .nth(1)
                .and_then(|rest| rest.split_whitespace().next())
                .and_then(|number| number.parse::<f64>().ok())
        };
        let loudest = log
            .lines()
            .filter(|line| line.contains(" M:"))
            .filter_map(|line| value(line, " M:"))
            .fold(f64::NEG_INFINITY, f64::max);
        let summary = |key: &str| {
            log.lines()
                .rev()
                .find(|line| line.trim_start().starts_with(key))
                .and_then(|line| value(line, key))
        };
        let peak = summary("Peak:").unwrap_or(0.0);
        match summary("I:") {
            Some(integrated) if seconds > 3.0 && integrated > -70.0 => (integrated, peak),
            _ => (loudest, peak),
        }
    }
}
