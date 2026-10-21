import { expect, test } from "bun:test";

import * as fs from "node:fs";

import { ahead, assetTarget, enabled, latestBuild, newer, programs, readChannel, swapAll, Updater } from "../src/update.ts";
import { scratch } from "./helpers/home.ts";

test("newer_compares_numerically", () => {
  expect(newer("0.1.10", "0.1.9")).toBe(true);
  expect(newer("v1.0.0", "0.9.9")).toBe(true);
  expect(newer("0.1.0", "0.1.0")).toBe(false);
  expect(newer("0.0.9", "0.1.0")).toBe(false);
  expect(newer("0.2.0-beta", "0.1.0")).toBe(false);
  expect(newer("garbage", "0.1.0")).toBe(false);
});

/** A nightly goes by its number, a release by its version; a release build (no number) takes any nightly. */
test("nightlies_and_releases_are_ahead_by_their_own_measure", () => {
  expect(ahead("nightly-3", "0.0.0", null)).toBe(true);
  expect(ahead("nightly-3", "0.0.0", 2)).toBe(true);
  expect(ahead("nightly-3", "0.0.0", 3)).toBe(false);
  expect(ahead("nightly-12", "0.0.0", 9)).toBe(true);
  expect(ahead("v0.0.1", "0.0.0", 7)).toBe(true);
  expect(ahead("v0.0.0", "0.0.0", 7)).toBe(false);
  expect(ahead("nightly-x", "0.0.0", null)).toBe(false);
});

/** The newest build is whichever came out last (nightly or release), with an archive for this machine; drafts never count. */
test("the_newest_build_is_the_one_published_last", () => {
  const asset = { name: `edit-${assetTarget()}.tar.gz` };
  const release = (tag: string, published: string | null, extra: Record<string, unknown> = {}) => ({
    tag_name: tag,
    published_at: published,
    draft: false,
    prerelease: tag.startsWith("nightly-"),
    assets: [asset],
    ...extra,
  });
  const list = [
    release("nightly-7", null, { draft: true }),
    release("nightly-6", "2026-10-24T09:00:00Z", { assets: [{ name: "edit-other.tar.gz" }] }),
    release("v0.0.1", "2026-10-23T09:00:00Z"),
    release("nightly-5", "2026-10-22T09:00:00Z"),
    release("v0.0.0", "2026-10-21T09:00:00Z"),
  ];
  expect(latestBuild(list)?.tag_name).toBe("v0.0.1");
  expect(latestBuild(list.slice(3))?.tag_name).toBe("nightly-5");
  expect(latestBuild([])).toBeNull();
});

/** The channel is nightly unless set to stable, and kept in the data folder. */
test("the_channel_is_kept_and_defaults_to_nightly", async () => {
  const { dir, cleanup } = scratch("update-channel");
  try {
    expect(readChannel(dir)).toBe("nightly");
    const updater = new Updater(dir);
    expect(await updater.setChannel("stable")).toMatchObject({ channel: "stable", latest: null });
    expect(readChannel(dir)).toBe("stable");
    expect((await new Updater(dir).status()).channel).toBe("stable");
    await expect(updater.setChannel("beta")).rejects.toThrow("no such channel");
    expect(readChannel(dir)).toBe("stable");
  } finally {
    cleanup();
  }
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
  expect(await updater.status()).toMatchObject({ latest: null, channel: "nightly", phase: "idle", progress: 0, error: null, enabled: false });
  expect(() => updater.start()).toThrow("this build doesn't update itself; pull and rebuild");
});
