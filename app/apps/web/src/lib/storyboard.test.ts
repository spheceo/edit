import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("the hover frames' sheets", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        set src(_: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("asked again after no answer (a render not here yet, a server restarting)", async () => {
    let asked = 0;
    vi.stubGlobal("fetch", async () => {
      asked++;
      if (asked === 1) return new Response("", { status: 404 });
      return new Response(JSON.stringify({ state: "ready", columns: 10, rows: 10, width: 160, height: 90, times: [0, 2, 4] }));
    });
    const storyboard = await import("./storyboard");
    expect(storyboard.cellAt("p1", "s1", 2)).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(asked).toBe(2);
    expect(storyboard.cellAt("p1", "s1", 2)).toMatchObject({ x: 160, y: 0 });
  });

  test("gives up after a few tries", async () => {
    let asked = 0;
    vi.stubGlobal("fetch", async () => {
      asked++;
      return new Response("", { status: 500 });
    });
    const storyboard = await import("./storyboard");
    storyboard.cellAt("p1", "s1", 2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(asked).toBe(5);
  });
});

describe("the hover frames' spread", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("fetched for a version whose exact frames came first (the sheets stood in, then an unsaved change)", async () => {
    vi.resetModules();
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      return new Response(new Blob(["x"]));
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const storyboard = await import("./storyboard");
    await storyboard.fetchExact("p1", 3, 900, 450, false);
    expect(asked).toEqual(["/api/projects/p1/frame/450.png?max=240"]);
    storyboard.pictureAt("p1", 3, 900, 100);
    await new Promise((done) => setTimeout(done, 0));
    expect(asked.length).toBeGreaterThan(1);
  });
});
