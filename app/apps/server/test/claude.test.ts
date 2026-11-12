// The agent on Claude Code: its models read into the panel's, and a turn's
// messages (shaped as a real Opus 5.5 turn sent them) mapped onto the chat,
// with a stand-in query (no Claude Code is started).

import { expect, spyOn, test } from "bun:test";

import * as fs from "node:fs";
import { join } from "node:path";

import * as jobs from "../src/jobs.ts";
import * as localPreviews from "../src/local_previews.ts";

import { agentHooks, Agents, editToolsFailed, readChat, STALL_MS, timing } from "../src/agent.ts";
import * as claude from "../src/claude.ts";
import * as modelChoice from "../src/model_choice.ts";
import * as notices from "../src/notices.ts";
import * as toolChanges from "../src/tool_changes.ts";
import { fixtureHome } from "./helpers/home.ts";
import { media } from "./helpers/model.ts";

const MODELS = [
  { value: "default", displayName: "Default (recommended)", description: "" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Most capable", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "haiku", displayName: "Haiku 5.5", description: "Fastest", supportsEffort: false },
] as claude.ModelInfo[];

test("opus is the default at medium and claude code's own default row is left out", () => {
  const models = claude.catalog(MODELS);
  expect(models.map((model) => model.id)).toEqual(["opus", "haiku"]);
  expect(models[0]).toMatchObject({ is_default: true, default_effort: "medium", efforts: ["low", "medium", "high", "xhigh", "max"] });
  expect(models[1]).toMatchObject({ is_default: false, efforts: [] });
});

test("plans and results read as the user sees them", () => {
  expect(claude.planName("max")).toBe("Claude Max");
  expect(claude.planName("Claude Pro")).toBe("Claude Pro");
  expect(claude.resultError({ subtype: "success", is_error: false })).toBeNull();
  expect(claude.resultError({ subtype: "error_during_execution", errors: ["API Error: 529 overloaded"] })).toBe("API Error: 529 overloaded");
  expect(claude.toolName("mcp__edit__get_edit_context")).toBe("get_edit_context");
});

/** A stand-in query: the test pushes messages; interrupt ends it as stopped (or never answers, `hangs`). */
function fakeQuery(hangs = false) {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  let interrupted = false;
  let closed = false;
  const push = (message: unknown) => {
    queue.push(message);
    wake?.();
  };
  const end = () => {
    ended = true;
    wake?.();
  };
  async function* messages() {
    for (;;) {
      while (queue.length > 0) yield queue.shift();
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
  }
  const generator = messages();
  const query = Object.assign(generator, {
    interrupt: async () => {
      interrupted = true;
      if (hangs) return new Promise<undefined>(() => {});
      push({ type: "result", subtype: "error_during_execution", errors: ["interrupted"], usage: {} });
      end();
      return undefined;
    },
    close: () => {
      closed = true;
      end();
    },
  });
  return { query: query as unknown as claude.Query, push, end, interrupted: () => interrupted, closed: () => closed };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Bun.sleep(0);
}

/** Waits until `asked` holds `count` sends (a follow-up lands a second after a turn ends), within 10 s: on a loaded CI runner the second can run long. */
async function askedCount(asked: unknown[], count: number): Promise<void> {
  const until = Date.now() + 10_000;
  while (asked.length < count && Date.now() < until) await Bun.sleep(25);
  await settle();
}

function agentsWith(home: ReturnType<typeof fixtureHome>, hangs = false) {
  const agents = new Agents(home.store, home.home, 7700);
  const asked: { prompt: string | AsyncIterable<claude.UserMessage>; options: claude.Options }[] = [];
  const queries: ReturnType<typeof fakeQuery>[] = [];
  agents.findClaude = async () => "/test/claude";
  agents.listClaudeModels = async () => MODELS;
  agents.claudeQuery = async (params) => {
    asked.push(params);
    const fake = fakeQuery(hangs);
    queries.push(fake);
    return fake.query;
  };
  return { agents, asked, queries };
}

const stream = (event: Record<string, unknown>) => ({ type: "stream_event", event, parent_tool_use_id: null });

test("a Bodycam HQ project's turn runs in its effects folder with the file tools, allowed there and nowhere else", async () => {
  const home = fixtureHome("claude-hq");
  try {
    const project = home.store.create("HQ test", { width: 1920, height: 1080, fps: 30 }).project.id;
    await home.store.update(project, "test", (made) => {
      made.hq = true;
    });
    const { agents, asked, queries } = agentsWith(home);
    await agents.send(project, "Make the evidence board", null, null);
    const { options } = asked[0]!;
    const folder = fs.realpathSync(join(home.home, "media", project, "effects"));
    expect(options.cwd).toBe(folder);
    expect(options.tools).toEqual(["Read", "Write", "Edit", "Glob", "Grep"]);
    expect(options.allowedTools).toEqual(["mcp__edit", `Read(/${folder}/**)`, `Edit(/${folder}/**)`, `Write(/${folder}/**)`]);
    // Still nothing asked and nothing run: a tool that isn't allowed is refused.
    expect(options.permissionMode).toBe("dontAsk");
    expect(String(options.systemPrompt)).toContain("THIS IS A BODYCAM HQ VIDEO");
    // Fable 5.2 thinking high until the person picks, whatever the menu says elsewhere (Sphe, Nov 11).
    expect(options.model).toBe("claude-fable-5-2");
    expect(options.effort).toBe("high");
    expect(agents.revising(project)).toBe(false);
    expect(agents.modelName(project)).toBe("Fable 5.2");
    expect(String(options.systemPrompt)).toContain("- look_at_effect(name: string, beside?: object, detail?: normal|full, end?: number, every_frame?: boolean, start?: number, times?: array, zoom?: object)");
    expect(String(options.systemPrompt)).toContain("- fetch_font(family: string, weights?: array)");
    queries[0]!.push({ type: "system", subtype: "init", session_id: "session-hq" });
    queries[0]!.push({ type: "result", subtype: "success", is_error: false, usage: {} });
    queries[0]!.end();
    await settle();

    // Its own pick in the menu, at any time (Sphe, Nov 11): the next turn is on it, the other chats' pick untouched.
    modelChoice.save({ ...modelChoice.current(), hq_model: "claude-sonnet-5-5", hq_effort: "medium" });
    expect(JSON.parse(fs.readFileSync(`${home.home}/models.json`, "utf8"))).toEqual({ revision: "claude-opus-5-5", effort: "medium", hq_model: "claude-sonnet-5-5", hq_effort: "medium" });
    expect(agents.modelName(project)).toBe("Sonnet 5.5");
    expect(agents.revising(project)).toBe(false);
    await agents.send(project, "Make it red", null, null);
    expect(asked[1]!.options.model).toBe("claude-sonnet-5-5");
    expect(asked[1]!.options.effort).toBe("medium");
    expect(asked[1]!.options.resume).toBe("session-hq");
    // The other chats' pick changed: HQ's stays.
    modelChoice.save({ ...modelChoice.current(), effort: "low" });
    expect(modelChoice.current()).toMatchObject({ hq_model: "claude-sonnet-5-5", hq_effort: "medium" });
    // Another project is as it was: Opus to build, at the other chats' level.
    const other = home.store.create("Not HQ", { width: 1920, height: 1080, fps: 30 }).project.id;
    expect(agents.modelName(other)).toBe("Opus 5.5");
    await agents.send(other, "Tighten the intro", null, null);
    expect(asked[2]!.options.model).toBe("opus");
    expect(asked[2]!.options.effort).toBe("low");
  } finally {
    modelChoice.save({});
    home.cleanup();
  }
});

/** A Bodycam HQ project with the agent on Claude Code, for one test. */
async function hqProject(name: string) {
  const made = claudeProject(name);
  await made.home.store.update(made.project, "test", (draft) => {
    draft.hq = true;
  });
  return made;
}

/** A stand-in query's turn ending as it should. */
function ends(query: ReturnType<typeof fakeQuery>): void {
  query.push({ type: "result", subtype: "success", is_error: false, usage: {} });
  query.end();
}

test("a message sent while a Bodycam HQ turn runs waits on the server, kept with the chat, and goes as the next turn when it ends; cancel takes one out", async () => {
  const { home, project, agents, asked, queries } = await hqProject("claude-hq-queue");
  const read = agentHooks.messageContext;
  // What's at its playhead is read as it goes.
  agentHooks.messageContext = async (_project, playhead) => `\n\n(the playhead at ${playhead})`;
  try {
    await agents.send(project, "Make the evidence board", null, null);
    queries[0]!.push({ type: "system", subtype: "init", session_id: "session-1" });
    await settle();
    const first = await agents.message(project, "Make it red", null, null, "(read now)", [{ name: "ref.png", kind: "image", media: "m1" }], 120);
    const second = await agents.message(project, "And add a stamp", null, null, "", [], null);
    const third = await agents.message(project, "Never mind", null, null, "", [], null);
    expect([first?.text, second?.text, third?.text]).toEqual(["Make it red", "And add a stamp", "Never mind"]);
    // Queued, not sent.
    expect(asked.length).toBe(1);
    expect(agents.withChat(project).entries.filter((item) => item.kind === "user").map((item) => item.text)).toEqual(["Make the evidence board"]);
    expect(agents.cancelQueued(project, third!.id)).toBe(true);
    expect(agents.cancelQueued(project, third!.id)).toBe(false);
    expect((agents.chat(project) as { queue: { text: string }[] }).queue.map((one) => one.text)).toEqual(["Make it red", "And add a stamp"]);
    // Kept in the chat's file, read back as it was (a restart, another editor).
    const saved = readChat(fs.readFileSync(home.store.chatPath(project), "utf8"));
    expect(saved.queue).toEqual([
      { id: first!.id, text: "Make it red", at: first!.at, playhead: 120, attachments: [{ name: "ref.png", kind: "image", media: "m1" }] },
      { id: second!.id, text: "And add a stamp", at: second!.at, playhead: null },
    ]);

    // The turn ends: the first goes by itself, in the same conversation, its playhead read now; the second waits.
    ends(queries[0]!);
    await askedCount(asked, 2);
    expect(asked[1]!.options.resume).toBe("session-1");
    expect(String(asked[1]!.prompt)).toStartWith("Make it red");
    expect(agents.withChat(project).entries.filter((item) => item.kind === "user").at(-1)).toMatchObject({ text: "Make it red", attachments: [{ name: "ref.png", kind: "image", media: "m1" }] });
    expect(agents.withChat(project).queue.map((one) => one.text)).toEqual(["And add a stamp"]);
    expect(agents.withChat(project).running).toBe(true);

    // A turn that ends with an error doesn't send the queue on: it waits, shown.
    queries[1]!.push({ type: "result", subtype: "error_during_execution", errors: ["The tool broke the page"], usage: {} });
    queries[1]!.end();
    await settle();
    await Bun.sleep(50);
    expect(agents.withChat(project).running).toBe(false);
    expect(asked.length).toBe(2);
    expect(agents.withChat(project).queue.map((one) => one.text)).toEqual(["And add a stamp"]);

    // A message sent with nothing running starts its turn as ever; the queue goes on after it.
    await agents.send(project, "Carry on", null, null);
    expect(asked[2]!.prompt).toBe("Carry on");
    // Stopped by the person: the queue stays, to steer or cancel.
    await agents.stop(project);
    await settle();
    await Bun.sleep(50);
    expect(agents.withChat(project).running).toBe(false);
    expect(asked.length).toBe(3);
    expect(agents.withChat(project).queue.map((one) => one.text)).toEqual(["And add a stamp"]);
    // Steer with nothing running sends it now.
    await agents.steer(project, second!.id);
    expect(asked[3]!.prompt).toBe("And add a stamp\n\n(the playhead at null)");
    expect(agents.withChat(project).queue).toEqual([]);
  } finally {
    agentHooks.messageContext = read;
    agents.shutdown();
    home.cleanup();
  }
});

test("steer stops the running turn and sends the queued message in its place, in the same conversation, the rest left queued", async () => {
  const { home, project, agents, asked, queries } = await hqProject("claude-hq-steer");
  try {
    await agents.send(project, "Make the evidence board", null, null);
    queries[0]!.push({ type: "system", subtype: "init", session_id: "session-1" });
    await settle();
    const wait = await agents.message(project, "Then a lower third", null, null, "", [], null);
    const now = await agents.message(project, "Make the board blue instead", null, null, "", [], null);
    await agents.steer(project, now!.id);
    expect(queries[0]!.interrupted()).toBe(true);
    expect(asked.length).toBe(2);
    expect(asked[1]!.prompt).toBe("Make the board blue instead");
    expect(asked[1]!.options.resume).toBe("session-1");
    const chat = agents.withChat(project);
    expect(chat.running).toBe(true);
    // The stop isn't said: the steered message follows it.
    expect(chat.entries.some((item) => item.kind === "error")).toBe(false);
    expect(chat.queue.map((one) => one.id)).toEqual([wait!.id]);
    // The steered turn ends: the rest of the queue goes on.
    ends(queries[1]!);
    await askedCount(asked, 3);
    expect(asked[2]!.prompt).toBe("Then a lower third");
    expect(agents.withChat(project).queue).toEqual([]);
    // With nothing running a message isn't queued: it starts its turn.
    ends(queries[2]!);
    await settle();
    expect(agents.withChat(project).running).toBe(false);
    const idle = await agents.message(project, "One more", null, null, "", [], null);
    expect(idle).toBeNull();
    expect(asked[3]!.prompt).toBe("One more");
  } finally {
    agents.shutdown();
    home.cleanup();
  }
});

test("a queue left when Edit quit goes on after the turn a restart carries on", async () => {
  const { home, project, agents, queries } = await hqProject("claude-hq-restart");
  try {
    await agents.send(project, "Make the evidence board", null, null);
    queries[0]!.push({ type: "system", subtype: "init", session_id: "session-1" });
    await settle();
    await agents.message(project, "Make it red", null, null, "", [], null);
    agents.shutdown();
    await settle();
    // Quitting doesn't send it.
    expect(agents.withChat(project).queue.map((one) => one.text)).toEqual(["Make it red"]);
    const after = agentsWith(home);
    expect(after.agents.withChat(project).queue.map((one) => one.text)).toEqual(["Make it red"]);
    await after.agents.resumeInterrupted();
    await settle();
    expect(after.asked[0]!.prompt).toStartWith("(Edit, automatically) Edit restarted");
    ends(after.queries[0]!);
    await askedCount(after.asked, 2);
    expect(after.asked[1]!.prompt).toBe("Make it red");
    expect(after.asked[1]!.options.resume).toBe("session-1");
    after.agents.shutdown();
  } finally {
    home.cleanup();
  }
});

test("any other project still refuses a message while its turn runs, exactly as before", async () => {
  const { home, project, agents, asked } = claudeProject("claude-no-queue");
  try {
    await agents.send(project, "Go", null, null);
    await expect(agents.message(project, "More", null, null, "", [], 10)).rejects.toThrow("the agent is still working; stop it or wait");
    await expect(agents.send(project, "More", null, null)).rejects.toThrow("the agent is still working; stop it or wait");
    await settle();
    expect(asked.length).toBe(1);
    expect(agents.withChat(project).queue).toEqual([]);
    await expect(agents.steer(project, "queued-1")).rejects.toThrow("only a Bodycam HQ chat queues messages");
    // Nothing queued in its file.
    expect(JSON.parse(fs.readFileSync(home.store.chatPath(project), "utf8")).queue).toBeUndefined();
  } finally {
    agents.shutdown();
    home.cleanup();
  }
});

test("claude is the default provider and a turn streams text and edit tools onto the chat", async () => {
  const home = fixtureHome("claude");
  try {
    const project = home.store.create("Claude test", { width: 1920, height: 1080, fps: 30 }).project.id;
    const { agents, asked, queries } = agentsWith(home);

    await agents.send(project, "Tighten the intro", null, null);
    const { prompt, options } = asked[0]!;
    expect(prompt).toBe("Tighten the intro");
    expect(options.model).toBe("opus");
    expect(options.effort).toBe("medium");
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual(["mcp__edit"]);
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.pathToClaudeCodeExecutable).toBe("/test/claude");
    expect(options.mcpServers).toEqual({ edit: { type: "http", url: `http://127.0.0.1:7700/mcp?project=${project}` } });
    expect(options.resume).toBeUndefined();
    expect(String(options.systemPrompt)).toContain("call them directly");
    expect(String(options.systemPrompt)).not.toContain("yield_time_ms");

    const q = queries[0]!;
    q.push({ type: "system", subtype: "init", session_id: "session-1" });
    q.push(stream({ type: "message_start" }));
    q.push(stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    q.push(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reading " } }));
    q.push(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "the intro." } }));
    q.push(stream({ type: "content_block_stop", index: 0 }));
    q.push(stream({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__edit__get_edit_context", input: {} } }));
    q.push({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "toolu_1", name: "mcp__edit__get_edit_context", input: { section: "intro" } }] } });
    q.push(stream({ type: "content_block_stop", index: 1 }));
    q.push({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "{}" }] }] } });
    q.push(stream({ type: "message_start" }));
    q.push(stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }));
    q.push(stream({ type: "content_block_stop", index: 0 }));
    q.push(stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }));
    q.push(stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Cut 2 s at 00:04." } }));
    q.push(stream({ type: "content_block_stop", index: 1 }));
    await settle();

    let chat = agents.withChat(project);
    expect(chat.running).toBe(true);
    expect(chat.provider).toBe("claude");
    expect(chat.thread).toBe("session-1");
    expect(chat.entries.map((item) => [item.kind, item.text, item.tool ?? null, item.status ?? null])).toEqual([
      ["user", "Tighten the intro", null, null],
      ["assistant", "Reading the intro.", null, null],
      ["tool", "section: intro", "get_edit_context", "done"],
      ["assistant", "Cut 2 s at 00:04.", null, null],
    ]);

    q.push({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 4, cache_read_input_tokens: 100, output_tokens: 20 } });
    q.end();
    await settle();
    chat = agents.withChat(project);
    expect(chat.running).toBe(false);
    expect(chat.entries.some((item) => item.kind === "error")).toBe(false);

    // The next message resumes the same session.
    await agents.send(project, "And the outro", null, "high");
    expect(asked[1]!.options.resume).toBe("session-1");
    expect(asked[1]!.options.effort).toBe("high");
  } finally {
    home.cleanup();
  }
});

