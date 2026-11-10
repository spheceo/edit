// The producer's comments reaching the edit the ways they're really written:
// saved on this Mac through Script mode's own save (the edit follows a moment
// later), and arriving from another Mac by the script's cloud pull (no sync
// runs; the next agent turn brings them), then read by the agent.

import { afterAll, expect, test } from "bun:test";

import type { Script } from "@edit/types/writer";

import { registerEditingTools } from "../src/edit_tools.ts";
import { dispatch } from "../src/mcp/index.ts";
import { catchUpComments, linkOf, start } from "../src/script_sync.ts";
import { saveClips } from "../src/writer/edits.ts";
import * as writerStore from "../src/writer/store.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip } from "./helpers/model.ts";

const fixture = fixtureHome("script-comments-flow");
afterAll(() => fixture.cleanup());

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`never: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a comment saved in the script, or pulled from another Mac, reaches the edit and the agent at its words", async () => {
  const { app, store } = fixture;
  const id = store.create("Case", { width: 1920, height: 1080, fps: 30 }).project.id;
  const data = writerStore.dataDir(store.home);
  const dir = writerStore.scriptDir(data, "5c41");
  const script = {
    id: "5c41", title: "Case", sourceKind: "youtube", sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", originalPath: "", status: "ready", stage: "", progress: 100, error: null, durationMs: 60_000, revision: 1, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null, words: [],
    clips: [
      { id: "a", startMs: 0, endMs: 10_000 },
      { id: "n", kind: "cut-in", startMs: 0, endMs: 3_000, narration: "Then the call came in, from a home." },
    ],
  } as Script;
  script.edit = linkOf(id, script);
  writerStore.write(dir, script);
  await store.update(id, "test", (project) => {
    const [v1] = project.tracks.map((track) => track.id);
    project.clips.push(clip({ id: "range", track: v1!, start: 0, duration: 300, type: "solid", fill: [0, 0, 0, 1] }), clip({ id: "card", track: v1!, start: 300, duration: 90, type: "solid", fill: [0, 0, 0, 1] }));
    project.script = {
      source: "writer:5c41",
      blocks: [
        { kind: "footage", url: "https://youtu.be/dQw4w9WgXcQ", file: "youtube:dQw4w9WgXcQ", start: 0, end: 10, label: "00:00 - 00:10", clip: "range", origin: "a" },
        { kind: "narration", text: "Then the call came in, from a home.", clip: "card", origin: "n" },
      ],
    };
  });
  start(app);
  const block = (origin: string) => store.get(id)!.project.script!.blocks.find((one) => one.origin === origin)!;

  // Written here, as the Script page saves it.
  const saved = writerStore.read(dir);
  saved.clips[1]!.notes = [{ id: "k1", text: "edit: the porch footage here", at: 1, anchor: { start: 23, end: 34, quote: "from a home" } }];
  saveClips(data, "5c41", saved.revision, saved.clips);
  await until(() => (block("n").comments ?? []).length === 1, "the saved comment on the edit");
  expect(block("n").comments).toEqual([{ id: "k1", text: "edit: the porch footage here", on: "from a home" }]);

  // From another Mac: the script's body lands on disk with no save of this Mac's.
  const pulled = writerStore.read(dir);
  pulled.clips[0]!.notes = [{ id: "k2", text: "edit: blur the plate", at: 2 }];
  const hook = writerStore.hooks.written;
  writerStore.hooks.written = () => {};
  writerStore.write(dir, pulled);
  writerStore.hooks.written = hook;
  expect(block("a").comments).toBeUndefined();
  await catchUpComments(app, id);
  expect(block("a").comments).toEqual([{ id: "k2", text: "edit: blur the plate" }]);

  // The agent reads both where they're said.
  registerEditingTools();
  app.store.setActive(id);
  fixture.native.sections = () => ({ intro: null, intro_splits: 1, outro: null, parts: [] });
  const reply = (await dispatch(app, { id: 1, method: "tools/call", params: { name: "get_edit_context", arguments: {} } }, null)) as { result: { content: { text: string }[] } };
  expect(JSON.parse(reply.result.content[0]!.text).script_comments).toEqual([
    { at: 0, footage_block: 0, text: "edit: blur the plate" },
    { at: 359, cut_in: 1, on: "from a home", text: "edit: the porch footage here" },
  ]);
});
