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
- The report's log was drowned by one warning, 1,747× "its footage stays here: That script is missing.", for 141 folders with no script.json. Fixed in plan part 5 (said once a start, and as one line); why those folders are on his Mac is still open.
- One footage file of "Son Spent His Dead Mom's Money On Roblox While Rats Ate Her" couldn't be downloaded; that import waits.
- Retry for a failure that can't change: fixed in plan part 6 (not offered on the build it stopped on). Whether a resume re-runs steps that had finished is still open: his resumes took up to 11 minutes each before the 413.

## Again, Nov 1 afternoon: two imports stopped at Transcribing

Sphe: "imports are stopping again, look" (Home, Importing: three of Mathias's scripts stopped). Read from prod's script index (his report couldn't be pulled: `edit remote` was asking the dev server on :7700, so dev's device list, where his Mac isn't; prod's had it, as found that evening):

- **Predator Cop Realizes His Life Is Over…** (6 h 20 min, 15:31) and **8-Year-Old Points Officers To Dad's Hidden Torture Room** (7 h 43 min, 15:27): stopped at Transcribing, 60%, "could not reach the transcription relay: The socket connection was closed unexpectedly".
- **Mom Secretly Has a Baby With Her Daughter's Boyfriend**: stopped downloading at 13:01, "The import stopped when Edit closed". Builds from nightly-41 carry such an import on 15 s after Edit starts again; it didn't, so his Edit was likely on an older build, or hadn't started again since.

- **Root cause:** for a long recording the pieces (words) and one whole-file hearing (only for who speaks) run together, and any failure ended both. The whole hearing of a 6–7 h file holds one request open through the relay for minutes; when its connection dropped after its two retries, the import stopped, its words already heard. The morning's fix was checked in tests only, never on a real multi-hour hearing.
- **Fix:** a whole hearing that fails for a temporary reason once its retries are spent (a dropped connection, a timeout, the gateway, a busy relay) costs the voices, never the import: its words stand from the pieces, who speaks is left for the watch, as for a file too long to send whole. A refusal or an allowance used up still stops it (the pieces meet it too). `test/transcribe.test.ts`: a whole hearing failing every time keeps the words, no voices, nothing kept for the whole.
- **For Mathias:** update to the next nightly and press Retry on both: the pieces heard are kept, so only what's left is asked.

Open: why the whole hearing's connection drops (the relay waits on Scribe synchronously; a multi-hour file may take Scribe longer than a connection lasts). ElevenLabs' asynchronous mode (a webhook to the relay) would hold no connection open. (His Mac's remote support was fine all along: see docs/remote-support.md on which server `edit remote` asks.)

## Heard by link: the whole hearing as a job (Nov 1, evening)

Sphe: "let's build this, test it … do not ship a nightly yet."

- **What:** a long recording's whole hearing (who speaks) goes as a job. Edit puts the 32 kbps audio in R2 (`edit/transcribe/<id>.ogg`); the relay (`apps/relay/src/transcribe_jobs.ts`) starts Scribe on a presigned link (`cloud_storage_url`, up to 2 GB and 10 h, so no 45 MB cap and no squeezed bitrate) with `webhook=true` and our webhook; Edit asks `GET /v1/transcribe/jobs/<id>` every 15 s (a 4 h deadline) until Scribe has it. Scribe answers 404 until it's done (read as pending), the relay deletes the audio once heard (or when Scribe refuses the start), and ElevenLabs' callback (`POST /v1/transcribe/webhook`, HMAC `t=…,v0=…` checked) keeps a failure for the next look. The job is kept beside the transcript (`transcript.whole.job.json`), so a restart asks for the same job. Edit asks the relay's `/health` (`jobs`) before any upload; a relay without jobs (prod until the next nightly), or one refusing the job, hears it the old way.
- **Set up:** ElevenLabs workspace webhooks "Edit relay (dev|prod): transcription jobs", made through the API once Sphe granted the key `webhooks_write`, subscribed to `speech_to_text` (a webhook alone is refused: "is not configured for speech-to-text"), retries on. Their ids and HMAC secrets are in Infisical (`/edit-relay`, dev and prod: `ELEVENLABS_WEBHOOK_ID`, `ELEVENLABS_WEBHOOK_SECRET`) and pushed to both Workers. The dev relay is deployed; prod's code goes with the next nightly.
- **Tried live on dev:** a 2 min 7 s two-voice recording imported in Script mode. The first try found two things, both fixed: a job Scribe refused stopped the import (now heard the old way), and the audio of a refused start was left in R2 (now deleted). Retried: "heard whole by link for its voices (job Nh7zZCNr0yKc5rMrc4Bo)", one pending look then the transcript, the callback answered 200 (signature good), 387 words, 2 voices, ready in 47 s; nothing left under `edit/transcribe/`.
- **Tests:** `test/transcribe.test.ts` (by link with its voices kept; a restart's job asked for again, never started twice; Scribe failing it costs the voices, never the import; a refused job heard the old way; a relay without jobs uploads nothing), the relay's (`relay.test.ts`: the presigned link and webhook fields, pending then the transcript with the audio deleted, a refused start's audio deleted, only signed callbacks, a reported failure said to the next look).
- **Open:** not yet tried on a real multi-hour recording (Scribe's time on 6–8 h, ~$0.40 an hour heard, twice with the pieces); the first real one will be Mathias's on the next nightly.

## Night of Nov 1: nightly-45 and -46 onto his Mac

Sphe: "when i wake up i want to have EVERYTHING we complained about today resolved ON mathias's machine … dont restart the app while mathias is using it, wait for idle." Then: "if there is some remote functionality you want … build it out before you ship the nightly."

### Fixed on the way

- **Jobs refused in prod** (nightly-44, his Mac: "the relay can't hear it by link (400: Invalid budget reservation)"): the relay's budget held every reservation to one request's 45 MB, so every 5–8 h job was refused and heard the old way (which lost its connection; the fallback kept the words). A job may now reserve up to the 2 GB Scribe fetches; the day's caps hold (6f377df9). The relay's tests had stood the budget in. Tried on dev: a 3 h 20 min two-voice recording heard whole by link in 87 s, 2 voices.
- **Mom Secretly**: the recording is fine (the cloud's copy decodes clean, here, with Edit's exact command); his streamed import reads its sound from its **480p preview**, which held damaged packets at the right length (probe: 6,326 decode errors), so every retry stopped in minutes. Drive's MD5 check couldn't catch it (it's the preview, not the download; and a failed MD5 lookup counts the size as proof). Now footage Edit made or fetched whose sound can't be read is taken away and made again once before the import stops (25797292). On his Mac (nightly-45) the retry re-encoded the preview from the cloud's copy.
- **Remote abilities** (b1428407): `edit remote update-when-idle` (installs once nobody has used the window for 20 min and nothing's running, kept across restarts) and `edit remote probe <id>` (the import's whole error, its files' streams, a decode of their sound, as a report). The probe found Mom Secretly's damaged preview from here.
- **Modal exports from a source-run prod Edit** (b092a690, from the export-routing thread): such an Edit drove Modal with Infisical's dev keys (Kroger 404ed three times, edit-dev holding 22 of its 114 originals); on the team's relay it now always goes through the relay, as installed Edits do. Tried: Kroger exported on prod Modal through the relay in 14 min 35 s.
- **Tests**: the preview-stops import test ran past its time in the full suite (8 min of sound now, d65fdaae).

### On his Mac

- nightly-45 installed remotely while idle (nobody at the window for 2 h 19 min, nothing running); nightly-46 asked for "when idle" (it waits for the Mom Secretly import).
- 8-Year-Old: imported (7 h 43 min, 24 voices), script written. Predator Cop: imported (6 h 20 min, 20 voices), script written. Roblox: imported, editing. Kroger: JJ's 5 notes fixed and shared as v2 by this Mac (the fixing computer), copy checked (1 h 22 min). Every review copy checked: 28 reviews, 0 faulty.
- JJ's "Republican Chairman" compilation imported twice (both of his starts went through once his Edit answered): two scripts, left for him.