test("a compaction shows in the chat as it happens, then how much it took off", async () => {
  // Sphe, Nov 12: "show when there is compaction occurring, as it occurs ... then it shows how much was compacted".
  const home = fixtureHome("claude-compact");
  try {
    const project = home.store.create("Compact", { width: 1920, height: 1080, fps: 30 }).project.id;
    const { agents, queries } = agentsWith(home);
    await agents.send(project, "Carry on", null, null);
    const q = queries[0]!;
    q.push({ type: "system", subtype: "init", session_id: "session-1" });
    q.push({ type: "system", subtype: "status", status: "compacting" });
    await settle();
    const line = () => agents.withChat(project).entries.find((item) => item.kind === "compact");
    expect(line()?.status).toBe("running");
    // Its size after isn't said: the next call's reading is it.
    q.push({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 967_000 } });
    q.push({ type: "system", subtype: "status", status: null, compact_result: "success" });
    await settle();
    expect(line()?.status).toBe("done");
    expect(JSON.parse(line()!.detail!)).toEqual({ pre: 967_000, post: null });
    q.push(stream({ type: "message_start", message: { usage: { input_tokens: 700, cache_creation_input_tokens: 22_000, cache_read_input_tokens: 0 } } }));
    await settle();
    expect(JSON.parse(line()!.detail!)).toEqual({ pre: 967_000, post: 22_700 });
    expect(agents.withChat(project).entries.filter((item) => item.kind === "compact")).toHaveLength(1);
    q.push({ type: "result", subtype: "success", is_error: false, usage: {} });
    q.end();
    await settle();
  } finally {
    home.cleanup();
  }
});

