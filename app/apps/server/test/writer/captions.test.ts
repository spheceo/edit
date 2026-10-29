import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { english, MODEL, parse, select, spokenMs } from "../../src/writer/captions.ts";

test("turns open at each speaker change, and ends are spoken lengths", () => {
  const value = { events: [
    { tStartMs: 0, dDurationMs: 1_237_720 },
    { tStartMs: 80, dDurationMs: 3120, segs: [{ utf8: "paint" }, { utf8: " the", tOffsetMs: 160 }, { utf8: " truck.", tOffsetMs: 320 }] },
    { tStartMs: 1510, segs: [{ utf8: "\n" }] },
    { tStartMs: 3200, segs: [{ utf8: ">> Where's", isSpeakerChange: 1 }, { utf8: " [music]", tOffsetMs: 200 }, { utf8: " the", tOffsetMs: 239 }, { utf8: " truck?", tOffsetMs: 320 }] },
    { tStartMs: 6720, segs: [{ utf8: ">>" }, { utf8: " $8,320", tOffsetMs: 80 }] },
  ] };
  const transcript = parse(value);
  expect(transcript.words.map((word) => word.text)).toEqual(["paint", "the", "truck.", "Where's", "the", "truck?", "$8,320"]);
  expect(transcript.words.map((word) => word.speaker)).toEqual(["t0001", "t0001", "t0001", "t0002", "t0002", "t0002", "t0003"]);
  // "paint" would take 300 ms but "the" starts at 240.
  expect(transcript.words[0]!.end).toBe(0.24);
  // "truck." is said in 300 ms, long before the next turn at 3.2 s.
  expect(Math.abs(transcript.words[2]!.end - 0.7)).toBeLessThan(1e-9);
  expect(transcript.model).toBe(MODEL);
});

test("manual cues get distinct, bounded word times and keep speaker changes", () => {
  const words = parse({ events: [
    { tStartMs: 1000, dDurationMs: 1500, segs: [{ utf8: ">> We are ready." }] },
    { tStartMs: 4000, dDurationMs: 500, segs: [{ utf8: ">> Yes." }] },
  ] }).words;
  expect(words.map((word) => word.text)).toEqual(["We", "are", "ready.", "Yes."]);
  for (let i = 0; i < 2; i++) expect(words[i]!.start < words[i]!.end && words[i]!.end <= words[i + 1]!.start).toBe(true);
  expect(words[2]!.end).toBeLessThanOrEqual(2.5);
  expect(words[3]!.start).toBe(4);
  expect(words[0]!.speaker).not.toBe(words[3]!.speaker);
});

test("English selection takes variants, manual cues and usable earlier files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writer-caption-selection-"));
  const cue = (text: string) => ({ events: [{ tStartMs: 1000, dDurationMs: 1200, segs: [{ utf8: text }] }] });
  const timed = { events: [{ tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: "Original", tOffsetMs: 0 }, { utf8: " English", tOffsetMs: 400 }] }] };
  const put = (language: string, value: unknown) => fs.writeFileSync(path.join(dir, `captions.${language}.json3`), JSON.stringify(value));
  put("en-US", cue("Manual English"));
  put("fr", timed);
  put("en-orig", { events: [] });
  expect(select(dir, null)![0]).toBe("en-US");
  const info = { subtitles: { "en-US": [{}] }, requested_subtitles: { en: { url: "https://example.test/captions?lang=fr&tlang=en" } } };
  put("en", timed);
  put("en-Zd4rRTALbmM", timed);
  // Automatic translations are not the spoken transcript.
  expect(select(dir, info)![0]).toBe("en-US");
  put("en-orig", timed);
  expect(select(dir, info)![0]).toBe("en-orig");
  fs.rmSync(path.join(dir, "captions.en-orig.json3"));
  fs.rmSync(path.join(dir, "captions.en.json3"));
  fs.writeFileSync(path.join(dir, "captions.en-GB.json3"), "broken");
  // Bad or failed later tracks don't discard usable captions.
  expect(select(dir, info)![0]).toBe("en-US");
  expect(english("eng")).toBe(false);
  expect(english("en-GB")).toBe(true);
  expect(english("en-CA")).toBe(true);
  // A translated track named with another video id is not this recording.
  expect(english("en-Zd4rRTALbmM")).toBe(false);
  expect(english("en-en-Zd4rRTALbmM")).toBe(false);
  fs.rmSync(dir, { recursive: true });
});

test("a word takes about sixty ms a letter", () => {
  expect(spokenMs("a")).toBe(60);
  expect(spokenMs("Objection.")).toBe(540);
  expect(spokenMs("$8,320")).toBe(1_000);
});
