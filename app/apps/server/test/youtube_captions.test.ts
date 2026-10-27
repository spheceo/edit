import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { captionRange, MODEL, parseCaptions, writeCaptionTranscript } from "../src/youtube_captions.ts";
import { fixtureHome } from "./helpers/home.ts";
import { media } from "./helpers/model.ts";
import { transcriptOf } from "../src/captions_core.ts";
import { voicesFor, type Answer } from "../src/watch.ts";
import { MockServer } from "./mocks/server.ts";
import * as tools from "../src/tools.ts";

const data = { events: [{ tStartMs: 10_000, segs: [{ utf8: ">>", tOffsetMs: 0 }, { utf8: "Hello", tOffsetMs: 100 }, { utf8: "there.", tOffsetMs: 600 }, { utf8: "[Music]", tOffsetMs: 1500 }, { utf8: ">>Yes.", tOffsetMs: 2000 }] }] };

test("word captions keep turns, silence and source times; line captions cannot invent cut edges", () => {
  const transcript = parseCaptions(data)!;
  expect(transcript.model).toBe(MODEL);
  expect(transcript.words.map((word) => [word.text, word.start, word.end, word.speaker])).toEqual([
    ["Hello", 10.1, 10.4, "caption_turn_1"], ["there.", 10.6, 10.9, "caption_turn_1"], ["Yes.", 12, 12.18, "caption_turn_2"],
  ]);
  expect(parseCaptions({ events: [{ tStartMs: 10, segs: [{ utf8: "A whole sentence timed only as one line.", tOffsetMs: 0 }] }] })).toBeNull();
  expect(captionRange("youtube:abcdefghijk#10000-11000")).toEqual({ id: "abcdefghijk", start: 10, end: 11 });
  expect(captionRange("sha256:abcdefghijk")).toBeNull();
});

test("the existing subject watcher can map separate caption turns back to the same person", () => {
  const watched: Answer = { people: [{ id: "A", look: "", place: "", on_screen: true, name: "", role: "officer" }, { id: "B", look: "", place: "", on_screen: true, name: "", role: "suspect" }],
    lines: ["A", "B", "A"].map((who, n) => ({ n, who, sure: "high", or: null })), segments: [], background: [] };
  const voices = voicesFor(watched, ["caption_turn_1", "caption_turn_2", "caption_turn_3"], new Map(), new Set(["caption_turn_1", "caption_turn_2", "caption_turn_3"]));
  expect(voices.get("A")).not.toBe(voices.get("B"));
  expect(["caption_turn_1", "caption_turn_3"]).toContain(voices.get("A") ?? "");
});

function fake(home: string, payload: unknown, language = "en-orig", exitCode = 0) {
  const file = `${home}/yt-dlp`;
  fs.writeFileSync(file, `#!/usr/bin/env bun\nconst args = process.argv.slice(2);\nconst out = args[args.indexOf('-o') + 1];\nawait Bun.write(${JSON.stringify(`${home}/args.json`)}, JSON.stringify(args));\nawait Bun.write(${JSON.stringify(`${home}/calls`)}, String(Number(await Bun.file(${JSON.stringify(`${home}/calls`)}).text().catch(() => '0')) + 1));\n${payload === null ? "" : `await Bun.write(out + ${JSON.stringify(`.${language}.json3`)}, ${JSON.stringify(JSON.stringify(payload))});`}\nprocess.exitCode = ${exitCode};\n`, { mode: 0o755 });
  return file;
}