test("a turn's footage comes down at its start and, with what it added, at its end, before the edit is opened to be watched", async () => {
  const home = fixtureHome("claude-footage");
  const asked: string[][] = [];
  const fetching = spyOn(localPreviews, "fetchAll").mockImplementation((_cache, project) => void asked.push(project.media.map((one) => one.id)));
  try {
    const project = home.store.create("Footage", { width: 1920, height: 1080, fps: 30 }).project.id;
    await home.store.update(project, "test", (draft) => void draft.media.push(media({ id: "m1", name: "a.mp4", path: "/a.mp4", kind: "video", duration: 60 })));
    const { agents, queries } = agentsWith(home);
    await agents.send(project, "Add the map", null, null);
    expect(asked).toEqual([["m1"]]);
    // The turn makes a map (a media of its own), then ends.
    await home.store.update(project, "agent", (draft) => void draft.media.push(media({ id: "m2", name: "map.mp4", path: "/map.mp4", kind: "video", duration: 8 })));
    const q = queries[0]!;
    q.push({ type: "system", subtype: "init", session_id: "session-1" });
    q.push({ type: "result", subtype: "success", is_error: false, usage: {} });
    q.end();
    await settle();
    expect(agents.withChat(project).running).toBe(false);
    expect(asked.at(-1)).toEqual(["m1", "m2"]);
  } finally {
    fetching.mockRestore();
    home.cleanup();
  }
});

