import { afterAll, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";

import { serialize, type Word } from "../src/transcribe.ts";
import * as voices from "../src/voices.ts";
import { scratch } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "relay-token" });
  voices.timing.pollMs = 1;
});

afterAll(() => {
  voices.setOnForTests(null);
  restore();
  mock.stop();
});

const word = (text: string, start: number, end: number, speaker?: string): Word => ({ text, start, end, ...(speaker === undefined ? {} : { speaker }) });

test("each word takes the voice pyannote heard over most of it, else the nearest turn or word", () => {
  const words = [word("Where", 0.1, 0.4, "speaker_0"), word("were", 0.45, 0.7, "speaker_0"), word("you?", 0.75, 1.2, "speaker_0"), word("Home.", 1.25, 1.9, "speaker_0"), word("Okay.", 9, 9.4, "speaker_0")];
  voices.label(words, [
    { start: 0, end: 1.1, speaker: "speaker_1" },
    // "you?" is mostly the detective's though the suspect starts under it.
    { start: 1.05, end: 2, speaker: "speaker_2" },
  ]);
  expect(words.map((one) => one.speaker)).toEqual(["speaker_1", "speaker_1", "speaker_1", "speaker_2", "speaker_2"]);
  // A word just past a turn's end is that turn's.
  const near = [word("Yes", 2.5, 2.8)];
  voices.label(near, [{ start: 0, end: 2, speaker: "speaker_3" }]);
  expect(near[0]!.speaker).toBe("speaker_3");
});

test("a recording in the cloud is heard there once: its job followed until done, then kept", async () => {
  const { dir, cleanup } = scratch("voices-key");
  try {
    let looks = 0;
    mock.on("POST", "/v1/diarize/jobs", (request) => {
      expect(request.json<{ key: string }>().key).toBe("edit/originals/youtube/abc/whole.mp4");
      expect(request.headers.get("authorization")).toBe("Bearer relay-token");
      return Response.json({ id: "job-1234" }, { status: 202 });
    });
    mock.on("GET", "/v1/diarize/jobs/job-1234", () =>
      ++looks < 3 ? Response.json({ pending: true }, { status: 202 }) : Response.json({ model: "pyannote-precision-3", segments: [{ start: 2, end: 3, speaker: "SPEAKER_01" }, { start: 0, end: 1, speaker: "SPEAKER_10" }] }),
    );
    const keep = `${dir}/voices/whole.json`;
    const turns = await voices.ofKey("edit/originals/youtube/abc/whole.mp4", keep);
    expect(turns).toEqual([{ start: 0, end: 1, speaker: "speaker_10" }, { start: 2, end: 3, speaker: "speaker_1" }]);
    expect(looks).toBe(3);
    expect(fs.existsSync(`${keep}.job`)).toBe(false);
    // Kept: asked again, nothing is sent.
    const before = mock.requests.length;
    expect(await voices.ofKey("edit/originals/youtube/abc/whole.mp4", keep)).toEqual(turns);
    expect(mock.requests.length).toBe(before);
  } finally {
    cleanup();
  }
});

test("pyannote failing is said, and its job forgotten so the next run starts afresh", async () => {
  const { dir, cleanup } = scratch("voices-failed");
  try {
    mock.on("POST", "/v1/diarize/jobs", () => Response.json({ id: "job-9999" }, { status: 202 }));
    mock.on("GET", "/v1/diarize/jobs/job-9999", () => Response.json({ error: "pyannote couldn't hear it: audio too short" }, { status: 502 }));
    const keep = `${dir}/voices/short.json`;
    await expect(voices.ofKey("edit/originals/drive/x/a.mp4", keep)).rejects.toThrow("audio too short");
    expect(fs.existsSync(`${keep}.job`)).toBe(false);
  } finally {
    cleanup();
  }
});

