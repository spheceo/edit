// `edit script-eval`: runs one Edit Script in its own process (the server's
// stays safe from a loop that never ends: it's killed after its time). Reads
// {code, library, context, run} on stdin, writes {ops, notes, error?} on
// stdout. The script and the library are real .ts files imported by Bun, so
// an error's line is the script's own line.

import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { runtime, type Op, type ScriptContext } from "./script_runtime.ts";

interface Input { code: string; library: { name: string; code: string }[]; context: ScriptContext; run: string }

/** The script's line and column in an error's stack, from the file it was imported as. */
function where(error: unknown, file: string): string {
  const stack = error instanceof Error ? error.stack ?? "" : "";
  // "at script.ts:2:11", or "at script.ts:2" for a frame calling into the API.
  const found = new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:(\\d+)(?::(\\d+))?`, "u").exec(stack);
  return found ? `line ${found[1]}${found[2] ? `:${found[2]}` : ""}` : "";
}

export async function evalScript(input: Input): Promise<{ ops: Op[]; notes: string[]; lines: (number | null)[]; error?: string }> {
  // Its real path: a stack names the file so, not by the /var → /private/var link.
  const dir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "edit-script-")));
  const script = join(dir, "script.ts");
  const lineOf = () => { const at = /line (\d+)/u.exec(where(new Error(), script)); return at ? Number(at[1]) : null; };
  const { api, ops, notes, lines } = runtime(input.context, input.run, lineOf);
  const scope = globalThis as Record<string, unknown>;
  for (const [name, value] of Object.entries(api)) scope[name] = value;
  try {
    for (const lib of input.library) {
      const file = join(dir, `lib-${lib.name}.ts`);
      fs.writeFileSync(file, lib.code);
      try {
        const exported = (await import(file)) as Record<string, unknown>;
        for (const [name, value] of Object.entries(exported)) scope[name] = value;
      } catch (error) {
        return { ops: [], notes, lines: [], error: `library ${lib.name} ${where(error, file)}: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    const file = script;
    fs.writeFileSync(file, input.code);
    try {
      await import(file);
    } catch (error) {
      const at = where(error, file);
      return { ops: [...ops], notes, lines, error: `${at ? `${at}: ` : ""}${error instanceof Error ? error.message : String(error)}` };
    }
    return { ops: [...ops], notes, lines };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The `script-eval` command: stdin to stdout. */
export async function main(): Promise<void> {
  const input = JSON.parse(await new Response(Bun.stdin.stream()).text()) as Input;
  const out = await evalScript(input);
  process.stdout.write(JSON.stringify(out));
}
