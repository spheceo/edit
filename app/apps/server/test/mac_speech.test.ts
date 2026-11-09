import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import * as macSpeech from "../src/mac_speech.ts";
import { scratch } from "./helpers/home.ts";

const dir = scratch("mac-speech");
afterAll(() => dir.cleanup());

// macOS 26 is Darwin 25: there, a checkout builds edit-speech on demand.
const mac26 = process.platform === "darwin" && Number(os.release().split(".")[0]) >= 25;
const built = await macSpeech.available();
// Hearing needs Apple's model, downloaded on first use: not something GitHub's
// virtual Mac can be counted on for, so there only the build is checked.
const here = built && process.env.GITHUB_ACTIONS === undefined;

test.skipIf(!mac26)("on macOS 26 edit-speech builds and is available", () => {
  expect(built).toBe(true);
});

test("with no helper, on-device speech isn't available and hearing says why", async () => {
  macSpeech.timing.helper = `${dir.dir}/no-such-edit-speech`;
  try {
    expect(await macSpeech.available()).toBe(false);
    macSpeech.timing.helper = null;
    expect(await macSpeech.available()).toBe(false);
    await expect(macSpeech.hear(`${dir.dir}/a.wav`, `${dir.dir}/a.json`)).rejects.toThrow(/macOS 26/u);
  } finally {
    macSpeech.timing.helper = undefined;
  }
});

test.skipIf(!here)("a spoken clip is heard on this Mac as timed words, written as Edit's transcript", async () => {
  const clip = `${dir.dir}/spoken.aiff`;
  const said = Bun.spawnSync(["say", "-o", clip, "The officer knocked on the door and asked the man to step outside."]);
  expect(said.exitCode).toBe(0);
  const target = `${dir.dir}/out/spoken.json`;
  const heard = await macSpeech.hear(clip, target);
  expect(heard.model).toBe(macSpeech.MODEL);
  expect(macSpeech.MODEL).toBe("apple-speech");
  expect(heard.language).toBe("en-US");
  const text = heard.words.map((word) => word.text.toLowerCase().replace(/[^a-z]/gu, "")).join(" ");
  expect(text).toContain("officer knocked on the door");
  for (const [index, word] of heard.words.entries()) {
    expect(word.speaker).toBeUndefined();
    expect(word.end).toBeGreaterThanOrEqual(word.start);
    if (index > 0) expect(word.start).toBeGreaterThanOrEqual(heard.words[index - 1]!.start);
  }
  expect(heard.words.at(-1)!.start).toBeGreaterThan(heard.words[0]!.start);
  const saved = JSON.parse(fs.readFileSync(target, "utf8"));
  expect(saved.model).toBe("apple-speech");
  expect(saved.words).toEqual(heard.words);
}, 120_000);

test.skipIf(!here)("an unreadable file is refused with the helper's reason", async () => {
  const bad = `${dir.dir}/bad.wav`;
  fs.writeFileSync(bad, "not sound");
  await expect(macSpeech.hear(bad, `${dir.dir}/bad.json`)).rejects.toThrow(/can't read bad\.wav/u);
  expect(fs.existsSync(`${dir.dir}/bad.json`)).toBe(false);
}, 60_000);

test.skipIf(!here)("an aborted hearing stops and rejects", async () => {
  const clip = `${dir.dir}/long.aiff`;
  Bun.spawnSync(["say", "-o", clip, "One two three four five six seven eight nine ten. ".repeat(6)]);
  const controller = new AbortController();
  const heard = macSpeech.hear(clip, `${dir.dir}/long.json`, controller.signal);
  setTimeout(() => controller.abort(), 300);
  await expect(heard).rejects.toThrow();
  expect(fs.existsSync(`${dir.dir}/long.json`)).toBe(false);
}, 60_000);
