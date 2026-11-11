// Edit V2's cloud (v2_cloud.ts), the library (Nov 11, Sphe: "v2's cloud where its code and
// skills should live"): what Bodycam HQ's agent makes and is taught, kept by
// the team rather than by one computer or by Edit's release, every save a
// numbered version beside the others with one in use. Three kinds of item:
//
//     effect:<project>/<name>   a project's coded effect: its folder's files at each settled version
//     template:<name>           an effect every project can start from (a teacher's to change)
//     skill:<path>              the agent's text at agent/<path>, read over the release's (a teacher's)
//
// The versions and pointers are mamagi's (edit:listLibrary, libraryVersions,
// libraryVersion, saveLibraryVersion, setLibraryCurrent; accounts'
// convex/edit.ts), the files R2's, each once, by its content
// (edit/library/sha256/<hex>), through the relay as everything of Edit's is.
// Nothing here happens signed out (no cloud): an effect then has only its
// folder, and the agent the release's text.

import fs from "node:fs";
import { dirname, join, sep } from "node:path";
import type { App } from "./app.ts";
import * as accounts from "./accounts.ts";
import * as cloud from "./cloud.ts";
import { sha256File } from "./cloud_media.ts";
import * as diag from "./diag.ts";
import { granted } from "./kinds.ts";
import * as relay from "./relay.ts";

export type Kind = "effect" | "template" | "skill";

export interface File {
  /** Inside the effect's folder ("scene.html", "img/top.jpg"). */
  path: string;
  sha256: string;
  size: number;
}

export interface Item {
  key: string;
  kind: Kind;
  projectId: string | null;
  name: string;
  current: number;
  latest: number;
  note: string | null;
  at: number;
  by: { name: string } | null;
}

export interface Version {
  key: string;
  n: number;
  files: File[] | null;
  text?: string | null;
  reason: string | null;
  from: { key: string; n: number } | null;
  source: string | null;
  at: number;
  by: { name: string } | null;
}

/** Whether the library is there: signed in (or a relay token), so the cloud is. */
export function enabled(): boolean {
  return relay.cloudEnabled();
}

/** Whether the person on this computer is a teacher (`agent.teach`; an admin, or nobody signed in in tests, is one). */
export function teacher(): boolean {
  const given = granted();
  return given === null || given.has("agent.teach");
}

export const effectKey = (project: string, name: string) => `effect:${project}/${name}`;
export const templateKey = (name: string) => `template:${name}`;
export const skillKey = (path: string) => `skill:${path}`;

const fileKey = (sha256: string) => `edit/library/sha256/${sha256}`;

export async function list(kind: Exclude<Kind, "effect">): Promise<Item[]> {
  return (await cloud.query("edit:listLibrary", { kind })) as Item[];
}

export async function projectEffects(project: string): Promise<Item[]> {
  return (await cloud.query("edit:listLibrary", { projectId: project })) as Item[];
}

export async function versions(key: string, text = false): Promise<Version[]> {
  return (await cloud.query("edit:libraryVersions", { key, ...(text ? { text: true } : {}) })) as Version[];
}

/** A version (`n`, else the one in use) and its item; null when the item has none. */
export async function version(key: string, n: number | null = null): Promise<{ item: Item; version: Version } | null> {
  return (await cloud.query("edit:libraryVersion", { key, ...(n === null ? {} : { n }) })) as { item: Item; version: Version } | null;
}

export async function setCurrent(key: string, n: number): Promise<void> {
  await cloud.mutation("edit:setLibraryCurrent", { key, n });
}

