import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as nodePath from "node:path";

import { dispatch } from "../src/mcp/index.ts";
import { registerMediaTools } from "../src/media_tools.ts";
import type { Project } from "../src/model.ts";
import { fixtureHome } from "./helpers/home.ts";

registerMediaTools();

test("listen: the strip, what's loud and silent, and who says what, cached", async () => {
  const { app, cleanup, native } = fixtureHome("listen");
  try {
    let asked = 0;
    // A room at -24 LUFS, someone shouting from 3 s to 4 s, silence from 5 s to 6.5 s.
    native.loudnessSpans = async (_path, spans) => {
      asked++;
      return spans.map((span) =>
        span.from >= 3 && span.from < 4
          ? { integrated: -10, loudest: -10, peak: -2 }
          : span.from >= 5 && span.from < 6.5
            ? { integrated: -80, loudest: -80, peak: -90 }
            : { integrated: -24, loudest: -24, peak: -12 },
      );
    };
    const live = app.store.create("p", { width: 1920, height: 1080, fps: 30 });
    const path = nodePath.join(app.store.home, "room.mp4");
    fs.writeFileSync(path, "");
    await app.store.update(live.project.id, "test", (project: Project) => {
      project.media = [{ id: "m1", name: "Room", path, kind: "video", duration: 8, width: 1920, height: 1080, fps: 30, has_audio: true }];
    });
    const transcript = app.media.paths(path).transcript;
    fs.mkdirSync(nodePath.dirname(transcript), { recursive: true });
    const word = (text: string, start: number, speaker: string) => ({ text, start, end: start + 0.4, speaker });
    fs.writeFileSync(transcript, JSON.stringify({ model: "scribe_v2", words: [word("Where", 0.5, "speaker_0"), word("were", 1, "speaker_0"), word("you?", 1.5, "speaker_0"), word("I", 3.1, "speaker_1"), word("WASN'T", 3.5, "speaker_1")], speakers: { speaker_0: "Detective" } }));
    const call = async (args: Record<string, unknown>) =>
      ((await dispatch(app, { id: 1, method: "tools/call", params: { name: "listen", arguments: args } }, null)) as { result: { content: { text: string }[]; isError: boolean } }).result;
    const heard = await call({ media_id: "m1", start: 0, end: 8 });
    expect(heard.isError).toBe(false);
    const said = heard.content[0]!.text;
    expect(said).toContain('m1 "Room" 0.0–8.0s, loudness every 0.5 s');
    expect(said).toContain("its speech here sits at -24 LUFS");
    expect(said).toContain("LOUD (8+ LU over its speech: shouting, a bang, a siren): 3.0–4.0s (peak -2 dBFS)");
    expect(said).toContain("SILENT (1 s+): 5.0–6.5s");
    expect(said).toContain('0.5–1.9s Detective: "Where were you?"');
    expect(said).toContain('3.1–3.9s voice 1: "I WASN\'T"');
    // A strip of 16 half-seconds, the shout tallest.
    expect(said).toContain("    0.0s ▆▆▆▆▆▆██▆▆▁▁▁▆▆▆\n");
    // Asked again: from the cache.
    expect((await call({ media_id: "m1", start: 0, end: 8 })).content[0]!.text).toBe(said);
    expect(asked).toBe(1);
    // Past the file's end: to its end; nothing to hear past it.
    expect((await call({ media_id: "m1", start: 6, end: 400 })).content[0]!.text).toContain("6.0–8.0s");
    expect((await call({ media_id: "m1", start: 9 })).content[0]!.text).toBe("end must be after start (seconds of the file)");
  } finally {
    cleanup();
  }
});
