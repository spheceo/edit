import { describe, expect, it } from "vitest";

import { chaptersInSpan, outputSize } from "./exporting";

describe("export", () => {
  it("sizes each shape from the short side, as the server does", () => {
    const at = (shape: "original" | "vertical" | "square" | "portrait", size: number | null, format: "h264" | "gif" = "h264") =>
      outputSize({ shape, size, format }, 1920, 1080);
    expect(at("original", null)).toEqual([1920, 1080]);
    expect(at("original", 720)).toEqual([1280, 720]);
    expect(at("vertical", 1080)).toEqual([1080, 1920]);
    expect(at("portrait", 1080)).toEqual([1080, 1350]);
    expect(at("original", null, "gif")).toEqual([852, 480]);
  });

  it("keeps chapters YouTube accepts: from 0:00, at least 10 s apart, within the span", () => {
    const fps = 30;
    const chapters = [
      { start: 0, title: "Intro" },
      { start: 33 * fps, title: "On July 13, 2024, Kent police…" },
      { start: 38 * fps, title: "Too soon" },
      { start: 128 * fps, title: "The man trapped behind the wheel…" },
      { start: 1207 * fps, title: "Outro" },
    ];
    const whole = chaptersInSpan(chapters, [0, 1210 * fps], fps);
    expect(whole.map((chapter) => chapter.title)).toEqual(["Intro", "On July 13, 2024, Kent police…", "The man trapped behind the wheel…"]);
    expect(whole.map((chapter) => Math.round(chapter.start / fps))).toEqual([0, 33, 128]);
    // A span starting mid-chapter opens with that chapter at 0:00.
    const later = chaptersInSpan(chapters, [60 * fps, 300 * fps], fps);
    expect(later.map((chapter) => [Math.round(chapter.start / fps), chapter.title])).toEqual([
      [60, "On July 13, 2024, Kent police…"],
      [128, "The man trapped behind the wheel…"],
    ]);
  });
});
