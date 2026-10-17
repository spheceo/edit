// Where the parity run keeps things (never under ~/.edit).

import * as fs from "node:fs";
import * as nodePath from "node:path";

export function parityDir(given?: string): string {
  return nodePath.resolve(given ?? process.env.EDIT_PARITY_DIR ?? "/tmp/edit-parity");
}

/** The UI both servers serve: a stub (the Rust build embeds the same files). */
export const STUB_WEB: Record<string, string> = {
  "index.html":
    '<!doctype html><html><head><title>Edit</title></head><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>\n',
  "assets/index.js": 'console.log("edit");\n',
};

export function writeStubWeb(dir: string): void {
  for (const [name, text] of Object.entries(STUB_WEB)) {
    const file = nodePath.join(dir, name);
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) fs.writeFileSync(file, text);
  }
}
