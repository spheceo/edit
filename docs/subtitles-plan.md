# One subtitles system for edits and subtitle videos

Status: proposed (Oct 17). Lands after the TS rewrite, in `apps/server` (with the model change in `edit-core`).

## What must never happen

1. **One person in several colours** (their subtitles, label, intro caption or quote).
2. **Several people in one colour**, or in colours close enough to read as one.
3. **Words given to the wrong person.**
4. **Subtitles off the speech**: early, late, or flashing too briefly to read.

Today each of these is avoided by heuristics in two separate systems, not ruled out by construction.

## How it works today, and why it can go wrong

| | Subtitle videos (`repack_subtitles`, `crates/edit/src/subtitles.rs`) | Edits (`add_subtitles`, `crates/edit/src/captions.rs`) |
|---|---|---|
| Who a person is | A transcript voice key (`<media>/speaker_N`), merged by comparing name strings (`same_person`) | A subtitle label's text and the clip name "Subtitle · <name>" (`people.rs`) |
| Colours | `speakers::distinct`, ΔE 20 apart | `people::one_colour_per_person`, palette of 20, ΔE 28 apart |
| Where the colour lives | On every clip | On every clip |

What follows from that:

- **No stable person ID.** Identity is worked out from display strings, so a relabel, a typo or a generic label ("Deputy", "Deputy 2") can split one person or merge two.
- **Colour is stored per clip**, so nothing stops two clips of one person from differing. A cached transcript today holds three different people (Deputy 3, Cale (Officer) and one more) all in `#00e5c7`.
- **Two thresholds.** Subtitle videos accept colours 20 apart, which `people.rs` itself says "still read as one person".
- **When the palette runs out, it fails silently**: `distinct` picks the least-bad colour without reporting it.
- **Identity across watch windows rests on diarisation.** Each ~4-minute window names people A, B, C on its own (`watch.rs`); the letters are tied together only through ElevenLabs' `speaker_N` labels (`voices_for`). When diarisation splits a person, or gives two people one label, nothing else catches it.
- **The two systems disagree on the same footage.** A subtitle video and the edit made from it can show the same person under different colours and names.

## Evidence (Oct 17)

**Young Actress Thinks She Can Get Away With Murder** (29 min interrogation, run on the current code):

- The bald agent in the orange polo was three diarisation voices (`speaker_7`, `speaker_4`, `speaker_5`) across the watch windows, named "Travis Lawson (Officer)", "Agent" and "Agent 2". He came out in **three colours**.
- The green-shirt agent (`speaker_0`) was named "Travis Lawson (Agent)" by the voice namer while the watcher called him "Jeremy": **310 of his lines were labelled as the other agent**. The roles differed (Agent vs Officer), so the name matcher kept the two "Travis Lawson"s apart as well.
- Lauren's two voices were merged correctly (same name and role).
- Fixed by naming the voices by appearance (the watcher's descriptions are consistent across windows even when its names aren't) and running again: five people, five colours.
- **Timing**: 129 of 926 lines (14%) start late, median 343 ms, 32 over half a second, at most ~1 s. Cause: in overlap mode a speaker's next line waits until their previous line has had its 400 ms (`shown`, `subtitles.rs:617`), and in quick speech the waits chain. Fix: join a too-short line with the speaker's next line instead of delaying the next.
- **A one-frame line**: a narrator line starting in the last frame of a footage stretch became an "Other" subtitle in white for 0.03 s.

**The six subtitle videos delivered before** (`/tmp/subsrun/check.py`):

| Video | People | Too close (ΔE < 28) | In white | Late lines | Under 400 ms |
|---|---|---|---|---|---|
| Traffic Stop | 9 | Heather / Mills 23.9 | Heather | 0 | 0 |
| INTERRO Comp (13-year-old) | 7 | 2 pairs (23.8, 27.3) | | 140 | 1 |
| Trench Coat Teen | 2 | | | 63 | 1 |
| Neglected 8-Year-Old | 13 | 10 pairs (down to 14.4) | Cynthia | 111 | 93 |
| 12-Year-Old Killer | 3 | | | 81 | 54 |
| Teen Scammer | 4 | | | 51 | 70 |

No line in any of them mixes two voices' words. The flashes under 400 ms are probably from before `MIN_SHOWN_MS` was added; the late lines are probably the chaining above (not yet confirmed for each video). Colour violations need eyes, not just ΔE: Traffic Stop's Heather in white next to a pale cyan reads as one person.

