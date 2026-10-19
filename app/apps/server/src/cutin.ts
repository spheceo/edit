// Covering a cut-in with B-roll in one go, the house way: the
// shots the agent picked, butted end to end across the cut-in, each slowed,
// pushed in using native frame sampling, the B-roll look over them, the
// vertical drop into the cut, and the placeholder card and words gone with
// the voice-over moved onto A1. The agent picks the shots; this does the
// rest, so a cut-in is one tool call instead of dozens. The tool itself (one
// store update, then optical flow for the shots that asked) is edit_tools.ts's.

import { clipFrom } from "./clips.ts";
import * as graphics from "./graphics.ts";
import type { Project } from "./model.ts";
import { addTrack, clipEnd, clipOf, fps as fpsOf, freshId, mediaOf } from "./project.ts";
import { display, fixed, round } from "./rust.ts";
import { field, optional, readStruct, required, SerdeError, type Struct } from "./serde.ts";

interface Shot {
  media: string;
  /** Seconds into the media. */
  source_in: number;
  /** Timeline seconds where the shot starts (the first defaults to the cut-in's start). */
  at: number | null;
  name: string | null;
  speed: number | null;
  /** Scale at the shot's first and last frame (multiplied by `scale`). */
  push: [number, number] | null;
  x: number | null;
  y: number | null;
  scale: number | null;
  smooth: boolean | null;
  /** A picture's label under it on its evidence card. */
  label: string | null;
}

interface Args {
  cut_in: unknown;
  shots: Shot[];
  look: boolean;
  /** "none" (the default: the transition is placed separately) or "drop" (the vertical drop). */
  into: string | null;
  /** Dissolve between shots of different moments (default true). */
  dissolve: boolean;
}

// Option fields here are kept as null (the struct is only read, never written).
const keep = <T extends ReturnType<typeof optional>>(spec: T) => ({ ...spec, skip: undefined });

const SHOT: Struct = {
  name: "Shot",
  fields: [
    required("media", "string"),
    required("source_in", "f64"),
    keep(optional("at", "f64")),
    keep(optional("name", "string")),
    keep(optional("speed", "f64")),
    keep(optional("push", { array: "f64", length: 2 })),
    keep(optional("x", "f64")),
    keep(optional("y", "f64")),
    keep(optional("scale", "f64")),
    keep(optional("smooth", "bool")),
    keep(optional("label", "string")),
  ],
};

const ARGS: Struct = {
  name: "Args",
  fields: [
    required("cut_in", "any"),
    required("shots", { vec: { struct: SHOT } }),
    field("look", "bool", true),
    keep(optional("into", "string")),
    field("dissolve", "bool", true),
  ],
};

/**
 * A cut-in: its number among the script's narration blocks (1-based, as
 * "Cut-in N" in clip and media names), its card, its words and voice-over.
 */
interface CutIn {
  number: number;
  card: string | null;
  voiceover: string | null;
  start: number;
  end: number;
}

function findCutIn(project: Project, which: unknown): CutIn {
  const script = project.script;
  if (script === undefined || script === null) throw new Error("the project has no script");
  const narrations: [string | null, string | null][] = [];
  for (const block of script.blocks) {
    if (block.kind === "narration") narrations.push([block.clip ?? null, block.voiceover ?? null]);
  }
  let index: number;
  if (typeof which === "number") {
    if (!Number.isInteger(which) || which < 1 || which - 1 >= narrations.length) {
      throw new Error(`cut_in is 1 to ${narrations.length}`);
    }
    index = which - 1;
  } else if (typeof which === "string") {
    index = narrations.findIndex(([card, voiceover]) => card === which || voiceover === which);
    if (index < 0) throw new Error(`${which} isn't a cut-in's card or voice-over`);
  } else {
    throw new Error("cut_in is its number (1-based) or its card's clip id");
  }
  const found = narrations[index];
  if (found === undefined) throw new Error("no such cut-in");
  const card = found[0] !== null && clipOf(project, found[0]) !== undefined ? found[0] : null;
  const voiceover = found[1] !== null && clipOf(project, found[1]) !== undefined ? found[1] : null;
  const spanning = clipOf(project, card ?? voiceover ?? "");
  if ((card ?? voiceover) === null || spanning === undefined) {
    throw new Error(`cut-in ${index + 1} has neither a card nor a voice-over on the timeline`);
  }
  return { number: index + 1, card, voiceover, start: spanning.start, end: clipEnd(spanning) };
}

