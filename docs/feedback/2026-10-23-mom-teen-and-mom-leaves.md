# JJ's notes on Mom & Teen v7 and Mom Leaves 5 Kids v5 (Oct 23)

Two Frame.io shares, read with `read_review`; applied by the in-app agent (feedback skill, Opus 5.5, medium), exported on Modal and shared on feedback.spheceo.com:

- Mom & Teen Daughter Buries Newborn in Bucket: v8 export, **v3** of https://feedback.spheceo.com/r/Ug9oMabqU-UkchweyTq9Eg (the user kept the existing link). 8 comments, 18 min of agent time (and 1.5 min for a follow-up).
- Mom Leaves 5 Kids Home Alone: v6 export, **v1** of https://feedback.spheceo.com/r/IFdELQxlG1zOCHYbm9btJQ. 6 comments, 5 min.

## Patterns

**Boards and desktops too quick and too busy.** Mom & Teen #1 (0:53): "far, far, far too rehearsed… This has to be a lot smoother"; #2 (1:02): "more space in between the images"; #3 (2:28): "dangerous to have two things appear at the same time when they are across the screen"; Mom Leaves #4 (4:48): "slower so we can actually see what is going on"; #6 (29:32): "simply not smooth enough".

- Cause: evidence boards with five photos panned sideways between them, and desktop windows opening together on opposite sides.
- What the agent did: at most four photos on a board, side by side with one slow push-in, each photo and note fading in a beat before it's said; desktop windows at least about 1 s apart; all applied across both videos.
- Teach next: these as house rules in the cut-ins skill. The agent's proposals: "windows open at least 1 s apart", "an evidence board has no more than about 4 photos". JJ's word "rehearsed" means rushed, not scripted.

**Graphics leave too soon.** Mom & Teen #4 (5:34): "file viewers stay for a little longer each"; #8 (16:05): "this screen for longer so people can actually read the charges"; Mom Leaves #5 (15:36): "stay on the scene for a little longer - until the footage starts again".

- Fix: holds lengthened; charges cards 5–7 s each; the Notepad stays until the footage returns.
- Teach next: "each charges card is held at least 5 s", and a screen stays until the footage it leads to starts. An audit could flag a charges card under 5 s.

**A File Viewer over a cut.** Mom & Teen #5 (5:38): "We keep the file viewer even while changing scenes."

- Fix: each viewer now sits over a single shot.
- Teach and audit next: "one shot under each File Viewer". An audit kind for a viewer that spans a cut is the tool.

**Subtitles beside their speaker.** Mom Leaves #2 (0:13) and #3 (0:20): "'bed' and the other subtitles to actually stay next to the mother", "ensure that all subtitles are in the right place".

- Fix: intro captions follow the speaker's face when they're visible, and sit bottom middle when they aren't.

## One-offs

- Mom & Teen #6 (9:44): "dont have this pop up to the left… just stay on the notepad". The pop-up is removed.
- Mom & Teen #7 (13:47): "not blurred properly". The neighbour's child's blur had slipped onto the woman; it's re-tracked.
- Mom Leaves #1 (0:08): "remove all the clips up until this point". The first 8.2 s (two teasers) are cut.

## Code

- `read_review` took a comment edited after posting ("Edited" before its number) as a reply to the one before it, which hid Mom Leaves #2 and #5. Fixed in `dca6cfd`, with a test.
- Edit can't pin its own notes on a review: Repack's `reviews:*` has no note-creating mutation for apps. The points to confirm went to the user with the links instead.

## Open questions for the user

- Both agents re-ran the house mute pass over the whole video, which muted words in the narration too: in Mom Leaves "blood", "child" twice and "hit"; in Mom & Teen "abuse" in the voice-over at 16:12. Keep them muted?
- Mom & Teen #8 offered stacking the mother's and Hanan's charges if they're the same. They aren't, so the cards are held one after another instead.
- Clipped word ends from earlier rounds are still open: Mom Leaves at 3:59, 12:31 and 30:24; Mom & Teen at around 3:36–4:51 and 9:30.
