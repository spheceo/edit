# One subtitles system for edits and subtitle videos

Status: steps 1–4 and the timing fixes are in (Oct 18, `apps/server`, `edit-core`); see *Done* below. Steps 5 (checks against the sound, the footage's frame rate) and 6 (fixtures as tests) are still to do; the offline harness in `/tmp/subsrun/harness` is the start of 6.

## What must never happen

1. **One person in several colours** (their subtitles, label, intro caption or quote).
2. **Several people in one colour**, or in colours close enough to read as one.
3. **Words given to the wrong person.**
4. **Subtitles off the speech**: early, late, or flashing too briefly to read.

Today each of these is avoided by heuristics in two separate systems, not ruled out by construction.

## How it works today, and why it can go wrong

| | Subtitle videos (`repack_subtitles`, `apps/server/src/subtitles.ts`) | Edits (`add_subtitles`, `apps/server/src/captions.ts`) |
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
- **Timing** (corrected Oct 18: the first count had its sign backwards): 19 lines start late (a frame or more after the first word, up to 0.3 s), from the 400 ms floor delaying the same speaker's next line, and **75 start over a quarter second early** (up to ~1 s), from `uncram` treating ordinary quick talk (over 25 characters a second, "Now, you stay right here." in 0.74 s) as wrongly timed words and moving the line back into the gap before it.
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

No line in any of them mixes two voices' words. The flashes under 400 ms are probably from before `MIN_SHOWN_MS` was added. (The "late lines" column counted early ones too; see the corrected timing above.) Colour violations need eyes, not just ΔE: Traffic Stop's Heather in white next to a pale cyan reads as one person.

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

## Done (Oct 18)

Measured on the six delivered subtitled videos' saved transcripts (`/tmp/subsrun/harness`: the pipeline offline, old code against new):

| | Late starts | Over 250 ms early | Pairs under ΔE 28 | Someone in white |
|---|---|---|---|---|
| Young Actress | 20 → 0 | 76 → 0 | 0 → 0 | 0 → 0 |
| INTERRO Comp (18 people) | 18 → 0 | 86 → 0 | 10 → 1 | 1 → 0 |
| Trench Coat Teen | 21 → 0 | 30 → 0 | 0 → 0 | 0 → 0 |
| Neglected 8-Year-Old | 26 → 0 | 74 → 2 | 7 → 0 | 1 → 0 |
| 12-Year-Old Killer | 16 → 0 | 55 → 0 | 0 → 0 | 0 → 0 |
| Teen Scammer | 13 → 0 | 23 → 1 | 0 → 0 | 0 → 0 |

- **The cast**: `project.people` and `Clip::person`, enforced by `Project::validate` (a person's clips all in their colour, no clip naming nobody, nobody white). One assigner (`people.ts`, ΔE 28) for both subtitlers; Repack subtitles are people too; ids and colours stay put across re-runs. Shared between a subtitled video and the edits from the same footage through the transcript: its colours are per person (voices named alike share one) at ΔE 28, so both start from the same colours. Not yet: a separate per-source `people-v1.json`, `same_as` across files (names are still matched across files by `same_person`), colour drawn at render time (it's still stored per clip, but can't differ within a person).
- **Timing**: a line too short to read joins the same person's next line (same moment included) or comes up at most 250 ms early; the next line never starts late. Only words faster than anyone talks (36 characters a second) count as crammed, and they move back into the gap only after a stretched word (the evidence they were said there). Both subtitlers. One-at-a-time mode keeps sync over the 400 ms floor where two people answer within a fraction of a second (~20 lines of 900 under 400 ms; overlap mode has none).
- **A narration line touching a footage edge** stays the narrator's (hidden), never a one-frame "Other".
- **Who is who across the windows** (step 4, `cast.ts`): after the watch, one text call (~4 s, $0.0025) gets every window's people and groups them by look and place; every voice of a person gets one name, and a voice that is two people has its words moved where it's the other. Young Actress: the bald agent's four voices (one of them the door officer at the start) and the green-shirt agent's three are one person each, automatically; the delivered video, fixed by hand by renaming voices, still had 9 of the bald agent's lines (28:07–28:22) in the door officer's colour, because one voice was both. Not yet: Vision face prints (Apple's feature prints are general image similarity, not identity).
- **Segments held to who is heard** (`voicedSegments`): the model's narration stretches move between runs (one run marked 18 s of the agent and suspect as narration, unsubtitled, and missed the narration before it). A narration stretch where the room talks is footage; a long narrator monologue in footage is narration only where the watch saw that voice as the narrator in that window (in three of the six videos the transcript's "narrator" voice is someone in the room). 12-Year-Old Killer gains 3 lines that were never subtitled.
- Remaining from the audit: the 400 ms floor rounds to 375 ms at 24 fps; INTERRO Comp's 18 people leave one pair under ΔE 28 (shared by people furthest apart in time).

## Order

1. The cast file and `person` on clips (edit-core), with migration: existing projects' labels and transcript names become cast entries.
2. One colour assigner (ΔE 28) and the validation rules.
3. Both subtitlers read and write the cast; corrections move there.
4. Cast reconciliation after the watch windows; face feature prints.
5. Timing checks against the sound; footage frame rate for subtitle videos.
6. Fixtures and the accuracy report.
