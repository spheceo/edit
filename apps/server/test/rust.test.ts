import { expect, test } from "bun:test";

import * as fs from "node:fs";

import {
  asInt,
  asSerdeRead,
  debugStr,
  debugStrings,
  display,
  f32Saved as f32,
  fixed,
  fixed32,
  idiv,
  round,
  serdeNumber,
  serdeParse,
  signed,
  signed32,
} from "../src/rust.ts";
import { fnv1a32, find, path } from "../src/sfx.ts";
import { scratch } from "./helpers/home.ts";

test("numbers are read as serde_json reads them without float_roundtrip", () => {
  // As serde_json 1.0.151 read them (checked against the addon built without float_roundtrip
  // on 24,000 literals): exact up to 15 digits, a u64 significand over a power of ten past that.
  expect(serdeNumber("9.299999999999999")).toBe(9.3);
  expect(serdeNumber("13.866666666666667")).toBe(13.866666666666667);
  expect(serdeNumber("0.30000000000000004")).toBe(0.30000000000000004);
  expect(serdeNumber("-1.5e3")).toBe(-1500);
  expect(serdeNumber("12345678901234567890123.5")).toBe(12345678901234567000000);
  expect(serdeNumber("-0")).toBe(-0);
  expect(serdeParse<{ a: number[] }>('{"a": [9.299999999999999, 1.25]}').a).toEqual([9.3, 1.25]);
  // Only the numbers change; a number in a string is left alone.
  expect(asSerdeRead('{"s": "9.299999999999999", "n": 9.299999999999999}')).toBe('{"s": "9.299999999999999", "n": 9.3}');
  expect(asSerdeRead('{"n": 1.5}')).toBe('{"n": 1.5}');
});

test("{:.N} rounds the exact value, ties to even, and keeps a negative zero's sign", () => {
  expect(fixed(104, 2)).toBe("104.00");
  expect(fixed(0.125, 2)).toBe("0.12");
  expect(fixed(0.375, 2)).toBe("0.38");
  expect(fixed(2.5, 0)).toBe("2");
  expect(fixed(3.5, 0)).toBe("4");
  // 0.35 is a hair under 0.35: down.
  expect(fixed(0.35, 1)).toBe("0.3");
  expect(fixed(9.995, 2)).toBe("9.99");
  expect(fixed(9.996, 2)).toBe("10.00");
  expect(fixed(-0.04, 1)).toBe("-0.0");
  expect(fixed(-0, 2)).toBe("-0.00");
  expect(fixed(1e21, 1)).toBe("1000000000000000000000.0");
  expect(signed(0, 1)).toBe("+0.0");
  expect(signed(-3.25, 1)).toBe("-3.2");
  // An f32 field rounds its own f32 value.
  expect(fixed32(-3.45, 1)).toBe("-3.5");
  expect(signed32(2.05, 1)).toBe("+2.0");
});

test("{} and {:?} write numbers and strings as Rust does", () => {
  expect(display(1)).toBe("1");
  expect(display(1e-7)).toBe("0.0000001");
  expect(display(1.5e21)).toBe("1500000000000000000000");
  expect(debugStr('say "hi"\n\t')).toBe('"say \\"hi\\"\\n\\t"');
  // Unprintable characters (a no-break space, a zero-width space, DEL) and an opening combining mark are escaped; the rest stay.
  expect(debugStr("a b​c\u007f")).toBe('"a\\u{a0}b\\u{200b}c\\u{7f}"');
  expect(debugStr("́é’")).toBe('"\\u{301}é’"');
  expect(debugStrings(["m1", "m2"])).toBe('["m1", "m2"]');
  expect(debugStrings([])).toBe("[]");
});

test("Rust's rounding, casts and division", () => {
  expect(round(2.5)).toBe(3);
  expect(round(-2.5)).toBe(-3);
  expect(asInt(-2.7)).toBe(-2);
  expect(asInt(Number.NaN)).toBe(0);
  expect(idiv(-7, 2)).toBe(-3);
  expect(f32(1.1)).toBe(1.1);
  expect(f32(0.1 + 0.2)).toBe(0.3);
  expect(f32(95.40000152587890625)).toBe(95.4);
});

test("a bundled sound is written once under a name carrying its hash", () => {
  const reference = (bytes: Uint8Array) => {
    let hash = 0xcbf29ce484222325n;
    for (const byte of bytes) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
    return Number(hash & 0xffffffffn);
  };
  const sample = new Uint8Array(Array.from({ length: 4096 }, (_, index) => (index * 37 + 11) % 256));
  expect(fnv1a32(sample)).toBe(reference(sample));
  const { dir, cleanup } = scratch("sfx");
  try {
    const shutter = find("shutter")!;
    const written = path(dir, shutter);
    const bytes = fs.readFileSync(written);
    expect(written).toBe(`${dir}/sfx/shutter-${reference(bytes).toString(16).padStart(8, "0")}.wav`);
    expect(bytes.length).toBe(fs.statSync(shutter.source).size);
    const mtime = fs.statSync(written).mtimeMs;
    expect(path(dir, shutter)).toBe(written);
    expect(fs.statSync(written).mtimeMs).toBe(mtime);
  } finally {
    cleanup();
  }
});
