//! MCP (streamable HTTP, JSON responses) so Codex / Claude Code can edit.
//! Every mutation goes through the store, so the open UI updates live.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine as _;
use edit_core::{
    animatable_params, Clip, ClipColor, ClipContent, Keyframe, Project, ScriptBlock, TextAnimation,
    TextStyle, TrackKind, Transform,
};
use serde_json::{json, Value};

use crate::render::{encode_png, tile};
use crate::server::App;

const ORIGIN: &str = "agent";

pub const INSTRUCTIONS: &str = r#"Edit is a local video editor. Tools edit the project the user has open (pass project_id to target another). Changes appear live in their UI and are undoable there.

Model (JSON):
- settings: {width, height, fps}. Timeline times (clip.start, clip.duration, fade_in, fade_out, keyframe.frame) are integer FRAMES at settings.fps. source_in is SECONDS into the media.
- tracks: video tracks composite in list order (first = bottom, label V1); audio tracks mix. A track holds non-overlapping clips. Video-type clips go on video tracks; audio clips on audio tracks. One video track may be the subtitles' own (subtitles: true): always the top video track, holding only subtitles (add_subtitles puts them there; new tracks go beneath it; tidy_tracks leaves it alone). Put nothing else on it.
- clip: {id, track, start, duration, color (blue|cyan|green|yellow|orange|red|purple|pink), link?, fade_in, fade_out, keyframes, type, ...}
  - type "video" (also images): media, source_in, speed (0.05..20), transform {x, y (px from frame centre, y down), scale (1 = fit frame), rotation (deg clockwise), shake (px of handheld camera wobble, 0 = still)}, opacity 0..1, optional crop {left, right, top, bottom} = shares of the picture cut off each side (0..1); what's left stays where it was in the picture (move it with x/y)
  - type "audio": media, source_in, speed, volume_db, optional mutes [{from, to}] = stretches of the source silenced (SECONDS of the media, like source_in; each fades out and back in over 12 ms just outside it), as repack_subtitles sets on swear words
  - type "text": text (\n for lines), style {font "Geist" (weight 400|500|600|700|900) or "Montserrat" (600 only), size px, color [r,g,b,a] 0..1, tracking px, line_height, glow {enabled (default true), color [r,g,b,a] or null = text colour (default null), radius = blur px (default 46), strength = opacity 0..1 (default 0.5)}, optional max_width px (wrap lines), align left|center|right (how the lines line up with each other, default center; the block stays where transform places it), optional background {color, opacity (0.75), pad_x (12), pad_y (8), border px (0 = none), border_color (white)} = a box behind the lines (border: a line around it, outside it), optional shadow {color, opacity (0.65), distance px (3), angle degrees clockwise from up (112), size px (6), blur px (8)} (with a background, the box casts it), optional label {text, color, size px (26)} = a small line centred above the text in its own colour, in its own box when there's a background (who's speaking: "Officer:"), optional leader {x, y (px from frame centre, y down: the point it starts from, e.g. a person's chin), width px (3), color (red [1,0.1,0.1,1]), draw (frames, 10), attach nearest|side (nearest: where the way to the box's centre crosses its edge; side: the middle of the box's side facing the point, for a box set off to the side), fade (frames, 8)} = a callout: a straight line from that point to the box, drawn in from the point over `draw` frames when the clip starts; then the box fades in over `fade` frames and the words start their animation (e.g. rise with a stagger) (pin the point to a face with track_region target "leader")}. Subtitle house style after the intro (at 1080p; scale by height/1080): Montserrat 600, size 48, white, line_height 1.15, glow off, max_width = 0.8*width - 24, background pure black (color [0,0,0,1], opacity 1, default padding), no shadow, label {text "<speaker>:", color = the speaker's colour, size 26}, transform.y = 0.4*height, animation none, transform (as video, shake included), animation {preset none|fade|rise|pop|typewriter|words|word, duration frames, stagger frames}, opacity, word_times (frames from the clip start at which each word appears, for preset "words": words pop in one at a time, no motion, synced to speech; without word_times one every `stagger` frames. The whole line is laid out from the first word, so each word appears where it ends up and nothing already shown moves; preset "word" is timed the same but shows only the word being said, alone and centred, each replacing the last)
  - type "adjustment": grade {exposure stops, contrast -1..1, saturation -1..1, temperature -1..1, vignette 0..1, vignette_x, vignette_y (px from frame centre, y down: where the light falls; default 0 = centred; follow a person with track_region target "vignette"), vignette_size (1 = the whole frame's vignette, 0.5 = the clear area half as far), vignette_aspect (clear area width / height: 1 round, ~0.6 tall for a standing person), focus_exposure (stops added inside the clear area only: lifts the person), vignette_saturation (-1..1, saturation change where the vignette falls only: grey surroundings, the person keeps their colour)}, glitch {amount (px at 1080p the bands slide, 0 = off), slices (bands across the height, 6: few and tall), rgb (colour split as a share of each band's slide, 0.08: barely any)} = a digital glitch transition: the picture beneath cut into horizontal bands of uneven height, some sliding sideways, a new pattern every frame, blur {radius (Gaussian spread in project px, as CSS blur(); 0 = off; ~35 at 1080p hides a face, scale by height/1080), x, y (the region's centre, px from frame centre, y down), width, height (the region in px; 0 = the whole frame), feather (px the blur fades out over beyond the region's edge; the region itself is always fully blurred), shape ellipse|rect (ellipse for a face, rect (slightly rounded) for a word, a plate, a screen)} = blurs the picture beneath in the region before the grade (follow a face with track_region target "blur"), shake {preset none|handheld|vertical|horizontal|impact|earthquake, and optionally any of motion wiggle|drop, amount (px at 1080p), frequency (wiggles/s), rotation (deg of tilt), direction both|vertical|horizontal, envelope steady|build|hit|swell (wiggle only), motion_blur (frames of movement smeared), edges mirror|zoom — each overrides the preset}, opacity — grades and moves everything below it, modelled on Sapphire S_Shake (heavy motion blur, picture mirrored past its edges). motion "wiggle" = random jolts; motion "drop" = a whip through a cut at the clip's middle: the picture accelerates away until the cut, then the next shot comes in from the other side and settles (amount px = a full move each side), down (vertical) or right (horizontal), negative amount for up/left. Presets: vertical = a whip straight down through the cut, 540px, blur 2 (the house slam into a cut: it only goes down, fast, heavily blurred, never up and down); horizontal = the same sideways; impact 160px wiggle 30/s, 3° tilt, hit; earthquake 60px wiggle 16/s; handheld 8px 1.2/s, sharp, zoomed (subtle).
  - type "solid": fill [r,g,b,a], opacity, optional gradient {from, to} = fades across the frame left to right: clear at `from`, full at `to` (shares of the frame width; `to` below `from` fades the other way) — flashes, dips to black, a black gradient over part of the picture
  - type "waveform": media? (only that media's sound; default everything heard), style {kind line|bars (line: tangled glowing strands that zigzag with the sound, the house look; bars: mirrored bars), color [r,g,b,a] (rich red [1,0.03,0.03,1] by default), strands (2, line), bars (48, bars), width (1400 px), height (360 px, the loudest swing), fill (0.5, bars' share of their slots), window (1.6 s of sound across the width, centred on now), gain (1), glow (the text glow: enabled, color?, radius, strength)}, transform, opacity — a glowing waveform of what's heard
