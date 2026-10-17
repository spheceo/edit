// How Rust wrote numbers and strings into the text agents read, and the bits
// of Rust arithmetic the ported tools lean on, so the TS tools say the same:
// - `{:.N}` rounds the exact binary value, ties to even (JS's toFixed rounds
//   ties up), and keeps the sign of a negative that rounds to zero ("-0.0");
// - `{:+.N}` always has a sign;
// - `{}` of a float never uses an exponent;
// - `{:?}` of a string is Debug-quoted;
// - `f64::round` rounds half away from zero (Math.round rounds half up),
//   `as i64` truncates and saturates, and i64 division truncates.
// f32 fields (edit-core keeps transforms, styles and keyframes in f32) are
// held as the shortest decimal that is that f32, which is what serde writes
// and so what every project the addon saved holds.

/** Rust's `format!("{:.digits$}", x)`. */
export function fixed(x: number, digits: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const negative = x < 0 || Object.is(x, -0);
  const magnitude = Math.abs(x);
  // toFixed(100) is the exact decimal of every double we'll meet (and of
  // every one where a tie could matter).
  const exact = magnitude >= 1e21 ? BigInt(magnitude).toString() : magnitude.toFixed(100);
  const [whole, fraction = ""] = exact.split(".");
  let kept = (whole ?? "0") + fraction.slice(0, digits).padEnd(digits, "0");
  const rest = fraction.slice(digits);
  const first = rest.charCodeAt(0) - 48;
  const tail = /[1-9]/.test(rest.slice(1));
  const last = Number(kept.at(-1) ?? "0");
  const up = first > 5 || (first === 5 && (tail || last % 2 === 1));
  if (up) kept = increment(kept);
  const intLength = kept.length - digits;
  const text = digits === 0 ? kept : `${kept.slice(0, intLength)}.${kept.slice(intLength)}`;
  return negative ? `-${text}` : text;
}

function increment(digits: string): string {
  const out = digits.split("");
  for (let index = out.length - 1; index >= 0; index--) {
    if (out[index] === "9") {
      out[index] = "0";
    } else {
      out[index] = String(Number(out[index]) + 1);
      return out.join("");
    }
  }
  return `1${out.join("")}`;
}

/** Rust's `format!("{:+.digits$}", x)`. */
export function signed(x: number, digits: number): string {
  const text = fixed(x, digits);
  return text.startsWith("-") || Number.isNaN(x) ? text : `+${text}`;
}

/** An f32 field's `{:.N}`: the f32's own exact value is what Rust rounded. */
export function fixed32(x: number, digits: number): string {
  return fixed(Math.fround(x), digits);
}

/** An f32 field's `{:+.N}`. */
export function signed32(x: number, digits: number): string {
  return signed(Math.fround(x), digits);
}

/** Rust's `{}` of an f64: the shortest decimal that round-trips, never in exponent form. */
export function display(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (Object.is(x, -0)) return "-0";
  return plain(String(x));
}

/** Rust's `{}` of an f32. */
export function display32(x: number): string {
  return display(f32(x));
}

/** A JS number's text without an exponent ("1e-7" → "0.0000001"). */
function plain(text: string): string {
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (match === null) return text;
  const [, sign, lead, rest = "", power] = match;
  const digits = `${lead}${rest}`;
  const exponent = Number(power);
  if (exponent >= 0) {
    const whole = digits.padEnd(exponent + 1, "0");
    const point = exponent + 1;
    const fraction = whole.slice(point);
    return `${sign}${whole.slice(0, point)}${fraction === "" ? "" : `.${fraction}`}`;
  }
  return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
}

/** Rust's `{:?}` of a string: quoted, with Rust's escapes. */
export function debugStr(text: string): string {
  let out = '"';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    switch (char) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\0":
        out += "\\0";
        break;
      default:
        out += code < 0x20 || code === 0x7f ? `\\u{${code.toString(16)}}` : char;
    }
  }
  return `${out}"`;
}

/** Rust's `{:?}` of a `Vec<String>`: `["a", "b"]`. */
export function debugStrings(items: readonly string[]): string {
  return `[${items.map(debugStr).join(", ")}]`;
}

/** Rust's `{:?}` of a `Vec<i64>`: `[1, 2]`. */
export function debugInts(items: readonly number[]): string {
  return `[${items.join(", ")}]`;
}

/** `f64::round`: half away from zero. */
export function round(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

const I64_MAX = 9_223_372_036_854_775_807;

/** `x as i64`: truncated toward zero, NaN as 0, saturating. */
export function asInt(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x >= I64_MAX) return I64_MAX;
  if (x <= -I64_MAX) return -I64_MAX;
  return Math.trunc(x) + 0;
}

/** i64 division: truncates toward zero. */
export function idiv(a: number, b: number): number {
  return Math.trunc(a / b) + 0;
}

/** `i64::rem_euclid`. */
export function remEuclid(a: number, b: number): number {
  const r = a % b;
  return r < 0 ? r + Math.abs(b) : r + 0;
}

/**
 * An f32 as serde writes it (the shortest decimal that is that f32), as a JS
 * number: what an f32 field holds once the addon has saved it.
 */
export function f32(x: number): number {
  if (!Number.isFinite(x)) return x;
  const single = Math.fround(x);
  if (single === 0) return Object.is(single, -0) ? -0 : 0;
  for (let precision = 1; precision <= 9; precision++) {
    const shortest = Number(single.toPrecision(precision));
    if (Math.fround(shortest) === single) return shortest;
  }
  return single;
}

/** Rust's `str::trim`: Unicode white space at both ends. */
export function trim(text: string): string {
  return text.replace(/^[\p{White_Space}]+|[\p{White_Space}]+$/gu, "");
}

/** Rust's `char::is_alphanumeric`. */
export function isAlphanumeric(char: string): boolean {
  return /^[\p{Alphabetic}\p{N}]$/u.test(char);
}

/** Bytes of `text` as UTF-8 (Rust's `str::len`). */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The first `count` chars (Rust's `chars().take(count)`). */
export function takeChars(text: string, count: number): string {
  let out = "";
  let taken = 0;
  for (const char of text) {
    if (taken === count) break;
    out += char;
    taken += 1;
  }
  return out;
}

/** How many chars (Unicode scalar values) `text` has. */
export function charCount(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** Rust's String order (UTF-8 bytes) for sorting ids. */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
