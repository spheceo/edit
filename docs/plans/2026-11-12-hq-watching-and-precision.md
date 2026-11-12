# Bodycam HQ: watching while the agent works, and copying a reference precisely (Nov 12)

Two things from the bodycam HQ test. Part 1 is agreed but not built yet ("we still have a lot of work to get done"). Part 2 is the fixes that came out of comparing the agent's graphics with the references, frame by frame.

## Part 1: watch normally while the agent works (not built)

The team will have several things going on and queued at once, and playback while the agent builds is "horrible".

**Why it is bad today.** The player plays the finished smooth render only when it matches the edit's current version exactly. The agent saves many times a turn, and Edit never asks for a render mid-turn (each would be stale before it landed). So for the whole turn the player draws the edit live from the raw footage, the slow path. Meanwhile the server is also rendering graphics, the agent is looking at frames, and every agent save is pushed into the viewer.

**The plan, in the order to build it:**

1. **Watch a fixed version while a turn runs.** The player keeps playing the last finished render. The agent's changes build up out of view.
2. **Swap the changes in without interrupting.** When the turn ends, only the changed parts are rendered (the render's chunks are named by their content, so untouched stretches are reused). They replace the old ones chunk by chunk, ahead of the playhead and never under it, so a change is simply there when you reach it. If the agent added or cut time before the playhead, the playhead keeps the same moment, not the same timecode.
3. **A quieter screen while it works.** The working glow much dimmer, or a small status line ("Agent working · 2 changes ready"); the flash sweeping across the picture removed.

Later:
- Several graphics built at once (a subagent per graphic: effects are separate folders). Timeline edits stay one at a time through one agent so they never conflict.
- While someone watches, their playback comes first on the server; graphics renders and the agent's frame looks wait.

Already true: comments and queued messages are kept on the server and run in order, with the tab closed or not.

## Part 2: copying a reference precisely

Sphe's aim: "give it a link, give it a range to look at, and it can come back with precisely what I'm looking for", from about 80% alike to near exact.

**What went wrong, measured:**

- **Evidence board (reference 4:19 and 10:15–10:40):** the layout and staging are close, the handwriting isn't.
  - **Redrawn every frame:** the board drifts, and each frame the labels land a little differently, so they shimmer. In the reference the letters are identical across 24 frames in a row; only the board moves, smoothly.
  - **Outline added:** an outline 3.5 px wide on top of the letters turns a thin pen into a fat marker.
  - **Too big:** the labels are about four times the reference's size against their photos (1.5 photo widths, where the reference's are a third).
- **Focus effect (reference 51:05):** the reference cuts the man out along his outline, keeps him in colour with a faint white spill at his edge, and greys and darkens everything else. The agent drew a loose shape round his head with a yellow glowing ring. Edit has no way to cut a person out of footage, so the agent filled the gap with a look of its own instead of saying so.
- **Why the agent didn't notice:** it studied the references frame by frame at full size. But it checked its own graphics only as separate stills at chosen moments, at most 8 per look. Nothing that moves between frames shows there, and nothing set its frames beside the reference's.

**Fixed (Nov 12):**

- **look_at_effect `every_frame`:** shows each frame of a stretch of the agent's own graphic, numbered, 16 to a sheet and up to 48 a look, to set beside the reference's (look_at_media `every_frame`). `detail: "full"` draws its stills at full size.
- **Bodycam HQ's instructions (agent/hq/notes.md):**
  - **Draw once:** draw what doesn't change once, at twice the size, and move it with the camera; never redraw it every frame.
  - **The reference is the brief:** copy it element by element (sizes against each other, strokes and weights, colours, timing). Add nothing it doesn't have, leave nothing out, and compare every frame before calling it done. Where the tools can't do what it does, say so first instead of covering the gap.

**Open:** a subject cut-out for effects. A tool that gives an effect a matte of a person (or whatever is in focus) for every frame, the way `effect_beneath` gives it the picture beneath, from a matting model run here as the face and text models are. Without it, the focus look stays approximate.