test("one caption fetch serves concurrent excerpts with their own clocks and keeps explicit provenance", async () => {
  const home = fixtureHome("caption-excerpts");
  const previous = process.env.EDIT_YTDLP;
  try {
    process.env.EDIT_YTDLP = fake(home.dir, data);
    const targets = [`${home.dir}/a.json`, `${home.dir}/b.json`];
    expect(await Promise.all(targets.map((target, index) => writeCaptionTranscript(home.home, `youtube:abcdefghijk#${10000 + index * 1000}-${11000 + index * 2000}`, target)))).toEqual([true, true]);
    expect(JSON.parse(fs.readFileSync(targets[0]!, "utf8"))).toMatchObject({ model: MODEL, words: [{ text: "Hello", start: 0.1 }, { text: "there.", start: 0.6 }] });
    expect(JSON.parse(fs.readFileSync(targets[1]!, "utf8"))).toMatchObject({ words: [{ text: "Yes.", start: 1 }] });
    expect(fs.readFileSync(`${home.dir}/calls`, "utf8")).toBe("1");
    expect(await writeCaptionTranscript(home.home, "youtube:abcdefghijk", `${home.dir}/whole.json`)).toBe(true);
    expect(fs.readFileSync(`${home.dir}/calls`, "utf8")).toBe("1");
  } finally { if (previous === undefined) delete process.env.EDIT_YTDLP; else process.env.EDIT_YTDLP = previous; home.cleanup(); }
});

test("missing captions fall back without repeatedly probing every excerpt", async () => {
  const home = fixtureHome("caption-unavailable");
  const previous = process.env.EDIT_YTDLP;
  try {
    process.env.EDIT_YTDLP = fake(home.dir, null);
    expect(await writeCaptionTranscript(home.home, "youtube:abcdefghijk", `${home.dir}/first.json`)).toBe(false);
    expect(await writeCaptionTranscript(home.home, "youtube:abcdefghijk#1000-2000", `${home.dir}/second.json`)).toBe(false);
    expect(fs.existsSync(`${home.dir}/first.json`)).toBe(false);
    expect(fs.readFileSync(`${home.dir}/calls`, "utf8")).toBe("1");
  } finally { if (previous === undefined) delete process.env.EDIT_YTDLP; else process.env.EDIT_YTDLP = previous; home.cleanup(); }
});

test("the media processor uses local script source offsets and names do not trigger paid re-hearing", async () => {
  const home = fixtureHome("caption-processor");
  const mock = MockServer.start();
  mock.gatewayAnswer = JSON.stringify({ people: ["John Smith"], places: [] });
  const restore = mock.useEnv({ AI_GATEWAY_API_KEY: "gateway-test" });
  const previous = process.env.EDIT_YTDLP;
  try {
    process.env.EDIT_YTDLP = fake(home.dir, data);
    const source = `${home.dir}/excerpt.mp4`;
    fs.writeFileSync(source, "not decoded: captions come from the original YouTube source");
    const id = home.store.create("Compilation", { width: 1920, height: 1080, fps: 30 }).project.id;
    await home.store.update(id, "script", (project) => {
      project.media.push(media({ id: "m1", name: "Case", path: source, kind: "video", duration: 1, has_audio: true }));
      project.script = { blocks: [{ kind: "footage", file: "youtube:abcdefghijk", url: "https://youtu.be/abcdefghijk", label: "", start: 10.1, end: 10.9, media: "m1", media_start: 10 }, { kind: "narration", text: "John Smith was questioned by the officers about the incident that morning." }] };
    });
    home.app.media.transcribe(source, true);
    const deadline = Date.now() + 5000;
    while (home.app.media.status(source).transcript === "working" && Date.now() < deadline) await Bun.sleep(5);
    expect(home.app.media.status(source).transcript).toBe("ready");
    const project = home.store.get(id)!.project;
    const transcript = await transcriptOf(home.app, project.media[0]!, project);
    expect(transcript).toMatchObject({ model: MODEL, words: [{ text: "Hello", start: 0.1 }, { text: "there.", start: 0.6 }] });
    expect(JSON.parse(fs.readFileSync(`${home.home}/research/${id}/names.json`, "utf8")).names).toContain("John Smith");
    expect(mock.calls("/v1/transcribe")).toHaveLength(0);
    expect(fs.existsSync(home.app.media.paths(source).transcript.replace(/\.json$/u, ".ogg"))).toBe(false);
  } finally { if (previous === undefined) delete process.env.EDIT_YTDLP; else process.env.EDIT_YTDLP = previous; restore(); mock.stop(); home.cleanup(); }
});