test("an excerpt of a cloud recording takes its stretch of the whole recording's voices, its old names gone", async () => {
  const { dir, cleanup } = scratch("voices-excerpt");
  try {
    mock.cloud.convex.media.set("youtube:JTr4372yI1g", { source: "youtube:JTr4372yI1g", name: "Interrogation.mp4", originalKey: "edit/originals/youtube/JTr4372yI1g/Interrogation.mp4", originalReady: true, size: 100 } as never);
    mock.on("POST", "/v1/diarize/jobs", () => Response.json({ id: "job-5678" }, { status: 202 }));
    // Kimberly (01) and the detective (03) of the whole recording; the excerpt is 257 s to 668.158 s of it.
    mock.on("GET", "/v1/diarize/jobs/job-5678", () =>
      Response.json({ segments: [{ start: 100, end: 110, speaker: "SPEAKER_00" }, { start: 257, end: 259, speaker: "SPEAKER_03" }, { start: 259.2, end: 262, speaker: "SPEAKER_01" }, { start: 700, end: 710, speaker: "SPEAKER_00" }] }),
    );
    const target = `${dir}/media/transcript.json`;
    fs.mkdirSync(`${dir}/media`, { recursive: true });
    fs.writeFileSync(target, serialize({ model: "youtube-captions", language: "en", words: [word("Did", 0.2, 0.5, "caption_turn_1"), word("you?", 0.6, 1.5, "caption_turn_1"), word("No.", 2.5, 3, "caption_turn_1")], speakers: { caption_turn_1: "Detective 3" }, roles: { caption_turn_1: "leader" } }));
    voices.setOnForTests(false);
    expect(await voices.revoice(`${dir}/cache`, `${dir}/media/excerpt.mp4`, target, "youtube:JTr4372yI1g#257000-668158")).toBe(false);
    voices.setOnForTests(true);
    expect(await voices.revoice(`${dir}/cache`, `${dir}/media/excerpt.mp4`, target, "youtube:JTr4372yI1g#257000-668158")).toBe(true);
    const heard = JSON.parse(fs.readFileSync(target, "utf8")) as { words: Word[]; voices: string; speakers?: unknown; roles?: unknown };
    expect(heard.words.map((one) => one.speaker)).toEqual(["speaker_3", "speaker_3", "speaker_1"]);
    expect([heard.voices, heard.speakers, heard.roles]).toEqual(["pyannote-precision-3", undefined, undefined]);
    // Once: a transcript with pyannote's voices isn't asked again.
    const before = mock.requests.length;
    expect(await voices.revoice(`${dir}/cache`, `${dir}/media/excerpt.mp4`, target, "youtube:JTr4372yI1g#257000-668158")).toBe(false);
    expect(mock.requests.length).toBe(before);
  } finally {
    voices.setOnForTests(null);
    cleanup();
  }
});

test("a whole recording pyannote can't hear: the excerpt takes its own audio's voices, and the recording isn't asked again", async () => {
  const { dir, cleanup } = scratch("voices-fallback");
  try {
    const ffmpeg = Bun.which("ffmpeg");
    if (ffmpeg === null) return;
    const source = `${dir}/excerpt.wav`;
    expect(Bun.spawnSync([ffmpeg, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=2", source]).exitCode).toBe(0);
    mock.cloud.convex.media.set("youtube:OfywwsMVroM", { source: "youtube:OfywwsMVroM", name: "Interrogation.mp4", originalKey: "edit/originals/youtube/OfywwsMVroM/big.mp4", originalReady: true, size: 1809515991 } as never);
    let wholeAsked = 0;
    mock.on("POST", "/v1/diarize/jobs", (request) => {
      const key = request.json<{ key: string }>().key;
      if (key.startsWith("edit/originals/")) wholeAsked++;
      return Response.json({ id: key.startsWith("edit/originals/") ? "job-big1" : "job-own1" }, { status: 202 });
    });
    mock.on("GET", "/v1/diarize/jobs/job-big1", () => Response.json({ error: "pyannote couldn't hear it: Could not load audio" }, { status: 502 }));
    mock.on("GET", "/v1/diarize/jobs/job-own1", () => Response.json({ segments: [{ start: 0, end: 2, speaker: "SPEAKER_00" }] }));
    voices.setOnForTests(true);
    for (const n of [1, 2]) {
      const target = `${dir}/m${n}/transcript.json`;
      fs.mkdirSync(`${dir}/m${n}`, { recursive: true });
      fs.writeFileSync(target, serialize({ model: "scribe_v2", words: [word("Hello", 0.2, 0.6, "speaker_4")] }));
      expect(await voices.revoice(`${dir}/cache`, source, target, `youtube:OfywwsMVroM#${n}000-${n}900`)).toBe(true);
      expect((JSON.parse(fs.readFileSync(target, "utf8")) as { words: Word[] }).words[0]!.speaker).toBe("speaker_0");
    }
    expect(wholeAsked).toBe(1);
  } finally {
    voices.setOnForTests(null);
    cleanup();
  }
});
