// What `serde_json::from_value` did for the tools: a value read into a Rust
// type, its defaults filled in, f32 fields rounded to f32, and a wrong value
// refused with serde's own words ("missing field `media`", "unknown variant
// `x`, expected one of …", "invalid type: string \"a\", expected i64"), which
// agents read. Read values come out in serde's written shape: fields in
// declaration order, skipped ones (`skip_serializing_if`) left out.
//
// serde_json's maps are BTreeMaps, so an object's fields are met in sorted
// order (the first bad one in that order is the one reported); missing
// fields are reported after, in declaration order.

import { compareKeys } from "./stable.ts";
import { f32 as toF32 } from "./rust.ts";

/** A refusal in serde's words. */
export class SerdeError extends Error {}

export type Kind =
  | "i64"
  | "u16"
  | "u32"
  | "u64"
  | "f32"
  | "f64"
  | "bool"
  | "string"
  | "any"
  | { rgba: true }
  | { array: Kind; length: number }
  | { enum: string; variants: readonly string[] }
  | { option: Kind }
  | { vec: Kind }
  | { map: Kind }
  | { struct: Struct };

export interface Field {
  name: string;
  kind: Kind;
  /** Absent: the field is required (serde's "missing field"). */
  default?: () => unknown;
  /** Left out of the written shape when this holds (`skip_serializing_if`). */
  skip?: (value: unknown) => boolean;
}

export interface Struct {
  /** Its Rust name, for "expected struct Name". */
  name: string;
  fields: Field[];
  /** Unknown fields are refused (`deny_unknown_fields`). */
  denyUnknown?: boolean;
}

/** How serde_json names a JSON value it didn't expect (serde_json Value::unexpected). */
export function unexpected(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return `boolean \`${value}\``;
  if (typeof value === "number") {
    if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return `integer \`${value}\``;
    return `floating point \`${floatText(value)}\``;
  }
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (Array.isArray(value)) return "sequence";
  return "map";
}

/** serde's WithDecimalPoint: a float always shows a point. */
function floatText(value: number): string {
  const text = String(value);
  return /[.eEn]/.test(text) ? text : `${text}.0`;
}

function expected(kind: Kind): string {
  if (typeof kind === "string") {
    switch (kind) {
      case "bool":
        return "a boolean";
      case "string":
        return "a string";
      case "any":
        return "any value";
      default:
        return kind;
    }
  }
  if ("rgba" in kind) return "tuple struct Rgba";
  if ("array" in kind) return `an array of length ${kind.length}`;
  if ("enum" in kind) return "string or map";
  if ("option" in kind) return expected(kind.option);
  if ("vec" in kind) return "a sequence";
  if ("map" in kind) return "a map";
  return `struct ${kind.struct.name}`;
}

function invalidType(value: unknown, kind: Kind): SerdeError {
  return new SerdeError(`invalid type: ${unexpected(value)}, expected ${expected(kind)}`);
}

const LIMITS: Record<string, [number, number]> = {
  i64: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  u16: [0, 65_535],
  u32: [0, 4_294_967_295],
  u64: [0, Number.MAX_SAFE_INTEGER],
};

