//! Small, owning AVFoundation boundary. A handle is used by one thread at a
//! time (it may move between threads; AVFoundation's objects allow that).
//! FFmpeg remains the compatibility path for unsupported formats and export options.
use std::ffi::{c_char, c_void, CStr, CString};
use std::path::Path;
use std::ptr::NonNull;

unsafe extern "C" {
    fn edit_smooth_supported() -> i32;
    #[allow(clippy::too_many_arguments)]
    fn edit_smooth(
        path: *const c_char,
        start: f64,
        length: f64,
        speed: f64,
        fps: f64,
        max_w: u32,
        max_h: u32,
        bitrate: u64,
        output: *const c_char,
        pause: Option<extern "C" fn()>,
        error: *mut c_char,
        capacity: usize,
    ) -> i32;
    fn edit_image_info(path: *const c_char, width: *mut u32, height: *mut u32) -> i32;
    fn edit_keychain_get(
        service: *const c_char,
        account: *const c_char,
        out: *mut c_char,
        capacity: usize,
        length: *mut usize,
    ) -> i32;
    fn edit_keychain_set(
        service: *const c_char,
        account: *const c_char,
        value: *const c_char,
    ) -> i32;
    fn edit_keychain_delete(service: *const c_char, account: *const c_char) -> i32;
    fn edit_image_thumbnail(path: *const c_char, output: *const c_char) -> i32;
    fn edit_subject_cutout(
        input: *const c_char,
        output: *const c_char,
        x: f64,
        y: f64,
        bounds: *mut f64,
        error: *mut c_char,
        capacity: usize,
    ) -> i32;
    fn edit_image_frame(
        path: *const c_char,
        width: u32,
        height: u32,
        rgba: *mut u8,
        length: usize,
    ) -> i32;
    fn edit_image_encode(
        rgba: *const u8,
        width: u32,
        height: u32,
        stride: usize,
        jpeg: i32,
        quality: f64,
    ) -> *mut c_void;
    fn edit_data_bytes(data: *mut c_void) -> *const u8;
    fn edit_data_length(data: *mut c_void) -> usize;
    fn edit_data_release(data: *mut c_void);
    fn edit_scale(
        source: *const u8,
        sw: u32,
        sh: u32,
        sstride: usize,
        dest: *mut u8,
        dw: u32,
        dh: u32,
        dstride: usize,
    ) -> i32;
    fn edit_text(bgra: *const u8, width: u32, height: u32, stride: usize) -> *mut c_void;
    fn edit_faces(
        bgra: *const u8,
        width: u32,
        height: u32,
        stride: usize,
        out: *mut f32,
        max: usize,
        count: *mut usize,
    ) -> i32;
    fn edit_reader_open(
        path: *const c_char,
        width: u32,
        height: u32,
        error: *mut c_char,
        capacity: usize,
    ) -> *mut c_void;
    #[allow(clippy::too_many_arguments)]
    fn edit_reader_frame(
        handle: *mut c_void,
        time: f64,
        out: *mut u8,
        length: usize,
        rgba: i32,
        if_changed: i32,
        error: *mut c_char,
        capacity: usize,
    ) -> i32;
    fn edit_reader_span(handle: *mut c_void, end: *mut f64, step: *mut f64);
    fn edit_reader_close(handle: *mut c_void);
    fn edit_sound_open(path: *const c_char, error: *mut c_char, capacity: usize) -> *mut c_void;
    fn edit_sound_close(handle: *mut c_void);
    fn edit_sound_reader_open(
        sound: *mut c_void,
        start: f64,
        duration: f64,
        error: *mut c_char,
        capacity: usize,
    ) -> *mut c_void;
    fn edit_sound_read(
        handle: *mut c_void,
        out: *mut f32,
        frames: usize,
        written: *mut usize,
        error: *mut c_char,
        capacity: usize,
    ) -> i32;
    fn edit_sound_reader_close(handle: *mut c_void);
    fn edit_speaker_open(capacity: usize, error: *mut c_char, error_capacity: usize)
        -> *mut c_void;
    fn edit_speaker_write(handle: *mut c_void, samples: *const f32, frames: usize) -> usize;
    fn edit_speaker_run(handle: *mut c_void, on: i32);
    fn edit_speaker_flush(handle: *mut c_void);
    fn edit_speaker_state(
        handle: *mut c_void,
        played: *mut u64,
        buffered: *mut u64,
        starved: *mut u64,
    );
    fn edit_speaker_latency(handle: *mut c_void) -> f64;
    fn edit_speaker_close(handle: *mut c_void);
    fn edit_sound_writer_open(
        path: *const c_char,
        bitrate: u32,
        error: *mut c_char,
        capacity: usize,
    ) -> *mut c_void;
    fn edit_sound_writer_write(
        handle: *mut c_void,
        samples: *const f32,
        frames: usize,
        error: *mut c_char,
        capacity: usize,
    ) -> i32;
    fn edit_sound_writer_finish(handle: *mut c_void, error: *mut c_char, capacity: usize) -> i32;
    fn edit_sound_writer_close(handle: *mut c_void);
    #[allow(clippy::too_many_arguments)]
    fn edit_writer_open(
        path: *const c_char,
        width: u32,
        height: u32,
        fps: f64,
        hevc: i32,
        bitrate: u64,
        key_interval: i32,
        flags: i32,
        error: *mut c_char,
        capacity: usize,
    ) -> *mut c_void;
    #[allow(clippy::too_many_arguments)]
    fn edit_writer_frame(
        handle: *mut c_void,
        frame: i64,
        pixels: *const u8,
        length: usize,
        stride: usize,
        rgba: i32,
        error: *mut c_char,
        capacity: usize,
    ) -> i32;
    fn edit_writer_finish(
        handle: *mut c_void,
        frames: i64,
        error: *mut c_char,
        capacity: usize,
    ) -> i32;
    fn edit_writer_close(handle: *mut c_void);
}

