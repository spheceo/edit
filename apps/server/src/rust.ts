// The bits of Rust's standard library whose behaviour the ported modules keep,
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

/**
 * `format!("{:.N}", value)`: the exact binary value rounded to `digits`
 * decimals, an exact tie to the even digit (JS's toFixed takes the larger).
 */
export function fixed(value: number, digits: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  const negative = value < 0 || Object.is(value, -0);
  const size = Math.abs(value);
  if (size >= 1e21) return `${negative ? "-" : ""}${size.toFixed(digits)}`;
  let out = size.toFixed(digits);
  // A tie has at most digits+1 decimals, the last a 5: the exact expansion shows it.
  const exact = size.toFixed(Math.min(digits + 30, 100));
  const point = exact.indexOf(".");
  const rest = point < 0 ? "" : exact.slice(point + 1 + digits);
  if (/^50*$/.test(rest)) {
    const truncated = point < 0 ? exact : exact.slice(0, digits === 0 ? point : point + 1 + digits);
    const last = truncated.replace(".", "").slice(-1);
    if (Number(last) % 2 === 0) out = truncated;
  }
  return `${negative ? "-" : ""}${out}`;
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
