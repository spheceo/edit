// What the agent is taught for each kind of video (a project's style:
// bodycam, interrogation, courtroom). They all share the house
// style (the MCP instructions and the skills) for now. A style's own rules go
// in its guide: `notes` are added to the agent's instructions, and `skills`
// are added to the shared ones (one with a shared skill's name replaces it
// for that style), so the effects stay the same and what the agent picks
// from them can differ.

import { STYLES, type Style } from "./model.ts";
import * as skills from "./skills.ts";
import type { Skill } from "./skills.ts";

export interface Guide {
  /** Rules for this kind of video only, read after the house style. */
  notes: string;
  /** Its own skills, and its versions of shared ones. */
  skills: readonly Skill[];
}

// Learnt from the team's reference, Sam's Interrogations' "'Friendly' Cop
// Has No Idea Colleagues Know His Darkest Secret" (youtu.be/4mqGp1IgqEw).
const INTERROGATION: Guide = {
  notes: `INTERROGATION VIDEOS: a fixed camera on an interview room, the person questioned facing it, the detectives mostly with their backs to it. The video is that footage, mostly raw: stretches of one to three minutes as the Doc's ranges cut them, between short narration bridges (7–30 s) that say what the footage doesn't.
- SEVERAL CASES: a script can be a compilation ("four cases we'll take a look at today"). Each case has its own footage file, research, date cut-in (its first narration after the intro or after "Moving on to the next case…") and outcome narration ("…was charged with…, sentenced to…"), which is that case's outro wherever it sits (outro skill). get_edit_context's sections know one intro, story and outro: work case by case with start/end. A narration whose note says "Reuse: <link>" is followed by a finished video of ours: the import puts it on after that narration whole and as it is (a footage clip labelled "Reuse (the whole video)"; its subtitles, graphics and music are burned in): nothing over it, no flash out of it, and set_segments marks its span captioned before repack_subtitles.
- "Note to editor: Blur this" on a narration word ("murder", "killer", "killed") never means a blur on the picture: the word is censored, starred wherever it's on screen (a letter or two kept: "m****r", "k****d", "bl**d") and muted in the voice-over (final-pass). Murder, blood and strip are starred in every text on screen even unmarked.
- No speaker captions and no name labels: Repack's positional subtitles carry every line said in the footage, the intro's teasers too (subtitles skill). No vertical drops, shakes, glitches or dips: every narration is entered and left with THE BRIDGE FLASH, and everything else is a hard cut (transitions skill).
- AFTER THE INTRO the footage plays clean, as in bodycam: no punch-ins or effects on it; only the bridges and outros get treatment.
- NARRATION BRIDGES (the cut-ins) are covered with cover_cut_in as usual (shots changing on the narration's phrases, each moment once, never ahead of the story), but with look: false (natural colour), into: "none" (the bridge flash replaces the drop), speed 1 and push [1, 1.06]. The B-roll is mostly the interrogation itself: other moments of the same room (the person questioned listening, rubbing their face, a detective sliding a photo across; another camera angle when the file has one), never a moment before it has played (a confession, a breakdown, a photo being shown); then the case's own pictures where the words name them (the scene, the evidence, a victim, a mugshot), and map_view for a place. The room's sound is gone under the narration.
- PICTURES: a person's photo (a victim; the person questioned before their arrest) goes on as an evidence card labelled "Name, age" ("Jenny Gamez, 19"), a thing's with a few words. While someone in the room talks about what a picture shows (the suitcase, the victims), in the intro or under a bridge, a PHOTO WINDOW pops up over the running footage: the image as a video clip with frame {width 6, color [0.15,0.15,0.16,1], shadow 0.6}, its height ~40% of the frame's, in a top corner clear of every face (two victims: one each side of the person), coming in with scale keyframes 0.92 → 1 over 4 frames (ease out) and fade_in 3, leaving with fade_out 4 at the end of the phrase. Never over a face, never more than two at once. A body or remains in a scene shot or photo gets a blur over it (rect) and the shot stays short.
- NAME CALLOUT, once per person questioned, when the narration first names them over their footage ("This is Steven Zelich…"): their full name and age ("Steven Mark Zelich, 54") small, up and to the side of their head: white Geist 500 ~26 at 1080p, glow off, background {color [0,0,0,1], opacity 0.8, pad_x 10, pad_y 6}, typed on (animation typewriter, stagger 1), a thin white leader from the neck (leader {color [1,1,1,0.9], width 2, attach "side"}; track_region target "leader" on their face, the label following them), held ~3 s, fade_out 6. Not bodycam's red-bordered label, and no vignette. A detective the narration introduces by name gets the same with their role ("Det. Nicona Cordero").
- THE CLOSING LINE ON SCREEN: a bridge's last sentence (the one ending "…" that hands back to the footage) can be typed on screen as the narrator says it: the picture under it blurred and darkened (an adjustment {grade {exposure -1.2}, blur {radius ~40 at 1080p}} over its span, beneath the text), white Geist 700 ~62 at 1080p, centred, max_width 0.8*width, glow {enabled, color null, radius 18, strength 0.5}, no box, animation typewriter with stagger = the frames it takes to say ÷ its characters (it types in step with the voice), held to the bridge's end. Two or three a video, on the strongest hooks; never every bridge.
- MUSIC (with the music-and-sound skill): under the intro, the narration and the outros only: a low dark drone or pulse that comes in with a bridge's flash and fades out (~1 s) across the flash back into the room. The raw interrogation has no music: the room's own sound carries it.`,
  skills: [
    {
      name: "edit-workflow",
      body: `THE EDITING WORKFLOW (interrogation video): the whole edit, start to finish, in this one turn, when the user asks for it; whatever else their message says steers every stage. Work through every stage without stopping to ask: decide yourself, and keep a short list of what you weren't sure about for the summary. Watching the footage started in the background when you loaded this skill.

The whole edit should take minutes, not hours: a handful of tool calls per stage. Per stage: load its skill (once), get_edit_context narrowed to the stage (start/end per case in a compilation), decide everything, apply the timeline changes in one apply_edit_plan and the tools that place sounds, images or text in one batch, look once (review_frames on the plan, or one contact_sheet), fix only concrete defects in one more call, then go on. Never re-read what you've read or re-check unchanged work; wait for slow tools in long blocks (yield_time_ms 30000 or more). In a compilation, do a stage for every case before the next stage.

The stages, in order:
1. RESEARCH (skill research), per case: the date and place (for its map), each person questioned and their age, the job or badge the case turns on (years on the force, the department), each victim's name and age, the outcome as the articles word it (charges, plea, verdict, sentence, with the source), each person questioned's mugshot, a photo of each adult victim, and pictures of the scene and evidence the narration names. A minor is never shown.
2. THE INTRO (skills intro, transitions): static punch-ins on the teasers, the narration hooks covered, the first name callout and photo windows, the bridge flashes and their sound.
3. THE BRIDGES (skills cut-ins, transitions): every narration between the intro and the end. Each case's date cut-in (map_view, date_title, place_label), then each bridge covered with cover_cut_in the interrogation way (the style's rules), its name callout, photo windows and, on the strongest hooks, the closing line on screen; the bridge flash in and out of each. One find_in_footage per case (a phrase per idea in its narration) finds the shots; look_at_media only where the words don't settle what's on screen.
4. THE OUTROS (skill outro): each case's resolution screen on its outcome narration, the bridge into the next case, and where the video ends.
5. SUBTITLES (skill subtitles): watch_footage (cached by now, usually), then repack_subtitles over the whole timeline with overlap: true.
6. MUSIC AND SOUND (skill music-and-sound): the case's tone, beds under the intro, the narration and the outros only, every bridge flash heard, in one batch of add_from_library calls with under_speech.
7. THE FINAL PASS (skill final-pass).

Then finish with a short summary: the edit's length, its cases and sections, the outcomes used and where they came from, and everything you weren't sure about.`,
    },
    {
      name: "intro",
      body: `- The INTRO (interrogation) is the hook: teaser lines from the interrogations (the Doc's first ranges) with short narration hooks between them (in a compilation, a hook per case and one saying how many there are), up to the first case's backstory narration. Each teaser ends on a finished sentence (the footage-range rule).
  - It opens straight on the first teaser line: no opening dip.
  - Each teaser is a STATIC PUNCH-IN on the person questioned: scale ~1.3 (1.25–1.4), x/y so their head and shoulders sit a little off centre with room beside the head for their subtitle, no scale keyframes (nothing zooms in motion). Teasers from one exchange are hard cuts; alternate the crop a little between consecutive teasers, or play one wide, so a cut doesn't jump.
  - The narration hooks are covered like bridges (the style's NARRATION BRIDGES): the room at other moments, the NAME CALLOUT the first time the narration names the person questioned ("This is Steven Zelich…"), PHOTO WINDOWS as it names the victims. Under a teaser line that names a thing ("I had a big black suitcase"), its photo window pops up as it's said.
  - THE BRIDGE FLASH (transitions) into and out of each hook, with its sound; hard cuts everywhere else.
  - No speaker captions (never caption_speakers): Repack's subtitles cover the teasers in the subtitles stage.
- The first case's backstory narration ("In 1986, a young nurse…", "On February 23, 2017…") is its DATE CUT-IN (cut-ins skill: map_view of the place, date_title, place_label), entered with the bridge flash.`,
    },
    {
      name: "transitions",
      body: `- TRANSITIONS (interrogation) are few and the same on purpose: THE BRIDGE FLASH into and out of every narration (hook, bridge, outro) and nowhere else; hard cuts everywhere else (between teasers of one exchange, between B-roll shots, between the Doc's ranges in the raw footage, between an outro's pages). No vertical drops, shakes, glitches, dips or shutter flashes. The repetition is the style: name each "Bridge flash" (the audit's repetitive_transitions doesn't count it).
- THE BRIDGE FLASH: a warm burn-out, not a white card: apply_edit_plan op transition {kind "burn", at: the cut's frame} builds it (an adjustment named "Bridge flash", 12 frames straddling the cut, on a track above everything there: the picture burns out warm to near white on the cut, a little light leak sweeping across, and comes back). One op per cut, all of a stage's in its one plan.
- EVERY BRIDGE FLASH IS HEARD: a whoosh or a short riser landing on the cut, about 4 LU under the speech around it; into a new case (its date cut-in) a riser building ~1 s into it, the music changing on the cut. Out of a bridge back into the room the music fades out across the flash, so the room's sound comes back clean. A photo window popping up gets a soft click (~8 LU under); never a sound on a cut within the footage.`,
    },
    {
      name: "outro",
      body: `- THE OUTRO (interrogation) of each case is its outcome narration ("…was charged with…", "…sentenced to…"), wherever it sits. It gets one RESOLUTION SCREEN per person questioned, as long as the narration talks about them, laid out like bodycam's charges screen but with the narration's own words instead of a charges list:
  - Left: their mugshot (research; else a clear frame of them from the footage with still_frame), filling the frame's height and no more, the face centred in the clear left space (x so the face's centre lands at ~14% of the frame width), a slow push-in (×1.04, linear), an adjustment {grade {saturation -0.3}} over it only, and a black gradient solid {fill [0,0,0,1], gradient {from 0.3, to 0.42}} above it.
  - Right: the narration's sentences typed on in red as they're said: Geist 700 ~48 at 1080p, color [1,0.08,0.08,1], glow {enabled, color null, radius 26, strength 0.85}, line_height 1.15, align left, the block's left edge at ~49% of the width and its top at ~17% of the height, max_width ~0.42*width, no box; animation typewriter with stagger = the frames the words take to say ÷ their characters, starting on its first word. A page is a sentence or two (up to ~5 lines); the next page replaces it on a hard cut as the narration moves on. The narration's exact words (its script text), starred: the Doc's Blur this words and the house words ("m****r"). No "Charges:" heading, no list, no name.
  - Its last ~3–4 s: the mugshot alone, full frame and centred (no gradient, no text), a slow push-in (1 → 1.05, linear) to the end of the case's last word.
  - Into the screen, the bridge flash; between pages, hard cuts. A soft low hit as the first page starts typing, ~6 LU under the voice-over.
- In a compilation the next narration ("Moving on to the next case, where…") follows: a bridge covered with the next case's room or place, entered with the bridge flash, the music carrying across.
- The video ends when the last case's outcome narration ends (its last word, plus at most a couple of frames: trim every clip there, the music fading out ~1.5 s by then), or at the end of the reused video when the Doc reuses one. The plan's audit gives the new duration.`,
    },
    {
      name: "subtitles",
      body: `- SUBTITLES (interrogation) are Repack's positional ones, over every line said in the footage, the intro's teasers too: first watch_footage (it corrects who says each line; on an edit it leaves the segments alone), then repack_subtitles over the whole timeline (no start/end) with overlap: true (faces stays on). That gives Montserrat in each speaker's colour with a glow in a 75% black box, no name label; the person questioned's lines by their face (the camera angle's seat), a detective with their back to the camera bottom middle, people talking over each other stacked, each line held a second after its last word. neglect: true only where violence against a child is the story. Never add_subtitles, labels, caption_speakers or place_subtitles in this kind of video (they'd change the style or move Repack's places). Narration is a voice-over, not footage: it gets none. A reused finished video (a Reuse note) is set captioned with set_segments first.
- COLOURS are Repack's code, set from each voice's role: one person, one colour, across every file, except THE PERSON QUESTIONED, who is red as in the reference ([0.92,0.16,0.16,1]): one update_clips {person: their name in the cast, patch: {style: {color}}} recolours all their lines at once (and anyone else's near red is moved off it). Two people in near shades get one changed the same way; never pink or magenta for a detective or officer. One person under two names (a detective who is "Officer" in one stretch) gets one colour.
- After the run read the speakers it returns (an "Other" in the room is usually a real person: give them their colour), look only at watch_footage's doubtful lines (look_at_media at all their times in one call, fix the wrong ones in one update), and read the mutes it returns back to the user. A line held past a cut into a bridge (the audit's subtitle_past_cut) ends at the cut. If footage changes later, run repack_subtitles again (it replaces its own).
- SUBTITLE WORDING follows Repack: keep the transcriber's best reading, never "[unclear]" or another note on screen; list the lines you couldn't settle, with their times, for the user. ONE WORD AT A TIME still suits a short line that's the moment itself, a few per video.`,
    },
    {
      name: "final-pass",
      body: `THE FINAL PASS (interrogation): one review_edit with frames across the whole edit (the intro, each case's date cut-in, a bridge or two per case and each outro, plus each place an earlier stage flagged; at most 24). Its audit covers the mechanics (gaps, slivers, bare cut-in cards, uncovered speech, subtitles past a cut, bare stills, censored B-roll, callouts off their words); the frames are for what only eyes catch: a subtitle, photo window or callout over a face, a name callout on the wrong person, a minor's face showing, a body or remains not blurred, a closing line or outro page unreadable over its picture. Fix what you find in one apply_edit_plan (tidy_tracks included). Then run mute_house_words over the whole timeline once with words: the Doc's Blur this words in every form the script and the footage use ("murder = m****r", "murdered = m******d", "murdering", "murderer", "killer = k****r", "killed = k****d", "killing", "blood = bl**d"), plus murder, blood and strip: it mutes them in the footage and the voice-overs and stars them in every text on screen in one call (a later run replaces its mutes, so pass the same words every time). Don't re-review sections you already checked unless you changed them.`,
    },
  ],
};

