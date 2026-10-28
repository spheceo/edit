// Voice-over projects, for now apart from the video projects: a
// script of lines, each spoken by an ElevenLabs voice through Edit's relay,
// kept as takes to listen to and choose between. Each lives in
// `~/.edit/voice/<id>/` (project.json, takes/<take>.mp3).
//
// Rust held a lock over every read-modify-write; here those run without an
// await between the read and the write, which is the same thing on one thread.

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import { ioMessage, nowMs, writeAtomic } from "./files.ts";
import * as media from "./media.ts";
import type { Project } from "./model.ts";
import { isFile, join, withExtension } from "./paths.ts";
import * as relay from "./relay.ts";
import { charCount, f32Saved, serdeParse, takeChars, trim } from "./rust.ts";
import { field, optional, readStruct, required, SerdeError, type Struct } from "./serde.ts";
import { validId } from "./store.ts";
import * as tools from "./tools.ts";

/** How a voice speaks (ElevenLabs' voice settings, plus which voice and model). */
export interface VoiceSettings {
  voice_id: string | null;
  voice_name: string | null;
  model_id: string;
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
  speed: number;
}

/** The team's narration voice: new voice-overs start with it. */
export const HOUSE_VOICE = "gUABw7pXQjhjt0kNFBTF";

export function defaultSettings(): VoiceSettings {
  return {
    voice_id: HOUSE_VOICE,
    voice_name: null,
    model_id: "eleven_v4",
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0,
    use_speaker_boost: true,
    // Quicker than the voice's own pace (the team's call: 1.1 on Oct 16, and
    // after Mom Leaves 5 Kids "slightly faster, maybe just 5%"; 1.2 is ElevenLabs' fastest).
    speed: 1.15,
  };
}

/** One recording of a line. */
export interface Take {
  id: string;
  created_ms: number;
  /** The words as they were when it was made (the line may have changed since). */
  text: string;
  settings: VoiceSettings;
  duration: number | null;
  characters: number;
  /** ElevenLabs' id for the request that made it: the next line's take can follow on from it (request stitching). */
  request_id?: string;
}

export interface Line {
  id: string;
  text: string;
  /** Where it came from ("Cut-in 3"), when imported from a video project. */
  label?: string;
  takes: Take[];
  /** The take to use. */
  chosen: string | null;
}

export interface VoiceProject {
  id: string;
  name: string;
  created_ms: number;
  modified_ms: number;
  voice: VoiceSettings;
  /** The video project its lines came from. */
  source?: string;
  lines: Line[];
  next_id: number;
}

export interface Summary {
  id: string;
  name: string;
  modified_ms: number;
  lines: number;
  /** Lines with a chosen take. */
  done: number;
  voice_name: string | null;
}

// serde's reading of the files and of the UI's changes (defaults, f32s, its words).

const SETTINGS: Struct = {
  name: "VoiceSettings",
  fields: [
    field("voice_id", { option: "string" }, null),
    field("voice_name", { option: "string" }, null),
    field("model_id", "string", "eleven_v4"),
    field("stability", "f32", 0.5),
    field("similarity_boost", "f32", 0.75),
    field("style", "f32", 0),
    field("use_speaker_boost", "bool", true),
    field("speed", "f32", 1),
  ],
};

const TAKE: Struct = {
  name: "Take",
  fields: [
    required("id", "string"),
    required("created_ms", "u64"),
    required("text", "string"),
    required("settings", { struct: SETTINGS }),
    field("duration", { option: "f64" }, null),
    field("characters", "u64", 0),
    optional("request_id", "string"),
  ],
};

const LINE: Struct = {
  name: "Line",
  fields: [
    required("id", "string"),
    field("text", "string", ""),
    optional("label", "string"),
    field("takes", { vec: { struct: TAKE } }, []),
    field("chosen", { option: "string" }, null),
  ],
};

