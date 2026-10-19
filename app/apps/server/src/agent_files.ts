// Every Markdown file in agent/ (the repo's top), read while the code is
// bundled: agent_text.ts imports this `with { type: "macro" }`, so Bun runs it
// at build time and the files' text is part of the build (and of the compiled
// binary). A new file is picked up by itself; under `bun run` it's read when
// the server starts.

import * as fs from "node:fs";
import * as nodePath from "node:path";

/** agent/, from this file. */
export const AGENT_DIR = nodePath.join(import.meta.dir, "../../../../agent");

/** Each .md file's text, by its path under agent/ ("skills/intro.md"), sorted. */
export function agentFiles(): Record<string, string> {
  const files = (fs.readdirSync(AGENT_DIR, { recursive: true }) as string[])
    .map((file) => file.split(nodePath.sep).join("/"))
    .filter((file) => file.endsWith(".md"))
    .sort();
  const out: Record<string, string> = {};
  for (const file of files) out[file] = fs.readFileSync(nodePath.join(AGENT_DIR, file), "utf8");
  return out;
}
