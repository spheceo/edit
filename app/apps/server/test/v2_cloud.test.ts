// Edit V2's cloud (v2_cloud.ts): an effect's code kept version by version and
// brought back, an effect made elsewhere brought down, templates, and the
// agent's skills a teacher saves, read over the release's in Bodycam HQ;
// through the relay to the cloud mock's library (mamagi's editLibrary).

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";

import * as accounts from "../src/accounts.ts";
import { agentInstructions } from "../src/agent.ts";
import * as cloud from "../src/cloud.ts";
import { registerEffectTools } from "../src/effect_tools.ts";
import { registerEditingTools } from "../src/edit_tools.ts";
import * as effects from "../src/effects.ts";
import { dispatch } from "../src/mcp/index.ts";
import * as v2cloud from "../src/v2_cloud.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  cloud.timing.sleep = async () => {};
  registerEffectTools();
  registerEditingTools();
});

afterAll(() => {
  restore();
  mock.stop();
});

afterEach(() => {
  accounts.resetForTests();
  v2cloud.useSkillsForTests([]);
});

function hq(name: string) {
  const home = fixtureHome(name);
  const id = home.app.store.create("HQ", { width: 1920, height: 1080, fps: 30 }).project.id;
  return { ...home, id };
}

async function call(app: ReturnType<typeof fixtureHome>["app"], project: string, name: string, args: Record<string, unknown>) {
  return ((await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, project)) as { result: { content: { text?: string }[]; isError: boolean } }).result;
}

test("an effect's code kept version by version, the same files never twice, and put back to any of them", async () => {
  const { app, cleanup, id } = hq("v2-versions");
  try {
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    const dir = effects.folder(app.store, id, "board");
    fs.mkdirSync(join(dir, "img"), { recursive: true });
    fs.writeFileSync(join(dir, "scene.html"), "<p>one</p>");
    fs.writeFileSync(join(dir, "img/a.png"), "picture");
    const key = v2cloud.effectKey(id, "board");
    expect(await v2cloud.save(key, "board", dir, { source: "k1", reason: "rendered" })).toMatchObject({ n: 1, made: true });
    // The same files again (saved as it renders once more, or just brought back): no new version.
    expect(await v2cloud.save(key, "board", dir, { source: "k1b" })).toEqual({ n: 1, made: false });
    fs.writeFileSync(join(dir, "scene.html"), "<p>two</p>");
    fs.rmSync(join(dir, "img/a.png"));
    expect(await v2cloud.save(key, "board", dir, { source: "k2", reason: "rendered" })).toMatchObject({ n: 2, made: true });
    // The files went up once each, by their content.
    expect([...mock.cloud.objects.keys()].filter((one) => one.startsWith("edit/library/sha256/")).length).toBe(3);

    // The agent's history and undo.
    const listed = await call(app, id, "effect_versions", { name: "board" });
    expect(listed.isError).toBe(false);
    expect(listed.content[0]!.text).toContain("version 2 (in use)");
    expect(listed.content[0]!.text).toContain("version 1:");
    const back = await call(app, id, "restore_effect", { name: "board", version: 1 });
    expect(back.isError).toBe(false);
    expect(fs.readFileSync(join(dir, "scene.html"), "utf8")).toBe("<p>one</p>");
    expect(fs.readFileSync(join(dir, "img/a.png"), "utf8")).toBe("picture");
    expect((await v2cloud.version(key))?.item.current).toBe(1);
    // Forward again: the newer version was kept.
    await call(app, id, "restore_effect", { name: "board", version: 2 });
    expect(fs.readFileSync(join(dir, "scene.html"), "utf8")).toBe("<p>two</p>");
    expect(fs.existsSync(join(dir, "img/a.png"))).toBe(false);
    expect((await call(app, id, "restore_effect", { name: "board", version: 9 })).content[0]!.text).toContain("has no version 9");

    // Opened on another computer, without the folder: its code comes down at the version in use.
    await app.store.update(id, "test", (project) => {
      project.media.push({ id: "m1", name: "board", path: "/elsewhere/board.mp4", kind: "video", duration: 2, width: 1920, height: 1080, fps: 30, has_audio: false, effect: "board", effect_key: "k2" });
    });
    fs.rmSync(dir, { recursive: true });
    expect(await effects.bringDown(app, id)).toEqual(["board"]);
    expect(fs.readFileSync(join(dir, "scene.html"), "utf8")).toBe("<p>two</p>");
    // Here already: left as it is.
    expect(await effects.bringDown(app, id)).toEqual([]);
  } finally {
    cleanup();
  }
});

