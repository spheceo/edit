// The interrogation intro's house graphics, each one plan operation, learnt
// from Red Thread Interrogations ("Killer Wife Has No Idea Cops Already Know
// Her Dirty Secret") and Red File ("'Friendly' Cop…"), the team's references
// for how heavily an interrogation video's first two minutes use graphics
// (docs/feedback/2026-10-19-interrogation-intro.md):
// - `intro_captions`: the teasers' subtitles as Red Thread's: small boxed
//   lines that come up word by word, white on black, the lines that matter in
//   a red box; the same for everyone (no role colours in the intro).
// - `photo_inset`: a person's photo, small and framed in white in a corner,
//   their name typed above it, over the room gone black and white.
// - `countdown`: "INTERROGATION STARTS IN 01:18" in the top-left corner,
//   ticking down through the prologue to the frame the tape rolls.
// - `map_pin`: a photo beside the house on a top-down map, a red line drawn
//   from the house to it.
// - `split_screen`: two faces side by side, each half of the frame, with a tag.
// - `fast_forward`: the room skipping ahead: black and white, the picture
//   tearing in bursts, "FF >>" in the corner.
// - `disclaimer`: the card before the tape: "DISCLAIMER" in red over a short text.
// - `text_slam`: Red File's headline: big red capitals word by word over the
//   picture darkened.
// - `timeline_bar`: Red File's "1986 ——— 2009", the line drawing across.

import { clipFrom } from "./clips.ts";
import type { Project } from "./model.ts";
import { addTrack, clipEnd, clipOf, fps as fpsOf, freshId, mediaOf, trackOf } from "./project.ts";
import { charCount, round, splitWhitespace, trim } from "./rust.ts";
import * as seams from "./seams.ts";

type Args = Record<string, unknown>;
type Rgba = [number, number, number, number];

const int = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" && trim(value) !== "" ? trim(value) : null);

/** The intro's red: the slams, the line to the house, the flash. */
export const RED: Rgba = [0.82, 0.04, 0.06, 1];
const WHITE: Rgba = [1, 1, 1, 1];
/** Red words that glow (the teasers' emphasis): brighter than RED, which fills shapes. */
export const RED_TEXT: Rgba = [1, 0.1, 0.1, 1];

/** The house glow on text, bodycam's (its captions, Repack's subtitles): wide and soft, in the text's colour. */
function glow(k: number): Args {
  return { enabled: true, color: null, radius: 46 * k, strength: 0.5 };
}
const PAPER: Rgba = [0.97, 0.97, 0.95, 1];

function push(project: Project, made: string[], fields: Args): string {
  const id = freshId(project, "c");
  project.clips.push(clipFrom({ ...fields, id }));
  made.push(id);
  return id;
}

/** `start` and `end` (or `duration`) in frames. */
function span(args: Args, what: string, least = 6): [number, number] {
  const given = int(args.start);
  if (given === null) throw new Error(`${what} needs start (frames)`);
  const start = Math.max(given, 0);
  const end = int(args.end) ?? (int(args.duration) !== null ? start + int(args.duration)! : null);
  if (end === null) throw new Error(`${what} needs end or duration (frames)`);
  if (end - start < least) throw new Error(`${what} needs at least ${least} frames`);
  return [start, end];
}

const key = (frame: number, value: number, ease = "linear") => ({ frame, value, ease });

/** The soft shadow under white words on a picture. */
function shadow(k: number): Args {
  return { color: [0, 0, 0, 1], opacity: 0.9, distance: 4 * k, angle: 112, size: 6 * k, blur: 14 * k };
}

/** How wide one line of `text` is in Geist at `size` px (an estimate, as place_label's). */
function lineWidth(text: string, size: number): number {
  return charCount(text) * size * 0.58;
}

/** A colour given as [r, g, b, a] (0..1), else `fallback`. */
function rgba(value: unknown, fallback: Rgba): Rgba {
  if (Array.isArray(value) && value.length === 4 && value.every((part) => typeof part === "number")) return value as Rgba;
  return fallback;
}

