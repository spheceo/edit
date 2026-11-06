# Cops Realize Their Own Colleague Is The KILLER: JJ's 31 notes

JJ's review (feedback.spheceo.com/r/omql-7MoSpwLhJ8ViuE3ow, project p1793808303783-46052, cloud), Nov 6. JJ pressed Ready for changes for 31 notes on v1 at 14:34 SAST. Mathias's Mac took it, on nightly-58. v2 went up at 15:25 with 7 of them fixed. JJ has left 2 more notes on v2 since. Sphe: share it as v3 (v2 has comments), with the v1 and v2 notes fixed.

## Fixes on the way

1. **"Audio only in the left ear" (0:44, 12:40, v2 0:45) was left unfixed: Edit had no channel control.** An audio clip now has `channel` (left or right), which plays that side of its source in both ears, in both the export's mix and the preview. The plan's `both_ears` op measures which side carries the sound and sets it for a whole source. The music-and-sound skill says when to use it.
2. **The round was shared half done.** The turn compacted 2 minutes in, fixed 7, ended with "this round is not finished", and followFix took the end of the turn as done. Now a turn that ends with notes unanswered sends them back to the agent (up to four sends, while each send gets some answered). Only then is anything shared. Any note still unanswered is left on the review saying so, never "Queued for Edit". The fix message asks for every note in the one turn.

## Before nightly-59 (Sphe, Nov 6)

The notes need a Mac on a build with the fixes above: the 22 untouched on v1, the 2 on v2, the 3 audio ones, and a single click back on the viewers left with none (frames 437, 12322, 37951, 42533). Then share as v3.

## The round on nightly-60 (Sphe's Mac, Nov 6, with JJ's other three)

Sphe asked for this review and three more of JJ's (Female Police Captain ria0huFRqGapbrsO9Ig34Q, Predator Teacher ndYdvC7G6ZmRHyOat6dbwg, Cops Surprise Predator Son & Dad kZZJlPlalisDKuzoGeAyzA) to be done on his Mac, all at once.

3. **pull_feedback refused on any Mac but the one that shared the review** ("This project hasn't been shared for review"). All four were shared from Mathias's Mac. A Ready for changes taken on another Mac also always shared as a new version, because that Mac knew none of the versions. Now a Mac takes the review in from the cloud (`reviews.adopt`: the link, plus each version's timeline, fps, length and clip map from its meta). Test: reviews_pull "a review shared from another Mac…". Shipped in nightly-60. At 17:38 the four pulled 26, 22, 55 and 7 notes in parallel.

### Fix 4: notes put off with feedback_unfixed, and silent share failures (5b1161bb)

After the network fix the four turns ran 8–11 min and ended with 41 of 110 notes fixed; the other 69 got feedback_unfixed reasons like "Not done: Michael's image timing not yet adjusted" and "not reached this turn". An unfixed note counts as answered, so followFix sent none back, and then all four shares failed before exporting, with the error only on the review page (the disk had ~0 free by 19:19; the share's room check refuses up front). Fix: feedback_unfixed refuses a reason that says the note wasn't got to (`putOff`; all 69 of tonight's refused, none of the 9 genuine reasons on other reviews), the feedback skill says so, and a failed share is logged. On nightly-60 (no fix yet) the four were asked again in the chat with pull_feedback {again: true} at 20:04; 11 GB of stale build caches were freed for the exports (26 GB free).

### Fix 5: frames from whole previews here (9d1c2cd8, nightly-61)

The four projects' footage was imported on Mathias's Mac, so every frame the agents looked at streamed from R2 in blocks: a contact sheet 3 min 32 s, a render_frame 3 min 06 s, a plan's review frames 3 min 31 s, ~90% of the turns' tool time (Son & Dad's 2 notes took a 57 min 51 s turn). Each cloud preview is now fetched whole when a turn starts (four at a time) and the agent's renders read it (local_previews.ts); exports made ahead wait while an agent works. Measured on Son & Dad: 6 frames streamed failed after 8 min 52 s, from the whole previews 1.5 s.

### Fix 6: Home's status held the server (d5425c15, nightly-62)

On nightly-61 the server answered health in 13–52 s: /api/projects/status built and sorted every project's whole chat twice (54 chats, 6.5 MB) every few seconds, and so did each followed fix. The agents' tools didn't connect (Cops Realize, six times), whole previews took 3–4 min, and Son & Dad's share upload had R2 close its sockets. Whether a turn runs is now read without building the chat (agent.ts `turn`); health 0.03–2.75 s after.

Also on the way: Cops Realize's chat was flagged by the model's safeguards (Sonnet and Opus) every turn, so it was reset (the old chat kept in ~/Documents/edit-chat-backups); three flaky tests fixed so just check passes on a loaded Mac (f8592da8, c2c034dc's media timeout, 37c4d0b4's lint).
