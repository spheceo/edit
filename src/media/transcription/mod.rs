use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering},
        mpsc, Arc,
    },
    thread,
};

use eframe::egui;

use crate::{
    media::audio::render_sequence_audio_wav,
    project::{sequence::MediaId, Sequence, Transcript},
};

#[cfg(target_os = "macos")]
mod macos;

static TEMP_FILE_ID: AtomicU32 = AtomicU32::new(1);

pub enum TranscriptionResult {
    Finished(Transcript),
    Cancelled,
    Failed(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TranscriptionStage {
    Preparing,
    Recognizing,
}

pub struct TranscriptionJob {
    progress: Arc<AtomicU32>,
    stage: Arc<AtomicU8>,
    cancel: Arc<AtomicBool>,
    receiver: mpsc::Receiver<TranscriptionResult>,
}

impl TranscriptionJob {
    pub fn start(
        sources: HashMap<MediaId, PathBuf>,
        sequence: Sequence,
        ctx: egui::Context,
    ) -> Self {
        let progress = Arc::new(AtomicU32::new(0));
        let stage = Arc::new(AtomicU8::new(0));
        let cancel = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = mpsc::channel();
        let worker_progress = Arc::clone(&progress);
        let worker_stage = Arc::clone(&stage);
        let worker_cancel = Arc::clone(&cancel);

        thread::spawn(move || {
            let temporary = temporary_audio_path();
            worker_progress.store(25, Ordering::Release);
            let rendered = render_sequence_audio_wav(
                sources,
                &sequence,
                temporary.clone(),
                Arc::clone(&worker_cancel),
            );
            let result = match rendered {
                Err(_) if worker_cancel.load(Ordering::Acquire) => TranscriptionResult::Cancelled,
                Err(error) => TranscriptionResult::Failed(error),
                Ok(stats) if !stats.has_audible_signal() => TranscriptionResult::Failed(format!(
                    "The prepared sequence audio is effectively silent ({:.0} dBFS RMS across {:.1} seconds). Check clip audio levels and source media.",
                    stats.rms_dbfs(),
                    stats.duration_secs
                )),
                Ok(stats) => {
                    worker_progress.store(450, Ordering::Release);
                    worker_stage.store(1, Ordering::Release);
                    recognize(
                        temporary.clone(),
                        sequence.duration,
                        stats.rms_dbfs(),
                        Arc::clone(&worker_cancel),
                        Arc::clone(&worker_progress),
                    )
                }
            };
            let _ = fs::remove_file(temporary);
            let _ = sender.send(result);
            ctx.request_repaint();
        });

        Self {
            progress,
            stage,
            cancel,
            receiver,
        }
    }

    pub fn progress(&self) -> f32 {
        self.progress.load(Ordering::Acquire) as f32 / 1_000.0
    }

    pub fn stage(&self) -> TranscriptionStage {
        if self.stage.load(Ordering::Acquire) == 0 {
            TranscriptionStage::Preparing
        } else {
            TranscriptionStage::Recognizing
        }
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Release);
    }

    pub fn poll(&self) -> Option<TranscriptionResult> {
        self.receiver.try_recv().ok()
    }
}

impl Drop for TranscriptionJob {
    fn drop(&mut self) {
        self.cancel();
    }
}

pub const fn supported() -> bool {
    cfg!(target_os = "macos")
}

#[cfg(target_os = "macos")]
fn recognize(
    path: PathBuf,
    sequence_duration: f64,
    audio_rms_dbfs: f32,
    cancel: Arc<AtomicBool>,
    progress: Arc<AtomicU32>,
) -> TranscriptionResult {
    match macos::recognize_file(path, sequence_duration, audio_rms_dbfs, cancel, progress) {
        Ok(transcript) => TranscriptionResult::Finished(transcript),
        Err(error) if error == "cancelled" => TranscriptionResult::Cancelled,
        Err(error) => TranscriptionResult::Failed(error),
    }
}

#[cfg(not(target_os = "macos"))]
fn recognize(
    _path: PathBuf,
    _sequence_duration: f64,
    _audio_rms_dbfs: f32,
    _cancel: Arc<AtomicBool>,
    _progress: Arc<AtomicU32>,
) -> TranscriptionResult {
    TranscriptionResult::Failed("Transcription on Windows is coming soon.".to_owned())
}

fn temporary_audio_path() -> PathBuf {
    let token = TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "kuro-transcription-{}-{token}.wav",
        std::process::id()
    ))
}