/** `value` read as `kind` (throws SerdeError). */
export function read(kind: Kind, value: unknown): unknown {
  if (typeof kind === "string") {
    switch (kind) {
      case "any":
        return value ?? null;
      case "bool":
        if (typeof value !== "boolean") throw invalidType(value, kind);
        return value;
      case "string":
        if (typeof value !== "string") throw invalidType(value, kind);
        return value;
      case "f32":
      case "f64":
        if (typeof value !== "number") throw invalidType(value, kind);
        return kind === "f32" ? toF32(value) : value;
      default: {
        if (typeof value !== "number" || !Number.isInteger(value)) throw invalidType(value, kind);
        const [low, high] = LIMITS[kind]!;
        if (value < low || value > high) throw new SerdeError(`invalid value: integer \`${value}\`, expected ${kind}`);
        return value + 0;
      }
    }
  }
  if ("rgba" in kind) {
    if (!Array.isArray(value)) throw invalidType(value, { array: "f32", length: 4 });
    if (value.length !== 4) throw new SerdeError(`invalid length ${value.length}, expected an array of length 4`);
    return value.map((item) => read("f32", item));
  }
  if ("array" in kind) {
    if (!Array.isArray(value)) throw invalidType(value, kind);
    if (value.length !== kind.length) {
      throw new SerdeError(`invalid length ${value.length}, expected an array of length ${kind.length}`);
    }
    return value.map((item) => read(kind.array, item));
  }
  if ("enum" in kind) {
    if (typeof value !== "string") throw invalidType(value, kind);
    if (!kind.variants.includes(value)) throw unknownVariant(value, kind.variants);
    return value;
  }
  if ("option" in kind) return value === null || value === undefined ? null : read(kind.option, value);
  if ("vec" in kind) {
    if (!Array.isArray(value)) throw invalidType(value, kind);
    return value.map((item) => read(kind.vec, item));
  }
  if ("map" in kind) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidType(value, kind);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareKeys)) {
      out[key] = read(kind.map, (value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return readStruct(kind.struct, value);
}

export function unknownVariant(value: string, variants: readonly string[]): SerdeError {
  return new SerdeError(`unknown variant \`${value}\`, expected one of ${variants.map((v) => `\`${v}\``).join(", ")}`);
}

/** A struct from a JSON object: sorted-order type checks, then missing fields, then defaults. */
export function readStruct(spec: Struct, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidType(value, { struct: spec });
  }
  const given = value as Record<string, unknown>;
  const byName = new Map(spec.fields.map((field) => [field.name, field]));
  const found = new Map<string, unknown>();
  for (const key of Object.keys(given).sort(compareKeys)) {
    const field = byName.get(key);
    if (field === undefined) {
      if (spec.denyUnknown === true) {
        throw new SerdeError(
          `unknown field \`${key}\`, expected one of ${spec.fields.map((f) => `\`${f.name}\``).join(", ")}`,
        );
      }
      continue;
    }
    const raw = given[key];
    // A missing value and JSON null are the same to an Option.
    if (raw === undefined) continue;
    found.set(key, read(field.kind, raw));
  }
  return fill(spec, found);
}

/** Missing fields (declaration order), defaults, and the written shape. */
function fill(spec: Struct, found: Map<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of spec.fields) {
    let value: unknown;
    if (found.has(field.name)) {
      value = found.get(field.name);
    } else if (field.default !== undefined) {
      value = field.default();
    } else if (typeof field.kind === "object" && "option" in field.kind) {
      value = null;
    } else {
      throw new SerdeError(`missing field \`${field.name}\``);
    }
    if (field.skip?.(value) === true) continue;
    out[field.name] = value;
  }
  return out;
}

/** Fields read from `given` (sorted order), the rest left for another reader (serde's flatten). */
export function readFields(spec: Struct, given: Record<string, unknown>): Map<string, unknown> {
  const byName = new Map(spec.fields.map((field) => [field.name, field]));
  const found = new Map<string, unknown>();
  for (const key of Object.keys(given).sort(compareKeys)) {
    const field = byName.get(key);
    if (field === undefined || given[key] === undefined) continue;
    found.set(key, read(field.kind, given[key]));
  }
  return found;
}

export function fillFields(spec: Struct, found: Map<string, unknown>): Record<string, unknown> {
  return fill(spec, found);
}

// Field helpers ---------------------------------------------------------------

export const isNone = (value: unknown) => value === null || value === undefined;
export const isZero = (value: unknown) => value === 0;
export const isOne = (value: unknown) => value === 1;
export const isEmpty = (value: unknown) =>
  Array.isArray(value) ? value.length === 0 : typeof value === "object" && value !== null && Object.keys(value).length === 0;

/** A field with a default (copied each time). */
export function field(name: string, kind: Kind, value?: unknown, skip?: (value: unknown) => boolean): Field {
  const out: Field = { name, kind };
  if (value !== undefined) out.default = () => structuredClone(value);
  if (skip !== undefined) out.skip = skip;
  return out;
}

/** A required field. */
export function required(name: string, kind: Kind): Field {
  return { name, kind };
}

/** An optional field (None when absent), left out when None. */
export function optional(name: string, kind: Kind): Field {
  return { name, kind: { option: kind }, default: () => null, skip: isNone };
}
