# Cop Father Thinks His Badge Will Save Him After Beating His Daughter: the one-shot subtitle run (Oct 19)

The user's ask: try to one-shot a subtitle video from its Drive folder, time it, and where it goes wrong, improve the system ("so that eventually I don't have to put projects through you"). Footage: one finished 29-minute edit (narration as cards, an intro preview with captions burned in), bodycam at the house, then Perez questioned at and in the back of a cruiser; the folder's Doc holds only a timecode (ignored, as the user confirmed).

## The run

- New project → the folder link → 6 min 15 s (a 3.5 GB download and the proxy; the transcription started behind it).
- "This is a subtitle video. Subtitle it." → one agent turn of 8 min 43 s, 32 model calls: research (NAMES FIRST: 10 names, the footage heard again with them), watch_footage (2 min 13 s: the intro preview captioned, 12 narration stretches, footage), repack_subtitles with neglect, 1,011 lines in eight people's role colours, the 51 starred words listed with times, four doubtful lines named.
- 15.5 minutes from nothing to subtitled.

## What went wrong

### It exported (and would have uploaded to Drive) without being asked
"Do not export it just yet. I'll just take a look and review it" / "Just wait".
- Cause: the subtitle-video skill and the core's skill list said "then export and upload".
- Teach: WAIT FOR REVIEW in the subtitle-video skill; the core's list says ready for review, export only when asked.

### The questioning at the cruiser came out bodycam style
"It's a mixture of interrogation later on and bodycam at the start so we need to build a feature into it" / "I just meant the later segments in the same footage".
- Cause: repack_subtitles had one style for the whole video: overlap and faces (fixed-camera seats, seats.ts) or neither. Repack itself lets the producer mark ranges for faces by hand; the seats need a fixed camera, and these stretches are bodycam.
- Code: moving_seats.ts (faces named in stills by Gemini, followed frame by frame by the face detector) and `repack_subtitles interrogation: [[start, end]…]`, which subtitles the span plain and each stretch again the interrogation way.
- Teach: the subtitle-video skill's BODYCAM FIRST AND QUESTIONING LATER: the stretches from watch_footage's footage segments whose notes say someone is questioned.
- Tests: moving_seats.test.ts. Checked on the footage: Perez and Sergeant Suaste followed through the door and back-seat shots (24 s with the faces cached).

### Small slips it recovered from
add_subtitles inside a batch (refused: it can't run in one), and an edit plan's `select.clip_ids` (the field is `ids`).

## Round 2: it isn't an interrogation (with Terrified Child Secretly Calls 911 On Violent Dad)

"Since this is not an interrogation video we shouldn't have subtitles be in positions under the subjects… we can keep the overlap feature but everything should be bottom middle" / "I forgot that this one is NOT the case with interrogation so both are just normal BWC footage".

- The second video (Terrified Child: 25 minutes, one finished edit) one-shot in 11.5 minutes: a 5 min 17 s import, then a 6 min 08 s turn of 22 model calls (research found no article, so Scribe had no names; the watch 2 min 36 s; repack_subtitles 30 s). The agent judged the doorstep questioning an interrogation by itself and put Rowery under his face, which is what the user didn't want.
- Cause: the skill's BODYCAM FIRST AND QUESTIONING LATER told the agent to find questioning in the segments' notes (a doorstep, a cruiser) and position it, on our reading of Cop Father's first note.
- Teach: BOTTOM MIDDLE UNLESS THE USER SAYS INTERROGATION in the subtitle-video skill: bodycam is overlap with faces: false; faces and the `interrogation` stretches only when the user calls the video, or a stretch of it, an interrogation; never decided by the agent. The tool descriptions of faces, overlap and interrogation say the same.
- Code kept: moving_seats.ts and `interrogation` stay for a real bodycam-to-interrogation video.
- Found on the way: the moving seats' cache held one set of stretches, so a video's second stretch overwrote the first and every re-run paid again (now one file per set); and in both seat finders a failed model call was cached (seats-v2.json even shared to the cloud) as nobody seen (now nothing is kept when a call failed).
- A re-run of repack_subtitles brings back the lines fixed by hand after the last one (Cop Father's agent had deleted 8 background lines and lengthened short holds; the interrogation redo lost them). The redo went through each project's agent, which redid its own fixes. Open: keep hand fixes across a re-run in code (as hand-moved subtitles are kept).