test("a chat saved from the Codex days starts a new Claude conversation, and stopping interrupts the query", async () => {
  const home = fixtureHome("claude-stop");
  try {
    const project = home.store.create("Claude stop", { width: 1920, height: 1080, fps: 30 }).project.id;
    const { agents, asked, queries } = agentsWith(home);
    // Read back as a saved Codex chat is: no provider Claude Code can resume.
    const saved = readChat(JSON.stringify({ provider: "codex", thread: "codex-thread", model: "gpt-6", entries: [] }));
    expect([saved.provider, saved.thread]).toEqual([null, "codex-thread"]);
    Object.assign(agents.withChat(project), saved);

    await agents.send(project, "Go", null, null);
    expect(asked[0]!.options.resume).toBeUndefined();
    expect(asked[0]!.options.model).toBe("opus");

    await agents.stop(project);
    expect(queries[0]!.interrupted()).toBe(true);
    await settle();
    const chat = agents.withChat(project);
    expect(chat.running).toBe(false);
    expect(chat.entries.at(-1)?.text).toBe("Stopped.");
  } finally {
    home.cleanup();
  }
});

/** A project with the agent on Claude Code, for one test. */
function claudeProject(name: string, hangs = false) {
  const home = fixtureHome(name);
  const project = home.store.create(name, { width: 1920, height: 1080, fps: 30 }).project.id;
  return { home, project, ...agentsWith(home, hangs) };
}

test("a stop claude code never answers ends the turn after the grace, closing it", async () => {
  const { home, project, agents, queries } = claudeProject("claude-hung", true);
  const saved = { ...timing };
  const timers: (() => void)[] = [];
  timing.later = (_ms, work) => timers.push(work);
  timing.sleep = async () => {};
  try {
    await agents.send(project, "Go", null, null);
    await agents.stop(project);
    expect(queries[0]!.interrupted()).toBe(true);
    expect(agents.withChat(project).running).toBe(true);
    for (const work of timers) work();
    await settle();
    const chat = agents.withChat(project);
    expect(chat.running).toBe(false);
    expect(queries[0]!.closed()).toBe(true);
    expect(chat.entries.at(-1)?.text).toBe("Stopped.");
  } finally {
    Object.assign(timing, saved);
    home.cleanup();
  }
});

test("a turn its agent stopped answering is ended, and edit quitting ends the rest", async () => {
  const { home, project, agents, queries } = claudeProject("claude-stall");
  try {
    await agents.send(project, "Go", null, null);
    queries[0]!.push({ type: "system", subtype: "init", session_id: "session-1" });
    await settle();
    agents.checkStalls(timing.now() + STALL_MS / 2);
    expect(agents.withChat(project).running).toBe(true);
    agents.checkStalls(timing.now() + STALL_MS + 1000);
    await settle();
    let chat = agents.withChat(project);
    expect(chat.running).toBe(false);
    expect(queries[0]!.closed()).toBe(true);
    expect(chat.entries.at(-1)?.text).toContain("The agent stopped answering");

    await agents.send(project, "Carry on", null, null);
    expect(agents.withChat(project).running).toBe(true);
    agents.shutdown();
    await settle();
    chat = agents.withChat(project);
    expect(chat.running).toBe(false);
    expect(queries[1]!.closed()).toBe(true);
    expect(chat.entries.at(-1)?.text).toStartWith("Edit was closed during this turn. Back within 10 minutes (a restart), it carries on by itself");
  } finally {
    home.cleanup();
  }
});

test("a restart carries on the turns its quit cut short, in the same conversation; a quit long ago doesn't", async () => {
  const { home, project, agents, queries } = claudeProject("claude-restart");
  // The turns as jobs.json lists them (kind `turn`).
  const turns = () => jobs.list(home.home, "turn").filter(jobs.live);
  try {
    await agents.send(project, "Start the editing workflow", null, null);
    queries[0]!.push({ type: "system", subtype: "init", session_id: "session-1" });
    await settle();
    agents.shutdown();
    await settle();
    expect(turns().map((job) => job.project)).toEqual([project]);

    // The new process: the chat read back from disk.
    const after = agentsWith(home);
    // Before it carries on (serve.ts waits up to 20 s for sign-in), the cut turn counts as running: no restart cuts it again.
    expect(after.agents.hasRunningTurns()).toBe(true);
    await after.agents.resumeInterrupted();
    await settle();
    // Listed still: the turn carrying on is running.
    expect(turns().map((job) => job.project)).toEqual([project]);
    expect(after.asked.length).toBe(1);
    expect(after.asked[0]!.options.resume).toBe("session-1");
    expect(after.asked[0]!.prompt).toStartWith("(Edit, automatically) Edit restarted while you were working");
    expect(after.agents.withChat(project).running).toBe(true);
    after.agents.shutdown();
    await settle();

    // A crash (no shutdown) leaves the turn listed as it started it.
    const crashed = agentsWith(home);
    await crashed.agents.send(project, "Go on", null, null);
    expect(turns().map((job) => job.project)).toEqual([project]);
    const back = agentsWith(home);
    await back.agents.resumeInterrupted();
    await settle();
    expect(back.asked[0]!.prompt).toStartWith("(Edit, automatically) Edit restarted");
    back.agents.shutdown();
    crashed.agents.shutdown();
    await settle();

    // A turn that ended leaves nothing listed.
    const done = agentsWith(home);
    await done.agents.send(project, "One more", null, null);
    done.queries[0]!.push({ type: "result", subtype: "success", is_error: false, usage: {} });
    done.queries[0]!.end();
    await settle();
    expect(done.agents.withChat(project).running).toBe(false);
    expect(turns()).toEqual([]);

    // Closed hours ago (an older build's running-turns.json, taken into jobs.json): nothing starts by itself.
    fs.writeFileSync(`${home.home}/agent/running-turns.json`, JSON.stringify({ at: Date.now() - 3 * 3_600_000, projects: [project] }));
    const later = agentsWith(home);
    expect(later.agents.hasRunningTurns()).toBe(false);
    await later.agents.resumeInterrupted();
    await settle();
    expect(later.asked.length).toBe(0);
    expect(fs.existsSync(`${home.home}/agent/running-turns.json`)).toBe(false);
    expect(turns()).toEqual([]);
  } finally {
    home.cleanup();
  }
});