/** A picture's (or a video's) shown size at scale 1 (fitted to the frame) and its media. */
function fitted(project: Project, mediaId: unknown, what: string) {
  if (typeof mediaId !== "string") throw new Error(`${what} needs media (a picture's or a video's media id)`);
  const media = mediaOf(project, mediaId);
  if (media === undefined) throw new Error(`no media ${mediaId}`);
  if (media.kind !== "image" && media.kind !== "video") throw new Error(`${mediaId} isn't a picture or a video`);
  const [width, height] = [project.settings.width, project.settings.height];
  const [w, h] = [Math.max(media.width ?? width, 1), Math.max(media.height ?? height, 1)];
  const fit = Math.min(width / w, height / h);
  return { media, w, h, fit };
}

// ---------------------------------------------------------------------------
// intro_captions

/**
 * The teasers' subtitles restyled as Red Thread's (`{"op":"intro_captions",
 * "start":F,"end":F,"emphasis":["c12","c15"]}`): every subtitle between start
 * and end in the house caption look, bodycam's (the team: "a glow on the
 * text, just as we do with bodycam, and a drop shadow on the background"):
 * white Montserrat glowing, on the see-through box with its soft shadow; the
 * clips in `emphasis`, the lines that matter, in red words with the same glow
 * ("it's not a red background, it's the red text"). Its words come up one by
 * one as they're said (`heard`: the frames words are heard at, which
 * apply_edit_plan fills in from the transcripts; else evenly over the first
 * 60% of the line), flush left, in the speaker's colour (their subtitle's
 * label's, else its words'; white for nobody's). It names nobody.
 */
/** A subtitle's speaker colour: its label's, else its words' (Repack's are in theirs). */
function speakerColour(style: { color: Rgba; label?: { color: Rgba } | null }): Rgba {
  return [...(style.label?.color ?? style.color)] as Rgba;
}

export function introCaptions(project: Project, args: Args): Record<string, unknown> {
  const [start, end] = span(args, "intro_captions");
  const emphasis = new Set(Array.isArray(args.emphasis) ? args.emphasis.filter((id): id is string => typeof id === "string") : []);
  const heard = (Array.isArray(args.heard) ? args.heard.filter((frame): frame is number => typeof frame === "number") : []).sort((a, b) => a - b);
  const look = seams.captions.captionStyle(project.settings.width, project.settings.height);
  const restyled: string[] = [];
  project.clips.forEach((clip, index) => {
    if (clip.type !== "text" || clip.start < start || clip.start >= end) return;
    const name = clip.name ?? "";
    if (!(name.startsWith("Subtitle") || trackOf(project, clip.track)?.subtitles === true)) return;
    const words = splitWhitespace(clip.text).length;
    const length = clipEnd(clip) - clip.start;
    const said = heard.filter((frame) => frame >= clip.start - 3 && frame < clipEnd(clip)).slice(0, words);
    const times =
      said.length === words
        ? said.map((frame) => Math.max(frame - clip.start, 0))
        : Array.from({ length: words }, (_, n) => round(((n / Math.max(words, 1)) * 0.6 * length) * 100) / 100);
    const { person: _person, ...rest } = clip as typeof clip & { person?: string };
    void _person;
    project.clips[index] = clipFrom({
      ...rest,
      name: "Subtitle (teaser)",
      style: {
        ...clip.style,
        ...look,
        // In the speaker's colour, as their subtitle was (the team's subtitle
        // guide, Oct 20); the lines that land in red.
        color: emphasis.has(clip.id) ? RED_TEXT : speakerColour(clip.style),
        // Flush left, as bodycam's captions read (the team, Oct 20).
        align: "left",
        max_width: clip.style.max_width,
        uppercase: false,
        label: null,
      },
      animation: { preset: "words", duration: 1, stagger: 2 },
      word_times: times,
    });
    restyled.push(clip.id);
  });
  if (restyled.length === 0) throw new Error("intro_captions: no subtitles start between start and end (add the subtitles first)");
  return { restyled, emphasised: restyled.filter((id) => emphasis.has(id)) };
}

