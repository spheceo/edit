---
description: Read and edit the timeline as code (Edit Script): read_edit, run_edit, describe_shots, save_graphic.
---

Edit Script is the timeline as TypeScript. It's the fastest way to see a stretch whole and change many things in one go. edit_script_reference has every call.

1. **read_edit {start, end}** (at most 180 s) prints the stretch as calls. Each clip is a line: `shot("m590", {id: "c594", from: 11.83, to: 16.6, source_in: 0, speed: 0.8}) // name · source · sees: …`. Compositions are one line with their layers' ids: `youtube({ids: [...], from, to, title, …})`. The narration sits between them as `// says @12.0: …`. Run that line back with a change and it updates the clip. Without an id it adds a new one. With ids, a composition is rebuilt.
2. **describe_shots** over the stretch before judging it. It turns each shot's rendered frame into facts: what's on screen, its text, who (from the source's title and your notes, never from faces), whether it's empty, and whether it fits the words said over it. Facts stay until the shot changes. Re-describe what you change.
3. **run_edit {code, start, end}** runs a script. It reads `clips`, `shots` (with `facts`), `words` (the narration, `{text, at}`) and `media`; `said("most hated")` is where a phrase is spoken. It writes with the calls, in timeline seconds. Loops and helpers are plain TypeScript:
   ```ts
   // Every shot the describer says doesn't fit: show what the words name instead.
   for (const s of shots.filter((s) => s.facts?.fits === "no")) note(`${s.id}: ${s.facts?.why}`);
   const at = said("Kanye West");
   shot("m731", { from: at, to: at + 3.2, source_in: 41.5 });
   punch("c594", { at: [said("hated")], on: [480, -60], scales: [1.25] });
   ```
   The whole script saves as one plan, or nothing: an error names its line, and an invalid plan says why. The answer lists the audit's issues in that stretch and the lints, which are errors to fix:
   - a shot that doesn't fit its words;
   - a shot that shows nothing.

   dry_run checks without saving; a script that changes nothing (`note(...)` only) returns the stretch's issues as they are. A saving run describes the shots it changed, so its lints judge your new pictures at once. `media` items carry their scene `cuts` (source seconds) where known: start a shot after one and end it before the next. `shot({fill: true})` covers the frame (a photo of another shape would sit in black); a shot whose source runs out is refused.
4. **save_graphic** keeps a function you wrote (a composition you'll reuse: a stat reveal, a two-post comparison) for every script in every project. read_edit lists the library.

Work a chapter at a time: read_edit, describe_shots, one run_edit that fixes what you found, then read_edit and describe_shots again on what changed, until the lints are clean.
