// A project's research in the cloud, so an edit opened on another Mac has
// it (the user, Oct 30: "everything on the cloud! including research which is
// done in the scripting stage and passed on to editing"; "local copies only as
// short-lived caches"). Its lists (`index.json`, `articles.json`,
// `names.json`) go to `edit/research/projects/<project>/`; its found images,
// each named by its hash, to `edit/research/images/<name>` once for every
// project. Another Mac takes the lists when the project opens and an image
// when it's first shown.

import * as fs from "node:fs";
import { basename, join } from "node:path";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";
import * as research from "./research.ts";

const LISTS = ["index.json", "articles.json", "names.json"];
/** How often projects' research is looked at for what's new. */
const EVERY_MS = 10 * 60_000;
/** A project left this long has its images (in the cloud) removed here; shown again, they come back. */
const KEEP_DAYS = 14;
/** Found images are named by their hash (research.ts). */
const IMAGE = /^[0-9a-f]{16}\.(jpg|png|webp)$/u;

const listKey = (project: string, name: string) => `edit/research/projects/${project}/${name}`;
const imageKey = (name: string) => `edit/research/images/${name}`;

/** What of a project's research is in the cloud: each list's mtime when it went, and the images. */
type Sent = { lists: Record<string, number>; images: string[] };

const sentFile = (home: string, project: string) => join(research.dir(home, project), "cloud.json");

function sentOf(home: string, project: string): Sent {
  try {
    return JSON.parse(fs.readFileSync(sentFile(home, project), "utf8")) as Sent;
  } catch {
    return { lists: {}, images: [] };
  }
}

/** Sends what's new in `project`'s research: lists changed since they went, images not there yet. */
export async function push(app: App, project: string): Promise<number> {
  const home = app.store.home;
  const folder = research.dir(home, project);
  if (!cloud.enabled() || !fs.existsSync(folder)) return 0;
  const sent = sentOf(home, project);
  const images = new Set(sent.images);
  let count = 0;
  for (const name of fs.readdirSync(folder)) {
    if (!IMAGE.test(name) || images.has(name)) continue;
    if (!(await cloud.has(imageKey(name)))) await cloud.uploadFile(join(folder, name), imageKey(name));
    images.add(name);
    count += 1;
  }
  for (const name of LISTS) {
    const path = join(folder, name);
    if (!fs.existsSync(path)) continue;
    const mtime = fs.statSync(path).mtimeMs;
    if (sent.lists[name] === mtime) continue;
    await cloud.uploadFile(path, listKey(project, name));
    sent.lists[name] = mtime;
    count += 1;
  }
  if (count > 0) writeAtomic(sentFile(home, project), JSON.stringify({ lists: sent.lists, images: [...images] }));
  return count;
}

/**
 * Takes `project`'s research lists from the cloud when this Mac has none
 * (another Mac did the research). Each image is taken when it's first shown
 * (`image`), so a project's hundreds of candidates aren't all downloaded.
 */
export async function pull(app: App, project: string): Promise<boolean> {
  const home = app.store.home;
  const folder = research.dir(home, project);
  if (!cloud.enabled() || fs.existsSync(join(folder, "index.json")) || fs.existsSync(join(folder, "articles.json"))) return false;
  let took = false;
  for (const name of LISTS) {
    if (!(await cloud.has(listKey(project, name)))) continue;
    fs.mkdirSync(folder, { recursive: true });
    await cloud.download(listKey(project, name), join(folder, name));
    took = true;
  }
  if (!took) return false;
  // Its items name the other Mac's files: the same names in this Mac's folder.
  const index = join(folder, "index.json");
  if (fs.existsSync(index)) {
    const items = JSON.parse(fs.readFileSync(index, "utf8")) as { file: string }[];
    for (const item of items) item.file = join(folder, basename(item.file));
    writeAtomic(index, JSON.stringify(items, null, 2));
  }
  // What came is already in the cloud.
  const lists = Object.fromEntries(LISTS.filter((name) => fs.existsSync(join(folder, name))).map((name) => [name, fs.statSync(join(folder, name)).mtimeMs]));
  writeAtomic(sentFile(home, project), JSON.stringify({ lists, images: [] }));
  diag.info("research", `${project}: its research came from the cloud`);
  return true;
}

/** A found image's file on this Mac, taken from the cloud when it isn't here. */
export async function image(file: string): Promise<string> {
  if (fs.existsSync(file) || !cloud.enabled() || !IMAGE.test(basename(file))) return file;
  await cloud.download(imageKey(basename(file)), file);
  return file;
}

/**
 * Removes the found images of a project left `KEEP_DAYS` that are in the
 * cloud (the pool's copy goes with the cache's cleaning once nothing links
 * it). Returns the bytes freed.
 */
export function free(app: App, project: string, modifiedMs: number, now = Date.now()): number {
  if (now - modifiedMs < KEEP_DAYS * 86_400_000) return 0;
  const folder = research.dir(app.store.home, project);
  let freed = 0;
  for (const name of sentOf(app.store.home, project).images) {
    const path = join(folder, name);
    try {
      freed += fs.statSync(path).size;
      fs.rmSync(path);
    } catch {
      // Gone already.
    }
  }
  return freed;
}

/** Sends every project's new research now and then (one Mac does a project's research; any may open it). */
export function start(app: App): void {
  const sweep = async () => {
    for (const summary of app.store.visible()) {
      try {
        await push(app, summary.id);
        free(app, summary.id, summary.modified_ms);
      } catch (error) {
        diag.warn("research", `${summary.name}: sending its research to the cloud: ${diag.messageOf(error)}`);
      }
    }
  };
  const first = setTimeout(() => void sweep(), 3 * 60_000);
  const every = setInterval(() => void sweep(), EVERY_MS);
  first.unref?.();
  every.unref?.();
}
