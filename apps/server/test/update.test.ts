import { expect, test } from "bun:test";

import * as fs from "node:fs";

import { assetTarget, enabled, newer, programs, swapAll, Updater } from "../src/update.ts";
import { scratch } from "./helpers/home.ts";

test("newer_compares_numerically", () => {
  expect(newer("0.1.10", "0.1.9")).toBe(true);
  expect(newer("v1.0.0", "0.9.9")).toBe(true);
  expect(newer("0.1.0", "0.1.0")).toBe(false);
  expect(newer("0.0.9", "0.1.0")).toBe(false);
  expect(newer("0.2.0-beta", "0.1.0")).toBe(false);
  expect(newer("garbage", "0.1.0")).toBe(false);
});

/** Every program in the archive is swapped in, the edit binary last over the running one; other files and anything hidden are left. */
test("every_program_in_the_archive_is_swapped_in", () => {
  const { dir, cleanup } = scratch("update");
  try {
    const unpacked = `${dir}/unpacked`;
    const installed = `${dir}/bin`;
    fs.mkdirSync(unpacked, { recursive: true });
    fs.mkdirSync(installed, { recursive: true });
    const write = (folder: string, name: string, text: string, mode: number) => {
      fs.writeFileSync(`${folder}/${name}`, text);
      fs.chmodSync(`${folder}/${name}`, mode);
    };
    const running = `${installed}/edit-installed-as`;
    write(installed, "edit-installed-as", "old edit", 0o755);
    write(installed, "edit-ffmpeg", "old ffmpeg", 0o755);
    write(unpacked, "edit", "new edit", 0o755);
    write(unpacked, "edit-ffmpeg", "new ffmpeg", 0o644);
    write(unpacked, "edit-ffprobe", "new ffprobe", 0o755);
    write(unpacked, "edit-window", "new window", 0o755);
    write(unpacked, "README", "notes", 0o644);
    write(unpacked, ".hidden", "no", 0o755);
    expect(programs(unpacked)).toEqual(["edit-ffmpeg", "edit-ffprobe", "edit-window"]);
    expect(swapAll(unpacked, running)).toBe(running);
    const read = (name: string) => fs.readFileSync(`${installed}/${name}`, "utf8");
    expect(read("edit-installed-as")).toBe("new edit");
    expect(read("edit-ffmpeg")).toBe("new ffmpeg");
    expect(read("edit-ffprobe")).toBe("new ffprobe");
    expect(read("edit-window")).toBe("new window");
    expect(fs.existsSync(`${installed}/README`) || fs.existsSync(`${installed}/.hidden`)).toBe(false);
    expect(fs.statSync(`${installed}/edit-ffmpeg`).mode & 0o777).toBe(0o755);
    // No edit binary: nothing is touched.
    fs.rmSync(`${unpacked}/edit`);
    expect(() => swapAll(unpacked, running)).toThrow("the update has no edit binary");
  } finally {
    cleanup();
  }
});

test("a dev build doesn't update itself, and says so", async () => {
  expect(enabled()).toBe(false);
  expect(assetTarget()).toMatch(/^(aarch64|x86_64)-(apple-darwin|unknown-linux-gnu)$/);
  const updater = new Updater("/nonexistent");
  expect(await updater.status()).toMatchObject({ latest: null, phase: "idle", progress: 0, error: null, enabled: false });
  expect(() => updater.start()).toThrow("this build doesn't update itself; pull and rebuild");
});