const PROJECT: Struct = {
  name: "VoiceProject",
  fields: [
    required("id", "string"),
    required("name", "string"),
    required("created_ms", "u64"),
    required("modified_ms", "u64"),
    { name: "voice", kind: { struct: SETTINGS }, default: () => defaultSettings() },
    optional("source", "string"),
    field("lines", { vec: { struct: LINE } }, []),
    field("next_id", "u64", 0),
  ],
};

const LINE_CHANGE: Struct = {
  name: "LineChange",
  fields: [
    field("id", { option: "string" }, null),
    required("text", "string"),
    field("label", { option: "string" }, null),
    field("chosen", { option: "string" }, null),
  ],
};

const CHANGES: Struct = {
  name: "Changes",
  fields: [required("name", "string"), required("voice", { struct: SETTINGS }), required("lines", { vec: { struct: LINE_CHANGE } })],
};

interface LineChange {
  id: string | null;
  text: string;
  label: string | null;
  chosen: string | null;
}

/**
 * What the UI may change: names, the voice, and the lines' words, order and
 * chosen takes. Takes themselves only come from generating. Read as serde
 * reads `Changes` (a SerdeError in its words when it isn't one).
 */
export interface Changes {
  name: string;
  voice: VoiceSettings;
  lines: LineChange[];
}

export function changesFrom(value: unknown): Changes {
  return readStruct(CHANGES, value) as unknown as Changes;
}

function settingsShown(voice: VoiceSettings): VoiceSettings {
  return {
    voice_id: voice.voice_id,
    voice_name: voice.voice_name,
    model_id: voice.model_id,
    stability: voice.stability,
    similarity_boost: voice.similarity_boost,
    style: voice.style,
    use_speaker_boost: voice.use_speaker_boost,
    speed: voice.speed,
  };
}

/** A voice-over as it's always been written: fields in order, the skipped ones left out. */
export function shown(project: VoiceProject): VoiceProject {
  const out: Record<string, unknown> = {
    id: project.id,
    name: project.name,
    created_ms: project.created_ms,
    modified_ms: project.modified_ms,
    voice: settingsShown(project.voice),
  };
  if (project.source !== undefined && project.source !== null) out.source = project.source;
  out.lines = project.lines.map((line) => {
    const own: Record<string, unknown> = { id: line.id, text: line.text };
    if (line.label !== undefined && line.label !== null) own.label = line.label;
    own.takes = line.takes.map((take) => {
      const made: Record<string, unknown> = {
        id: take.id,
        created_ms: take.created_ms,
        text: take.text,
        settings: settingsShown(take.settings),
        duration: take.duration,
        characters: take.characters,
      };
      if (take.request_id !== undefined && take.request_id !== null) made.request_id = take.request_id;
      return made;
    });
    own.chosen = line.chosen;
    return own;
  });
  out.next_id = project.next_id;
  return out as unknown as VoiceProject;
}

const MAX_LINE_CHARS = 5000;

/** Keeps settings within what ElevenLabs accepts. */
function clamp(voice: VoiceSettings): VoiceSettings {
  const within = (value: number, low: number, high: number) => f32Saved(Math.min(Math.max(value, low), high));
  return {
    ...voice,
    stability: within(voice.stability, 0, 1),
    similarity_boost: within(voice.similarity_boost, 0, 1),
    style: within(voice.style, 0, 1),
    speed: within(voice.speed, f32Saved(0.7), f32Saved(1.2)),
  };
}

export class Voices {
  readonly home: string;
  private listing: [at: number, listing: unknown] | null = null;

  constructor(home: string) {
    this.home = join(home, "voice");
  }

  private dir(id: string): string {
    if (!validId(id)) throw new Error("no such voice-over");
    return join(this.home, id);
  }

  takePath(id: string, take: string): string {
    if (!validId(take)) throw new Error("no such take");
    return join(this.dir(id), "takes", `${take}.mp3`);
  }

