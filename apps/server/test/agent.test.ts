// agent.rs's tests: the outgoing RPCs echoed to the test instead of Codex, on
// a fixture home (no Codex is started, no real project edited).

import { expect, test } from "bun:test";

import {
  Agents,
  busyModel,
  Codex,
  effortIn,
  EXITED,
  mcpServersIn,
  READY_FOR_MS,
  stillReady,
  summarizeArgs,
  tomlKey,
  withConfiguredEffort,
} from "../src/agent.ts";
import { fixtureHome } from "./helpers/home.ts";

test("a_ready_status_is_kept_for_a_while", () => {
  const found = 1000;
  const status = { ready: true, state: "ready" };
  const cached: [number, unknown] = [found, status];
  expect(stillReady(cached, found)).toEqual(status);
  expect(stillReady(cached, found + READY_FOR_MS - 1000)).toEqual(status);
  expect(stillReady(cached, found + READY_FOR_MS)).toBeNull();
  expect(stillReady(null, found)).toBeNull();
});

/** Echoes the outgoing RPCs without starting Codex or editing real projects. */
class Fixture {
  readonly agents: Agents;
  readonly codex: Codex;
  readonly project: string;
  private sent: Record<string, unknown>[] = [];
  private waiting: ((message: Record<string, unknown>) => void)[] = [];
  readonly cleanup: () => void;

  constructor() {
    const home = fixtureHome("agent");
    this.cleanup = home.cleanup;
    this.project = home.store.create("Agent test", { width: 1920, height: 1080, fps: 30 }).project.id;
    this.agents = new Agents(home.store, home.home, 0);
    this.codex = new Codex(
      {
        write: (line) => {
          const message = JSON.parse(line) as Record<string, unknown>;
          const waiter = this.waiting.shift();
          if (waiter !== undefined) waiter(message);
          else this.sent.push(message);
        },
        kill: () => {},
      },
      (message) => this.agents.onMessage(message),
    );
    this.agents.useCodex(this.codex);
    this.agents.withChat(this.project).thread = "test-thread";
    this.agents.threads.set("test-thread", this.project);
  }

  start(): Promise<void> {
    return this.agents.send(this.project, "Start the editing workflow. test notes", "test-model", "medium");
  }