test.skipIf(Bun.which("ffmpeg") === null)("a YouTube source without usable captions falls through the normal cached speech transcription", async () => {
  const home = fixtureHome("caption-scribe-fallback");
  const mock = MockServer.start();
  const restore = mock.useEnv();
  const previous = process.env.EDIT_YTDLP;
  try {
    tools.forget();
    process.env.EDIT_YTDLP = fake(home.dir, null);
    const source = `${home.dir}/source.mp4`;
    expect(Bun.spawnSync([Bun.which("ffmpeg")!, "-v", "error", "-f", "lavfi", "-i", "color=s=32x32:d=1", "-f", "lavfi", "-i", "sine=d=1", "-c:v", "libx264", "-c:a", "aac", "-shortest", source]).exitCode).toBe(0);
    const id = home.store.create("Compilation", { width: 1920, height: 1080, fps: 30 }).project.id;
    await home.store.update(id, "script", (project) => {
      project.media.push(media({ id: "m1", name: "No captions", path: source, kind: "video", duration: 1, has_audio: true }));
      project.script = { blocks: [{ kind: "footage", file: "youtube:abcdefghijk", url: "https://youtu.be/abcdefghijk", label: "", start: 0, end: 1, media: "m1" }] };
    });
    home.app.media.transcribe(source, true);
    const deadline = Date.now() + 5000;
    while (home.app.media.status(source).transcript === "working" && Date.now() < deadline) await Bun.sleep(5);
    expect(home.app.media.status(source).transcript).toBe("ready");
    expect(JSON.parse(fs.readFileSync(home.app.media.paths(source).transcript, "utf8")).model).toBe("scribe_v2");
    expect(mock.calls("/v1/transcribe")).toHaveLength(1);
    home.app.media.transcribe(source, true);
    expect(mock.calls("/v1/transcribe")).toHaveLength(1);
  } finally {
    if (previous === undefined) delete process.env.EDIT_YTDLP; else process.env.EDIT_YTDLP = previous;
    restore(); mock.stop(); home.cleanup();
  }
});

test("alternate English word captions work in existing cloud-backed projects without script blocks or re-hearing finished media", async () => {
  const home = fixtureHome("caption-existing-cloud");
  const previous = process.env.EDIT_YTDLP;
  try {
    // A later requested track failed after this usable track was written.
    process.env.EDIT_YTDLP = fake(home.dir, data, "en-US", 1);
    const source = `${home.dir}/old-cloud-proxy.mp4`;
    fs.writeFileSync(source, "existing imported proxy; no decode needed");
    const id = home.store.create("Existing", { width: 1920, height: 1080, fps: 30 }).project.id;
    await home.store.update(id, "test", (project) => {
      project.media.push(media({ id: "m", name: "Earlier YouTube import", path: source, kind: "video", duration: 1, has_audio: true, cloud: { source: "youtube:abcdefghijk#10000-11000", original: "edit/originals/youtube/abcdefghijk.mp4", proxy: "edit/proxies/youtube/abcdefghijk/10000-11000.mp4", size: 100 } }));
    });
    home.app.media.transcribe(source, true);
    const deadline = Date.now() + 5000;
    while (home.app.media.status(source).transcript === "working" && Date.now() < deadline) await Bun.sleep(5);
    expect(home.app.media.status(source).transcript).toBe("ready");
    const target = home.app.media.paths(source).transcript;
    const transcript = JSON.parse(fs.readFileSync(target, "utf8"));
    expect(transcript).toMatchObject({ model: MODEL, words: [{ text: "Hello", start: 0.1 }, { text: "there.", start: 0.6 }] });
    const args = JSON.parse(fs.readFileSync(`${home.dir}/args.json`, "utf8")) as string[];
    expect(args).toContain("--js-runtimes");
    expect(args).toContain("--write-subs");
    expect(args).toContain("--write-auto-subs");
    expect(args).toContain("en-orig,en,en-US,en-GB");
    home.app.media.transcribe(source, true);
    expect(fs.readFileSync(`${home.dir}/calls`, "utf8")).toBe("1");
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual(transcript);
  } finally { if (previous === undefined) delete process.env.EDIT_YTDLP; else process.env.EDIT_YTDLP = previous; home.cleanup(); }
});
