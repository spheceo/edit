# Scripting run-through, Oct 31 (nightly prep)

Project: "RT Oct 31: Trooper FAKES Testimony — His Own Dashcam BACKFIRES" (Courtroom, one YouTube video OVITtAlFG6M), on the dev server (:7700); the trial server was busy with another session's trial. Paused at the import (script 48f7710a, status "reading").

## Fixed on the way

1. **Map Chromes left running after a dev reload** (where: before New project; every request lagged). Root cause: under `bun --watch` a save reloads the server in the same process, so a map render it cut short keeps that process as its parent, and the startup sweep only stopped orphans. Two had been running for 90 min (about 700 MB) while the 8 GB Mac had 7 GB swapped. Fix: `broll.leftoverMaps` also stops this process's own map Chromes when the server starts. acf1941a. Verified with a unit test and on the dev server, whose log said "stopped 2 map renders an earlier Edit left running".
2. **Script mode was off on the trial server** (where: choosing a server for the run). Root cause: `EDIT_TRIALS=1` skipped all of `writer.start` and the first prompts. Builds then called :7700's tools, Drive had no token, and script↔edit sync didn't run. Fix: on trials, `writer.start` runs everything except Writer-folder adoption, review fixing and archives, and first prompts run too. 99a9e802. Not yet run on the trial server, because restarting it would have cut off another session's trial.
3. **New project refused a single video** (where: New project → Write a script → Footage). Root cause: `checkVideos` parsed the paste with the compilation rule, so one video failed with "A compilation takes at least two cases". Fix: the check parses without the count rule, and compilation imports keep it. 161c9210. Verified with a unit test, and on the dev server the same paste then passed and created the script.

## Still open

- The dev server's event loop is slow: `/api/health` takes 7–15 s while the trial server answers in 2 ms on the same Mac. Convex calls log 5–70 s, `/api/writer/handoff` 8–33 s on each Home refresh, and a video check takes about 2 min. Root cause not found yet. The Mac is also overloaded (load average 400–900, kernel_task at about 155%, swap 4–7 GB).
- The YouTube probe's 90 s limit fails under load. The check then only warns ("couldn't be asked about it"), and the dialog doesn't show that warning.
- Not run yet: the import finishing, Script mode, the build, Doc sync, voiceover, cut-ins, Start the edit, preview, export, share.
