// Bodycams: which camera each moment of a file was filmed on, read off the
// ID the camera burns into its picture ("AXON BODY 4 D01A2379M"), and the
// voices split by it. A bodycam's wearer is one officer, never seen, and
// the closest voice; two partners' cameras cut together sound alike to
// Scribe, which heard them as one voice. On "Terrified Child Secretly Calls
// 911" McCall's camera ran 1½ minutes and his partner's the other 23: the
// partner's 2,066 words were all labelled McCall. Split by camera, naming
// (speakers.ts) sees two voices, the one that says "I'm Officer McCall" on
// his own camera and the one that says "McCall did" on the other.
//
// The IDs are read by Gemini (the watcher's route) from strips of the
// picture's top and bottom edges every few seconds, tiled onto a few sheets:
// a cent or two a file. Apple's text recognition reads them too, but garbled
// ("D@IA2379M", "1OalA45'5"), and every maker's overlay differs.

import * as fs from "node:fs";
import * as os from "node:os";

import * as diag from "./diag.ts";
import { serdeParse, trim } from "./rust.ts";
import * as tools from "./tools.ts";
import type { Transcript } from "./transcribe.ts";

/** Seconds between frames read (more on a long file: at most `MOST` frames). */
const EVERY = 5;
const MOST = 720;
/** Frames on one sheet (4 across). */
const PER_SHEET = 120;
/** A camera read on fewer frames than this is a misreading. */
const LEAST_FRAMES = 3;
/** A voice is split only where it says this many words on a camera. */
const LEAST_WORDS = 20;

/** The camera (its ID) at each read frame, from `start` every `step` seconds; "" where none shows. */
export interface Reading {
  step: number;
  ids: string[];
}

/**
 * Splits `transcript`'s voices by bodycam when its file shows more than one
 * camera: a voice with `LEAST_WORDS` words on two cameras keeps its number on
 * the camera it says most on and takes a new one on each other; every voice's
 * camera is written to `transcript.cameras`. Nothing to do for a file with
 * no picture, one camera, or no route to the model.
 */
export async function split(source: string, transcript: Transcript): Promise<void> {
  if (!transcript.words.some((word) => word.speaker !== undefined)) return;
  const seconds = await videoLength(source);
  if (seconds === null || seconds < EVERY * LEAST_FRAMES * 2) return;
  const reading = await read(source, seconds);
  if (reading === null) return;
  apply(transcript, reading);
}

/** Splits the voices by the cameras read (see `split`). */
export function apply(transcript: Transcript, reading: Reading): void {
  const ids = cleaned(reading.ids);
  if (new Set(ids.filter((id) => id !== "")).size < 2) return;
  const cameraAt = (time: number) => ids[Math.min(Math.max(Math.round(time / reading.step), 0), ids.length - 1)] ?? "";
  // Words per voice per camera.
  const counts = new Map<string, Map<string, number>>();
  for (const word of transcript.words) {
    const camera = cameraAt(word.start);
    if (word.speaker === undefined || camera === "") continue;
    const voice = counts.get(word.speaker) ?? new Map<string, number>();
    voice.set(camera, (voice.get(camera) ?? 0) + 1);
    counts.set(word.speaker, voice);
  }
  const used = new Set(transcript.words.map((word) => word.speaker).filter((voice) => voice !== undefined));
  let free = 0;
  const fresh = () => {
    while (used.has(`speaker_${free}`)) free += 1;
    const voice = `speaker_${free}`;
    used.add(voice);
    return voice;
  };
  const cameras: Record<string, string> = {};
  const renamed = new Map<string, string>();
  for (const [voice, byCamera] of [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const ranked = [...byCamera].filter(([, count]) => count >= LEAST_WORDS).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const main = ranked[0]?.[0] ?? [...byCamera].sort((a, b) => b[1] - a[1])[0]![0];
    cameras[voice] = main;
    for (const [camera] of ranked.slice(1)) {
      const other = fresh();
      renamed.set(`${voice}\n${camera}`, other);
      cameras[other] = camera;
    }
  }
  if (renamed.size > 0) {
    for (const word of transcript.words) {
      if (word.speaker === undefined) continue;
      const other = renamed.get(`${word.speaker}\n${cameraAt(word.start)}`);
      if (other !== undefined) word.speaker = other;
    }
  }
  transcript.cameras = cameras;
}

/**
 * The IDs as one spelling each: upper case without spaces, a misreading one
 * character off a commoner ID taken as that ID, an ID seen on fewer than
 * `LEAST_FRAMES` frames dropped, and a lone frame between two of the same
 * camera taken as that camera.
 */
export function cleaned(given: readonly string[]): string[] {
  const ids = given.map((id) => trim(id).toUpperCase().replace(/\s+/g, ""));
  const counts = new Map<string, number>();
  for (const id of ids) if (id !== "") counts.set(id, (counts.get(id) ?? 0) + 1);
  const common = [...counts].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const canonical = new Map<string, string>();
  for (const id of common) {
    const near = common.find((other) => other !== id && (counts.get(other) ?? 0) > (counts.get(id) ?? 0) && oneApart(id, other));
    canonical.set(id, near !== undefined ? (canonical.get(near) ?? near) : id);
  }
  const merged = ids.map((id) => (id === "" ? "" : canonical.get(id)!));
  const totals = new Map<string, number>();
  for (const id of merged) if (id !== "") totals.set(id, (totals.get(id) ?? 0) + 1);
  const kept = merged.map((id) => (id !== "" && (totals.get(id) ?? 0) >= LEAST_FRAMES ? id : ""));
  return kept.map((id, index) => {
    const before = kept[index - 1];
    const after = kept[index + 1];
    return before !== undefined && before !== "" && before === after && id !== before ? before : id;
  });
}

/** Whether two IDs differ by one character (changed, added or dropped). */
function oneApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
}

