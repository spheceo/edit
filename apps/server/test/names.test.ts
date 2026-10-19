// names.ts: the case's names for the transcriber.

import { afterAll, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";

import { timing as waits, transcriptOf } from "../src/captions_core.ts";
import type { Media, Project } from "../src/model.ts";
import { covers, joined, keyTerms } from "../src/names.ts";
import { join } from "../src/paths.ts";
import * as tools from "../src/tools.ts";
import { serialize, timing } from "../src/transcribe.ts";
import { fixtureHome, write } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

const ffmpeg = Bun.which("ffmpeg");
let mock: MockServer;
let restore: () => void;
beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ AI_GATEWAY_API_KEY: "gateway-key" });
  timing.sleep = async () => {};
  waits.sleep = (ms: number) => Bun.sleep(Math.min(ms, 20));
  tools.forget();
});
afterAll(() => {
  restore();
  mock.stop();
});

const ARTICLE =
  "Stephanie Lazarus, a former LAPD detective, was convicted of killing Sherri Rasmussen, the wife of her ex-boyfriend John Ruetten, in their Van Nuys condo in 1986.";

test("names the sources spell, a person's surname on its own too, and nothing the sources don't say", () => {
  expect(
    keyTerms(
      ["Stephanie Lazarus", "John Ruetten", "Sherri Rasmussen", "John Rutten", "Detective 2", "{Jim}"],
      ["Van Nuys", "Los Angeles Police Department"],
      ARTICLE,
    ),
  ).toEqual(["Stephanie Lazarus", "John Ruetten", "Sherri Rasmussen", "Van Nuys", "Lazarus", "Ruetten", "Rasmussen"]);
});

test("at most a hundred, each under 50 characters and five words", () => {
  const many = Array.from({ length: 150 }, (_, n) => `Name${"x".repeat(n % 5)} ${String.fromCharCode(65 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26))}`);
  const said = many.join(" ");
  expect(keyTerms(many, [], said).length).toBeLessThanOrEqual(100);
  expect(keyTerms(["One Two Three Four Five Six"], [], "one two three four five six")).toEqual(["Six"]);
});

test("a transcript heard with some names is heard again only for ones it wasn't given", () => {
  expect(covers(["John Ruetten", "Van Nuys"], ["john ruetten"])).toBe(true);
  expect(covers(undefined, [])).toBe(true);
  expect(covers(["Van Nuys"], ["John Ruetten"])).toBe(false);
  expect(joined(["John Ruetten"], ["Van Nuys", "john ruetten"])).toEqual(["John Ruetten", "Van Nuys"]);
});

test.skipIf(ffmpeg === null)("footage heard without the case's names is heard again with them once its articles are saved, and only once", async () => {
  const { app, dir, cleanup } = fixtureHome("names");
  try {
    const source = `${dir}/tape.wav`;
    expect(Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", source]).exitCode).toBe(0);
    const media: Media = { id: "m", name: "tape", path: source, kind: "audio", duration: 1, width: 0, height: 0, fps: 0, has_audio: true } as Media;
    // Heard when it came in, before any research: "John Rutten".
    write(app.media.paths(source).transcript, serialize({ model: "scribe_v2", language: "eng", words: [{ text: "Rutten", start: 0, end: 0.5 }] }));
    const project = { ...(structuredClone(app.store.create("Cops Realizing", { width: 1920, height: 1080, fps: 30 }).project) as Project), media: [media] };
    const first = mock.calls("/v1/transcribe", "POST").length;
    // No research: nothing asked, nothing heard again.
    expect((await transcriptOf(app, media, project)).words[0]!.text).toBe("Rutten");
    expect(mock.calls("/v1/transcribe", "POST").length).toBe(first);

    write(join(app.store.home, "research", project.id, "articles.json"), JSON.stringify([{ id: "a", url: "https://x.test/a", title: "Lazarus convicted", outlet: "X", summary: "", text: ARTICLE }]));
    mock.on("POST", "/v1/chat/completions", () => Response.json({ choices: [{ message: { content: JSON.stringify({ people: ["John Ruetten", "Stephanie Lazarus"], places: ["Van Nuys"] }) } }] }), 1);
    const heard = await transcriptOf(app, media, project);
    const asked = mock.calls("/v1/transcribe", "POST").slice(first);
    expect(asked.map((call) => call.query.getAll("keyterm"))).toEqual([["John Ruetten", "Stephanie Lazarus", "Van Nuys", "Ruetten", "Lazarus"]]);
    expect(heard.keyterms).toEqual(["John Ruetten", "Stephanie Lazarus", "Van Nuys", "Ruetten", "Lazarus"]);
    expect(fs.existsSync(join(app.store.home, "research", project.id, "names.json"))).toBe(true);
    // Asked again: the names are kept and the transcript has them.
    await transcriptOf(app, media, project);
    expect(mock.calls("/v1/transcribe", "POST").length).toBe(first + 1);
  } finally {
    cleanup();
  }
});
