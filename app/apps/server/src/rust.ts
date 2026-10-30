// The bits of Rust's standard library whose behaviour the server keeps,
// where JS's own differs: rounding half away from zero (`f64::round`), `{:.N}`
// formatting (the exact value, ties to even), f32 arithmetic (`Math.fround`
// after every step, which gives exactly f32's result for + − × ÷), and the
// Unicode character classes `char::is_alphanumeric` and friends use. Agents
// read the text these make, and project files hold the f32s, so they have to
// come out the same.

/** f32: rounds a number to the nearest f32 (apply after every operation). */
export const f32 = Math.fround;

/** `f32::MAX`. */
export const F32_MAX = 3.4028234663852886e38;

/** `f64::round`: half away from zero (Math.round goes half up). */
export function round(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** `value as i64`: towards zero, NaN as 0 (the result stays a JS number). */
export function toI64(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.trunc(value);
}

/** Rust's `format!("{:.digits$}", x)`. */
export function fixed(x: number, digits: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const negative = x < 0 || Object.is(x, -0);
  const magnitude = Math.abs(x);
  // toFixed(100) is the exact decimal of every double we'll meet (and of
  // every one where a tie could matter).
  // oxlint-disable-next-line number-arg-out-of-range -- toFixed takes up to 100 (ES2018)
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

/** The characters (code points) of `text`, as `str::chars`. */
export function chars(text: string): string[] {
  return [...text];
}

/** `str::chars().count()`. */
export function charCount(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

const ALPHANUMERIC = /^[\p{Alphabetic}\p{N}]$/u;
const ALPHABETIC = /^\p{Alphabetic}$/u;
const WHITESPACE = /^\p{White_Space}$/u;

/** `char::is_alphanumeric`: Alphabetic or a number (Nd, Nl, No). */
export function isAlphanumeric(char: string | undefined): boolean {
  return char !== undefined && ALPHANUMERIC.test(char);
}

/** `char::is_alphabetic`. */
export function isAlphabetic(char: string | undefined): boolean {
  return char !== undefined && ALPHABETIC.test(char);
}

/** `char::is_whitespace` (White_Space). */
export function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && WHITESPACE.test(char);
}

/** `str::trim`: White_Space off both ends (JS's trim also takes U+FEFF). */
export function trim(text: string): string {
  return text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

/** `str::split_whitespace`. */
export function splitWhitespace(text: string): string[] {
  return text.split(/\p{White_Space}+/u).filter((word) => word !== "");
}

/** `str::lines`: split at \n, a \r before it dropped, no last empty line. */
export function lines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** `str::len`: bytes of UTF-8. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * `u32::from_str_radix(text, 16)` (and u8's with `max` 255): hex digits, an
 * optional leading +, nothing else, within range.
 */
export function parseHex(text: string, max = 0xffff_ffff): number | null {
  if (!/^\+?[0-9a-fA-F]+$/.test(text)) return null;
  const value = Number.parseInt(text.startsWith("+") ? text.slice(1) : text, 16);
  return value <= max ? value : null;
}

/** The value of an own key of a map-like object (a BTreeMap<String, _> read from JSON). */
export function get<T>(map: Record<string, T> | undefined | null, key: string): T | undefined {
  return map !== undefined && map !== null && Object.hasOwn(map, key) ? map[key] : undefined;
}

// Formatting helpers the editing tools use.
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

/**
 * What Rust's `{:?}` writes as `\u{…}`: what core::unicode's `is_printable`
 * calls unprintable (control, format, private-use, unassigned, line and
 * paragraph separators, and spaces other than the plain one), and a
 * combining mark opening the string.
 */
const UNPRINTABLE = /^(?:[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]|(?! )\p{Zs})$/u;
const COMBINING = /^\p{Grapheme_Extend}$/u;

/** Rust's `{:?}` of a string: quoted, with Rust's escapes. */
export function debugStr(text: string): string {
  let out = '"';
  let first = true;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const opening = first;
    first = false;
    if (opening && COMBINING.test(char)) {
      out += `\\u{${code.toString(16)}}`;
      continue;
    }
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
        out += UNPRINTABLE.test(char) ? `\\u{${code.toString(16)}}` : char;
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

// oxlint-disable-next-line no-loss-of-precision -- i64::MAX as Rust's `as f64` has it (2^63), on purpose
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

/** Rust's String order (UTF-8 bytes) for sorting ids. */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * An f32 as serde writes it (the shortest decimal that is that f32), as a JS
 * number: what an f32 field holds once the addon has saved it. Not the same
 * as `f32` (Math.fround), which is for f32 arithmetic.
 */
export function f32Saved(x: number): number {
  if (!Number.isFinite(x)) return x;
  const single = Math.fround(x);
  if (single === 0) return Object.is(single, -0) ? -0 : 0;
  for (let precision = 1; precision <= 9; precision++) {
    const shortest = Number(single.toPrecision(precision));
    if (Math.fround(shortest) === single) return shortest;
  }
  return single;
}

// ---------------------------------------------------------------------------
// Reading JSON text the way serde_json does (no `float_roundtrip`)

const U64_MAX = 18446744073709551615n;
const POW10 = Array.from({ length: 309 }, (_, index) => Number(`1e${index}`));

/**
 * The f64 serde_json (without `float_roundtrip`) reads from a JSON number
 * literal: the digits as a u64 (later ones dropped once it would overflow),
 * as f64, times or over one power of ten. Correctly rounded for up to 15
 * significant digits, but not always beyond: "9.299999999999999" is read as
 * 9.3. Projects were always read so, and the addon reads exactly (it has
 * `float_roundtrip`, so the values passed to it keep what they are); where
 * numbers must come out as serde reads them, the TS reads them with this.
 */
export function serdeNumber(literal: string): number {
  let at = 0;
  const positive = literal[0] !== "-";
  if (!positive) at++;
  let significand = 0n;
  let exponent = 0;
  let overflowed = false;
  const digit = () => {
    const code = literal.charCodeAt(at) - 48;
    return code >= 0 && code <= 9 ? code : -1;
  };
  const push = (value: number): boolean => {
    const next = significand * 10n + BigInt(value);
    if (next > U64_MAX) return false;
    significand = next;
    return true;
  };
  // The integer part: past u64, the rest only count as powers of ten.
  for (let value = digit(); value >= 0; value = digit()) {
    at++;
    if (overflowed || !push(value)) {
      overflowed = true;
      exponent += 1;
    }
  }
  const integerOnly = literal[at] !== "." && literal[at] !== "e" && literal[at] !== "E";
  if (integerOnly && !overflowed) {
    // An integer: u64 or i64 to serde, which an f64 field takes `as f64`.
    return positive ? Number(significand) : -Number(significand);
  }
  if (literal[at] === ".") {
    at++;
    for (let value = digit(); value >= 0; value = digit()) {
      at++;
      if (overflowed) continue;
      if (!push(value)) {
        overflowed = true;
        continue;
      }
      exponent -= 1;
    }
  }
  if (literal[at] === "e" || literal[at] === "E") {
    at++;
    let sign = 1;
    if (literal[at] === "+") at++;
    else if (literal[at] === "-") {
      sign = -1;
      at++;
    }
    let exp = 0;
    for (let value = digit(); value >= 0; value = digit()) {
      at++;
      exp = exp * 10 + value;
      if (exp > 2147483647) return sign > 0 ? (positive ? Infinity : -Infinity) : positive ? 0 : -0;
    }
    exponent += sign * exp;
  }
  let f = Number(significand);
  for (;;) {
    const pow = POW10[Math.abs(exponent)];
    if (pow !== undefined) {
      if (exponent >= 0) f *= pow;
      else f /= pow;
      break;
    }
    if (f === 0) break;
    if (exponent >= 0) return positive ? Infinity : -Infinity;
    f /= 1e308;
    exponent += 308;
  }
  return positive ? f : -f;
}

/** JSON.parse, numbers read as serde_json reads them (`serdeNumber`). */
export function serdeParse<T = unknown>(text: string): T {
  // Up to 15 significant digits and no exponent, serde is exact: JSON.parse's own value.
  if (!LOSSY.test(text)) return JSON.parse(text) as T;
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => {
    if (typeof value !== "number" || context?.source === undefined) return value;
    const source = context.source;
    return source.length < 16 && !/[eE]/.test(source) ? value : serdeNumber(source);
  }) as T;
}

/** A number literal serde might read differently from JS: 16+ digits, or an exponent. */
const LOSSY = /[\d.]{16}|\d[eE][+-]?\d/;

/**
 * JSON text with each number literal that serde reads differently from its
 * exact value rewritten as the value serde reads; everything else (strings,
 * key order, spacing) untouched. For text handed to the addon, which reads
 * exactly, where serde's reading of the same text is what's wanted (project files).
 */
export function asSerdeRead(text: string): string {
  if (!LOSSY.test(text)) return text;
  let out = "";
  let last = 0;
  let at = 0;
  while (at < text.length) {
    const char = text.charCodeAt(at);
    if (char === 34) {
      // A string: skipped whole, escapes included.
      at++;
      while (at < text.length && text.charCodeAt(at) !== 34) at += text.charCodeAt(at) === 92 ? 2 : 1;
      at++;
      continue;
    }
    if (char === 45 || (char >= 48 && char <= 57)) {
      const from = at;
      at++;
      while (at < text.length && NUMBER_CHAR.test(text[at]!)) at++;
      const literal = text.slice(from, at);
      if (literal.length >= 16 || /[eE]/.test(literal)) {
        const value = serdeNumber(literal);
        if (Number.isFinite(value) && value !== Number(literal)) {
          out += text.slice(last, from) + String(value);
          last = at;
        }
      }
      continue;
    }
    at++;
  }
  return last === 0 ? text : out + text.slice(last);
}

const NUMBER_CHAR = /[0-9.eE+-]/;

/**
 * JSON for the addon: JSON.stringify, except that a negative zero stays `-0`
 * (JSON.stringify writes 0, losing the sign edit-core's f32/f64 math keeps
 * and writes as -0.0). The addon reads a `-0` an integer field can't
 * take as 0.
 */
export function jsonForSerde(value: unknown): string {
  if (!hasNegativeZero(value)) return JSON.stringify(value);
  return JSON.stringify(value, (_key, item: unknown) => (Object.is(item, -0) ? NEGATIVE_ZERO : item)).replaceAll(NEGATIVE_ZERO_JSON, "-0");
}

const NEGATIVE_ZERO = "\u0000-0\u0000";
const NEGATIVE_ZERO_JSON = JSON.stringify(NEGATIVE_ZERO);

function hasNegativeZero(value: unknown): boolean {
  if (typeof value === "number") return Object.is(value, -0);
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    for (const item of value) if (hasNegativeZero(item)) return true;
    return false;
  }
  for (const key in value) if (hasNegativeZero((value as Record<string, unknown>)[key])) return true;
  return false;
}
