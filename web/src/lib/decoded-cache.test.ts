import { describe, expect, it, vi } from "vitest";
import { DecodedCache } from "./decoded-cache";

describe("decoded resource ownership", () => {
  it("evicts the least recently used frame, and releases replacements and project resources", () => {
    const release = vi.fn();
    const cache = new DecodedCache<string>(10, release);
    cache.set("a", "first", 4); cache.set("b", "second", 4);
    expect(cache.get("a")).toBe("first");
    cache.set("c", "third", 4);
    expect(release).toHaveBeenCalledWith("second");
    expect(cache.bytes).toBe(8);
    cache.set("a", "replacement", 5);
    expect(release).toHaveBeenCalledWith("first");
    cache.clear();
    expect(cache.bytes).toBe(0);
    expect(release.mock.calls.map(([value]) => value).sort()).toEqual(["first", "replacement", "second", "third"]);
  });

  it("allows one large frame, then frees it when another arrives", () => {
    const release = vi.fn();
    const cache = new DecodedCache<string>(10, release);
    cache.set("4k", "large", 20);
    expect(cache.get("4k")).toBe("large");
    cache.set("small", "small", 4);
    expect(release).toHaveBeenCalledWith("large");
    expect(cache.bytes).toBe(4);
  });
});
