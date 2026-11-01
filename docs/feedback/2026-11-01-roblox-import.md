# Son Spent His Dead Mom's Money On Roblox While Rats Ate Her: an import stuck all day (Nov 1)

Mathias's Mac, project p1793492055193-220550, started ~02:14 SAST. Reported (screenshot) as "stuck since morning", the editor showing "Getting the footage ready · file 1 of 12".

## Fixed on the way

- **What broke, where:** the import (getting the footage ready). 11 of 12 files were ready. File 6, a 911 call (`26-00446_911_Call.wav`, Drive 1a6Tn42BzFjsdQQggWQuqf0eMbztpaFVS, µ-law 8 kHz stereo, 102 s), failed every try at its sound proxy: `aac: Invalid data`. After three tries the import waited for the person ("1 of 12 footage files couldn't be downloaded"). It was already waiting in the 07:25 diagnostics; each Edit start ran it again and it ended waiting again. The screenshot caught one of those runs.
- **Root cause:** `script.excerptExtension` kept the source's extension, but `script.cut` always encodes the sound as AAC (so an excerpt starts on its keyframe's instant). For a sound-only `.wav`, that wrote AAC into a WAV. That reads back as 27.6 s for a 55 s excerpt and can't be decoded, so no proxy could be made. `.m4a` police calls had worked because their container holds AAC.
- **Fix:** 7832f6a1. Sound-only containers that can't hold AAC (WAV, AIFF, FLAC, MP3, Ogg, and others) cut to `.m4a`. The excerpt's cloud record still says it has no proxy, so the next run cuts it again under the new key.
- **Verified:** a unit test (script.test.ts). On the real file, the old excerpt gives Mathias's exact error, and the fixed cut is 55.0 s with its proxy made cleanly.
- **Still to do:** Mathias's Mac is on nightly-43. After the next nightly: `edit remote update fd1604bf-23bc-499a-9ef3-16803137a712`, then `edit remote resume fd1604bf-23bc-499a-9ef3-16803137a712 p1793492055193-220550`.

## Also found (Mathias's diagnostics, not fixed here)

- Script "Mom Secretly Has a Baby With Her Daughter's Boyfriend": NOT IN THE CLOUD ("The summary is too large"), and its import stopped on a corrupt source (`aac channel element duplicate`, `h264 Invalid NAL unit size`).
- Thousands of "its footage stays here: That script is missing" warnings (512× for one script), every few seconds.