  private next(): Promise<Record<string, unknown>> {
    const queued = this.sent.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no request in time")), 2000);
      this.waiting.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  /** The next request Codex is sent (a new conversation's thread/start is handed the test's thread). */
  async request(method: string): Promise<Record<string, unknown>> {
    for (;;) {
      const request = await this.next();
      if (request.method === "thread/start" && method !== "thread/start") {
        this.reply(request, { thread: { id: "test-thread" } });
        continue;
      }
      expect(request.method).toBe(method);
      return request;
    }
  }

  /** Nothing waiting to go out. */
  quiet(): boolean {
    return this.sent.length === 0;
  }

  reply(request: Record<string, unknown>, result: unknown): void {
    const id = request.id as number;
    const reply = this.codex.pending.get(id)!;
    this.codex.pending.delete(id);
    reply({ ok: result });
  }

  complete(): void {
    this.agents.onMessage({
      method: "turn/completed",
      params: { threadId: "test-thread", turn: { id: "test-turn", status: "completed" } },
    });
  }
}

test("a_turn_goes_out_with_its_model_and_ends_when_codex_says_so", async () => {
  const fixture = new Fixture();
  try {
    const started = fixture.start();
    const request = await fixture.request("turn/start");
    const params = request.params as Record<string, unknown>;
    expect(params.threadId).toBe("test-thread");
    expect(params.model).toBe("test-model");
    expect(params.effort).toBe("medium");
    // No await between: completion can arrive before the start reply is handled.
    fixture.reply(request, { turn: { id: "test-turn" } });
    fixture.complete();
    await started;
    expect(fixture.agents.withChat(fixture.project).running).toBe(false);
  } finally {
    fixture.cleanup();
  }
});

test("stop_interrupts_a_turn_whose_id_arrives_late", async () => {
  const fixture = new Fixture();
  try {
    const started = fixture.start();
    const request = await fixture.request("turn/start");
    await fixture.agents.stop(fixture.project);
    fixture.reply(request, { turn: { id: "late-turn" } });
    const interrupt = await fixture.request("turn/interrupt");
    expect((interrupt.params as Record<string, unknown>).turnId).toBe("late-turn");
    fixture.reply(interrupt, {});
    await expect(started).rejects.toThrow("Stopped.");
    expect(fixture.agents.withChat(fixture.project).running).toBe(false);
  } finally {
    fixture.cleanup();
  }
});

test("stop_during_initialization_sends_no_turn", async () => {
  const fixture = new Fixture();
  try {
    const release = await fixture.agents.holdCodex();
    const started = fixture.start();
    await Bun.sleep(0);
    expect(fixture.agents.withChat(fixture.project).running).toBe(true);
    await fixture.agents.stop(fixture.project);
    release();
    await expect(started).rejects.toThrow("Stopped.");
    expect(fixture.quiet()).toBe(true);
  } finally {
    fixture.cleanup();
  }
});

test("process_exit_ends_the_running_turn", async () => {
  const fixture = new Fixture();
  try {
    const started = fixture.start();
    const request = await fixture.request("turn/start");
    fixture.reply(request, { turn: { id: "test-turn" } });
    await started;
    fixture.agents.onMessage({ method: EXITED });
    const chat = fixture.agents.withChat(fixture.project);
    expect(chat.running).toBe(false);
    expect(chat.entries.at(-1)?.text).toBe("Codex stopped unexpectedly; send your message again.");
  } finally {
    fixture.cleanup();
  }
});

test("a one-off question gets the model's last message, in its own ephemeral thread", async () => {
  const fixture = new Fixture();
  try {
    const asked = fixture.agents.ask("gpt-test", "low", "Name the voices.", [{ type: "text", text: "hi" }], { type: "object" }, 2000);
    const start = await fixture.request("thread/start");
    expect((start.params as Record<string, unknown>).ephemeral).toBe(true);
    expect((start.params as Record<string, unknown>).developerInstructions).toBe("Name the voices.");
    fixture.reply(start, { thread: { id: "ask-thread" } });
    const turn = await fixture.request("turn/start");
    expect(turn.params).toEqual({
      threadId: "ask-thread",
      input: [{ type: "text", text: "hi" }],
      model: "gpt-test",
      effort: "low",
      approvalPolicy: "never",
      outputSchema: { type: "object" },
    });
    fixture.reply(turn, {});
    fixture.agents.onMessage({ method: "item/completed", params: { threadId: "ask-thread", item: { type: "agentMessage", text: '{"speakers":[]}' } } });
    fixture.agents.onMessage({ method: "turn/completed", params: { threadId: "ask-thread", turn: { status: "completed" } } });
    expect(await asked).toBe('{"speakers":[]}');
  } finally {
    fixture.cleanup();
  }
});

test("a chat's turn shows its tool calls, text and the end of the turn", async () => {
  const fixture = new Fixture();
  try {
    const started = fixture.start();
    const request = await fixture.request("turn/start");
    fixture.reply(request, { turn: { id: "test-turn" } });
    await started;
    const send = (method: string, params: Record<string, unknown>) =>
      fixture.agents.onMessage({ method, params: { threadId: "test-thread", ...params } });
    send("item/started", { item: { id: "t1", type: "mcpToolCall", tool: "get_edit_context", arguments: { section: "intro", project_id: "p" } } });
    send("item/started", { item: { id: "a1", type: "agentMessage", text: "" } });
    send("item/agentMessage/delta", { itemId: "a1", delta: "Done" });
    send("item/completed", { item: { id: "a1", type: "agentMessage", text: "Done." } });
    const chat = fixture.agents.chat(fixture.project) as { entries: { kind: string; text: string; status?: string; tool?: string }[]; running: boolean };
    expect(chat.entries.map((item) => [item.kind, item.text])).toEqual([
      ["user", "Start the editing workflow. test notes"],
      ["tool", "section: intro"],
      ["assistant", "Done."],
    ]);
    expect(chat.entries[1]!.status).toBe("running");
    fixture.complete();
    const after = fixture.agents.chat(fixture.project) as { entries: { status?: string }[]; running: boolean };
    expect(after.running).toBe(false);
    // A turn that ended mid-tool leaves it marked.
    expect(after.entries[1]!.status).toBe("stopped");
  } finally {
    fixture.cleanup();
  }
});

test("a request from Codex is refused: Edit allows only its own tools", () => {
  const written: string[] = [];
  const codex = new Codex({ write: (line) => written.push(line), kill: () => {} }, () => {});
  codex.receive('{"jsonrpc":"2.0","id":7,"method":"item/commandExecution/requestApproval","params":{}}');
  expect(JSON.parse(written[0]!)).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32601, message: "Edit only allows its own tools" } });
});

test("the user's Codex config: its MCP servers switched off by name, its effort the default", () => {
  expect(mcpServersIn('[mcp_servers.github]\nx = 1\n[mcp_servers.github.env]\n[mcp_servers."computer-use"]\n[mcp_servers.edit]\n')).toEqual([
    "computer-use",
    "github",
  ]);
  expect(tomlKey("computer-use")).toBe("computer-use");
  expect(tomlKey("a b")).toBe('"a b"');
  expect(effortIn('model = "x"\nmodel_reasoning_effort = "high"\n[profiles]\nmodel_reasoning_effort = "low"')).toBe("high");
  expect(effortIn("[profiles]\nmodel_reasoning_effort = \"low\"")).toBeNull();
  const model = { id: "m", name: "M", description: "", default_effort: "high", efforts: ["low", "high"], is_default: true };
  expect(withConfiguredEffort([model], "low")[0]!.default_effort).toBe("low");
  expect(withConfiguredEffort([{ ...model, efforts: ["medium", "high"] }], "low")[0]!.default_effort).toBe("medium");
});

test("tool arguments read as one short line; a busy model is tried again", () => {
  expect(summarizeArgs({ text: "Your title", start: 2, project_id: "p" })).toBe("start: 2 · text: Your title");
  expect(summarizeArgs("x")).toBe("");
  expect(summarizeArgs({ a: "x".repeat(200), b: "y".repeat(200) }).length).toBe(129);
  expect(summarizeArgs({ a: "x".repeat(200), b: "y".repeat(200), c: "z".repeat(10) })).toBe(`a: ${"x".repeat(60)} · b: ${"y".repeat(60)} · c: zzzzz…`);
  expect(busyModel("The model is at capacity")).toBe(true);
  expect(busyModel("Invalid request")).toBe(false);
});
