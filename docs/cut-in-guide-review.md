# The Cut-In Guide against the agent's skills (Oct 20)

The guide is the team's draft of 19 October 2026 ("Cut-In Guide: How to Build a Cut-In"). This compares it with `agent/skills/cut-ins.md`, `music-and-sound.md` and the styles' notes, and says what went into the skills.

## Taken into the skills

- **The mindset and the question** ("what do we have to work with here, and what makes it easiest for the viewer to follow…"), order and help, and unrelated footage held too long as the commonest failure: `cut-ins.md`, WHAT A CUT-IN IS FOR.
- **Reading a cut-in first**: recap, teaser and background, what the narration does, related footage, length: READ EACH CUT-IN BEFORE BUILDING.
- **Two builds** (footage only, words and pictures on screen) and the order to work down when there's no related footage: TWO BUILDS.
- **The footage-only build** with its example (cut on a new idea, slowed and normal shots, dissolves, the look, dissolve back out, a riser into a strong moment): A FOOTAGE-ONLY CUT-IN.
- **Which pictures earn their place**, and the new rule of a map instead of a photo of a kind of place: PICTURES THAT EARN THEIR PLACE. A previous mugshot is now allowed where the narration covers a record (MUGSHOTS ARE NOT B-ROLL).
- **Sensitive content** (gore, suspects, children, child victims' photos, names): SENSITIVE CONTENT. The interrogation workflow's "a minor is never shown" now follows it: never a minor in the room, a minor victim's photo with the face blurred unless it's widely public.
- **Sound into and out of cut-ins**: click, riser, wind, silence before fresh footage, music as sound design, varied clicks, typewriter: `music-and-sound.md`, INTO AND OUT OF A CUT-IN.

## What the guide repeats (already in the skills, no change)

Never ahead of the story (B-ROLL NEVER GETS AHEAD OF THE STORY), cut on the narration's phrases, dissolves between shots, each moment once (EACH B-ROLL MOMENT ONCE), the B-roll look as an overlay, mixed speeds (0.5 to 1), no stock or AI pictures, look-alike evidence marked illustrative (evidence boards), quotes on screen (THE QUOTE CALLOUT), notepad text typed in time with the words (DESKTOP PROFILE), music matched to the mood and changed at natural points (music-and-sound).

## What the skills have that the guide doesn't (kept)

These were learnt from feedback rounds and the guide doesn't mention them yet. They answer part of its "Still open" list ("which rules from the current agent guide still apply"):

- A new shot every ~2 to 4 s, never one held past ~4.5 s (Mom Leaves 5 Kids: "more clips", "change clips more frequently"). The guide's "2 to 7 clips" fits inside it.
- Linear push-ins, and one continuous push across cuts of the same moment.
- The date cut-in's map, the date title and the place label.
- Introducing a person (vignette, age and role label, leader), the freeze after a teaser.
- The emphasis run, evidence boards and their shutters, claim lists.
- Never redacted or blurred B-roll; what to do when the footage is thin.
- Labels in plain words, no source abbreviations.
- Phone calls (the waveform), voice-overs on A1, revoicing, tightening.
- Not covered by the guide at all yet: the intro, the outro and charges screens, subtitles (the guide lists them itself).

## Where they disagree (decided this way for now)

- **Image labels**: the guide wants "(actual image)" or "(illustrative image)" bottom left in brackets; the skills label evidence cards in the house label box, with a few words saying what it is. Unchanged until the Windows screen exists (below), since the guide puts these labels on it.
- **Overlay**: the guide offers slight grain, a slight vignette or black and white; Edit has no grain effect, so the B-roll look stays desaturation plus a slight vignette.

## Code it needs (not built yet)

1. **The Windows screen.** The guide's main new build: the footage pauses with a click, the overlay comes on, the camera zooms out until the frame is a window on a desktop, and file viewers, a notepad, an audio player, images and footage windows open around it as they're named. The camera moves while the windows stay still, there's a faint monitor grid over the whole screen, and the way out is a footage window growing to full screen. Today Edit has only `desktop_profile` (one photo and a notepad, for a person). A `desktop_screen` plan op (windows with `at` times like the evidence board, the zoom out of the running frame, a grid overlay, a click marked per window) would make this one line for the agent, and it's the build the guide reaches for in about half of all cut-ins.
2. **Grain** as a grade option (the guide's first overlay choice).
3. **Mosaic blur** for gore (the guide's word; Edit's blur is a smooth blur).
4. An audit for a photo of a kind of place (hard to do mechanically; the skill carries it for now).

## Questions for the team

The guide's own "Still open" list stands (paper screen or desktop, camera moves, one look per video, how much a teaser may give away, the wind effect, effect levels). One more: is the Windows screen for every style, or bodycam only? The interrogation bridges are built from the room's own footage for now.
