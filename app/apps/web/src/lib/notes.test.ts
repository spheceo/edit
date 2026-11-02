import { describe, expect, it } from "vitest";

import type { AppNote } from "./api";
import { boxFrom, pictureRect, queued } from "./note-shapes";

describe("notes on the player", () => {
  it("finds the picture inside a letterboxed viewer", () => {
    // A 1600×900 viewer showing a 1080×1920 vertical frame: pillarboxed.
    const rect = pictureRect(1600, 900, 1080, 1920);
    expect(rect.height).toBe(900);
    expect(rect.width).toBeCloseTo(506.25);
    expect(rect.left).toBeCloseTo((1600 - 506.25) / 2);
    expect(rect.top).toBe(0);
  });

  it("turns a drag into a box of fractions, whichever way it went, kept in the frame; a click is no box", () => {
    const rect = { width: 400, height: 200 };
    expect(boxFrom({ x: 300, y: 150 }, { x: 100, y: 50 }, rect)).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(boxFrom({ x: -50, y: -10 }, { x: 600, y: 100 }, rect)).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(boxFrom({ x: 10, y: 10 }, { x: 11, y: 11 }, rect)).toBeNull();
  });

  it("queues the notes still to fix or with the agent, in timeline order", () => {
    const note = (id: string, now: number, status: AppNote["status"]) => ({ id, now, status, at: 0 }) as AppNote;
    expect(queued([note("a", 90, "queued"), note("b", 30, "sent"), note("c", 10, "done"), note("d", 5, "left")]).map((one) => one.id)).toEqual(["b", "a"]);
  });
});
