# Bodycam HQ, end to end: "Cops Found 3 Bodies In A House Linked To Same Killer" (Nov 12)

Sphe's test: a high-quality bodycam edit through Edit V2 from start to finish, on dev (the V2 server, `~/.edit-v2`, :7740, dev relay), the HQ chat on Opus 5.5 at high writing the graphics itself (no Fable). Project `p1794436996566-38`.

## The input

The script Doc links its footage on Dropbox; the same files are in a Drive folder (114 videos, 93 GB). An exception, not a change to the import (Sphe): the Doc was taken as Markdown (Docs' own export), each Dropbox link swapped for the Drive file of the same name (all 16 found), and pasted into New project → Bodycam HQ. Edit's parser read the paste as it reads the Doc: 59 ranges from 16 files, 1,404 s of footage, the same 2,182 words of narration.

## Timings

| Stage | Took |
| --- | --- |
| Download and cut 16 files (10.4 GB) | 9 min |
| Voice-over and research | 9 min |
| Agent's build turn (one turn, 342 entries) | 71 min |
| Coded graphics rendered (5, about 17,800 frames, in the background during the turn) | 23 min of render time |
| Export, 34:28 (62,039 frames) | 8 min 04 s |
| Start to finished edit | 89 min |

## Fixed

- **A pasted Markdown script voiced its chapter titles.** Docs' Markdown escapes `\[`/`\!` and marks headings `**ACT 1**`; the paste route kept both as text, so "ACT 1" landed in the narration. Now a whole-bold line stays bold (a chapter title, shown not voiced) and the escapes go. Commit 1bfe2287, test in `pasted_script.test.ts`.
- **An export failed on a 911 call's sound.** The Dec 14 call is a GSM 6.10 WAV; its sound copy (`copySound`, `-c:a copy` into MOV) was a file nothing could decode, so every export and the export-ahead failed on it. Now a sound MOV can't carry as it is is made PCM, and a broken copy kept or shared before is made again. Commit 68f76b83, test in `cloud_media.test.ts`. The export afterwards: 8 min, sound mixed.

## Open

- **This script's quote lines, DISPLAY lines and editor note were voiced.** The import reads the line under each range (the transcript snippet), `[DISPLAY: …]` and `[To Editor: …]` as narration, in the Doc route as well as the paste. The agent spent about 7 minutes cutting them out of the voice-over, and five places still sound cut off (it says to listen at 0:17 and 4:25). Left as is: Sphe called this script's format an exception.
- **The narration says "Hakeem"** where the name is Haikiem (the voice reads the spelling as written).
## The player (MacBook Air M1 8 GB, Chrome, the page over Tailscale from mandalorian; three runs, the Mac busy with other agents)

| | cold | warm |
| --- | --- | --- |
| Page to player | 1.1 s | 0.6–0.8 s |
| First picture | 2.9 s | 2.4–2.8 s |
| A jump, median | 590 ms | 250–355 ms |
| A jump, worst of 12 | 7.2 s | 3.7–10 s (far jumps into footage not yet read) |
| A 4 s drag | 174 pictures, 4 frames behind | 212 / 99 pictures, 4 / 176 frames behind |
| 10 s playing | 255 of 300 frames | 297–298 of 300 |

No errors, no audio underruns. Smooth playback's render isn't made for an edit this long until it's watched.

- **WebGPU on this Linux machine.** Edit's page draws only through WebGPU. Headless Chrome 157 here gets SwiftShader (the CPU), and a Chrome window on the Wayland session refuses Vulkan, so the player couldn't be measured on the 4060. Measured on the MacBook Air instead (below). Not checked: whether Edit's own Linux window gets the GPU.
