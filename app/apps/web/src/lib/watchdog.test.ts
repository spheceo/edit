import { describe, expect, it, vi } from "vitest";

vi.mock("./agent", () => ({ useAgent: { subscribe: () => {} } }));
vi.mock("./store", () => ({ useEditor: { subscribe: () => {} } }));
vi.mock("./timelineView", () => ({ useView: { subscribe: () => {} } }));
vi.mock("./diagnostics", () => ({ note: () => {} }));

const { describeStall, frameOf } = await import("./watchdog");
const { rendered } = await import("./reactCommits");

describe("a stall in the report", () => {
  it("names the script that ran, the time in layout and what React drew", () => {
    const frame = frameOf({
      name: "long-animation-frame", entryType: "long-animation-frame", startTime: 1000, duration: 3400, styleAndLayoutStart: 4100,
      scripts: [
        { duration: 400, invoker: "TimerHandler:setInterval", sourceFunctionName: "tick", sourceURL: "https://x/assets/index-AB.js", sourceCharPosition: 120 },
        { duration: 2900, invoker: "WebSocket.onmessage", sourceFunctionName: "applyAgentEvent", sourceURL: "https://x/assets/index-AB.js", sourceCharPosition: 98765 },
      ],
    } as never);
    const line = describeStall(3400, "no store changing", [frame], [{ at: 1, names: ["Timeline"], count: 1 }, { at: 2, names: ["TurnView ×12", "MainAgentPanel"], count: 13 }]);
    expect(line).toBe(
      "The page was stuck for 3.4 s; changing most: no store changing; 1 long frame (3.4 s: 3.3 s in script, 300 ms in style and layout); the longest 3.4 s: " +
        "WebSocket.onmessage → applyAgentEvent (index-AB.js@98765) 2.9 s; TimerHandler:setInterval → tick (index-AB.js@120) 400 ms; " +
        "React drew last: [Timeline] [TurnView ×12, MainAgentPanel; 13 in all]",
    );
  });

  it("says when nothing on the page ran that long, and when the browser doesn't tell", () => {
    expect(describeStall(14_000, "no store changing", [], [])).toContain("no long frame on the page meanwhile: held up from outside it");
    expect(describeStall(2_000, "useEditor.media 40×", null, [])).toContain("long frames: this browser doesn't say");
  });
});

describe("what a React commit rendered", () => {
  it("reads only the parts of the tree that rendered", () => {
    function Panel() {}
    function Turn() {}
    const memoTurn = { $$typeof: "memo", type: Turn };
    const fiber = (type: unknown, flags: number, subtreeFlags: number, child: object | null = null, sibling: object | null = null) => ({ type, flags, subtreeFlags, child, sibling });
    // Panel rendered with two of its three turns; a stale flag under a skipped subtree isn't counted.
    const skipped = fiber(Turn, 1, 0);
    const root = fiber(null, 0, 1, fiber(Panel, 1, 1, fiber(memoTurn, 1, 0, null, fiber(memoTurn, 1, 0, null, fiber("div", 0, 0, skipped)))));
    expect(rendered(root as never)).toEqual({ names: ["Turn ×2", "Panel"], count: 3 });
  });
});
