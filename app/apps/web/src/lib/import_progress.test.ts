import { describe, expect, it } from "vitest";

import { afterLines, afterNeedsSaying, importProgress } from "./import_progress";
import type { ScriptJob } from "./types";

describe("a script import's lines", () => {
  it("waiting by itself says the server's words, with nothing to press", () => {
    const job: ScriptJob = {
      state: "waiting",
      error: "The transcription plan is out of credit: 1 of 2 footage files wait for it; Edit tries again at 14:30.",
      files: [
        { file: "a", bytes: 10, total: 10, state: "done" },
        { file: "b", bytes: 5, total: 10, state: "waiting", why: "quota", retry_at: 1 },
      ],
    };
    expect(importProgress(job).line).toBe(job.error);
  });

  it("waiting on the person still asks for them", () => {
    const job: ScriptJob = { state: "waiting", files: [{ file: "a", bytes: 0, state: "failed", why: "person", error: "This Drive file isn't shared." }] };
    expect(importProgress(job).line).toBe("Waiting for you: one file couldn’t be downloaded");
  });

  it("a done import keeps its tab only while something after it failed or waits", () => {
    const done: ScriptJob = { state: "done", files: [], after: [{ step: "voiceover", state: "done" }] };
    expect(afterNeedsSaying(done)).toBe(false);
    const voice: ScriptJob = { ...done, after: [{ step: "voiceover", state: "failed", note: "The voice-over couldn't be made: no answer" }] };
    expect(afterNeedsSaying(voice)).toBe(true);
    expect(afterLines(voice)).toEqual([{ step: "voiceover", state: "failed", line: "The voice-over couldn't be made: no answer" }]);
    expect(afterLines({ ...done, after: [{ step: "research", state: "running" }] })[0]!.line).toBe("Research: working…");
  });
});
