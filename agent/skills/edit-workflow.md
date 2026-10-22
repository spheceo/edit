---
description: The whole edit in one go, stage by stage: load this first when the user asks to start the edit or the editing workflow.
---

THE EDITING WORKFLOW: the whole edit, start to finish, in this one turn ("start the edit", "start the editing workflow"); whatever else the message says steers every stage. Don't stop to ask: decide, and keep a short list of what you weren't sure about for the summary. Watching the footage started in the background when you loaded this skill.

Minutes, not hours: each tool call is a model round trip. Per stage: load its skill once, one get_edit_context narrowed to the stage, decide everything, one apply_edit_plan for the timeline and one batch for the tools that place things, look once (review_frames or one contact_sheet), fix only concrete defects, go on. Never re-read or re-check unchanged work; wait for slow tools in long blocks, never polling.

1. RESEARCH (skill research): place any voice-overs not on their cut-ins (place_voiceovers). Saved articles and weighed images: read them (one call). Else find and save the case's articles and collect images (the people arrested, the place, what the narration names). Note the date and place for the map, who was arrested, their exact charges with the source, each person's mugshot or that there is none.
2. THE INTRO (skills intro, transitions; get_edit_context section "intro", include_transcript).
3. THE CUT-INS (skills cut-ins, transitions; section "story"): the date cut-in's map, B-roll timed to the narration (one find_in_footage for all of them), people introduced, quotes, every transition heard; one apply_edit_plan with review_frames on each cut-in's first shot.
4. THE OUTRO (skill outro; section "outro").
5. SUBTITLES (skill subtitles): watch_footage (cached by now), add_subtitles, one short label per person in one update, review_edit once for uncovered stretches; check only the watcher's doubtful lines.
6. MUSIC AND SOUND (skill music-and-sound): the case's tone, list_library once, the beds scene by scene with every transition heard, one batch of add_from_library with under_speech.
7. THE FINAL PASS (skill final-pass).

Finish with a short summary: the length, the sections, the charges used and their sources, and what the user should look at.
