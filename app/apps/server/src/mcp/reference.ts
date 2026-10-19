// Every tool as one line: its call, its arguments (required ones bare,
// optional ones with ?) and its description's first sentence. In Codex's code
// mode the tool declarations aren't in the prompt, and an agent that had to
// look each one up spent a dozen round trips a run doing it.

import { compareKeys } from "../stable.ts";
import { TOOLS, type Tool } from "./registry.ts";

export function toolReference(tools: Tool[] = TOOLS): string {
  let out = "";
  for (const tool of tools) {
    const schema = tool.inputSchema ?? { properties: {}, required: [] };
    const required = Array.isArray(schema.required) ? schema.required.filter((name) => typeof name === "string") : [];
    const args: string[] = [];
    const properties = schema.properties ?? {};
    // serde_json's maps iterate in key order.
    for (const arg of Object.keys(properties).sort(compareKeys)) {
      if (arg === "project_id") continue;
      const spec = properties[arg] ?? {};
      let kind: string;
      if (typeof spec.type === "string") kind = spec.type;
      else if (Array.isArray(spec.type)) kind = spec.type.filter((entry) => typeof entry === "string").join("|");
      else kind = "any";
      if (Array.isArray(spec.enum) && spec.enum.length <= 8) {
        kind = spec.enum.filter((entry) => typeof entry === "string").join("|");
      }
      const optional = required.includes(arg) ? "" : "?";
      args.push(`${arg}${optional}: ${kind}`);
    }
    // Required arguments first (a stable sort, as Rust's sort_by_key).
    const ordered = [
      ...args.filter((arg) => !(arg.split(":")[0] ?? "").endsWith("?")),
      ...args.filter((arg) => (arg.split(":")[0] ?? "").endsWith("?")),
    ];
    out += `- ${tool.name}(${ordered.join(", ")}) — ${firstSentence(tool.description ?? "")}\n`;
  }
  return out;
}

/** Up to the first ". " that doesn't end "e.g" or "i.e" (the full stop kept); all of it without one. */
function firstSentence(description: string): string {
  let from = 0;
  for (;;) {
    const at = description.indexOf(". ", from);
    if (at < 0) return description;
    const before = description.slice(0, at);
    if (!before.endsWith("e.g") && !before.endsWith("i.e")) return description.slice(0, at + 1);
    from = at + 1;
  }
}