  get(id: string): VoiceProject {
    const path = join(this.dir(id), "project.json");
    let text: string;
    try {
      text = fs.readFileSync(path, "utf8");
    } catch {
      throw new Error("no such voice-over");
    }
    try {
      return readStruct(PROJECT, serdeParse(text)) as unknown as VoiceProject;
    } catch (error) {
      throw new Error(`${path} can't be read: ${diag.messageOf(error)}`);
    }
  }

  /** Writes a voice-over (as `to_vec_pretty` lays it out), stamping it modified now. */
  save(project: VoiceProject): void {
    project.modified_ms = nowMs();
    const dir = this.dir(project.id);
    try {
      fs.mkdirSync(join(dir, "takes"), { recursive: true });
      writeAtomic(join(dir, "project.json"), JSON.stringify(shown(project), null, 2));
    } catch (error) {
      throw new Error(ioMessage(error));
    }
  }

  list(): Summary[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.home);
    } catch {
      names = [];
    }
    const out: Summary[] = [];
    for (const id of names) {
      let project: VoiceProject;
      try {
        project = this.get(id);
      } catch {
        continue;
      }
      out.push({
        id: project.id,
        name: project.name,
        modified_ms: project.modified_ms,
        lines: project.lines.length,
        done: project.lines.filter((line) => line.chosen !== null).length,
        voice_name: project.voice.voice_name,
      });
    }
    return out.sort((a, b) => b.modified_ms - a.modified_ms);
  }

  /** A new voice-over; with `lines`, one line each (e.g. a video project's cut-ins). */
  create(name: string, source: string | null, lines: [string, string | null][], voiceId: string | null = null): VoiceProject {
    const now = nowMs();
    const project: VoiceProject = {
      id: `v${now}`,
      name: trim(name) === "" ? "Untitled voice-over" : trim(name),
      created_ms: now,
      modified_ms: now,
      voice: voiceId === null ? defaultSettings() : { ...defaultSettings(), voice_id: voiceId },
      lines: [],
      next_id: 0,
    };
    if (source !== null) project.source = source;
    for (const [text, label] of lines.length === 0 ? ([["", null]] as [string, string | null][]) : lines) {
      project.next_id += 1;
      const line: Line = { id: `l${project.next_id}`, text, takes: [], chosen: null };
      if (label !== null) line.label = label;
      project.lines.push(line);
    }
    while (fs.existsSync(this.dir(project.id))) {
      project.id = `v${now}-${project.next_id}`;
      project.next_id += 1;
    }
    this.save(project);
    diag.info("voice", `created voice-over ${project.name} (${project.lines.length} lines)`);
    return project;
  }

  /** Video project `source`'s voice-over of these lines: the latest one made from the same words, or a new one. */
  forProject(name: string, source: string, lines: [string, string | null][], voiceId: string | null = null): VoiceProject {
    for (const summary of this.list()) {
      let project: VoiceProject;
      try {
        project = this.get(summary.id);
      } catch {
        continue;
      }
      if (
        project.source === source &&
        project.lines.length === lines.length &&
        project.lines.every((line, index) => line.text === lines[index]![0])
      ) {
        return project;
      }
    }
    return this.create(name, source, lines, voiceId);
  }

  update(id: string, given: unknown): VoiceProject {
    const changes = changesFrom(given);
    const project = this.get(id);
    if (trim(changes.name) !== "") project.name = trim(changes.name);
    project.voice = clamp(changes.voice);
    const old = project.lines;
    project.lines = [];
    for (const change of changes.lines) {
      const at = change.id === null ? -1 : old.findIndex((line) => line.id === change.id);
      let line: Line;
      if (at >= 0) {
        line = old.splice(at, 1)[0]!;
      } else {
        project.next_id += 1;
        line = { id: `l${project.next_id}`, text: "", takes: [], chosen: null };
      }
      line.text = takeChars(change.text, MAX_LINE_CHARS);
      if (change.label === null) delete line.label;
      else line.label = change.label;
      line.chosen = change.chosen !== null && line.takes.some((take) => take.id === change.chosen) ? change.chosen : null;
      project.lines.push(line);
    }
    // Lines left out were deleted: their takes go too.
    for (const line of old) {
      for (const take of line.takes) fs.rmSync(this.takePath(id, take.id), { force: true });
    }
    this.save(project);
    return project;
  }

  delete(id: string): void {
    const dir = this.dir(id);
    const bin = join(this.home, "deleted");
    try {
      fs.mkdirSync(bin, { recursive: true });
      // Kept aside, like video projects, so a deletion can be undone by hand.
      fs.renameSync(dir, join(bin, `${id}-${nowMs()}`));
    } catch (error) {
      throw new Error(ioMessage(error));
    }
  }

  deleteTake(id: string, lineId: string, take: string): VoiceProject {
    const project = this.get(id);
    const line = project.lines.find((own) => own.id === lineId);
    if (line === undefined) throw new Error("no such line");
    line.takes = line.takes.filter((candidate) => candidate.id !== take);
    if (line.chosen === take) line.chosen = line.takes.at(-1)?.id ?? null;
    fs.rmSync(this.takePath(id, take), { force: true });
    this.save(project);
    return project;
  }

  /** Speaks a line with the project's voice: a new take, chosen. */
  async generate(id: string, lineId: string): Promise<VoiceProject> {
    const project = this.get(id);
    const index = project.lines.findIndex((line) => line.id === lineId);
    if (index < 0) throw new Error("no such line");
    const settings = structuredClone(project.voice);
    const voice = settings.voice_id;
    if (voice === null) throw new Error("Choose a voice first.");
    const line = project.lines[index]!;
    const text = trim(line.text);
    if (text === "") throw new Error("This line has no words yet.");
    // The lines around it, so the delivery flows from one into the next.
    const neighbour = (offset: number): string | null => {
      const near = project.lines[index + offset];
      if (near === undefined) return null;
      const words = trim(near.text);
      return words === "" ? null : words;
    };
    // The take chosen for the line before, if made with this model: this
    // line carries on from how that one was actually said.
    const before = index > 0 ? project.lines[index - 1] : undefined;
    const stitched = before?.takes.find((take) => take.id === before.chosen);
    const previous =
      stitched !== undefined && stitched.settings.model_id === settings.model_id && stitched.request_id !== undefined && stitched.request_id !== null
        ? [stitched.request_id]
        : null;
    // Keys as serde_json's json! wrote them (sorted).
    const body = {
      model_id: settings.model_id,
      next_text: neighbour(1),
      output_format: "mp3_44100_128",
      previous_request_ids: previous,
      previous_text: neighbour(-1),
      text,
      voice_id: voice,
      voice_settings: {
        similarity_boost: settings.similarity_boost,
        speed: settings.speed,
        stability: settings.stability,
        style: settings.style,
        use_speaker_boost: settings.use_speaker_boost,
      },
    };
    const takeId = `t${nowMs()}`;
    const path = this.takePath(id, takeId);
    fs.mkdirSync(join(this.dir(id), "takes"), { recursive: true });
    const subject = `${project.name} line ${index + 1}`;
    const requestId = await diag.timeOnAsync("voice", "voice: generate a line", subject, () => speak(body, path));
    let duration: number | null = null;
    try {
      duration = (await media.probe(path)).duration;
    } catch {
      duration = null;
    }

    // Read again: the words or other lines may have changed while it spoke.
    const now = this.get(id);
    const spoken = now.lines.find((own) => own.id === lineId);
    if (spoken === undefined) {
      fs.rmSync(path, { force: true });
      throw new Error("The line was deleted while it was being spoken.");
    }
    const take: Take = { id: takeId, created_ms: nowMs(), text, settings, duration, characters: charCount(text) };
    if (requestId !== null) take.request_id = requestId;
    spoken.takes.push(take);
    spoken.chosen = takeId;
    this.save(now);
    return now;
  }

  /** Each line's chosen take, in order (line number, label, file). */
  chosenTakes(id: string): [number, string | null, string][] {
    const project = this.get(id);
    const out: [number, string | null, string][] = [];
    project.lines.forEach((line, index) => {
      if (line.chosen === null) return;
      let path: string;
      try {
        path = this.takePath(id, line.chosen);
      } catch {
        return;
      }
      if (isFile(path)) out.push([index + 1, line.label ?? null, path]);
    });
    return out;
  }

  /** The account's voices (from the relay), kept for ten minutes. */
  async voices(refresh: boolean): Promise<unknown> {
    if (!refresh && this.listing !== null && performance.now() - this.listing[0] < 600_000) return this.listing[1];
    const listing = await diag.timeOnAsync("voice", "voice: list voices", "relay", () =>
      relay.json<unknown>("GET", "/v1/voices", null, "voices", 300),
    );
    this.listing = [performance.now(), listing];
    return listing;
  }

  /** Every chosen take, in order, as one file (lines without one are skipped). */
  async full(id: string): Promise<string> {
    const project = this.get(id);
    const takes: string[] = [];
    for (const line of project.lines) {
      if (line.chosen === null) continue;
      let path: string;
      try {
        path = this.takePath(id, line.chosen);
      } catch {
        continue;
      }
      if (isFile(path)) takes.push(path);
    }
    if (takes.length === 0) throw new Error("No lines have been spoken yet.");
    const out = join(this.dir(id), "full.mp3");
    const list = join(this.dir(id), "full.txt");
    try {
      fs.writeFileSync(list, takes.map((path) => `file '${path.replaceAll("'", "'\\''")}'\n`).join(""));
    } catch (error) {
      throw new Error(ioMessage(error));
    }
    let code: number;
    let stderr: string;
    try {
      const child = Bun.spawn(
        [tools.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c:a", "libmp3lame", "-b:a", "192k", out],
        { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
      );
      [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    } catch (error) {
      fs.rmSync(list, { force: true });
      throw new Error(`ffmpeg: ${diag.messageOf(error)}`);
    }
    fs.rmSync(list, { force: true });
    if (code !== 0) throw new Error(`joining the takes failed: ${trim(stderr)}`);
    return out;
  }
}

/** The lines of a video project's script narration (its cut-ins), in order. */
export function narrationLines(project: Project): [string, string | null][] {
  return (project.script?.blocks ?? [])
    .flatMap((block) => (block.kind === "narration" ? [trim(block.text)] : []))
    .filter((text) => text !== "")
    .map((text, index): [string, string | null] => [text, `Cut-in ${index + 1}`]);
}

/**
 * Sends `body` to the relay's /v1/speech and writes the audio to `path`.
 * Returns ElevenLabs' request id, for stitching the next line onto it.
 */
async function speak(body: unknown, path: string): Promise<string | null> {
  const partial = withExtension(path, "partial");
  try {
    // A connection dropped part way (JJ, Oct 26: "The socket connection was
    // closed unexpectedly") is tried again, twice, before the line fails.
    let request: string | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        request = await relay.call("POST", "/v1/speech", body, partial, "voices");
        break;
      } catch (error) {
        if (attempt >= SPEAK_RETRIES || !(error instanceof Error) || !error.message.startsWith(relay.UNREACHABLE)) throw error;
        diag.warn("voice", `speaking a line: ${error.message}; trying again`);
        await timing.sleep(2000 * (attempt + 1));
      }
    }
    try {
      fs.renameSync(partial, path);
    } catch (error) {
      throw new Error(ioMessage(error));
    }
    return request;
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
}

/** Waits between tries (tests make them instant). */
export const timing = { sleep: (ms: number) => Bun.sleep(ms) };
/** Times a line is asked for again after the relay couldn't be reached. */
const SPEAK_RETRIES = 2;

export { SerdeError };

// Its routes live beside the package's other routes (script_tools.ts).
export { voiceRoutes as routes } from "./script_tools.ts";
