import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { captionRange, MODEL, NoWords, parse, read, select, USES, words, hearing, writeCaptionTranscript } from "../src/youtube_words.ts";
import * as youtube from "../src/youtube.ts";
import { fixtureHome } from "./helpers/home.ts";
import { media } from "./helpers/model.ts";
import { transcriptOf } from "../src/captions_core.ts";
import { voicesFor, type Answer } from "../src/watch.ts";
import { MockServer } from "./mocks/server.ts";
import * as tools from "../src/tools.ts";

const data = { events: [{ tStartMs: 10_000, segs: [{ utf8: ">>", tOffsetMs: 0 }, { utf8: "Hello", tOffsetMs: 100 }, { utf8: "there.", tOffsetMs: 600 }, { utf8: "[Music]", tOffsetMs: 1500 }, { utf8: ">>Yes.", tOffsetMs: 2000 }] }] };

test("word captions keep turns, silence and source times; line captions cannot invent cut edges", () => {
  const transcript = parse(data);
  expect(transcript.model).toBe(MODEL);
  expect(transcript.words.map((word) => [word.text, word.start, word.end, word.speaker])).toEqual([
    ["Hello", 10.1, 10.4, "caption_turn_1"], ["there.", 10.6, 10.9, "caption_turn_1"], ["Yes.", 12, 12.18, "caption_turn_2"],
  ]);
  // A track timed only by the line is one a reader may take (an idea) and a cutter may not (an import's footage).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caption-cues-"));
  fs.writeFileSync(path.join(dir, "captions.en.json3"), JSON.stringify({ events: [{ tStartMs: 10, dDurationMs: 3000, segs: [{ utf8: "A whole sentence timed only as one line.", tOffsetMs: 0 }] }] }));
  expect(select(dir, null, USES.footage.cues)).toBeNull();
  expect(select(dir, null, USES.idea.cues)).toMatchObject({ language: "en", timed: false });
  fs.rmSync(dir, { recursive: true, force: true });
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
  mock.modelAnswer = JSON.stringify({ people: ["John Smith"], places: [] });
  const restore = mock.useEnv();
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
    expect(args).toContain("en-orig,en.*");
    home.app.media.transcribe(source, true);
    expect(fs.readFileSync(`${home.dir}/calls`, "utf8")).toBe("1");
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual(transcript);
  } finally { if (previous === undefined) delete process.env.EDIT_YTDLP; else process.env.EDIT_YTDLP = previous; home.cleanup(); }
});

// ── Asking YouTube over a use's ways (JJ, Nov 10: ten ideas "skipped: YouTube has no English captions" for videos that had them; YouTube had turned the proxy's address away) ──

const BOT = "ERROR: [youtube] abcdefghijk: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.";

/** A yt-dlp stand-in whose `body` (JavaScript: `args`, `proxied`, `n` the call's number, `put(language, json)`, `refuse(line)`) says what each call does; every call's arguments are kept. */
function ytdlp(dir: string, body: string): { calls: () => string[][] } {
  const file = `${dir}/yt-dlp`;
  const log = `${dir}/asked.jsonl`;
  fs.writeFileSync(
    file,
    `#!/usr/bin/env bun
import * as fs from "node:fs";
const args = process.argv.slice(2);
const proxied = args.includes("--proxy");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const n = fs.readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").length;
const out = args[args.indexOf("-o") + 1];
const put = (language, json) => fs.writeFileSync(out + "." + language + ".json3", JSON.stringify(json));
const refuse = (line) => { console.error(line); process.exit(1); };
${body}
`,
    { mode: 0o755 },
  );
  process.env.EDIT_YTDLP = file;
  return { calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) : []) };
}

/** A home with a proxy, no waits and no refusals remembered; `done` puts everything back. */
function asking(name: string) {
  const home = fixtureHome(name);
  const before = { ytdlp: process.env.EDIT_YTDLP, proxy: process.env.PROXY_URL, pause: youtube.timing.pause, hear: hearing.hear };
  process.env.PROXY_URL = "http://someone:secret@proxy.test:823";
  youtube.timing.pause = async () => {};
  youtube.forgetRefusals();
  return {
    ...home,
    done: () => {
      if (before.ytdlp === undefined) delete process.env.EDIT_YTDLP; else process.env.EDIT_YTDLP = before.ytdlp;
      if (before.proxy === undefined) delete process.env.PROXY_URL; else process.env.PROXY_URL = before.proxy;
      youtube.timing.pause = before.pause;
      hearing.hear = before.hear;
      youtube.forgetRefusals();
      home.cleanup();
    },
  };
}

