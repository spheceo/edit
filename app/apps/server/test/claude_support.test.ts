import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as claude from "../src/claude.ts";
import { ClaudeSupport, loginUrl, safeDetail, type SupportRuntime } from "../src/claude_support.ts";
import { scratch } from "./helpers/home.ts";
import { fixtureHome } from "./helpers/home.ts";
import { Agents } from "../src/agent.ts";
import { buildRouter } from "../src/routes.ts";
import { respond } from "../src/http/server.ts";

const ok = { code: 0, out: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK" }) };
const refused = { code: 1, out: JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate. API Error: 401 OAuth access token is invalid" }) };
function harness() {
  const home = scratch("claude-support");
  const calls: string[][] = [];
  let authenticated = true;
  let ready = 0;
  const runtime: SupportRuntime = {
    find: async () => "/test/claude",
    async run(command) {
      calls.push(command);
      if (command[1] === "--version") return { code: 0, out: "2.1.310" };
      if (command[1] === "auth" && command[2] === "status") return { code: 0, out: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) };
      if (command[1] === "auth" && command[2] === "login") { authenticated = true; return { code: 0, out: "Login successful" }; }
      if (command[1] === "-p") return authenticated ? ok : refused;
      return { code: 0, out: "Healthy" };
    },
  };
  const support = new ClaudeSupport(home.dir, () => { ready++; }, undefined, runtime);
  return { ...home, support, runtime, calls, ready: () => ready, refuse: () => { authenticated = false; } };
}
afterEach(() => claude.useStoredLogin(false));

test("nightly maintenance updates and probes once per build, including across restarts", async () => {
  const h = harness();
  try {
    h.support.afterNightly("nightly-21");
    h.support.afterNightly("nightly-21");
    await h.support.settled();
    expect(h.calls.filter((call) => call[1] === "update")).toHaveLength(1);
    expect(h.support.status().phase).toBe("ready");
    const restarted = new ClaudeSupport(h.dir, () => {}, undefined, h.runtime);
    restarted.afterNightly("nightly-21");
    await restarted.settled();
    expect(h.calls.filter((call) => call[1] === "update")).toHaveLength(1);
    restarted.afterNightly("nightly-22");
    await restarted.settled();
    expect(h.calls.filter((call) => call[1] === "update")).toHaveLength(2);
    expect(h.calls.find((call) => call[1] === "-p")).toContain("--no-session-persistence");
  } finally { h.cleanup(); }
});

test("a saved login can be rejected: diagnosis identifies it, login verifies a request before resuming", async () => {
  const h = harness();
  try {
    h.refuse();
    h.support.start("diagnose");
    await h.support.settled();
    expect(h.support.status().phase).toBe("needs_login");
    expect(h.ready()).toBe(0);
    expect(h.calls.some((call) => call[2] === "login")).toBe(false);
    h.support.start("login");
    h.support.start("login");
    await h.support.settled();
    await Bun.sleep(0);
    expect(h.calls.filter((call) => call[2] === "login")).toHaveLength(1);
    expect(h.support.status().phase).toBe("ready");
    expect(h.ready()).toBe(1);
  } finally { h.cleanup(); }
});

test("network and capacity failures are diagnosed without opening a sign-in loop", async () => {
  const h = harness();
  const original = h.runtime.run;
  h.runtime.run = async (...args) => args[0][1] === "-p" ? { code: 1, out: "API Error: 529 overloaded" } : original(...args);
  try {
    h.support.start("login");
    await h.support.settled();
    expect(h.support.status().phase).toBe("error");
    expect(h.support.status().error).toContain("529");
    expect(h.calls.some((call) => call[2] === "login")).toBe(false);
    expect(h.ready()).toBe(0);
  } finally { h.cleanup(); }
});

test("a working terminal request does not hide a rejected SDK connection", async () => {
  const h = harness();
  let sdkRequests = 0;
  h.runtime.sdkProbe = async () => { sdkRequests++; return refused; };
  try {
    h.support.start("diagnose");
    await h.support.settled();
    expect(h.support.status().phase).toBe("needs_login");
    expect(h.support.status().checks.find((check) => check.name === "Claude request")?.ok).toBe(true);
    expect(h.support.status().checks.find((check) => check.name === "Edit connection")?.ok).toBe(false);
    expect(sdkRequests).toBe(1);
    expect(h.ready()).toBe(0);
  } finally { h.cleanup(); }
});

test("the setup API observes without running commands and starts one real diagnostic through the agent service", async () => {
  const h = harness();
  const home = fixtureHome("claude-support-api");
  const agents = home.app.agents as Agents;
  agents.claudeSupport.runtime = h.runtime;
  const router = buildRouter();
  const request = (method: string, action?: string) => respond(home.app, router, new Request("http://localhost:7700/api/agent/claude", {
    method, headers: { host: "localhost:7700", "content-type": "application/json" },
    ...(action ? { body: JSON.stringify({ action }) } : {}),
  }), null);
  try {
    expect((await request("GET"))?.status).toBe(200);
    expect(h.calls).toHaveLength(0);
    expect((await request("POST", "diagnose"))?.status).toBe(200);
    await agents.claudeSupport.settled();
    const response = await request("GET");
    expect(await response?.json()).toMatchObject({ phase: "ready" });
    expect((await request("POST", "arbitrary-command"))?.status).toBe(400);
    expect(h.calls.filter((call) => call[1] === "-p")).toHaveLength(1);
  } finally { agents.shutdown(); home.cleanup(); h.cleanup(); }
});

test("cancel aborts the login and never resumes; OAuth URLs stay out of saved diagnostics", async () => {
  const h = harness();
  h.refuse();
  const original = h.runtime.run;
  let opened!: () => void;
  const opening = new Promise<void>((resolve) => { opened = resolve; });
  h.runtime.run = async (...args) => {
    const [command, , signal, , output] = args;
    if (command[2] !== "login") return original(...args);
    output?.("Open https://claude.ai/oauth/authorize?state=private-state&code_challenge=private-challenge");
    opened();
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  try {
    h.support.start("login");
    await opening;
    expect(h.support.status().url).toContain("private-state");
    expect(fs.readFileSync(`${h.dir}/agent/claude-support.json`, "utf8")).not.toContain("private-state");
    h.support.cancel();
    await h.support.settled();
    expect(h.support.status().phase).toBe("idle");
    expect(h.ready()).toBe(0);
  } finally { h.cleanup(); }
});

test("a stale inherited token is replaced only after a real request proves the saved login works", async () => {
  const h = harness();
  const before = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-stale-token";
  const original = h.runtime.run;
  h.runtime.run = async (...args) => args[0][1] === "-p" ? (claude.environment().CLAUDE_CODE_OAUTH_TOKEN ? refused : ok) : original(...args);
  try {
    h.support.start("login");
    await h.support.settled();
    expect(h.support.status().phase).toBe("ready");
    expect(claude.environment().CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("test-stale-token");
    expect(h.calls.some((call) => call[2] === "login")).toBe(false);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = before;
    h.cleanup();
  }
});

test("sign-in links are limited to Claude authorization pages and reports remove tokens and URLs", () => {
  expect(loginUrl("https://evil.example/oauth/authorize")).toBeNull();
  expect(loginUrl("https://claude.ai.evil.example/oauth/authorize")).toBeNull();
  expect(loginUrl("https://claude.ai/oauth/authorize?state=abc")).toBe("https://claude.ai/oauth/authorize?state=abc");
  expect(safeDetail("sk-ant-test-secret Bearer secret https://claude.ai/oauth?code=private")).toBe("<redacted> Bearer <redacted> <url>");
});
