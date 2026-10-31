import { expect, test } from "bun:test";

import { pictureHash } from "../src/playback_render.ts";
import { project, stubNative } from "./helpers/model.ts";

test("smooth playback stays for changes nothing on screen shows, and goes for one it does", () => {
  stubNative();
  const p = project("smooth");
  const before = pictureHash(p);
  // The script's notes and words change nothing seen or heard.
  expect(pictureHash({ ...p, script: { source: "doc", blocks: [{ kind: "narration", text: "Then she left." }] } } as typeof p)).toBe(before);
  expect(pictureHash({ ...p, settings: { ...p.settings, fps: 25 } })).not.toBe(before);
});
