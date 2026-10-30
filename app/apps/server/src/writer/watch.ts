// The watcher for a script's footage, on Edit's (watch.ts: the same windows
// of a few minutes, the same Gemini question, cache and retries): right
// after transcription it watches the footage with its sound and says who
// speaks each line, and who each person is when the footage says it. Speech
// to text tells voices apart by sound alone, so it gives two detectives who
// sound alike one label, or one person two; seeing whose mouth moves fixes
// that. Its answers correct `word.speaker` and fill `script.speakers`.
// Each window's answer is kept in the script's `watch` folder, so a retry
// never pays for it twice.

import * as fs from "node:fs";
import { createHash } from "node:crypto";

import type { Script, Word } from "@edit/types/writer";

import * as diag from "../diag.ts";
import { writeAtomic } from "../files.ts";
import { isFile, join } from "../paths.ts";
import { BACKGROUND } from "../speakers.ts";
import * as edit from "../watch.ts";
import * as media from "./media.ts";
import * as store from "./store.ts";

/** Windows watched at once. */
const AT_ONCE = 8;

/** What the watcher did, for the import's notes. */
export interface Report {
  windows: number;
  cached: number;
  failed: string[];
  cost: number;
  linesChanged: number;
  labels: Record<string, string>;
}

/** The last run's state, so Retry unfinished speaker checks knows there's something to finish. */
export interface Status {
  total: number;
  checked: number;
  failed: string[];
  at: number;
  needsApply?: boolean;
}

const statusPath = (dir: string) => join(dir, "watch", "status.json");

export function status(dir: string): Status | null {
  try {
    return JSON.parse(fs.readFileSync(statusPath(dir), "utf8")) as Status;
  } catch {
    return null;
  }
}

export function applied(dir: string): void {
  const found = status(dir);
  if (found !== null) writeAtomic(statusPath(dir), JSON.stringify({ ...found, needsApply: false }));
}

/** Warnings of the visual path, superseded by a successful retry or by caption turns. */
export function clearNotes(script: Script): void {
  script.notes = (script.notes ?? []).filter((note) => !note.includes("stretches of footage couldn't be watched") && !note.includes("Visual speaker checks couldn't finish") && !note.startsWith("Writer couldn't watch the footage") && !note.startsWith("Edit couldn't watch the footage"));
}

/** Speaker corrections must not change the next retry's lines, windows or cache keys: the transcription before any visual change is kept. */
function inputFingerprint(script: Script): string {
  const hash = createHash("sha256");
  hash.update(String(script.durationMs));
  for (const part of script.parts ?? []) hash.update(`${part.startMs}:${part.durationMs}:${part.audio ? 1 : 0};`);
  for (const word of script.words) hash.update(`${word.startMs}:${word.endMs}:${word.id}\0${word.text}\0`);
  return hash.digest("hex");
}

function prepareInput(script: Script, dir: string): void {
  const path = join(dir, "watch", "input.json");
  fs.mkdirSync(join(dir, "watch"), { recursive: true });
  const fingerprint = inputFingerprint(script);
  try {
    const kept = JSON.parse(fs.readFileSync(path, "utf8")) as { fingerprint: string; words: Word[] };
    if (kept.fingerprint === fingerprint) {
      script.words = kept.words;
      return;
    }
  } catch {
    // First run.
  }
  writeAtomic(path, JSON.stringify({ fingerprint, words: script.words }));
}

/** The stretches of footage with a picture, by recording: [group, from, to] in ms. A joined case's audio recordings, or an audio file, have nothing to see. */
export async function stretches(script: Script): Promise<[number, number, number][]> {
  const parts = script.parts ?? [];
  if (parts.length === 0) {
    const video = await media.streams(script.originalPath).then((found) => found.video, () => false);
    return video ? [[0, 0, script.durationMs]] : [];
  }
  return parts.flatMap((part, group): [number, number, number][] => (part.audio ? [] : [[group, part.startMs, Math.min(part.startMs + part.durationMs, script.durationMs)]]));
}

/** Someone is named only by a full name, as Haiku names them: first and last, or first name and initial. */
const fullName = (name: string): boolean => name.split(/\s+/).filter((word) => word !== "").length >= 2;

/** The value given most often, ignoring case (the first of a tie). */
function most(values: string[]): string | null {
  const counts: [string, number][] = [];
  for (const value of values) {
    const seen = counts.find(([known]) => known.toLowerCase() === value.toLowerCase());
    if (seen) seen[1]++;
    else counts.push([value, 1]);
  }
  let best: [string, number] | null = null;
  for (const entry of counts) if (best === null || entry[1] > best[1]) best = entry;
  return best?.[0] ?? null;
}

const tidy = (text: string): string => [...text.replace(/[()[\]]/g, "").split(/\s+/).filter((word) => word !== "").join(" ")].slice(0, 48).join("");
const capitalized = (text: string): string => (text === "" ? "" : text[0]!.toUpperCase() + text.slice(1));