// Learnt from the team's courtroom reference (Judge Jester's "When Cocky
// Attorney TAUNTS The Judge", youtu.be/RAhmNukjK2g): a hearing plays in long
// stretches, short narration bridges explain it, and each case ends on a
// "SENTENCING:" card.
const COURTROOM: Guide = {
  notes: `- A COURTROOM VIDEO is a hearing (a trial, a sentencing, a bond, motion or discipline hearing; a court livestream or a Zoom/Teams recording) told as a story: the hearing is the footage and carries the drama; the narration only explains it. Its shape: the cold open (the teasers: the intro), the hook cut-in, the setup cut-in ("On <date>…": who, what they did, what's at stake), then the hearing in long stretches (1–3 minutes each) with a short narration bridge (a cut-in of 10–20 s) between them, and the outcome at the end (the outro: THE SENTENCING CARD). Inside a range cut only dead air (paperwork, long silences, a recess) with a hard cut and no sound, never a speaker's sentence.
- RECORDED VOICE-OVERS: Edit doesn't make courtroom narration; the user supplies recordings. Never generate one or ask for one. Before placing, read each recording's transcript (media_transcript) against the script's cut-ins: only a recording that reads THIS script goes on (one of another case, or an older take of this one, stays off the timeline: say which and why); of several takes of this script, the newest the user names, else the one that matches the script best. place_voiceovers {media_ids: [it]}; it places only the words that read each cut-in, so anything else in the file (a note to the editor read out, a retake, a count-in) stays off: check the last cut-in ends on its last scripted word. Where the recording words a line differently from the Doc, the recording wins (it's what's heard): text on screen follows it. Voice-overs Edit generated at import ("<project> (voice-over) - Cut-in N") are replaced by the recording (place_voiceovers with the recording's id). With no recording, leave the cards and say so.
- THE HEARING'S PICTURE: AFTER THE INTRO doesn't hold here; court cameras are fixed, so the edit makes the moves. Hard cuts between angles, never a transition. A PUNCH-IN (scale ~1.3–2 on one person or one pane of a grid, x/y on them, held still, no animation) on the lines that land (a ruling, a rebuke, an admission, "Is that clear?") and on a person's first lines; back out when the exchange widens. A grid of feeds (panes side by side or stacked, black bars around them) fills the frame: scale it up past the bars; where one pane holds the speaker for a stretch, punch into that pane. Another channel's logo, banners, "coming up" cards or captions burned into a re-upload are never on screen: crop past them (scale and x/y), else a rect blur over them (MINORS' FACES); the court's own name tags and seals can stay. Clerk monitors and papers with personal details get a rect blur.
- NARRATION BRIDGES (every cut-in after the setup) are covered with the hearing itself, as B-roll: cover_cut_in with into "none", 2–4 shots from around that point (never ahead of the story): whom the narration names, punched in, then whoever reacts (the judge leaning back, an attorney's face); the B-roll look stays. In and out of every bridge: the flash (skill transitions), never the vertical drop. No maps, evidence boards, emphasis runs or shutters unless the narration names an object or document the hearing shows.
- REACTION TAG: at most one per bridge, on its key reaction shot: the narration's verdict on that person in 2–4 words, upper case between asterisks ("*HIS PATIENCE SNAPS*", "*TAKING THE BLAME*", "*REFUSES TO BUDGE*"; HOUSE WORDS still starred): Geist 700 ~44 at 1080p, white, glow {enabled, color null, radius 12, strength 0.35}, opaque black box (background opacity 1, pad_x 16, pad_y 10), no leader, beside the person's head on the side with room, never on a face, following them (track_region), animation typewriter (stagger 1: a letter a frame), from the word that says it for 2–3 s, fade_out 6.
- NAME CALLOUT: the first time a person who matters is on screen (the accused in the setup, a witness taking the stand, an official the narration names): their name in upper case as the hearing gives it ("JOSHUA MCCLUSKEY", "MARK BRACHTL"; a role only when unnamed: "BOARD MEMBER"), Geist 700 ~44, white with a drop shadow, no box, no glow, beside them with a white leader (style.leader {color [1,1,1,1], width 4, attach "side"}) from their neck; otherwise INTRODUCING A PERSON's callout (track_region on label and leader, rise, fade out). It replaces the age-and-role label and the body vignette.
- THE SETUP (the "On <date>…" cut-in): no map_view. date_title over its first shot (the person in the hearing); the person's NAME CALLOUT; then their DESKTOP PROFILE (desktop_profile, photo_title "Court Viewer", media a still_frame of them in the hearing or a found photo of them; lines in upper case, 2–4 short facts from the narration, "- FIRED SEPT. 9, 2024"), once per video; it ends on THE CLIFFHANGER TITLE.
- THE CLIFFHANGER TITLE closes the hook and the setup, the last 2–3 s before the hearing: a still_frame of the moment the narration teases (the judge mid-rebuke), full frame, under an adjustment {blur {radius ~40 at 1080p}, grade {exposure -0.4}} whose radius keys 0 → 40 over its first 8 frames, and the narration's last phrase in upper case ending "..." ("UNLEASHING A FEROCIOUS REBUKE FROM THE BENCH..."), centred, Geist 700 ~64, white, drop shadow, no box, no glow, rise, on the words; a low hit as it lands; a hard cut into the hearing.
- SUBTITLES: the house's (skill subtitles) in capitals with no name label above them: the picture and the name callouts say who speaks. After the labels are settled (one per person, as the subtitles skill says), one update_clips {track: the subtitles track, patch: {style: {label: null, uppercase: true}}} (uppercase shows them in capitals; the words stay as said, so starring and timing still work); the words stay white.
- SOUND: music lives under the narration (bridges, setup, the sentencing card) and fades out over ~1 s as the hearing comes back; under a hearing stretch, nothing, or one low drone ~20 LU under the speech. Tone: serious tension (drones, low pulses), never horror or a chase. Each flash gets a whoosh or a hit; the desktop profile's lines a keyboard's typing; each cliffhanger title and the sentencing card a low hit.
- The audit's repetitive_transitions on the flashes in and out of bridges is this style: leave them.`,
  skills: [
    {
      name: "edit-workflow",
      body: `THE EDITING WORKFLOW (courtroom): the whole edit, start to finish, in this one turn. It starts when the user asks for it ("start the edit", "start the editing workflow", "edit this video"); whatever else their message says steers every stage. Work through every stage without stopping to ask: decide yourself, and keep a short list of what you weren't sure about for the summary at the end. Watching the footage (who says each line) started in the background when you loaded this skill.

The whole edit should take about ten minutes: a handful of tool calls per stage. Per stage: load its skill (once), get_edit_context narrowed to the stage, decide everything, apply the timeline changes in one apply_edit_plan and the tools that place sounds, images or text in one batch, look once (review_frames on the plan, or one contact_sheet), fix only concrete defects in one more call, then go on. Never re-read what you've read or re-check unchanged work; wait for slow tools in long blocks (yield_time_ms 30000 or more).

The stages, in order (the courtroom rules in your instructions win over the skills where they differ):
1. VOICE-OVERS AND RESEARCH (skill research). First the narration: choose and place the user's recording (RECORDED VOICE-OVERS). Then research THIS hearing (case_articles first; if none, search_web, read_page, add_article): every named person's full name and role (the accused, the judge or board, attorneys, witnesses), the hearing's date and kind, and its outcome (ruling, sentence, discipline) worded as the source words it, with the source. Pictures: only of the people (one collect_images, weeded with look_at_found / reject_found); no scenes, places or vehicles.
2. THE INTRO (skills intro, transitions): the opening dip, the teasers' speaker captions and punch-ins, hard cuts between teasers; the hook cut-in covered with hearing shots (cover_cut_in into "none", the flash in), a NAME CALLOUT on the person it's about, ending on THE CLIFFHANGER TITLE.
3. THE STORY (skills cut-ins, transitions): THE SETUP, then every NARRATION BRIDGE (one find_in_footage with a phrase per bridge finds the shots; the people they name, the reactions) with its REACTION TAG and flashes, and THE HEARING'S PICTURE across the hearing stretches (punch-ins on the lines that land, grids filled, other channels' branding cropped or blurred). One apply_edit_plan with review_frames on each bridge's first shot, each tag and callout, and one frame per hearing stretch.
4. THE OUTRO (skill outro): THE SENTENCING CARD, the video ending on the narration's last word.
5. SUBTITLES (skill subtitles): watch_footage, add_subtitles after the intro, one label per person, then the labels removed (SUBTITLES), review_edit once and fix only uncovered stretches and lines that read oddly.
6. MUSIC AND SOUND (skill music-and-sound, with SOUND): read list_library once, choose the beds (say which and why), lay every bed, whoosh, hit and typing in one batch of add_from_library calls with under_speech.
7. THE FINAL PASS (skill final-pass).

Then finish with a short summary: the edit's length, its sections, the outcome you used and its source, which recording you placed (and any you left off, and why), and everything you weren't sure about.`,
    },
    {
      name: "transitions",
      body: `- TRANSITIONS (courtroom): few and the same, so viewers read them as "the narrator is speaking" / "back to the hearing". Inside the hearing and between teasers: hard cuts only, nothing heard on them. THE FLASH: into and out of every narration bridge, into the setup, and into the sentencing card: a warm light leak burning to white, apply_edit_plan op transition {kind "light_leak", at: the cut's frame} (16 frames straddling the cut: orange light sweeping across from the left, white on the cut, gone by its end); one op per cut, all of a stage's in its one plan; out of a bridge it can land on the hearing's first word. A dip to black (op transition kind "dip") only between the hook and the setup. Into a cliffhanger title the blur itself is the move (its radius keys up); out of it a hard cut on a hit. No vertical drops, glitches or camera shutters; a crossfade (10 frames) only between two B-roll shots of one bridge.
- EVERY FLASH IS HEARD: a whoosh building into it (starting ~0.5 s before the cut) or a hit on it, about 3–4 LU under the speech around it; never two whooshes within ~10 s (use a hit for the second). The music moves with the flash: a bridge's bed comes in on the flash into it and fades out by the flash out of it. The plan's audit flags a flash with nothing heard (silent_transition).`,
    },
    {
      name: "outro",
      body: `- THE OUTRO (courtroom: the cut-in after the last hearing stretch, "In the end…") is THE SENTENCING CARD, one per person whose outcome the narration gives, for as long as it talks about them, coming in on the flash (skill transitions) as the narration turns to the outcome:
  - Left: the person's picture filling the frame's height: a still_frame of them in the hearing where their face is clear (preferred: it's how viewers know them), else a found photo of them; a mugshot only if they were booked. As the house outro: an image clip scaled to the frame's height, a slow push-in (×1.04, ease linear), an adjustment {grade {saturation -0.3}} over it only, their face centred at ~20% of the frame width, and a black gradient over it (a solid {fill [0,0,0,1], gradient {from 0.3, to 0.42}}) so the right is black.
  - The header: "SENTENCING:" when a court sentenced them, else "RULING:" (a board's decision, a motion, discipline). Geist 700, size ~96 at 1080p, color [1,0.12,0.12,1], glow {enabled, color null, radius 26, strength 0.85}, no box, centred over the right column (x = +0.2*width), its centre ~13% from the top (y = -0.37*height), on from the card's first frame (fade in 6).
  - The outcome: one text clip per point, each starting "- ", worded as the narration (and the source) says it, sentence case, Geist 700 ~44, white, glow {enabled, color null, radius 18, strength 0.6}, align left, line_height 1.25, max_width 0.47*width, left edge at ~45% of the width, the first ~22% from the top and each below the one before with a line's gap; animation typewriter (stagger 1: a letter a frame), each starting on the narration's word that begins it, all held to the end. Two to four points; nothing guessed (FACTS).
  - No other text: no name label on the picture, no date heading. A soft low hit as the card lands, ~6 LU under the narration.
  - The video ends when the narration's last word ends (plus at most a couple of frames): trim everything to it, the music fading out by then (fade_out ~1.5 s). The plan's audit gives the new duration.`,
    },
  ],
};

