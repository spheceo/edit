import { describe, expect, it } from "vitest";

import { mediaVersions } from "./mediaVersions";

describe("the viewer's media versions", () => {
  it("stays the same object until a picture's version changes", () => {
    const select = mediaVersions(true);
    const first = select({ media: { a: { proxy: "making", progress: 0.1 } as never, b: { proxy: "ready", light: "ready", stamps: { preview: "1", light: "2" } } as never } });
    expect(first).toEqual({ a: "source", b: "light~2~1" });
    // Progress only: the same versions, the same object.
    expect(select({ media: { a: { proxy: "making", progress: 0.9 } as never, b: { proxy: "ready", light: "ready", stamps: { preview: "1", light: "2" } } as never } })).toBe(first);
    const ready = select({ media: { a: { proxy: "ready", stamps: { preview: "7" } } as never, b: { proxy: "ready", light: "ready", stamps: { preview: "1", light: "2" } } as never } });
    expect(ready).toEqual({ a: "preview~7", b: "light~2~1" });
    expect(select({ media: { a: { proxy: "ready", stamps: { preview: "7" } } as never } })).toEqual({ a: "preview~7" });
  });

  it("takes the preview over the light one where light isn't wanted", () => {
    expect(mediaVersions(false)({ media: { b: { proxy: "ready", light: "ready", stamps: { preview: "1", light: "2" } } as never } })).toEqual({ b: "preview~1" });
  });
});
