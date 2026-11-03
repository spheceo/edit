import { expect, test } from "bun:test";

import type { Project } from "../src/model.ts";
import { PIECE, pieceKey, piecesOf, shared } from "../src/scrub.ts";

test("the scrub tier is made for the stretches the timeline shows, in pieces of the source, each once", () => {
  const project = {
    settings: { width: 1920, height: 1080, fps: 30 },
    media: [
      { id: "a", name: "a.mp4", path: "x", kind: "video", duration: 3600, width: 1920, height: 1080, fps: 30, has_audio: true },
      { id: "s", name: "s.wav", path: "y", kind: "audio", duration: 3600, width: 0, height: 0, fps: 0, has_audio: true },
    ],
    clips: [
      // 290–310 s of a: across pieces 0 and 1.
      { id: "c1", track: "v1", type: "video", media: "a", source_in: 290, start: 0, duration: 600 },
      // 1210 s on, 10 s: piece 4.
      { id: "c2", track: "v1", type: "video", media: "a", source_in: 1210, start: 600, duration: 300 },
      { id: "c3", track: "a1", type: "audio", media: "s", source_in: 0, start: 0, duration: 900 },
    ],
  } as unknown as Project;
  expect([...(piecesOf(project, 0, 900).get("a") ?? [])].sort()).toEqual([0, 1, 4]);
  expect(piecesOf(project, 0, 900).has("s")).toBe(false);
  // Only what frames 600–900 show.
  expect([...(piecesOf(project, 600, 900).get("a") ?? [])]).toEqual([4]);
  expect(PIECE).toBe(300);
  expect(pieceKey("edit/proxies/drive/abc.mp4", 3)).toBe("edit/scrub/proxies/drive/abc.mp4/3.mp4");
});

test("scrub pieces stay on this Mac unless edge media is on", () => {
  const before = { edge: process.env.EDIT_EDGE_MEDIA };
  try {
    delete process.env.EDIT_EDGE_MEDIA;
    expect(shared()).toBe(false);
    process.env.EDIT_EDGE_MEDIA = "0";
    expect(shared()).toBe(false);
  } finally {
    if (before.edge === undefined) delete process.env.EDIT_EDGE_MEDIA;
    else process.env.EDIT_EDGE_MEDIA = before.edge;
  }
});