test("the library: effects and sounds kept with a category, a note and a brief, searched, put away and back, brought into a project", async () => {
  const { app, cleanup, id } = hq("v2-library");
  try {
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    const dir = effects.folder(app.store, id, "board");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "scene.html"), "<p>board</p>");
    const keep = { kind: "effect", name: "board", as: "evidence-board", category: "evidence board", note: "A paper board the camera glides across.", brief: "PHOTOS, CAM keys and TEXTS at the top." };
    // Not a teacher: refused, in words to pass on.
    accounts.signedInForTests(["edit.bodycam"]);
    expect((await call(app, id, "save_to_library", keep)).content[0]!.text).toContain("a teacher's to do");
    accounts.signedInForTests(["edit.bodycam", "agent.teach"]);
    expect((await call(app, id, "save_to_library", { ...keep, brief: "x".repeat(300) })).content[0]!.text).toContain("brief is at most 240 characters");
    expect((await call(app, id, "save_to_library", keep)).content[0]!.text).toContain("evidence-board is version 1");
    const found = await call(app, id, "library", { kind: "effect", query: "board" });
    expect(found.content[0]!.text).toBe("- evidence-board [evidence board]: A paper board the camera glides across. To change it: PHOTOS, CAM keys and TEXTS at the top.");
    expect((await call(app, id, "library", { kind: "effect", query: "whoosh" })).content[0]!.text).toContain('No effects match "whoosh"');
    expect((await call(app, id, "library", { kind: "sound" })).content[0]!.text).toContain("No sounds");
    // Brought into a project as its own folder.
    expect((await call(app, id, "use_from_library", { kind: "effect", name: "evidence-board", as: "intro-board" })).isError).toBe(false);
    expect(fs.readFileSync(join(effects.folder(app.store, id, "intro-board"), "scene.html"), "utf8")).toBe("<p>board</p>");
    expect((await call(app, id, "use_from_library", { kind: "effect", name: "evidence-board", as: "intro-board" })).content[0]!.text).toContain("already");
    // Put away ("delete it"): out of the list, unless asked for; back again.
    await call(app, id, "archive_in_library", { kind: "effect", name: "evidence-board" });
    expect((await call(app, id, "library", { kind: "effect" })).content[0]!.text).toContain("No effects");
    expect((await call(app, id, "library", { kind: "effect", archived: true })).content[0]!.text).toContain("evidence-board (put away)");
    await call(app, id, "archive_in_library", { kind: "effect", name: "evidence-board", archived: false });
    expect((await call(app, id, "library", { kind: "effect" })).content[0]!.text).toContain("- evidence-board [");
  } finally {
    cleanup();
  }
});

test("what the agent remembers: a line or two each, the global skill first and never put away, in Bodycam HQ's instructions alone", async () => {
  const { app, cleanup, id } = hq("v2-memory");
  try {
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    accounts.signedInForTests(["edit.bodycam"]);
    expect((await call(app, id, "remember", { skill: "pins", text: "Pins are red.", reason: "Sphe" })).content[0]!.text).toContain("a teacher's to do");
    accounts.signedInForTests(["edit.bodycam", "agent.teach"]);
    expect((await call(app, id, "remember", { skill: "pins", text: "x".repeat(401), reason: "Sphe" })).content[0]!.text).toContain("at most 400 characters");
    expect((await call(app, id, "remember", { skill: "global", text: "x", reason: "y" })).content[0]!.text).toContain("Edit's own");
    expect((await call(app, id, "remember", { skill: "pins", text: "Board pins are red.", reason: "Sphe: pins are red" })).content[0]!.text).toContain("Remembered as pins (version 1)");
    // The global skill is seeded where Edit is made (the mock stands in for accounts' setGlobalSkill).
    mock.cloud.convex.library.set("skill:global", { key: "skill:global", kind: "skill", name: "global", current: 1, latest: 1, at: Date.now(), by: { name: "Edit" } });
    mock.cloud.convex.libraryVersions.set("skill:global", [{ key: "skill:global", n: 1, text: "- Keep what you remember short.", at: Date.now(), by: { name: "Edit" } }]);
    v2cloud.forgetSkills();
    await v2cloud.refreshSkills();
    expect(v2cloud.memories().map((one) => one.name)).toEqual(["global", "pins"]);
    const project = app.store.get(id)!.project;
    const prompt = agentInstructions(project);
    expect(prompt).toContain("WHAT YOU REMEMBER");
    expect(prompt.indexOf("- Keep what you remember short.")).toBeLessThan(prompt.indexOf("[pins] Board pins are red."));
    // None of the house's instructions or skills: its own, short.
    expect(prompt).not.toContain("WORK FAST");
    expect(prompt).not.toContain("- skill(");
    expect(prompt).not.toContain("- add_sound_effect(");
    expect((await call(app, id, "archive_in_library", { kind: "skill", name: "global" })).content[0]!.text).toContain("stays");
    await call(app, id, "archive_in_library", { kind: "skill", name: "pins" });
    await v2cloud.refreshSkills();
    expect(v2cloud.memories().map((one) => one.name)).toEqual(["global"]);
    // Every other project reads the house's, and none of this.
    const plain = app.store.create("Plain", { width: 1920, height: 1080, fps: 30 }).project;
    expect(agentInstructions(plain)).toContain("WORK FAST");
    expect(agentInstructions(plain)).not.toContain("WHAT YOU REMEMBER");
  } finally {
    cleanup();
  }
});