pub fn image_size(path: &Path) -> Result<(u32, u32), String> {
    let path = path_string(path)?;
    let (mut width, mut height) = (0, 0);
    // The bridge writes only these two integers and copies the path immediately.
    let ok = unsafe { edit_image_info(path.as_ptr(), &mut width, &mut height) };
    if ok == 1 {
        Ok((width, height))
    } else {
        Err("ImageIO couldn't read the image dimensions".to_owned())
    }
}

pub fn image_thumbnail(path: &Path, output: &Path) -> Result<(), String> {
    let (path, output) = (path_string(path)?, path_string(output)?);
    // Both paths are borrowed for this call only; ImageIO owns its output file.
    let ok = unsafe { edit_image_thumbnail(path.as_ptr(), output.as_ptr()) };
    if ok == 1 {
        Ok(())
    } else {
        Err("ImageIO couldn't make the thumbnail".to_owned())
    }
}

/// A picture's subject lifted out (Vision's foreground instances): `input` at
/// its own size with everything else transparent, as a PNG at `output`. With
/// `point` (0..1 from the top left), only the subject under it; else every one.
/// The subject's box comes back as x0, y0, x1, y1 (0..1 from the top left).
pub fn subject_cutout(
    input: &Path,
    output: &Path,
    point: Option<(f64, f64)>,
) -> Result<[f64; 4], String> {
    let (input, output) = (path_string(input)?, path_string(output)?);
    let (x, y) = point.unwrap_or((-1.0, -1.0));
    let mut bounds = [0.0_f64; 4];
    let mut error = [0; 1024];
    // Both paths are borrowed for this call only; the bridge writes four numbers into `bounds`.
    let ok = unsafe {
        edit_subject_cutout(
            input.as_ptr(),
            output.as_ptr(),
            x,
            y,
            bounds.as_mut_ptr(),
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if ok == 1 {
        Ok(bounds)
    } else {
        Err(message(&error))
    }
}

pub fn image(path: &Path, width: u32, height: u32, rgba: &mut [u8]) -> Result<(), String> {
    let path = path_string(path)?;
    // The bridge checks the exact buffer length before writing; no pointer escapes.
    let ok =
        unsafe { edit_image_frame(path.as_ptr(), width, height, rgba.as_mut_ptr(), rgba.len()) };
    if ok == 1 {
        Ok(())
    } else {
        Err("ImageIO couldn't decode the image".to_owned())
    }
}

/// An opaque RGBA picture (rows `stride` bytes apart) as JPEG at `quality`
/// (0–1), or as PNG when `quality` is None.
pub fn encode_image(
    rgba: &[u8],
    width: u32,
    height: u32,
    stride: usize,
    quality: Option<f64>,
) -> Result<Vec<u8>, String> {
    if width == 0
        || height == 0
        || stride < width as usize * 4
        || rgba.len() < stride * height as usize
    {
        return Err("image buffer doesn't match its size".to_owned());
    }
    // The bridge copies the pixels before returning; the CFData it hands back
    // is read, copied and released exactly once below.
    let data = unsafe {
        edit_image_encode(
            rgba.as_ptr(),
            width,
            height,
            stride,
            i32::from(quality.is_some()),
            quality.unwrap_or(1.0),
        )
    };
    if data.is_null() {
        return Err("ImageIO couldn't encode the image".to_owned());
    }
    let bytes = unsafe {
        let (pointer, length) = (edit_data_bytes(data), edit_data_length(data));
        let copy = if pointer.is_null() {
            Vec::new()
        } else {
            std::slice::from_raw_parts(pointer, length).to_vec()
        };
        edit_data_release(data);
        copy
    };
    Ok(bytes)
}

/// Words in a packed BGRA picture (Apple's Vision, the fast level): each piece
/// of text with its box, x0, y0, x1, y1 (0..1 from the top left), and the
/// recogniser's confidence.
pub fn text(bgra: &[u8], width: u32, height: u32) -> Result<Vec<([f32; 4], f32, String)>, String> {
    let stride = width as usize * 4;
    if width == 0 || height == 0 || bgra.len() < stride * height as usize {
        return Err("text picture doesn't match its size".to_owned());
    }
    // The bridge reads the pixels during the call only; the CFData it hands
    // back is read, copied and released exactly once below.
    let data = unsafe { edit_text(bgra.as_ptr(), width, height, stride) };
    if data.is_null() {
        return Err("Vision couldn't look for text".to_owned());
    }
    let bytes = unsafe {
        let (pointer, length) = (edit_data_bytes(data), edit_data_length(data));
        let copy = if pointer.is_null() {
            Vec::new()
        } else {
            std::slice::from_raw_parts(pointer, length).to_vec()
        };
        edit_data_release(data);
        copy
    };
    Ok(String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|line| {
            let (numbers, text) = line.split_once('\t')?;
            let values: Vec<f32> = numbers
                .split(' ')
                .filter_map(|value| value.parse().ok())
                .collect();
            let [x0, y0, x1, y1, sure] = values.as_slice() else {
                return None;
            };
            Some(([*x0, *y0, *x1, *y1], *sure, text.trim().to_owned()))
        })
        .filter(|(_, _, text)| !text.is_empty())
        .collect())
}

/// Faces in a packed BGRA picture (Apple's Vision): each as x0, y0, x1, y1
/// (0..1 from the top left) and the detector's confidence.
pub fn faces(bgra: &[u8], width: u32, height: u32) -> Result<Vec<[f32; 5]>, String> {
    const MAX: usize = 32;
    let stride = width as usize * 4;
    if width == 0 || height == 0 || bgra.len() < stride * height as usize {
        return Err("face picture doesn't match its size".to_owned());
    }
    let mut out = [0.0_f32; MAX * 5];
    let mut count = 0_usize;
    // The bridge reads the pixels during the call only and writes at most MAX faces.
    let ok = unsafe {
        edit_faces(
            bgra.as_ptr(),
            width,
            height,
            stride,
            out.as_mut_ptr(),
            MAX,
            &mut count,
        )
    };
    if ok != 1 {
        return Err("Vision couldn't look for faces".to_owned());
    }
    Ok(out
        .as_chunks::<5>()
        .0
        .iter()
        .take(count.min(MAX))
        .copied()
        .collect())
}

/// High-quality resample of a 4-channel, 8-bit picture (`sw`×`sh`, rows
/// `stride` bytes apart) into `dest` (`dw`×`dh`, packed).
pub fn scale(
    source: &[u8],
    (sw, sh, stride): (u32, u32, usize),
    dest: &mut [u8],
    (dw, dh): (u32, u32),
) -> Result<(), String> {
    if stride < sw as usize * 4
        || source.len() < stride * sh as usize
        || dest.len() != dw as usize * dh as usize * 4
    {
        return Err("scale buffers don't match their sizes".to_owned());
    }
    // Both buffers were checked against the sizes given.
    let ok = unsafe {
        edit_scale(
            source.as_ptr(),
            sw,
            sh,
            stride,
            dest.as_mut_ptr(),
            dw,
            dh,
            dw as usize * 4,
        )
    };
    if ok == 1 {
        Ok(())
    } else {
        Err("vImage couldn't scale the picture".to_owned())
    }
}

/// Whether this Mac's VideoToolbox does frame rate conversion (macOS 15.4+).
pub fn smooth_supported() -> bool {
    // SAFETY: no arguments; it only asks the framework.
    unsafe { edit_smooth_supported() == 1 }
}

extern "C" fn give_way() {
    crate::media::yield_to_foreground();
}

/// Smooth slow motion with VideoToolbox's frame rate conversion: `length`
/// seconds of `path` from `start`, played at `speed`, as frames at `fps`
/// with the in-between pictures made by the frame processor (`edit_smooth`
/// in mac_media.m), fitted within `max_w`×`max_h`, H.264 at `bitrate`, no
/// sound. It waits while an export runs.
#[allow(clippy::too_many_arguments)]
pub fn smooth(
    path: &Path,
    start: f64,
    length: f64,
    speed: f64,
    fps: f64,
    max: (u32, u32),
    bitrate: u64,
    output: &Path,
) -> Result<(), String> {
    let path = path_string(path)?;
    let output = path_string(output)?;
    let mut error = [0; 1024];
    // SAFETY: the strings and the error buffer outlive the call; `give_way` only sleeps.
    let done = unsafe {
        edit_smooth(
            path.as_ptr(),
            start,
            length,
            speed,
            fps,
            max.0,
            max.1,
            bitrate,
            output.as_ptr(),
            Some(give_way),
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if done == 1 {
        Ok(())
    } else {
        Err(message(&error))
    }
}

fn path_string(path: &Path) -> Result<CString, String> {
    CString::new(path.to_str().ok_or("native media path is not UTF-8")?)
        .map_err(|error| error.to_string())
}

fn message(error: &[c_char; 1024]) -> String {
    // All calls receive a zero-filled buffer; the C side uses bounded snprintf.
    unsafe { CStr::from_ptr(error.as_ptr()) }
        .to_string_lossy()
        .into_owned()
}

pub use crate::render::Order;

pub struct Reader {
    handle: NonNull<c_void>,
}

// AVAssetReader and its outputs may be used from any thread, one at a time;
// `&mut self` on every call makes that so.
unsafe impl Send for Reader {}

impl Reader {
    pub fn open(path: &Path, width: u32, height: u32) -> Result<Self, String> {
        let path = path_string(path)?;
        let mut error = [0; 1024];
        // The bridge retains the handle until Drop; the path is copied during open.
        let handle = unsafe {
            edit_reader_open(
                path.as_ptr(),
                width,
                height,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        Ok(Self {
            handle: NonNull::new(handle).ok_or_else(|| message(&error))?,
        })
    }

    /// The frame nearest `time` into `out`; Ok(false) without touching `out`
    /// when `if_changed` and it's the picture the last call copied.
    pub fn frame(
        &mut self,
        time: f64,
        out: &mut [u8],
        order: Order,
        if_changed: bool,
    ) -> Result<bool, String> {
        let mut error = [0; 1024];
        // Exclusive handle and output access; C checks the exact output length.
        let result = unsafe {
            edit_reader_frame(
                self.handle.as_ptr(),
                time,
                out.as_mut_ptr(),
                out.len(),
                i32::from(order == Order::Rgba),
                i32::from(if_changed),
                error.as_mut_ptr(),
                error.len(),
            )
        };
        match result {
            1 => Ok(true),
            2 => Ok(false),
            _ => Err(message(&error)),
        }
    }

    /// Where the pictures end (seconds into the source) and one frame's
    /// length: [`Reader::frame`] holds the last picture for any later time.
    pub fn span(&self) -> (f64, f64) {
        let (mut end, mut step) = (0.0, 0.0);
        // Reads two fields of the handle this reader owns.
        unsafe { edit_reader_span(self.handle.as_ptr(), &mut end, &mut step) };
        (end, step)
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        // One retained handle, released exactly once.
        unsafe { edit_reader_close(self.handle.as_ptr()) };
    }
}

/// A file's sound track, opened once for any number of stretches.
pub struct Sound {
    handle: NonNull<c_void>,
}

// As Reader: an AVAsset may be used from any thread.
unsafe impl Send for Sound {}

impl Sound {
    pub fn open(path: &Path) -> Result<Self, String> {
        let path = path_string(path)?;
        let mut error = [0; 1024];
        // Retained until Drop; the path is copied during open.
        let handle = unsafe { edit_sound_open(path.as_ptr(), error.as_mut_ptr(), error.len()) };
        Ok(Self {
            handle: NonNull::new(handle).ok_or_else(|| message(&error))?,
        })
    }

    /// `duration` seconds from `start` as 48 kHz stereo float, read in order.
    pub fn stretch(&self, start: f64, duration: f64) -> Result<SoundReader, String> {
        let mut error = [0; 1024];
        // The reader retains the asset itself, so it may outlive this Sound.
        let handle = unsafe {
            edit_sound_reader_open(
                self.handle.as_ptr(),
                start,
                duration,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        Ok(SoundReader {
            handle: NonNull::new(handle).ok_or_else(|| message(&error))?,
        })
    }
}

impl Drop for Sound {
    fn drop(&mut self) {
        // One retained handle, released exactly once.
        unsafe { edit_sound_close(self.handle.as_ptr()) };
    }
}

pub struct SoundReader {
    handle: NonNull<c_void>,
}

// As Reader.
unsafe impl Send for SoundReader {}

impl SoundReader {
    /// Fills `out` (interleaved stereo) from where the last read stopped;
    /// returns the frames written (fewer only at the end of the file).
    pub fn read(&mut self, out: &mut [f32]) -> Result<usize, String> {
        let mut error = [0; 1024];
        let mut written = 0;
        // The bridge writes at most out.len() / 2 stereo frames.
        let ok = unsafe {
            edit_sound_read(
                self.handle.as_ptr(),
                out.as_mut_ptr(),
                out.len() / 2,
                &mut written,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if ok == 1 {
            Ok(written)
        } else {
            Err(message(&error))
        }
    }
}

impl Drop for SoundReader {
    fn drop(&mut self) {
        // One retained handle, released exactly once.
        unsafe { edit_sound_reader_close(self.handle.as_ptr()) };
    }
}

/// The player's sound out: a ring of 48 kHz stereo float the mixer writes,
/// played by CoreAudio; the frames played are the player's clock
/// (`crate::player`). Short of sound it plays silence and the clock holds.
pub struct Speaker {
    handle: NonNull<c_void>,
}

// The ring's ends are atomics and AVAudioEngine's calls are thread-safe; one
// thread writes (the mixer's), the others only start, stop, flush and read the state.
unsafe impl Send for Speaker {}
unsafe impl Sync for Speaker {}

/// What the speaker has played and holds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SpeakerState {
    /// Frames played in all.
    pub played: u64,
    /// Frames written and not yet played.
    pub buffered: u64,
    /// Output calls that ran short of sound while running.
    pub starved: u64,
}

impl Speaker {
    /// A speaker holding up to `capacity` frames ahead.
    pub fn open(capacity: usize) -> Result<Self, String> {
        let mut error = [0; 1024];
        // Retained until Drop.
        let handle = unsafe { edit_speaker_open(capacity, error.as_mut_ptr(), error.len()) };
        Ok(Self {
            handle: NonNull::new(handle).ok_or_else(|| message(&error))?,
        })
    }

    /// Writes as many frames of `samples` (interleaved stereo) as fit; how many did.
    pub fn write(&self, samples: &[f32]) -> usize {
        // The bridge reads at most samples.len() / 2 frames.
        unsafe { edit_speaker_write(self.handle.as_ptr(), samples.as_ptr(), samples.len() / 2) }
    }

    /// Sound comes out (true), or silence while the clock holds (false).
    pub fn run(&self, on: bool) {
        // A flag on the handle this speaker owns.
        unsafe { edit_speaker_run(self.handle.as_ptr(), i32::from(on)) };
    }

    /// Drops what's buffered (stopping first).
    pub fn flush(&self) {
        // A flag and two counters on the handle this speaker owns.
        unsafe { edit_speaker_flush(self.handle.as_ptr()) };
    }

    pub fn state(&self) -> SpeakerState {
        let mut state = SpeakerState::default();
        // Reads three counters of the handle this speaker owns.
        unsafe {
            edit_speaker_state(
                self.handle.as_ptr(),
                &mut state.played,
                &mut state.buffered,
                &mut state.starved,
            );
        }
        state
    }

    /// Seconds between a frame leaving the ring and the speaker.
    pub fn latency(&self) -> f64 {
        // Reads the engine's output node.
        unsafe { edit_speaker_latency(self.handle.as_ptr()) }
    }
}

impl Drop for Speaker {
    fn drop(&mut self) {
        // One retained handle, released exactly once.
        unsafe { edit_speaker_close(self.handle.as_ptr()) };
    }
}

/// AAC in an .m4a, encoded by AudioToolbox from 48 kHz stereo float.
pub struct SoundWriter {
    handle: NonNull<c_void>,
}

// As Reader.
unsafe impl Send for SoundWriter {}

impl SoundWriter {
    pub fn open(path: &Path, bitrate: u32) -> Result<Self, String> {
        let path = path_string(path)?;
        let mut error = [0; 1024];
        // Retained until Drop; the path is copied during open.
        let handle = unsafe {
            edit_sound_writer_open(path.as_ptr(), bitrate, error.as_mut_ptr(), error.len())
        };
        Ok(Self {
            handle: NonNull::new(handle).ok_or_else(|| message(&error))?,
        })
    }

    /// Appends interleaved stereo samples.
    pub fn write(&mut self, samples: &[f32]) -> Result<(), String> {
        let mut error = [0; 1024];
        // The bridge copies samples.len() / 2 frames before returning.
        let ok = unsafe {
            edit_sound_writer_write(
                self.handle.as_ptr(),
                samples.as_ptr(),
                samples.len() / 2,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if ok == 1 {
            Ok(())
        } else {
            Err(message(&error))
        }
    }

    pub fn finish(&mut self) -> Result<(), String> {
        let mut error = [0; 1024];
        let ok = unsafe {
            edit_sound_writer_finish(self.handle.as_ptr(), error.as_mut_ptr(), error.len())
        };
        if ok == 1 {
            Ok(())
        } else {
            Err(message(&error))
        }
    }
}

impl Drop for SoundWriter {
    fn drop(&mut self) {
        // Cancels an unfinished writer as well as releasing a completed one.
        unsafe { edit_sound_writer_close(self.handle.as_ptr()) };
    }
}

/// How a writer encodes.
#[derive(Clone, Copy, Debug, Default)]
pub struct WriterOptions {
    pub hevc: bool,
    pub bitrate: u64,
    pub key_interval: i32,
    /// A finished export: B-frames and the High profile (previews keep every
    /// frame decodable as it arrives).
    pub finished: bool,
    /// The index at the front of the file; only when nothing remuxes it after.
    pub faststart: bool,
}

pub struct Writer {
    handle: NonNull<c_void>,
}

// As Reader: an AVAssetWriter may be driven from any one thread at a time.
unsafe impl Send for Writer {}

impl Writer {
    pub fn open(
        path: &Path,
        width: u32,
        height: u32,
        fps: f64,
        options: WriterOptions,
    ) -> Result<Self, String> {
        let path = path_string(path)?;
        let mut error = [0; 1024];
        // The bridge copies settings and owns its bounded pixel-buffer pool.
        let handle = unsafe {
            edit_writer_open(
                path.as_ptr(),
                width,
                height,
                fps,
                i32::from(options.hevc),
                options.bitrate,
                options.key_interval,
                i32::from(options.finished) | (i32::from(options.faststart) << 1),
                error.as_mut_ptr(),
                error.len(),
            )
        };
        Ok(Self {
            handle: NonNull::new(handle).ok_or_else(|| message(&error))?,
        })
    }

    /// Appends a picture whose rows are `stride` bytes apart.
    pub fn frame(
        &mut self,
        frame: i64,
        pixels: &[u8],
        stride: usize,
        order: Order,
    ) -> Result<(), String> {
        let mut error = [0; 1024];
        // The bridge checks the length against its size and copies the frame
        // into its pool before returning.
        let ok = unsafe {
            edit_writer_frame(
                self.handle.as_ptr(),
                frame,
                pixels.as_ptr(),
                pixels.len(),
                stride,
                i32::from(order == Order::Rgba),
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if ok == 1 {
            Ok(())
        } else {
            Err(encoder_said(&error))
        }
    }

    pub fn finish(&mut self, frames: i64) -> Result<(), String> {
        let mut error = [0; 1024];
        let ok = unsafe {
            edit_writer_finish(
                self.handle.as_ptr(),
                frames,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if ok == 1 {
            Ok(())
        } else {
            Err(encoder_said(&error))
        }
    }
}

/// The video encoder's error, said as the native encoder's (AVFoundation's
/// own words don't say so), so an export knows to try FFmpeg's.
fn encoder_said(error: &[c_char; 1024]) -> String {
    let said = message(error);
    if said.to_lowercase().contains("native encoder") {
        said
    } else {
        format!("Native encoder: {said}")
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        // Cancels an unfinished writer as well as releasing a completed one.
        unsafe { edit_writer_close(self.handle.as_ptr()) };
    }
}

/// The Keychain's "no such item".
pub const KEYCHAIN_NOT_FOUND: i32 = -25300;

/// A string for the Keychain calls (errSecParam for one with a NUL in it).
fn keychain_string(value: &str) -> Result<CString, i32> {
    CString::new(value).map_err(|_| -50)
}

/// A generic password this program may read, without a prompt (mac_media.m):
/// `Ok(None)` when there's none, `Err(status)` otherwise (-25308,
/// errSecInteractionNotAllowed, or -25293: an item this program isn't trusted for).
pub fn keychain_get(service: &str, account: &str) -> Result<Option<String>, i32> {
    let (service, account) = (keychain_string(service)?, keychain_string(account)?);
    let mut out = vec![0u8; 16 * 1024];
    let mut length = 0usize;
    // SAFETY: the strings live through the call; `out` has `capacity` bytes and the call writes at most that many.
    let status = unsafe {
        edit_keychain_get(
            service.as_ptr(),
            account.as_ptr(),
            out.as_mut_ptr().cast(),
            out.len(),
            &mut length,
        )
    };
    match status {
        0 => {
            out.truncate(length);
            String::from_utf8(out).map(Some).map_err(|_| -26275)
        }
        KEYCHAIN_NOT_FOUND => Ok(None),
        other => Err(other),
    }
}

/// Keeps a generic password, made (when new) to trust only this program.
pub fn keychain_set(service: &str, account: &str, value: &str) -> Result<(), i32> {
    let (service, account, value) = (
        keychain_string(service)?,
        keychain_string(account)?,
        keychain_string(value)?,
    );
    // SAFETY: the strings live through the call.
    match unsafe { edit_keychain_set(service.as_ptr(), account.as_ptr(), value.as_ptr()) } {
        0 => Ok(()),
        other => Err(other),
    }
}

/// Removes a generic password (none there is fine).
pub fn keychain_delete(service: &str, account: &str) -> Result<(), i32> {
    let (service, account) = (keychain_string(service)?, keychain_string(account)?);
    // SAFETY: the strings live through the call.
    match unsafe { edit_keychain_delete(service.as_ptr(), account.as_ptr()) } {
        0 => Ok(()),
        other => Err(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "edit-{name}-{}-{}",
            std::process::id(),
            crate::util::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn proxy_options() -> WriterOptions {
        WriterOptions {
            bitrate: 2_000_000,
            key_interval: 15,
            ..Default::default()
        }
    }

    #[test]
    fn native_roundtrip_seeks_rotates_and_preserves_fractional_rate() {
        let dir = temp_dir("native");
        let path = dir.join("source.mp4");
        // A stale partial file must not stop the writer.
        std::fs::write(&path, b"stale").unwrap();
        let fps = 30000.0 / 1001.0;
        let mut writer = Writer::open(&path, 64, 32, fps, proxy_options()).unwrap();
        for frame in 0..60 {
            let mut pixels = vec![0; 64 * 32 * 4];
            for (index, pixel) in pixels.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                let color = if index % 64 < 32 {
                    [220, 20, frame as u8 * 3, 255]
                } else {
                    [20, 220, frame as u8 * 3, 255]
                };
                pixel.copy_from_slice(&color);
            }
            writer.frame(frame, &pixels, 64 * 4, Order::Rgba).unwrap();
        }
        writer.finish(60).unwrap();
        drop(writer);
        let info = crate::media::probe(&path).unwrap();
        assert!((info.fps - fps).abs() < 0.001, "{}", info.fps);
        assert!(
            (info.duration - 60.0 / fps).abs() < 0.002,
            "{}",
            info.duration
        );

        let mut reader = Reader::open(&path, 64, 32).unwrap();
        let mut pixels = vec![0; 64 * 32 * 4];
        for frame in [0, 15, 30, 3, 59, 0] {
            reader
                .frame(f64::from(frame) / fps, &mut pixels, Order::Rgba, false)
                .unwrap();
            let left = &pixels[16 * 64 * 4 + 16 * 4..][..4];
            assert!(left[0] > 190 && left[1] < 40, "frame {frame}: {left:?}");
            assert!(
                (i32::from(left[2]) - frame * 3).abs() < 15,
                "seek {frame}: {left:?}"
            );
        }
        // The same picture again is reported, not copied; the nearest frame is chosen.
        assert!(!reader
            .frame(0.2 / fps, &mut pixels, Order::Rgba, true)
            .unwrap());
        assert!(reader
            .frame(0.7 / fps, &mut pixels, Order::Bgra, true)
            .unwrap());
        let left = &pixels[16 * 64 * 4 + 16 * 4..][..4];
        assert!(left[2] > 190 && left[1] < 40, "BGRA order: {left:?}");
        assert!(i32::from(left[0]) < 15, "nearest is frame 1: {left:?}");
        // Past the last picture holds it.
        assert!(reader.frame(10.0, &mut pixels, Order::Rgba, false).unwrap());

        let rotated = dir.join("rotated.mp4");
        let made = Command::new(crate::util::ffmpeg())
            .args(["-v", "error", "-display_rotation", "90", "-i"])
            .arg(&path)
            .args(["-c", "copy"])
            .arg(&rotated)
            .status()
            .unwrap();
        assert!(made.success());
        let info = crate::media::probe(&rotated).unwrap();
        assert_eq!((info.width, info.height), (32, 64));
        let mut reader = Reader::open(&rotated, 32, 64).unwrap();
        reader.frame(0.0, &mut pixels, Order::Rgba, false).unwrap();
        let reference = Command::new(crate::util::ffmpeg())
            .args(["-v", "error", "-threads", "1", "-i"])
            .arg(&rotated)
            .args([
                "-frames:v",
                "1",
                "-threads",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgba",
                "pipe:1",
            ])
            .output()
            .unwrap();
        assert!(reference.status.success());
        let delta = pixels
            .iter()
            .zip(&reference.stdout)
            .map(|(a, b)| (i32::from(*a) - i32::from(*b)).unsigned_abs() as f64)
            .sum::<f64>()
            / pixels.len() as f64;
        assert!(delta < 8.0, "rotation/color difference: {delta}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A clip whose sound runs on past its last picture: reading near the end
    /// holds the last picture instead of failing (the range used to run to
    /// the longer sound track's end).
    #[test]
    fn reads_past_the_video_track_when_the_sound_is_longer() {
        let dir = temp_dir("longer-sound");
        let path = dir.join("short-video.mp4");
        let made = Command::new(crate::util::ffmpeg())
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg("testsrc2=size=64x32:rate=30:duration=1")
            .args(["-f", "lavfi", "-i", "sine=duration=3:sample_rate=48000"])
            .args(["-c:v", "libx264", "-c:a", "aac"])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        let mut reader = Reader::open(&path, 64, 32).unwrap();
        let mut pixels = vec![0; 64 * 32 * 4];
        for time in [2.5, 0.5, 1.5, 2.9] {
            reader
                .frame(time, &mut pixels, Order::Rgba, false)
                .unwrap_or_else(|error| panic!("{time}: {error}"));
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A file whose first picture isn't at 0 has an empty edit there (our
    /// slowed clips' renders do), which AVFoundation fills with a made-up
    /// black picture: a clip from 0 showed it as a black frame at the cut.
    #[test]
    fn a_leading_empty_edit_shows_the_first_picture_not_black() {
        let dir = temp_dir("empty-edit");
        let path = dir.join("late-start.mp4");
        let made = Command::new(crate::util::ffmpeg())
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg("testsrc2=size=64x32:rate=30:duration=1")
            .args(["-vf", "setpts=PTS+0.1/TB", "-c:v", "libx264"])
            .args(["-pix_fmt", "yuv420p"])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        let mut reader = Reader::open(&path, 64, 32).unwrap();
        let mut first = vec![0; 64 * 32 * 4];
        reader.frame(0.1, &mut first, Order::Rgba, false).unwrap();
        let mut reader = Reader::open(&path, 64, 32).unwrap();
        for time in [0.0, 0.05] {
            let mut pixels = vec![0; 64 * 32 * 4];
            reader.frame(time, &mut pixels, Order::Rgba, false).unwrap();
            let bright = pixels.iter().map(|&value| u64::from(value)).sum::<u64>();
            assert!(bright > 64 * 32 * 255, "{time}: a black picture");
            assert_eq!(pixels, first, "{time}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sound_stretches_start_on_the_sample() {
        let dir = temp_dir("sound");
        let path = dir.join("clicks.m4a");
        // A click every 0.25 s on the left, silence on the right.
        let made = Command::new(crate::util::ffmpeg())
            .args(["-v", "error", "-f", "lavfi", "-i"])
            .arg("aevalsrc='if(lt(mod(n\\,12000)\\,24)\\,0.8\\,0)|0':s=48000:d=3")
            .args(["-c:a", "aac", "-b:a", "256k"])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        let sound = Sound::open(&path).unwrap();
        let mut reader = sound.stretch(1.1, 1.0).unwrap();
        let mut samples = vec![0.0_f32; 48000 * 2];
        let mut filled = 0;
        while filled < samples.len() / 2 {
            let n = reader.read(&mut samples[filled * 2..]).unwrap();
            if n == 0 {
                break;
            }
            filled += n;
        }
        assert_eq!(filled, 48000);
        // Clicks at 1.25, 1.5, 1.75, 2.0 s of the file: 0.15 s, 0.4 s, … into the stretch.
        let loudest = |from: usize, to: usize| {
            (from..to)
                .max_by(|a, b| samples[a * 2].abs().total_cmp(&samples[b * 2].abs()))
                .unwrap()
        };
        for (index, click) in [7200_usize, 19200, 31200, 43200].into_iter().enumerate() {
            let at = loudest(click - 2400, click + 2400);
            assert!(
                at.abs_diff(click + 12) < 48,
                "click {index} at {at}, expected about {click}"
            );
        }
        let right = samples
            .iter()
            .skip(1)
            .step_by(2)
            .fold(0.0_f32, |m, v| m.max(v.abs()));
        assert!(right < 0.05, "right channel stays quiet: {right}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[ignore]
    fn probe_timings() {
        use std::time::Instant;
        let path = Path::new(&std::env::var("PROBE").unwrap()).to_owned();
        let t = Instant::now();
        let sound = Sound::open(&path).unwrap();
        eprintln!("sound open {:?}", t.elapsed());
        for start in [10.0, 60.0, 100.0] {
            let t = Instant::now();
            let mut r = sound.stretch(start, 1.0).unwrap();
            let opened = t.elapsed();
            let mut buf = vec![0f32; 48000 * 2];
            let mut got = 0;
            while got < 48000 {
                let n = r.read(&mut buf[got * 2..]).unwrap();
                if n == 0 {
                    break;
                }
                got += n;
            }
            eprintln!(
                "stretch {start}: open {opened:?} read {:?} ({got})",
                t.elapsed()
            );
        }
        for (w, h) in [(1920, 1080), (640, 360)] {
            for time in [60.0, 61.0, 90.0] {
                let t = Instant::now();
                let mut reader = Reader::open(&path, w, h).unwrap();
                let opened = t.elapsed();
                let mut px = vec![0u8; w as usize * h as usize * 4];
                reader.frame(time, &mut px, Order::Bgra, false).unwrap();
                let first = t.elapsed();
                for k in 1..30 {
                    reader
                        .frame(time + k as f64 / 30.0, &mut px, Order::Bgra, false)
                        .unwrap();
                }
                eprintln!(
                    "{w}x{h} at {time}: open {opened:?} first {first:?} +29 frames {:?}",
                    t.elapsed()
                );
            }
        }
        let times: Vec<f64> = (0..12).map(|k| 5.0 + k as f64 * 9.0).collect();
        for threads in [1, 2, 4] {
            let t = Instant::now();
            std::thread::scope(|scope| {
                for chunk in times.chunks(12 / threads) {
                    let path = path.clone();
                    scope.spawn(move || {
                        let mut reader = Reader::open(&path, 640, 360).unwrap();
                        let mut px = vec![0u8; 640 * 360 * 4];
                        for time in chunk {
                            reader.frame(*time, &mut px, Order::Bgra, false).unwrap();
                        }
                    });
                }
            });
            eprintln!("12 seeks on {threads} threads: {:?}", t.elapsed());
        }
    }

    #[test]
    fn encodes_and_scales_pictures() {
        let (w, h) = (64_u32, 32_u32);
        let mut pixels = vec![255_u8; (w * h * 4) as usize];
        for (index, pixel) in pixels.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            if index % 64 < 32 {
                pixel.copy_from_slice(&[200, 30, 30, 255]);
            }
        }
        let jpeg = encode_image(&pixels, w, h, w as usize * 4, Some(0.8)).unwrap();
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
        let png = encode_image(&pixels, w, h, w as usize * 4, None).unwrap();
        assert_eq!(&png[1..4], b"PNG");
        let mut small = vec![0_u8; 16 * 8 * 4];
        scale(&pixels, (w, h, w as usize * 4), &mut small, (16, 8)).unwrap();
        assert!(small[0] > 180 && small[1] < 60, "{:?}", &small[..4]);
        assert!(small[15 * 4] > 240, "{:?}", &small[15 * 4..16 * 4]);
    }

    #[test]
    fn smoothed_frames_keep_the_footages_brightness() {
        // The horror drafts (Nov 5): every frame VideoToolbox made came out
        // far darker than the real ones either side, a flicker five times a
        // second.
        if !smooth_supported() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("edit-smooth-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("moving.mp4");
        let made = std::process::Command::new(crate::util::ffmpeg())
            // A phone's tall frame, tagged Rec. 709 (decoded with those tags, the processor's frames came out dark).
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=608x1080:rate=30:duration=3",
                "-pix_fmt",
                "yuv420p",
                "-x264-params",
                "colorprim=bt709:transfer=bt709:colormatrix=bt709",
                "-color_range",
                "tv",
                "-movflags",
                "+write_colr",
                "-c:v",
                "libx264",
                "-y",
            ])
            .arg(&source)
            .status()
            .unwrap();
        assert!(made.success());
        let out = dir.join("smoothed.mp4");
        if let Err(error) = smooth(&source, 0.5, 1.5, 0.8, 30.0, (608, 1080), 4_000_000, &out) {
            // GitHub's virtual Macs say they have frame rate conversion and
            // then refuse to run it (-19730); a real Mac runs it, and Edit
            // smooths with FFmpeg's optical flow where it's refused (broll.ts).
            assert!(
                error.contains("VTFrameProcessorErrorDomain error -19730"),
                "{error}"
            );
            eprintln!("skipped: VideoToolbox refused frame rate conversion here ({error})");
            std::fs::remove_dir_all(dir).ok();
            return;
        }
        let raw = std::process::Command::new(crate::util::ffmpeg())
            .args(["-v", "error", "-i"])
            .arg(&out)
            .args(["-vf", "scale=32:24,format=gray", "-f", "rawvideo", "-"])
            .output()
            .unwrap();
        let means: Vec<f64> = raw
            .stdout
            .chunks(32 * 24)
            .map(|f| f.iter().map(|&v| f64::from(v)).sum::<f64>() / f.len() as f64)
            .collect();
        assert!(means.len() > 20, "{} frames", means.len());
        for (i, pair) in means.windows(2).enumerate() {
            assert!(
                (pair[0] - pair[1]).abs() < 8.0,
                "frame {} is {:.0}, frame {} {:.0}: {means:?}",
                i,
                pair[0],
                i + 1,
                pair[1]
            );
        }
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn images_keep_orientation_alpha_and_pixels_without_video() {
        let dir = temp_dir("image");
        let path = dir.join("still.png");
        let pixels = vec![255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 0, 0, 0, 0];
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 2, 2);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .write_header()
                .unwrap()
                .write_image_data(&pixels)
                .unwrap();
        }
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(image_size(&path).unwrap(), (2, 2));
        let mut decoded = vec![0; 16];
        image(&path, 2, 2, &mut decoded).unwrap();
        assert_eq!(decoded, pixels);
        let info = crate::media::probe(&path).unwrap();
        assert_eq!(info.kind, edit_core::MediaKind::Image);
        assert!(!info.has_audio);
        assert!(dir
            .read_dir()
            .unwrap()
            .all(|entry| entry.unwrap().path().extension().unwrap() == "png"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
