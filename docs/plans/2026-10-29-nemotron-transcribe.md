# NVIDIA Nemotron 3.5 Transcribe: worth a bench, parked

Researched Oct 29, the day after its release (Oct 28). Not benched yet; this is where to pick it up.

## Where we are

Transcription is settled (Oct 20 bake-off, `app/apps/server/src/transcribe.ts`): Scribe v2 on 40-second pieces for the words and times, Scribe on the whole file for who speaks, `cameras.ts` splitting a voice heard on two bodycams, then Sonnet 5.5 naming the voices (`speakers.ts`) and `watch_footage` fixing who says what. The labelling stays whatever we transcribe with. The question is only whether Nemotron gives clearly better speakers on hour-long videos with bad audio.

## What it is

- Open weights (OpenMDW-1.1, commercial use fine), 34B total / ~4.3B active, a mixture of experts with a ~99M speaker encoder beside the audio encoder.
- Recorded files only (no streaming), **up to 1 hour**, up to 8 speakers (speaker tags in 13 languages, transcription in 40).
- One pass gives words, word timestamps (a CTC head aligns them after decoding) and speaker tags, steered by a plain-language prompt. Context terms go in the prompt (like our Scribe keyterms): NVIDIA reports named-entity errors cut about six-fold with a list of expected names.

## Price

- Scribe v2: ~$0.22 per hour of audio (list price).
- Nemotron: no hosted API for this model yet (OpenRouter only has the small 0.6B streaming ASR, a different model). We'd run it on Modal: the FP8 version on an L40S (our export GPUs), or BF16 on one H100.
- Rough Modal cost: ~$0.05–0.10 per hour of audio once loaded; loading the weights takes minutes and dominates unless we batch whole videos. Price is a wash: this is about accuracy only.

## Accuracy (NVIDIA's numbers, nobody has checked them independently yet)

| Test | Error |
|---|---|
| English Open ASR leaderboard, mean of 9 sets | 4.71% WER (best open model) |
| AMI, one distant mic (SDM) | 17.34% cpWER (counts the speaker as well as the word) |
| NOTSOFAR-1, one distant mic | 25.91% cpWER |
| CALLHOME | 11.50% cpWER |
| URGENT24 (degraded audio) | 11.00% WER |
| Long-form Open ASR mean | 10.98% WER |

- No comparison with Scribe, Deepgram, AssemblyAI, Gemini or GPT.
- No DER (how often the speaker alone is wrong).
- The one-distant-mic meeting results (17–26%) are the closest thing to our worst audio, and they're its weakest numbers. Vendor charts didn't match bodycam last time either (Oct 20).

## What worries me for us

1. **The 1-hour limit.** Longer videos must be split, and speaker numbers don't carry across a split: holding them from start to end is exactly why we hear the whole file with Scribe.
2. **Our biggest speaker win wasn't the audio.** It was the bodycam split (two partners Scribe hears as one voice). Nemotron doesn't change that; `cameras.ts` stays.
3. **Day-one tooling:** vLLM 0.32.0 plus NeMo Speech from its main branch, the `nemo_speechlm` plugin, `VLLM_USE_V2_MODEL_RUNNER=0` and the timestamp middleware for word times. The card warns of rare generation loops (it ships a clean-up function), a slow first request, and up to ~20k output tokens on dense hour-long audio.
4. **Sonnet stays either way** for naming voices and fixing lines; at best it has fewer mistakes to fix.

## How to bench it (about half a day)

1. **Modal script** (next to `app/scripts/benchmark-modal*.py`): serve the FP8 checkpoint on an L40S (or BF16 on an H100) with vLLM as the model card says, send each whole file with the case's names as context terms, save words, times and speaker tags.
2. **Scoring script:** take finished projects whose speakers `watch_footage` already fixed. Map Nemotron's speaker tags to our people by overlap, then score:
   - word-level speaker accuracy (the Oct 20 measure: Scribe ~93%, pyannote ~75%)
   - words dropped or added vs our transcript
   - timing drift vs Scribe's 40-second pieces
3. **Videos:** Terrified Child Secretly Calls 911 (comparable with Oct 20) and one or two hour-long videos with bad audio.
4. **Bias:** our finished transcripts started from Scribe, so they lean towards Scribe. Hand-check a few minutes of the hardest stretches (overlap, distance, wind) for a fair score.
5. **Bar to switch:** clearly above ~93% on speakers on the hard videos, no dropped words, times as good as the pieces. Otherwise Scribe stays.

## Sources

- [Model card](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B)
- [NVIDIA research page](https://research.nvidia.com/labs/nemotron/NVIDIA-Nemotron-3.5-Transcribe/)
- [Hugging Face blog](https://huggingface.co/blog/nvidia/nemotron-transcribe-granary)
- [The Decoder](https://the-decoder.com/nvidias-open-nemotron-3-5-transcribe-combines-transcription-translation-and-speaker-recognition/)
- [DEV Community critique](https://dev.to/paullovelace/nvidias-nemotron-35-transcribe-one-open-model-for-40-languages-but-only-if-your-audio-is-3l1e)
- [Daily on self-hosting cost](https://www.daily.co/blog/open-source-multilingual-transcription-from-nvidia-nemotron-3-5-asr/)
- [OpenRouter: Scribe v2](https://openrouter.ai/elevenlabs/scribe-v2)
