# To do

Ideas and next steps that aren't started yet. Newest at the top.

## Ideas and thumbnails: a feedback link (future)

A way to send an idea or a thumbnail off to a feedback link — share it outside Edit for review, the way an edit goes to its review link, and have what comes back land where the work is. Not built yet; wanted so ideas and thumbnails can be sent for feedback without a screenshot and a message.

## Thumbnails: what's not built yet (get back to this)

Thumbnails is a working draft (Nov 2; `docs/thumbnails.md`; commits 39a833aa, 44f9aedd, b7e7952d). Paused there ("we'll get back to this later"). Not built yet:

1. **Caption styles per channel or niche**: which text style (black box, white and red, none) each channel and niche takes. Sphe: "the text stuff depends on the niche/channel whatever but we'll get to that later". Goes in `agent/thumbnails/guide.md`, with the channel or niche set on the thumbnail.
2. **Frames from YouTube**: give Claude Ideas' `scan_video` and `grab_frames` (`app/apps/server/src/ideas/frames.ts`, through the YouTube proxy) on a thumbnail, so it can pick a base and its subjects from the case's video itself.
3. **A thumbnail from an idea's guide**: start one from the idea page with its thumbnail guide, frames and base already in the thumbnail, and link the two.

Shipped to prod with nightly-48: one OpenArt sign-in, held by the live relay (dev asks it).
