import { expect, test } from "bun:test";

import * as firstPrompt from "../src/first_prompt.ts";
import type { ScriptJob } from "../src/model.ts";
import { fixtureHome } from "./helpers/home.ts";

test("a new project's first message waits for its import, then goes to its agent once", async () => {
  const { app, cleanup } = fixtureHome("first-prompt");
  const live = app.store.createAs("Case", "bodycam", { width: 1920, height: 1080, fps: 30 });
  const id = live.project.id;
  const sent: string[] = [];
  let job: ScriptJob | null = { state: "downloading", files: [{ file: "f", bytes: 0, state: "downloading" }] };
  (app as unknown as { agents: unknown }).agents = { chat: () => ({ running: false }), send: async (_project: string, text: string) => void sent.push(text) };
  (app as unknown as { scripts: unknown }).scripts = { get: () => job, running: () => job !== null };
  try {
    firstPrompt.give(app, id, "start the editing workflow");
    await firstPrompt.sendReady(app);
    expect(sent).toEqual([]);
    expect(firstPrompt.waiting(app, id)).toBe("start the editing workflow");
    // The import is done: it goes, and only once.
    job = { ...job, state: "done" };
    await firstPrompt.sendReady(app);
    await firstPrompt.sendReady(app);
    expect(sent).toEqual(["start the editing workflow"]);
    expect(firstPrompt.waiting(app, id)).toBeNull();
  } finally {
    cleanup();
  }
});
