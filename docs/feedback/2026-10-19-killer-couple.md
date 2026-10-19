# Feedback: Killer Couple Takes Down "Perfect Dad" (subtitles), Oct 19, the user in chat

Project `p1792351482180-138` (cloud), 52-minute interrogation subtitle video, `repack_subtitles` with overlap and faces.

## "the exact same person speaking, is picked up as different colors, and they're placed in different positions on screen"

At 11:22 the bald detective on the left (Mike) was "Mike (Sergeant)" in light blue, bottom middle; at 13:28 he was "Sergeant" in blue, under his face.

| | |
|---|---|
| Cause | Diarisation split him into four voices (speaker_7, _8, _11, _15, and speaker_0 in some windows). Each four-minute watch window names its people on its own; `cast.ts` is what joins them across windows by how they look, and its answer was refused whole (`checked`: "two items of one window are never one person"). But one window had given him two letters, one per voice ("bald detective, left of the table" and "Mike, bald, tattoos, left side"), and the model rightly joined them. With no cast, each voice kept its own name. The seats (faces per name) gave the bald man's face to "Sergeant", so "Mike (Sergeant)" had none and sat bottom middle. |
| Also | The cast's prompt never said what each role means, so both detectives came out "officer" (teal) and the victim's father "bystander" (white). |
| Teach | subtitle-video: a speaker with `not_under_face` is one person under two names or someone off camera; look, say so, give the lines the right person. |
| Code | `cast.checked` holds an answer together rather than refusing it: one person may have two letters of one window, an item given twice stays with its first person, and one left out is a person of its own. The cast prompt says what each role means (it decides the colour). |
| Tool | `repack_subtitles` returns `not_under_face` per speaker: lines that sat bottom middle while the others sat under their faces. |

## Not fixed in code: one window's watcher gave Mike's speech to the other detective

In 10:27–14:31 the watcher gave voice 0's long speech (13:24–14:30, "so basically, I just want you to know what we're investigating") to the detective in the foreground (back to the camera). It did the same at low and at medium thinking. The next window, which starts mid-speech, gives voice 0 to Mike; the seats place voice 0 under Mike; he gestures through it; and the user hears one man. Corrected by hand in the transcript (voice 0 in that window → Mike's voice). The way to catch it in code: when two windows disagree about a voice that talks across the edge between them, watch a window across that edge to decide.
