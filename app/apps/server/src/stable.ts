// JSON with sorted keys, at every depth (as serde_json's `json!` writes
// them). Agents read that text (an MCP tool's JSON-as-text output), so it
// stays the same from answer to answer. Project files and struct-shaped
// answers keep their field order and don't go through this.
//
// It writes the text itself rather than building a sorted copy for
// JSON.stringify: JS objects list integer-like keys ("2", "10") first and in
// numeric order whatever order they were added in, where a BTreeMap has
// "10" before "2".

/** `JSON.stringify` with every object's keys sorted (`indent` as JSON.stringify's: 2 is serde's pretty). */
export function stableStringify(value: unknown, indent?: number): string {
  const step = indent === undefined || indent <= 0 ? "" : " ".repeat(Math.min(indent, 10));
  return write(value, step, "") ?? "null";
}

function write(value: unknown, step: string, at: string): string | undefined {
  if (value === null) return "null";
  if (typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return write((value as { toJSON: () => unknown }).toJSON(), step, at);
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    case "object":
      break;
  }
  const inner = at + step;
  const open = step === "" ? "" : `\n${inner}`;
  const close = step === "" ? "" : `\n${at}`;
  const comma = step === "" ? "," : `,\n${inner}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => write(item, step, inner) ?? "null");
    return `[${open}${items.join(comma)}${close}]`;
  }
  const colon = step === "" ? ":" : ": ";
  const members: string[] = [];
  for (const key of Object.keys(value as object).sort(compareKeys)) {
    const text = write((value as Record<string, unknown>)[key], step, inner);
    if (text !== undefined) members.push(`${JSON.stringify(key)}${colon}${text}`);
  }
  if (members.length === 0) return "{}";
  return `{${open}${members.join(comma)}${close}}`;
}

const SURROGATE = /[\uD800-\uDFFF]/;

/**
 * Rust's String order: the UTF-8 bytes, which is code point order. UTF-16
 * code units agree except past the BMP (surrogates sort below U+E000), so
 * only keys with surrogates take the slow path.
 */
export function compareKeys(a: string, b: string): number {
  if (a === b) return 0;
  if (SURROGATE.test(a) || SURROGATE.test(b)) return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  return a < b ? -1 : 1;
}
