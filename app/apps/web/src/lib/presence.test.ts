import { describe, expect, it } from "vitest";

import { throttled } from "./presence";

describe("presence", () => {
  it("says the window was used on the first key or click, then at most every 30 s", () => {
    let now = 0;
    let sent = 0;
    const used = throttled(() => sent++, 30_000, () => now);
    used();
    used();
    expect(sent).toBe(1);
    now = 29_999;
    used();
    expect(sent).toBe(1);
    now = 30_000;
    used();
    expect(sent).toBe(2);
  });
});
