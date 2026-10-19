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