function videoTracks(project: Project): string[] {
  return project.tracks.filter((track) => track.kind === "video" && track.subtitles !== true).map((track) => track.id);
}

function busy(project: Project, track: string, start: number, end: number): boolean {
  return project.clips.some((clip) => clip.track === track && clip.start < end && start < clipEnd(clip));
}

/** The lowest video track above `below` (any track when null) that's free for the span; a new one on top when none is. */
function freeAbove(project: Project, below: string | null, start: number, end: number): string {
  const tracks = videoTracks(project);
  const at = below === null ? -1 : tracks.indexOf(below);
  const from = at < 0 ? 1 : at + 1;
  for (const track of tracks.slice(from)) {
    if (!busy(project, track, start, end)) return track;
  }
  return addTrack(project, "video");
}

/** A free video track above everything playing in the span. */
function freeOnTop(project: Project, start: number, end: number): string {
  const tracks = videoTracks(project);
  const top = [...tracks].reverse().find((track) => busy(project, track, start, end)) ?? null;
  return freeAbove(project, top, start, end);
}

function clipOfFields(fields: Record<string, unknown>) {
  try {
    return clipFrom(fields);
  } catch (error) {
    if (error instanceof SerdeError) throw new Error(`clip: ${error.message}`);
    throw error;
  }
}

/**
 * Pure plan operation: the caller validates and commits the whole section
 * once. Expensive optical flow is an explicit shot option, never automatic work.
 */
/**
 * Whether a slowed shot is smoothed unless it says otherwise: the server
 * turns it on where VideoToolbox smooths a shot in seconds (the user wants
 * slowed footage smooth almost always); FFmpeg's minutes a shot kept it opt-in.
 */
let smoothByDefault = false;
export function setSmoothByDefault(on: boolean): void {
  smoothByDefault = on;
}

/** Frames two B-roll shots of different moments dissolve over. */
const DISSOLVE = 12;

