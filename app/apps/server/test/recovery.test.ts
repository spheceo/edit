import { expect, test } from "bun:test";
import { dispatch } from "../src/mcp/index.ts";
import { recover } from "../src/recovery.ts";
import { layOut } from "../src/script.ts";
import { narrationRecovery } from "../src/voiceover.ts";
import { clip, media } from "./helpers/model.ts";
import { fixtureHome, write } from "./helpers/home.ts";

// Deliberate removals retain their script IDs. Coverage is evidence, not
// permission to rebuild them, and preparation must be safe after a restart.
test("recovery reports missing/removed blocks without modifying an existing edit or repeating completed analysis", async () => {
  const { app, store, dir, cleanup } = fixtureHome("recover-project");
  try {
    const id = store.create("Existing", { width: 1920, height: 1080, fps: 30 }).project.id;
    const path = `${dir}/footage.mp4`;
    write(path, "cached source");
    await store.update(id, "test", (project) => {
      project.media.push(media({ id: "m", name: "Footage", path, kind: "video", duration: 20, has_audio: true }));
      project.clips.push(clip({ id: "f", track: "v1", type: "video", media: "m", start: 0, duration: 300 }), clip({ id: "a", track: "a4", type: "audio", media: "m", start: 0, duration: 300 }));
      project.script = { blocks: [{ kind: "footage", file: "youtube:abcdefghijk", url: "https://youtu.be/abcdefghijk", start: 0, end: 10, label: "", media: "m", clip: "f" }, { kind: "narration", text: "Removed on purpose.", clip: "deleted-card" }, { kind: "narration", text: "Never placed." }] };
    });
    // The status was requested before another machine supplied analysis.
    expect(app.media.status(path).transcript).toBe("pending");
    const cached = JSON.stringify({ model: "youtube-captions", words: [{ text: "Hello.", start: 1, end: 1.4, speaker: "caption_turn_1" }] });
    write(app.media.paths(path).transcript, cached);
    const before = structuredClone(store.get(id)!.project);
    const revision = store.get(id)!.rev;
    const read = await recover(app, id, false) as Record<string, unknown>;
    expect(read).toMatchObject({ prepared: false, transcripts: [{ media: "m", state: "ready", model: "youtube-captions" }], narration: [{ state: "review" }, { state: "review" }], failures: [] });
    expect(read.unresolved_blocks).toEqual([{ block: 2, state: "removed_or_covered", why: expect.any(String) }, { block: 3, state: "unplaced", why: expect.any(String) }]);
    const response = await dispatch(app, { id: 1, method: "tools/call", params: { name: "recover_project", arguments: { project_id: id, prepare: true } } }, null) as { result: { isError: boolean; content: { text: string }[] } };
    expect(response.result.isError).toBe(false);
    expect(JSON.parse(response.result.content[0]!.text)).toMatchObject({ prepared: true, failures: [] });
    expect(store.get(id)!.project).toEqual(before);
    expect(store.get(id)!.rev).toBe(revision);
    expect(app.media.transcribe(path, true).transcript).toBe("ready");
    expect(await Bun.file(app.media.paths(path).transcript).text()).toBe(cached);
  } finally { cleanup(); }
});

test("narration recovery distinguishes bare import cards from designed, deleted and untracked recorded cut-ins", async () => {
  const { store, dir, cleanup } = fixtureHome("recover-narration");
  try {
    const id = store.create("Partial", { width: 1920, height: 1080, fps: 30 }).project.id;
    await store.update(id, "test", (project) => {
      project.script = { blocks: ["Bare", "Designed", "Deleted", "Recorded", "Missing take"].map((text) => ({ kind: "narration", text })) };
      layOut(project);
      const blocks = project.script.blocks;
      const designed = project.clips.find((clip) => clip.id === blocks[1]!.clip)!;
      if (designed.type === "solid") designed.fill = [1, 0, 0, 1];
      project.clips = project.clips.filter((clip) => clip.id !== blocks[2]!.clip);
      project.media.push(media({ id: "voice", name: "My recorded narration", path: `${dir}/voice.wav`, kind: "audio", duration: 3, has_audio: true }));
      project.clips.push(clip({ id: "recording", type: "audio", track: "a4", media: "voice", start: 270, duration: 90, name: "Voice-over recorded by hand" }));
      const removedTake = blocks[4]!;
      if (removedTake.kind === "narration") removedTake.voiceover = "deleted-voiceover";
    });
    expect(narrationRecovery(store.get(id)!.project).map((line) => line.state)).toEqual(["missing", "review", "review", "review", "review"]);
    await expect(recover({ store } as never, "no-such-project", false)).rejects.toThrow("no such project");
  } finally { cleanup(); }
});
