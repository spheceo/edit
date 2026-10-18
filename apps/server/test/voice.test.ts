// voice.ts's test, plus the voice-over of a script's cut-ins made
// end to end against the mock relay (speech, then transcription to place it).

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";

import { layOut } from "../src/script.ts";
import * as tools from "../src/tools.ts";
import { timing as transcribeTiming } from "../src/transcribe.ts";
import { Voices } from "../src/voice.ts";
import { generate, timing as voiceoverTiming } from "../src/voiceover.ts";
import { fixtureHome, scratch } from "./helpers/home.ts";
import { MockServer, scribeAnswer } from "./mocks/server.ts";

test("lines_keep_their_takes_and_drop_the_deleted", () => {
  const { dir, cleanup } = scratch("voice");
  try {
    const voices = new Voices(dir);
    const project = voices.create("Test", null, [
      ["One.", null],
      ["Two.", null],
    ]);
    const [first, second] = [project.lines[0]!.id, project.lines[1]!.id];
    // Pretend the second line was spoken.
    const stored = voices.get(project.id);
    stored.lines[1]!.takes.push({
      id: "t1",
      created_ms: 0,
      text: "Two.",
      settings: { voice_id: null, voice_name: null, model_id: "eleven_v4", stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1.1 },
      duration: 1,
      characters: 4,
    });
    voices.save(stored);
    fs.writeFileSync(voices.takePath(project.id, "t1"), "mp3");

    // Reordered, the second keeps its take; a made-up chosen take is refused.
    const voice = { voice_id: "gUABw7pXQjhjt0kNFBTF", model_id: "eleven_v4", speed: 5.0 };
    const updated = voices.update(project.id, {
      name: "Renamed",
      voice,
      lines: [
        { id: second, text: "Two!", chosen: "t1" },
        { id: first, text: "One.", chosen: "t9" },
        { text: "Three." },
      ],
    });
    expect(updated.name).toBe("Renamed");
    expect(updated.voice.speed).toBe(1.2);
    expect(updated.lines[0]!.id).toBe(second);
    expect(updated.lines[0]!.chosen).toBe("t1");
    expect(updated.lines[1]!.chosen).toBeNull();
    expect(updated.lines.length).toBe(3);

    // Deleting the line deletes its take's file.
    voices.update(project.id, { name: "Renamed", voice: {}, lines: [{ id: first, text: "One." }] });
    expect(fs.existsSync(voices.takePath(project.id, "t1"))).toBe(false);
    expect(voices.list().length).toBe(1);
    // The UI's changes are refused in serde's words.
    expect(() => voices.update(project.id, { voice: {}, lines: [] })).toThrow("missing field `name`");
  } finally {
    cleanup();
  }
});

const ffmpeg = Bun.which("ffmpeg");
let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: undefined });
  transcribeTiming.sleep = async () => {};
  // Short real waits: the transcription runs on the event loop meanwhile.
  voiceoverTiming.sleep = () => Bun.sleep(5);
  tools.forget();
});

afterAll(() => {
  restore();
  mock.stop();
});

test.skipIf(ffmpeg === null || Bun.which("ffprobe") === null)(
  "a script's cut-ins are spoken with the house voice, one after another, and laid on the cut-ins",
  async () => {
    const { app, dir, cleanup } = fixtureHome("voice-generate");
    // The stub measures no loudness, so the takes keep 0 dB.
    try {
      // A second of tone stands in for every take ElevenLabs speaks.
      const tone = `${dir}/tone.mp3`;
      expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=2", "-c:a", "libmp3lame", tone]).exitCode).toBe(0);
      const spoken: Record<string, unknown>[] = [];
      mock.on("POST", "/v1/speech", (request) => {
        spoken.push(request.json());
        return new Response(fs.readFileSync(tone), { headers: { "content-type": "audio/mpeg", "x-request-id": `req-${spoken.length}` } });
      });
      const lines = ["Police arrived at the house", "Then the call came in"];
      let heard = 0;
      mock.on("POST", "/v1/transcribe", () => Response.json(scribeAnswer(lines[heard++ % lines.length]!.split(" "))));
      const live = app.store.create("Case", { width: 1920, height: 1080, fps: 30 });
      await app.store.update(live.project.id, "test", (project) => {
        project.script = { blocks: lines.map((text) => ({ kind: "narration" as const, text })) };
        layOut(project);
      });
      const report = (await generate(app, live.project.id)) as { media: string[]; report: { placed: boolean; words_matched: string }[] };
      expect(report.media.length).toBe(2);
      expect(report.report.map((entry) => [entry.placed, entry.words_matched])).toEqual([
        [true, "5/5"],
        [true, "5/5"],
      ]);
      // The second line carries on from the first (stitched), with the line around it.
      expect(spoken[0]).toMatchObject({ voice_id: "gUABw7pXQjhjt0kNFBTF", text: lines[0], previous_text: null, next_text: lines[1] });
      expect(spoken[1]).toMatchObject({ text: lines[1], previous_text: lines[0], previous_request_ids: ["req-1"] });
      const project = app.store.get(live.project.id)!.project;
      const voiced = project.script!.blocks.map((block) => (block.kind === "narration" ? block.voiceover : null));
      expect(voiced.every((clip) => typeof clip === "string" && project.clips.some((own) => own.id === clip && own.name === "Voice-over"))).toBe(true);
      expect(project.media.map((own) => own.name)).toEqual(["Case (voice-over) - Cut-in 1.mp3", "Case (voice-over) - Cut-in 2.mp3"]);
      // A second run reuses the takes: nothing is spoken again.
      await generate(app, live.project.id);
      expect(spoken.length).toBe(2);
    } finally {
      cleanup();
    }
  },
);