// ---------------------------------------------------------------------------
// photo_inset

/**
 * A person's photo in a corner (`{"op":"photo_inset","media":"m4","name":
 * "Michelle Williams","start":F,"end":F,"corner":"top-left"}`): framed in
 * white with a shadow, a third of the frame's height (`size`), easing in from
 * 92%, their name typed on above it, over the picture beneath gone black and
 * white (`desaturate: false` keeps its colour). For a video, `source_in`.
 */
export function photoInset(project: Project, args: Args): Record<string, unknown> {
  const [start, end] = span(args, "photo_inset", 12);
  const { media, w, h, fit } = fitted(project, args.media, "photo_inset");
  const [width, height] = [project.settings.width, project.settings.height];
  const k = height / 1080;
  const corner = str(args.corner) ?? "top-left";
  if (!["top-left", "top-right", "bottom-left", "bottom-right"].includes(corner)) throw new Error("photo_inset corner: top-left, top-right, bottom-left or bottom-right");
  const share = Math.min(Math.max(num(args.size) ?? 0.34, 0.15), 0.6);
  const scale = (share * height) / (h * fit);
  const [shownW, shownH] = [w * fit * scale, h * fit * scale];
  const name = str(args.name);
  const margin = 0.06 * width;
  const nameRoom = name === null ? 0 : 56 * k;
  const left = corner.endsWith("left");
  const top = corner.startsWith("top");
  const x = (left ? -1 : 1) * (width / 2 - margin - shownW / 2);
  const y = top ? -height / 2 + 0.08 * height + nameRoom + shownH / 2 : height / 2 - 0.1 * height - shownH / 2;
  const duration = end - start;
  const last = Math.max(duration - 1, 1);
  const made: string[] = [];
  if (args.desaturate !== false) {
    push(project, made, {
      type: "adjustment",
      name: "Photo inset · black and white",
      track: addTrack(project, "video"),
      start,
      duration,
      fade_in: 4,
      fade_out: 6,
      grade: { saturation: -1, contrast: 0.12 },
    });
  }
  const photo = push(project, made, {
    type: "video",
    name: `Photo inset · ${name ?? media.name}`,
    track: addTrack(project, "video"),
    start,
    duration,
    media: media.id,
    source_in: num(args.source_in) ?? 0,
    fade_in: 6,
    fade_out: 6,
    transform: { x, y, scale },
    frame: { width: 8 * k, color: PAPER, shadow: 0.6 },
    keyframes: { scale: [key(0, scale * 0.92, "out"), key(Math.min(8, last), scale), key(last, scale * 1.03)] },
  });
  let label: string | null = null;
  if (name !== null) {
    const size = 34 * k;
    label = push(project, made, {
      type: "text",
      name: "Photo inset · name",
      track: addTrack(project, "video"),
      start: start + 4,
      duration: duration - 4,
      fade_out: 6,
      text: name,
      style: { font: "Geist", weight: 600, size: round(size), color: WHITE, glow: { enabled: false }, background: null, shadow: shadow(k), align: left ? "left" : "right" },
      transform: { x: x + (left ? -1 : 1) * (shownW / 2 - lineWidth(name, size) / 2), y: y - shownH / 2 - 30 * k },
      animation: { preset: "typewriter", duration: 1, stagger: 1.5 },
    });
  }
  return { clips: made, photo, name: label };
}

// ---------------------------------------------------------------------------
// countdown