test("an idea's captions come straight only when YouTube turns the proxy away, and the proxy is asked first every time", async () => {
  const home = asking("words-proxy-refused");
  try {
    const fake = ytdlp(home.dir, `if (proxied) refuse(${JSON.stringify(BOT)});\nput("en-orig", ${JSON.stringify(data)});`);
    const transcript = await words(home.home, "abcdefghijk", USES.idea);
    expect(transcript).toMatchObject({ model: MODEL, words: [{ text: "Hello" }, { text: "there." }, { text: "Yes." }] });
    expect(fake.calls().map((args) => args.includes("--proxy"))).toEqual([true, false]);
    // Kept where an import finds them: its excerpt asks nobody.
    expect(await writeCaptionTranscript(home.home, "youtube:abcdefghijk#10000-11000", `${home.dir}/excerpt.json`)).toBe(true);
    expect(fake.calls()).toHaveLength(2);
    // Sparing of this Mac's address: the next case asks the proxy first again, refused a moment ago or not.
    await words(home.home, "bcdefghijkl", USES.idea);
    expect(fake.calls().slice(2).map((args) => args.includes("--proxy"))).toEqual([true, false]);
    // An import, whose video came down straight anyway, asks a way turned away lately last.
    expect(await read(home.home, "cdefghijklm", USES.footage)).not.toBeNull();
    expect(fake.calls().slice(4).map((args) => args.includes("--proxy"))).toEqual([false]);
  } finally { home.done(); }
});

test("an idea's straight asks go one at a time with a rest between, and none for a while once YouTube refuses this address", async () => {
  const home = asking("words-sparing");
  try {
    // Each ask says when it began and ended; the proxy is always refused.
    const fake = ytdlp(home.dir, `if (proxied) refuse(${JSON.stringify(BOT)});\nfs.appendFileSync(${JSON.stringify(`${home.dir}/spans`)}, "b");\nawait Bun.sleep(150);\nfs.appendFileSync(${JSON.stringify(`${home.dir}/spans`)}, "e");\nif (args.at(-1).endsWith("refusedhere")) refuse(${JSON.stringify(BOT)});\nput("en-orig", ${JSON.stringify(data)});`);
    const rests: number[] = [];
    youtube.timing.pause = async (ms) => {
      rests.push(ms);
    };
    await Promise.all(["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"].map((id) => words(home.home, id, USES.idea)));
    // Three cases at once: their straight asks never overlapped, and each was followed by its rest.
    expect(fs.readFileSync(`${home.dir}/spans`, "utf8")).toBe("bebebe");
    expect(rests.filter((ms) => ms === 10_000)).toHaveLength(3);
    // YouTube refuses this address: the next cases ask the proxy and leave the address alone.
    const before = fake.calls().length;
    expect(await words(home.home, "refusedhere", USES.idea).catch((error: unknown) => error)).toBeInstanceOf(NoWords);
    expect(fake.calls().slice(before).map((args) => args.includes("--proxy"))).toEqual([true, false]);
    const after = fake.calls().length;
    expect(await words(home.home, "ddddddddddd", USES.idea).catch((error: unknown) => error)).toBeInstanceOf(NoWords);
    expect(fake.calls().slice(after).map((args) => args.includes("--proxy"))).toEqual([true]);
  } finally { home.done(); }
});

test("turned away on every way is said as that, never as a video without captions, and isn't kept as one", async () => {
  const home = asking("words-refused");
  try {
    const fake = ytdlp(home.dir, `if (n <= 2) refuse(${JSON.stringify(BOT)});\nput("en-orig", ${JSON.stringify(data)});`);
    let heard = 0;
    hearing.hear = async () => {
      heard++;
      return null;
    };
    const failure = await words(home.home, "abcdefghijk", USES.idea).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NoWords);
    expect((failure as Error).message).toContain("turned");
    expect((failure as Error).message).not.toContain("no English captions");
    expect((failure as Error).message).not.toContain("secret");
    expect(fake.calls()).toHaveLength(2);
    // Not heard: its sound would be asked of the addresses YouTube just turned away.
    expect(heard).toBe(0);
    // Asked again (Try again), YouTube answers the proxy and the captions are read: nothing said "unavailable" meanwhile.
    expect((await words(home.home, "abcdefghijk", USES.idea)).words).toHaveLength(3);
    expect(fake.calls()).toHaveLength(3);
  } finally { home.done(); }
});

test("a refused track is passed over for one that comes down; every track refused is a way turned away, not a video without captions", async () => {
  const home = asking("words-429");
  try {
    const refusedTrack = `console.error("WARNING: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests");`;
    const fake = ytdlp(home.dir, `put("en-orig", ${JSON.stringify(data)});\n${refusedTrack}`);
    expect((await read(home.home, "abcdefghijk", USES.idea))?.words).toHaveLength(3);
    expect(fake.calls()).toHaveLength(1);
    expect(fake.calls()[0]).toContain("--ignore-errors");
    // yt-dlp ends well with its only track refused: the next way is asked, and with none answering it's said as turned away.
    ytdlp(home.dir, refusedTrack);
    fs.rmSync(`${home.dir}/asked.jsonl`);
    const failure = await read(home.home, "bcdefghijkl", USES.idea).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(youtube.Unanswered);
    expect((failure as youtube.Unanswered).gone).toBe(false);
    expect(fake.calls()).toHaveLength(2);
    expect(fs.existsSync(`${home.home}/cache/youtube-captions/bcdefghijkl/unavailable.json`)).toBe(false);
  } finally { home.done(); }
});

