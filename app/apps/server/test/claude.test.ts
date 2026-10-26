// The agent on Claude Code: its models read into the panel's, and a turn's
// messages (shaped as a real Opus 5.5 turn sent them) mapped onto the chat,
// with a stand-in query (no Claude Code is started).

import { expect, test } from "bun:test";

import * as fs from "node:fs";

import { Agents, EXITED, STALL_MS, timing } from "../src/agent.ts";
import * as claude from "../src/claude.ts";
import { fixtureHome } from "./helpers/home.ts";

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

function agentsWith(home: ReturnType<typeof fixtureHome>, hangs = false) {
  const agents = new Agents(home.store, home.home, 7700);
  const asked: { prompt: string; options: claude.Options }[] = [];
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

test("claude is the default provider and a turn streams text and edit tools onto the chat", async () => {
  const home = fixtureHome("claude");
  try {
    const project = home.store.create("Claude test", { width: 1920, height: 1080, fps: 30 }).project.id;
    const { agents, asked, queries } = agentsWith(home);
    expect(agents.provider()).toBe("claude");

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

test("a codex chat starts a new claude conversation, and stopping interrupts the query", async () => {
  const home = fixtureHome("claude-stop");
  try {
    const project = home.store.create("Claude stop", { width: 1920, height: 1080, fps: 30 }).project.id;
    const { agents, asked, queries } = agentsWith(home);
    const before = agents.withChat(project);
    before.provider = "codex";
    before.thread = "codex-thread";
    before.model = "gpt-6";

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

test("codex going away leaves a claude turn running", async () => {
  const { home, project, agents, queries } = claudeProject("claude-codex-exit");
  try {
    await agents.send(project, "Go", null, null);
    agents.onMessage({ method: EXITED });
    expect(agents.withChat(project).running).toBe(true);
    expect(queries[0]!.closed()).toBe(false);
  } finally {
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
  try {
    await agents.send(project, "Start the editing workflow", null, null);
    queries[0]!.push({ type: "system", subtype: "init", session_id: "session-1" });
    await settle();
    agents.shutdown();
    await settle();
    const noted = `${home.home}/agent/running-turns.json`;
    expect(fs.existsSync(noted)).toBe(true);

    // The new process: the chat read back from disk.
    const after = agentsWith(home);
    after.agents.resumeInterrupted();
    await settle();
    // Noted again: the turn carrying on is running.
    expect(JSON.parse(fs.readFileSync(noted, "utf8")).projects).toEqual([project]);
    expect(after.asked.length).toBe(1);
    expect(after.asked[0]!.options.resume).toBe("session-1");
    expect(after.asked[0]!.prompt).toStartWith("(Edit, automatically) Edit restarted while you were working");
    expect(after.agents.withChat(project).running).toBe(true);
    after.agents.shutdown();
    await settle();

    // A crash (no shutdown) leaves the note as the turn started it.
    const crashed = agentsWith(home);
    await crashed.agents.send(project, "Go on", null, null);
    expect(JSON.parse(fs.readFileSync(noted, "utf8")).projects).toEqual([project]);
    const back = agentsWith(home);
    back.agents.resumeInterrupted();
    await settle();
    expect(back.asked[0]!.prompt).toStartWith("(Edit, automatically) Edit restarted");
    back.agents.shutdown();
    crashed.agents.shutdown();
    await settle();

    // A turn that ended leaves nothing noted.
    const done = agentsWith(home);
    await done.agents.send(project, "One more", null, null);
    done.queries[0]!.push({ type: "result", subtype: "success", is_error: false, usage: {} });
    done.queries[0]!.end();
    await settle();
    expect(done.agents.withChat(project).running).toBe(false);
    expect(fs.existsSync(noted)).toBe(false);

    // Closed hours ago: nothing starts by itself.
    fs.writeFileSync(noted, JSON.stringify({ at: Date.now() - 3 * 3_600_000, projects: [project] }));
    const later = agentsWith(home);
    later.agents.resumeInterrupted();
    await settle();
    expect(later.asked.length).toBe(0);
    expect(fs.existsSync(noted)).toBe(false);
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
