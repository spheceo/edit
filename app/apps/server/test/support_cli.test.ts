import { expect, test } from "bun:test";
import { HELP, redactSupport, runSupport, supportUrl } from "../src/support_cli.ts";

const endpoint = "https://jj.tail123456.ts.net";
const json = (value: unknown, status = 200) => Response.json(value, { status });

test("support only accepts an explicit credential-free standard Tailscale HTTPS endpoint", () => {
  expect(supportUrl(`${endpoint}/`)).toBe(endpoint);
  for (const url of ["http://jj.tail123456.ts.net", "https://jj.tail123456.ts.net.evil.test", "https://evil.test", "http://127.0.0.1:7700", `${endpoint}/api`, `${endpoint}?token=x`, `${endpoint}#token`, "https://name:password@jj.tail123456.ts.net", `${endpoint}:8443`]) {
    expect(() => supportUrl(url)).toThrow();
  }
});

test("support help, invalid commands and incomplete prompts never contact a machine", async () => {
  let calls = 0;
  const options = { fetch: async () => { calls++; return json({}); }, read: () => "" };
  expect(await runSupport([], options)).toBe(HELP);
  await expect(runSupport(["update", "--url", endpoint], options)).rejects.toThrow("unknown support");
  await expect(runSupport(["projects"], options)).rejects.toThrow("--url");
  await expect(runSupport(["ask", "../p1", "--url", endpoint, "--message-file", "x"], options)).rejects.toThrow("project id");
  await expect(runSupport(["ask", "p1", "--url", endpoint, "--message-file", "x"], options)).rejects.toThrow("nonempty");
  await expect(runSupport(["projects", "--url", endpoint, "--message-file", "x"], options)).rejects.toThrow("only accepted");
  expect(calls).toBe(0);
});

test("an explicit repair goes once to a visible project's existing agent, never opens or resets its project", async () => {
  const calls: { path: string; method?: string; payload?: unknown }[] = [];
  const output = await runSupport(["ask", "p1", "--url", endpoint, "--message-file", "repair.txt"], {
    read: () => "Investigate the second intro's lag and fix its cause.",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, method: init?.method, ...(init?.body ? { payload: JSON.parse(String(init.body)) } : {}) });
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return path === "/api/projects" ? json({ projects: [{ id: "p1" }] }) : json({ ok: true });
    },
  });
  expect(JSON.parse(output)).toEqual({ ok: true });
  expect(calls).toEqual([
    { path: "/api/projects", method: "GET" },
    { path: "/api/projects/p1/agent", method: "POST", payload: { text: "Investigate the second intro's lag and fix its cause." } },
  ]);
});

test("hidden projects and lock refusals stop support requests, with no automatic retry", async () => {
  let calls = 0;
  await expect(runSupport(["stop", "p-hidden", "--url", endpoint], { fetch: async () => { calls++; return json({ projects: [{ id: "p1" }] }); } })).rejects.toThrow("visible project list");
  expect(calls).toBe(1);
  calls = 0;
  await expect(runSupport(["ask", "p1", "--url", endpoint, "--message-file", "x"], { read: () => "Fix the intro.", fetch: async (input) => {
    calls++;
    return new URL(String(input)).pathname === "/api/projects" ? json({ projects: [{ id: "p1" }] }) : json({ error: "This project is being edited on another machine." }, 423);
  } })).rejects.toThrow("another machine");
  expect(calls).toBe(2);
});

test("a lost command acknowledgement is ambiguous and never sends the command twice", async () => {
  let posts = 0;
  await expect(runSupport(["stop", "p1", "--url", endpoint], { fetch: async (_input, init) => {
    if (init?.method === "POST") { posts++; throw new Error("reset"); }
    return json({ projects: [{ id: "p1" }] });
  } })).rejects.toThrow("may have arrived");
  expect(posts).toBe(1);
});

test("diagnostic output and HTTP errors redact nested credentials, raw tokens and signed URLs", async () => {
  const secret = "sk-ant-api03-abcdefghijk123456";
  const report = { machine: "JJ", nested: { access_token: "hidden", cookie: "session=secret", apiKey: secret },
    lines: [{ message: `Authorization: Bearer abc123; password=badsecret signed https://r2.test/x?X-Amz-Signature=secret ${secret}` }] };
  const output = await runSupport(["diagnostics", "--url", endpoint], { fetch: async () => json(report) });
  expect(output).toContain("JJ");
  for (const hidden of ["hidden", "abc123", "badsecret", "X-Amz-Signature", secret, "session=secret"]) expect(output).not.toContain(hidden);
  const jwt = `eyJ${"a".repeat(20)}.abcdefghijk.abcdefghijk`;
  expect(String(redactSupport(jwt))).toBe("[redacted]");
  expect(String(redactSupport('Authorization: Basic base64secret\nCookie: session=secret; second=other\n{"api_key":"old-json-secret"}'))).not.toMatch(/base64secret|session=secret|second=other|old-json-secret/u);
  await expect(runSupport(["projects", "--url", endpoint], { fetch: async () => json({ error: `Unauthorized Bearer ${secret}` }, 403) })).rejects.toThrow("[redacted]");
});

test("status and project chat use bounded read-only APIs; a non-Edit proxy says so", async () => {
  const paths: string[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    paths.push(new URL(String(input)).pathname);
    expect(init?.method).toBe("GET");
    return json({ ready: true, projects: [{ id: "p1" }] });
  };
  await runSupport(["status", "--url", endpoint], { fetch: fetcher });
  await runSupport(["chat", "p1", "--url", endpoint], { fetch: fetcher });
  expect(paths).toEqual(["/api/health", "/api/agent", "/api/projects", "/api/projects/p1/agent"]);
  await expect(runSupport(["projects", "--url", endpoint], { fetch: async () => new Response("<html>Login</html>") })).rejects.toThrow("did not return Edit JSON");
});