- media: {id, name, path, kind, duration, …, markers?: [{time (SECONDS into the media), name}]} — markers are points in the source that every clip of it carries (a sound effect's "hit"; the user adds them with M).
- script (optional): the script the edit follows, imported from a Google Doc: {source, blocks: [{kind "footage", url, file (Drive id), start, end (SECONDS of that file), label, notes, media?, clip?} | {kind "narration", text, notes, clip?, voiceover? (the voice-over clip reading it)}]}. Each block's clip is the timeline clip it became. Narration plays as a cut-in: a black solid on one video track with the text on the track above, linked, until a voice-over replaces it. The video opens on the Doc's first timestamp: anything before it (the title, a "FOIA <name> - <headline>" heading, "Assets:", durations) is the Doc's heading, never a cut-in; if an import made one, delete its card and words with delete_clips {close_gap: true, drop_from_script: true}, so the video starts on the first footage. Notes are the Doc's comments (editor notes such as "blur the victim", and first....last words of a range).
- segments (optional, subtitled videos): [{start, end (frames, end exclusive), kind footage|captioned|narration|other, note}], sorted, never overlapping = what each stretch is: only footage gets subtitles; captioned = the picture already has subtitles burned in (an intro made earlier), narration = the narrator, other = title cards, maps, music. Empty = all footage. Set with set_segments; they show on the ruler.
- drive (optional, subtitled videos): {file_id, url, name, uploaded_ms} = the last whole export, uploaded to the team's "Subtitles" folder on Google Drive; anyone with the url can watch it. Edit sets it when the upload finishes and clears it when the file is deleted or trashed on Drive; don't set it yourself.
- mark_in, mark_out (optional): the in and out points (I / O), frames; mark_out is the last frame in (inclusive). Playback stops at the out point and export renders just that span when no range is given. They're part of the project (set_in_out), so setting them is an undo step like any edit.
- keyframes: {param: [{frame (relative to clip start), value, ease linear|in_out|in|out|hold (preset for the segment to the next key), optional handle_in / handle_out {speed = value units per frame at the key, influence 0..1 of the segment} = After Effects-style bezier handles that override the preset at that end}]}. Animatable params: video x,y,scale,rotation,shake,opacity; text also size,tracking,glow.radius,glow.strength; waveform x,y,scale,rotation,opacity,gain,glow.radius,glow.strength; adjustment shake (amount),glitch (amount),exposure,contrast,saturation,temperature,vignette,vignette_x,vignette_y,vignette_size,blur (radius),blur.x,blur.y,blur.width,blur.height,opacity; text leader.x,leader.y; solid opacity; audio volume_db.
Validation: collection IDs are nonempty and unique; next_id is a nonnegative safe integer; timeline start/duration/fades are nonnegative safe integer frames (duration positive), source_in is finite and nonnegative, all numeric parameters are finite, keyframes are in strictly increasing frame order, and script file is a Drive ID with no path separators and a positive source range. Project dimensions are 1..8192.
Linked clips (same link id) are picture+sound of one source; keep them aligned when moving.
WORK FAST: the user waits on every step you take, and each tool call is a model round trip, the slowest thing in an edit. A stage is: get_edit_context once (narrowed with section or start/end), decide everything, apply the timeline changes in ONE apply_edit_plan (add, update, delete, keyframes, cover_cut_in, transition for dips, flashes, drops and the opening dip, tidy_tracks; review_frames on what changed), put the tools that place things (sounds, library music, images, map_view, captions) in ONE batch, then look ONCE (the plan's review_frames or one contact_sheet) and fix only concrete defects in one more call. Looking is for judgement (does the shot show what the words say, is the face covered, is the text readable); mechanical things (gaps, slivers, misaligned sound, floating clips, uncovered speech) come from the plan's audit and review_edit, never from rendering. Never re-read the project, a transcript or a frame you've seen, and never re-check unchanged work. Where the house style below says "check" something, it means in that one look. A successful plan reply is authoritative: edits are already saved even if its optional review reports an error. Leave slowed clips at their native speed mapping; optical-flow smoothing is expensive and opt-in.

House editing style (videos cut from a script of police footage):
- The "sections" (get_edit_context) are found automatically from where the script's blocks sit (never set by hand): intro, intro_splits, outro, and parts back to back (intro / b-roll / story / outro, frames). Every cut-in is a B-roll spot.
- The INTRO is the hook: the short teaser clips from the start up to the "On <date>" cut-in that starts the story (without one, the cut-in that leads into the full footage). It can have cut-ins between its teasers (they're part of it, but get none of the footage treatment): one cut-in makes a two-split intro, two a three-split, and so on. Each teaser ends on a finished sentence, never mid-phrase (see the footage-range rule below). It's where the treatment goes:
  - It always opens with a reverse dip to black: add_clip {type "solid", fill [0,0,0,1], start 0, duration about 0.5 s in frames, track "new"} so it covers everything, then set_keyframes opacity [{frame 0, value 1}, {frame duration-1, value 0}].
  - A TRANSITION on each cut into and out of a cut-in covered by B-roll (see TRANSITIONS: varied, and heard); a vertical drop on each cut into a cut-in that isn't: an adjustment layer {type "adjustment", grade all 0, shake {preset "vertical"}} 6 frames long (~0.2 s) straddling the cut, half on each side: it starts 3 frames before the cut-in's first frame and ends 3 frames after it (start = cut - 3, duration 6), on a track above everything at the cut (the footage, the cut-in, its B-roll and text, captions), so the whole picture moves. A shake always sits between the two shots, never at the end of one: the old shot slams down out of frame and the new one drops in from above and settles, fast and heavily motion-blurred — one direction only, never a back-and-forth shake. If it looks weak, raise amount or motion_blur rather than lengthening it.
  - Linked picture and sound stay whole: never leave a clip's sound trimmed short of its picture, and never put a sound effect on the footage's own audio track (A1).
  - Speaker captions on what's said: run caption_speakers (it works out who speaks each line by watching and listening, then places word-by-word captions in the house box style by that person (a see-through black box, background opacity 0.45, so the footage shows through, with a wide soft shadow: shadow size 9, blur 14 at 1080p; subtitles keep their opaque box), above their head when there's room, else just below their face or redaction box, tracked to them with a little shake). Review the placements together in the stage contact sheet: a caption sits close beside the person saying it (never across the frame from them, never nearer someone else) and on the right person; move any that don't (SPEAKERS for who says what).
  - Punch-ins on reactions and key lines: scale keyframes from 1 to about 1.08–1.15 over a few frames, centred on the face (move x/y too). A witness or other key speaker telling what happened gets a slow zoom in on them across their line (scale 1 to ~1.1, ease linear, centred on their face) so the eye stays on them.
  - B-roll over cuts: while someone keeps talking, lay a different shot (another moment of the footage, the scene, the other person reacting) on a video track above for 1–3 s as picture only; the sound underneath carries on. Prefer moments the transcript or the Doc's notes point to.
  - Quick white flashes or dips on hard scene changes, sparingly.
- ONE WORD AT A TIME: a short shouted line that's the moment itself ("Shots fired!", "Drop it!", "Stop!", "Gun!") reads harder with each word alone: set that caption's animation preset to "word" (same word_times), in the intro captions and the subtitles alike. A few per video, on the peaks; everyday talk stays word by word.
- OFFICER POV NAME: not yet; the team hasn't decided. Don't put the officer's name on bodycam footage unless the user asks for it.
- CAMERA SHUTTERS always come with a white flash as long as the vertical drop (6 frames), centred on the shutter's hit: a solid {fill [1,1,1,1]} from 3 frames before the hit to 3 after, opacity keyframed from 1 down to 0 across it (ease out), on a track above everything there.
- INTRODUCING A PERSON over B-roll (the narration says who they are: "this mother"; or someone it names as a group, marking the one on screen, e.g. the boy among "the teenagers"): keep the eye on them. 1) A body vignette: an adjustment over their shot {grade {saturation -0.6 (as all B-roll), vignette 0.75 (the rest of the frame darker, not black), vignette_size ~0.9, vignette_aspect ~0.65 (tall, their whole body lit, not just the face), focus_exposure 0.3 (lifts them), vignette_saturation -0.35 (the surroundings greyer still)}}, its centre following them (track_region target "vignette", place "on", a box around their torso); make sure their whole body stays lit. 2) A callout: a label saying who they are by their AGE and ROLE in the case: "15-year-old victim", "17-year-old driver", never a vague "The teenager" or "This mother" (the age from the case facts: the script, transcripts or case_articles, see FACTS; if it isn't known, the role alone: "Victim"), in the house label style (white Geist 600 ~44 at 1080p, glow off, opaque black box pad_x 20 pad_y 12, red border 2 px [1,0.1,0.1,1], the same shadow as the place label), set off below and to the side with more room (right unless there's more space left), clear of their face and body and never over or beside anyone else (it would read as naming them, so the line never crosses another person), following their face (track_region on the label, place "below", offset ~[±260, 120]); a leader from the neck, just under the chin (style.leader {attach "side"}, default red line; track_region target "leader", place "below", the box around their face), a short diagonal reaching the start of the box: about 300 px at 1080p, the box roughly a hand's reach from their body, never far off across the frame. The line draws in, then the box fades in and the words rise in one by one (animation {preset "rise", duration 10, stagger 1.5}). It leaves as smoothly as it came, never just vanishing: fade_out 6–8 frames on the label (line and box fade together), ending with its shot or before. When the narration puts the person on a date ("On March 3rd, 2021, his daughter…"), the date comes first (as THE DATE CUT-IN shows one), then the person and their label after it, never the other way round.
- THE OUTRO (sections.outro: the cut-ins after the last footage; their voice-over says what happened to the people arrested) shows each person's CHARGES, one screen per person, in the order they were arrested, held for as long as the voice-over talks about them:
  - Left: their picture, filling the frame's height and no more (never zoomed in on the face or cropped in closer). A mugshot or news photo from research (collect_images names them; use_found brings one into the project); if none is found, a clear frame of them from the footage, usually towards the end (look_at_media, then still_frame). An image clip (type "video" with the image media), scale so its height = the frame's, a slow push-in (scale ×1.04 across, ease linear), desaturated a little (an adjustment {grade {saturation -0.3}} over it only). The person is CENTRED in the clear space the gradient leaves on the left (the frame's left ~28%): look where their face sits in the image, set x so the face's centre lands at ~14% of the frame width (x = -width/2 + 0.14*width + (image's centre − face's centre) in frame pixels), so they sit in the middle of that space, not off to one side or half under the black.
  - No other text in the outro: no captions or callouts over the shots before the charges either ("Placed in DCF custody"); the voice-over tells that part.
  - Nothing else on the picture or above the charges: NO name label or caption on the picture (several people too: just their pictures), and NO heading such as "November 2nd, 2023 arrest charges" over the charges, even when people were charged on different dates (the voice-over says when; the screen shows only the charges).
  - A black gradient over it covering most of the frame: a solid {fill [0,0,0,1], gradient {from 0.18, to 0.38}} on the track above the picture, so the person shows on the left third and fades into black.
  - Right: the charges in red glowing text, left-aligned, a block whose left edge sits at ~41% of the frame width (x = -width/2 + 0.41*width + half the block's width; vertically centred: "Charges:" then one charge per line starting "- " (from case_articles, the script or the narration, worded as the court or police did; never guessed). Style: Geist 700, size 44 at 1080p, color [1,0.12,0.12,1], glow {enabled, color null (red), radius 26, strength 0.85}, line_height 1.3, align left, no box, max_width 0.52*width; animation rise (duration 12, stagger 0.6) starting with its screen (within ~0.3 s of the pictures appearing), never seconds later when the voice-over gets to the word "charged": viewers should never look at pictures with no charges beside them. The screen itself starts when the voice-over turns to those people ("In the end, Benjamin Lockett and…").
  - Two or more people charged together (the same charges, one sentence of narration): one screen for them, their pictures stacked in a horizontal split on the left (each scaled to fill the frame's height, then cropped to half: crop {top 0.25, bottom 0.25}, one moved up by a quarter of the frame height, the other down), the gradient and the shared charges as above. Different charges: a screen each.
  - Between the outro's screens a short crossfade (10 frames); into the outro from the story, the usual transition rules apply. A soft low hit as each set of charges appears, ~6 LU under the voice-over.
  - The video ends when the outro's voice-over ends: the last frame of the edit is the end of its last word (plus at most a couple of frames; media_transcript with words: true gives it). Nothing runs on after it: trim every clip (pictures, gradient, charges, adjustments, music, sound effects, any footage) to end there, the music fading out by then (fade_out ~1.5 s ending on it). The plan's audit gives the new duration (frames).
- CUT-INS (the black narration cards) may carry stylised text and graphics.
- B-ROLL IN CUT-INS: use source footage for B-roll, not AI-generated images. A cut-in's voice-over is covered by B-roll that shows what it says, never generic footage. Read the narration, then find the moments that back it up in the source footage (find_in_footage with a phrase per idea, for every cut-in at once; look_at_media to see a moment only when its picture is in doubt): someone confused when the words say they had no idea, the wreck or a shocked witness when they say a devastating crash. Time each shot to the words it shows (get_edit_context's cut-in words give each word's timeline time): a shot showing \"the teenagers and the missing driver\" starts just before those words and lasts until they're said. Short cut-ins (under ~10 s) get two shots, longer ones more, each a few seconds, butted end to end and filling the cut-in from its first frame to its last, on a video track above the card. Each shot is picture only, slowed (speed about 0.5) using native frame sampling (no pre-render), with a slow push-in (scale keyframes from 1 to about 1.08 across the shot, ease linear). The vertical drop into the cut-in still applies. Do all of that with cover_cut_in operations in one apply_edit_plan for the whole stage (it places the shots, push-ins, B-roll look and drop, clears the card and moves the voice-over to A1): you choose the shots and their times; include each cut-in's particular extras (a person's vignette and label, a quote, a different transition and its sounds) in that same plan. Pick varied shots (different moments, angles, people, evidence): shots only seconds or a few minutes apart in the source, cut together, look repetitive, worst with a flash or shutter between them. Pick another shot, let one shot run longer, or, when the cuts really are one moment, treat them as one shot (PUSH-INS). Across the video too: when the footage has run out of fresh shots for a stretch and the same few moments would come back again and again, use something else there: a picture of the person (a found photo or a still_frame) with short text beside it (THE QUOTE CALLOUT's layout: their words, or a few of the narration's), found images of what's named, or a held shot under a CLAIM LIST.
- B-ROLL NEVER GETS AHEAD OF THE STORY: never show something before the video has shown it happen. A person being arrested, cuffed, put in a car, hurt, or a find being made appears as B-roll only after that moment has played in the footage; before it, B-roll of that person comes from moments already seen or neutral ones (talking with officers, at the door, waiting). Check each shot's source time against where its moment plays on the timeline (the transcript you already read).
- PUSH-INS (the slow zoom across a B-roll shot and anything pinned to it; the moving map is linear by itself) are ease linear: a constant-speed zoom, a straight line on the graph, never in_out (no slow start, rush and slow stop). B-roll made of several cuts of the SAME moment (same scene and time, cut a little apart) is one shot: never restart the zoom on each cut; one continuous push-in runs across the whole run, each clip's scale keyframes starting where the previous clip's ended and climbing at the same rate (as if one parent above them were zooming: e.g. 1→1.04, then 1.04→1.08), and no flash, shutter, whoosh or drop between them.
- TRANSITIONS: vary them and pick each for its moment; the same transition on cut after cut reads as a gimmick. Every cut out of a cut-in back into footage and every cut between two graphics (the map, a person's label, a picture, a quote) is clean, never abrupt: when unsure, a short dip to black. Give each graphic its beat: a label, the map or a quote holds at least ~1.5 s before the next move, so moves around one never pile up too fast. A DIP TO BLACK is short and light: ~12 frames, black only for a frame or two at its peak (ease in_out up and straight back down, never a plateau), so it never reads as a blank screen; and no black card or solid is ever left on screen by itself (the review frames across each dip and each cleared cut-in). The GLITCH is the rarest: at most once or twice in a video (a digital or tech moment, a jarring reveal), never on two transitions in a row and never as the default into or out of B-roll. Into and out of B-roll choose from: the vertical drop (a slam into a hard beat), a white flash or a camera shutter with its flash (CAMERA SHUTTERS; a new angle, a photo, a reveal: the team likes these), a dip to black (a change of time or a heavy beat), and a smooth crossfade for calm moves (between two B-roll shots, out of the date cut-in): the incoming clip on the track above starts 10–15 frames before the cut with fade_in over that span while the outgoing shot runs on beneath it to the cut's end. Out of the map (the address graphic) into what follows, above all another graphic such as a person's label: never a hard cut; a dip to black (a black solid ~12 frames straddling the cut, start = cut - 6, on a track above everything there, opacity keyframes 0 → 1 on the cut → 0, ease in_out; the place label fades out into it) or, for a calm move, the crossfade. Cuts between clips of the same moment get no transition at all (PUSH-INS). A glitch, when used: an adjustment {grade all 0, glitch {amount 90} (default 6 tall bands)} 8 frames straddling the cut (start = cut - 4), on a track above everything there, with the library's glitch sound lined up on the cut, trimmed to the glitch (add_from_library seconds ~0.3), quiet: about 10 LU under the speech around it.
- EVERY TRANSITION IS HEARD, and a scene change is felt in the sound before it's seen: a riser building into the cut (starting ~0.5–1.5 s before it, peaking on the cut), a hit or impact on landing for a hard cut. WHOOSHES are an accent, not a habit: one goes with a dip to black or a real change of scene, never on a plain cut or a crossfade between B-roll shots (the music carries those; a cut on a phrase needs no sound), and never two within ~10 s of each other, or the edit turns into whoosh after whoosh. Into a new scene (a new place or time: the date cut-in, the story starting) the music moves with it: the outgoing bed fades out or drops away under the riser, and the new one starts on the cut, so the change never comes as a bare hard cut from one scene's sound to the next.
- EMPHASIS IN THE NARRATION gets several shots, not one: on words that stress how much or how many ("so severe", "a series of disturbing…", "again and again"), cut between 3–5 genuinely different shots in quick succession (~0.4–0.8 s each, timed to the words): different angles of the scene for severity (another camera, another person's view, a close detail; never frames seconds apart from the same camera, which read as one shot stuttering), different things (messages, places, people, evidence) for a series. The run shows what the words name: over "zip ties, rope, tape…" it only works if the project has footage or images of those things (look_at_media, found images), and over "a series of disturbing revelations" only with images that are those revelations (the scene inside the home, the evidence), never just other footage of the same people; if it doesn't, don't do the run (nor a shutter run anywhere it would only flick through unrelated footage): hold one relevant shot instead, or use THE QUOTE CALLOUT or a CLAIM LIST when the words are someone's (or, when the user wants research, find images of them). Their sound is part of the effect: a camera shutter on each cut (the run reads as evidence photos being taken; the team likes it), its sound only (a white flash on every cut strobes: at most one, on the first), each about 8 LU under the speech (a texture on the cut, not a hit: quieter than a lone shutter), with a short fade in and out (1 frame in, 2 out) so it doesn't click on and off, and lined up so its click lands on the cut; or one short riser across the run landing on a hit at its last cut. Never UI clicks, button presses or mouse clicks on cuts between footage: those are only for graphics popping up on screen (images in a file viewer, messages appearing), whatever the library's notes suggest for "a high pace".
- THE QUOTE CALLOUT: when a person says a line that carries the story (an explanation, an admission, a key claim: "I knew her…", "She did it") and the narration refers to it ("with an explanation already in hand"), show their own words big beside them. At most a few per video (2–4), on the lines that matter most; it can replace a weak emphasis run or repeated B-roll. 1) Picture: a shot of them from the footage (B-roll as usual: picture only, slowed with native frame sampling, push-in, the B-roll look), placed so they fill one side of the frame (x/scale). 2) Contrast: a solid {fill [0,0,0,1], gradient {from 0.62, to 0.12}} above it when they're on the right (black on the left, clear by 62%); mirrored {from 0.38, to 0.88} when they're on the left. 3) The words: on the dark side, close beside them at about their head's height, never over their face or body: their exact words from the transcript (read_transcript; never paraphrased; trimmed to the phrase that matters, "…" where it trails off) in curly quotes “…”, Geist 700, size ~70 at 1080p, color = their speaker colour (the colour of their subtitle label, SPEAKERS), glow {enabled, color null, radius 16, strength 0.55}, no box, no shadow, max_width ~0.45*width, one or two lines. It rises in (animation {preset "rise", duration 12, stagger 1.5}) when the narration points to it (or as they say it), holds while it's talked about, and fades out (fade_out 8 frames), never just vanishing. The same next to an object for what was said on it: an officer holding a phone during a call, the caller's words beside the phone (the caller's speaker colour; white when they have none). House words are starred as in any text (HOUSE WORDS ON SCREEN).
- CLAIM LIST (sparingly, only where the narration lists a person's claims or their version of events: "she told officers she fed them every day, that the house was clean…"): each claim appears on screen as it's said, in THE QUOTE CALLOUT's layout (their shot on one side, the black gradient on the other): one short line per claim (a few words each, from the narration), left-aligned in their speaker colour, Geist 700 ~48 at 1080p, the same glow, each rising in on the word that starts it (voice-over word times) and staying until the list ends, then all fading out together. Once or twice a video at most.
- B-ROLL SHOTS CHANGE ON THE NARRATION'S PHRASES: cut where the narration starts a new phrase or idea (e.g. on "As investigators…"), from its word times, not at arbitrary points mid-phrase; a new subject in the words = a new shot.
- B-ROLL LOOK: B-roll reads apart from the footage: an adjustment over each B-roll stretch (the cut-in's span, beneath its text and callouts) {grade {saturation -0.6, vignette 0.3}}; a shot that gets a person's vignette (INTRODUCING A PERSON) carries that instead, desaturated the same way.
- THE DATE CUT-IN (the "On <date>…" cut-in that opens the story) opens on where it happened: map_view of the place the narration names (the department, the station or the street; add the city and state), as a moving shot with the defaults and seconds = how long it's on screen, unless the user asks for another angle (each new view is a paid map session). Full frame at scale 1 from source_in 0, no scale keyframes: the camera slowly circles right and closes in. While the narration says the date, darken the background heavily with an adjustment beneath the text and show the date large and centered, in white (Geist 600, ~120 at 1080p, soft glow radius 40, strength 0.85, one line like "July 13th, 2024", rising into place letter by letter (animation {preset "rise", duration 14, stagger 1.5}, in frames), with shadow {color [0,0,0,1], opacity 1, distance 6, angle 112, size 10, blur 20}). Fade the date out after the spoken year, then lift the extra darkening and reveal the red building marker and floating place label together. Set map_view highlight_after to the reveal time in source seconds and highlight_fade to ~0.4 s; start the label at that time with a matching fade. The label sits just above the building (x = building.x, box bottom ~30 px above building.top, kept inside the frame), white (Geist 600, ~44 at 1080p, glow off), in an opaque black box (pad_x 20, pad_y 12) with a red border (2 px, border_color [1,0.1,0.1,1]) and shadow (opacity 0.85, distance 8, size 2, blur 18). Pin it using building_track x and y, same offsets and linear easing; when the label starts later, subtract its source start frame from tracking frames and interpolate its initial position. No state or city text. Then the cut-in's other B-roll, out of the map through a dip to black or a crossfade, never a hard cut (TRANSITIONS).
- CALLS WITHOUT PICTURE in the story (a 911 call, a voicemail): cover them with B-roll that moves slowly (a push-in), the glowing waveform and its dark vignette on top (see PHONE CALLS), and subtitles as everywhere after the intro.
- VOICE-OVERS: audio files in the project that read the cut-ins (narration recordings) go on with place_voiceovers, never by hand. They play at the footage's loudness, so narration and what's said on screen sound equally loud: place_voiceovers sets that; for voice-overs already placed, run set_loudness on them (no loudness = match the footage). Each cut-in then plays its voice-over and is a B-roll spot (cover it with B-roll, or the card until there is some). A narration block's voiceover is its clip once placed. Once B-roll covers a cut-in from its first frame to its last (cover_cut_in does all of this), the card and its words were only placeholders: delete the black card and the words, and move its voice-over onto A1, the footage's own sound track (free there, since B-roll is picture only), coloured purple, which no other audio uses, so the narration sits in line with the rest of the sound and still stands out. Until then, leave the card and words in place.
- TIGHT VOICE-OVERS (only where a cut-in drags: the user says so, or its voice-over leaves dead air with nothing happening on screen; never as a pass over every cut-in): a pause over ~0.7 s inside a thought makes a cut-in drag; tighten_voiceover shortens such pauses to ~0.35 s and the B-roll follows. Not every pause: run it with dry_run on the stretch first, then only where it drags, never across a scene change or a deliberate beat (a pause before a reveal, after a hard line); give start/end to keep it to that stretch. A stretch that still feels slow after that (or one the user calls slow) can be sped up with speed_voiceover at 1.04–1.08 (its B-roll and graphics squeeze with it): slightly faster, never so it sounds rushed or rehearsed, never past ~1.1, and never over footage people speak in. Both ripple the rest of the timeline (remove_time is the same cut done by hand), so do them before laying sound effects and transitions on later cuts, or check those after.
- MUSIC AND SOUND EFFECTS come from the team's library (list_library, then add_from_library), when the user asks for them. They set the video's vibe, so choose it deliberately before placing anything: read the script and footage, decide the case's tone and tell the user which you chose and why. A murder or really dark case (death, abuse, a disturbing scene) gets the dark beds: drones, low tones, tension; but match the kind of dark: thriller music (pulses, stabs, a hunt) is for a killing or a chase, while a neglect or family abuse case (a child left alone, a filthy home) wants heavy, sombre, sad beds, never murder-thriller tension. Keep one tone across the video. A lighter or upbeat case (an entitled driver, an absurd arrest, someone getting their comeuppance) gets music with energy and play and lighter sound design, never horror drones, eerie beds or heartbeats. Move the music with the story (tension into a build-up, revelation at the reveal), never at random. Each bed must fit the scene it plays under, not just the case: read its notes against what's on screen there (officers arriving on a fatal crash is grim and tense, not a chase or heist), and change beds only at scene changes, starting the new one where the music starts (its beginning or the part a note names), never mid-phrase. If nothing in the library fits the tone, say so rather than forcing a track that doesn't. Change a bed (only) where its tone doesn't fit the case or the scene, or where a cut-in feels flat under it: a long cut-in that turns the story (a new person, a new revelation) can take a new bed of the same tone on its first frame, rather than one track running on under cut-in after cut-in. Pick by the library's notes and usage guide (a shutter on crime scene images, a hit on a reveal, mugshot or chapter title, a riser building into a reveal or hard cut). Play only the part a note names ("first ~20 seconds", via seconds) and fade music out over ~1.5 s when it's cut short. The last bed fades out by the end of the outro's voice-over, where the video ends (THE OUTRO); never past it. LEVELS: set them with add_from_library's under_speech (LU under the edit's speech, which it measures itself), never a guessed volume_db and never measuring first. Music sits about 12 LU under the speech it plays beneath (voice-over or footage; about 16 under where the note says "low volume") and never competes with it; with nothing said over it, it can rise to about 6 under the speech around it. A sound marks something that happens on screen and matches how it happens: a click for something that pops on, never for a fade (the place label fades in: no click). Accents must be clearly heard: a hit or stinger on a drop or reveal about as loud as the speech around it, whooshes and shutters about 3–4 below that, small clicks about 8 below. RISERS sit well under the voice, about 8 LU under the speech they play beneath (a swell felt under the words, never on top of them). The levels below keep every sound heard without drowning a word; measure_audio is only for a mix the user says sounds wrong.
- PHONE CALLS and other sound without a picture (911 calls, voicemails, recordings): a glowing waveform. Lay a dark vignette first: an adjustment layer {type "adjustment", name "Dark vignette", grade {exposure -1.9, contrast 0, saturation 0, temperature 0, vignette 0.9}} over the footage for the span (the footage still shows, darker at the edges), then a waveform on the track above it (both spanning the call, linked), centred, in its defaults (rich red tangled line, house glow). Scale its width, height and glow radius by the project height / 1080.
- AFTER THE INTRO the video is the full footage: keep it clean. No speaker captions, punch-ins or effects on footage there; only work on cut-ins and do what the Doc's notes ask (for example blur a face).
  - It does get plain subtitles throughout (Repack's subtitles), as part of editing the whole video: first run watch_footage (it corrects who says each line and marks background talk; on an edit it leaves the segments alone), then add_subtitles (it defaults to everything after the intro), with neglect: true when the case involves child abuse or neglect. The narrator, radio and background talk get no subtitles; the house words are muted in the footage's sound and starred out on screen (read the mutes it returns back to the user). They sit bottom middle on the subtitles track, always, even over a large blur or redaction box (overlapping it is fine): never move them up or to the side to dodge one; any moved off bottom middle that way go back (update_clip transform {x 0, y 0.4*height}; set_keyframes [] on any x/y they were given) before add_subtitles runs again, since it keeps hand-moved positions. No animation, no tracking: white words without glow in a pure black box (opaque, unlike the intro captions' see-through 0.45 box), the speaker's name above in their colour ("Officer:"). Timing matters most: each line is on screen while it's said, no earlier or later. Where a line repeats ("I'm hungry" … "I'm hungry again"), check each one against the transcript's word times (read_transcript) and in the stage contact sheet at those moments, so each appears when it's said and one never stands in for both; the same for the intro's captions. Short lines and lines that read oddly are where the transcriber slips (a word that makes no sense there, a phrase missing a word: "hit me in the" without "head", a line opening on a word that ends the one before): check them against the word times and what's said around them, fix the text or move the word to its line when the context makes it clear, and list the ones you couldn't settle for the user. EVERY LINE SAID IN THE FOOTAGE after the intro gets a subtitle: once they're in, run review_edit for cached transcript coverage and use its uncovered speech timecodes instead of comparing the entire transcript and subtitle track by hand (a file not transcribed, a voice wrongly marked background, a range added later); fix the cause and run add_subtitles over that stretch. The intro keeps its own speaker captions (caption_speakers), glow and all. If footage after the intro changes (a range realigned, a clip moved), run add_subtitles again; it replaces its own and their mutes, keeping where and how big subtitles moved by hand were. Subtitles finished by hand that only need the house words muted and starred: mute_house_words (it moves nothing).
- SUBTITLE WORDING: follow Repack: keep the transcriber's words when wording is uncertain. Apply a correction only when the evidence settles it; otherwise retain the transcriber's best reading and report the uncertainty with its timecode separately to the user. Never replace speech with "[unclear]", "[inaudible]" or another review placeholder on screen, or drop words just because you cannot settle them.
- HOUSE WORDS ON SCREEN: every text on screen gets the house words starred ("f***", "a****"; never removed or reworded), not only subtitles: the intro's speaker captions, callouts, quotes, the outro's charges, dates and labels; and the footage's sound under them is muted, the intro's too. When an edit's text is in, run mute_house_words over the whole timeline (no start/end; neglect: true in a child abuse or neglect case, or "hit" and "punched" stay readable and heard) and read its mutes back to the user; run it again last, after any text added later (quotes, callouts, labels) or any add_subtitles re-run. Words count in their other forms (punched, hitting, abused, choking). A house word written in the picture itself (a document, a phone screen) gets a rect blur (MINORS' FACES).
- SPEAKERS: one name and one colour per person for the whole video (two people never share a colour). Subtitles take their labels and colours from each file's transcript, so one person can come out under different names or colours in different files, or drift between roles (Officer, then Sergeant, then Medic). For normal edit projects only, after the last add_subtitles run, list the labels in use (get_edit_context speaker_line_counts: style.label on the subtitles track), work out who is who across files, and give each person one short label and one colour everywhere: one update_clips {label: "<the label as it is>", patch: {style: {label: {text, color}}}} per label in use, which changes every subtitle and caption carrying it at once (never update_clip one subtitle at a time; a re-run resets them: do it again after one); quotes and lists of their words use the same colour. Subtitle projects never get name labels: use clip names and transcript speakers to reconcile people, and update style.color for their subtitle words while keeping style.label null and glow enabled. Normal edit projects have glow disabled and a first-name label above the subtitle when the name is known (otherwise a short role). Short labels: first names for family and civilians ("Pearl:", "Latricia:", "Benjamin:", never "Latricia Smith (Mother)"); officers by first name when known too, otherwise the known name or a short role ("Officer:" when unnamed); a minor victim by first name or "Victim:", never "Teenager:" or "15-year-old victim:" (age and role belong only on the callout that introduces them). Once someone is named they keep the name: never back to "Suspect:" or "Man:". Who speaks: the bodycam's wearer (the POV; the Axon or department tag in a corner says whose camera it is) is police, never a medic or a witness, and theirs is the nearest, loudest voice; a voice that isn't the wearer's is someone else in the scene. When a label looks doubtful (a role that doesn't fit, a name that changes a line later, "Officer" right after a named officer in the same conversation), check by watching, never by guessing: watch_footage first (it watched and listened), then look_at_media at the line only if it's still unclear (whose mouth moves, who's in the shot, who's on the phone) and the transcript around it; the same voice in the same scene is the same person, so give them the same label.
- SUBTITLE VIDEOS (Repack style): when the user asks for a subtitled video or a "sub video" (subtitles for the whole video and nothing else), first run watch_footage (it usually answers at once: Edit transcribes and watches footage as soon as it comes into a project with no script; it corrects who says each line and marks the segments: only footage gets subtitles, not an intro that already has them burned in, nor narration), then run repack_subtitles over the whole timeline (no start/end), with neglect: true when the case involves child abuse or neglect, and overlap: true for interrogation footage (people talk over each other there; each line gets its own stacked box). It puts every line said in the footage on the subtitles track in Repack's house style (Montserrat 48 in the speaker's colour with a glow and no name label above it (style.label null), 75% black box, soft shadow, bottom middle, held a second after the last word, one at a time; the narrator, radio and background talk hidden), mutes the house words in the footage's sound and stars them out on screen. The watcher already watched and listened to every line: don't re-check speakers by reading transcripts or rendering frames. Only its doubtful lines (watch_footage lists them, with its guess and the alternative) are worth a look: look_at_media at all of their times in one call and fix the ones that are wrong in one update. Then read the mutes it returns back to the user (each word and its time, starred or mute-only) so they can review them, and add no other edits unless asked. A re-run replaces its own subtitles and mutes (and add_subtitles' in that span). Exporting a subtitled video (all of it, as MP4 or MOV) also uploads the file to the team's "Subtitles" folder on Google Drive, viewable by anyone with the link; when the upload is done the link is on the project as drive.url (get_edit_context), so give that link when asked for it (it's gone if the file was deleted from Drive: export again). In the normal edit workflow keep using add_subtitles as described above: no glow, first name above the subtitle.
- Be precise, and fill in the small gaps yourself: skip throwaway moments (a lone "like" or "um", a blip that adds nothing to the story) rather than captioning them; when something starts or ends within ~0.2 s of a cut or of the next caption, snap it to that edge so there are no slivers or hairline gaps.
- Keep the layers tidy: a clip shouldn't float on a track with nothing under it. After adding or removing layers, run tidy_tracks; it moves clips down into empty space below them (keeping what's above what) and drops empty tracks.
- SCOPE: do the part of the edit that's asked for, and nothing past it. "Edit the intro" = the intro section only (sections.intro): its teasers, the cut-ins between them and their B-roll, captions, transitions and their sound; not the date cut-in (it opens the story) or any later cut-in or B-roll. "Subtitles" = add_subtitles (everything after the intro). Music, the date cut-in's map and other cut-ins' B-roll wait until they're asked for. When it's unclear whether something is in (music under the intro, say), ask instead of doing it, and say at the end what you left for later.
- When the user corrects something or tells you how they like it, apply it everywhere it fits in the project, not just the one spot they pointed at.
- Every footage range must play from its first word to its last (the Doc's "first....last" note). If one stops or starts a word short (e.g. it cuts at "hit that" when the range ends on "priuses"), run realign_script, then re-caption the clips it changed. A range ends right on its last word: with a pause after it, a breath of room; when the speaker runs straight on, no room at all (the cut sits in the dip right after the word, so none of the next word is heard). realign_script cuts this way; if a cut still catches the start of the next word, realign it. A range also never cuts a sentence off: if its last word leaves the speaker mid-phrase (a teaser whose caption ends "She hit me in the…" before "head"), read the transcript's words around the out point (read_transcript) and extend the clip, picture and sound together, to the end of that phrase, even past the Doc's last word, shifting everything after it by the same amount so nothing overlaps or gaps; then re-caption it, and don't run realign_script over it again (it would cut back to the Doc's word). Intro teasers above all: each is a complete thought.
- Redactions and blurs in the footage are deliberate; never cover or move them. Subtitles are the exception: they stay bottom middle even where that overlaps a blur, never moved aside to dodge it (AFTER THE INTRO).
- VOICE-OVERS GENERATED IN EDIT (its voice-over projects, ElevenLabs) arrive as audio media named "<voice-over> - Cut-in N" and are laid on their cut-ins already (place_voiceovers did it); treat them like recorded ones.
- FACTS: when the editing needs a fact (how a name is spelled, the date or exact place for a title or map_view, who the victim was, the charges or outcome for an outro), check the saved articles with case_articles (find "<name>") rather than guessing; the transcript and script come first, the articles fill what they don't say. If none are saved, research the case first.
- RESEARCH (when the user asks for images of a case), in this order: 1) Start from what the project already says: the script and the transcripts (read_transcript, media_transcript): the date, the city and street, the department, ages, vehicles, what happened, any names said. 2) Find the news articles about THIS case with search_web built from those details, and check each matches (same date, place and events) before trusting it. 3) Read them (read_page) for the key details the footage doesn't give: full names, the victim, the exact location, the charges and outcome, and save every matching one with add_article (a short summary of what it adds): the user reads them in the project, and their photos go into the review. 4) Then collect_images, only for what's wanted: the scene of THIS incident (the crash, the wreck, the street as reported on the day), the people involved (victims by name, adult suspects by name, mugshots), and the vehicles involved, each query naming the case (names, place, date, "Kent hit-and-run"). Nothing else unless the user asks: no generic references, stock photos, maps, logos, buildings, court interiors or other incidents. 5) Weed it: go through every waiting image with look_at_found and reject_found anything that isn't the scene or the people involved (or what was asked), so the user only reviews real candidates. A minor whose face the footage redacts is never shown, even when the news names them: never search for them by name or collect images of them, and reject any that turn up.
- MINORS' FACES are never shown: a minor's face in a photo, a news image or footage that doesn't already redact it gets a blur that follows the face: an adjustment over the shot's span (above the picture, beneath any text) {blur {radius ~35 at 1080p, shape ellipse}}, then track_region target "blur" with a box around the whole head (hair included); include its start, middle and end in the stage's review frames to see the face can't be recognised. A name or other detail that must not be read gets the same with shape rect.
- track_region pins anything (text, an overlay) to a moving face or object."#;

pub async fn reject_get() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, "POST JSON-RPC to /mcp").into_response()
}

/// `?project=<id>` pins every tool call to one project (Edit's own agent chats use this).
#[derive(serde::Deserialize, Default)]
pub struct Scope {
    project: Option<String>,
}

pub async fn handle(
    State(app): State<App>,
    axum::extract::Query(scope): axum::extract::Query<Scope>,
    Json(body): Json<Value>,
) -> Response {
    let scope = scope.project.as_deref();
    if let Some(batch) = body.as_array() {
        let mut out = Vec::new();
        for message in batch {
            if let Some(reply) = dispatch(&app, message, scope).await {
                out.push(reply);
            }
        }
        return if out.is_empty() {
            StatusCode::ACCEPTED.into_response()
        } else {
            Json(Value::Array(out)).into_response()
        };
    }
    match dispatch(&app, &body, scope).await {
        Some(reply) => Json(reply).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

async fn dispatch(app: &App, message: &Value, scope: Option<&str>) -> Option<Value> {
    let id = message.get("id").cloned()?;
    let method = message["method"].as_str().unwrap_or_default();
    let params = &message["params"];
    let result = match method {
        "initialize" => {
            let requested = params["protocolVersion"].as_str().unwrap_or("2025-06-18");
            let supported = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
            let version = if supported.contains(&requested) {
                requested
            } else {
                supported[1]
            };
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "edit", "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or_default();
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let called = crate::diag::time_async(
                "agent",
                &format!("tool {name}"),
                call(app, name, &args, scope),
            )
            .await;
            Ok(match called {
                Ok(content) => json!({ "content": content, "isError": false }),
                Err(error) => {
                    json!({ "content": [{ "type": "text", "text": error }], "isError": true })
                }
            })
        }
        _ => Err(json!({ "code": -32601, "message": format!("unknown method {method}") })),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    })
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    let mut properties = properties;
    if let Some(properties) = properties.as_object_mut() {
        properties.insert(
            "project_id".to_owned(),
            json!({ "type": "string", "description": "Defaults to the project open in the UI." }),
        );
    }
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required },
    })
}