/** Every file in a folder, however deep, by its path inside it. */
function walk(dir: string, under = ""): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(join(dir, under), { withFileTypes: true })) {
    const inside = under === "" ? entry.name : `${under}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(dir, inside));
    else if (entry.isFile() && !entry.name.endsWith(".partial.mp4")) found.push(inside);
  }
  return found.sort();
}

/** A folder's files in R2, each once by its content: the list of them. */
async function putFiles(dir: string): Promise<File[]> {
  const files: File[] = [];
  for (const path of walk(dir)) {
    const full = join(dir, path);
    const sha256 = await sha256File(full);
    if (!(await cloud.has(fileKey(sha256)))) await cloud.uploadFile(full, fileKey(sha256));
    files.push({ path, sha256, size: fs.statSync(full).size });
  }
  return files;
}

/**
 * A version's files into `dir`, which then holds them and nothing else:
 * built beside it and swapped in, so a page is never half the old and half
 * the new.
 */
async function getFiles(files: File[], dir: string): Promise<void> {
  const fresh = `${dir}.incoming-${process.pid}`;
  fs.rmSync(fresh, { recursive: true, force: true });
  for (const file of files) {
    const target = join(fresh, file.path);
    if (!target.startsWith(fresh + sep)) throw new Error(`a file outside the folder: ${file.path}`);
    fs.mkdirSync(dirname(target), { recursive: true });
    // The same content already here (most of a revision is): copied, not fetched.
    const here = join(dir, file.path);
    if (fs.existsSync(here) && (await sha256File(here)) === file.sha256) fs.copyFileSync(here, target);
    else await cloud.download(fileKey(file.sha256), target);
  }
  const old = `${dir}.outgoing-${process.pid}`;
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(dir)) fs.renameSync(dir, old);
  fs.renameSync(fresh, dir);
  fs.rmSync(old, { recursive: true, force: true });
}

/**
 * A folder kept as the item's next version (in use at once): its files sent
 * up first, those already there not again. `source` names the code's version
 * (an effect's key): the same as the newest makes no new version.
 */
export async function save(key: string, name: string, dir: string, options: { reason?: string; from?: { key: string; n: number }; source?: string; note?: string } = {}): Promise<{ n: number; made: boolean }> {
  const files = await putFiles(dir);
  // The same files as the version in use (a version just brought back, saved again as it renders): not a new one.
  const now = await version(key).catch(() => null);
  const same = (a: File[], b: File[]) => a.length === b.length && a.every((one, at) => one.path === b[at]!.path && one.sha256 === b[at]!.sha256);
  if (now !== null && now.version.files !== null && same(files, now.version.files)) return { n: now.version.n, made: false };
  return (await cloud.mutation("edit:saveLibraryVersion", { key, name, files, ...options })) as { n: number; made: boolean };
}

/** A skill's next version (in use at once): a teacher's. */
export async function saveSkill(path: string, text: string, reason: string): Promise<{ n: number }> {
  return (await cloud.mutation("edit:saveLibraryVersion", { key: skillKey(path), name: path, text, reason })) as { n: number };
}

/** An item's version `n` (else the one in use) put in `dir`; null when the item has none. */
export async function fetchInto(key: string, n: number | null, dir: string): Promise<Version | null> {
  const found = await version(key, n);
  if (found === null || found.version.files === null) return null;
  await getFiles(found.version.files, dir);
  return found.version;
}

// ---------------------------------------------------------------- the agent's skills, over the release's

/** The skills a teacher has saved, by agent/ path, as last read; the release's text stands for the rest. */
let skills = new Map<string, string>();
let readAt = 0;
const SKILLS_FRESH_MS = 30_000;

/** The cloud's text for agent/`path`, or null to read the release's. */
export function skillText(path: string): string | null {
  return skills.get(path) ?? null;
}

/** Reads the skills a teacher has saved, at most every 30 s (a turn's start asks): a failure keeps what was read before. */
export async function refreshSkills(): Promise<void> {
  if (!enabled() || Date.now() - readAt < SKILLS_FRESH_MS) return;
  readAt = Date.now();
  try {
    const items = await list("skill");
    const next = new Map<string, string>();
    for (const item of items) {
      const found = await version(item.key);
      const text = found?.version.text;
      if (typeof text === "string") next.set(item.name, text);
    }
    skills = next;
  } catch (error) {
    diag.warn("library", `the agent's skills from the cloud: ${diag.messageOf(error)}`);
  }
}

/** The skills read again at the next ask (a teacher just saved one). */
export function forgetSkills(): void {
  readAt = 0;
}

/** Tests: the skills as given, read now. */
export function useSkillsForTests(given: Record<string, string>): void {
  skills = new Map(Object.entries(given));
  readAt = Date.now();
}

/** Who saves, for the agent's words ("you" when it's this computer's person). */
export function whoIs(by: { name: string } | null): string {
  const me = accounts.status() as { person: { name?: string } | null };
  if (by === null) return "Edit";
  return me.person?.name === by.name ? `${by.name} (this computer)` : by.name;
}

export type { App };
