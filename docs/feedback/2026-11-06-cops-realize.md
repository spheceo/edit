# Cops Realize Their Own Colleague Is The KILLER: JJ's 31 notes

JJ's review (feedback.spheceo.com/r/omql-7MoSpwLhJ8ViuE3ow, project p1793808303783-46052, cloud), Nov 6. JJ pressed Ready for changes for 31 notes on v1 at 14:34 SAST. Mathias's Mac took it, on nightly-58. v2 went up at 15:25 with 7 of them fixed. JJ has left 2 more notes on v2 since. Sphe: share it as v3 (v2 has comments), with the v1 and v2 notes fixed.

## Fixes on the way

1. **"Audio only in the left ear" (0:44, 12:40, v2 0:45) was left unfixed: Edit had no channel control.** An audio clip now has `channel` (left or right), which plays that side of its source in both ears, in both the export's mix and the preview. The plan's `both_ears` op measures which side carries the sound and sets it for a whole source. The music-and-sound skill says when to use it.
2. **The round was shared half done.** The turn compacted 2 minutes in, fixed 7, ended with "this round is not finished", and followFix took the end of the turn as done. Now a turn that ends with notes unanswered sends them back to the agent (up to four sends, while each send gets some answered). Only then is anything shared. Any note still unanswered is left on the review saying so, never "Queued for Edit". The fix message asks for every note in the one turn.

## Still to do (no release yet, Sphe, Nov 6)

The notes need a Mac on a build with the fixes above: the 22 untouched on v1, the 2 on v2, the 3 audio ones, and a single click back on the viewers left with none (frames 437, 12322, 37951, 42533). Then share as v3.
