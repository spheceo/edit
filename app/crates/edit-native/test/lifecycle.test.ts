import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { cache, home, native } from "./native";

describe("cache keys", () => {
  test("a file's key is its name, size and mtime", () => {
    const file = join(home, "a.mp4");
    writeFileSync(file, "one");
    const key = native.mediaKey(file);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(native.mediaKey(file)).toBe(key);
    expect(native.keyOf(file, file)).toBe(key);
    // A changed file is another key.
    writeFileSync(file, "two!");
    expect(native.mediaKey(file)).not.toBe(key);
    expect(native.mediaCache(file)).toBe(join(cache, native.mediaKey(file)));
  });

  test("no light preview until one is made", () => {
    expect(native.lightPreview(join(home, "nothing.mp4"))).toBeNull();
  });
});

describe("the data folder's lock", () => {
  test("held here, it's locked for another process", async () => {
    const lock = join(home, "server.lock");
    expect(native.holdLock(lock)).toBe(true);
    expect(native.holdLock(lock)).toBe(true);
    expect(native.isLocked(lock)).toBe(false);
    const other = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const n = require(${JSON.stringify(join(import.meta.dir, "..", "edit-native.node"))});
         console.log(JSON.stringify([n.isLocked(${JSON.stringify(lock)}), n.holdLock(${JSON.stringify(lock)})]));`,
      ],
      { stdout: "pipe" },
    );
    const answer = JSON.parse((await new Response(other.stdout).text()).trim());
    expect(answer).toEqual([true, false]);
    expect(native.isLocked(join(home, "nobody.lock"))).toBe(false);
  });
});

describe("constants", () => {
  test("as the engine has them", () => {
    expect(native.SHEET_CELL).toBe(360);
    expect(native.FACES_RATE).toBe(2);
    expect(native.cloudProxyBitrate(1920, 1080)).toBe(4_000_000);
    expect(native.cloudProxyBitrate(320, 180)).toBe(800_000);
  });

  test("bundled fonts", () => {
    const font = native.bundledFont("Geist-Regular.ttf");
    expect(font).toBeInstanceOf(Buffer);
    expect(font!.length).toBeGreaterThan(10_000);
    expect(native.bundledFont("Nope.ttf")).toBeNull();
  });

  test("text measures as the renderer lays it out", () => {
    const [one, height] = native.textBlock("- Aggravated burglary", 42, 400, 1.76);
    const [two, taller] = native.textBlock(
      "- Aggravated burglary\n- Aggravated assault",
      42,
      400,
      1.76,
    );
    expect(one).toBeGreaterThan(300);
    expect(Math.abs(one - two)).toBeLessThan(1e-6);
    expect(taller).toBeGreaterThan(height * 1.8);
  });
});