/** "01:18": minutes and seconds. */
function clock(seconds: number): string {
  const whole = Math.max(Math.ceil(seconds - 1e-6), 0);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * "INTERROGATION STARTS IN 01:18" in the top-left corner from start until end,
 * the frame the tape rolls (`{"op":"countdown","start":F,"end":F}`; `label`
 * for other words): small white capitals in a black box, one clip a second,
 * so it reads the time left at every frame and reaches 00:01 as the tape
 * comes in. Red Thread holds viewers through its prologue with it.
 */
export function countdown(project: Project, args: Args): Record<string, unknown> {
  const [start, end] = span(args, "countdown", 30);
  const fps = fpsOf(project);
  const label = (str(args.label) ?? "INTERROGATION STARTS IN").toUpperCase();
  const [width, height] = [project.settings.width, project.settings.height];
  const k = height / 1080;
  const size = 28 * k;
  const sample = `${label}  00:00`;
  const boxW = lineWidth(sample, size) + 28 * k;
  const boxH = size * 1.15 + 16 * k;
  const x = -width / 2 + 0.035 * width + boxW / 2;
  const y = -height / 2 + 0.05 * height + boxH / 2;
  const track = addTrack(project, "video");
  const made: string[] = [];
  const step = Math.max(Math.round(fps), 1);
  for (let from = start; from < end; from += step) {
    const to = Math.min(from + step, end);
    push(project, made, {
      type: "text",
      name: "Countdown",
      track,
      start: from,
      duration: to - from,
      fade_in: from === start ? 6 : 0,
      fade_out: to === end ? 4 : 0,
      text: `${label}  ${clock((end - from) / fps)}`,
      style: {
        font: "Geist",
        weight: 700,
        size: round(size),
        color: WHITE,
        tracking: 1,
        glow: { enabled: false },
        background: { color: [0, 0, 0, 1], opacity: 0.85, pad_x: 14 * k, pad_y: 8 * k },
      },
      transform: { x, y },
      animation: { preset: "none", duration: 1, stagger: 1 },
    });
  }
  return { clips: made.length, track, from: clock((end - start) / fps) };
}

// ---------------------------------------------------------------------------
// map_pin

/**
 * A photo pinned to the house on a top-down map (`{"op":"map_pin","media":"m4",
 * "name":"Michelle Williams","map":"<the map's clip id>","building":{"x":…,
 * "y":…},"start":F,"end":F}`; map_view's `building` gives x and top/bottom):
 * the photo framed in white off to the side with more room, its name in a
 * box under it, a red line drawn from the house to the name as it comes in.
 */
export function mapPin(project: Project, args: Args): Record<string, unknown> {
  const [start, end] = span(args, "map_pin", 12);
  const { media, w, h, fit } = fitted(project, args.media, "map_pin");
  const map = typeof args.map === "string" ? clipOf(project, args.map) : undefined;
  if (map === undefined) throw new Error("map_pin needs map: the map's clip id");
  const building = (typeof args.building === "object" && args.building !== null ? args.building : {}) as Args;
  const bx = num(building.x);
  const by = num(building.y) ?? (num(building.top) !== null && num(building.bottom) !== null ? (num(building.top)! + num(building.bottom)!) / 2 : null);
  if (bx === null || by === null) throw new Error("map_pin needs building {x, y} (or map_view's building, with top and bottom)");
  const [width, height] = [project.settings.width, project.settings.height];
  const k = height / 1080;
  const scale = (0.3 * height) / (h * fit);
  const [shownW, shownH] = [w * fit * scale, h * fit * scale];
  const side = str(args.side) ?? (bx > 0 ? "left" : "right");
  const x = Math.min(Math.max(bx + (side === "left" ? -1 : 1) * 0.26 * width, -width / 2 + 0.05 * width + shownW / 2), width / 2 - 0.05 * width - shownW / 2);
  const y = Math.min(Math.max(by - 0.04 * height, -height / 2 + 0.08 * height + shownH / 2), height / 2 - 0.16 * height - shownH / 2);
  const name = str(args.name);
  if (name === null) throw new Error("map_pin needs name (the person in the photo)");
  const duration = end - start;
  const last = Math.max(duration - 1, 1);
  const made: string[] = [];
  const photo = push(project, made, {
    type: "video",
    name: `Map pin · ${name}`,
    track: addTrack(project, "video"),
    start: start + 6,
    duration: duration - 6,
    media: media.id,
    source_in: num(args.source_in) ?? 0,
    fade_in: 6,
    fade_out: 6,
    transform: { x, y, scale },
    frame: { width: 7 * k, color: PAPER, shadow: 0.6 },
    keyframes: { scale: [key(0, scale * 0.92, "out"), key(Math.min(8, last), scale)] },
  });
  const label = push(project, made, {
    type: "text",
    name: "Map pin · name",
    track: addTrack(project, "video"),
    start,
    duration,
    fade_out: 6,
    text: name,
    style: {
      font: "Geist",
      weight: 600,
      size: round(26 * k),
      color: WHITE,
      glow: { enabled: false },
      background: { color: [0, 0, 0, 1], opacity: 0.9, pad_x: 10 * k, pad_y: 6 * k },
      leader: { x: bx, y: by, width: 4 * k, color: RED, draw: 8, attach: "nearest", fade: 4 },
    },
    transform: { x, y: y + shownH / 2 + 26 * k },
    animation: { preset: "fade", duration: 6 },
  });
  return { clips: made, photo, label };
}

// ---------------------------------------------------------------------------
// split_screen

/**
 * Two faces side by side (`{"op":"split_screen","left":"m4","right":"m9",
 * "start":F,"end":F,"tags":["MICHELLE WILLIAMS","GREG WILLIAMS"]}`): each
 * picture fills its half of the frame (cropped to it), a hard cut in and out;
 * `tags` in boxes low on each half (`tag_colors`: each box's colour, the
 * person's role colour). For a video, `left_in`/`right_in` seconds.
 */
export function splitScreen(project: Project, args: Args): Record<string, unknown> {
  const [start, end] = span(args, "split_screen", 12);
  const [width, height] = [project.settings.width, project.settings.height];
  const k = height / 1080;
  const tags = Array.isArray(args.tags) ? args.tags : [];
  const colors = Array.isArray(args.tag_colors) ? args.tag_colors : [];
  const made: string[] = [];
  const duration = end - start;
  const last = Math.max(duration - 1, 1);
  const halves: ["left" | "right", unknown, unknown][] = [
    ["left", args.left, args.left_in],
    ["right", args.right, args.right_in],
  ];
  halves.forEach(([side, mediaId, sourceIn], index) => {
    const { media, w, h, fit } = fitted(project, mediaId, `split_screen ${side}`);
    const cover = Math.max(width / 2 / (w * fit), height / (h * fit));
    // The share of the picture's width that shows in its half, the rest cropped evenly off its sides.
    const shown = Math.min(width / 2 / (w * fit * cover), 1);
    const cut = (1 - shown) / 2;
    const x = (side === "left" ? -1 : 1) * (width / 4);
    push(project, made, {
      type: "video",
      name: `Split screen · ${side}`,
      track: addTrack(project, "video"),
      start,
      duration,
      media: media.id,
      source_in: num(sourceIn) ?? 0,
      transform: { x, scale: cover },
      crop: { left: cut, right: cut },
      keyframes: { scale: [key(0, cover), key(last, cover * 1.02)] },
    });
    const tag = str(tags[index]);
    if (tag !== null) {
      const color = rgba(colors[index], [0, 0, 0, 1]);
      const light = color[0] * 0.3 + color[1] * 0.59 + color[2] * 0.11 > 0.6;
      push(project, made, {
        type: "text",
        name: `Split screen · ${side} tag`,
        track: addTrack(project, "video"),
        start: start + 4,
        duration: duration - 4,
        fade_out: 4,
        text: tag,
        style: {
          font: "Geist",
          weight: 700,
          size: round(30 * k),
          color: light ? [0.05, 0.05, 0.05, 1] : WHITE,
          glow: { enabled: false },
          background: { color, opacity: 1, pad_x: 12 * k, pad_y: 7 * k },
        },
        transform: { x, y: 0.36 * height },
        animation: { preset: "fade", duration: 6 },
      });
    }
  });
  return { clips: made };
}

// ---------------------------------------------------------------------------
// fast_forward

/**
 * The room skipping ahead (`{"op":"fast_forward","start":F,"end":F}`), over
 * footage the edit plays sped up there: black and white, the picture tearing
 * in short bursts (a glitch keyed up and down every ~20 frames), "FF >>" in
 * the bottom-right corner. Red Thread uses it to get through hours of tape.
 */
export function fastForward(project: Project, args: Args): Record<string, unknown> {
  const [start, end] = span(args, "fast_forward", 12);
  const [width, height] = [project.settings.width, project.settings.height];
  const k = height / 1080;
  const duration = end - start;
  const glitch: Args[] = [key(0, 0)];
  for (let at = 3; at < duration - 4; at += 20) {
    glitch.push(key(at, 0), key(at + 2, 0.035, "out"), key(at + 5, 0));
  }
  glitch.push(key(duration - 1, 0));
  const made: string[] = [];
  push(project, made, {
    type: "adjustment",
    name: "Fast forward",
    track: addTrack(project, "video"),
    start,
    duration,
    grade: { saturation: -1, contrast: 0.15 },
    glitch: { amount: 0, slices: 7, rgb: 0.1 },
    keyframes: { glitch },
  });
  const size = 88 * k;
  push(project, made, {
    type: "text",
    name: "Fast forward · FF",
    track: addTrack(project, "video"),
    start,
    duration,
    text: "FF >>",
    style: { font: "Geist", weight: 800, size: round(size), color: [1, 1, 1, 0.82], glow: { enabled: false }, background: null, shadow: shadow(k) },
    // Top right: the room's subtitles sit low.
    transform: { x: width / 2 - 0.06 * width - lineWidth("FF >>", size) * 0.65, y: -height / 2 + 0.14 * height },
    animation: { preset: "none", duration: 1, stagger: 1 },
  });
  return { clips: made };
}

// ---------------------------------------------------------------------------
// pause

/**
 * The room paused to say something over it (`{"op":"pause","start":F,"end":F,
 * "text":"June 2013"}`; `from`: the frame whose picture holds, default the one
 * before `start`): the team's way instead of words in the middle of the
 * screen ("pause the previous frame and then write June 2013 on that frame,
 * and then zoom over to the Notepad"). The footage under `from` held still
 * (speed 0.05) with a slow push, greyed and darkened a little, and the words
 * typed on small, lower left (`side: "right"` for lower right, away from
 * the person's face), white with the house shadow. A shutter or click on
 * `start` is the sound's job (add_sound_effect).
 */
export function pause(project: Project, args: Args): Record<string, unknown> {
  const [start, end] = span(args, "pause", 12);
  const [width, height] = [project.settings.width, project.settings.height];
  const k = height / 1080;
  const fps = fpsOf(project);
  const from = int(args.from) ?? Math.max(start - 1, 0);
  const video = project.tracks.filter((track) => track.kind === "video" && track.subtitles !== true).map((track) => track.id);
  // The picture showing at `from`: the highest footage clip there.
  const under = project.clips
    .filter((clip) => clip.type === "video" && clip.start <= from && from < clipEnd(clip) && mediaOf(project, clip.media)?.kind === "video")
    .sort((a, b) => video.indexOf(b.track) - video.indexOf(a.track))[0];
  if (under === undefined || under.type !== "video") throw new Error(`pause: no footage on the timeline at frame ${from} to hold`);
  const at = under.source_in + ((from - under.start) / fps) * under.speed;
  const scale = under.transform.scale ?? 1;
  const duration = end - start;
  const made: string[] = [];
  push(project, made, {
    type: "video",
    name: "Pause",
    track: addTrack(project, "video"),
    start,
    duration,
    media: under.media,
    source_in: at,
    speed: 0.05,
    transform: { ...under.transform },
    crop: under.crop,
    keyframes: { scale: [key(0, scale), key(duration - 1, scale * 1.08)] },
  });
  push(project, made, {
    type: "adjustment",
    name: "Pause · look",
    track: addTrack(project, "video"),
    start,
    duration,
    grade: { saturation: -0.7, exposure: -0.35, vignette: 0.55 },
  });
  const words = typeof args.text === "string" ? trim(args.text) : "";
  if (words !== "") {
    const size = 56 * k;
    const lines = words.split("\n");
    const widest = Math.max(...lines.map((line) => lineWidth(line, size)));
    const right = args.side === "right";
    push(project, made, {
      type: "text",
      name: "Pause · words",
      track: addTrack(project, "video"),
      start: start + 4,
      duration: duration - 4,
      fade_out: 6,
      text: words,
      style: { font: "Geist", weight: 600, size: round(size), color: [1, 1, 1, 1], glow: { enabled: false }, background: null, shadow: shadow(k), align: right ? "right" : "left" },
      transform: { x: (right ? 1 : -1) * (width / 2 - 0.07 * width - widest / 2), y: height / 2 - 0.2 * height },
      animation: { preset: "typewriter", duration: 1, stagger: 1 },
    });
  }
  return { clips: made };
}

// ---------------------------------------------------------------------------
// disclaimer

/** The house disclaimer's words: ours, plain, short enough to read in a few seconds. */
export const DISCLAIMER_TEXT =
  "This video is made to inform. Everything in it comes from public records: police recordings, court documents and news reports.\n\nAnyone charged with a crime is presumed innocent unless proven guilty in a court of law. Where we describe what someone thought or felt, that is our reading of the evidence, not a fact.\n\nThe interrogation that follows is real. Viewer discretion is advised.";

/**
 * The card before the tape rolls (`{"op":"disclaimer","start":F,"end":F}`;
 * `text` for other words): "DISCLAIMER" in red capitals over the words in
 * white, centred on black, fading in; it ends where the interrogation starts
 * (the countdown's last second).
 */
export function disclaimer(project: Project, args: Args): Record<string, unknown> {
  const [start, end] = span(args, "disclaimer", 30);
  const [width, height] = [project.settings.width, project.settings.height];
  const k = height / 1080;
  const duration = end - start;
  const made: string[] = [];
  push(project, made, { type: "solid", name: "Disclaimer · black", track: addTrack(project, "video"), start, duration, fill: [0.02, 0.02, 0.02, 1] });
  push(project, made, {
    type: "text",
    name: "Disclaimer · title",
    track: addTrack(project, "video"),
    start,
    duration,
    text: "DISCLAIMER",
    style: { font: "Geist", weight: 800, size: round(80 * k), color: RED, glow: { enabled: true, color: null, radius: 18 * k, strength: 0.4 }, background: null },
    transform: { x: 0, y: -0.27 * height },
    animation: { preset: "fade", duration: 8 },
  });
  push(project, made, {
    type: "text",
    name: "Disclaimer · text",
    track: addTrack(project, "video"),
    start: start + 4,
    duration: duration - 4,
    text: str(args.text) ?? DISCLAIMER_TEXT,
    style: { font: "Geist", weight: 400, size: round(34 * k), color: [0.92, 0.92, 0.92, 1], line_height: 1.45, max_width: round(0.66 * width), glow: { enabled: false }, background: null },
    transform: { x: 0, y: 0.06 * height },
    animation: { preset: "fade", duration: 10 },
  });
  return { clips: made };
}

// ---------------------------------------------------------------------------
// text_slam

/**
 * Red File's headline (`{"op":"text_slam","text":"THEN THE CASE GOES COLD",
 * "start":F,"end":F}`): big red capitals in the middle, a word at a time
 * (`heard`: the frames its words are said at, from the narration, filled in
 * by apply_edit_plan; else every 6 frames), over the picture darkened and
 * gone grey (`darken: false` leaves it). For the story's turns, once or twice
 * an intro, never every narration.
 */
export function textSlam(project: Project, args: Args): Record<string, unknown> {
  const text = str(args.text);
  if (text === null) throw new Error('text_slam needs text ("THEN THE CASE GOES COLD")');
  const [start, end] = span(args, "text_slam", 18);
  const [width, height] = [project.settings.width, project.settings.height];
  const k = height / 1080;
  const duration = end - start;
  const words = splitWhitespace(text).length;
  const heard = (Array.isArray(args.heard) ? args.heard.filter((frame): frame is number => typeof frame === "number") : []).sort((a, b) => a - b);
  const said = heard.filter((frame) => frame >= start - 3 && frame < end).slice(0, words);
  const times = said.length === words ? said.map((frame) => Math.max(frame - start, 0)) : Array.from({ length: words }, (_, n) => n * 6);
  const made: string[] = [];
  if (args.darken !== false) {
    push(project, made, {
      type: "adjustment",
      name: "Text slam · darken",
      track: addTrack(project, "video"),
      start,
      duration,
      fade_in: 4,
      fade_out: 6,
      grade: { exposure: -0.9, saturation: -1, contrast: 0.1 },
    });
  }
  push(project, made, {
    type: "text",
    name: "Text slam",
    track: addTrack(project, "video"),
    start,
    duration,
    fade_out: 6,
    text: text.toUpperCase(),
    style: {
      font: "Geist",
      weight: 900,
      size: round(118 * k),
      color: rgba(args.color, RED),
      line_height: 0.95,
      max_width: round(0.8 * width),
      // The house glow, not a tight one (the team: "a bit too contracted… use the normal glow style… like the bodycam").
      glow: glow(k),
      background: null,
      shadow: shadow(k),
    },
    transform: { x: 0, y: 0 },
    animation: { preset: "words", duration: 1, stagger: 6 },
    word_times: times,
  });
  return { clips: made };
}

// ---------------------------------------------------------------------------
// timeline_bar

/**
 * Red File's time gap (`{"op":"timeline_bar","from":"1986","to":"2009",
 * "start":F,"end":F}`): the two years in big red numbers either side of the
 * frame, a red line drawing from the first to the second.
 */
export function timelineBar(project: Project, args: Args): Record<string, unknown> {
  const from = str(args.from);
  const to = str(args.to);
  if (from === null || to === null) throw new Error('timeline_bar needs from and to ("1986", "2009")');
  const [start, end] = span(args, "timeline_bar", 24);
  const [width, height] = [project.settings.width, project.settings.height];
  const k = height / 1080;
  const duration = end - start;
  const size = 96 * k;
  const x = 0.3 * width;
  const style = (leader: Args | null): Args => ({
    font: "Geist",
    weight: 900,
    size: round(size),
    color: RED,
    glow: glow(k),
    background: null,
    shadow: shadow(k),
    ...(leader === null ? {} : { leader }),
  });
  const made: string[] = [];
  push(project, made, {
    type: "text",
    name: "Timeline · from",
    track: addTrack(project, "video"),
    start,
    duration,
    fade_out: 6,
    text: from,
    style: style(null),
    transform: { x: -x, y: 0 },
    animation: { preset: "fade", duration: 6 },
  });
  push(project, made, {
    type: "text",
    name: "Timeline · to",
    track: addTrack(project, "video"),
    start: start + 4,
    duration: duration - 4,
    fade_out: 6,
    text: to,
    style: style({ x: -x + lineWidth(from, size) / 2 + 24 * k, y: 0, width: 6 * k, color: RED, draw: Math.min(20, duration / 3), attach: "side", fade: 4 }),
    transform: { x, y: 0 },
    animation: { preset: "fade", duration: 6 },
  });
  return { clips: made };
}
