import { describe, expect, it } from "vitest";

import type { AgentEntry } from "./agent";
import { sentLanded } from "./agentTurns";

const you = (n: number, at: number): AgentEntry => ({ id: `turn-${n}`, kind: "user", text: `message ${n}`, at }) as AgentEntry;
const claude = (n: number, at: number): AgentEntry => ({ id: `turn-${n}`, kind: "assistant", text: "done", at }) as AgentEntry;

describe("a message held on screen as it's sent", () => {
  it("goes once it's in the chat", () => {
    const before = [you(0, 1), claude(1, 2)];
    expect(sentLanded(before, { asked: 1, newest: 1 })).toBe(false);
    expect(sentLanded([...before, you(2, 3)], { asked: 1, newest: 1 })).toBe(true);
  });

  it("goes once it's in a chat kept to its last turns, which dropped its oldest for it", () => {
    // Nov 5, a thumbnail's 80 turns: the new message in, the oldest out, as many of the person's as before.
    const full = [you(0, 1), claude(1, 2), you(2, 3), claude(3, 4)];
    const after = [claude(1, 2), you(2, 3), claude(3, 4), you(4, 5)];
    expect(sentLanded(after, { asked: 2, newest: 3 })).toBe(true);
    expect(sentLanded(full, { asked: 2, newest: 3 })).toBe(false);
  });
});
