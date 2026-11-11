// writer/links.ts: a video linked in a revision of a built script comes in
// whole as a recording of its own, heard whole by Scribe, before Claude places it.

import { afterAll, afterEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs";

import type { Script, Word } from "@edit/types/writer";

import * as realHearing from "../../src/writer/hearing.ts";
import * as realReuse from "../../src/writer/reuse.ts";
import * as realScripting from "../../src/writer/scripting.ts";
import { ffmpeg } from "../../src/tools.ts";
import { fixtureHome } from "../helpers/home.ts";

// Scribe, the turns pass and Claude's revision stand in, only while this file's tests run (a module stood in for
// stays so for the test files after it in the same run).
const standIn = { on: true };
afterAll(() => {
  standIn.on = false;
});
// The real ones kept first: once a module is stood in for, its own names point at the stand-ins, and a stand-in
// calling "the real one" through them calls itself (every later test file's hearing then never ends).
const real = { hear: realHearing.hear, nameNewVoices: realReuse.nameNewVoices, reviseWith: realScripting.reviseWith };
const heardFiles: string[] = [];
const told: string[] = [];
void mock.module("../../src/writer/hearing.ts", () => ({
  ...realHearing,
  hear: async (...args: Parameters<typeof realHearing.hear>) => {
    if (!standIn.on) return real.hear(...args);
    heardFiles.push(args[0]);
    expect(args[1]).toBeNull();
    return { model: "scribe_v3", language: "en", words: [{ text: "Hands", start: 0.2, end: 0.5, speaker: "speaker_0" }, { text: "up", start: 0.5, end: 0.8, speaker: "speaker_0" }] };
  },
}));
void mock.module("../../src/writer/reuse.ts", () => ({
  ...realReuse,
  nameNewVoices: async (...args: Parameters<typeof realReuse.nameNewVoices>) => {
    if (!standIn.on) return real.nameNewVoices(...args);
    const [now, , added, tag] = args;
    for (const word of now.words.slice(now.words.length - added)) word.speaker = `${tag}:p9`;
    now.speakers = { ...(now.speakers ?? {}), [`${tag}:p9`]: "Officer" };
  },
}));
void mock.module("../../src/writer/scripting.ts", () => ({
  ...realScripting,
  reviseWith: async (...args: Parameters<typeof realScripting.reviseWith>) => {
    if (!standIn.on) return real.reviseWith(...args);
    told.push(args[2]);
    return ["Put it after the intro.", 0.01];
  },
}));

const { bringLinks } = await import("../../src/writer/links.ts");
const store = await import("../../src/writer/store.ts");
const media = await import("../../src/writer/media.ts");

const restore = process.env.EDIT_YTDLP;
afterEach(() => {
  if (restore === undefined) delete process.env.EDIT_YTDLP;
  else process.env.EDIT_YTDLP = restore;
});

function make(args: string[], out: string): void {
  const done = Bun.spawnSync([ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", ...args, out]);
  if (done.exitCode !== 0) throw new Error(done.stderr.toString());
}

const ID = "5d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f4a";
const word = (text: string, startMs: number): Word => ({ id: `w${startMs}`, text, startMs, endMs: startMs + 400, speaker: "p1" });

test("a video linked in a revision joins the script as its own recording, heard whole, then the revision places it", async () => {
  const fx = fixtureHome("writer-links");
  try {
    // A built single-video script: its preview, words and a cut-in.
    const data = store.dataDir(fx.app.store.home);
    const dir = store.scriptDir(data, ID);
    fs.mkdirSync(dir, { recursive: true });
    const source = `${fx.dir}/case.mp4`;
    make(["-f", "lavfi", "-i", "testsrc=s=640x360:d=3", "-f", "lavfi", "-i", "sine=d=3", "-shortest"], source);
    await media.join([{ path: source, streams: await media.streams(source) }], store.proxyPath(dir));
    const lengthMs = (await media.streams(store.proxyPath(dir))).durationMs;
    fs.mkdirSync(`${dir}/transcript/whole`, { recursive: true });
    fs.writeFileSync(`${dir}/transcript/whole/transcript.json`, "{}");
    store.write(dir, {
      id: ID, title: "Traffic stop", sourceKind: "youtube", sourceUrl: "https://www.youtube.com/watch?v=4mqGp1IgqEw", originalPath: store.proxyPath(dir),
      status: "ready", stage: "", progress: 100, error: null, durationMs: lengthMs, revision: 4, createdAt: 0, updatedAt: 0, overview: [], proxyPath: null,
      speakers: { p1: "Driver" }, words: [word("license", 500), word("please", 1_000)],
      clips: [{ id: "c0", kind: "cut-in", startMs: 0, endMs: 0, narration: "It began." }, { id: "c1", startMs: 400, endMs: 1_500 }],
    } as unknown as Script);
    // The linked page's video, as a stand-in yt-dlp gives it.
    const linked = `${fx.dir}/linked.mp4`;
    make(["-f", "lavfi", "-i", "testsrc=s=1280x720:d=2", "-f", "lavfi", "-i", "sine=f=330:d=2", "-shortest"], linked);
    fs.writeFileSync(`${fx.dir}/yt-dlp`, `#!/bin/sh
for arg in "$@"; do case "$prev" in -P) out="$arg";; esac; prev="$arg"; done
cp "${linked}" "$out/Dashcam [x1].mp4"
echo "EDIT-FILE $out/Dashcam [x1].mp4"
`, { mode: 0o755 });
    process.env.EDIT_YTDLP = `${fx.dir}/yt-dlp`;
    const stages: string[] = [];
    const job = { id: ID, signal: new AbortController().signal, stage: (text: string) => void stages.push(text) };
    const request = "Add this right after the intro: https://news.example.com/dashcam";
    const [answer] = await bringLinks(fx.app, data, ID, ["https://news.example.com/dashcam"], request, { kind: "none" } as never, job);
    expect(answer).toBe("Put it after the intro.");

    const now = store.read(dir);
    // Recording 1 is the script's own footage; Recording 2 the link's, after it on the clock.
    expect(now.parts).toHaveLength(2);
    expect(now.parts![0]).toMatchObject({ title: "Traffic stop", startMs: 0, durationMs: lengthMs, url: "https://www.youtube.com/watch?v=4mqGp1IgqEw" });
    expect(now.parts![1]).toMatchObject({ title: "Dashcam", startMs: lengthMs, url: "https://news.example.com/dashcam", audio: false });
    expect(now.durationMs).toBeGreaterThanOrEqual(lengthMs + 1_900);
    expect((await media.streams(store.proxyPath(dir))).durationMs).toBeGreaterThanOrEqual(lengthMs + 1_900);
    // Heard whole from the download itself; its words on the script's clock, its voice its recording's.
    expect(heardFiles).toHaveLength(1);
    expect(heardFiles[0]).toEndWith("Dashcam [x1].mp4");
    const added = now.words.slice(2);
    expect(added.map((one) => one.text)).toEqual(["Hands", "up"]);
    expect(added[0]!.startMs).toBe(lengthMs + 200);
    expect(added.every((one) => one.speaker === "2:p9" && one.id.startsWith("w-"))).toBe(true);
    expect(now.words.slice(0, 2).map((one) => one.speaker)).toEqual(["p1", "p1"]);
    expect(now.speakers).toMatchObject({ p1: "Driver", "2:p9": "Officer" });
    // Counted as heard exactly, and the whole file's hearing kept for Recording 1.
    expect(now.exact).toContainEqual([lengthMs, lengthMs + now.parts![1]!.durationMs]);
    expect(fs.existsSync(`${dir}/transcript/part-01/transcript.json`)).toBe(true);
    expect(now.revision).toBe(5);
    // Then Claude revised on the message, told which recording is new.
    expect(told[0]).toContain(request);
    expect(told[0]).toContain('Recording 2 ("Dashcam") is the footage from https://news.example.com/dashcam');
    expect(stages.some((stage) => stage.startsWith("Downloading “Dashcam”"))).toBe(true);
    expect(stages).toContain("Transcribing “Dashcam”");
    expect(stages.at(-1)).toBe("Editing the script");

    // Edit finds it by its link, so Start the edit takes its words (Nov 11: a YouTube script's linked recording had no
    // source, its words weren't shared and Edit would have heard it again); a link Edit can't fetch is by its original.
    const { partSources } = await import("../../src/writer/parts.ts");
    const withYoutube = { ...now, parts: [now.parts![0]!, { ...now.parts![1]!, title: "Bodycam 4", url: "https://youtu.be/abcdefghijk" }] };
    expect(partSources(dir, withYoutube)).toEqual([["youtube:4mqGp1IgqEw", "Traffic stop [4mqGp1IgqEw].mp4"], ["youtube:abcdefghijk", "Bodycam 4 [abcdefghijk].mp4"]]);
    const original = `sha256:${"a".repeat(64)}`;
    const withPage = { ...now, parts: [now.parts![0]!, { ...now.parts![1]!, mediaSource: original, originalKey: `edit/originals/sha256/${"a".repeat(64)}/Dashcam [x1].mp4` }] };
    expect(partSources(dir, withPage)[1]).toEqual([original, "Dashcam [x1].mp4"]);

    // Carried on after a restart, the same link isn't added twice.
    await bringLinks(fx.app, data, ID, ["https://news.example.com/dashcam"], request, { kind: "none" } as never, { ...job, resumed: true });
    expect(store.read(dir).parts).toHaveLength(2);
    expect(heardFiles).toHaveLength(1);
  } finally {
    fx.cleanup();
  }
}, 120_000);