test("a session claude code no longer has is started again as a new conversation in the same turn", async () => {
  const { home, project, agents, asked, queries } = claudeProject("claude-gone");
  try {
    agents.withChat(project).provider = "claude";
    agents.withChat(project).thread = "session-gone";
    await agents.send(project, "And the outro", null, null);
    expect(asked[0]!.options.resume).toBe("session-gone");
    queries[0]!.push({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["No conversation found with session ID: session-gone"], usage: {} });
    queries[0]!.end();
    await settle();
    expect(asked.length).toBe(2);
    expect(asked[1]!.options.resume).toBeUndefined();
    expect(asked[1]!.prompt).toStartWith("(Edit, automatically) The earlier conversation couldn't be picked up again");
    expect(asked[1]!.prompt).toEndWith("\n\nAnd the outro");
    let chat = agents.withChat(project);
    expect(chat.running).toBe(true);
    expect(chat.thread).toBeNull();
    queries[1]!.push({ type: "system", subtype: "init", session_id: "session-2" });
    queries[1]!.push({ type: "result", subtype: "success", is_error: false, usage: {} });
    queries[1]!.end();
    await settle();
    chat = agents.withChat(project);
    expect(chat.running).toBe(false);
    expect(chat.thread).toBe("session-2");
    expect(chat.entries.filter((item) => item.kind === "user").length).toBe(1);
    expect(chat.entries.some((item) => item.kind === "error")).toBe(false);
  } finally {
    home.cleanup();
  }
});

test("a chat saved mid-tool reads back with that tool stopped", () => {
  const home = fixtureHome("claude-reload");
  try {
    const project = home.store.create("Reload", { width: 1920, height: 1080, fps: 30 }).project.id;
    const entries = [{ id: "t1", kind: "tool", text: "", tool: "watch_footage", status: "running", at: 1, updated: 1 }];
    fs.writeFileSync(home.store.chatPath(project), JSON.stringify({ provider: "claude", thread: "s", model: null, effort: null, entries }));
    const agents = new Agents(home.store, home.home, 7700);
    expect(agents.withChat(project).entries[0]!.status).toBe("stopped");
  } finally {
    home.cleanup();
  }
});

test("a refused sign-in mid-turn is told as one to fix, not Anthropic's raw error", () => {
  expect(claude.signInProblem("Failed to authenticate. API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"OAuth access token is invalid\"}}")).toBe(true);
  expect(claude.signInProblem("Invalid API key · Please run /login")).toBe(true);
  expect(claude.signInProblem("Claude Code stopped: it reached its limit of turns.")).toBe(false);
  expect(claude.SIGN_IN_AGAIN).toContain("/login");
});