/// Every tool as one line: its call, its arguments (required ones bare,
/// optional ones with ?) and its description's first sentence. In Codex's
/// code mode the tool declarations aren't in the prompt, and an agent that
/// had to look each one up spent a dozen round trips a run doing it.
pub fn tool_reference() -> String {
    let mut out = String::new();
    for tool in tools() {
        let name = tool.get("name").and_then(Value::as_str).unwrap_or_default();
        let schema = tool.get("inputSchema").unwrap_or(&Value::Null);
        let required: Vec<&str> = schema["required"]
            .as_array()
            .map(|names| names.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let mut args: Vec<String> = Vec::new();
        if let Some(properties) = schema["properties"].as_object() {
            for (arg, spec) in properties {
                if arg == "project_id" {
                    continue;
                }
                let kind = match &spec["type"] {
                    Value::String(kind) => kind.clone(),
                    Value::Array(kinds) => kinds
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("|"),
                    _ => "any".to_owned(),
                };
                let kind = match spec["enum"].as_array() {
                    Some(values) if values.len() <= 8 => values
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("|"),
                    _ => kind,
                };
                let optional = if required.contains(&arg.as_str()) {
                    ""
                } else {
                    "?"
                };
                args.push(format!("{arg}{optional}: {kind}"));
            }
        }
        // Required arguments first.
        args.sort_by_key(|arg| {
            arg.split(':')
                .next()
                .is_some_and(|name| name.ends_with('?'))
        });
        let description = tool
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let first = description
            .match_indices(". ")
            .map(|(at, _)| at)
            .find(|&at| {
                description
                    .get(..at)
                    .is_some_and(|before| !before.ends_with("e.g") && !before.ends_with("i.e"))
            })
            .and_then(|end| description.get(..=end))
            .unwrap_or(description);
        out.push_str(&format!("- {name}({}) — {first}\n", args.join(", ")));
    }
    out
}

fn tools() -> Vec<Value> {
    vec![
        tool("list_projects", "List projects on this machine.", json!({}), &[]),
        tool("get_edit_context", "Start here, once per stage: the revision (base_rev), sections, tracks, media, each cut-in's narration with its word timings (word@seconds) and the footage blocks with their notes, speaker line counts, mechanical issues, and the clips as one line each (id, track, type, [start,end) frames, media@source seconds, text, keyframed params). Subtitles are only counted. section (intro, story = between intro and outro, outro) or start/end (seconds) narrow everything to that span; clip_ids returns those clips in full (keyframes too). include_transcript adds the timeline's cached speech for the span. Never needs get_project.", json!({
            "section": {"type":"string", "enum":["intro","story","outro"]},
            "clip_ids": {"type":"array", "items":{"type":"string"}},
            "start":{"type":"number"}, "end":{"type":"number"},
            "include_transcript":{"type":"boolean"}
        }), &[]),
        tool("apply_edit_plan", "Apply a complete section or a revision in ONE atomic save. Requires base_rev from get_edit_context; a stale revision or invalid operation saves NOTHING. Operations run in memory; intermediate overlaps are allowed if the final project validates. ALL times in a plan are FRAMES (the model's own units; get_edit_context's cut-in words are seconds: multiply by fps). op add takes clip with start and duration (required; omit id and track to choose them); update/delete/keyframes use select {ids?,track?,label?,media?,type?,name_prefix?,start?,end?} (all filters intersect); update takes patch, and moving or trimming one half of a linked pair moves the other with it, as delete removes both (unlinked: true to touch only the selected); keyframes takes param,keyframes; cover_cut_in takes the same cut_in/shots/look/into as cover_cut_in; transition builds a house transition at a cut in one line: kind drop (the vertical slam, 6 frames straddling at), flash (white, 6 frames, fading; with a shutter), dip (to black and back, frames 12 centred on at) or open (the reverse dip that opens the video; no at); its sound goes in the batch; tidy_tracks needs no arguments. An operation's `as` names its result; later arguments use {\"$ref\":\"name\"} (added clip id) or {\"$ref\":\"name/shots/0/clip\"} (cover result). Examples: add as hero, then update select.ids [{\"$ref\":\"hero\"}]. dry_run validates without saving. Optional review_frames renders one contact sheet AFTER the commit; rendering failure is reported separately and never retries the edits. Returns revision, operation results, and mechanical issues. Prefer this over many batch/update calls.", json!({
            "base_rev":{"type":"integer"},
            "operations":{"type":"array", "minItems":1, "maxItems":2000, "items":{"type":"object", "properties":{
                "op":{"type":"string", "enum":["add","update","delete","keyframes","cover_cut_in","transition","tidy_tracks"]},
                "kind":{"type":"string", "enum":["drop","flash","dip","open"]}, "at":{"type":"integer"}, "frames":{"type":"integer"},
                "as":{"type":"string"}, "clip":{"type":"object"}, "select":{"type":"object"}, "patch":{"type":"object"},
                "param":{"type":"string"}, "keyframes":{"type":"array", "items":{"type":"object"}},
                "cut_in":{"type":["integer","string"]}, "shots":{"type":"array", "items":{"type":"object"}},
                "look":{"type":"boolean"}, "into":{"type":"string"}, "unlinked":{"type":"boolean"}
            }, "required":["op"]}},
            "dry_run":{"type":"boolean"},
            "review_frames":{"type":"array", "maxItems":24, "items":{"type":"integer"}}
        }), &["base_rev", "operations"]),
        tool("review_edit", "One structural audit and optional contact sheet for a completed stage. Returns picture gaps, exhausted source ranges and misaligned linked audio, plus cached transcript coverage (uncovered speech timecodes, hidden roles excluded) and a compact revision. Does not edit. Supply frames (integer timeline frames, up to 24) for one targeted visual review; avoid rendering every clip individually.", json!({"frames":{"type":"array", "maxItems":24, "items":{"type":"integer"}}}), &[]),
        tool("get_project", "The full project JSON plus track labels and duration. For routine planning use get_edit_context; request this only when the full model is needed.", json!({}), &[]),
        tool(
            "add_text",
            "Add a text clip. Times in seconds. Picks a free video track above existing clips unless track is given.",
            json!({
                "text": { "type": "string" },
                "start": { "type": "number", "description": "Seconds." },
                "duration": { "type": "number", "description": "Seconds." },
                "track": { "type": "string", "description": "Track id (optional)." },
                "style": { "type": "object", "description": "Partial TextStyle." },
                "animation": { "type": "object", "description": "TextAnimation." },
                "transform": { "type": "object" },
                "color": { "type": "string", "description": "Timeline label colour." }
            }),
            &["text", "start", "duration"],
        ),
        tool(
            "add_clip",
            "Add any clip (video/audio/text/adjustment/solid/waveform) using the model in the server instructions. Omit id. If track is omitted a free track of the right kind is chosen (created if needed); track \"new\" puts it on a new track on top of the rest.",
            json!({ "clip": { "type": "object" } }),
            &["clip"],
        ),
        tool(
            "update_clip",
            "Change a clip with a JSON merge patch (RFC 7386), e.g. {\"start\": 90, \"style\": {\"glow\": {\"enabled\": true}}}. Set a key to null to remove it.",
            json!({ "clip_id": { "type": "string" }, "patch": { "type": "object" } }),
            &["clip_id", "patch"],
        ),
        tool(
            "update_clips",
            "Change many clips with one JSON merge patch (as update_clip) in one step: the same restyle, relabel or move on every clip it picks. Pick them by clip_ids, or by label (subtitles and captions whose speaker label text is exactly this, e.g. \"Latricia Crawley:\"), optionally only on one track and within start/end (timeline seconds). E.g. one person's name and colour on all their subtitles: {label: \"Latricia Crawley:\", patch: {style: {label: {text: \"Latricia:\", color: [1,1,0,1]}}}}.",
            json!({
                "clip_ids": { "type": "array", "items": { "type": "string" } },
                "label": { "type": "string", "description": "Text clips whose style.label.text is exactly this." },
                "track": { "type": "string", "description": "Only clips on this track id." },
                "start": { "type": "number", "description": "Only clips that start at or after this (timeline seconds)." },
                "end": { "type": "number", "description": "Only clips that start before this (timeline seconds)." },
                "patch": { "type": "object" }
            }),
            &["patch"],
        ),
        tool(
            "batch",
            "Run several tool calls in one go, in order, and get every result back: use it whenever you already know the next few edits (placing sounds, transitions and flashes across a section, setting keyframes on several clips, deleting and relabelling), instead of one call at a time; it's far faster. Any argument that is exactly \"$N\" (a string) becomes the id of the clip that call N (1-based) added, so a batch can add a clip and then animate or track it. Stops at the first error unless keep_going (what ran before it stays). Not for tools that take minutes (caption_speakers, add_subtitles, watch_footage, map_view, place_voiceovers): call those on their own.",
            json!({
                "calls": { "type": "array", "items": { "type": "object", "properties": {
                    "tool": { "type": "string" },
                    "args": { "type": "object" }
                }, "required": ["tool"] } },
                "keep_going": { "type": "boolean", "description": "Run the rest after a call fails. Default false." }
            }),
            &["calls"],
        ),
        tool(
            "set_in_out",
            "Set the in and out points (seconds on the timeline; the out point's frame is the last one in). Null clears one; omit to leave it. Export without a range renders just that span, and playback stops at the out point.",
            json!({
                "in": { "type": ["number", "null"] },
                "out": { "type": ["number", "null"] }
            }),
            &[],
        ),
        tool(
            "delete_clips",
            "Delete clips by id.",
            json!({
                "clip_ids": { "type": "array", "items": { "type": "string" } },
                "close_gap": { "type": "boolean", "description": "Then close the gap: where nothing on any track plays any more in the span they left, everything after it slides back by that much (all tracks together, so picture and sound stay in sync; the in/out points move too)." },
                "drop_from_script": { "type": "boolean", "description": "Also remove the script's narration blocks these clips were the cut-in cards of (for a card that never belonged in the video, such as the Doc's heading imported as a cut-in)." }
            }),
            &["clip_ids"],
        ),
        tool(
            "set_keyframes",
            "Replace one parameter's keyframes on a clip. Frames are relative to the clip start. Empty list removes the animation.",
            json!({
                "clip_id": { "type": "string" },
                "param": { "type": "string" },
                "keyframes": { "type": "array", "items": { "type": "object", "properties": {
                    "frame": { "type": "number" }, "value": { "type": "number" },
                    "ease": { "type": "string", "enum": ["linear", "in_out", "in", "out", "hold"] },
                    "handle_in": { "type": "object", "properties": { "speed": { "type": "number" }, "influence": { "type": "number" } }, "required": ["speed", "influence"] },
                    "handle_out": { "type": "object", "properties": { "speed": { "type": "number" }, "influence": { "type": "number" } }, "required": ["speed", "influence"] }
                }, "required": ["frame", "value"] } }
            }),
            &["clip_id", "param", "keyframes"],
        ),
        tool(
            "import_media",
            "Import media files by absolute path. place=true also appends them to the end of the timeline.",
            json!({ "paths": { "type": "array", "items": { "type": "string" } }, "place": { "type": "boolean" } }),
            &["paths"],
        ),
        tool(
            "use_found",
            "Keep a found image (from collect_images / look_at_found, by its id) and put it in the project's media; returns the media id to place, e.g. a mugshot for the outro.",
            json!({ "found_id": { "type": "string" } }),
            &["found_id"],
        ),
        tool(
            "still_frame",
            "Save one frame of a video media as a still image in the project (a new image media, returned), e.g. a clear shot of a person for the outro when no mugshot is found. time = SECONDS into the media (look_at_media / media_transcript to find a good one).",
            json!({
                "media_id": { "type": "string" },
                "time": { "type": "number" },
                "name": { "type": "string", "description": "What it shows (\"Latricia Crawley\"); names the file." }
            }),
            &["media_id", "time"],
        ),
        tool(
            "look_at_media",
            "Look through a media file (the whole source, not just what's on the timeline): evenly spaced frames between start and end (seconds of the file) in one grid image. For finding B-roll moments that show what a cut-in says.",
            json!({
                "media_id": { "type": "string" },
                "start": { "type": "number" }, "end": { "type": "number" },
                "count": { "type": "integer", "description": "Frames, max 24 (default 12)." },
                "columns": { "type": "integer", "description": "Default 4." }
            }),
            &["media_id", "start", "end"],
        ),
        tool(
            "find_in_footage",
            "Where things are said in all of the project's footage at once, from the transcripts already made: for each phrase, the best places (media id, source seconds at/end, speaker, the words around it), exact runs first. Use it to find B-roll for every cut-in in one call: a phrase per idea in the narration (\"baby in a bucket\", \"arrested her mother\", \"the trunk\"), then look_at_media only where a moment's picture is in doubt. Transcribes nothing; untranscribed_media lists videos without a transcript.",
            json!({
                "phrases": { "type": "array", "items": { "type": "string" }, "description": "Up to 60 phrases." },
                "limit": { "type": "integer", "description": "Places per phrase (default 4)." },
                "context": { "type": "integer", "description": "Words of context before each place (default 8)." }
            }),
            &["phrases"],
        ),
        tool(
            "media_transcript",
            "What's said in a media file (its own seconds, the whole source), as phrases with times and speakers; transcribes it first if needed. For finding moments to use as B-roll (someone confused, a witness reacting).",
            json!({
                "media_id": { "type": "string" },
                "start": { "type": "number", "description": "Default 0." },
                "end": { "type": "number", "description": "Default the end of the file." },
                "words": { "type": "boolean", "description": "Each word with its times, to time a shot to an exact word (default: phrases)." }
            }),
            &["media_id"],
        ),
        tool(
            "smooth_slow_motion",
            "Make slowed video clips (speed below 1) play smoothly: the stretch of each one's media is rendered at that speed with new frames made between the real ones (motion interpolation, like After Effects' pixel-motion frame blending), and the clip then plays that at 1×. Timing is unchanged. Set the clip's speed and trim first; run again after changing them. Optical flow is expensive and optional; each render has a 120-second limit and they run one at a time. By default it returns at once and each swaps in when done (get_project's smoothing lists those still going; exports use the current timeline snapshot unless options.wait_for_smoothing is true).",
            json!({
                "clip_id": { "type": "string" },
                "clip_ids": { "type": "array", "items": { "type": "string" }, "description": "Several requests queued together; one expensive optical-flow render runs at a time." },
                "wait": { "type": "boolean", "description": "Wait for the renders (default false). False: smooth in the background and carry on." }
            }),
            &[],
        ),
        tool(
            "cover_cut_in",
            "Cover a cut-in with B-roll in one call, the house way (B-ROLL IN CUT-INS, PUSH-INS, B-ROLL LOOK, VOICE-OVERS): your shots butted end to end from the cut-in's first frame to its last (each picture only, slowed to speed 0.5, a linear push-in 1 → 1.08; native frame sampling with no background render by default), the B-roll look adjustment over the stretch, the vertical drop into the cut-in (into \"none\" when you'll put another transition there), the black card and its words deleted and the voice-over moved onto A1 in purple. You pick the shots (media_transcript, look_at_media) and time them to the narration's phrases (media_transcript words on the voice-over); this does the rest. Running it again on the same cut-in replaces what it placed. Afterwards add what's particular to the cut-in (a person's vignette and label, a quote, other transitions and their sounds) with batch. Returns each shot's clip id and span.",
            json!({
                "cut_in": { "type": ["integer", "string"], "description": "The cut-in's number among the script's narration blocks (1-based: \"Cut-in N\"), or its card's or voice-over's clip id." },
                "shots": { "type": "array", "items": { "type": "object", "properties": {
                    "media": { "type": "string", "description": "Media id (video or image)." },
                    "source_in": { "type": "number", "description": "Seconds into the media where the shot starts." },
                    "at": { "type": "number", "description": "Timeline seconds where it starts (the first defaults to the cut-in's start; each later one is required). Each shot runs until the next starts; the last to the cut-in's end." },
                    "name": { "type": "string", "description": "What it shows (\"the locked closet\"); names the clip." },
                    "speed": { "type": "number", "description": "Default 0.5." },
                    "push": { "type": "array", "items": { "type": "number" }, "description": "[from, to] scale across the shot, default [1, 1.08]; continue a run of the same moment with e.g. [1.04, 1.08]." },
                    "x": { "type": "number" }, "y": { "type": "number" },
                    "scale": { "type": "number", "description": "Base scale the push multiplies (default 1)." },
                    "smooth": { "type": "boolean", "description": "Expensive optional optical-flow render, limited to 120 s per shot; default false. Leave false for normal edits." }
                }, "required": ["media", "source_in"] } },
                "look": { "type": "boolean", "description": "The B-roll look adjustment (default true)." },
                "into": { "type": "string", "enum": ["drop", "none"], "description": "The transition into the cut-in: the vertical drop (default), or none." }
            }),
            &["cut_in", "shots"],
        ),
        tool(
            "map_view",
            "A tilted 3D view of a place from Google's photorealistic 3D map (real buildings and trees, darker exposure and a vignette, the building at the place marked in glowing red), imported as footage: by default a moving shot, the camera slowly circling the building and closing in while aimed at it (rendered frame by frame; takes a minute or two), or a still. Give the place as an address or name (\"Kent Police Department, Kent, Washington\"; Google finds it and the building's outline) or lat/lon. Each new view is a paid map session (a few a day): get it right the first time, and asking for the same view again reuses the footage. Returns the media id, the address it found, whether the building was outlined and where it sits in the frame (`building`: x, top, bottom, left, right in timeline transform coordinates; for a moving shot also `building_track`, where it is every half second), to place text by it.",
            json!({
                "place": { "type": "string" },
                "lat": { "type": "number" }, "lon": { "type": "number" },
                "range": { "type": "number", "description": "Camera distance in metres at the start: 170 (default) close on the building, ~330 the block around it, 800+ the neighbourhood." },
                "pitch": { "type": "number", "description": "Tilt from straight down in degrees; default 55." },
                "heading": { "type": "number", "description": "Compass direction the camera faces in degrees at the start; default -25." },
                "seconds": { "type": "number", "description": "Length of the moving shot: how long it's on screen (default 6)." },
                "orbit": { "type": "number", "description": "Degrees the camera circles the building over the shot, positive to its right (default 15)." },
                "push": { "type": "number", "description": "How much closer the camera ends, as a fraction of the range (default 0.12)." },
                "still": { "type": "boolean", "description": "A still picture instead of a moving shot (30 s of footage, for a push-in)." },
                "highlight": { "type": "boolean", "description": "Mark the building in red (default true)." },
                "highlight_after": { "type": "number", "description": "Reveal the marker after this many source seconds, e.g. once a date title has faded away (default 0). Building tracking is returned even while hidden." },
                "highlight_fade": { "type": "number", "description": "Marker reveal fade duration in seconds (default 0, immediate)." }
            }),
            &[],
        ),
        tool(
            "add_sound_effect",
            "Place a sound effect bundled with Edit at timeline times, on a free audio track. Only when the user asks for one. Each is lined up by its \"hit\" marker (see media markers): for a cut, give the cut's time (where the two clips meet) and the sound straddles it. The same sound already within 0.5 s of a time is replaced, so placing again (or after the sound is updated) never doubles up.",
            json!({
                "sound": { "type": "string", "enum": crate::sfx::names(), "description": "shutter = a camera shutter. Not part of the house style: only when the user asks for it." },
                "times": { "type": "array", "items": { "type": "number" }, "description": "Seconds on the timeline." },
                "volume_db": { "type": "number", "description": "Default 0." }
            }),
            &["sound", "times"],
        ),
        tool(
            "list_library",
            "The team's sound library (a Google Drive folder): music by mood and sound effects by kind, each with its id and the team's note on how it's used (\"first ~20 seconds\", \"very low volume\"), then the library's usage guide (what each category is for). Read it before picking music or a sound effect.",
            json!({
                "refresh": { "type": "boolean", "description": "Read Drive again now (it's re-read every 2 minutes anyway), e.g. after a sound was added there." }
            }),
            &[],
        ),
        tool(
            "add_from_library",
            "Place a sound or music from the team's library (list_library) at timeline times, on a free audio track (downloaded from Drive the first time; large music can take a minute). A short sound effect is lined up by its \"hit\" marker (its loudest moment, found automatically; see media markers): for a cut, give the cut's time and the hit lands on it; a riser builds into the time. Music and long beds start at the time. The same sound already within 0.5 s of a time is replaced, so placing again never doubles up.",
            json!({
                "id": { "type": "string", "description": "The sound's id from list_library." },
                "times": { "type": "array", "items": { "type": "number" }, "description": "Seconds on the timeline." },
                "loudness": { "type": "number", "description": "How loud it's heard, in LUFS (see the house style's levels): the tool measures the part that plays (a short sound by its loudest moment) and sets the volume to match. Prefer this to volume_db: library files differ in loudness by 20 dB or more." },
                "volume_db": { "type": "number", "description": "A raw gain instead of loudness. Default 0." },
                "seconds": { "type": "number", "description": "Play at most this long: music from its start (a track's \"first ~20 seconds\"); a sound effect, the stretch around its hit (a long glitch or whoosh file cut to its transition's length, e.g. 0.3 s for an 8-frame glitch)." },
                "lead": { "type": "number", "description": "With seconds, on a sound effect: how much of it plays before the hit (default half of seconds; a riser wants most of it before)." },
                "fade_out": { "type": "number", "description": "Seconds of fade at the end, e.g. 1.5 when music is cut short. Default 0." }
            }),
            &["id", "times"],
        ),
        tool(
            "search_web",
            "Search the web privately from this machine (its own Chrome, headless, a throwaway profile: nothing in anyone's search history). Returns titles, links and snippets. Use it to learn a case from the news (names, the place, the date, what happened) before collecting images.",
            json!({ "query": { "type": "string" } }),
            &["query"],
        ),
        tool(
            "read_page",
            "The readable text of a web page (a news story from search_web), the same private way.",
            json!({
                "url": { "type": "string" },
                "limit": { "type": "integer", "description": "Characters to return (default 12000)." }
            }),
            &["url"],
        ),
        tool(
            "add_article",
            "Save a news article about THIS case into the project (the user reads it in the Research view: its text, outlet and date), and put the photos it carries into the review: an article's own photos are of the case, the best images there are. Only for articles you've checked match the case.",
            json!({
                "url": { "type": "string" },
                "summary": { "type": "string", "description": "What it adds to the case in two or three sentences (who, where, what it reports that the footage doesn't)." }
            }),
            &["url", "summary"],
        ),
        tool(
            "case_articles",
            "The news articles saved for this project (add_article), read from the saved copies (no web needed): without id, each one's title, outlet, date and what it adds; with id, its full text. Check them for facts the editing needs (spellings of names, the date and place, the victim, charges and outcome) instead of guessing.",
            json!({
                "id": { "type": "string", "description": "An article's id to read in full." },
                "find": { "type": "string", "description": "Only the passages that mention this (a name, a street, a word), across every article." }
            }),
            &[],
        ),
        tool(
            "look_at_found",
            "A contact sheet of found images still waiting for the user's review, numbered, with their ids and pages, so you can weed out what's off-target before the user looks (reject_found).",
            json!({
                "offset": { "type": "integer", "description": "Skip this many (default 0)." },
                "count": { "type": "integer", "description": "How many (default 24, up to 36)." }
            }),
            &[],
        ),
        tool(
            "reject_found",
            "Reject found images (by id from look_at_found) that aren't of the scene, the people involved or what the user asked for. The user can still see them under Rejected.",
            json!({ "ids": { "type": "array", "items": { "type": "string" } } }),
            &["ids"],
        ),
        tool(
            "collect_images",
            "Search images for each query (Bing, privately from this machine) and download the results into the project's Research review, where the user looks through them and keeps the ones they want (kept images land in the media bin). Skips duplicates and anything smaller than 360 px. Takes a minute or two. Make the queries specific, from what search_web and read_page found: names with the place, the street, \"<name> mugshot\", \"<place> crash scene\", the department.",
            json!({
                "queries": { "type": "array", "items": { "type": "string" } },
                "per_query": { "type": "integer", "description": "Results to try per query (default 40, up to 150)." }
            }),
            &["queries"],
        ),
        tool(
            "set_loudness",
            "Set audio clips to a loudness as heard (LUFS): measures what each plays and sets its volume_db (peaks kept under -1 dBFS). Without loudness, they match the footage's own sound across the timeline (its average loudness), as voice-overs should.",
            json!({
                "clip_ids": { "type": "array", "items": { "type": "string" } },
                "loudness": { "type": "number", "description": "LUFS (default: the footage's average loudness)." }
            }),
            &["clip_ids"],
        ),
        tool(
            "measure_audio",
            "Cached source loudness of unmuted audio clips after static volume (does not include fades, mutes, speed processing or combined mix), over a span of the timeline, in LUFS: integrated over stretches longer than 3 s, a short sound by its loudest moment. Use it to set music under the speech and voice-overs there, and to check a mix after placing sounds.",
            json!({
                "clip_ids": {"type":"array", "items":{"type":"string"}, "description":"Measure only these audio clips, e.g. sounds just added. Repeated source measurements are cached."},
                "start": { "type": "number", "description": "Seconds on the timeline (default 0)." },
                "end": { "type": "number", "description": "Seconds on the timeline (default the end)." }
            }),
            &[],
        ),
        tool(
            "realign_script",
            "Re-finds each script range's first and last words in its transcript (forgiving how the Doc spells them: plurals, possessives, a letter off, e.g. \"priuses\" for \"Prius\") and moves that clip's in/out points to them, shifting everything after it so nothing overlaps or gaps (effects ending on its cut move with the cut). Use it when a range starts or ends a word early or late. Re-run caption_speakers over any clip it changes.",
            json!({}),
            &[],
        ),
        tool(
            "place_voiceovers",
            "Lay voice-over recordings on the script's cut-ins. The recordings read the cut-ins' text: each is transcribed, the words that read each cut-in are found, and that stretch of audio is placed where the cut-in is (on a voice-over track). The cut-in (card and words) takes the voice-over's length and everything after moves with it, so the timeline stays butted. Placing again replaces what it placed. Takes a while the first time (transcription). Reports what was placed and any cut-in whose words weren't found.",
            json!({
                "media_ids": { "type": "array", "items": { "type": "string" }, "description": "The recordings (default: every audio file not on the timeline that isn't a sound effect, plus ones placed before)." }
            }),
            &[],
        ),
        tool(
            "remove_time",
            "Takes a stretch of time out of the whole timeline (a ripple delete across every track): clips wholly inside it are deleted; footage, B-roll and sound crossing it are cut so what's before and after it stays and joins up (the later piece plays on from where it would have); text, solids and adjustments crossing it are shortened; everything after moves left by its length. Keyframes stay with the picture they describe, fades at the cut are dropped, the in/out points, segments and script links follow. Returns what it cut, deleted and moved.",
            json!({
                "start": { "type": "number", "description": "Seconds on the timeline." },
                "end": { "type": "number", "description": "Seconds on the timeline." }
            }),
            &["start", "end"],
        ),
        tool(
            "tighten_voiceover",
            "Shortens the long pauses inside voice-overs: each silence between two words longer than max_pause (from the recording's word times) is cut down to keep, by taking the rest out of the timeline (remove_time at that spot), so the B-roll over it and everything after follow. Never touches the silence before a voice-over clip's first word or after its last, never cuts into a word, and leaves a pause where the footage's own sound is heard over it. Run it with dry_run first on a stretch that drags. Returns each pause (timeline seconds, the words either side, its length, how much went) and the total removed.",
            json!({
                "start": { "type": "number", "description": "Seconds on the timeline (default 0)." },
                "end": { "type": "number", "description": "Seconds on the timeline (default: the end)." },
                "max_pause": { "type": "number", "description": "Seconds: shorter pauses are left alone. Default 0.7." },
                "keep": { "type": "number", "description": "Seconds of each long pause kept. Default 0.35." },
                "dry_run": { "type": "boolean", "description": "Only list the pauses it would shorten. Default false." }
            }),
            &[],
        ),
        tool(
            "speed_voiceover",
            "Plays the voice-over in a span faster (pitch kept, as audio speed always is), and everything laid over it with it: the B-roll plays faster to fit, graphics and keyframes in the span squeeze to the new length, so all still lines up with the words; the timeline after it moves up by the time saved. The span is trimmed to the voice-over clips in it; refused where the footage's own sound plays (it would speed up what people say). Returns the span sped and the seconds saved.",
            json!({
                "start": { "type": "number", "description": "Seconds on the timeline." },
                "end": { "type": "number", "description": "Seconds on the timeline." },
                "speed": { "type": "number", "description": "1.01 to 1.25; 1.04 to 1.08 is usual." }
            }),
            &["start", "end", "speed"],
        ),
        tool(
            "tidy_tracks",
            "Moves every clip down onto the track below wherever that track is empty for the clip's whole span (never into V1/A1, the footage tracks), so layers don't float above gaps and clips that overlap keep their order, then removes tracks left empty. Run it after adding or removing layers.",
            json!({}),
            &[],
        ),
        tool(
            "read_transcript",
            "What is said on the timeline, with timeline times in seconds, grouped into phrases. Only audio clips whose media has been transcribed appear; use `transcribe` first.",
            json!({}),
            &[],
        ),
        tool(
            "transcribe",
            "Transcribe a media item's speech (word timings). Costs money and runs once per file; check get_project's media first. Poll read_transcript afterwards.",
            json!({ "media_id": { "type": "string" } }),
            &["media_id"],
        ),
        tool(
            "render_frame",
            "Render one frame exactly as it will export and return it as an image. Give time (seconds) or frame.",
            json!({ "time": { "type": "number" }, "frame": { "type": "integer" }, "max_size": { "type": "integer", "description": "Longest side in px (default 960)." } }),
            &[],
        ),
        tool(
            "contact_sheet",
            "Render evenly spaced frames between start and end (seconds) into one grid image, to review motion or many moments at once.",
            json!({
                "start": { "type": "number" }, "end": { "type": "number" },
                "count": { "type": "integer", "description": "Frames, max 24 (default 12)." },
                "columns": { "type": "integer", "description": "Default 4." }
            }),
            &["start", "end"],
        ),
        tool(
            "caption_speakers",
            "Speaker captions for intro footage: splits what's said into lines, asks a vision model (Luna) who says each line and where they are (stills + sound), then adds a word-by-word caption per line in the house box style beside its speaker, tracked to their face with a little shake. Replaces captions it made before in that span. Takes a few minutes. Defaults to the intro (start to the cut-in before the full footage).",
            json!({
                "start": { "type": "number", "description": "Seconds on the timeline (default 0)." },
                "end": { "type": "number", "description": "Seconds on the timeline (default: the end of the intro)." }
            }),
            &[],
        ),
        tool(
            "add_subtitles",
            "Plain subtitles for everything said (Repack's style): bottom middle, no animation, no tracking, each line in its speaker's colour. Made from the footage's own sound, skipping throwaway lines and the narrator, radio and background talk, and snapping to cuts. The house words (in their other forms too: punched, hitting) are muted in the footage's sound (`mutes` on its audio clips) and starred out on screen (\"f***\"), in the subtitles and in every other text on the timeline; some are muted but stay readable. Replaces subtitles and mutes it made before in that span; a new subtitle over one moved, resized or keyframed by hand keeps that position and size (subtitles stay bottom middle even over a blur: move one only when the user asks). Defaults to after the intro: from the cut-in before the full footage to the end of the timeline. Returns the subtitles placed, how many kept a hand adjustment, and every mute (term, timeline time, starred).",
            json!({
                "start": { "type": "number", "description": "Seconds on the timeline (default: the end of the intro)." },
                "end": { "type": "number", "description": "Seconds on the timeline (default: the end)." },
                "neglect": { "type": "boolean", "description": "A child abuse or neglect case: also mutes and stars hit, kick, punch, beat, slap, blood, etc. (and their forms: hitting, punched, beaten). Default false." }
            }),
            &[],
        ),
        tool(
            "mute_house_words",
            "Mutes the house words in the footage's sound (the intro's too) and stars them out in every text on screen: subtitles, speaker captions, callouts, quotes, charges, labels; moving and re-timing nothing. Words count in their other forms (punched, hitting, abusive). Run it over the whole timeline (no start/end) once the captions and text are in. Replaces the mutes made before in that span. Returns how many subtitles and other texts changed and every mute (term, timeline time, starred).",
            json!({
                "start": { "type": "number", "description": "Seconds on the timeline (default 0)." },
                "end": { "type": "number", "description": "Seconds on the timeline (default: the end)." },
                "neglect": { "type": "boolean", "description": "A child abuse or neglect case: also mutes and stars hit, kick, punch, beat, slap, blood, etc. (and their forms: hitting, punched, beaten). Default false." }
            }),
            &[],
        ),
        tool(
            "set_segments",
            "Sets a subtitled video's segments (replacing them all): what each stretch is, so repack_subtitles subtitles only the footage. Gaps between the ones given are footage. Re-run repack_subtitles after.",
            json!({
                "segments": { "type": "array", "items": { "type": "object", "properties": {
                    "start": { "type": "number", "description": "Seconds on the timeline." },
                    "end": { "type": "number", "description": "Seconds on the timeline." },
                    "kind": { "type": "string", "enum": ["footage", "captioned", "narration", "other"] },
                    "note": { "type": "string", "description": "What's in it, briefly." }
                }, "required": ["start", "end", "kind"] } }
            }),
            &["segments"],
        ),
        tool(
            "repack_subtitles",
            "A subtitled video the Repack way: every line said in the footage (its own sound, transcribed if needed), split by Repack's rules, held a second after its last word (one at a time), in the house style in each speaker's colour (no two alike), on the subtitles track; the narrator, radio and background talk are hidden. The house words are muted in the footage's sound (sample-accurate, 12 ms cosine ramps; written as `mutes` on its audio clips) and starred out on screen (\"f***\"), in the subtitles and every other text on the timeline; words count in their other forms (punched, hitting); some are muted but stay readable. Replaces subtitles and mutes made before in the span (add_subtitles' too). Returns the subtitles placed, the speakers (name, role, colour, lines) and every mute (term, timeline time, starred).",
            json!({
                "start": { "type": "number", "description": "Seconds on the timeline (default 0)." },
                "end": { "type": "number", "description": "Seconds on the timeline (default: the end)." },
                "neglect": { "type": "boolean", "description": "A child abuse or neglect case: also mutes and stars hit, kick, punch, beat, slap, blood, etc. (and their forms: hitting, punched, beaten). Default false." },
                "hold_ms": { "type": "number", "description": "How long a subtitle stays after its last word unless the next starts first (default 1000)." },
                "overlap": { "type": "boolean", "description": "Interrogation footage: people talking over each other are shown together, each line its own box stacked above the one already up (each person's lines still one at a time). Default false." }
            }),
            &[],
        ),
        tool(
            "watch_footage",
            "The watcher: Gemini watches the footage (a few minutes at a time, with sound) and says who speaks each subtitle line, correcting the speakers in the transcript (a voice the transcriber merged with another becomes its own, named when the footage says the name; a second conversation going on behind the one followed goes to a hidden \"Background talk\" voice), and, for a subtitled video, marks its segments (footage to subtitle, already subtitled e.g. a cold open with burned-in subtitles, narration, other). Answers are cached per window, so a re-run costs nothing unless force. Returns the windows watched, the cost (USD), the lines re-assigned (count and examples), the people seen per window and the segments. Run repack_subtitles (a subtitled video) or add_subtitles (an edit) after it.",
            json!({
                "force": { "type": "boolean", "description": "Watch again even where an answer is cached (costs again). Default false." },
                "segments": { "type": "boolean", "description": "Set the project's segments from what's seen. Default: only for a subtitled video (never on an edit)." }
            }),
            &[],
        ),
        tool(
            "track_region",
            "Track a box in the footage (a face, a redaction block, an object) and make a clip follow it: bakes x/y keyframes onto `follow` so it stays above, below or on the box. Give the box as it appears at `time` in project pixels from the top-left of the frame (as render_frame shows it, scaled to the project size).",
            json!({
                "time": { "type": "number", "description": "Timeline seconds where the box is as given." },
                "box": { "type": "array", "items": { "type": "number" }, "description": "[x0, y0, x1, y1] in project pixels from the top-left." },
                "follow": { "type": "string", "description": "Clip id to move with it (text or video; an adjustment for target vignette or blur)." },
                "place": { "type": "string", "enum": ["above", "below", "on"], "description": "Where the clip sits relative to the box (default on). For a vignette or leader, the point: the box's centre, or the middle of its top or bottom edge (below a face's box = the chin)." },
                "target": { "type": "string", "enum": ["position", "vignette", "leader", "blur"], "description": "What follows: the clip's position (default), an adjustment's vignette centre (vignette_x/y: light kept on a person), a text's callout line start (leader.x/y), or an adjustment's blur region (blur.x/y, place on; its width/height set to the box, radius 35 and feather 20 at 1080p unless already set: a face hidden as it moves)." },
                "offset": { "type": "array", "items": { "type": "number" }, "description": "[dx, dy] px added to every tracked position, e.g. a callout label set off to the side with more room ([260, 140]: right of and below where place puts it)." }
            }),
            &["time", "box", "follow"],
        ),
        tool(
            "export",
            "Export the project (default: the whole edit as an MP4, H.264 + AAC, at the project's size). Progress shows in the UI. Options as the export dialog: format, range (frames [start, end)), shape (vertical = 9:16 for Shorts/Reels, filled per fill: blur | crop | black), size (short side px), quality or target_mb, loudness (LUFS, e.g. -14 for YouTube), chapters. A whole subtitled video is then uploaded to the team's Subtitles folder on Drive; its link becomes the project's drive.url.",
            json!({
                "path": { "type": "string", "description": "Output path (default ~/Movies/Edit/<name>.mp4); the extension follows the format." },
                "options": {
                    "type": "object",
                    "properties": {
                        "format": { "type": "string", "enum": ["h264", "hevc", "prores", "gif", "wav", "mp3", "png"] },
                        "range": { "type": "array", "items": { "type": "integer" }, "description": "[start, end) frames of the edit; png uses start." },
                        "shape": { "type": "string", "enum": ["original", "vertical", "square", "portrait"] },
                        "fill": { "type": "string", "enum": ["blur", "crop", "black"] },
                        "size": { "type": "integer", "description": "Short side in px (e.g. 1080, 720)." },
                        "quality": { "type": "string", "enum": ["high", "balanced", "small"] },
                        "target_mb": { "type": "number" },
                        "hardware": { "type": "boolean", "description": "Encode on the Mac's media engine: much faster." },
                        "audio": { "type": "boolean" },
                        "loudness": { "type": "number" },
                        "chapters": { "type": "array", "items": { "type": "object", "properties": { "start": { "type": "integer" }, "title": { "type": "string" } } } }
                    }
                }
            }),
            &[],
        ),
    ]
}

fn text(value: impl Into<String>) -> Value {
    json!([{ "type": "text", "text": value.into() }])
}

fn image(png: &[u8], caption: String) -> Value {
    json!([
        { "type": "image", "data": base64::engine::general_purpose::STANDARD.encode(png), "mimeType": "image/png" },
        { "type": "text", "text": caption }
    ])
}

async fn call(app: &App, name: &str, args: &Value, scope: Option<&str>) -> Result<Value, String> {
    let store = &app.store;
    if name == "list_projects" {
        return Ok(text(
            serde_json::to_string_pretty(&store.list()).unwrap_or_default(),
        ));
    }
    // A scoped connection only ever touches its own project.
    let id = match scope {
        Some(project) => store.resolve(Some(project))?,
        None => store.resolve(args["project_id"].as_str())?,
    };
    match name {
        "get_edit_context" => {
            let live = store.get(&id).ok_or("project vanished")?;
            Ok(text(
                serde_json::to_string(&edit_context(app, &live, args))
                    .map_err(|error| error.to_string())?,
            ))
        }
        "apply_edit_plan" => {
            let base = args["base_rev"].as_u64().ok_or("base_rev is required")?;
            let operations = args["operations"]
                .as_array()
                .ok_or("operations must be a list")?;
            let frames = review_frames(args.get("review_frames"))?;
            let current = store.get(&id).ok_or("project vanished")?;
            if current.rev != base {
                return Err(format!("revision conflict: expected {base}, current {}; nothing saved; refresh get_edit_context", current.rev));
            }
            let mut project = current.project;
            let applied = crate::diag::time_on("agent", "plan: apply and validate", &id, || {
                crate::edit_plan::apply(&mut project, operations)
            })?;
            let dry_run = args["dry_run"].as_bool().unwrap_or(false);
            let audit = crate::edit_plan::audit(&project);
            let live = if dry_run {
                crate::store::Live { rev: base, project }
            } else {
                store
                    .replace(&id, Some(base), project, ORIGIN)
                    .map_err(|error| match error {
                        crate::store::UpdateError::NotFound => {
                            "project was deleted; nothing saved".to_owned()
                        }
                        crate::store::UpdateError::Conflict(live) => {
                            format!("revision conflict: current {}; nothing saved", live.rev)
                        }
                        crate::store::UpdateError::Invalid(error) => error,
                    })?
            };
            let smoothing = if dry_run {
                Vec::new()
            } else {
                crate::broll::smooth_in_background(app, &id, &applied.smooth)
            };
            let report = json!({"rev":live.rev, "saved":!dry_run, "results":applied.results, "audit":audit, "smoothing_started":smoothing});
            with_review(app, live.project, frames, report).await
        }
        "review_edit" => {
            let frames = review_frames(args.get("frames"))?;
            let live = store.get(&id).ok_or("project vanished")?;
            let report = json!({"rev":live.rev, "audit":crate::edit_plan::audit(&live.project), "subtitle_coverage":subtitle_coverage(app, &live.project), "smoothing":crate::broll::smoothing_pending(&id)});
            with_review(app, live.project, frames, report).await
        }
        "get_project" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let project = &live.project;
            let labels: serde_json::Map<String, Value> = project
                .tracks
                .iter()
                .map(|track| (track.id.clone(), json!(project.track_label(&track.id))))
                .collect();
            Ok(text(
                serde_json::to_string_pretty(&json!({
                    "rev": live.rev,
                    "duration_frames": project.duration(),
                    "duration_seconds": project.duration() as f64 / project.fps(),
                    "track_labels": labels,
                    "sections": edit_core::sections(project),
                    "smoothing": crate::broll::smoothing_pending(&id),
                    "project": project,
                }))
                .unwrap_or_default(),
            ))
        }
        "add_text" => {
            let fps = store.get(&id).ok_or("project vanished")?.project.fps();
            let start = (args["start"].as_f64().ok_or("start is required")? * fps).round() as i64;
            let duration =
                ((args["duration"].as_f64().ok_or("duration is required")? * fps).round() as i64)
                    .max(1);
            let mut style = serde_json::to_value(TextStyle::default()).unwrap_or_default();
            merge(&mut style, &args["style"]);
            let style: TextStyle =
                serde_json::from_value(style).map_err(|error| format!("style: {error}"))?;
            let mut animation = serde_json::to_value(TextAnimation::default()).unwrap_or_default();
            merge(&mut animation, &args["animation"]);
            let animation: TextAnimation =
                serde_json::from_value(animation).map_err(|error| format!("animation: {error}"))?;
            let mut transform = serde_json::to_value(Transform::default()).unwrap_or_default();
            merge(&mut transform, &args["transform"]);
            let transform: Transform =
                serde_json::from_value(transform).map_err(|error| format!("transform: {error}"))?;
            let color: ClipColor = args
                .get("color")
                .filter(|value| !value.is_null())
                .map(|value| serde_json::from_value(value.clone()))
                .transpose()
                .map_err(|error| format!("color: {error}"))?
                .unwrap_or(ClipColor::Pink);
            let text_value = args["text"].as_str().ok_or("text is required")?.to_owned();
            let track = args["track"].as_str().map(str::to_owned);
            let (_, clip_id) = store.update(&id, ORIGIN, |project| {
                let track = match track {
                    Some(track) => track,
                    None => free_track(project, TrackKind::Video, start, start + duration),
                };
                let clip_id = project.fresh_id("c");
                project.clips.push(Clip {
                    id: clip_id.clone(),
                    track,
                    start,
                    duration,
                    color,
                    name: None,
                    link: None,
                    fade_in: 0,
                    fade_out: 0,
                    keyframes: Default::default(),
                    content: ClipContent::Text {
                        text: text_value,
                        style,
                        transform,
                        animation,
                        opacity: 1.0,
                        word_times: Vec::new(),
                    },
                });
                Ok(clip_id)
            })?;
            Ok(text(format!("added text clip {clip_id}")))
        }
        "add_clip" => {
            let Some(mut fields) = args.get("clip").and_then(Value::as_object).cloned() else {
                return Err("clip must be an object".to_owned());
            };
            let (_, clip_id) = store.update(&id, ORIGIN, |project| {
                let clip_id = project.fresh_id("c");
                fields.insert("id".to_owned(), json!(clip_id));
                let kind = if fields.get("type").and_then(Value::as_str) == Some("audio") {
                    TrackKind::Audio
                } else {
                    TrackKind::Video
                };
                let number = |key: &str, default: i64| {
                    fields.get(key).and_then(Value::as_i64).unwrap_or(default)
                };
                let track = match fields.get("track").and_then(Value::as_str) {
                    Some("new") => Some(project.add_track(kind)),
                    Some(_) => None,
                    None => {
                        let start = number("start", 0);
                        let end = start + number("duration", 1);
                        Some(free_track(project, kind, start, end))
                    }
                };
                if let Some(track) = track {
                    fields.insert("track".to_owned(), json!(track));
                }
                let clip: Clip = serde_json::from_value(Value::Object(fields))
                    .map_err(|error| format!("clip: {error}"))?;
                project.clips.push(clip);
                Ok(clip_id)
            })?;
            Ok(text(format!("added clip {clip_id}")))
        }
        "update_clip" => {
            let clip_id = args["clip_id"]
                .as_str()
                .ok_or("clip_id is required")?
                .to_owned();
            let patch = args["patch"].clone();
            store.update(&id, ORIGIN, |project| {
                let clip = project
                    .clip_mut(&clip_id)
                    .ok_or_else(|| format!("no clip {clip_id}"))?;
                let mut value = serde_json::to_value(&*clip).map_err(|error| error.to_string())?;
                merge(&mut value, &patch);
                if let Some(fields) = value.as_object_mut() {
                    fields.insert("id".to_owned(), json!(clip_id));
                }
                *clip = serde_json::from_value(value)
                    .map_err(|error| format!("patched clip is invalid: {error}"))?;
                Ok(())
            })?;
            let clip = store
                .get(&id)
                .and_then(|live| live.project.clip(&clip_id).cloned());
            Ok(text(format!(
                "updated {clip_id}: {}",
                serde_json::to_string(&clip).unwrap_or_default()
            )))
        }
        "update_clips" => {
            let patch = args["patch"].clone();
            if !patch.is_object() {
                return Err("patch must be an object".to_owned());
            }
            let ids: Option<Vec<String>> = args
                .get("clip_ids")
                .filter(|value| !value.is_null())
                .map(|value| {
                    serde_json::from_value(value.clone()).map_err(|error| error.to_string())
                })
                .transpose()?;
            let label = args["label"].as_str().map(str::to_owned);
            let track = args["track"].as_str().map(str::to_owned);
            if ids.is_none() && label.is_none() && track.is_none() {
                return Err("pick the clips: clip_ids, label or track".to_owned());
            }
            let (_, changed) = store.update(&id, ORIGIN, |project| {
                let fps = project.fps();
                let from = args["start"]
                    .as_f64()
                    .map(|seconds| (seconds * fps).round() as i64);
                let to = args["end"]
                    .as_f64()
                    .map(|seconds| (seconds * fps).round() as i64);
                if let Some(ids) = &ids {
                    if let Some(missing) = ids.iter().find(|clip| project.clip(clip).is_none()) {
                        return Err(format!("no clip {missing}"));
                    }
                }
                let mut changed = Vec::new();
                for clip in &mut project.clips {
                    let picked = ids.as_ref().is_none_or(|ids| ids.contains(&clip.id))
                        && track.as_ref().is_none_or(|track| &clip.track == track)
                        && from.is_none_or(|from| clip.start >= from)
                        && to.is_none_or(|to| clip.start < to)
                        && label.as_ref().is_none_or(|label| {
                            matches!(&clip.content, ClipContent::Text { style, .. }
                                if style.label.as_ref().is_some_and(|own| &own.text == label))
                        });
                    if !picked {
                        continue;
                    }
                    let clip_id = clip.id.clone();
                    let mut value =
                        serde_json::to_value(&*clip).map_err(|error| error.to_string())?;
                    merge(&mut value, &patch);
                    if let Some(fields) = value.as_object_mut() {
                        fields.insert("id".to_owned(), json!(clip_id));
                    }
                    *clip = serde_json::from_value(value)
                        .map_err(|error| format!("patched {clip_id} is invalid: {error}"))?;
                    changed.push(clip_id);
                }
                Ok(changed)
            })?;
            Ok(text(match changed.len() {
                0 => "no clips matched; nothing changed".to_owned(),
                count => format!("updated {count} clip(s): {}", changed.join(", ")),
            }))
        }
        "batch" => run_batch(app, args, scope).await,
        "cover_cut_in" => {
            let report = crate::cutin::cover_cut_in(app, &id, args).await?;
            Ok(text(
                serde_json::to_string_pretty(&report).unwrap_or_default(),
            ))
        }
        "set_in_out" => {
            let fps = store.get(&id).ok_or("project vanished")?.project.fps();
            let frame = |key: &str| -> Option<Option<i64>> {
                let value = args.get(key)?;
                Some(
                    value
                        .as_f64()
                        .map(|seconds| (seconds * fps).round().max(0.0) as i64),
                )
            };
            let (start, end) = (frame("in"), frame("out"));
            let (_, span) = store.update(&id, ORIGIN, |project| {
                if let Some(start) = start {
                    project.mark_in = start;
                }
                if let Some(end) = end {
                    project.mark_out = end;
                }
                Ok(project.in_out())
            })?;
            Ok(text(match span {
                Some((start, end)) => format!(
                    "in/out: {:.2}s to {:.2}s ({} frames)",
                    start as f64 / fps,
                    end as f64 / fps,
                    end - start
                ),
                None => "in and out points cleared".to_owned(),
            }))
        }
        "delete_clips" => {
            let ids: Vec<String> = serde_json::from_value(args["clip_ids"].clone())
                .map_err(|error| error.to_string())?;
            let close_gap = args["close_gap"].as_bool().unwrap_or(false);
            let drop_from_script = args["drop_from_script"].as_bool().unwrap_or(false);
            let (_, (removed, closed)) = store.update(&id, ORIGIN, |project| {
                let (gone, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut project.clips)
                    .into_iter()
                    .partition(|clip| ids.contains(&clip.id));
                project.clips = kept;
                if drop_from_script {
                    if let Some(script) = &mut project.script {
                        script.blocks.retain(|block| {
                            !matches!(block, ScriptBlock::Narration { clip: Some(card), .. } if ids.contains(card))
                        });
                    }
                }
                let closed = if close_gap {
                    close_gaps(project, &gone)
                } else {
                    0
                };
                Ok((gone.len(), closed))
            })?;
            Ok(text(if closed > 0 {
                format!("deleted {removed} clip(s); closed {closed} frame(s) of gap")
            } else {
                format!("deleted {removed} clip(s)")
            }))
        }
        "set_keyframes" => {
            let clip_id = args["clip_id"]
                .as_str()
                .ok_or("clip_id is required")?
                .to_owned();
            let param = args["param"]
                .as_str()
                .ok_or("param is required")?
                .to_owned();
            let mut keys: Vec<Keyframe> = serde_json::from_value(args["keyframes"].clone())
                .map_err(|error| format!("keyframes: {error}"))?;
            keys.sort_by(|a, b| a.frame.total_cmp(&b.frame));
            store.update(&id, ORIGIN, |project| {
                let clip = project
                    .clip_mut(&clip_id)
                    .ok_or_else(|| format!("no clip {clip_id}"))?;
                if !animatable_params(&clip.content).contains(&param.as_str()) {
                    return Err(format!(
                        "{param} is not animatable here; use one of {}",
                        animatable_params(&clip.content).join(", ")
                    ));
                }
                if keys.is_empty() {
                    clip.keyframes.remove(&param);
                } else {
                    clip.keyframes.insert(param.clone(), keys);
                }
                Ok(())
            })?;
            Ok(text(format!("set {param} keyframes on {clip_id}")))
        }
        "import_media" => {
            let paths: Vec<String> =
                serde_json::from_value(args["paths"].clone()).map_err(|error| error.to_string())?;
            let place = args["place"].as_bool().unwrap_or(false);
            let (_, added, errors) =
                crate::server::import_paths(app, &id, paths, place, ORIGIN).await?;
            Ok(text(format!(
                "imported media {added:?}{}",
                if errors.is_empty() {
                    String::new()
                } else {
                    format!("; errors: {errors:?}")
                }
            )))
        }
        "use_found" => {
            let found = args["found_id"].as_str().ok_or("found_id is required")?;
            let item = crate::server::review_found(app, &id, found, "kept", ORIGIN).await?;
            match item.media {
                Some(media) => Ok(text(format!(
                    "kept {found}: media {media} ({})",
                    item.title
                ))),
                None => Err("it was kept but isn't in the media bin".to_owned()),
            }
        }
        "still_frame" => {
            let media_id = args["media_id"].as_str().ok_or("media_id is required")?;
            let time = args["time"].as_f64().ok_or("time is required")?;
            let live = store.get(&id).ok_or("no such project")?;
            let media = live
                .project
                .media(media_id)
                .ok_or_else(|| format!("no media {media_id}"))?;
            if !(0.0..=media.duration).contains(&time) {
                return Err(format!("time must be 0 to {:.2} s", media.duration));
            }
            let source = std::path::PathBuf::from(&media.path);
            let label: String = args["name"]
                .as_str()
                .unwrap_or("still")
                .chars()
                .map(|c| {
                    if c.is_alphanumeric() || c == ' ' || c == '-' {
                        c
                    } else {
                        '_'
                    }
                })
                .take(60)
                .collect();
            let dir = store.uploads_dir(&id);
            std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
            let out = dir.join(format!("{} {:.2}s.png", label.trim(), time));
            let output = std::process::Command::new(crate::tools::ffmpeg())
                .args(["-hide_banner", "-loglevel", "error", "-y", "-ss"])
                .arg(format!("{time:.3}"))
                .arg("-i")
                .arg(&source)
                .args(["-frames:v", "1"])
                .arg(&out)
                .stdin(std::process::Stdio::null())
                .output()
                .map_err(|error| format!("ffmpeg: {error}"))?;
            if !output.status.success() || !out.is_file() {
                return Err(format!(
                    "couldn't take the frame: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
            let (_, added, errors) = crate::server::import_paths(
                app,
                &id,
                vec![out.to_string_lossy().into_owned()],
                false,
                ORIGIN,
            )
            .await?;
            match added.first() {
                Some(still) => Ok(text(format!(
                    "saved the frame at {time:.2} s as image media {still}"
                ))),
                None => Err(format!("couldn't import the frame: {errors:?}")),
            }
        }
        "add_sound_effect" => {
            let name = args["sound"].as_str().ok_or("sound is required")?;
            let sound = crate::sfx::find(name).ok_or_else(|| {
                format!(
                    "no sound {name}; use one of {}",
                    crate::sfx::names().join(", ")
                )
            })?;
            let times: Vec<f64> =
                serde_json::from_value(args["times"].clone()).map_err(|error| error.to_string())?;
            let volume_db = args["volume_db"].as_f64().unwrap_or(0.0) as f32;
            let path = crate::sfx::path(store.home(), sound)?;
            let (_, added, errors) = crate::server::import_paths(
                app,
                &id,
                vec![path.to_string_lossy().to_string()],
                false,
                ORIGIN,
            )
            .await?;
            let media_id = added
                .into_iter()
                .next()
                .ok_or_else(|| format!("couldn't import {name}: {errors:?}"))?;
            let markers = sound.markers();
            let placed = place_sound(
                store,
                &id,
                &media_id,
                name,
                markers,
                &times,
                Sound {
                    volume_db,
                    seconds: None,
                    lead: None,
                    fade_out: 0.0,
                    color: ClipColor::Yellow,
                },
            )?;
            Ok(text(placed))
        }
        "list_library" => {
            let library = std::sync::Arc::clone(&app.library);
            let refresh = args["refresh"].as_bool().unwrap_or(false);
            let listing = tokio::task::spawn_blocking(move || library.list(refresh))
                .await
                .map_err(|error| error.to_string())??;
            let mut out = String::from(
                "The team's sound library (Google Drive). Place one with add_from_library {id}.\n",
            );
            let mut heading = ("", "");
            for sound in &listing.sounds {
                if heading != (sound.kind, sound.category.as_str()) {
                    heading = (sound.kind, sound.category.as_str());
                    let kind = if sound.kind == "music" {
                        "Music"
                    } else {
                        "Sound effects"
                    };
                    out.push_str(&format!("\n{kind} / {}:\n", sound.category));
                }
                out.push_str(&format!(
                    "- {} | {}{}\n",
                    sound.id,
                    sound.name,
                    sound
                        .note
                        .as_ref()
                        .map(|note| format!(" — {note}"))
                        .unwrap_or_default()
                ));
            }
            if !listing.guide.is_empty() {
                out.push_str(&format!(
                    "\nUsage guide (from the library's Doc):\n{}\n",
                    listing.guide
                ));
            }
            Ok(text(out))
        }
        "add_from_library" => {
            let sound_id = args["id"].as_str().ok_or("id is required")?;
            let times: Vec<f64> =
                serde_json::from_value(args["times"].clone()).map_err(|error| error.to_string())?;
            let (media_id, sound) = crate::library::import(app, &id, sound_id, ORIGIN).await?;
            let seconds = args["seconds"].as_f64().filter(|seconds| *seconds > 0.0);
            let mut volume_db = args["volume_db"].as_f64().unwrap_or(0.0);
            let mut level = String::new();
            if let Some(target) = args["loudness"].as_f64() {
                let media = store
                    .get(&id)
                    .and_then(|live| live.project.media(&media_id).cloned())
                    .ok_or("sound media vanished")?;
                // The stretch that plays (around the hit when trimmed; see place_sound).
                let hit = media
                    .markers
                    .iter()
                    .find(|marker| marker.name == crate::sfx::HIT)
                    .map_or(0.0, |marker| marker.time);
                let from = match seconds {
                    Some(seconds) if hit > 0.0 => {
                        (hit - args["lead"].as_f64().unwrap_or(seconds / 2.0)).max(0.0)
                    }
                    _ => 0.0,
                };
                let length = seconds.unwrap_or(media.duration).min(media.duration - from);
                let measured = tokio::task::spawn_blocking(move || {
                    crate::library::loudness(std::path::Path::new(&media.path), from, length)
                })
                .await
                .map_err(|error| error.to_string())??;
                // Never boost a near-silent stretch into noise.
                volume_db = (target - measured).clamp(-40.0, 12.0);
                level = format!(
                    "; it measures {measured:.1} LUFS, so volume {volume_db:+.1} dB puts it at {:.1} LUFS",
                    measured + volume_db
                );
            }
            let placed = place_sound(
                store,
                &id,
                &media_id,
                &sound.name,
                Vec::new(),
                &times,
                Sound {
                    volume_db: volume_db as f32,
                    seconds,
                    lead: args["lead"].as_f64().filter(|lead| *lead >= 0.0),
                    fade_out: args["fade_out"].as_f64().unwrap_or(0.0).max(0.0),
                    color: if sound.kind == "music" {
                        ClipColor::Green
                    } else {
                        ClipColor::Yellow
                    },
                },
            )?;
            Ok(text(format!("{placed}{level}")))
        }
        "search_web" => {
            let query = args["query"]
                .as_str()
                .ok_or("query is required")?
                .to_owned();
            let found = tokio::task::spawn_blocking(move || crate::research::search_web(&query))
                .await
                .map_err(|error| error.to_string())??;
            Ok(text(if found.is_empty() {
                "nothing found".to_owned()
            } else {
                found
                    .iter()
                    .enumerate()
                    .map(|(index, found)| {
                        format!(
                            "{}. {}\n   {}\n   {}",
                            index + 1,
                            found.title,
                            found.url,
                            found.snippet
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            }))
        }
        "read_page" => {
            let url = args["url"].as_str().ok_or("url is required")?.to_owned();
            let limit = args["limit"].as_u64().unwrap_or(12_000).clamp(500, 60_000) as usize;
            let page = tokio::task::spawn_blocking(move || crate::research::read_page(&url, limit))
                .await
                .map_err(|error| error.to_string())??;
            Ok(text(page))
        }
        "add_article" => {
            let url = args["url"].as_str().ok_or("url is required")?.to_owned();
            let summary = args["summary"].as_str().unwrap_or_default().to_owned();
            let (home, project) = (store.home().to_path_buf(), id.clone());
            let (article, photos) = tokio::task::spawn_blocking(move || {
                crate::research::add_article(&home, &project, &url, &summary)
            })
            .await
            .map_err(|error| error.to_string())??;
            Ok(text(format!(
                "saved \"{}\" ({}{}) to the project's articles, and added {photos} of its photos to the review",
                article.title,
                article.outlet,
                article.published.as_deref().map(|date| format!(", {date}")).unwrap_or_default()
            )))
        }
        "case_articles" => {
            let articles = crate::research::articles(store.home(), &id);
            if articles.is_empty() {
                return Ok(text("no articles saved for this project yet (research the case: search_web, read_page, add_article)"));
            }
            if let Some(wanted) = args["id"].as_str() {
                let article = articles
                    .iter()
                    .find(|article| article.id == wanted)
                    .ok_or_else(|| format!("no article {wanted}"))?;
                return Ok(text(format!(
                    "{} ({}{})\n{}\n\n{}",
                    article.title,
                    article.outlet,
                    article
                        .published
                        .as_deref()
                        .map(|date| format!(", {date}"))
                        .unwrap_or_default(),
                    article.url,
                    article.text
                )));
            }
            if let Some(find) = args["find"].as_str().filter(|find| !find.trim().is_empty()) {
                let needle = find.to_ascii_lowercase();
                let mut found = Vec::new();
                for article in &articles {
                    // Each mention with the sentence or so around it.
                    // ASCII lowercasing keeps byte positions, so they index the text itself.
                    let text = article.text.as_str();
                    let lower = text.to_ascii_lowercase();
                    let mut from = 0;
                    while let Some(at) = lower
                        .get(from..)
                        .and_then(|rest| rest.find(&needle))
                        .map(|at| at + from)
                    {
                        let (Some(before), Some(after)) = (text.get(..at), text.get(at..)) else {
                            break;
                        };
                        let start = before
                            .char_indices()
                            .rev()
                            .nth(200)
                            .map_or(0, |(index, _)| index);
                        let end = after
                            .char_indices()
                            .nth(needle.len() + 200)
                            .map_or(text.len(), |(index, _)| at + index);
                        found.push(format!(
                            "[{} · {}] …{}…",
                            article.outlet,
                            article.id,
                            text.get(start..end).unwrap_or_default()
                        ));
                        // Always forward, so a mention can't be found twice.
                        from = end.max(at + needle.len().max(1)).min(lower.len());
                    }
                }
                return Ok(text(if found.is_empty() {
                    format!("\"{find}\" isn't in the saved articles")
                } else {
                    found.join("\n\n")
                }));
            }
            Ok(text(
                articles
                    .iter()
                    .map(|article| {
                        format!(
                            "{} · {} ({}{})\n   {}",
                            article.id,
                            article.title,
                            article.outlet,
                            article
                                .published
                                .as_deref()
                                .map(|date| format!(", {date}"))
                                .unwrap_or_default(),
                            article.summary
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            ))
        }
        "look_at_found" => {
            let offset = args["offset"].as_u64().unwrap_or(0) as usize;
            let count = args["count"].as_u64().unwrap_or(24).clamp(1, 36) as usize;
            let waiting: Vec<_> = crate::research::items(store.home(), &id)
                .into_iter()
                .filter(|item| item.status == "new")
                .collect();
            let total = waiting.len();
            let shown: Vec<_> = waiting.into_iter().skip(offset).take(count).collect();
            if shown.is_empty() {
                return Ok(text(format!(
                    "no found images waiting from {offset} ({total} waiting)"
                )));
            }
            let files: Vec<String> = shown.iter().map(|item| item.file.clone()).collect();
            let thumbs = tokio::task::spawn_blocking(move || {
                files
                    .iter()
                    .map(|file| {
                        crate::research::thumbnail(std::path::Path::new(file)).unwrap_or(
                            crate::render::RgbaImage {
                                width: 320,
                                height: 240,
                                pixels: vec![0; 320 * 240 * 4],
                            },
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .await
            .map_err(|error| error.to_string())?;
            let png = encode_png(&tile(&thumbs, 6))?;
            let list = shown
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    format!(
                        "{} {} — {} ({})",
                        offset + index + 1,
                        item.id,
                        item.title,
                        item.page
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            Ok(image(
                &png,
                format!(
                    "found images {}–{} of {total} waiting, left to right then down:\n{list}",
                    offset + 1,
                    offset + shown.len()
                ),
            ))
        }
        "reject_found" => {
            let ids: Vec<String> =
                serde_json::from_value(args["ids"].clone()).map_err(|error| error.to_string())?;
            let count = crate::research::reject(store.home(), &id, &ids)?;
            Ok(text(format!("rejected {count}")))
        }
        "collect_images" => {
            let queries: Vec<String> = serde_json::from_value(args["queries"].clone())
                .map_err(|error| error.to_string())?;
            let per_query = args["per_query"].as_u64().unwrap_or(40).clamp(1, 150) as usize;
            let home = store.home().to_path_buf();
            let project = id.clone();
            let (added, had, failed) = tokio::task::spawn_blocking(move || {
                crate::research::collect(&home, &project, &queries, per_query)
            })
            .await
            .map_err(|error| error.to_string())??;
            let total = crate::research::items(store.home(), &id).len();
            Ok(text(format!(
                "added {added} new images to the Research review ({had} already there, {failed} couldn't be used: blocked, not an image or too small); {total} in all. The user reviews them in the media bin's Research view; the ones they keep land in the media bin."
            )))
        }
        "set_loudness" => {
            let clip_ids: Vec<String> = serde_json::from_value(args["clip_ids"].clone())
                .map_err(|error| error.to_string())?;
            let project = store.get(&id).ok_or("project vanished")?.project;
            let target = args["loudness"].as_f64();
            let (target, gains) = tokio::task::spawn_blocking(move || {
                let target = match target {
                    Some(target) => target,
                    None => crate::library::footage_loudness(&project)?,
                };
                let gains = clip_ids
                    .iter()
                    .map(|clip_id| {
                        let clip = project
                            .clip(clip_id)
                            .ok_or_else(|| format!("no clip {clip_id}"))?;
                        Ok((
                            clip_id.clone(),
                            crate::library::gain_to(&project, clip, target)?,
                        ))
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                Ok::<_, String>((target, gains))
            })
            .await
            .map_err(|error| error.to_string())??;
            store.update(&id, ORIGIN, |project| {
                for (clip_id, gain) in &gains {
                    if let Some(ClipContent::Audio { volume_db, .. }) = project
                        .clips
                        .iter_mut()
                        .find(|clip| &clip.id == clip_id)
                        .map(|clip| &mut clip.content)
                    {
                        *volume_db = *gain as f32;
                    }
                }
                Ok(())
            })?;
            Ok(text(format!(
                "set to {target:.1} LUFS: {}",
                gains
                    .iter()
                    .map(|(clip_id, gain)| format!("{clip_id} volume {gain:+.1} dB"))
                    .collect::<Vec<_>>()
                    .join(", ")
            )))
        }
        "measure_audio" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let project = live.project;
            let fps = project.fps();
            let start = (args["start"].as_f64().unwrap_or(0.0) * fps).round() as i64;
            let end = args["end"]
                .as_f64()
                .map_or(project.duration(), |end| (end * fps).round() as i64);
            let picked: Option<Vec<String>> = args
                .get("clip_ids")
                .map(|value| serde_json::from_value(value.clone()))
                .transpose()
                .map_err(|error| format!("clip_ids: {error}"))?;
            let mut spans = Vec::new();
            for clip in &project.clips {
                if picked.as_ref().is_some_and(|ids| !ids.contains(&clip.id)) {
                    continue;
                }
                if !project.track(&clip.track).is_some_and(|track| !track.muted) {
                    continue;
                }
                let ClipContent::Audio {
                    media,
                    source_in,
                    speed,
                    volume_db,
                    ..
                } = &clip.content
                else {
                    continue;
                };
                let (from, to) = (clip.start.max(start), clip.end().min(end));
                let Some(media) = project.media(media).filter(|_| to > from) else {
                    continue;
                };
                let source = source_in + (from - clip.start) as f64 / fps * speed;
                let seconds = (to - from) as f64 / fps * speed;
                spans.push((
                    clip.id.clone(),
                    clip.name.clone().unwrap_or_else(|| media.name.clone()),
                    clip.track.clone(),
                    from as f64 / fps,
                    to as f64 / fps,
                    media.path.clone(),
                    source,
                    seconds,
                    f64::from(*volume_db),
                ));
            }
            spans.sort_by(|a, b| a.3.total_cmp(&b.3));
            let labels: std::collections::HashMap<String, String> = project
                .tracks
                .iter()
                .filter_map(|track| Some((track.id.clone(), project.track_label(&track.id)?)))
                .collect();
            let lines = tokio::task::spawn_blocking(move || {
                spans
                    .into_iter()
                    .map(|(clip, name, track, from, to, path, source, seconds, gain)| {
                        let heard = crate::library::loudness(std::path::Path::new(&path), source, seconds)
                            .map_or_else(|error| error, |lufs| format!("{:.1} LUFS", lufs + gain));
                        let track = labels.get(&track).cloned().unwrap_or(track);
                        format!("{clip} {track} {from:.2}–{to:.2}s {name}: {heard} (volume {gain:+.1} dB)")
                    })
                    .collect::<Vec<_>>()
            })
            .await
            .map_err(|error| error.to_string())?;
            Ok(text(if lines.is_empty() {
                "no audio in that span".to_owned()
            } else {
                lines.join("\n")
            }))
        }
        "realign_script" => {
            let changed = crate::script::realign(app, &id).await?;
            Ok(text(if changed.is_empty() {
                "every range already starts and ends on its words".to_owned()
            } else {
                serde_json::to_string_pretty(&changed).unwrap_or_default()
            }))
        }
        "look_at_media" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let media_id = args["media_id"].as_str().ok_or("media_id is required")?;
            let media = live
                .project
                .media(media_id)
                .ok_or_else(|| format!("no media {media_id}"))?
                .clone();
            let start = args["start"].as_f64().unwrap_or(0.0).max(0.0);
            let end = args["end"].as_f64().unwrap_or(media.duration);
            let count = args["count"].as_u64().unwrap_or(12).clamp(1, 24) as usize;
            let columns = args["columns"].as_u64().unwrap_or(4).clamp(1, 8) as u32;
            let (images, times) = tokio::task::spawn_blocking(move || {
                crate::broll::media_frames(&media, start, end, count)
            })
            .await
            .map_err(|error| error.to_string())??;
            let png = encode_png(&tile(&images, columns))?;
            let times: Vec<String> = times.iter().map(|time| format!("{time:.2}s")).collect();
            Ok(image(
                &png,
                format!(
                    "{media_id}: {} frames, left-to-right then down, at {}",
                    times.len(),
                    times.join(", ")
                ),
            ))
        }
        "find_in_footage" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let phrases: Vec<String> = serde_json::from_value(args["phrases"].clone())
                .map_err(|error| format!("phrases: {error}"))?;
            if phrases.is_empty() || phrases.len() > 60 {
                return Err("give 1 to 60 phrases".to_owned());
            }
            let limit = args["limit"].as_u64().unwrap_or(4).clamp(1, 12) as usize;
            let context = args["context"].as_u64().unwrap_or(8).min(40) as usize;
            let app = app.clone();
            let found = tokio::task::spawn_blocking(move || {
                crate::footage_search::find(&app, &live.project, &phrases, limit, context)
            })
            .await
            .map_err(|error| error.to_string())?;
            Ok(text(
                serde_json::to_string(&found).map_err(|error| error.to_string())?,
            ))
        }
        "media_transcript" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let media_id = args["media_id"].as_str().ok_or("media_id is required")?;
            let media = live
                .project
                .media(media_id)
                .ok_or_else(|| format!("no media {media_id}"))?;
            let from = args["start"].as_f64().unwrap_or(0.0);
            let to = args["end"].as_f64().unwrap_or(f64::MAX);
            let words = args["words"].as_bool().unwrap_or(false);
            Ok(text(
                crate::broll::media_transcript(app, media, from, to, words).await?,
            ))
        }
        "smooth_slow_motion" => {
            let mut clips: Vec<String> = args
                .get("clip_ids")
                .filter(|value| !value.is_null())
                .map(|value| {
                    serde_json::from_value(value.clone()).map_err(|error| error.to_string())
                })
                .transpose()?
                .unwrap_or_default();
            clips.extend(args["clip_id"].as_str().map(str::to_owned));
            if clips.is_empty() {
                return Err("give clip_id or clip_ids".to_owned());
            }
            if !args["wait"].as_bool().unwrap_or(false) {
                let started = crate::broll::smooth_in_background(app, &id, &clips);
                return Ok(text(format!(
                    "smoothing {} clip(s) in the background ({}); each swaps in when done",
                    started.len(),
                    started.join(", ")
                )));
            }
            let renders = clips
                .iter()
                .map(|clip| crate::broll::smooth_slow_motion(app, &id, clip));
            let results = futures_util::future::join_all(renders).await;
            let mut out = Vec::new();
            let mut failed = Vec::new();
            for (clip, result) in clips.iter().zip(results) {
                match result {
                    Ok(done) => out.push(done.to_string()),
                    Err(error) => failed.push(format!("{clip}: {error}")),
                }
            }
            if out.is_empty() {
                return Err(failed.join("\n"));
            }
            out.extend(
                failed
                    .into_iter()
                    .map(|failure| format!("failed {failure}")),
            );
            Ok(text(out.join("\n")))
        }
        "map_view" => {
            let done = crate::broll::map_view(app, &id, args).await?;
            Ok(text(
                serde_json::to_string_pretty(&done).unwrap_or_default(),
            ))
        }
        "place_voiceovers" => {
            let media: Option<Vec<String>> = args
                .get("media_ids")
                .filter(|value| !value.is_null())
                .map(|value| {
                    serde_json::from_value(value.clone()).map_err(|error| error.to_string())
                })
                .transpose()?;
            let report = crate::voiceover::place(app, &id, media).await?;
            Ok(text(
                serde_json::to_string_pretty(&report).unwrap_or_default(),
            ))
        }
        "remove_time" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let fps = live.project.fps();
            let frame = |key: &str| {
                args[key]
                    .as_f64()
                    .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
                    .map(|seconds| (seconds * fps).round() as i64)
                    .ok_or(format!("{key} is required (seconds)"))
            };
            let (start, end) = (frame("start")?, frame("end")?);
            if end <= start {
                return Err("end must come after start".into());
            }
            let (_, done) = store.update(&id, ORIGIN, |project| {
                Ok(edit_core::remove_time(project, start, end))
            })?;
            Ok(text(format!(
                "removed {:.2}s at {:.2}s: {} clip(s) cut, {} deleted, {} moved",
                done.frames as f64 / fps,
                start as f64 / fps,
                done.cut,
                done.deleted,
                done.moved
            )))
        }
        "tighten_voiceover" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let fps = live.project.fps();
            let from = args["start"]
                .as_f64()
                .map_or(0, |seconds| (seconds * fps).round() as i64);
            let to = args["end"]
                .as_f64()
                .map_or(live.project.duration(), |seconds| {
                    (seconds * fps).round() as i64
                });
            let max_pause = args["max_pause"]
                .as_f64()
                .filter(|pause| pause.is_finite() && *pause >= 0.2)
                .unwrap_or(0.7);
            let keep = args["keep"]
                .as_f64()
                .filter(|keep| keep.is_finite() && *keep >= 0.1)
                .unwrap_or(0.35)
                .min(max_pause);
            let dry_run = args["dry_run"].as_bool().unwrap_or(false);
            let done = crate::diag::time_async(
                "voiceover",
                "tighten voice-over",
                crate::voiceover::tighten(app, &id, (from, to), max_pause, keep, dry_run),
            )
            .await?;
            Ok(text(
                serde_json::to_string_pretty(&done).unwrap_or_default(),
            ))
        }
        "speed_voiceover" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let fps = live.project.fps();
            let frame = |key: &str| {
                args[key]
                    .as_f64()
                    .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
                    .map(|seconds| (seconds * fps).round() as i64)
                    .ok_or(format!("{key} is required (seconds)"))
            };
            let (from, to) = (frame("start")?, frame("end")?);
            let speed = args["speed"].as_f64().ok_or("speed is required")?;
            let (_, (start, end, saved)) = store.update(&id, ORIGIN, |project| {
                crate::voiceover::speed_up(project, from, to, speed)
            })?;
            Ok(text(format!(
                "sped {:.2}–{:.2}s up {speed}x: saved {:.2}s",
                start as f64 / fps,
                end as f64 / fps,
                saved as f64 / fps
            )))
        }
        "tidy_tracks" => {
            let (_, (moved, removed)) =
                store.update(&id, ORIGIN, |project| Ok(tidy_tracks(project)))?;
            Ok(text(format!(
                "moved {moved} clip(s) down, removed {removed} empty track(s)"
            )))
        }
        "transcribe" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let media_id = args["media_id"].as_str().ok_or("media_id is required")?;
            let media = live
                .project
                .media(media_id)
                .ok_or_else(|| format!("no media {media_id}"))?;
            if media.is_sound_effect() {
                return Err(format!(
                    "{} is a sound effect; there's nothing said to transcribe",
                    media.name
                ));
            }
            let status = app
                .media
                .transcribe(std::path::PathBuf::from(&media.path), media.has_audio);
            Ok(text(format!(
                "transcript for {}: {}",
                media.name,
                serde_json::to_string(&status.transcript).unwrap_or_default()
            )))
        }
        "caption_speakers" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let fps = live.project.fps();
            let (intro_from, intro_to) =
                crate::captions::intro(&live.project).unwrap_or((0, live.project.duration()));
            let from = args["start"]
                .as_f64()
                .map_or(intro_from, |seconds| (seconds * fps).round() as i64);
            let to = args["end"]
                .as_f64()
                .map_or(intro_to, |seconds| (seconds * fps).round() as i64);
            let summary = crate::captions::caption_speakers(app, &id, from, to).await?;
            Ok(text(format!(
                "captioned {}–{}s: {}",
                from as f64 / fps,
                to as f64 / fps,
                serde_json::to_string(&summary).unwrap_or_default()
            )))
        }
        "add_subtitles" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let fps = live.project.fps();
            let intro_end = crate::captions::intro(&live.project).map_or(0, |(_, end)| end);
            let from = args["start"]
                .as_f64()
                .map_or(intro_end, |seconds| (seconds * fps).round() as i64);
            let to = args["end"]
                .as_f64()
                .map_or(live.project.duration(), |seconds| {
                    (seconds * fps).round() as i64
                });
            let neglect = args["neglect"].as_bool().unwrap_or(false);
            let summary = crate::captions::subtitles(app, &id, from, to, neglect).await?;
            Ok(text(format!(
                "subtitled {:.2}–{:.2}s: {}",
                from as f64 / fps,
                to as f64 / fps,
                serde_json::to_string(&summary).unwrap_or_default()
            )))
        }
        "set_segments" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let fps = live.project.fps();
            let duration = live.project.duration();
            let mut given: Vec<edit_core::Segment> = args["segments"]
                .as_array()
                .ok_or("segments must be a list")?
                .iter()
                .map(|segment| {
                    let at = |key: &str| {
                        segment[key]
                            .as_f64()
                            .map(|seconds| ((seconds * fps).round() as i64).clamp(0, duration))
                            .ok_or(format!("each segment needs {key} (seconds)"))
                    };
                    Ok(edit_core::Segment {
                        start: at("start")?,
                        end: at("end")?,
                        kind: serde_json::from_value(segment["kind"].clone())
                            .map_err(|_| "kind is footage, captioned, narration or other")?,
                        note: segment["note"].as_str().unwrap_or_default().to_owned(),
                    })
                })
                .collect::<Result<_, String>>()?;
            given.retain(|segment| segment.end > segment.start);
            given.sort_by_key(|segment| segment.start);
            let segments = crate::subtitles::fill_segments(given, duration);
            let count = segments.len();
            store.update(&id, "agent", |project| {
                project.segments = segments;
                Ok(())
            })?;
            Ok(text(format!("{count} segments set (gaps are footage)")))
        }
        "mute_house_words" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let fps = live.project.fps();
            let from = args["start"]
                .as_f64()
                .map_or(0, |seconds| (seconds * fps).round() as i64);
            let to = args["end"]
                .as_f64()
                .map_or(live.project.duration(), |seconds| {
                    (seconds * fps).round() as i64
                });
            let neglect = args["neglect"].as_bool().unwrap_or(false);
            let summary = crate::subtitles::mute_house_words(app, &id, from, to, neglect).await?;
            Ok(text(format!(
                "muted {:.2}–{:.2}s: {}",
                from as f64 / fps,
                to as f64 / fps,
                serde_json::to_string(&summary).unwrap_or_default()
            )))
        }
        "watch_footage" => {
            let options = crate::watch::Options {
                force: args["force"].as_bool().unwrap_or(false),
                segments: args["segments"].as_bool(),
            };
            let summary = crate::diag::time_async(
                "watch",
                "watch footage",
                crate::watch::watch_footage(app, &id, options),
            )
            .await?;
            Ok(text(format!(
                "watched: {}",
                serde_json::to_string(&summary).unwrap_or_default()
            )))
        }
        "repack_subtitles" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let fps = live.project.fps();
            let from = args["start"]
                .as_f64()
                .map_or(0, |seconds| (seconds * fps).round() as i64);
            let to = args["end"]
                .as_f64()
                .map_or(live.project.duration(), |seconds| {
                    (seconds * fps).round() as i64
                });
            let options = crate::subtitles::Options {
                from,
                to,
                neglect: args["neglect"].as_bool().unwrap_or(false),
                hold_ms: args["hold_ms"]
                    .as_f64()
                    .filter(|hold| hold.is_finite() && (0.0..=3000.0).contains(hold))
                    .unwrap_or(crate::subtitles::DEFAULT_HOLD_MS),
                overlap: args["overlap"].as_bool().unwrap_or(false),
            };
            let summary = crate::subtitles::repack_subtitles(app, &id, options).await?;
            Ok(text(format!(
                "subtitled {:.2}–{:.2}s: {}",
                from as f64 / fps,
                to as f64 / fps,
                serde_json::to_string(&summary).unwrap_or_default()
            )))
        }
        "track_region" => {
            let time = args["time"].as_f64().ok_or("time is required")?;
            let region: Vec<f64> = args["box"]
                .as_array()
                .map(|values| values.iter().filter_map(Value::as_f64).collect())
                .unwrap_or_default();
            let follow = args["follow"].as_str().ok_or("follow is required")?;
            let [x0, y0, x1, y1] = region[..] else {
                return Err("box is [x0, y0, x1, y1]".into());
            };
            let place = args["place"].as_str().unwrap_or("on");
            let target = args["target"].as_str().unwrap_or("position");
            let offset = match args["offset"]
                .as_array()
                .map(|values| values.iter().filter_map(Value::as_f64).collect::<Vec<_>>())
            {
                Some(values) => match values[..] {
                    [dx, dy] => [dx, dy],
                    _ => return Err("offset is [dx, dy]".into()),
                },
                None => [0.0, 0.0],
            };
            let summary = crate::captions::follow_region(
                app,
                &id,
                time,
                [x0, y0, x1, y1],
                follow,
                place,
                target,
                offset,
            )
            .await?;
            Ok(text(summary))
        }
        "read_transcript" => {
            let live = store.get(&id).ok_or("project vanished")?;
            Ok(text(timeline_transcript(app, &live.project)))
        }
        "render_frame" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let frame = match (args["frame"].as_i64(), args["time"].as_f64()) {
                (Some(frame), _) => frame,
                (None, Some(time)) => (time * live.project.fps()).floor() as i64,
                _ => 0,
            };
            let max = args["max_size"].as_u64().unwrap_or(960) as u32;
            let images = app
                .frames
                .render(live.project.clone(), vec![frame], max)
                .await?;
            let rendered = images.first().ok_or("nothing was rendered")?;
            let png = encode_png(rendered)?;
            Ok(image(
                &png,
                format!("frame {frame} ({:.2}s)", frame as f64 / live.project.fps()),
            ))
        }
        "contact_sheet" => {
            let live = store.get(&id).ok_or("project vanished")?;
            let fps = live.project.fps();
            let start = args["start"].as_f64().ok_or("start is required")?;
            let end = args["end"].as_f64().ok_or("end is required")?.max(start);
            let count = args["count"].as_u64().unwrap_or(12).clamp(1, 24) as usize;
            let columns = args["columns"].as_u64().unwrap_or(4).clamp(1, 8) as u32;
            let frames: Vec<i64> = (0..count)
                .map(|index| {
                    let t = if count == 1 {
                        start
                    } else {
                        start + (end - start) * index as f64 / (count - 1) as f64
                    };
                    (t * fps).floor() as i64
                })
                .collect();
            let images = app
                .frames
                .render(live.project.clone(), frames.clone(), 480)
                .await?;
            let png = encode_png(&tile(&images, columns))?;
            let times: Vec<String> = frames
                .iter()
                .map(|frame| format!("{:.2}s", *frame as f64 / fps))
                .collect();
            Ok(image(
                &png,
                format!(
                    "{count} frames, left-to-right then down: {}",
                    times.join(", ")
                ),
            ))
        }
        "export" => {
            let options: crate::export::ExportOptions = args
                .get("options")
                .filter(|value| !value.is_null())
                .map(|value| serde_json::from_value(value.clone()))
                .transpose()
                .map_err(|error| format!("export options: {error}"))?
                .unwrap_or_default();
            if options.wait_for_smoothing
                && !crate::broll::wait_for_smoothing(&id, std::time::Duration::from_secs(120)).await
            {
                return Err("optional optical flow is still running; export the current timeline with wait_for_smoothing false or wait for it to finish".to_owned());
            }
            let live = store.get(&id).ok_or("project vanished")?;
            let path = args["path"]
                .as_str()
                .filter(|path| !path.trim().is_empty())
                .map(crate::server::expand_home)
                .unwrap_or_else(|| crate::server::default_export_path(&live.project));
            let subtitled = crate::subtitles::is_subtitled(&live.project);
            let path = app.exports.start(
                std::sync::Arc::clone(store),
                std::sync::Arc::clone(&app.library),
                live.project,
                options,
                path,
            )?;
            let mut said = format!("export started → {}", path.display());
            if subtitled {
                said.push_str(". A whole subtitled video is uploaded to the team's Subtitles folder on Google Drive when it's done; the link is then the project's drive.url (get_edit_context).");
            }
            Ok(text(said))
        }
        _ => Err(format!("unknown tool {name}")),
    }
}

fn review_frames(value: Option<&Value>) -> Result<Vec<i64>, String> {
    let frames: Vec<i64> = value
        .filter(|value| !value.is_null())
        .map(|value| serde_json::from_value(value.clone()))
        .transpose()
        .map_err(|error| format!("frames: {error}"))?
        .unwrap_or_default();
    if frames.len() > 24 || frames.iter().any(|frame| *frame < 0) {
        return Err("give at most 24 nonnegative integer frames".to_owned());
    }
    Ok(frames)
}

async fn with_review(
    app: &App,
    project: Project,
    frames: Vec<i64>,
    mut report: Value,
) -> Result<Value, String> {
    let mut content = Vec::new();
    if !frames.is_empty() {
        let reviewed = async {
            if frames.iter().any(|frame| *frame >= project.duration()) {
                return Err("a review frame is past the timeline's end".to_owned());
            }
            let images = app.frames.render(project, frames.clone(), 480).await?;
            let png = encode_png(&tile(&images, 4))?;
            Ok(image(
                &png,
                format!("Review frames, left to right then down: {frames:?}"),
            ))
        }
        .await;
        match reviewed {
            Ok(Value::Array(images)) => content.extend(images),
            Ok(_) => {}
            Err(error) => {
                if let Some(fields) = report.as_object_mut() {
                    fields.insert("review_error".to_owned(), json!(error));
                }
            }
        }
    }
    content.insert(0, json!({"type":"text", "text":serde_json::to_string(&report).map_err(|error| error.to_string())?}));
    Ok(Value::Array(content))
}

fn subtitle_coverage(app: &App, project: &Project) -> Value {
    let mut transcripts = std::collections::HashMap::new();
    for media in project
        .media
        .iter()
        .filter(|media| media.has_audio && media.kind == edit_core::MediaKind::Video)
    {
        let path = app
            .media
            .paths(std::path::Path::new(&media.path))
            .transcript;
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(transcript) = serde_json::from_slice::<crate::transcribe::Transcript>(&bytes)
            {
                transcripts.insert(media.id.clone(), transcript);
            }
        }
    }
    crate::edit_review::subtitle_coverage(project, &transcripts)
}

fn edit_context(app: &App, live: &crate::store::Live, args: &Value) -> Value {
    // Sized for a model's context: Codex cuts a tool's output at ~10k tokens,
    // and every token here is read again on each later request of the turn.
    const BUDGET: usize = 36_000;
    let p = &live.project;
    let fps = p.fps();
    let sections = edit_core::sections(p);
    let ids = args["clip_ids"].as_array();
    let span = match args["section"].as_str() {
        Some("intro") => sections.intro,
        Some("outro") => sections.outro,
        Some("story") => Some((
            sections.intro.map_or(0, |(_, end)| end),
            sections.outro.map_or(p.duration(), |(start, _)| start),
        )),
        _ => None,
    };
    let from = args["start"]
        .as_f64()
        .map(|t| (t * fps).round() as i64)
        .or(span.map(|(start, _)| start));
    let to = args["end"]
        .as_f64()
        .map(|t| (t * fps).round() as i64)
        .or(span.map(|(_, end)| end));
    let inside = |start: i64, end: i64| {
        !from.is_some_and(|from| end <= from) && !to.is_some_and(|to| start >= to)
    };
    let mut speakers: std::collections::BTreeMap<String, usize> = Default::default();
    let mut clips = Vec::new();
    let mut subtitles = 0;
    for clip in &p.clips {
        if let ClipContent::Text { style, .. } = &clip.content {
            if let Some(label) = &style.label {
                *speakers.entry(label.text.clone()).or_default() += 1;
            }
        }
        if ids.is_some_and(|ids| !ids.iter().any(|id| id.as_str() == Some(&clip.id)))
            || !inside(clip.start, clip.end())
        {
            continue;
        }
        if ids.is_some() {
            // Asked for by id: the whole clip, keyframes too.
            clips.push(json!(clip));
        } else if p.track(&clip.track).is_some_and(|track| track.subtitles) {
            subtitles += 1;
        } else {
            clips.push(json!(clip_row(p, clip)));
        }
    }
    let mut cut_ins = Vec::new();
    let mut footage = Vec::new();
    if let Some(script) = &p.script {
        for (index, block) in script.blocks.iter().enumerate() {
            match block {
                ScriptBlock::Narration {
                    text,
                    notes,
                    clip,
                    voiceover,
                } => {
                    let number = cut_ins.len() + 1;
                    let placed = clip
                        .as_deref()
                        .and_then(|id| p.clip(id))
                        .or_else(|| voiceover.as_deref().and_then(|id| p.clip(id)));
                    if placed.is_some_and(|placed| !inside(placed.start, placed.end())) {
                        cut_ins.push(Value::Null);
                        continue;
                    }
                    let words = voiceover
                        .as_deref()
                        .and_then(|id| p.clip(id))
                        .and_then(|clip| {
                            let ClipContent::Audio {
                                media,
                                source_in,
                                speed,
                                ..
                            } = &clip.content
                            else {
                                return None;
                            };
                            let media = p.media(media)?;
                            let transcript: crate::transcribe::Transcript = serde_json::from_slice(
                                &std::fs::read(
                                    app.media
                                        .paths(std::path::Path::new(&media.path))
                                        .transcript,
                                )
                                .ok()?,
                            )
                            .ok()?;
                            let to = source_in + clip.duration as f64 / fps * speed;
                            Some(
                                transcript
                                    .words
                                    .iter()
                                    .filter(|word| word.end > *source_in && word.start < to)
                                    .map(|word| {
                                        format!(
                                            "{}@{:.2}",
                                            word.text.trim(),
                                            clip.start as f64 / fps
                                                + (word.start - source_in) / speed
                                        )
                                    })
                                    .collect::<Vec<_>>()
                                    .join(" "),
                            )
                        });
                    cut_ins.push(json!({"cut_in": number, "text": text, "notes": notes, "card": clip, "voiceover": voiceover,
                        "start": placed.map(|clip| clip.start), "end": placed.map(|clip| clip.end()),
                        "words": words}));
                }
                ScriptBlock::Footage {
                    label, notes, clip, ..
                } => {
                    let placed = clip.as_deref().and_then(|id| p.clip(id));
                    if placed.is_some_and(|placed| inside(placed.start, placed.end())) {
                        footage.push(json!({"block": index, "label": label, "notes": notes, "clip": clip,
                            "start": placed.map(|clip| clip.start), "end": placed.map(|clip| clip.end())}));
                    }
                }
            }
        }
    }
    if ids.is_some() {
        // A revision's lookup: just those clips, and where things stand.
        return json!({"rev": live.rev, "duration_frames": p.duration(), "clips": clips,
            "audit": crate::edit_plan::audit(p)});
    }
    // Keep cut-in numbers stable when a span hides some.
    let cut_ins: Vec<Value> = cut_ins
        .into_iter()
        .filter(|cut_in| !cut_in.is_null())
        .collect();
    let tracks: Vec<String> = p
        .tracks
        .iter()
        .map(|track| {
            let mut row = format!(
                "{} {}",
                track.id,
                p.track_label(&track.id).unwrap_or_default()
            );
            for (on, word) in [
                (track.subtitles, "subtitles"),
                (track.hidden, "hidden"),
                (track.muted, "muted"),
                (track.locked, "locked"),
            ] {
                if on {
                    row.push(' ');
                    row.push_str(word);
                }
            }
            row
        })
        .collect();
    let media: Vec<String> = p
        .media
        .iter()
        .map(|media| {
            format!(
                "{} {:?} {:.1}s{} \"{}\"",
                media.id,
                media.kind,
                media.duration,
                if media.has_audio { " sound" } else { "" },
                // Long camera-export names end in hashes nobody reads.
                media.name.chars().take(60).collect::<String>()
            )
        })
        .collect();
    let mut context = json!({"rev":live.rev, "id":p.id, "settings":p.settings, "duration_frames":p.duration(),
        "times": "clip rows are `id track type [start,end) frames …`; cut-in words are word@timeline-seconds",
        "tracks":tracks, "sections":sections, "media":media, "speaker_line_counts":speakers,
        "subtitles_in_span": subtitles, "footage_blocks":footage, "cut_ins":cut_ins,
        "audit":crate::edit_plan::audit(p), "smoothing":crate::broll::smoothing_pending(&p.id)});
    if args["include_transcript"].as_bool().unwrap_or(false) {
        let heard = timeline_transcript(app, p);
        let heard = match (from, to) {
            (None, None) => heard,
            _ => heard
                .lines()
                .filter(|line| {
                    line_seconds(line)
                        .is_none_or(|at| inside((at * fps) as i64, (at * fps) as i64 + 1))
                })
                .collect::<Vec<_>>()
                .join("\n"),
        };
        // Half the budget at most, so the clips still fit beside it.
        let room = BUDGET / 2;
        let transcript = if heard.len() > room {
            let cut: String = heard.chars().take(room).collect();
            let cut = cut.rsplit_once('\n').map_or(cut.as_str(), |(kept, _)| kept);
            json!(format!(
                "{cut}\n[cut here: narrow with start/end for the rest]"
            ))
        } else {
            json!(heard)
        };
        if let Some(fields) = context.as_object_mut() {
            fields.insert("transcript".to_owned(), transcript);
        }
    }
    // Clips last, cut to what fits.
    let used = context.to_string().len();
    let mut room = BUDGET.saturating_sub(used);
    let total = clips.len();
    let mut kept = Vec::new();
    for clip in clips {
        let size = clip.to_string().len() + 1;
        if size > room && ids.is_none() {
            break;
        }
        room = room.saturating_sub(size);
        kept.push(clip);
    }
    if kept.len() < total {
        if let Some(fields) = context.as_object_mut() {
            fields.insert(
                "clips_cut".to_owned(),
                json!(format!(
                    "{} of {total} clips shown; narrow with section, start/end or clip_ids",
                    kept.len()
                )),
            );
        }
    }
    if let Some(fields) = context.as_object_mut() {
        fields.insert("clips".to_owned(), json!(kept));
    }
    context
}

/// The start of a transcript line ("[12.3] …" / "12.30 …"), in seconds.
fn line_seconds(line: &str) -> Option<f64> {
    line.trim_start_matches(['[', ' '])
        .split(|c: char| !(c.is_ascii_digit() || c == '.' || c == ':'))
        .next()
        .and_then(|at| {
            at.split(':').try_fold(0.0, |total, part| {
                part.parse::<f64>().ok().map(|n| total * 60.0 + n)
            })
        })
}

/// One clip as a line a model reads quickly: id, track, type, frames, what it
/// shows or plays, and which params are keyframed (not the keys).
fn clip_row(p: &Project, clip: &Clip) -> String {
    let value = serde_json::to_value(clip).unwrap_or_default();
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("?");
    let mut row = format!(
        "{} {} {kind} [{},{})",
        clip.id,
        p.track_label(&clip.track)
            .unwrap_or_else(|| clip.track.clone()),
        clip.start,
        clip.end()
    );
    if let Some(name) = &clip.name {
        row.push_str(&format!(" \"{name}\""));
    }
    match &clip.content {
        ClipContent::Video {
            media,
            source_in,
            speed,
            ..
        } => {
            row.push_str(&format!(" {media}@{source_in:.2}s"));
            if (*speed - 1.0).abs() > 1e-6 {
                row.push_str(&format!(" x{speed:.2}"));
            }
        }
        ClipContent::Audio {
            media,
            source_in,
            speed,
            volume_db,
            ..
        } => {
            row.push_str(&format!(" {media}@{source_in:.2}s {volume_db:+.1}dB"));
            if (*speed - 1.0).abs() > 1e-6 {
                row.push_str(&format!(" x{speed:.2}"));
            }
        }
        ClipContent::Text { text, style, .. } => {
            let short: String = text.chars().take(70).collect();
            row.push_str(&format!(" {:?}", short.replace('\n', " / ")));
            if let Some(label) = &style.label {
                row.push_str(&format!(" label {:?}", label.text));
            }
        }
        _ => {}
    }
    if let Some(link) = &clip.link {
        row.push_str(&format!(" link {link}"));
    }
    if !clip.keyframes.is_empty() {
        let params: Vec<&str> = clip.keyframes.keys().map(String::as_str).collect();
        row.push_str(&format!(" kf {}", params.join(",")));
    }
    row
}

/// Runs tool calls one after another for `batch`: "$N" arguments become the
/// id of the clip call N added.
async fn run_batch(app: &App, args: &Value, scope: Option<&str>) -> Result<Value, String> {
    const SLOW: &[&str] = &[
        "batch",
        "caption_speakers",
        "add_subtitles",
        "repack_subtitles",
        "watch_footage",
        "map_view",
        "place_voiceovers",
        "collect_images",
        "transcribe",
        "export",
    ];
    /// Tools that only look (or each touch just their own clip) and take a
    /// while: a run of these with no "$N" references goes side by side.
    const SIDE_BY_SIDE: &[&str] = &[
        "render_frame",
        "contact_sheet",
        "look_at_media",
        "measure_audio",
        "media_transcript",
        "find_in_footage",
        "read_transcript",
        "still_frame",
        "track_region",
        "case_articles",
        "read_page",
        "list_library",
    ];
    let calls = args["calls"].as_array().ok_or("calls must be a list")?;
    let keep_going = args["keep_going"].as_bool().unwrap_or(false);
    let mut added: Vec<Option<String>> = Vec::new();
    let mut content = Vec::new();
    let mut failures = 0;
    let run_one = |index: usize, added: &[Option<String>]| {
        let call_spec = calls.get(index).unwrap_or(&Value::Null);
        let name = call_spec["tool"].as_str().unwrap_or_default().to_owned();
        let mut call_args = call_spec.get("args").cloned().unwrap_or_else(|| json!({}));
        let ready = if SLOW.contains(&name.as_str()) {
            Err(format!("{name} can't run in a batch; call it on its own"))
        } else {
            resolve_refs(&mut call_args, added)
        };
        async move {
            match ready {
                Ok(()) => {
                    Box::pin(crate::diag::time_async(
                        "agent",
                        &format!("tool {name}"),
                        call(app, &name, &call_args, scope),
                    ))
                    .await
                }
                Err(error) => Err(error),
            }
        }
    };
    let independent = |index: usize| {
        let spec = calls.get(index).unwrap_or(&Value::Null);
        SIDE_BY_SIDE.contains(&spec["tool"].as_str().unwrap_or_default())
            && !has_refs(spec.get("args").unwrap_or(&Value::Null))
    };
    let mut ready: std::collections::VecDeque<(usize, Result<Value, String>)> = Default::default();
    let mut index = 0;
    while index < calls.len() {
        let name = calls
            .get(index)
            .and_then(|call| call["tool"].as_str())
            .unwrap_or_default();
        let result = if let Some((_, result)) = ready.pop_front() {
            result
        } else if independent(index) {
            // This call and the independent ones right after it, three at a time.
            let mut end = index;
            while end < calls.len() && independent(end) {
                end += 1;
            }
            use futures_util::StreamExt as _;
            let results: Vec<Result<Value, String>> =
                futures_util::stream::iter((index..end).map(|at| run_one(at, &added)))
                    .buffered(3)
                    .collect()
                    .await;
            ready.extend((index..end).zip(results));
            ready
                .pop_front()
                .map(|(_, result)| result)
                .unwrap_or_else(|| Err("lost".into()))
        } else {
            run_one(index, &added).await
        };
        let label = format!("[{}] {name}: ", index + 1);
        index += 1;
        match result {
            Ok(Value::Array(items)) => {
                added.push(items.iter().find_map(added_clip));
                for mut item in items {
                    if let Some(fields) = item.as_object_mut() {
                        if let Some(said) = fields.get("text").and_then(Value::as_str) {
                            let said = format!("{label}{said}");
                            fields.insert("text".to_owned(), json!(said));
                        }
                    }
                    content.push(item);
                }
            }
            Ok(other) => {
                added.push(None);
                content.push(json!({ "type": "text", "text": format!("{label}{other}") }));
            }
            Err(error) => {
                added.push(None);
                failures += 1;
                content.push(json!({ "type": "text", "text": format!("{label}FAILED: {error}") }));
                if !keep_going {
                    // Calls that already ran beside this one still report.
                    while let Some((at, result)) = ready.pop_front() {
                        let label = format!(
                            "[{}] {}: ",
                            at + 1,
                            calls
                                .get(at)
                                .and_then(|call| call["tool"].as_str())
                                .unwrap_or_default()
                        );
                        let said = match result {
                            Ok(Value::Array(items)) => items
                                .iter()
                                .filter_map(|item| item["text"].as_str())
                                .collect::<Vec<_>>()
                                .join(" "),
                            Ok(other) => other.to_string(),
                            Err(error) => format!("FAILED: {error}"),
                        };
                        content.push(json!({ "type": "text", "text": format!("{label}{said}") }));
                        index = at + 1;
                    }
                    if index < calls.len() {
                        content.push(json!({ "type": "text", "text": format!("stopped; calls {} to {} didn't run", index + 1, calls.len()) }));
                    }
                    break;
                }
            }
        }
    }
    if failures > 0 && failures == calls.len() {
        let said: Vec<&str> = content
            .iter()
            .filter_map(|item| item["text"].as_str())
            .collect();
        return Err(said.join("\n"));
    }
    Ok(Value::Array(content))
}

/// The clip an add_clip / add_text result names ("added clip c12").
fn added_clip(item: &Value) -> Option<String> {
    let said = item["text"].as_str()?;
    let rest = said
        .strip_prefix("added clip ")
        .or_else(|| said.strip_prefix("added text clip "))?;
    rest.split_whitespace().next().map(str::to_owned)
}

/// Whether `value` holds a "$N" reference to an earlier call's clip.
fn has_refs(value: &Value) -> bool {
    match value {
        Value::String(said) => said
            .strip_prefix('$')
            .is_some_and(|n| n.parse::<usize>().is_ok()),
        Value::Array(items) => items.iter().any(has_refs),
        Value::Object(fields) => fields.values().any(has_refs),
        _ => false,
    }
}

/// Replaces "$N" strings with the clip call N added.
fn resolve_refs(value: &mut Value, added: &[Option<String>]) -> Result<(), String> {
    match value {
        Value::String(said) => {
            if let Some(number) = said.strip_prefix('$').and_then(|n| n.parse::<usize>().ok()) {
                let clip = number
                    .checked_sub(1)
                    .and_then(|index| added.get(index))
                    .ok_or_else(|| format!("${number}: there's no earlier call {number}"))?
                    .clone()
                    .ok_or_else(|| format!("${number}: call {number} added no clip"))?;
                *said = clip;
            }
            Ok(())
        }
        Value::Array(items) => items
            .iter_mut()
            .try_for_each(|item| resolve_refs(item, added)),
        Value::Object(fields) => fields
            .values_mut()
            .try_for_each(|item| resolve_refs(item, added)),
        _ => Ok(()),
    }
}

/// Words heard on the timeline (audio clips on unmuted tracks), as phrases with
/// timeline times. A phrase breaks on a pause or a change of voice.
fn timeline_transcript(app: &App, project: &Project) -> String {
    let fps = project.fps();
    let mut words: Vec<(f64, String, Option<String>)> = Vec::new();
    let mut missing = Vec::new();
    for clip in &project.clips {
        let ClipContent::Audio {
            media,
            source_in,
            speed,
            ..
        } = &clip.content
        else {
            continue;
        };
        if project.track(&clip.track).is_some_and(|track| track.muted) {
            continue;
        }
        let Some(source) = project.media(media) else {
            continue;
        };
        let path = app
            .media
            .paths(std::path::Path::new(&source.path))
            .transcript;
        let Some(transcript) = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<crate::transcribe::Transcript>(&bytes).ok())
        else {
            if !missing.contains(&source.name) {
                missing.push(source.name.clone());
            }
            continue;
        };
        let from = *source_in;
        let to = source_in + clip.duration as f64 / fps * speed;
        for word in transcript
            .words
            .iter()
            .filter(|word| word.start >= from && word.start < to)
        {
            let at = clip.start as f64 / fps + (word.start - from) / speed;
            // Named voices ("Officer") read better than Scribe's numbers.
            let speaker = word.speaker.as_ref().map(|voice| {
                transcript
                    .speakers
                    .get(voice)
                    .cloned()
                    .unwrap_or_else(|| voice.clone())
            });
            words.push((at, word.text.clone(), speaker));
        }
    }
    words.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out = String::new();
    let mut last: Option<(f64, Option<String>)> = None;
    for (at, word, speaker) in words {
        let breaks = last
            .as_ref()
            .is_none_or(|(previous, voice)| at - previous > 0.8 || *voice != speaker);
        if breaks {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&format!("[{at:.2}s]"));
            if let Some(voice) = &speaker {
                out.push_str(&format!(" ({voice})"));
            }
        }
        out.push(' ');
        out.push_str(&word);
        last = Some((at, speaker));
    }
    if out.is_empty() {
        out.push_str("No transcribed speech on the timeline.");
    }
    if !missing.is_empty() {
        out.push_str(&format!("\n\nNot transcribed yet: {}.", missing.join(", ")));
    }
    out
}

