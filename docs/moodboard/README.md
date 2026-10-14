# Editing styles: mood board

Distilled from the team's doc "How we want our edits to be" and the videos it links. One section per style; **bodycam (FOIA)** is the one we're building now, the others are next. Status markers:

- ✅ Edit does this today (or the agent is taught it)
- 🆕 added from this doc (see "What changed in Edit")
- 🔜 worth building next
- ❓ open question for the team
- ⏸ on hold until the team confirms

The stills in `shots/` are frames from other channels' videos, kept on this machine only (the repo is public; they're gitignored). The doc links each source video.

---

## 1. Bodycam / FOIA (current focus)

North star: **Code Blue Cam** (huge, branded, same kind of videos as ours). The doc says to study how they edit, but keep **our own subtitles, our own clean UI assets and our way of identifying people**. Second reference: **Unspoken Crime**.

### What Code Blue Cam does

| | |
|---|---|
| ![](shots/cbc-cold-open-shots-fired.png) | **Cold open on the peak.** The video starts mid-chaos: the gunfire, a caption shouted on screen ("SHOTS FIRED!"). No title card first. ✅ our intro hook does the same. |
| ![](shots/cbc-brand-sting.png) | **Brand sting** between the hook and the story: the logo over a red/blue police-light sweep, about 1 s. 🔜 ours would be the logo over dark red (see HQ's branding). ❓ |
| ![](shots/cbc-location-label.png) | **Establishing aerial with the place** bottom-left in a technical, all-caps face: "HARMONY TOWNSHIP, OH". ✅ map_view and the place label (ours sits on the building). |
| ![](shots/cbc-911-waveform-subs.png) | **911 call over the aerial:** a thin white waveform across the frame, captions in their subtitle box below. ✅ our glowing waveform and dark vignette. |
| ![](shots/cbc-floorplan-reconstruction.png) | **Reconstruction:** a floor plan drawn over the satellite view, people as dots (red = suspect, white = officers), doors marked in red. 🔜 a bigger feature; good for "what happened inside". |
| ![](shots/cbc-pov-map-dots.png) | **Who's where:** coloured dots for people on a top-down view, while the call plays. 🔜 |
| ![](shots/cbc-image-viewer-suspect.png) | **Suspect card** in a macOS-like "Image Viewer" window: name in red, age in white, in a bold condensed face, over the scene or a flat brand colour. 🔜 our "clean UI" twist (see below). |
| ![](shots/cbc-pov-name-watermark-cyan-sub.png) | **Whose camera it is**, top-left: "Deputy Rassi", small white text. ⏸ on hold until the team confirms (the agent won't add it). Also a **faint logo watermark** dead centre, and the bodycam's own timestamp kept. |
| ![](shots/cbc-bodycam-subs.png) | **Subtitles:** cyan, bold, in a tight black box, bottom centre. We keep **ours** (white, black box, the speaker's name above in their colour). |
| ![](shots/cbc-positioned-subtitle.png) | **Subtitles move out of the way:** set high and left here so they don't cover the action. ✅ the agent places intro captions by the speaker; ❓ do the same with subtitles when the bottom is busy? |
| ![](shots/cbc-focus-blur.png) | **Focus pull:** the edges blurred so the eye goes to the person (a blurred vignette). 🔜 we vignette and darken, but don't blur yet. |

### What Unspoken Crime does

| | |
|---|---|
| ![](shots/uc-911-dispatcher-green.png) ![](shots/uc-911-caller-yellow.png) | **911 calls coloured by speaker:** the dispatcher in green, the caller in yellow, italic, glowing, no box, over a dark desaturated aerial with a white waveform. ❓ our call captions could take the speaker's colour the same way. |
| ![](shots/uc-subs-officer-label-blur.png) | **"Officer:" above the subtitle** in a small cyan label, white words in a black box. ✅ the same as ours, which is good validation. Heavy blur over a victim. ✅ "blur" notes from the Doc are followed. |

### The doc's asks for bodycam

- **Subtitles:** keep the current subtitle style and the current intro caption style (a little glow, black box). ✅
  - "Keyframe them a little more often": ❓ we read this as more movement on the intro captions (punch-ins, tracking the speaker). Is that right?
  - "At times only one word appears at a time." 🆕 a new **One word at a time** caption style, used on shouted peaks ("Shots fired!", "Drop it!").
- **The POV officer's name, top-left**, from the incident report (whose Axon serial is whose). ⏸ on hold until the team confirms; the agent won't add it unless asked.
- **Our own assets:** the clean UI we're designing, used at certain times, and identifying people our way (✅ the callout label with a red line).

### Our bodycam recipe today (from the house style)

✅ opening dip from black · speaker captions in the intro, in the speaker's box style · punch-ins on reactions, a slow zoom on witnesses · B-roll from the footage over cut-ins, timed to the narration's phrases, desaturated · varied transitions (the glitch at most once or twice) · camera shutters on quick-cut runs · the date cut-in on a moving 3D map with the place label · phone calls as a glowing waveform over a dark vignette · word-by-word subtitles that fill in place · music that fits each scene, every transition heard.

---

## 2. Interrogation (Sam)

References: three interrogation edits, plus the countdown example.

| | |
|---|---|
| ![](shots/int-countdown-map-pulse.png) | **"INTERROGATION STARTS IN: 01:33"** top-left, counting down from the case's introduction to the interrogation (used when there's no bodycam). A black tab, white caps, bold timer. 🔜 needs a counting text element; easy to add next. |
| ![](shots/int-countdown-file-viewers-map.png) | **File viewers on a map:** mugshot cards titled "File Viewer", name bold and age small, around a pulsing location marker (rings). 🔜 the clean macOS-style UI. |
| ![](shots/int-file-viewer-cards.png) | **People introduced as cards** laid over the interrogation room (dimmed), unknown people as silhouettes, names in red. 🔜 |
| ![](shots/int-countdown-disclaimer.png) | **Disclaimer** before the interrogation (the countdown still running). ✅ a text card the agent can make; ❓ the wording (see HQ). |
| ![](shots/int-watermark-pip.png) | **Watermark** "LS", large and faint over the footage, and **picture-in-picture** of a second camera bottom-left. 🔜 picture-in-picture is a transform plus a border; doable now by hand. |
| ![](shots/ls-red-speaker-sub-by-face.png) | **Small subtitles by the speaker's face,** red on black (the interviewer). ✅ our intro captions do this. |

- **Editing style:** a macOS kind of UI, with our own twist.
- **Subtitles:** the same as always. ✅
- **Music:** cut to impact points in the clips (the doc's music link). ✅ the agent lines up hits on reveals; ❓ more cutting of the edit to the music's beats?
- **Overlays:** ✅ wanted.

## 3. Interrogation compilation (Sam)

The same style as the interrogation, plus:
- Lines like "But this is just one of three cases when…" over a **carousel**, or **three small frames on one screen**. 🔜 a multi-frame layout (three video clips scaled and placed is possible now by hand).
- ✅ **Watermark** with our own logo. ❓ we need the logo file and where it goes (see below).
- ✅ **Overlays.**

## 4. HQ (Detective Leg)

| | |
|---|---|
| ![](shots/ls-red-911-waveform-subs.png) | **Red waveform with red subtitles** on a dark aerial: on-brand dark red. |
| ![](shots/ls-chromatic-glow-flashback.png) | **Doorbell or CCTV look:** a soft glow with RGB-split edges, desaturated. 🔜 a grade preset. |
| ![](shots/ls-watermark-shirt.png) | **Watermark** "LS", faint and large. |

- ✅ **Watermark** (like LS).
- **Disclaimer of liability** in the intro.
- **Subtitles:** Dr Insanity-style subs. ❓ need a reference (no link in the doc).
- **Dark red assets** (backgrounds and so on) matching our logo and branding.
- **File viewers and paper viewers**, like Dr Insanity's. 🔜

---

## Contradictions and open questions

1. **POV officer name.** The doc says "let's have the name of the officer we're seeing as the POV in the top left", then "It is not something that we should do, but by reading the incident report, we should be able to locate what Axon tags belong to whom." We took it as: do it, but never guess. The agent only names a camera when the report or transcript ties the Axon serial to an officer, and lists the ones it couldn't place. Is that right?
2. **Watermark on bodycam.** The doc ticks the watermark for the interrogation compilation and HQ, but not FOIA. Our bodycam north star (Code Blue Cam) has a faint watermark dead centre on every frame. Do bodycam videos get one too, and where: centre (Code Blue Cam) or large and faint (LS)? We also need **our logo** as a PNG (white, transparent background) to build it.
3. **Subtitle colour.** Code Blue Cam's are cyan; the doc says to keep ours. We're keeping ours, so this is just noting the difference.
4. **"Keyframe them a little more often"** (bodycam subtitles) is ambiguous: more movement and tracking on the intro captions, or shorter caption chunks? See above.
5. **"Dr Insanity style subs"** (HQ) and the music impact-point example: we couldn't see what's meant without a reference frame. A screenshot would settle it.

## What changed in Edit (from this doc)

- 🆕 **One word at a time**, a caption animation (Inspector → Animate in): timed from the speech like word-by-word, but only the word being said shows, alone and centred. The agent uses it on a few shouted peaks.
- ⏸ **Officer POV name**: rank and surname small in the top-left while that officer's camera is on screen. On hold until the team confirms.

## What we'd build next (in order)

1. **Watermark** (once we have the logo): one setting per project, drawn on top of everything in preview and export.
2. **Countdown timer** ("INTERROGATION STARTS IN 01:33"): a text element whose number counts down to a frame.
3. **The clean UI kit:** a macOS-style window frame (title bar, "Image Viewer" / "File Viewer"), with a photo inside, a name and an age. It's the shared piece behind suspect cards, file viewers and paper viewers in every style.
4. **Styles as separate house styles:** today the agent's house style is all bodycam. Splitting it into a shared core plus one section per style (bodycam, interrogation, compilation, HQ), chosen per project, is what lets the agent edit each style.
