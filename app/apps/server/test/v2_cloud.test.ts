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
  v2cloud.useSkillsForTests({});
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

test("templates: kept by a teacher, listed with when to use them, started from as a project's own effect", async () => {
  const { app, cleanup, id } = hq("v2-templates");
  try {
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    const dir = effects.folder(app.store, id, "board");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "scene.html"), "<p>board</p>");
    // Not a teacher: refused, in words to pass on.
    accounts.signedInForTests(["edit.bodycam"]);
    const refused = await call(app, id, "save_template", { name: "board", note: "an evidence board" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("a teacher's to do");
    // A teacher (agent.teach).
    accounts.signedInForTests(["edit.bodycam", "agent.teach"]);
    expect((await call(app, id, "save_template", { name: "board", template: "evidence-board", note: "an evidence board the camera glides across" })).content[0]!.text).toContain("Template evidence-board is version 1");
    const listed = await call(app, id, "templates", {});
    expect(listed.content[0]!.text).toBe("- evidence-board (version 1): an evidence board the camera glides across");
    const used = await call(app, id, "use_template", { template: "evidence-board", name: "intro-board" });
    expect(used.isError).toBe(false);
    expect(fs.readFileSync(join(effects.folder(app.store, id, "intro-board"), "scene.html"), "utf8")).toBe("<p>board</p>");
    expect((await call(app, id, "use_template", { template: "evidence-board", name: "intro-board" })).content[0]!.text).toContain("already");
    expect((await call(app, id, "use_template", { template: "nothing", name: "other" })).content[0]!.text).toContain("no template nothing");
  } finally {
    cleanup();
  }
});

test("a teacher's version of the agent's text is what Bodycam HQ's agent reads from its next turn, and only there", async () => {
  const { app, cleanup, id } = hq("v2-skills");
  try {
    await app.store.update(id, "test", (project) => {
      project.hq = true;
    });
    const before = await call(app, id, "skill_text", { path: "hq/notes.md" });
    expect(before.content[0]!.text).toContain("(the release's)");
    expect((await call(app, id, "skill_text", { path: "../secrets.md" })).content[0]!.text).toContain("is a file of agent/");
    accounts.signedInForTests(["edit.bodycam"]);
    expect((await call(app, id, "save_skill", { path: "hq/notes.md", text: "x", reason: "y" })).content[0]!.text).toContain("a teacher's to do");
    accounts.signedInForTests(["edit.bodycam", "agent.teach"]);
    const saved = await call(app, id, "save_skill", { path: "hq/notes.md", text: "TAUGHT: every board has a red pin.", reason: "Sphe: pins are red" });
    expect(saved.content[0]!.text).toContain("hq/notes.md is version 1");
    const intro = await call(app, id, "save_skill", { path: "skills/intro.md", text: "---\ndescription: The intro.\n---\n\nTAUGHT intro: open on the board.", reason: "Sphe" });
    expect(intro.isError).toBe(false);
    const project = app.store.get(id)!.project;
    // The HQ agent's instructions and skill read the teacher's.
    expect(agentInstructions(project)).toContain("TAUGHT: every board has a red pin.");
    expect(agentInstructions(project)).not.toContain("EVERYTHING ON SCREEN IS CODE YOU WRITE");
    const skill = await call(app, id, "skill", { name: "intro" });
    expect(skill.content[0]!.text).toBe("TAUGHT intro: open on the board.");
    expect((await call(app, id, "skill_text", { path: "hq/notes.md" })).content[0]!.text).toContain("(a teacher's, from V2's cloud)");
    // Every other project reads the release's.
    const plain = app.store.create("Plain", { width: 1920, height: 1080, fps: 30 }).project;
    expect(agentInstructions(plain)).not.toContain("TAUGHT");
    const theirs = await call(app, plain.id, "skill", { name: "intro" });
    expect(theirs.content[0]!.text).not.toContain("TAUGHT");
  } finally {
    cleanup();
  }
});