/// Lowest track of `kind` free over [start, end); adds a track when none is.
/// Text and graphics prefer tracks above the main footage.
/// Moves clips down onto the track below wherever it's empty for the clip's
/// whole span, so nothing floats above a gap; clips that overlap in time keep
/// their order. The first track of each kind (the footage) is left as it is.
/// Then drops tracks left empty. Returns (clips moved, tracks removed).
pub(crate) fn tidy_tracks(project: &mut Project) -> (usize, usize) {
    let mut moved = 0;
    loop {
        let mut changed = false;
        for kind in [TrackKind::Video, TrackKind::Audio] {
            // The subtitles keep their own track: nothing moves onto it or off it.
            let tracks: Vec<(String, bool)> = project
                .tracks
                .iter()
                .filter(|track| track.kind == kind && !track.subtitles)
                .map(|track| (track.id.clone(), track.locked))
                .collect();
            // From the second track up, each onto the one below (never into the first).
            for pair in tracks.windows(2).skip(1) {
                let [(below, below_locked), (here, here_locked)] = pair else {
                    continue;
                };
                if *below_locked || *here_locked {
                    continue;
                }
                let ids: Vec<String> = project
                    .clips
                    .iter()
                    .filter(|clip| &clip.track == here)
                    .map(|clip| clip.id.clone())
                    .collect();
                for id in ids {
                    let (start, end) = match project.clip(&id) {
                        Some(clip) => (clip.start, clip.end()),
                        None => continue,
                    };
                    let free = !project.clips.iter().any(|other| {
                        &other.track == below && other.start < end && start < other.end()
                    });
                    if free {
                        if let Some(clip) = project.clip_mut(&id) {
                            clip.track = below.clone();
                        }
                        moved += 1;
                        changed = true;
                    }
                }
            }
        }
        if !changed {
            break;
        }
    }
    let before = project.tracks.len();
    let firsts: Vec<String> = [TrackKind::Video, TrackKind::Audio]
        .iter()
        .filter_map(|kind| project.tracks.iter().find(|track| track.kind == *kind))
        .map(|track| track.id.clone())
        .collect();
    let used: std::collections::HashSet<String> = project
        .clips
        .iter()
        .map(|clip| clip.track.clone())
        .collect();
    project
        .tracks
        .retain(|track| firsts.contains(&track.id) || used.contains(&track.id) || track.subtitles);
    (moved, before - project.tracks.len())
}