function browserRecovery(agents: Agents) {
  let authenticated = false;
  let finishLogin!: () => void;
  let opened!: () => void;
  const opening = new Promise<void>((resolve) => { opened = resolve; });
  const login = new Promise<void>((resolve) => { finishLogin = resolve; });
  let logins = 0;
  agents.claudeSupport.runtime = {
    find: async () => "/test/claude",
    async run(command, _cwd, signal) {
      if (command[1] === "auth" && command[2] === "login") {
        logins++;
        opened();
        await Promise.race([login, new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
        authenticated = true;
        return { code: 0, out: "Login successful" };
      }
      if (command[1] === "auth") return { code: 0, out: '{"loggedIn":true,"authMethod":"claude.ai"}' };
      if (command[1] === "-p") return { code: authenticated ? 0 : 1, out: JSON.stringify({ type: "result", subtype: "success", is_error: !authenticated, result: authenticated ? "OK" : "authentication_error: OAuth access token is invalid (401)" }) };
      return { code: 0, out: "Healthy" };
    },
  };
  return { opening, finishLogin, logins: () => logins };
}

test("an auth refusal opens one login and resends the saved message once without duplicating the chat", async () => {
  const home = fixtureHome("claude-sign-in-replay");
  const { agents, asked, queries } = agentsWith(home);
  const recovery = browserRecovery(agents);
  try {
    const project = home.store.create("Login", { width: 1920, height: 1080, fps: 30 }).project.id;
    await agents.send(project, "Research this case", null, null);
    queries[0]!.push({ type: "system", subtype: "init", session_id: "saved-session" });
    queries[0]!.push({ type: "result", subtype: "success", is_error: true, result: "authentication_error: OAuth access token is invalid (401)" });
    queries[0]!.end();
    await recovery.opening;
    expect(agents.withChat(project).running).toBe(false);
    expect(agents.claudeSetup().phase).toBe("signing_in");
    recovery.finishLogin();
    await agents.claudeSupport.settled();
    await settle();
    expect(asked).toHaveLength(2);
    expect(asked[1]!.prompt).toBe("Research this case");
    expect(asked[1]!.options.resume).toBe("saved-session");
    expect(agents.withChat(project).entries.filter((item) => item.kind === "user")).toHaveLength(1);
    expect(recovery.logins()).toBe(1);
    // A second rejection stays actionable without opening another browser.
    queries[1]!.push({ type: "result", subtype: "success", is_error: true, result: "authentication_error: 401" });
    queries[1]!.end();
    await settle();
    expect(recovery.logins()).toBe(1);
    expect(agents.claudeSetup().phase).toBe("needs_login");
  } finally { agents.shutdown(); home.cleanup(); }
});

test("Stop and New Chat discard a message waiting for sign-in", async () => {
  for (const cancel of ["stop", "reset"] as const) {
    const home = fixtureHome(`claude-sign-in-${cancel}`);
    const { agents, asked, queries } = agentsWith(home);
    const recovery = browserRecovery(agents);
    try {
      const project = home.store.create("Login", { width: 1920, height: 1080, fps: 30 }).project.id;
      await agents.send(project, "Research this case", null, null);
      queries[0]!.push({ type: "result", subtype: "success", is_error: true, result: "authentication_error: 401" });
      queries[0]!.end();
      await recovery.opening;
      if (cancel === "stop") await agents.stop(project); else agents.reset(project);
      recovery.finishLogin();
      await agents.claudeSupport.settled();
      await settle();
      expect(asked).toHaveLength(1);
      expect(agents.withChat(project).running).toBe(false);
    } finally { agents.shutdown(); home.cleanup(); }
  }
});

test("a message awaiting sign-in survives a restart", async () => {
  const home = fixtureHome("claude-sign-in-restart");
  let { agents, asked, queries } = agentsWith(home);
  const recovery = browserRecovery(agents);
  try {
    const project = home.store.create("Login", { width: 1920, height: 1080, fps: 30 }).project.id;
    await agents.send(project, "Research this case", null, null);
    queries[0]!.push({ type: "result", subtype: "success", is_error: true, result: "authentication_error: 401" });
    queries[0]!.end();
    await recovery.opening;
    agents.shutdown();
    await agents.claudeSupport.settled();
    ({ agents, asked, queries } = agentsWith(home));
    const next = browserRecovery(agents);
    agents.claudeSetup("login");
    await next.opening;
    next.finishLogin();
    await agents.claudeSupport.settled();
    await settle();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.prompt).toBe("Research this case");
    expect(agents.withChat(project).entries.filter((item) => item.kind === "user")).toHaveLength(1);
  } finally { agents.shutdown(); home.cleanup(); }
});

test("a project that moved to another Mac is not edited after sign-in", async () => {
  const home = fixtureHome("claude-sign-in-lock");
  const { agents, asked, queries } = agentsWith(home);
  const recovery = browserRecovery(agents);
  const original = home.store.mayWrite;
  try {
    const project = home.store.create("Login", { width: 1920, height: 1080, fps: 30 }).project.id;
    await agents.send(project, "Research this case", null, null);
    queries[0]!.push({ type: "result", subtype: "success", is_error: true, result: "authentication_error: 401" });
    queries[0]!.end();
    await recovery.opening;
    home.store.mayWrite = async () => { throw new Error("Project is now open on another Mac"); };
    recovery.finishLogin();
    await agents.claudeSupport.settled();
    await settle();
    expect(asked).toHaveLength(1);
    expect(agents.withChat(project).entries.at(-1)?.text).toContain("another Mac");
  } finally { home.store.mayWrite = original; agents.shutdown(); home.cleanup(); }
});

function oldAuthChat(home: ReturnType<typeof fixtureHome>, project: string, tool = false, error = "Failed to authenticate. API Error: 401 OAuth access token is invalid") {
  fs.writeFileSync(home.store.chatPath(project), JSON.stringify({ provider: "claude", thread: "old-session", model: null, effort: null, entries: [
    { id: "old-user", kind: "user", text: "Research this case", at: 1, updated: 1 },
    ...(tool ? [{ id: "old-tool", kind: "tool", text: "{}", tool: "collect_images", status: "done", at: 2, updated: 2 }] : []),
    { id: "old-error", kind: "error", text: error, at: 3, updated: 3 },
  ] }));
}

test("the open pre-update failed message resumes once after verification, with no duplicate user or active old error", async () => {
  const home = fixtureHome("claude-old-message");
  const { agents, asked, queries } = agentsWith(home);
  const recovery = browserRecovery(agents);
  try {
    const project = home.store.create("Old login", { width: 1920, height: 1080, fps: 30 }).project.id;
    const other = home.store.create("Other old login", { width: 1920, height: 1080, fps: 30 }).project.id;
    oldAuthChat(home, project);
    oldAuthChat(home, other);
    expect(agents.chat(project)).toMatchObject({ auth_retry: null });
    recovery.finishLogin();
    agents.claudeSetup("login");
    await agents.claudeSupport.settled();
    await settle();
    // Nightly 21's screenshot: ready, old 401 still there, no waiting receipt.
    expect(asked).toHaveLength(0);
    expect(agents.chat(project)).toMatchObject({ auth_retry: "old-user" });
    const claimed = await Promise.all([agents.retryClaude(project, "old-user"), agents.retryClaude(project, "old-user")]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.prompt).toBe("Research this case");
    expect(asked[0]!.options.resume).toBe("old-session");
    expect(agents.withChat(project).entries.filter((item) => item.kind === "user")).toHaveLength(1);
    expect(agents.withChat(project).entries.find((item) => item.id === "old-error")).toMatchObject({ status: "done", text: "Claude sign-in restored. Continuing your message." });
    expect(agents.withChat(other).running).toBe(false);
    queries[0]!.push({ type: "result", subtype: "success", is_error: false });
    queries[0]!.end();
    await settle();
    expect(await agents.retryClaude(project, "old-user")).toBe(false);
    expect(asked).toHaveLength(1);
  } finally { agents.shutdown(); home.cleanup(); }
});

test("pre-update recovery continues around completed tools, and Stop remains cancelled after a restart", async () => {
  const home = fixtureHome("claude-old-message-stop");
  let { agents, asked } = agentsWith(home);
  const recovery = browserRecovery(agents);
  try {
    const project = home.store.create("Old login", { width: 1920, height: 1080, fps: 30 }).project.id;
    const stopped = home.store.create("Stopped login", { width: 1920, height: 1080, fps: 30 }).project.id;
    oldAuthChat(home, project, true);
    oldAuthChat(home, stopped);
    recovery.finishLogin();
    agents.claudeSetup("login");
    await agents.claudeSupport.settled();
    await agents.stop(stopped);
    expect(await agents.retryClaude(project, "old-user")).toBe(true);
    expect(asked[0]!.prompt).toContain("check what is already done");
    expect(asked[0]!.prompt).toContain("Research this case");
    agents.shutdown();
    ({ agents, asked } = agentsWith(home));
    expect(agents.chat(stopped)).toMatchObject({ auth_retry: null });
    expect(await agents.retryClaude(stopped, "old-user")).toBe(false);
    expect(asked).toHaveLength(0);
  } finally { agents.shutdown(); home.cleanup(); }
});

test("verification must follow the failure, and unrelated errors are never adopted", async () => {
  const home = fixtureHome("claude-old-message-guard");
  const { agents, asked } = agentsWith(home);
  const recovery = browserRecovery(agents);
  try {
    const project = home.store.create("Old login", { width: 1920, height: 1080, fps: 30 }).project.id;
    const other = home.store.create("Other error", { width: 1920, height: 1080, fps: 30 }).project.id;
    oldAuthChat(home, project);
    oldAuthChat(home, other, false, "API Error: 529 overloaded");
    recovery.finishLogin();
    agents.claudeSetup("login");
    await agents.claudeSupport.settled();
    agents.withChat(project).entries.at(-1)!.updated = Number.MAX_SAFE_INTEGER;
    expect(await agents.retryClaude(project, "old-user")).toBe(false);
    expect(await agents.retryClaude(other, "old-user")).toBe(false);
    expect(asked).toHaveLength(0);
  } finally { agents.shutdown(); home.cleanup(); }
});

test("a turn whose Edit tools didn't connect starts again by itself, never asking for a restart (card 1, Oct 28)", async () => {
  const { home, project, agents, queries } = claudeProject("claude-tools-missing");
  const sleep = timing.sleep;
  timing.sleep = async () => {};
  try {
    await agents.send(project, "start the editing workflow", null, null);
    queries[0]!.push({ type: "system", subtype: "init", session_id: "session-1", mcp_servers: [{ name: "edit", status: "failed" }] });
    await settle();
    // Stopped and started again, the same message, before the agent says a word.
    expect(queries[0]!.closed()).toBe(true);
    expect(queries.length).toBe(2);
    queries[1]!.push({ type: "system", subtype: "init", session_id: "session-1", mcp_servers: [{ name: "edit", status: "connected" }] });
    await settle();
    expect(queries.length).toBe(2);
    expect(agents.withChat(project).running).toBe(true);
    expect(agents.withChat(project).entries.some((entry) => entry.kind === "error")).toBe(false);
    expect(editToolsFailed({ type: "system", subtype: "init", mcp_servers: [{ name: "edit", status: "pending" }] })).toBe(false);
  } finally {
    timing.sleep = sleep;
    agents.shutdown();
    home.cleanup();
  }
});

test("a resumed session is told once what changed in the tools; a fresh one isn't", async () => {
  const home = fixtureHome("claude-tools");
  try {
    const project = home.store.create("Tools test", { width: 1920, height: 1080, fps: 30 }).project.id;
    const { agents, asked, queries } = agentsWith(home);
    const finish = async (index: number, session: string) => {
      const q = queries[index]!;
      q.push({ type: "system", subtype: "init", session_id: session });
      q.push({ type: "result", subtype: "success", is_error: false, usage: {} });
      q.end();
      await settle();
    };
    // A fresh session: no note, and the build's tools are kept with the chat.
    await agents.send(project, "Look at the intro", null, null);
    expect(asked[0]!.prompt).toBe("Look at the intro");
    await finish(0, "session-1");
    const now = toolChanges.current();
    expect(agents.withChat(project).tools?.hash).toBe(now.hash);
    // Saved and read back with the chat.
    const saved = JSON.parse(fs.readFileSync(home.store.chatPath(project), "utf8")) as { tools?: { hash?: string } };
    expect(saved.tools?.hash).toBe(now.hash);
    // The session last saw an older build: look_at_media without pick, no wait or listen.
    const older = structuredClone(now.tools);
    older.look_at_media = older.look_at_media!.filter((arg) => arg !== "pick");
    delete older.wait;
    delete older.listen;
    agents.withChat(project).tools = toolChanges.schemaOf(older, now.skills.filter((skill) => skill !== "walkthrough"));
    await agents.send(project, "Find a shot of the house", null, null);
    expect(asked[1]!.options.resume).toBe("session-1");
    expect(asked[1]!.prompt).toBe(
      "(Edit updated since this chat last looked at its tools: look_at_media gained pick; new tools listen, wait; new skill walkthrough. Use what's new where it fits; the tools' current descriptions say how.)\n\nFind a shot of the house",
    );
    await finish(1, "session-1");
    // Told once: the next turn on the same build carries no note.
    await agents.send(project, "And the outro", null, null);
    expect(asked[2]!.prompt).toBe("And the outro");
    expect(toolChanges.changes(now, now)).toBe("");
  } finally {
    home.cleanup();
  }
});

test("files attached to a message: pictures go to Claude as pictures, the rest named, and the chat keeps them", async () => {
  const home = fixtureHome("claude-attached");
  try {
    const project = home.store.create("Attached test", { width: 1920, height: 1080, fps: 30 }).project.id;
    // A real picture for sips to scale (1×1 PNG).
    const picture = `${home.dir}/shot.png`;
    fs.writeFileSync(picture, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    await home.store.update(project, "test", (edited) => {
      edited.media.push(media({ id: "m1", name: "shot.png", path: picture, kind: "image", duration: 5 }));
    });
    const { agents, asked } = agentsWith(home);

    await agents.send(project, "what do you see here?", null, null, "", [
      { name: "shot.png", kind: "image", media: "m1" },
      { name: "brief.pdf", kind: "file", file: "brief.pdf" },
    ]);
    const prompt = asked[0]!.prompt;
    expect(typeof prompt).not.toBe("string");
    const messages: claude.UserMessage[] = [];
    for await (const message of prompt as AsyncIterable<claude.UserMessage>) messages.push(message);
    const content = messages[0]!.message.content as { type: string; text?: string; source?: { data: string; media_type: string } }[];
    expect(content[0]!.type).toBe("image");
    expect(content[0]!.source!.media_type).toBe("image/jpeg");
    expect(Buffer.from(content[0]!.source!.data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const words = content[1]!.text!;
    expect(words).toStartWith("what do you see here?");
    expect(words).toContain('"shot.png": image media m1, the picture above');
    expect(words).toContain('"brief.pdf": a file (read_upload name "brief.pdf")');

    // The chat shows the message as it was written, with its files; kept across a restart.
    const user = agents.withChat(project).entries.find((item) => item.kind === "user")!;
    expect(user.text).toBe("what do you see here?");
    expect(user.attachments).toEqual([
      { name: "shot.png", kind: "image", media: "m1" },
      { name: "brief.pdf", kind: "file", file: "brief.pdf" },
    ]);
    const saved = JSON.parse(JSON.stringify(agents.chat(project))) as { entries: { attachments?: unknown }[] };
    expect(saved.entries[0]!.attachments).toEqual(user.attachments);
  } finally {
    home.cleanup();
  }
});

test("a whole edit done, a fresh-eyes final pass runs as a sub-agent: a card in the main chat that opens its own chat", async () => {
  // The user, Nov 1: "launch it as a sub agent, that just has this message… click into the sub agent to view it and go back".
  const home = fixtureHome("claude-fresh-eyes");
  const sleep = timing.sleep;
  const later = timing.later;
  timing.sleep = async () => {};
  timing.later = (_ms, work) => void Promise.resolve().then(work);
  // The person is on Home, Edit in front: told by a toast once the whole edit, fresh eyes and all, is done.
  const heard: { how: string; notice: notices.Notice }[] = [];
  const viewer = notices.connect((text) => heard.push(JSON.parse(text) as (typeof heard)[number]));
  notices.heard(viewer, JSON.stringify({ type: "attention", focused: true, path: "/" }));
  try {
    const project = home.store.create("Fresh eyes", { width: 1920, height: 1080, fps: 30 }).project.id;
    const { agents, asked, queries } = agentsWith(home);
    await agents.send(project, "Start the edit", null, null);
    const q = queries[0]!;
    q.push({ type: "system", subtype: "init", session_id: "session-main" });
    q.push({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "toolu_skill", name: "mcp__edit__skill", input: { name: "edit-workflow" } }] } });
    q.push({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "toolu_skill", content: [{ type: "text", text: "ok" }] }] } });
    q.push({ type: "result", subtype: "success", is_error: false, usage: {} });
    q.end();
    for (let tries = 0; queries.length < 2 && tries < 100; tries++) await settle();
    const main = agents.chat(project) as { entries: { kind: string; text: string; status?: string; detail?: string }[] };
    const card = main.entries.find((item) => item.kind === "subagent")!;
    expect(card).toMatchObject({ text: "Fresh-eyes final pass", status: "running", detail: `${project}~review` });
    // Its own turn, with just the message, in its own chat and conversation.
    expect(String(asked[1]!.prompt)).toContain("with fresh eyes");
    expect(asked[1]!.options.resume).toBeUndefined();
    const sub = agents.chat(`${project}~review`) as { entries: { kind: string }[]; running: boolean };
    expect(sub.entries.map((item) => item.kind)).toEqual(["user"]);
    expect(sub.running).toBe(true);
    // The main turn's end isn't the edit's: nothing said while the pass runs.
    expect(heard).toEqual([]);
    const review = queries[1]!;
    review.push({ type: "result", subtype: "success", is_error: false, usage: {} });
    review.end();
    await settle();
    const after = agents.chat(project) as { entries: { kind: string; status?: string }[] };
    expect(after.entries.find((item) => item.kind === "subagent")!.status).toBe("done");
    expect(agents.runningProjects()).toEqual([]);
    expect(heard).toEqual([{ type: "notice", how: "toast", notice: { key: expect.any(String), title: "The edit is ready", body: "Fresh eyes", path: `/p/${project}` } }] as never);
  } finally {
    timing.sleep = sleep;
    timing.later = later;
    notices.resetForTests();
    home.cleanup();
  }
});