/** The picture's length, or null for a file without one. */
async function videoLength(source: string): Promise<number | null> {
  const probe = Bun.spawn(
    [tools.ffprobe(), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type:format=duration", "-of", "json", source],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  const [out] = await Promise.all([new Response(probe.stdout).text(), probe.exited]);
  try {
    const value = JSON.parse(out) as { streams?: { codec_type?: string }[]; format?: { duration?: string } };
    if (!(value.streams ?? []).some((stream) => stream.codec_type === "video")) return null;
    const seconds = Number.parseFloat(value.format?.duration ?? "");
    return Number.isFinite(seconds) ? seconds : null;
  } catch {
    return null;
  }
}

/** Reads the camera IDs off `source`: sheets of edge strips, one model call each. Null without a route. */
export async function read(source: string, seconds: number): Promise<Reading | null> {
  const watch = await import("./watch.ts");
  const step = Math.max(EVERY, seconds / MOST);
  const dir = fs.mkdtempSync(`${os.tmpdir()}/edit-cameras-`);
  try {
    // Each frame's top and bottom eighth stacked, 480 wide: an overlay's ID reads at that size.
    const filter =
      `fps=1/${step.toFixed(3)},split[a][b];[a]crop=iw:ih/8:0:0[top];[b]crop=iw:ih/8:0:ih*7/8[bottom];` +
      `[top][bottom]vstack,scale=480:-2,pad=iw+4:ih+4:2:2:red,tile=4x${PER_SHEET / 4}`;
    const made = Bun.spawn([tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-filter_complex", filter, "-q:v", "4", `${dir}/sheet-%03d.jpg`], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(made.stderr).text(), made.exited]);
    if (code !== 0) throw new Error(`couldn't cut the camera strips: ${stderr.trim()}`);
    const frames = Math.floor(seconds / step) + 1;
    const sheets = fs.readdirSync(dir).filter((name) => name.startsWith("sheet-")).sort();
    const ids = new Array<string>(frames).fill("");
    let cost = 0;
    for (const [index, name] of sheets.entries()) {
      const first = index * PER_SHEET;
      const count = Math.min(PER_SHEET, frames - first);
      if (count <= 0) break;
      const body = `${dir}/ask-${index}.json`;
      fs.writeFileSync(body, JSON.stringify(question(fs.readFileSync(`${dir}/${name}`).toString("base64"), count)));
      let answer: unknown;
      try {
        answer = await watch.post(body);
      } catch (error) {
        // No cloud token or gateway key: no cameras, not a failed transcript.
        if (/needs the cloud token/.test(diag.messageOf(error))) return null;
        throw error;
      }
      const usage = (answer as { usage?: { cost?: unknown } } | null)?.usage?.cost;
      if (typeof usage === "number") cost += usage;
      for (const [at, id] of tiles(answer, count)) ids[first + at] = id;
    }
    diag.info("media", `${source}: bodycam IDs read on ${sheets.length} sheets ($${cost.toFixed(4)}): ${[...new Set(ids.filter((id) => id !== ""))].join(", ") || "none"}`);
    return { step, ids };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The request for one sheet of `count` tiles. */
function question(jpeg: string, count: number): unknown {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["tiles"],
    properties: {
      tiles: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["n", "id"],
          properties: { n: { type: "integer" }, id: { type: "string" } },
        },
      },
    },
  };
  return {
    model: "google/gemini-3.8-flash",
    reasoning: { effort: "low" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `This sheet has ${count} tiles in red borders, numbered 0 to ${count - 1} left to right, top to bottom. ` +
              "Each is the top and bottom edge of one frame of police or security footage. For each tile give the camera's " +
              "device ID or serial from the overlay burned into the picture (in \"AXON BODY 4 D01A2379M\" it is \"D01A2379M\"; " +
              "the date, time and maker are not the ID), exactly as shown, or \"\" when the tile shows none. Answer every tile.",
          },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg}` } },
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: { name: "cameras", strict: true, schema } },
  };
}

/** The (tile, ID) pairs in a model's answer; tiles outside the sheet ignored. */
function tiles(answer: unknown, count: number): [number, string][] {
  const content = (answer as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("the model gave no answer");
  let value: unknown;
  try {
    value = serdeParse(trim(content).replace(/^```(?:json)?/, "").replace(/```$/, ""));
  } catch {
    throw new Error("the model's answer isn't the JSON asked for");
  }
  const list = (value as { tiles?: unknown } | null)?.tiles;
  if (!Array.isArray(list)) throw new Error("the model's answer has no tiles");
  const out: [number, string][] = [];
  for (const item of list as { n?: unknown; id?: unknown }[]) {
    if (typeof item?.n === "number" && Number.isInteger(item.n) && item.n >= 0 && item.n < count && typeof item.id === "string") out.push([item.n, item.id]);
  }
  return out;
}
