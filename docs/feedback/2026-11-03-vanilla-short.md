# Vanilla extract short: zoom out (Nov 3)

Review: https://feedback.spheceo.com/r/lJk9FQ2NOoprlc5CU0mXGw
Project: She Drank 21 Bottles of Vanilla Extract and Crashed (`p1793233709938-138`)

The note: the dashcam screen is unreadable, there are too many errors, and a zoom-out with blurred bars at the top and bottom might help. It was applied to this Short only. v2 had no comments (the seven notes are all on v1), so the new export replaced v2 on the same link.

## The edit

The agent ran `blur_bars` once. Each dashcam shot is the whole 16:9 picture, centred, over a blurred copy that fills the bars. The crop and the punch-in are gone. The callout, arrow, subtitles, music, click and shutter were left.

The bodycam stamp and the uploader logo were readable on the sharp picture, so the existing rect blurs were moved onto them. Those rects run the whole timeline and sat on her hair during the freeze (frames 108–144). A second turn split both so they stop at frame 108 and start again at frame 144.

Frames 40, 120, 200, 700, 1100 and 1250: the bars are soft, and the stamp and logo are covered outside the freeze. Frame 120 is still the close-up, with the title and the arrow. A diff against the frame from before the split shows the two boxes gone.

## The product

- `blur_bars` is an op, not the way every Short is framed. A shot already over blur bars is not `short_unfilled`.
- A share replaces the latest version when it has no reviewer comments, and adds the next version when it has any. Replies and notes written from Edit do not count. The server decides. The Share dialog no longer has a checkbox for it.

Shared from the installed home. The server log: v2 replaced at the link above. Not committed.
