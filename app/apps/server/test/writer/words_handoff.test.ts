// Start the edit hands Edit the script's words first (writer/handoff.ts
// shareWordsNow), whether or not the footage is on this Mac, so Edit's
// excerpts take what Script mode paid for instead of hearing it again.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import * as captions from "../../src/writer/captions.ts";
import * as handoff from "../../src/writer/handoff.ts";
import * as store from "../../src/writer/store.ts";
import { scratch } from "../helpers/home.ts";
import { MockServer } from "../mocks/server.ts";

let mock: MockServer;
let restore: () => void;
beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
});
afterAll(() => {
  restore();
  mock.stop();
});

const ID = "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const KEY = "edit/analysis/youtube/vGj1b3p6mQk/transcript.json";
/** Where words heard only in their kept stretches go: builds from before Nov 11 never read it (shared_words.ts). */
const KEPT = "edit/analysis/youtube/vGj1b3p6mQk/transcript-kept.json";

/** A YouTube script read from captions, two stretches heard exactly, its footage cleared from this Mac. */
function rough(home: string): string {
  const data = store.dataDir(home);
  const dir = store.scriptDir(data, ID);
  fs.mkdirSync(join(dir, "transcript", "whole"), { recursive: true });
  fs.writeFileSync(join(dir, "transcript", "whole", "captions.json"), JSON.stringify({ model: captions.MODEL, words: [{ text: "rough", start: 0, end: 1 }] }));
  fs.writeFileSync(join(dir, "script.json"), JSON.stringify({
    id: ID, title: "Kroger", sourceKind: "youtube", kind: "interrogation", sourceUrl: "https://youtu.be/vGj1b3p6mQk",
    status: "ready", stage: "ready", revision: 1, updatedAt: 1, durationMs: 120_000, originalPath: join(dir, "proxy.mp4"),
    captions: true, rough: true, exact: [[10_000, 20_000]], exactKeyterms: ["Kimberly"],
    clips: [{ id: "c", startMs: 12_000, endMs: 18_000 }],
    words: [
      { id: "w0", text: "rough", startMs: 1_000, endMs: 1_400, speaker: "t0001" },
      { id: "w1", text: "Where", startMs: 12_000, endMs: 12_300, speaker: "speaker_0" },
    ],
  }));
  return data;
}

test("a rough script's words go to Edit before its edit, with the footage cleared from this Mac", async () => {
  const { dir: home, cleanup } = scratch("words-handoff");
  try {
    const data = rough(home);
    // An older Edit kept YouTube's captions there: rough words, not a hearing, so they're replaced.
    mock.cloud.put(KEY, JSON.stringify({ model: "youtube-captions", words: [{ text: "caption", start: 0, end: 1, speaker: "caption_turn_1" }] }));
    expect(await handoff.shareWordsNow(data, ID)).toHaveLength(1);
    const shared = JSON.parse(new TextDecoder().decode(mock.cloud.objects.get(KEPT)!));
    // The captions an older build reads stay as they were.
    expect(JSON.parse(new TextDecoder().decode(mock.cloud.objects.get(KEY)!)).model).toBe("youtube-captions");
    expect([shared.model, shared.heard, shared.keyterms, shared.words.map((word: { text: string; speaker?: string }) => [word.text, word.speaker])]).toEqual([
      "scribe_v3", [[10, 20]], ["Kimberly"], [["rough", undefined], ["Where", "speaker_0"]],
    ]);
    // Shared already, nothing new heard: left as it is.
    expect(await handoff.shareWordsNow(data, ID)).toEqual([]);
    // A whole hearing there is never replaced.
    mock.cloud.put(KEY, JSON.stringify({ model: "scribe_v3", words: [{ text: "heard", start: 0, end: 1 }] }));
    expect(await handoff.shareWordsNow(data, ID)).toEqual([]);
    expect(JSON.parse(new TextDecoder().decode(mock.cloud.objects.get(KEY)!)).words[0].text).toBe("heard");
  } finally {
    cleanup();
  }
});
