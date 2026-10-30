import { expect, test } from "bun:test";

import * as fs from "node:fs";

import { ahead, appBundle, assetTarget, building, feedTags, installApp, enabled, latestBuild, newer, programs, readChannel, swapAll, Updater } from "../src/update.ts";
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

test("edit_inside_an_app_is_found_by_its_path", () => {
  expect(appBundle("/Applications/Edit.app/Contents/Resources/edit")).toBe("/Applications/Edit.app");
  expect(appBundle("/Users/a/.local/bin/edit")).toBeNull();
  expect(appBundle("/Applications/Edit.app/Contents/MacOS/edit-window")).toBeNull();
});

/** The whole app is replaced from its zip (signature checked), and the server to restart into is at the same path. */
test.skipIf(process.platform !== "darwin")("an_app_update_replaces_the_whole_app", () => {
  const { dir, cleanup } = scratch("update-app");
  try {
    const make = (at: string, text: string) => {
      fs.mkdirSync(`${at}/Contents/Resources`, { recursive: true });
      fs.mkdirSync(`${at}/Contents/MacOS`, { recursive: true });
      fs.writeFileSync(`${at}/Contents/Info.plist`, '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.spheceo.edit.test</string><key>CFBundleExecutable</key><string>w</string></dict></plist>');
      fs.writeFileSync(`${at}/Contents/MacOS/w`, "#!/bin/sh\n", { mode: 0o755 });
      fs.writeFileSync(`${at}/Contents/Resources/edit`, text, { mode: 0o755 });
      expect(Bun.spawnSync(["codesign", "-s", "-", "-f", "--deep", at]).exitCode).toBe(0);
    };
    make(`${dir}/apps/Edit.app`, "old");
    fs.writeFileSync(`${dir}/apps/Edit.app/Contents/Resources/leftover`, "from the old app");
    make(`${dir}/build/Edit.app`, "new");
    expect(Bun.spawnSync(["ditto", "-c", "-k", "--keepParent", `${dir}/build/Edit.app`, `${dir}/Edit.zip`]).exitCode).toBe(0);
    expect(installApp(`${dir}/Edit.zip`, `${dir}/apps/Edit.app`)).toBe(`${dir}/apps/Edit.app/Contents/Resources/edit`);
    expect(fs.readFileSync(`${dir}/apps/Edit.app/Contents/Resources/edit`, "utf8")).toBe("new");
    expect(fs.existsSync(`${dir}/apps/Edit.app/Contents/Resources/leftover`)).toBe(false);
    expect(fs.readdirSync(`${dir}/apps`)).toEqual(["Edit.app"]);
    // A broken signature is refused, and the installed app is left alone.
    make(`${dir}/bad/Edit.app`, "tampered");
    fs.writeFileSync(`${dir}/bad/Edit.app/Contents/Resources/edit`, "changed after signing");
    expect(Bun.spawnSync(["ditto", "-c", "-k", "--keepParent", `${dir}/bad/Edit.app`, `${dir}/Bad.zip`]).exitCode).toBe(0);
    expect(() => installApp(`${dir}/Bad.zip`, `${dir}/apps/Edit.app`)).toThrow("signature is broken");
    expect(fs.readFileSync(`${dir}/apps/Edit.app/Contents/Resources/edit`, "utf8")).toBe("new");
    expect(fs.readdirSync(`${dir}/apps`)).toEqual(["Edit.app"]);
  } finally {
    cleanup();
  }
});

test("the releases feed's tags: every tag, sorted", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(`<feed><entry><link href="https://github.com/spheceo/edit/releases/tag/nightly-2"/></entry><entry><link href="https://github.com/spheceo/edit/releases/tag/v0.0.0"/></entry><entry><link href="https://github.com/spheceo/edit/releases/tag/nightly-1"/></entry></feed>`),
  });
  try {
    expect(await feedTags(`http://localhost:${server.port}/releases.atom`)).toBe("nightly-1 nightly-2 v0.0.0");
  } finally {
    void server.stop(true);
  }
});

test("a tag in the feed whose build isn't out yet is asked about again soon, a stale draft isn't", () => {
  // nightly-15 running; nightly-16 pushed, its build still uploading (Oct 24).
  expect(building("nightly-14 nightly-15 nightly-16", "nightly", null, "0.0.0", 15)).toBe(true);
  // Published and offered: nothing more to wait for.
  expect(building("nightly-14 nightly-15 nightly-16", "nightly", "nightly-16", "0.0.0", 15)).toBe(false);
  // nightly-14's build failed and stays a draft: once nightly-16 is offered it doesn't count.
  expect(building("nightly-14 nightly-15 nightly-16", "nightly", "nightly-16", "0.0.0", 13)).toBe(false);
  // Nothing ahead of this build.
  expect(building("nightly-14 nightly-15", "nightly", null, "0.0.0", 15)).toBe(false);
  // Stable waits only for releases.
  expect(building("nightly-16 v0.0.0", "stable", null, "0.0.0", 15)).toBe(false);
  expect(building("v0.0.0 v0.0.1", "stable", null, "0.0.0", null)).toBe(true);
  expect(building("v0.0.0 v0.0.1", "stable", "v0.0.1", "0.0.0", null)).toBe(false);
});
