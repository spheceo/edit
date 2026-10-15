/** Run separately for each mode so retained heaps cannot contaminate one another:
 * bun scripts/benchmark-history.ts /path/to/project.json baseline
 * bun scripts/benchmark-history.ts /path/to/project.json shared
 * Measures retained JavaScriptCore heap after GC, not whole-browser/GPU memory. */
import { heapStats } from "bun:jsc";
import { shareProject } from "../web/src/lib/project-sharing";
import type { Project } from "../web/src/lib/types";

const [file, mode] = process.argv.slice(2);
if (!file || (mode !== "baseline" && mode !== "shared")) {
  console.error("usage: bun scripts/benchmark-history.ts PROJECT.json baseline|shared");
  process.exit(1);
}
const raw = await Bun.file(file).text();
const saved: Project[] = [];
let previous: Project = JSON.parse(raw);
if (!previous.clips.length) throw new Error("the fixture needs at least one clip");
Bun.gc(true);
const start = heapStats().heapSize;
const at = performance.now();
for (let i = 0; i < 200; i++) {
  const next: Project = JSON.parse(raw);
  next.clips[0].name = `revision ${i}`;
  previous = mode === "shared" ? shareProject(previous, next) : next;
  saved.push(previous);
}
Bun.gc(true);
const end = heapStats().heapSize;
console.log(JSON.stringify({ mode, snapshots: saved.length,
  unique_clip_objects: new Set(saved.flatMap((project) => project.clips)).size,
  heap_delta_mib: (end - start) / 1024 / 1024,
  seconds: (performance.now() - at) / 1000,
}));