test("a video with no captions is heard for an idea, and stays without for an import; one that's gone says so", async () => {
  const home = asking("words-none");
  try {
    const fake = ytdlp(home.dir, `if (args.at(-1).endsWith("goneeeeeeee")) refuse("ERROR: [youtube] goneeeeeeee: Video unavailable. This video has been removed by the uploader");`);
    const asked: string[] = [];
    hearing.hear = async (_home, id) => {
      asked.push(id);
      return { model: "apple-speech", language: "en-US", words: [{ text: "Heard", start: 0, end: 0.4 }] };
    };
    expect(await read(home.home, "abcdefghijk", USES.footage)).toBeNull();
    expect((await words(home.home, "abcdefghijk", USES.idea)).model).toBe("apple-speech");
    expect(asked).toEqual(["abcdefghijk"]);
    // "None" stands for a while: YouTube was asked once, by the import.
    expect(fake.calls()).toHaveLength(1);
    const gone = await words(home.home, "goneeeeeeee", USES.idea).catch((error: unknown) => error);
    expect(gone).toBeInstanceOf(NoWords);
    expect((gone as Error).message).toContain("Video unavailable");
    // No way helps a video that's gone: asked once, not heard.
    expect(fake.calls()).toHaveLength(2);
    expect(asked).toEqual(["abcdefghijk"]);
  } finally { home.done(); }
});

test("captions timed by the line serve a reader and are never handed to a cutter", async () => {
  const home = asking("words-cues");
  try {
    ytdlp(home.dir, `put("en", { events: [{ tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: "A whole sentence timed only as one line." }] }] });`);
    const read1 = await read(home.home, "abcdefghijk", USES.idea);
    expect(read1?.words.map((word) => word.text).join(" ")).toBe("A whole sentence timed only as one line.");
    expect(await read(home.home, "abcdefghijk", USES.footage)).toBeNull();
    expect(await writeCaptionTranscript(home.home, "youtube:abcdefghijk", `${home.dir}/cut.json`)).toBe(false);
  } finally { home.done(); }
});

test.skipIf(Bun.which("ffmpeg") === null)("with no captions and no Apple recogniser, the video's sound alone is fetched and Scribe hears it once", async () => {
  const home = asking("words-heard");
  const mock = MockServer.start();
  const restore = mock.useEnv();
  const macSpeech = await import("../src/mac_speech.ts");
  const helper = macSpeech.timing.helper;
  try {
    tools.forget();
    macSpeech.timing.helper = null;
    const sound = `${home.dir}/sound.m4a`;
    expect(Bun.spawnSync([Bun.which("ffmpeg")!, "-v", "error", "-f", "lavfi", "-i", "sine=d=1", "-c:a", "aac", sound]).exitCode).toBe(0);
    // Captions: none. The download: the sound alone, said the way yt-dlp says a finished file.
    const fake = ytdlp(home.dir, `if (args.includes("--skip-download")) process.exit(0);\nconst dir = args[args.indexOf("-P") + 1];\nfs.copyFileSync(${JSON.stringify(sound)}, dir + "/Some title [abcdefghijk].m4a");\nconsole.log("EDIT-FILE " + dir + "/Some title [abcdefghijk].m4a");`);
    const stages: string[] = [];
    const transcript = await words(home.home, "abcdefghijk", USES.idea, undefined, (text) => stages.push(text));
    expect(transcript.model).toBe("scribe_v2");
    expect(transcript.words.length).toBeGreaterThan(0);
    expect(stages).toEqual(["No captions: fetching the video's sound", "No captions: hearing the video"]);
    const download = fake.calls().find((args) => args.includes("-f"))!;
    expect(download[download.indexOf("-f") + 1]).toBe("ba[ext=m4a]/ba/b");
    // An idea's download is sparing too: through the proxy, and never with the person's YouTube sign-in.
    expect(download).toContain("--proxy");
    expect(fake.calls().some((args) => args.includes("--cookies-from-browser"))).toBe(false);
    expect(mock.calls("/v1/transcribe")).toHaveLength(1);
    // Kept: read again, nothing is fetched or heard.
    const calls = fake.calls().length;
    expect((await words(home.home, "abcdefghijk", USES.idea)).model).toBe("scribe_v2");
    expect(fake.calls()).toHaveLength(calls);
    expect(mock.calls("/v1/transcribe")).toHaveLength(1);
    expect(fs.existsSync(`${home.home}/cache/youtube-captions/abcdefghijk/sound`)).toBe(false);
  } finally {
    macSpeech.timing.helper = helper;
    restore();
    mock.stop();
    home.done();
  }
});
