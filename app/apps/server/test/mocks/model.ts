// The tests' stand-in for Claude (ai_claude.standIn, set in setup.ts): a
// model question (an OpenAI-style chat request in a file) is posted to the
// mock server (`EDIT_TEST_MODEL_URL`, server.ts) and answered as it answers.
// Edit itself asks Claude through Claude Code; this is never its path.

import * as fs from "node:fs";

export async function post(body: string): Promise<unknown> {
  const base = (process.env.EDIT_TEST_MODEL_URL ?? "").trim().replace(/\/+$/u, "");
  if (base === "") throw new Error("no stand-in model is running (MockServer.useEnv)");
  let response: Response;
  try {
    response = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: fs.readFileSync(body) });
  } catch (error) {
    throw new Error(`couldn't reach the model: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  if (response.status !== 200) {
    const message = (value as { error?: { message?: unknown } } | null)?.error?.message;
    throw new Error(`the model answered ${response.status}: ${typeof message === "string" ? message : "request failed"}`);
  }
  return value;
}