const GUIDES: Record<Style, Guide> = {
  bodycam: { notes: "", skills: [] },
  interrogation: INTERROGATION,
  courtroom: COURTROOM,
};

/** Every style, in edit-core's order (Style::ALL). */
export const ALL: readonly Style[] = STYLES.map((style) => style.value);

export function guide(style: Style): Guide {
  return GUIDES[style] ?? GUIDES.bodycam;
}

/** The skill called `name` for this style: its own version, else the house one. */
export function skill(style: Style, name: string): Skill | undefined {
  return guide(style).skills.find((own) => own.name === name) ?? skills.get(name);
}

/** The skills this style can load. */
export function skillNames(style: Style): string[] {
  const names = skills.SKILLS.map((own) => own.name);
  for (const own of guide(style).skills) if (!names.includes(own.name)) names.push(own.name);
  return names;
}

/** Every skill name across the styles (the skill tool's choices). */
export function allSkillNames(): string[] {
  const names: string[] = [];
  for (const style of ALL) for (const name of skillNames(style)) if (!names.includes(name)) names.push(name);
  return names;
}

/** What the agent's instructions say about the project's style. */
export function instructions(style: Style): string {
  const notes = guide(style).notes.trim();
  let out = `THIS VIDEO'S STYLE: ${style}. The house style above applies to it`;
  if (notes === "") {
    out += ".";
  } else {
    out += ", with these rules for this kind of video (they win where they differ):\n";
    out += notes;
  }
  return out;
}
