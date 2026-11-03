import { describe, expect, it } from "vitest";

import { centredScrollY, nextFollow } from "./follow";

describe("centredScrollY", () => {
  it("puts the middle in the middle, clamped to the content", () => {
    expect(centredScrollY(300, 200, 1000)).toBe(200);
    expect(centredScrollY(10, 200, 1000)).toBe(0);
    expect(centredScrollY(990, 200, 1000)).toBe(800);
    expect(centredScrollY(300, 200, 150)).toBe(0);
  });
});

describe("nextFollow", () => {
  it("pages when the playhead runs off the edge while following", () => {
    expect(nextFollow({ playing: true, justStarted: false, following: true, x: 970, width: 1000 })).toEqual({ following: true, page: true });
    expect(nextFollow({ playing: true, justStarted: false, following: true, x: 500, width: 1000 })).toEqual({ following: true, page: false });
  });

  it("leaves a person scrolled away alone until the playhead walks into view", () => {
    expect(nextFollow({ playing: true, justStarted: false, following: false, x: -10, width: 1000 })).toEqual({ following: false, page: false });
    expect(nextFollow({ playing: true, justStarted: false, following: false, x: 1200, width: 1000 })).toEqual({ following: false, page: false });
    expect(nextFollow({ playing: true, justStarted: false, following: false, x: 500, width: 1000 })).toEqual({ following: true, page: false });
  });

  it("pause and play again picks the playhead back up", () => {
    expect(nextFollow({ playing: true, justStarted: true, following: false, x: -10, width: 1000 })).toEqual({ following: true, page: true });
    expect(nextFollow({ playing: false, justStarted: false, following: false, x: -10, width: 1000 })).toEqual({ following: false, page: false });
  });
});
