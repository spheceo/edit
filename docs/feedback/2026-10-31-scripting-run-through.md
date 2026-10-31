# Scripting run-through, Oct 31 (nightly prep)

Project: "RT Oct 31: Trooper FAKES Testimony — His Own Dashcam BACKFIRES" (Courtroom, one YouTube video OVITtAlFG6M), on the dev server (:7700); the trial server was busy with another session's trial. Paused at the import (script 48f7710a, status "reading").

## Fixed on the way

1. **Map Chromes left running after a dev reload** (where: before New project; every request lagged). Root cause: under `bun --watch` a save reloads the server in the same process, so a map render it cut short keeps that process as its parent, and the startup sweep only stopped orphans. Two had been running for 90 min (about 700 MB) while the 8 GB Mac had 7 GB swapped. Fix: `broll.leftoverMaps` also stops this process's own map Chromes when the server starts. acf1941a. Verified with a unit test and on the dev server, whose log said "stopped 2 map renders an earlier Edit left running".
2. **Script mode was off on the trial server** (where: choosing a server for the run). Root cause: `EDIT_TRIALS=1` skipped all of `writer.start` and the first prompts. Builds then called :7700's tools, Drive had no token, and script↔edit sync didn't run. Fix: on trials, `writer.start` runs everything except Writer-folder adoption, review fixing and archives, and first prompts run too. 99a9e802. Not yet run on the trial server, because restarting it would have cut off another session's trial.
3. **New project refused a single video** (where: New project → Write a script → Footage). Root cause: `checkVideos` parsed the paste with the compilation rule, so one video failed with "A compilation takes at least two cases". Fix: the check parses without the count rule, and compilation imports keep it. 161c9210. Verified with a unit test, and on the dev server the same paste then passed and created the script.

4. **Any file can be dropped in** (Sphe's ask). Before, uploads took only video and audio. Now:
   - Pictures, video and sound Edit reads go in as they are.
   - Other pictures (HEIC, AVIF, PSD, RAW) become PNGs, and other video and sound (WMV, FLV, MPG, WMA, an animated GIF) become MP4 or M4A.
   - Anything else (PDF, Doc, notes) is kept as a project file under Files in the media panel.
   - The agent's context lists what the user uploaded and whether each item is on the timeline yet, and `read_upload` reads a file's text.

   Commit ae1660fd. Verified with tests, and on the dev server: a JPG, a HEIC, a PDF and a brief were dropped in the editor, then "add the new images I've uploaded to the start, in the order my brief says" placed both images in that order (31 s).
5. **Exports with chapters went to the Mac** ("chapters are added here"), and that included every share with chapters. The Modal worker now adds the chapters when it joins the file, outside the cache keys. Commit 68458d2b. Five exports at once on Modal is tested; the deployed pool takes six at once.
6. **Chapters had no names.** `-map_metadata -1` dropped the titles, both in the Mac's export (render.rs) and in the worker. Commit 8c9fd63f. Checked with FFmpeg 8.1 and Debian's 5.1.
7. **Picture-only edits fell back to the Mac** ("there's no sound to export in that span"). They now get a silent soundtrack on Modal. Commit 6e8ce417. Verified: two dropped photos with two chapters were rendered on Modal, kept in the cloud, and came back with video, sound and both chapters named.

## Still open

- The dev server's event loop is slow: `/api/health` takes 7–15 s while the trial server answers in 2 ms on the same Mac. Convex calls log 5–70 s, `/api/writer/handoff` 8–33 s on each Home refresh, and a video check takes about 2 min. Root cause not found yet. The Mac is also overloaded (load average 400–900, kernel_task at about 155%, swap 4–7 GB).
- The YouTube probe's 90 s limit fails under load. The check then only warns ("couldn't be asked about it"), and the dialog doesn't show that warning.
- Not run yet: the import finishing, Script mode, the build, Doc sync, voiceover, cut-ins, Start the edit, preview, export, share.