/** "Name (Role)" or the role, for every voice seen, from the names and roles the windows gave it; unique within a recording ("Officer 2"). */
export function labels(said: Map<string, [number, string, string[], string[]]>): Record<string, string> {
  const out: Record<string, string> = {};
  const taken = new Map<number, string[]>();
  for (const [group, voice, roles, names] of [...said.values()].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))) {
    const role = tidy(most(roles) ?? "");
    const name = tidy(most(names) ?? "");
    if (name === "" && role === "") continue;
    const base = name !== "" ? (role !== "" ? `${name} (${role})` : name) : capitalized(role);
    const mine = taken.get(group) ?? [];
    taken.set(group, mine);
    let label = base;
    for (let n = 2; mine.includes(label); n++) label = `${base} ${n}`;
    mine.push(label);
    out[voice] = label;
  }
  return out;
}

/**
 * Watches the script's footage and corrects who says each line: the voices
 * of `script.words`, and labels for the voices seen in `script.speakers`.
 * Null when there is nothing to watch (no picture, no words); an error when
 * no window could be watched.
 */
export async function run(script: Script, dir: string, onWindow: (done: number, total: number, cached: number) => void = () => {}, signal?: AbortSignal): Promise<Report | null> {
  if (script.words.length === 0) return null;
  prepareInput(script, dir);
  // Edit's watcher reads words in seconds of the footage; a joined case's footage is its whole preview.
  const words = script.words.map((word) => ({ text: word.text, start: word.startMs / 1000, end: word.endMs / 1000, ...(word.speaker == null ? {} : { speaker: word.speaker }) }));
  const plan: { group: number; window: edit.Window; lines: edit.WatchLine[] }[] = [];
  for (const [group, from, to] of await stretches(script)) {
    const found = edit.linesOf(words, from / 1000, to / 1000);
    for (const window of edit.windows(found.map((line) => [line.start, line.end]), from / 1000, to / 1000)) plan.push({ group, window, lines: found.slice(window.lines[0], window.lines[1]) });
  }
  if (plan.length === 0) return null;
  const proxy = store.proxyPath(dir);
  const footage = isFile(proxy) ? proxy : script.originalPath;
  const folder = join(dir, "watch");
  const report: Report = { windows: plan.length, cached: 0, failed: [], cost: 0, linesChanged: 0, labels: {} };
  const answers: ([edit.Answer, number] | null)[] = plan.map(() => null);
  let next = 0;
  let done = 0;
  onWindow(0, plan.length, 0);
  const lane = async () => {
    for (let index = next++; index < plan.length; index = next++) {
      const { window, lines } = plan[index]!;
      if (signal?.aborted) {
        report.failed.push("the watcher stopped");
        continue;
      }
      try {
        const [answer, cost, wasCached] = await edit.watchWindow(footage, folder, script.title, window, lines, script.speakers ?? {}, false);
        report.cost += cost;
        report.cached += Number(wasCached);
        answers[index] = [answer, index];
      } catch (error) {
        report.failed.push(`${edit.clock(window.start)}–${edit.clock(window.end)}: ${diag.messageOf(error)}`);
      }
      onWindow(++done, plan.length, report.cached);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, plan.length) }, lane));
  writeAtomic(statusPath(dir), JSON.stringify({ total: plan.length, checked: plan.length - report.failed.length, failed: report.failed, at: Date.now(), needsApply: true } satisfies Status));
  const watched = answers.filter((one): one is [edit.Answer, number] => one !== null);
  if (watched.length === 0) throw new Error(report.failed[0] ?? "nothing was watched");

  // Letters to voices, window by window in order, then the lines moved.
  const known = new Set(script.words.flatMap((word) => (word.speaker == null ? [] : [word.speaker])));
  const splits = new Map<string, string>();
  const said = new Map<string, [number, string, string[], string[]]>();
  for (const [answer, index] of watched) {
    const { group, lines } = plan[index]!;
    const heard = lines.map((line) => line.label);
    const voices = edit.voicesFor(answer, heard, splits, known);
    for (const person of answer.people) {
      const voice = voices.get(person.id);
      if (voice === undefined) continue;
      const key = `${group}\u0000${voice}`;
      const entry = said.get(key) ?? [group, voice, [], []];
      said.set(key, entry);
      if (person.role.trim() !== "") entry[2].push(person.role.trim());
      if (fullName(person.name)) entry[3].push(person.name.trim());
    }
    for (const [n, voice] of edit.reassigned(answer, voices, heard)) {
      // Talk in the background keeps its voice as heard: Script mode has no hidden voice.
      if (voice === BACKGROUND) continue;
      report.linesChanged++;
      for (const at of lines[n]!.words) script.words[at]!.speaker = voice;
    }
  }
  // Labels only for voices that still speak.
  const speaking = new Set(script.words.flatMap((word) => (word.speaker == null ? [] : [word.speaker])));
  for (const [key, [, voice]] of said) if (!speaking.has(voice)) said.delete(key);
  const speakers = Object.fromEntries(Object.entries(script.speakers ?? {}).filter(([voice]) => speaking.has(voice)));
  report.labels = labels(said);
  script.speakers = { ...speakers, ...report.labels };
  return report;
}
