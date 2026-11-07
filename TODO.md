# To do

Ideas and next steps that aren't started yet. Newest at the top.

## Speaking to the agents: local speech-to-text (future)

Talk to the in-app agents instead of typing a prompt: a mic button in the chat composers (the edit agent, Writer, Ideas, Thumbnails), the words transcribed on the machine itself, so nothing is uploaded, nothing is paid per minute, and the text lands in the box to send or fix first. Not footage: footage and subtitles stay on ElevenLabs Scribe (`transcribe.ts`). What it needs: text back within a moment of stopping (words as you speak, ideally), on every machine the team uses (Apple Silicon Macs first, Linux with or without an NVIDIA card), and the case's names spelled right where it can (the project's cast, `people.ts`). Researched Nov 7, 2026:

- **NVIDIA Parakeet TDT 0.6B v3** (Apache 2.0) is the accurate one: on a Mac through FluidAudio (Core ML on the Neural Engine; a short phrase back in ~0.2 s on an M4) or parakeet-mlx (~0.5 s), on Linux through ONNX on the NVIDIA card. About 1.2 GB, so downloaded the first time someone dictates. Its 120M streaming sibling, Parakeet EOU, gives words as you speak and knows when you've stopped.
- **Moonshine** (MIT for English, small) was built for streaming: words appear as you talk and are seldom revised. Small enough to run on any CPU, so the one model that could serve every machine the same way (through tract, as faces and on-screen text do on Linux).
- **Whisper large-v3-turbo** (MIT, through whisper.cpp or WhisperKit) only if the team dictates in languages Parakeet lacks; it's slower for the same English.
- **Names:** every engine stumbles on names and jargon (bodycam terms, the cast). NeMo's phrase boosting does it for Parakeet on NVIDIA; elsewhere, the agent can be told the cast and fix a misheard name, as it would a typo.
- **Try first:** Moonshine everywhere for its simplicity, against Parakeet on a Mac, with the team's own dictated prompts; keep whichever gets names and speed right.

Sources: [local STT models compared](https://www.onresonant.com/resources/local-stt-models-2026), [Mac engines on 13,000 recordings](https://dicta.to/blog/speech-to-text-engine-comparison-mac-2026/), [Parakeet on the Neural Engine](https://macparakeet-website.pages.dev/blog/whisper-to-parakeet-neural-engine), [speech-swift (Parakeet EOU streaming)](https://github.com/soniqo/speech-swift), [Whisper large-v3 vs turbo](https://vexascribe.com/whisper-large-v3-vs-turbo), [NeMo word boosting](https://docs.nvidia.com/nemo/speech/nightly/asr/asr_customization/word_boosting.html).

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
