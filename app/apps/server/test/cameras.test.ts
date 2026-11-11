import { expect, spyOn, test } from "bun:test";

import * as fs from "node:fs";
import * as os from "node:os";

// The seams first: speakers.ts alone meets the cast→speakers cycle before ROLES is set.
import "../src/seams.ts";
import { bodycams } from "../src/speakers.ts";
import * as aiClaude from "../src/ai_claude.ts";
import { apply, cleaned, read } from "../src/cameras.ts";
import type { Transcript, Word } from "../src/transcribe.ts";

test("camera IDs read off the picture are made one spelling each, misreadings dropped", () => {
  const read = ["D01A45518", "D01A45518", "D01A4551B", "D01A45518", "", "D01A2379M", "D01A2379M", "XYZ", "D01A2379M", "d01a2379m"];
  expect(cleaned(read)).toEqual(["D01A45518", "D01A45518", "D01A45518", "D01A45518", "", "D01A2379M", "D01A2379M", "D01A2379M", "D01A2379M", "D01A2379M"]);
});

const words = (voice: string, from: number, count: number): Word[] => Array.from({ length: count }, (_, i) => ({ text: "word", start: from + i * 0.4, end: from + i * 0.4 + 0.3, speaker: voice }));

test("a voice heard on two bodycams is two officers: each camera's words get their own voice", () => {
  // McCall's camera for the first 60 s, his partner's after; Scribe heard both officers as speaker_1.
  const transcript: Transcript = {
    model: "scribe_v2",
    words: [...words("speaker_1", 10, 30), ...words("speaker_0", 30, 25), ...words("speaker_1", 70, 40), ...words("speaker_0", 100, 25), ...words("speaker_2", 130, 5)],
  };
  const ids = Array.from({ length: 40 }, (_, i) => (i < 12 ? "D01A45518" : "D01A2379M"));
  apply(transcript, { step: 5, ids });
  const voiceAt = (time: number) => transcript.words.find((word) => word.start >= time)!.speaker;
  // A voice keeps its number on the camera it says most on; McCall's own camera gets a new one.
  expect(voiceAt(70)).toBe("speaker_1");
  expect(voiceAt(10)).toBe("speaker_4");
  // The suspect, on both cameras, is split too: naming gives both his name.
  expect(voiceAt(100)).toBe("speaker_0");
  expect(voiceAt(30)).toBe("speaker_3");
  expect(voiceAt(130)).toBe("speaker_2");
  expect(transcript.cameras).toEqual({ speaker_0: "D01A2379M", speaker_1: "D01A2379M", speaker_2: "D01A2379M", speaker_3: "D01A45518", speaker_4: "D01A45518" });
  expect(bodycams(transcript)).toContain("speaker_4: camera D01A45518");
});

test("one camera, or none, changes nothing", () => {
  const transcript: Transcript = { model: "scribe_v2", words: words("speaker_1", 0, 50) };
  apply(transcript, { step: 5, ids: Array.from({ length: 10 }, () => "D01A2379M") });
  expect(transcript.words.every((word) => word.speaker === "speaker_1")).toBe(true);
  expect(transcript.cameras).toBeUndefined();
  expect(bodycams({ model: "scribe_v2", words: [] })).toBe("");
});

test("a long file's sheets are cut from its keyframes and asked at once, each tile's ID in its place", async () => {
  // Nov 11: after Scribe, a 25-minute video's strips took 101 s decoding every frame and its three sheets 46 s asked
  // one after another, all under Script mode's "Transcribing".
  const dir = fs.mkdtempSync(`${os.tmpdir()}/edit-cameras-test-`);
  const file = `${dir}/two-sheets.mp4`;
  const made = Bun.spawnSync(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=2:duration=700", "-c:v", "libx264", "-g", "8", "-preset", "ultrafast", file]);
  expect(made.exitCode).toBe(0);
  let flying = 0;
  let most = 0;
  const post = spyOn(aiClaude, "post").mockImplementation(async (body: string) => {
    flying += 1;
    most = Math.max(most, flying);
    await Bun.sleep(50);
    flying -= 1;
    const asked = JSON.parse(fs.readFileSync(body, "utf8")) as { messages: { content: { text?: string }[] }[] };
    const count = Number(/has (\d+) tiles/u.exec(asked.messages[0]!.content[0]!.text!)![1]);
    // The first sheet shows one camera, the second another.
    const id = count === 120 ? "D01A45518" : "D01A2379M";
    return { choices: [{ message: { content: JSON.stringify({ tiles: Array.from({ length: count }, (_, n) => ({ n, id })) }) } }], usage: { cost: 0.01 } };
  });
  try {
    const reading = (await read(file, 700))!;
    expect(post).toHaveBeenCalledTimes(2);
    expect(most).toBe(2);
    expect(reading.step).toBe(5);
    expect(reading.ids.length).toBe(141);
    expect(reading.ids[119]).toBe("D01A45518");
    expect(reading.ids[120]).toBe("D01A2379M");
    expect(reading.ids[140]).toBe("D01A2379M");
  } finally {
    post.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
