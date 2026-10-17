// broll.rs names the files it makes with DefaultHasher; these values were
// printed by that code (rustc 1.99, `fingerprint` copied from broll.rs).

import { expect, test } from "bun:test";

import { debugModified, fingerprint, siphash } from "../src/hash.ts";

test("fingerprints are the Rust server's", () => {
  expect(fingerprint([])).toBe("a762150c532c");
  expect(fingerprint([""])).toBe("6ea523c53def");
  expect(fingerprint(["a"])).toBe("50b9a4f0e9f3");
  expect(fingerprint(["hello", "world"])).toBe("64f714dbd2bb");
  expect(
    fingerprint([
      "bounded-optical-flow-v2",
      "0123456789abcdef",
      "1920x1080",
      "/Users/x/media/clip one.mp4",
      "12.3400",
      "3.1250",
      "0.5000",
      "30",
    ]),
  ).toBe("e8493527cd6b");
  const long = Array.from({ length: 300 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
  expect(fingerprint([long, "é✓🎬"])).toBe("e9aa258d38ed");
});

test("siphash 2-4 matches the reference vector", () => {
  // The SipHash paper's key 00..0f and the empty message.
  const key = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
  expect(siphash(new Uint8Array(0), key.readBigUInt64LE(0), key.readBigUInt64LE(8), 2, 4).toString(16)).toBe(
    "726fdb47dd0e0e31",
  );
});

test("modified times read as Rust's Debug of Option<SystemTime>", () => {
  expect(debugModified(1792262521899524021n)).toBe("Some(SystemTime { tv_sec: 1792262521, tv_nsec: 899524021 })");
  expect(debugModified(null)).toBe("None");
});
