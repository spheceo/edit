---
description: The whole Short in one go, from the source video to the finished 9:16 cut: load this first when the user asks to start the edit or the editing workflow.
---

THE SHORT, start to finish, in this one turn ("start the edit", "start the editing workflow", "make a Short of this"); whatever else the message says steers every stage. Don't stop to ask: decide, and keep a short list of what you weren't sure about for the summary. Minutes, not hours: one context read, one plan and one look per stage.

FOOTAGE THE IMPORT COULDN'T FETCH: as in every edit, when get_edit_context's `import` is `waiting`, ask "Go on without it, or do you have a replacement?" (replace_footage / skip_footage); never ask them to retry.

1. THE HIGHLIGHTS. The source is usually the whole video, laid on the timeline by the import. A script with ranges (Writer's highlights) is the cut: keep its ranges in its order and go to 2. Without one, read what's said once (read_transcript, transcribing first if needed) and choose 45–60 seconds that tell one complete story on their own: the hook (the line or moment that makes someone stop scrolling: the accusation, the lie, the turn) first, then just enough setup to follow it, the escalation, and the payoff last (the arrest, the confession, the punchline). Keep each speaker's sentences whole; drop the dead air, paperwork, repeats and everything that waits. Order stays as it happened unless the hook comes from later: then the hook, a hard cut, and the story from its start. Write the ranges down with why each earns its place.
2. THE CUT. Take out everything else in one batch of remove_time, last stretch first (so earlier times don't move); a jump cut inside a scene is fine, every cut hard. Check the total is 45–60 s (the audit's short_length).
3. THE FRAME. reframe with no arguments: every shot fills the 9:16 frame and follows the subject. For each clip it says had no face (a redacted face, someone turned away, a car), look at that clip once (one contact_sheet over those clips) and reframe it again with centres: where the subject is across the source picture from each time on. Where two people talk across the frame, centre who's speaking, moving at the turns of the conversation. A punch-in only where a reaction earns it, after reframing (scale keyframes at or above the fill scale reframe answered).
4. BLUR. The bodycam's stamps and overlays that the crop still shows, the uploader's marks (blur_marks), and the house's faces and screens, as in every edit.
5. Load subtitles, then music-and-sound, then final-pass, and follow them.

Finish with the length, the ranges you kept (source times) and why, and anything you weren't sure about.
