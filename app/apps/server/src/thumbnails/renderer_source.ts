// The thumbnail drawing's own text (packages/edit-types/src/thumbnail_render.ts),
// read while the code is bundled: render.ts imports this `with { type: "macro" }`,
// so Bun runs it at build time and the text is part of the compiled binary.
// Imported as text directly, the bundler gave the file one loader and the
// modules importing it as code (design.ts, thumbnails.ts) broke the build
// (nightly-54: "No matching export … for import captionShadow").

import * as fs from "node:fs";
import * as nodePath from "node:path";

export function rendererSource(): string {
  return fs.readFileSync(nodePath.join(import.meta.dir, "../../../../packages/edit-types/src/thumbnail_render.ts"), "utf8");
}
