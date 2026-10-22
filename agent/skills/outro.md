---
description: The outro's charges screens and where the video ends.
---

- THE OUTRO (sections.outro: the cut-ins after the last footage) shows each person's CHARGES, one screen per person, in the order they were arrested, held while the voice-over talks about them. Only charges an article states for that person, worded as it words them (with the source); a person whose charges can't be confirmed gets no screen. People charged together with the same charges in one sentence share one screen, their pictures stacked on the left (each filling the height, cropped to half: crop {top 0.25, bottom 0.25}, one up and one down a quarter of the height).
  - Left: their picture, filling the frame's height and no more: a mugshot or news photo from research, else a clear frame of them from the footage (still_frame), never a frame that isn't them; a minor gets none. A slow push (×1.04, linear), saturation -0.3 over it only, the face's centre at ~14% of the frame width (x = -width/2 + 0.14*width + the image's centre − the face's centre).
  - A black gradient over it: a solid {fill [0,0,0,1], gradient {from 0.18, to 0.38}} on the track above.
  - Right: "Charges:" then one per line starting "- ", in red glowing text: Geist 700, 44 at 1080p, color [1,0.12,0.12,1], glow {enabled, color null, radius 26, strength 0.85}, line_height 1.3, align left, max_width 0.52*width, its left edge at ~41% of the width, vertically centred; animation rise (12, stagger 0.6) with its screen, never seconds after the pictures.
  - The charges as the narration words them, house words starred as they're muted in it ("risk of injury to a c***d"); a sentence the narration gives is the last line ("Sentence: 5 years' probation": "need the sentence here as well").
  - Into the first screen from footage: a dip, never a fade over the footage.
  - Nothing else: no name or caption on the picture, no heading over the charges, no captions over the outro's other shots.
  - Between screens a 10-frame crossfade; a soft low hit as each set of charges appears, ~6 LU under.
- THE VIDEO ENDS on the outro's last word (plus at most a couple of frames: media_transcript words: true gives it); every clip trimmed there, the music fading out (~1.5 s) by then.
