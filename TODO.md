# To do

Ideas and next steps that aren't started yet. Newest at the top.

## Local transcription (future)

Transcribe on the machine's own GPU instead of ElevenLabs Scribe through the relay (`apps/server/src/transcribe.ts`): no per-minute cost, no upload, works offline. What it has to match before it can replace Scribe: word timings (subtitles, cuts), who's speaking (subtitle colours, `people.ts`), and the case's names spelled right (`names.ts` sends them as keyterms). Researched Nov 7, 2026:

- **Words and timings:** NVIDIA Parakeet TDT 0.6B v3 is the fast pick: word-level timestamps built in, 25 European languages, thousands of times real time on a GPU. For top English accuracy, Canary-Qwen-2.5B, IBM Granite Speech 4.1 or Cohere Transcribe (Apache 2.0) led the Hugging Face Open ASR Leaderboard during 2026; check the leaderboard again before choosing. Whisper large-v3 only for languages the others lack (it needs a separate alignment step for word timings).
- **Names:** NeMo's GPU phrase boosting (GPU-PB / TurboBias) takes a per-request list of phrases for Parakeet and Canary, the local equivalent of Scribe's keyterms. Names must be passed capitalised as they should appear.
- **Speakers:** pyannote's Community-1 (MIT code, CC-BY-4.0 weights, needs a Hugging Face token to download) has no speaker limit; NVIDIA's Sortformer is end-to-end but best at four speakers or fewer, which bodycam and interrogations often exceed.
- **Before switching:** run both on the team's real footage (bodycam wind and sirens, overlapping interrogations) and compare names, speakers and timing against Scribe; keep Scribe as the fallback for a machine without an NVIDIA card (every Mac).

Sources: [Open ASR models compared](https://www.marktechpost.com/2026/07/23/best-open-speech-recognition-asr-models-in-2026-wer-languages-latency-and-license-compared/), [Gladia's 2026 list](https://www.gladia.io/blog/best-open-source-speech-to-text-models), [NeMo word boosting](https://docs.nvidia.com/nemo/speech/nightly/asr/asr_customization/word_boosting.html), [pyannote](https://github.com/pyannote/pyannote-audio), [diarization in 2026](https://www.pyannote.ai/blog/top-7-speaker-diarization-apis-and-models-in-2026).

## Linux: the thumbnail subject cut-out

On a Mac the thumbnail maker lifts a subject out with Vision's "Copy Subject" (`subject_cutout`, `crates/edit-native/src/media.rs`); on Linux it says "Lifting a subject out needs a Mac." The stand-in: BiRefNet (MIT, the best open background-removal model; ~200 MB, so downloaded the first time someone uses it rather than shipped in the binary), run on the NVIDIA card. Faces (YuNet) and on-screen text already run on Linux the same way, through tract.

## Ideas and thumbnails: a feedback link (future)

A way to send an idea or a thumbnail off to a feedback link — share it outside Edit for review, the way an edit goes to its review link, and have what comes back land where the work is. Not built yet; wanted so ideas and thumbnails can be sent for feedback without a screenshot and a message.

## Thumbnails: what's not built yet (get back to this)

Thumbnails is a working draft (Nov 2; `docs/thumbnails.md`; commits 39a833aa, 44f9aedd, b7e7952d). Paused there ("we'll get back to this later"). Not built yet:

1. **Caption styles per channel or niche**: which text style (black box, white and red, none) each channel and niche takes. Sphe: "the text stuff depends on the niche/channel whatever but we'll get to that later". Goes in `agent/thumbnails/guide.md`, with the channel or niche set on the thumbnail.
2. **Frames from YouTube**: give Claude Ideas' `scan_video` and `grab_frames` (`app/apps/server/src/ideas/frames.ts`, through the YouTube proxy) on a thumbnail, so it can pick a base and its subjects from the case's video itself.
3. **A thumbnail from an idea's guide**: start one from the idea page with its thumbnail guide, frames and base already in the thumbnail, and link the two.

Shipped to prod with nightly-48: one OpenArt sign-in, held by the live relay (dev asks it).
