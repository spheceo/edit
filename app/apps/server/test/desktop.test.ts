import { beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";

import { Layout, NOTEPAD, PHOTO_VIEWER, TITLE_BAR, textBlock, titles } from "../src/desktop.ts";
import { findAddon, isReal, useNative, wrap, type Native } from "../src/native/index.ts";
import { scratch } from "./helpers/home.ts";
import { stubNative } from "./helpers/model.ts";

beforeAll(stubNative);

test("the_layout_matches_the_reference_and_scales", () => {
  const hd = new Layout(1920, 1080);
  expect(hd.window("photo_viewer")).toEqual(PHOTO_VIEWER);
  const [x, y, w, h] = hd.content("notepad");
  expect(x > NOTEPAD[0] && y > NOTEPAD[1] + TITLE_BAR && w < NOTEPAD[2] && h < NOTEPAD[3]).toBe(true);
  const uhd = new Layout(3840, 2160);
  expect(uhd.window("notepad")[2]).toBe(NOTEPAD[2] * 2);
  // Text measures as the renderer lays it out (the stub estimates; the addon measures).
  const [one, height] = textBlock("- Aggravated burglary", 42, 400, 1.76);
  const [two, taller] = textBlock("- Aggravated burglary\n- Aggravated assault", 42, 400, 1.76);
  expect(one > 300 && Math.abs(one - two) < 1e-6 && taller > height * 1.8).toBe(true);
});

test("window titles default and are cut to 60 characters", () => {
  expect(titles({})).toEqual(["Photo Viewer", "Notepad"]);
  expect(titles({ photo_title: "  ", title: ` ${"x".repeat(70)} ` })).toEqual(["Photo Viewer", "x".repeat(60)]);
});

// Renders a profile to PNGs for eyeballing (it needs a GPU and a photo).
test.skip("render_a_profile", () => {});

// The window frames are the addon's drawing (edit-engine's desktop.rs): checked against the real one when it's built.
test.skipIf(findAddon() === null)("a_window_frame_is_drawn_at_its_size", async () => {
  const { dir, cleanup } = scratch("desktop-frame");
  const real = wrap(require(findAddon()!) as Native);
  const before = useNative(real);
  try {
    real.init({ home: dir, cacheDir: `${dir}/cache`, ffmpeg: "ffmpeg", ffprobe: "ffprobe", mediaFolders: [], log: () => {} });
    expect(isReal()).toBe(true);
    const [, , notepad] = await real.desktopFiles(960, 540, "Photo Viewer", "Notepad");
    const png = fs.readFileSync(notepad);
    // PNG IHDR: width and height, big-endian, at bytes 16 and 20.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([486, 329]);
  } finally {
    useNative(before);
    cleanup();
  }
});
