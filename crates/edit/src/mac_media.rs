//! Small, owning AVFoundation boundary. Handles stay on their creating thread.
//! FFmpeg remains the compatibility path for unsupported formats and export options.
use std::ffi::{c_char, c_void, CStr, CString};
use std::marker::PhantomData;
use std::path::Path;
use std::ptr::NonNull;
use std::rc::Rc;

unsafe extern "C" {
    fn edit_image_info(path: *const c_char, width: *mut u32, height: *mut u32) -> i32;
    fn edit_image_thumbnail(path: *const c_char, output: *const c_char) -> i32;
    fn edit_image_frame(
        path: *const c_char,
        width: u32,
        height: u32,
        rgba: *mut u8,
        length: usize,
    ) -> i32;
    fn edit_reader_open(
        path: *const c_char,
        width: u32,
        height: u32,
        error: *mut c_char,
        capacity: usize,
    ) -> *mut c_void;
    fn edit_reader_frame(
        handle: *mut c_void,
        time: f64,
        rgba: *mut u8,
        length: usize,
        error: *mut c_char,
        capacity: usize,
    ) -> i32;
    fn edit_reader_close(handle: *mut c_void);
    fn edit_writer_open(
        path: *const c_char,
        width: u32,
        height: u32,
        fps: f64,
        hevc: i32,
        bitrate: u64,
        key_interval: i32,
        error: *mut c_char,
        capacity: usize,
    ) -> *mut c_void;
    fn edit_writer_frame(
        handle: *mut c_void,
        frame: i64,
        rgba: *const u8,
        length: usize,
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

pub struct Reader {
    handle: NonNull<c_void>,
    _thread: PhantomData<Rc<()>>,
}

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
            _thread: PhantomData,
        })
    }

    pub fn frame(&mut self, time: f64, rgba: &mut [u8]) -> Result<(), String> {
        let mut error = [0; 1024];
        // Exclusive handle and output access; C checks the exact output length.
        let ok = unsafe {
            edit_reader_frame(
                self.handle.as_ptr(),
                time,
                rgba.as_mut_ptr(),
                rgba.len(),
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
}

impl Drop for Reader {
    fn drop(&mut self) {
        // One retained handle, released exactly once.
        unsafe { edit_reader_close(self.handle.as_ptr()) };
    }
}

pub struct Writer {
    handle: NonNull<c_void>,
    _thread: PhantomData<Rc<()>>,
}

impl Writer {
    pub fn open(
        path: &Path,
        width: u32,
        height: u32,
        fps: f64,
        hevc: bool,
        bitrate: u64,
        key_interval: i32,
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
                i32::from(hevc),
                bitrate,
                key_interval,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        Ok(Self {
            handle: NonNull::new(handle).ok_or_else(|| message(&error))?,
            _thread: PhantomData,
        })
    }

    pub fn frame(&mut self, frame: i64, rgba: &[u8]) -> Result<(), String> {
        let mut error = [0; 1024];
        // The bridge copies this frame into its pool before returning.
        let ok = unsafe {
            edit_writer_frame(
                self.handle.as_ptr(),
                frame,
                rgba.as_ptr(),
                rgba.len(),
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
            Err(message(&error))
        }
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        // Cancels an unfinished writer as well as releasing a completed one.
        unsafe { edit_writer_close(self.handle.as_ptr()) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn native_roundtrip_seeks_rotates_and_preserves_fractional_rate() {
        let dir = std::env::temp_dir().join(format!(
            "edit-native-{}-{}",
            std::process::id(),
            crate::store::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("source.mp4");
        let fps = 30000.0 / 1001.0;
        let mut writer = Writer::open(&path, 64, 32, fps, false, 2_000_000, 15).unwrap();
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
            writer.frame(frame, &pixels).unwrap();
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
            reader.frame(f64::from(frame) / fps, &mut pixels).unwrap();
            let left = &pixels[16 * 64 * 4 + 16 * 4..][..4];
            assert!(left[0] > 190 && left[1] < 40, "frame {frame}: {left:?}");
            assert!(
                (i32::from(left[2]) - frame * 3).abs() < 15,
                "seek {frame}: {left:?}"
            );
        }

        let rotated = dir.join("rotated.mp4");
        let made = Command::new(crate::tools::ffmpeg())
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
        reader.frame(0.0, &mut pixels).unwrap();
        let reference = Command::new(crate::tools::ffmpeg())
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

    #[test]
    fn images_keep_orientation_alpha_and_pixels_without_video() {
        let dir = std::env::temp_dir().join(format!(
            "edit-image-{}-{}",
            std::process::id(),
            crate::store::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
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
