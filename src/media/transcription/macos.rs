use std::{
    path::Path,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc, Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use block2::RcBlock;
use objc2::{rc::autoreleasepool, AnyThread};
use objc2_foundation::{NSBundle, NSError, NSString, NSURL};
use objc2_speech::{
    SFSpeechRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTaskHint,
    SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus, SFSpeechURLRecognitionRequest,
};

use crate::project::{Transcript, TranscriptWord};

enum RecognitionEvent {
    Hypothesis {
        transcript: Transcript,
        is_final: bool,
    },
    Failed(String),
}

pub fn recognize_file(
    path: PathBuf,
    sequence_duration: f64,
    audio_rms_dbfs: f32,
    cancel: Arc<AtomicBool>,
    progress: Arc<AtomicU32>,
) -> Result<Transcript, String> {
    autoreleasepool(|_| unsafe {
        ensure_authorized(&cancel)?;
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".to_owned());
        }

        let recognizer =
            SFSpeechRecognizer::init(SFSpeechRecognizer::alloc()).ok_or_else(|| {
                "Speech recognition is unavailable for the current language.".to_owned()
            })?;
        if !recognizer.isAvailable() {
            return Err("Apple Speech is temporarily unavailable.".to_owned());
        }
        if !recognizer.supportsOnDeviceRecognition() {
            return Err(
                "The current macOS language does not have an on-device speech model installed."
                    .to_owned(),
            );
        }

        let language = recognizer.locale().localeIdentifier().to_string();
        let callback_language = language.clone();
        let path = NSString::from_str(&path.to_string_lossy());
        let url = NSURL::fileURLWithPath(&path);
        let request = SFSpeechURLRecognitionRequest::initWithURL(
            SFSpeechURLRecognitionRequest::alloc(),
            &url,
        );
        let base_request: &SFSpeechRecognitionRequest = &request;
        base_request.setRequiresOnDeviceRecognition(true);
        base_request.setShouldReportPartialResults(true);
        base_request.setAddsPunctuation(true);
        base_request.setTaskHint(SFSpeechRecognitionTaskHint::Dictation);

        let (sender, receiver) = mpsc::channel::<RecognitionEvent>();
        let callback_progress = Arc::clone(&progress);
        let callback = RcBlock::new(
            move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
                if !result.is_null() {
                    // Apple guarantees callback objects remain valid for the callback duration.
                    let result = &*result;
                    let transcription = result.bestTranscription();
                    let words = extract_words(&transcription);
                    if let Some(last) = words.last() {
                        let fraction =
                            (last.end_secs / sequence_duration.max(0.001)).clamp(0.0, 1.0);
                        callback_progress
                            .store(450 + (fraction * 525.0).round() as u32, Ordering::Release);
                    }
                    if result.isFinal() {
                        let _ = sender.send(RecognitionEvent::Hypothesis {
                            transcript: Transcript {
                                words,
                                language: Some(callback_language.clone()),
                                generated_unix_ms: unix_millis(),
                            },
                            is_final: true,
                        });
                    } else {
                        if !words.is_empty() {
                            let _ = sender.send(RecognitionEvent::Hypothesis {
                                transcript: Transcript {
                                    words,
                                    language: Some(callback_language.clone()),
                                    generated_unix_ms: unix_millis(),
                                },
                                is_final: false,
                            });
                        }
                        if !error.is_null() {
                            let error = &*error;
                            let _ = sender.send(RecognitionEvent::Failed(
                                error.localizedDescription().to_string(),
                            ));
                        }
                    }
                } else if !error.is_null() {
                    let error = &*error;
                    let _ = sender.send(RecognitionEvent::Failed(
                        error.localizedDescription().to_string(),
                    ));
                }
            },
        );
        let task = recognizer.recognitionTaskWithRequest_resultHandler(base_request, &callback);

        let mut best_partial = None;
        loop {
            if cancel.load(Ordering::Acquire) {
                task.cancel();
                return Err("cancelled".to_owned());
            }
            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(RecognitionEvent::Hypothesis {
                    transcript,
                    is_final: true,
                }) => {
                    if let Some(transcript) = completed_transcript(transcript, best_partial.take())
                    {
                        progress.store(1_000, Ordering::Release);
                        return Ok(transcript);
                    }
                    return Err(format!(
                        "Apple Speech ({language}) found no words, although the prepared audio is audible ({audio_rms_dbfs:.0} dBFS RMS). Check that the speech matches this Mac's Dictation language in System Settings → Keyboard → Dictation."
                    ));
                }
                Ok(RecognitionEvent::Hypothesis {
                    transcript,
                    is_final: false,
                }) => best_partial = Some(transcript),
                Ok(RecognitionEvent::Failed(error)) => {
                    return Err(format!("Speech recognition failed: {error}"));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("Apple Speech ended without a result.".to_owned());
                }
            }
        }
    })
}

