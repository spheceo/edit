import { describe, expect, it } from "vitest";

import type { ChatTurn } from "../types";
import { scriptEntries } from "./editor-entries";

describe("scriptEntries", () => {
  it("shapes a script conversation as the editor chat's entries", () => {
    const chat: ChatTurn[] = [
      { role: "producer", text: "Tighten the intro", at: 1000 },
      {
        role: "editor",
        text: "Done. Shorter now.",
        at: 2000,
        workedMs: 90_000,
        trace: [{ at: 0, calls: [{ id: "c1", tool: "read_transcript", label: "Read the transcript", state: "done" }] }],
      },
      { role: "editor", text: "Reset the script?", at: 3000, reset: "pending" },
    ];
    const entries = scriptEntries(chat);
    expect(entries.map((entry) => entry.kind)).toEqual(["user", "tool", "assistant"]);
    expect(entries[1]).toMatchObject({ tool: "read_transcript", text: "Read the transcript", status: "done", updated: 92_000 });
    expect(entries[2]).toMatchObject({ text: "Done. Shorter now." });
  });

  it("keeps a failed turn's tools beside its error", () => {
    const chat: ChatTurn[] = [
      {
        role: "editor",
        text: "The build stopped",
        at: 5000,
        failed: true,
        trace: [{ at: 0, calls: [{ id: "c1", tool: "build_script", label: "", state: "error" }] }],
      },
    ];
    const entries = scriptEntries(chat);
    expect(entries.map((entry) => entry.kind)).toEqual(["tool", "error"]);
    expect(entries[0]).toMatchObject({ status: "failed" });
  });
});