test("opus builds the edit; once it's built, a revision is on the model menu's pick (Opus until picked), through a new chat (Sphe, Nov 7)", async () => {
  const { home, project, agents, asked, queries } = claudeProject("claude-revision-model");
  try {
    await agents.send(project, "Start the edit", null, null);
    expect(asked[0]!.options.model).toBe("opus");
    expect(agents.chat(project)).toMatchObject({ model_name: "Opus 5.5" });
    // The turn did the whole edit but left flags: Edit's follow-up to it is still the build, on Opus.
    const chat = agents.withChat(project);
    const before = agentHooks.unfinished;
    const freshEyes = agentHooks.freshEyes;
    agentHooks.unfinished = () => ({ note: "(Edit, automatically) The edit left 3 flags.", count: 3 });
    agentHooks.freshEyes = false;
    try {
      chat.entries.push({ id: "t1", kind: "tool", tool: "skill", text: "edit-workflow", status: "done", at: 0, updated: 0 });
      queries[0]!.push({ type: "result", subtype: "success", is_error: false, usage: {} });
      queries[0]!.end();
      await Bun.sleep(1100);
      await settle();
      expect(asked[1]!.prompt).toBe("(Edit, automatically) The edit left 3 flags.");
      expect(asked[1]!.options.model).toBe("opus");
      expect(chat.built).toBeNull();
      // Nothing left after it: the edit is built, kept in the chat's file.
      agentHooks.unfinished = () => null;
      queries[1]!.push({ type: "result", subtype: "success", is_error: false, usage: {} });
      queries[1]!.end();
      await settle();
    } finally {
      agentHooks.unfinished = before;
      agentHooks.freshEyes = freshEyes;
    }
    expect(chat.built).not.toBeNull();
    expect(JSON.parse(fs.readFileSync(home.store.chatPath(project), "utf8")).built).toBe(chat.built);
    expect(agents.chat(project)).toMatchObject({ model_name: "Opus 5.5", revising: true, effort: null });
    expect(agents.turnModel(project, "Make the intro shorter")).toBe("claude-opus-5-5");
    // Sonnet picked in the menu (kept in the home): the revisions are Sonnet's, at the picked level.
    modelChoice.save({ revision: "claude-sonnet-5-5", effort: "high" });
    expect(JSON.parse(fs.readFileSync(`${home.home}/models.json`, "utf8"))).toEqual({ revision: "claude-sonnet-5-5", effort: "high", hq_model: "claude-fable-5-2", hq_effort: "high" });
    expect(agents.chat(project)).toMatchObject({ model_name: "Sonnet 5.5" });
    // A new chat on the built edit still revises it.
    agents.reset(project);
    expect(agents.withChat(project).entries).toEqual([]);
    expect(agents.turnModel(project, "Make the intro shorter")).toBe("claude-sonnet-5-5");
    await agents.send(project, "Make the intro shorter", null, null);
    expect(asked.at(-1)!.options.model).toBe("claude-sonnet-5-5");
    expect(asked.at(-1)!.options.effort).toBe("high");
    // Asking for it again from the start is a build.
    expect(agents.turnModel(project, "Redo the whole edit from the top")).toBe("opus");
    expect(agents.turnModel(project, "start over on this edit")).toBe("opus");
    // The fresh-eyes pass is a revision.
    expect(agents.turnModel(`${project}~review`)).toBe("claude-sonnet-5-5");
  } finally {
    modelChoice.save({});
    home.cleanup();
  }
});

