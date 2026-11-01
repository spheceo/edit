# Son Spent His Dead Mom's Money On Roblox While Rats Ate Her: an import stuck all day (Nov 1)

Mathias's Mac, project p1793492055193-220550, started ~02:14 SAST. Reported (screenshot) as "stuck since morning", the editor showing "Getting the footage ready · file 1 of 12".

## Fixed on the way

- **What broke, where:** the import (getting the footage ready). 11 of 12 files were ready. File 6, a 911 call (`26-00446_911_Call.wav`, Drive 1a6Tn42BzFjsdQQggWQuqf0eMbztpaFVS, µ-law 8 kHz stereo, 102 s), failed every try at its sound proxy: `aac: Invalid data`. After three tries the import waited for the person ("1 of 12 footage files couldn't be downloaded"). It was already waiting in the 07:25 diagnostics; each Edit start ran it again and it ended waiting again. The screenshot caught one of those runs.
- **Root cause:** `script.excerptExtension` kept the source's extension, but `script.cut` always encodes the sound as AAC (so an excerpt starts on its keyframe's instant). For a sound-only `.wav`, that wrote AAC into a WAV. That reads back as 27.6 s for a 55 s excerpt and can't be decoded, so no proxy could be made. `.m4a` police calls had worked because their container holds AAC.
- **Fix:** 7832f6a1. Sound-only containers that can't hold AAC (WAV, AIFF, FLAC, MP3, Ogg, and others) cut to `.m4a`. The excerpt's cloud record still says it has no proxy, so the next run cuts it again under the new key.
- **Verified:** a unit test (script.test.ts). On the real file, the old excerpt gives Mathias's exact error, and the fixed cut is 55.0 s with its proxy made cleanly.
- **Still to do:** Mathias's Mac is on nightly-43. After the next nightly: `edit remote update fd1604bf-23bc-499a-9ef3-16803137a712`, then `edit remote resume fd1604bf-23bc-499a-9ef3-16803137a712 p1793492055193-220550`.

## Also fixed, from the same diagnostics

- **"Mom Secretly Has a Baby With Her Daughter's Boyfriend": NOT IN THE CLOUD ("The summary is too large").** Root cause: its import's "could not extract audio" kept all 545 KB of FFmpeg's stderr as the script's error. The summary carries the error, and mamagi refuses a summary over 64 KB, so every sync failed. Fix f71fa1d8: `diag.gist` keeps each message once, ≤ 600 characters; transcribe's encode uses it, and `store.summary` caps any error at its gist. Verified with tests on a 20,000-line flood (the summary stays under 4 KB).
- **The same script's half-encoded preview piece (498 MB) was synced to the cloud.** The sync skipped only names ending `.partial`, and preview pieces encode as `<name>.partial.mp4`. The same test chose which local footage could be deleted once the cloud had it. Fix 7650bf1e: one rule, `store.inTheMaking`, for both; the sync skips `pieces/`. Tested.
- **The flood of "its footage stays here: That script is missing" warnings** was already fixed in 175fd794 (nightly-42). None since his Mac restarted on nightly-43; the report's two-day tally still counts the old ones.

## Still open

- **Why that script's sound couldn't be extracted.** Not the recording: the cloud original (Drive 1jKGSJSlkSEnHaQYmxUMW7vVvbJ1PjLif, 5.3 GB, 83 min) extracts whole with no errors (4,978 s of sound in 4.4 min). So the import read a damaged copy on Mathias's Mac, most likely its local download of the Drive file. After the nightly, retry the import (`edit remote resume` with the script's id) and pull diagnostics. If it fails the same way, that local copy is still being read: delete it so the cloud copy is used, and look at how Drive downloads resume (a resumed download with bytes in the wrong place gives exactly these "Invalid NAL unit size" errors).

## Changed so these don't come back (Sphe: "fundamentally change how things work")

- Every excerpt is checked as it's cut (1f307309): one that doesn't read back as long as was cut is refused with its reason, whatever the container.
- Every Script-mode Drive download is proven to be Drive's file (9d02f83c): it appends only where Drive's Content-Range says, checks the MD5 (asking Drive when an old manifest lacks it) and fetches again from scratch once. A copy of the right size is no longer trusted at every retry. Edit mode's copies through the relay already ask exact ranges of exact lengths.
- One list of what a restart would cut off (d3ac3ff5), for an update and a remote restart alike.
- Diagnostics say when the window was last used, and how many of each problem came since Edit started (9273ccfc).
- The rule is written in app/AGENTS.md ("Checked before it's used").
- Not mine to change: Off-Duty Officer's export running 29 min past its edit (the review-repair session found it).