## The design

### A cast, one per footage source, shared

`people-v1.json` beside each source's analysis (shared through the cloud like `transcript.json`, `watch/`, `seats-v2.json`):

```
people: [{ id, name, label, role, colour, look, voices: [speaker_N…] }]
lines:  [{ words: [from, to), person, sure, why }]   // attribution, word ranges of the transcript
```

- **The watcher, seats, the agent and the user all write here**, never into clip text. A correction made in a subtitle video is there for the edit too, and the other way round.
- **A project's cast** is its sources' casts joined. The same person in two files is one person when the agent or user says so (`same_as`), never inferred from a name string.

### Subtitles reference people; colour is never stored per clip

- A subtitle, label, intro caption or quote clip carries `person: id` (an edit-core model change).
- Its colour and label text are drawn from the person at render time. Recolouring someone is one write, and two clips of one person can't differ.
- One colour assigner for everything, one threshold (ΔE 28). When it can't keep everyone 28 apart, it says so (by name), and the audit lists it.

### `Project::validate` enforces it

The contract every writer (UI, MCP) must satisfy gains:

- every person-referencing clip names a person in the cast;
- every person's colour is ≥ ΔE 28 from every other person on screen in the same video (or the project records an accepted exception);
- white and near-white are never a person's colour.

A plan or tool that would break these saves nothing, as an invalid plan does today.

### Attribution: agreement, not one guess

A line's person comes from the evidence agreeing:

1. **Diarisation** (ElevenLabs' `speaker_N`).
2. **The watcher** (Gemini, with sound and picture: whose mouth moves).
3. **Seats and faces** for interrogations (which face the line sits under).

When they agree, the line is certain. When they disagree, it's on the doubtful list, and the agent looks at just those moments in one call, as now.

**New: a cast reconciliation step after the windows.** One cheap call is given every window's people (letter, look, place, name, role) and a still of each. It returns the global cast, so the same person is one ID in every window even when diarisation flipped. Apple Vision face feature prints (`VNGenerateImageFeaturePrintRequest` on face crops) confirm or question "same person" across windows locally, for free.

### Naming people by how they look, not by names alone

The watcher's descriptions ("bald, orange polo, right chair") stayed consistent across all seven windows while its names and the diarisation voices didn't. The reconciliation step groups voices by appearance and place first, then takes a name only where the footage says it ("I'm Travis Lawson") and the evidence agrees on who said it. A name it can't pin down stays a role ("Agent"), never a guess: in subtitle videos only the colour shows, so a wrong name costs nothing on screen but a wrong grouping does.

### Timing

- In overlap mode, a line too short to read is joined with the same speaker's next line, rather than delaying that line (today's cause of 14% late lines).
- A line from a hidden voice (narrator) that only overlaps a footage stretch by a frame or two is dropped, never shown as "Other".
- Lines are cut from word times as today (Repack's rules: speaker change, 750 ms pause, 3.5 s, 52 characters, sentence end), then **checked against the sound**. The loudness analysis already has 10 ms energy blocks; a word timed into silence, or speech with no word on it, is flagged.
- **Frames are the footage's own.** A subtitle video's project takes the footage's frame rate (this one is 23.976). Today projects are always 30 fps, which repeats every fourth frame in the export (judder) and puts subtitle edges on frames that don't exist in the source.
- Start on the first word's frame (rounded down), end at least on the last word's (rounded up), at least 400 ms on screen, never overlapping the next line except in overlap mode.

### Tests that keep it true

- **Fixtures from real projects**: the subtitle videos already delivered (Teen Scammer, 12-Year-Old, Trench Coat, Traffic Stop, Neglected 8-Year-Old, Young Actress), with their hand-checked speakers frozen as expected results. Every change to the watcher, the cast or the colours runs against them and reports attribution accuracy, colour violations and timing errors.
- **Property tests** on the colour assigner: any cast, any order, the invariants hold or a named exception is reported.

## Order

1. The cast file and `person` on clips (edit-core), with migration: existing projects' labels and transcript names become cast entries.
2. One colour assigner (ΔE 28) and the validation rules.
3. Both subtitlers read and write the cast; corrections move there.
4. Cast reconciliation after the watch windows; face feature prints.
5. Timing checks against the sound; footage frame rate for subtitle videos.
6. Fixtures and the accuracy report.