export function cover(project: Project, given: Record<string, unknown>): [Record<string, unknown>, string[]] {
  let args: Args;
  try {
    args = readStruct(ARGS, given) as unknown as Args;
  } catch (error) {
    if (error instanceof SerdeError) throw new Error(`arguments: ${error.message}`);
    throw error;
  }
  if (args.shots.length === 0) throw new Error("give at least one shot");
  let drop: boolean;
  // The vertical drop only when asked: the team isn't a fan of it ("not a fan of this transition right here").
  if (args.into === "drop") drop = true;
  else if (args.into === null || args.into === "none") drop = false;
  else throw new Error(`into is drop or none, not ${args.into}`);
  const fps = fpsOf(project);
  const cut = findCutIn(project, args.cut_in);
  const prefix = `Cut-in ${cut.number} · `;

  // Where each shot starts and ends, butted across the whole cut-in.
  const frame = (seconds: number) => Math.trunc(round(seconds * fps));
  const starts: number[] = [];
  args.shots.forEach((shot, index) => {
    let start: number;
    if (shot.at !== null) start = frame(shot.at);
    else if (index === 0) start = cut.start;
    else throw new Error(`shot ${index + 1} needs at (timeline seconds where it starts)`);
    // A first shot within a few frames of the cut-in's start starts it.
    if (index === 0 && Math.abs(start - cut.start) <= 6) start = cut.start;
    starts.push(start);
  });
  if (starts[0] !== cut.start) throw new Error(`the first shot must start the cut-in, at ${fixed(cut.start / fps, 2)} s`);
  const spans: [number, number][] = [];
  starts.forEach((start, index) => {
    const end = starts[index + 1] ?? cut.end;
    if (end <= start || end > cut.end) {
      throw new Error(
        `shot ${index + 1} has no room: shots start in order inside the cut-in (${fixed(cut.start / fps, 2)}–${fixed(cut.end / fps, 2)} s)`,
      );
    }
    spans.push([start, end]);
  });

  // A re-run replaces what it placed before.
  const [spanFrom, spanTo] = [cut.start - 6, cut.end + 6];
  project.clips = project.clips.filter((clip) => {
    const name = clip.name;
    const ours =
      typeof name === "string" && (name.startsWith(`${prefix}B-roll`) || name === `${prefix}vertical drop`);
    return !(ours && clip.start < spanTo && spanFrom < clipEnd(clip));
  });

  // The placeholder card and its words go; the narration keeps its voice-over.
  const removed: string[] = [];
  if (cut.card !== null) {
    const card = clipOf(project, cut.card);
    if (card !== undefined) {
      const cardLink = card.link ?? null;
      project.clips = project.clips.filter((clip) => {
        const words =
          clip.id !== card.id &&
          clip.type === "text" &&
          ((cardLink !== null && (clip.link ?? null) === cardLink) ||
            (clip.start === card.start && clip.duration === card.duration));
        const gone = clip.id === card.id || words;
        if (gone) removed.push(clip.id);
        return !gone;
      });
    }
    // The script keeps the card's id: a placed block whose clip is gone was
    // removed on purpose. Cleared, it read as never placed, and the next
    // script resume laid every covered card out again at the end.
  }

  // The shots, on the lowest free track above the footage.
  const shotsTrack = freeAbove(project, null, cut.start, cut.end);
  // Between shots of different moments, a dissolve (the team: "make a
  // dissolve here"): the shot going out runs DISSOLVE frames past the cut and
  // whichever of the two is on the upper track fades over them, so shots
  // alternate between two tracks. Cuts within one moment stay hard (one push-in).
  const video = (index: number) => {
    const shot = args.shots[index];
    return shot !== undefined && mediaOf(project, shot.media)?.kind === "video";
  };
  const extend = args.shots.map((shot, index) => {
    const next = args.shots[index + 1];
    if (!args.dissolve || next === undefined || !video(index) || !video(index + 1)) return 0;
    const speed = Math.min(Math.max(shot.speed ?? 0.5, 0.05), 20);
    const [start, end] = spans[index]!;
    const ends = shot.source_in + ((end - start) / fps) * speed;
    const sameMoment = next.media === shot.media && Math.abs(next.source_in - ends) < 2;
    const room = (mediaOf(project, shot.media)?.duration ?? 0) - ends;
    return sameMoment || room < (DISSOLVE / fps) * speed + 0.05 ? 0 : DISSOLVE;
  });
  const dissolving = extend.some((frames) => frames > 0);
  const upperTrack = dissolving ? freeAbove(project, shotsTrack, cut.start, cut.end) : shotsTrack;
  // Which track each shot is on: a new one after each dissolve.
  const onUpper: boolean[] = [];
  args.shots.forEach((_, index) => onUpper.push(index === 0 ? false : extend[index - 1]! > 0 ? !onUpper[index - 1] : onUpper[index - 1]!));
  // The B-roll look over the whole stretch, above the footage shots (and
  // under a picture's evidence card, which stays in colour over its greyed backdrop).
  let look: string | null = null;
  if (args.look) {
    const track = freeAbove(project, upperTrack, cut.start, cut.end);
    const id = freshId(project, "c");
    project.clips.push(
      clipOfFields({
        id,
        track,
        start: cut.start,
        duration: cut.end - cut.start,
        color: "blue",
        name: `${prefix}B-roll look`,
        type: "adjustment",
        grade: { exposure: 0, contrast: 0, saturation: -0.6, temperature: 0, vignette: 0.3 },
        opacity: 1,
      }),
    );
    look = id;
  }

  const placed: Record<string, unknown>[] = [];
  const smooth: string[] = [];
  args.shots.forEach((shot, index) => {
    const [start, end] = spans[index]!;
    const media = mediaOf(project, shot.media);
    if (media === undefined) throw new Error(`shot ${index + 1}: no media ${shot.media}`);
    const still = media.kind === "image";
    if (media.kind === "audio") throw new Error(`shot ${index + 1}: ${shot.media} is audio`);
    const speed = still ? 1 : Math.min(Math.max(shot.speed ?? 0.5, 0.05), 20);
    const duration = end - start + extend[index]!;
    const upper = onUpper[index]!;
    // The upper of a dissolving pair fades: in from the shot under it, or out over the next.
    const fadeIn = upper && index > 0 && extend[index - 1]! > 0 ? extend[index - 1]! : 0;
    const fadeOut = upper ? extend[index]! : 0;
    const needs = (duration / fps) * speed;
    if (!Number.isFinite(shot.source_in) || shot.source_in < 0) {
      throw new Error(`shot ${index + 1}: source_in must be finite and nonnegative`);
    }
    if (!still && shot.source_in + needs > media.duration + 0.05) {
      throw new Error(
        `shot ${index + 1}: ${shot.media} runs out at ${fixed(media.duration, 2)} s; from ${fixed(shot.source_in, 2)} s at ${display(speed)}× this shot needs ${fixed(needs, 2)} s of it`,
      );
    }
    const label = shot.name ?? `shot ${index + 1}`;
    // A picture is never a bare still: it goes on as an evidence card.
    if (still) {
      const blur = freeAbove(project, shotsTrack, start, end);
      const photo = freeAbove(project, blur, start, end);
      const over = freeAbove(project, photo, start, end);
      let clips: string[];
      try {
        clips = graphics.card(
          project,
          shot.media,
          [start, end],
          shot.label,
          { backdrop: shotsTrack, blur, photo, label: over },
          `${prefix}B-roll: ${label} · card `,
        );
      } catch (error) {
        if (error instanceof Error && !(error instanceof TypeError || error instanceof RangeError)) {
          throw new Error(`shot ${index + 1}: ${error.message}`);
        }
        throw error;
      }
      placed.push({
        clip: clips[0] ?? null,
        name: label,
        evidence_card: clips,
        start: start / fps,
        end: end / fps,
      });
      return;
    }
    const scale = shot.scale ?? 1;
    const [from, to] = shot.push ?? [1, 1.08];
    const id = freshId(project, "c");
    project.clips.push(
      clipOfFields({
        id,
        track: upper ? upperTrack : shotsTrack,
        start,
        duration,
        color: "cyan",
        name: `${prefix}B-roll: ${label}`,
        fade_in: fadeIn,
        fade_out: fadeOut,
        type: "video",
        media: shot.media,
        source_in: Math.max(shot.source_in, 0),
        speed,
        transform: { x: shot.x ?? 0, y: shot.y ?? 0, scale, rotation: 0 },
        opacity: 1,
        keyframes: {
          scale: [
            { frame: 0, value: scale * from, ease: "linear" },
            { frame: Math.max(duration - 1, 1), value: scale * to, ease: "linear" },
          ],
        },
      }),
    );
    if (!still && speed < 0.999 && (shot.smooth ?? smoothByDefault)) smooth.push(id);
    placed.push({
      clip: id,
      name: label,
      start: start / fps,
      end: end / fps,
      source: [shot.source_in, shot.source_in + needs],
    });
  });

  // The vertical drop into the cut-in, straddling the cut above everything.
  let dropped: string | null = null;
  if (drop && cut.start >= 3) {
    const [start, end] = [cut.start - 3, cut.start + 3];
    const track = freeOnTop(project, start, end);
    const id = freshId(project, "c");
    project.clips.push(
      clipOfFields({
        id,
        track,
        start,
        duration: end - start,
        color: "blue",
        name: `${prefix}vertical drop`,
        type: "adjustment",
        grade: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, vignette: 0 },
        shake: { preset: "vertical" },
        opacity: 1,
      }),
    );
    dropped = id;
  }

  // The voice-over onto A1 (the footage's sound track, free under B-roll), purple.
  let voiceover: Record<string, unknown> | null = null;
  if (cut.voiceover !== null) {
    const vo = cut.voiceover;
    const a1 = project.tracks.find((track) => track.kind === "audio")?.id ?? null;
    const own = clipOf(project, vo);
    const [start, end] = own === undefined ? [0, 0] : [own.start, clipEnd(own)];
    const free =
      a1 !== null &&
      !project.clips.some((clip) => clip.id !== vo && clip.track === a1 && clip.start < end && start < clipEnd(clip));
    if (a1 !== null && free && own !== undefined) {
      own.track = a1;
      own.color = "purple";
      voiceover = { clip: vo, moved_to_a1: true };
    } else {
      voiceover = { clip: vo, moved_to_a1: false, why: "A1 isn't free under it" };
    }
  }

  const report = {
    cut_in: cut.number,
    span: [cut.start / fps, cut.end / fps],
    shots: placed,
    look,
    vertical_drop: dropped,
    removed_card_and_words: removed,
    voiceover,
  };
  return [report, smooth];
}
