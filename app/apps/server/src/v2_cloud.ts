// Edit V2's cloud (v2_cloud.ts), the library (Nov 11, Sphe: "v2's cloud where its code and
// skills should live"): what Bodycam HQ's agent makes and is taught, kept by
// the team rather than by one computer or by Edit's release, every save a
// numbered version beside the others with one in use. Three kinds of item:
//
//     effect:<project>/<name>   a project's coded effect: its folder's files at each settled version
//     template:<name>           an effect every project can start from (a teacher's to change)
//     sound:<name>              a sound effect as code every project can start from (a teacher's)
//     skill:<name>              something the agent was told to remember, a line or two (a teacher's);
//                               skill:global, the one every agent has, is Edit's own (accounts' setGlobalSkill)
//
// Each template and sound carries a category to search by, a note (when to
// use it) and a brief (how to change it without making it again). Put away
// ("delete" it), an item leaves every list unless asked for, its versions
// kept: what the agent sees stays short (Sphe, Nov 11: with many projects
// over time the agents "are going to get quite clouded").
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

export type Kind = "effect" | "template" | "sound" | "skill" | "font";

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
  brief: string | null;
  category: string | null;
  archived: boolean;
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
export const soundKey = (name: string) => `sound:${name}`;
export const skillKey = (name: string) => `skill:${name}`;
export const fontKey = (name: string) => `font:${name}`;
/** The one skill every agent has: Edit's own, never put away. */
export const GLOBAL = "global";

const fileKey = (sha256: string) => `edit/library/sha256/${sha256}`;

/** One kind's items; those put away only with `archived`. */
export async function list(kind: Exclude<Kind, "effect">, archived = false): Promise<Item[]> {
  return (await cloud.query("edit:listLibrary", { kind, ...(archived ? { archived: true } : {}) })) as Item[];
}

/** Puts an item away (out of every list unless asked for, its versions kept), or back. */
export async function archive(key: string, archived: boolean): Promise<void> {
  await cloud.mutation("edit:archiveLibrary", { key, archived });
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
export async function save(key: string, name: string, dir: string, options: { reason?: string; from?: { key: string; n: number }; source?: string; note?: string; brief?: string; category?: string } = {}): Promise<{ n: number; made: boolean }> {
  const files = await putFiles(dir);
  // The same files as the version in use (a version just brought back, saved again as it renders): not a new one.
  const now = await version(key).catch(() => null);
  const same = (a: File[], b: File[]) => a.length === b.length && a.every((one, at) => one.path === b[at]!.path && one.sha256 === b[at]!.sha256);
  if (now !== null && now.version.files !== null && same(files, now.version.files)) return { n: now.version.n, made: false };
  return (await cloud.mutation("edit:saveLibraryVersion", { key, name, files, ...options })) as { n: number; made: boolean };
}

/** A skill's next version (in use at once): a teacher's. A note (when to read it) makes it one read when needed rather than always in mind. */
export async function saveSkill(name: string, text: string, reason: string, note?: string): Promise<{ n: number }> {
  return (await cloud.mutation("edit:saveLibraryVersion", { key: skillKey(name), name, text, reason, ...(note !== undefined ? { note } : {}) })) as { n: number };
}

/** An item's version `n` (else the one in use) put in `dir`; null when the item has none. */
export async function fetchInto(key: string, n: number | null, dir: string): Promise<Version | null> {
  const found = await version(key, n);
  if (found === null || found.version.files === null) return null;
  await getFiles(found.version.files, dir);
  return found.version;
}

// ---------------------------------------------------------------- the agent's skills: what it's been told to remember

/**
 * One of the agent's skills: a memory (no note: always in its instructions,
 * a line or two) or a part of the edit (its note says when to read it, and
 * read_skill brings it in then), so what's always in mind stays short.
 */
export interface Skill {
  name: string;
  text: string;
  note?: string;
}

/** The skills in V2's cloud (the global one first), as last read. */
let skills: Skill[] = [];
let readAt = 0;
const SKILLS_FRESH_MS = 30_000;

/** What Bodycam HQ's agent knows: the global skill, then the rest by name. */
export function memories(): Skill[] {
  return skills;
}

/** One skill, as last read. */
export function skill(name: string): Skill | undefined {
  return skills.find((one) => one.name === name);
}

/** Reads the skills, at most every 30 s (a turn's start asks): a failure keeps what was read before. */
export async function refreshSkills(): Promise<void> {
  if (!enabled() || Date.now() - readAt < SKILLS_FRESH_MS) return;
  readAt = Date.now();
  try {
    const items = await list("skill");
    // Each skill's text at once: a turn waits on this.
    const read = await Promise.all(items.map(async (item) => ({ item, text: (await version(item.key))?.version.text })));
    const next: Skill[] = [];
    for (const { item, text } of read) {
      if (typeof text === "string" && text.trim() !== "") next.push({ name: item.name, text: text.trim(), ...(item.note ? { note: item.note } : {}) });
    }
    skills = next.sort((a, b) => Number(b.name === GLOBAL) - Number(a.name === GLOBAL) || a.name.localeCompare(b.name));
  } catch (error) {
    diag.warn("library", `the agent's skills from the cloud: ${diag.messageOf(error)}`);
  }
}

/** The skills read again at the next ask (one was just saved or put away). */
export function forgetSkills(): void {
  readAt = 0;
}

/** Tests: the skills as given, read now. */
export function useSkillsForTests(given: Skill[]): void {
  skills = given;
  readAt = Date.now();
}

/** Who saves, for the agent's words ("you" when it's this computer's person). */
export function whoIs(by: { name: string } | null): string {
  const me = accounts.status() as { person: { name?: string } | null };
  if (by === null) return "Edit";
  return me.person?.name === by.name ? `${by.name} (this computer)` : by.name;
}

export type { App };