pub(crate) fn free_track(project: &mut Project, kind: TrackKind, start: i64, end: i64) -> String {
    free_track_from(
        project,
        kind,
        usize::from(kind == TrackKind::Video),
        start,
        end,
    )
}

/// The lowest track of `kind` free for the span, after the first `skip` of them.
/// How a sound is placed.
struct Sound {
    volume_db: f32,
    /// Plays at most this long: for a sound with a hit, the stretch around
    /// it, `lead` seconds before it (default half).
    seconds: Option<f64>,
    lead: Option<f64>,
    /// Seconds of fade at the end.
    fade_out: f64,
    color: ClipColor,
}

/// Places a sound already in the project's media at timeline times (seconds)
/// on a free audio track, its "hit" marker (else its start) on each time.
/// The same sound already within 0.5 s of a time gives way. `markers` are
/// given to the media if it has none yet.
fn place_sound(
    store: &crate::store::Store,
    id: &str,
    media_id: &str,
    name: &str,
    markers: Vec<edit_core::Marker>,
    times: &[f64],
    sound: Sound,
) -> Result<String, String> {
    let (_, (placed, replaced)) = store.update(id, ORIGIN, |project| {
        let fps = project.fps();
        let media = project
            .media
            .iter_mut()
            .find(|media| media.id == media_id)
            .ok_or("sound media vanished")?;
        // The sound's markers come with it (kept if the user has moved them).
        if media.markers.is_empty() {
            media.markers = markers;
        }
        let hit = media
            .markers
            .iter()
            .find(|marker| marker.name == crate::sfx::HIT)
            .or(media.markers.first())
            .map_or(0.0, |marker| marker.time);
        // Trimmed, a sound with a hit keeps the stretch around it.
        let from = match sound.seconds {
            Some(seconds) if hit > 0.0 => (hit - sound.lead.unwrap_or(seconds / 2.0)).max(0.0),
            _ => 0.0,
        };
        let mut length = (((media.duration - from) * fps).floor() as i64).max(1);
        if let Some(seconds) = sound.seconds {
            length = length.min(((seconds * fps).round() as i64).max(1));
        }
        let mut placed = Vec::new();
        let mut replaced = 0;
        for time in times {
            // This sound already near the time (any version of it) gives way to the new one.
            let (near0, near1) = (((time - 0.5) * fps) as i64, ((time + 0.5) * fps) as i64);
            let before = project.clips.len();
            project.clips.retain(|clip| {
                !(clip.name.as_deref() == Some(name)
                    && matches!(clip.content, ClipContent::Audio { .. })
                    && clip.start < near1
                    && clip.end() > near0)
            });
            replaced += before - project.clips.len();
            // Its hit marker lands on the time given.
            let mut start = ((time - (hit - from)) * fps).round() as i64;
            let mut duration = length;
            let mut source_in = from;
            // A hit on frame 0: drop the bit before it.
            if start < 0 {
                source_in = from - start as f64 / fps;
                duration += start;
                start = 0;
            }
            if duration < 1 {
                continue;
            }
            // Never on A1: that's the footage's own sound.
            let track = free_track_from(project, TrackKind::Audio, 1, start, start + duration);
            let clip_id = project.fresh_id("c");
            project.clips.push(Clip {
                id: clip_id,
                track,
                start,
                duration,
                color: sound.color,
                name: Some(name.to_owned()),
                link: None,
                fade_in: 0,
                fade_out: ((sound.fade_out * fps).round() as i64).min(duration),
                keyframes: Default::default(),
                content: ClipContent::Audio {
                    media: media_id.to_owned(),
                    source_in,
                    speed: 1.0,
                    volume_db: sound.volume_db,
                    mutes: Vec::new(),
                },
            });
            placed.push(format!("{time:.2}s"));
        }
        Ok((placed, replaced))
    })?;
    Ok(format!(
        "placed {name} at {} (replacing {replaced} already near those times)",
        placed.join(", ")
    ))
}