test("a turn that ends listing what it didn't get to is sent back to it, only while each pass leaves fewer (Nov 6)", async () => {
  const { home, project, agents, asked, queries } = claudeProject("claude-notes-left");
  try {
    await agents.send(project, "The team's notes: 1:21 profile, 1:58 words, 2:58 white text", null, null);
    const chat = agents.withChat(project);
    const ends = (n: number, text: string) => {
      chat.entries.push({ id: `a${n}`, kind: "assistant", text, at: 0, updated: 0 });
      queries[n]!.push({ type: "result", subtype: "success", is_error: false, usage: {} });
      queries[n]!.end();
    };
    ends(0, "**Done**\n- 1:21 profile\n\n**Still open:**\n- 1:58 words: not done\n- 2:58 white text: not done");
    await settle();
    // In the second before the follow-up starts, the turn still counts as running: no restart lands in the gap.
    expect(agents.withChat(project).running).toBe(false);
    expect(agents.hasRunningTurns()).toBe(true);
    await askedCount(asked, 2);
    expect(asked[1]!.prompt).toStartWith("(Edit, automatically) Your turn ended with 2 of what was asked still open:\n- 1:58 words: not done\n- 2:58 white text");
    // One fewer: asked again.
    ends(1, "**Still open:**\n- 2:58 white text: not done");
    await askedCount(asked, 3);
    expect(asked[2]!.prompt).toStartWith("(Edit, automatically) Your turn ended with 1 of");
    // No fewer: left to the user (nothing arrives: waited well past the follow-up's second).
    ends(2, "**Still open:**\n- 2:58 white text: not done");
    await Bun.sleep(2000);
    await settle();
    expect(asked.length).toBe(3);
  } finally {
    home.cleanup();
  }
});

test("an edit shared for review is built, as is one a kept chat shows was done", () => {
  const { home, project, agents } = claudeProject("claude-built-elsewhere");
  try {
    expect(agents.isBuilt(project)).toBe(false);
    fs.writeFileSync(`${home.home}/reviews.json`, JSON.stringify({ cursor: 0, shared: { [project]: { reviewId: "r", url: "u", versions: [] } }, notes: {} }));
    expect(agents.isBuilt(project)).toBe(true);
    fs.rmSync(`${home.home}/reviews.json`);
    // A chat from before the mark: a turn before the latest message did the whole edit.
    agents.withChat(project).entries.push(
      { id: "u1", kind: "user", text: "Start the edit", at: 0, updated: 0 },
      { id: "t1", kind: "tool", tool: "skill", text: "edit-workflow", at: 0, updated: 0 },
      { id: "u2", kind: "user", text: "Shorter intro", at: 0, updated: 0 },
    );
    expect(agents.isBuilt(project)).toBe(true);
  } finally {
    home.cleanup();
  }
});
