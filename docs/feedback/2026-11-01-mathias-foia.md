# Mathias's FOIA scripts, Nov 1: transcription refused every time (413)

Sphe: "investigate why it took over 20 minutes for a script that my mathias was working on". Read from his Mac with `edit remote diagnostics` (mathiass-macbook-pro, nightly-39, signed in as Jones JJ; `~/.edit/reports-inbox/2026-11-01_mathiass-macbook-pro-1793515530311.txt`).

## What happened

- "Predator Cop Realizes His Life Is Over After Colleagues Find Secret Telegram Account" (9a9a4282, a Drive folder of 9 recordings, 6 h 20 min, one of them a 4 h 39 min interview) and "8-Year-Old Points Officers To Dad's Hidden Torture Room" (5f9276ca, 5 recordings, 7 h 43 min, one of 5 h 1 min), both started ~22:00 SAST on Oct 31.
- Each import's request ran ~41 minutes (`POST /api/writer/scripts/drive`, 2,445,945 ms), downloading and preparing the footage, then stopped: "transcription failed (413): That recording is too long for one request."
- He resumed them 13 times (`POST …/resume`, up to 11 minutes each, ~58 minutes in all). Each stopped at the same step.

## Fixed on the way

- **What broke, where:** transcription, the whole-file hearing of a long recording (for who speaks).
- **Root cause:** the whole file is sent as one request at 32 kbps; the relay takes at most 45 MB a request (`MAX_UPLOAD_BYTES`), ~3 h 7 min of it. Nothing on the Mac knew the limit, and a 413 was asked about again on every Retry as if it could change.
- **Fix:** part 1 of `docs/plans/2026-11-01-effect.md`: transcription rewritten in Effect. The whole hearing is encoded at the rate that fits one request (16 kbps for 4 h 39 min and 5 h 1 min; 8 kbps covers ~10 h 38 min), made smaller again if Opus runs over; a file too long even for that keeps its words from the pieces without voices instead of stopping the import. Failures are typed (`retryable`: only a busy relay, the gateway and a dropped connection), and the pieces and the whole hearing interrupt each other on failure. A test reads `MAX_UPLOAD_BYTES` from `wrangler.toml`, so the two can't drift again.
- **Verified:** `test/transcribe.test.ts` (17 tests, among them a 100 s file with the limit made smaller, so it takes the long file's road: every request under the limit, its voices kept; and one where the relay refuses the whole: words kept, no voices, no failure), the 160 tests that hear footage (media, import, names, voice, script tools, writer), the server's typecheck and lint, and a bundled build starting.

## Still open

- Mathias's Mac needs a nightly with this fix (`just nightly`, then `edit remote update fd1604bf-23bc-499a-9ef3-16803137a712`), then `edit remote resume` for 9a9a4282 and 5f9276ca. Not done: a nightly is a push.
- The report's log was drowned by one warning, 1,747× "its footage stays here: That script is missing." (plan part 5).
- One footage file of "Son Spent His Dead Mom's Money On Roblox While Rats Ate Her" couldn't be downloaded; that import waits.
- Retry is still offered for a failure that can't change (plan part 6).