unsafe fn ensure_authorized(cancel: &AtomicBool) -> Result<(), String> {
    ensure_app_bundle()?;
    ensure_usage_description()?;
    let status = unsafe { SFSpeechRecognizer::authorizationStatus() };
    if status == SFSpeechRecognizerAuthorizationStatus::Authorized {
        return Ok(());
    }
    if status == SFSpeechRecognizerAuthorizationStatus::Denied {
        return Err(
            "Speech Recognition access is disabled. Enable Kuro in System Settings → Privacy & Security → Speech Recognition."
                .to_owned(),
        );
    }
    if status == SFSpeechRecognizerAuthorizationStatus::Restricted {
        return Err("Speech Recognition is restricted on this Mac.".to_owned());
    }

    let (sender, receiver) = mpsc::channel();
    let callback = RcBlock::new(move |status: SFSpeechRecognizerAuthorizationStatus| {
        let _ = sender.send(status);
    });
    unsafe { SFSpeechRecognizer::requestAuthorization(&callback) };
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".to_owned());
        }
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(SFSpeechRecognizerAuthorizationStatus::Authorized) => return Ok(()),
            Ok(SFSpeechRecognizerAuthorizationStatus::Denied) => {
                return Err("Speech Recognition access was denied.".to_owned());
            }
            Ok(SFSpeechRecognizerAuthorizationStatus::Restricted) => {
                return Err("Speech Recognition is restricted on this Mac.".to_owned());
            }
            Ok(_) => return Err("Speech Recognition authorization was not granted.".to_owned()),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("Speech Recognition authorization did not complete.".to_owned());
            }
        }
    }
}

fn ensure_app_bundle() -> Result<(), String> {
    let bundle_path = NSBundle::mainBundle().bundlePath().to_string();
    let is_app = Path::new(&bundle_path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("app"));
    if is_app {
        Ok(())
    } else {
        Err(
            "Speech Recognition requires Kuro to run from a macOS app bundle. Quit this build and launch it with cargo xtask run-macos."
                .to_owned(),
        )
    }
}

fn ensure_usage_description() -> Result<(), String> {
    let key = NSString::from_str("NSSpeechRecognitionUsageDescription");
    let Some(value) = NSBundle::mainBundle().objectForInfoDictionaryKey(&key) else {
        return Err(
            "Kuro cannot request Speech Recognition access because its usage description is missing. Rebuild Kuro before transcribing."
                .to_owned(),
        );
    };
    let Ok(description) = value.downcast::<NSString>() else {
        return Err("Kuro's Speech Recognition usage description is invalid.".to_owned());
    };
    if description.is_empty() {
        return Err("Kuro's Speech Recognition usage description is empty.".to_owned());
    }
    Ok(())
}

unsafe fn extract_words(transcription: &objc2_speech::SFTranscription) -> Vec<TranscriptWord> {
    let segments = unsafe { transcription.segments() };
    let mut words = Vec::new();
    for segment in &segments {
        let text = unsafe { segment.substring() }.to_string();
        let parts = text.split_whitespace().collect::<Vec<_>>();
        if parts.is_empty() {
            continue;
        }
        let start = unsafe { segment.timestamp() }.max(0.0);
        let duration = unsafe { segment.duration() }.max(0.05);
        let part_duration = duration / parts.len() as f64;
        for (index, part) in parts.into_iter().enumerate() {
            let word_start = start + part_duration * index as f64;
            words.push(TranscriptWord {
                text: part.to_owned(),
                start_secs: word_start,
                end_secs: word_start + part_duration,
            });
        }
    }
    words
}

fn completed_transcript(
    final_transcript: Transcript,
    best_partial: Option<Transcript>,
) -> Option<Transcript> {
    if final_transcript.words.is_empty() {
        best_partial.filter(|transcript| !transcript.words.is_empty())
    } else {
        Some(final_transcript)
    }
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use objc2::rc::autoreleasepool;

    use crate::project::{Transcript, TranscriptWord};

    fn transcript(word: Option<&str>) -> Transcript {
        Transcript {
            words: word
                .map(|text| TranscriptWord {
                    text: text.to_owned(),
                    start_secs: 0.0,
                    end_secs: 0.5,
                })
                .into_iter()
                .collect(),
            language: Some("en-US".to_owned()),
            generated_unix_ms: 1,
        }
    }

    #[test]
    fn bare_mach_o_exposes_speech_usage_description_to_foundation() {
        autoreleasepool(|_| {
            super::ensure_usage_description()
                .expect("the embedded Info.plist must be visible through NSBundle");
        });
    }

    #[test]
    fn bare_mach_o_is_rejected_before_speech_authorization() {
        autoreleasepool(|_| {
            let error = super::ensure_app_bundle()
                .expect_err("a test executable must not be treated as an app bundle");
            assert!(error.contains("cargo xtask run-macos"));
        });
    }

    #[test]
    fn empty_final_result_keeps_the_last_nonempty_partial() {
        let completed =
            super::completed_transcript(transcript(None), Some(transcript(Some("recognized"))))
                .expect("partial result should be retained");
        assert_eq!(completed.words[0].text, "recognized");
    }

    #[test]
    fn nonempty_final_result_wins_over_partial() {
        let completed = super::completed_transcript(
            transcript(Some("final")),
            Some(transcript(Some("partial"))),
        )
        .expect("final result should be retained");
        assert_eq!(completed.words[0].text, "final");
    }
}