fn free_track_from(
    project: &mut Project,
    kind: TrackKind,
    skip: usize,
    start: i64,
    end: i64,
) -> String {
    let busy = |project: &Project, track: &str| {
        project
            .clips
            .iter()
            .any(|clip| clip.track == track && clip.start < end && start < clip.end())
    };
    let candidates: Vec<String> = project
        .tracks
        .iter()
        .filter(|track| track.kind == kind && !track.subtitles)
        .skip(skip)
        .map(|track| track.id.clone())
        .collect();
    for track in candidates {
        if !busy(project, &track) {
            return track;
        }
    }
    project.add_track(kind)
}

/// RFC 7386 JSON merge patch.
pub(crate) fn merge(target: &mut Value, patch: &Value) {
    let Some(patch) = patch.as_object() else {
        if !patch.is_null() {
            *target = patch.clone();
        }
        return;
    };
    if !target.is_object() {
        *target = json!({});
    }
    let Some(object) = target.as_object_mut() else {
        return;
    };
    for (key, value) in patch {
        if value.is_null() {
            object.remove(key);
        } else {
            merge(object.entry(key.clone()).or_insert(Value::Null), value);
        }
    }
}

/// Closes the spans `gone` left where nothing else plays: everything after
/// each slides back by its length, all tracks together. Returns frames closed.
fn close_gaps(project: &mut Project, gone: &[Clip]) -> i64 {
    let mut spans: Vec<(i64, i64)> = gone.iter().map(|clip| (clip.start, clip.end())).collect();
    spans.sort_unstable();
    let mut merged: Vec<(i64, i64)> = Vec::new();
    for (start, end) in spans {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    let mut closed = 0;
    // Latest first, so closing one never moves another.
    for (start, end) in merged.into_iter().rev() {
        if project
            .clips
            .iter()
            .any(|clip| clip.start < end && clip.end() > start)
        {
            continue;
        }
        let length = end - start;
        for clip in &mut project.clips {
            if clip.start >= end {
                clip.start -= length;
            }
        }
        for mark in [&mut project.mark_in, &mut project.mark_out]
            .into_iter()
            .flatten()
        {
            if *mark >= end {
                *mark -= length;
            } else if *mark > start {
                *mark = start;
            }
        }
        closed += length;
    }
    closed
}

#[cfg(test)]
mod tests {
    use super::{
        added_clip, close_gaps, merge, resolve_refs, tidy_tracks, Clip, Project, TrackKind,
    };
    use serde_json::json;

    #[test]
    fn tidy_tracks_drops_layers_into_gaps_and_keeps_their_order() {
        let mut project = Project::new("p".into(), "t".into(), Default::default());
        project.tracks.clear();
        let [v1, v2, v3, v4] = [(); 4].map(|_| project.add_track(TrackKind::Video));
        project.add_track(TrackKind::Audio);
        let clip = |id: &str, track: &str, start: i64, duration: i64| {
            serde_json::from_value::<Clip>(json!({
                "id": id, "track": track, "start": start, "duration": duration,
                "type": "solid", "fill": [0, 0, 0, 1]
            }))
            .unwrap()
        };
        project.clips = vec![
            clip("footage", &v1, 0, 100),
            // A caption alone on V3 with V2 empty under it: drops to V2.
            clip("caption", &v3, 0, 20),
            // A flash on V4 over a title on V2: drops to V3 (still above the title), not onto it.
            clip("title", &v2, 40, 30),
            clip("flash", &v4, 50, 5),
        ];
        let (moved, removed) = tidy_tracks(&mut project);
        let track_of = |id: &str| project.clip(id).unwrap().track.clone();
        assert_eq!(track_of("footage"), v1);
        assert_eq!(track_of("caption"), v2);
        assert_eq!(track_of("title"), v2);
        assert_eq!(track_of("flash"), v3);
        assert_eq!((moved, removed), (2, 1));
        assert!(!project.tracks.iter().any(|track| track.id == v4));
    }

    #[test]
    fn closing_a_gap_moves_every_track_together() {
        let mut project = Project::new("p".into(), "t".into(), Default::default());
        let clip = |id: &str, track: &str, start: i64, duration: i64| {
            serde_json::from_value::<Clip>(json!({
                "id": id, "track": track, "start": start, "duration": duration,
                "type": "solid", "fill": [0, 0, 0, 1]
            }))
            .unwrap()
        };
        let (v1, v2) = (project.tracks[0].id.clone(), project.tracks[1].id.clone());
        let heading = [clip("card", &v1, 0, 90), clip("words", &v2, 0, 90)];
        project.clips = vec![clip("footage", &v1, 90, 100), clip("caption", &v2, 120, 30)];
        project.mark_out = Some(150);
        assert_eq!(close_gaps(&mut project, &heading), 90);
        assert_eq!(project.clip("footage").unwrap().start, 0);
        assert_eq!(project.clip("caption").unwrap().start, 30);
        assert_eq!(project.mark_out, Some(60));
        // Something still playing in the span keeps it open.
        let mut project = Project::new("p".into(), "t".into(), Default::default());
        project.clips = vec![clip("music", &v2, 0, 300), clip("footage", &v1, 90, 100)];
        assert_eq!(close_gaps(&mut project, &[clip("card", &v1, 0, 90)]), 0);
        assert_eq!(project.clip("footage").unwrap().start, 90);
    }

    #[test]
    fn merge_patch_follows_rfc_7386() {
        let mut value = json!({ "a": 1, "style": { "size": 10, "glow": { "enabled": false } } });
        merge(
            &mut value,
            &json!({ "a": null, "style": { "glow": { "enabled": true } }, "b": [1] }),
        );
        assert_eq!(
            value,
            json!({ "style": { "size": 10, "glow": { "enabled": true } }, "b": [1] })
        );
    }

    #[test]
    fn batch_refs_become_the_clips_earlier_calls_added() {
        let added = vec![
            added_clip(&json!({ "type": "text", "text": "added clip c12" })),
            added_clip(&json!({ "type": "text", "text": "set opacity keyframes on c12" })),
            added_clip(&json!({ "type": "text", "text": "added text clip c13" })),
        ];
        assert_eq!(
            added,
            vec![Some("c12".to_owned()), None, Some("c13".to_owned())]
        );
        let mut args = json!({ "clip_id": "$1", "follow": ["$3", "$x", "c9"], "n": 2 });
        resolve_refs(&mut args, &added).unwrap();
        assert_eq!(
            args,
            json!({ "clip_id": "c12", "follow": ["c13", "$x", "c9"], "n": 2 })
        );
        assert!(resolve_refs(&mut json!("$2"), &added).is_err());
        assert!(resolve_refs(&mut json!("$4"), &added).is_err());
    }
}

#[cfg(test)]
mod reference_tests {
    #[test]
    fn tool_reference_is_one_short_line_per_tool() {
        let reference = super::tool_reference();
        println!("{reference}");
        assert_eq!(reference.lines().count(), super::tools().len());
        assert!(reference.contains("- apply_edit_plan(base_rev: integer, operations: array, "));
        assert!(reference.len() < 16_000, "{} chars", reference.len());
    }
}
