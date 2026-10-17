// library.rs's tests, and the library against the mock Drive: its listing,
// sign-in, downloads and the sound tools.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

import { base, gatewayThrough, googleThrough, protocols } from "../src/endpoints.ts";
import * as library from "../src/library.ts";
import { cleanNote, curl, encode, notes, quote, spanLevels } from "../src/library.ts";
import { dispatch } from "../src/mcp/index.ts";
import { registerMediaTools } from "../src/media_tools.ts";
import type { AudioClip, Project } from "../src/model.ts";
import * as seams from "../src/seams.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({
    GOOGLE_DRIVE_CLIENT_ID: "id",
    GOOGLE_DRIVE_CLIENT_SECRET: "secret",
    GOOGLE_DOCS_REFRESH_TOKEN: "refresh",
    EDIT_LIBRARY_FOLDER: "root",
    EDIT_RELAY_TOKEN: undefined,
  });
  registerMediaTools();
});

afterAll(() => {
  restore();
  mock.stop();
});

afterEach(() => {
  library.forgetAnswers();
});

test("notes_drop_labels_and_sources", () => {
  expect(cleanNote("Hit 2: Epidemic Sound")).toBeNull();
  expect(cleanNote(" Whoosh 1, very low volume: Epidemic Sound")).toBe("very low volume");
  expect(cleanNote("End of Luck, first ~9 seconds, good for intros: Epidemic Sound")).toBe(
    "End of Luck, first ~9 seconds, good for intros",
  );
  expect(cleanNote("Dark and slow: Epidemic Sound")).toBe("Dark and slow");
});

test("index_notes_by_id_and_file", () => {
  const index =
    "MUSIC & SFX LIBRARY\n\n[Music / Investigative]\nOut There - Out To The World.wav\nSource note: First ~20 seconds: Epidemic Sound\nSource: https://www.epidemicsound.com/x/\nDrive file: https://drive.google.com/file/d/16fhcGN-KYu/view?usp=drivesdk\n\n[Sound effects / Hits]\nBoom.wav\nSource note: Hit 3: Epidemic Sound\n";
  const found = notes(index);
  expect(found.get("16fhcGN-KYu")).toBe("First ~20 seconds");
  expect(found.get("Out There - Out To The World.wav")).toBe("First ~20 seconds");
  expect(found.has("Boom.wav")).toBe(false);
});

test("curl_config_values_cannot_add_lines", () => {
  expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"');
  expect(() => quote("token\nheader = evil")).toThrow("a Google Drive setting contains a control character");
});

test("stand_ins_take_every_google_host_and_the_gateway", () => {
  const drive = "https://www.googleapis.com/drive/v3/files?q=x";
  expect(googleThrough(null, drive)).toBe(drive);
  expect(protocols(null)).toBe("=https");
  expect(gatewayThrough(null)).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
  const stand = () => base(" http://127.0.0.1:7900/ ");
  expect(base("")).toBeNull();
  expect(googleThrough(stand(), drive)).toBe("http://127.0.0.1:7900/www.googleapis.com/drive/v3/files?q=x");
  expect(googleThrough(stand(), "https://oauth2.googleapis.com/token")).toBe("http://127.0.0.1:7900/oauth2.googleapis.com/token");
  expect(protocols(stand())).toBe("=http,https");
  expect(protocols("https://mock.example")).toBe("=https");
  expect(gatewayThrough(stand())).toBe("http://127.0.0.1:7900/v1/chat/completions");
});

test("query values are encoded byte by byte", () => {
  expect(encode("'root' in parents and trashed = false")).toBe("%27root%27%20in%20parents%20and%20trashed%20%3D%20false");
  expect(encode("é~")).toBe("%C3%A9~");
});

test("a short sound is measured by its loudest moment, a long one integrated", () => {
  expect(spanLevels({ integrated: -20, loudest: -12, peak: -3 }, 10)).toEqual([-20, -3]);
  expect(spanLevels({ integrated: -20, loudest: -12, peak: -3 }, 2)).toEqual([-12, -3]);
  expect(spanLevels({ integrated: -80, loudest: -12, peak: -3 }, 10)).toEqual([-12, -3]);
  expect(() => spanLevels({ integrated: -80, loudest: -75, peak: -60 }, 10)).toThrow("that stretch of the sound is silent");
});

/** The library's folders on the mock Drive: Music / Investigative and Sound effects / Hits, an index and a guide. */
function driveFolders(): void {
  const files: Record<string, unknown[]> = {
    root: [
      { id: "music", name: "Music", mimeType: "application/vnd.google-apps.folder" },
      { id: "sfx", name: "Sound effects", mimeType: "application/vnd.google-apps.folder" },
      { id: "index", name: "index.txt", mimeType: "text/plain" },
      { id: "guide", name: "Usage guide", mimeType: "application/vnd.google-apps.document" },
    ],
    music: [{ id: "investigative", name: "Investigative", mimeType: "application/vnd.google-apps.folder" }],
    investigative: [
      { id: "song", name: "Out There - Epidemic Sound.wav", mimeType: "audio/wav", size: "2048", md5Checksum: "abcdef0123456789" },
    ],
    sfx: [{ id: "hits", name: "Hits", mimeType: "application/vnd.google-apps.folder" }],
    hits: [
      { id: "boom", name: "Boom.wav", mimeType: "audio/wav", size: "100", md5Checksum: "0011223344556677" },
      { id: "readme", name: "Readme.pdf", mimeType: "application/pdf" },
    ],
  };
  mock.on("GET", "/www.googleapis.com/drive/v3/files", (request) => {
    const folder = /'([^']+)' in parents/.exec(request.query.get("q") ?? "")?.[1] ?? "";
    return Response.json({ files: files[folder] ?? [] });
  });
  mock.on("GET", "/www.googleapis.com/drive/v3/files/index", () =>
    new Response("[Music / Investigative]\nOut There - Epidemic Sound.wav\nSource note: First ~20 seconds: Epidemic Sound\n"),
  );
  mock.on("GET", "/www.googleapis.com/drive/v3/files/guide/export", () => new Response("\u{feff}  Hits go on cuts.\n"));
  mock.on("GET", "/www.googleapis.com/drive/v3/files/boom", () => new Response(new Uint8Array([1, 2, 3, 4])));
}

test("the library is read from Drive, with its notes and guide, through one sign-in", async () => {
  driveFolders();
  const before = mock.calls("/oauth2.googleapis.com/token").length;
  const found = new library.Library();
  const listing = await found.list(false);
  expect(listing.guide).toBe("Hits go on cuts.");
  expect(library.listingJson(listing).sounds).toEqual([
    { id: "song", name: "Out There", kind: "music", category: "Investigative", note: "First ~20 seconds", bytes: 2048 },
    { id: "boom", name: "Boom", kind: "sfx", category: "Hits", bytes: 100 },
  ]);
  // Once read, it answers from memory.
  await found.list(false);
  expect(mock.calls("/oauth2.googleapis.com/token").length).toBe(before + 1);
  const token = mock.calls("/oauth2.googleapis.com/token").at(-1)!;
  expect(token.text()).toContain("grant_type=refresh_token");
  const listed = mock.calls("/www.googleapis.com/drive/v3/files").at(-1)!;
  expect(listed.headers.get("authorization")).toBe("Bearer mock-access-token");
});

test("a sign-in that's missing or refused says so", async () => {
  const restoreEnv = mock.useEnv({ GOOGLE_DOCS_REFRESH_TOKEN: "" });
  try {
    await expect(new library.Library().accessToken()).rejects.toThrow("need a Google Drive sign-in");
  } finally {
    restoreEnv();
  }
  mock.on("POST", "/oauth2.googleapis.com/token", () => Response.json({ error: "invalid_grant" }, { status: 400 }), 1);
  await expect(new library.Library().accessToken()).rejects.toThrow("Google refused the Drive sign-in (400).");
});

test("curl answers with the status and body, and a Drive refusal is worded for the library", async () => {
  mock.on("GET", "/www.googleapis.com/drive/v3/files/nope", () => Response.json({ error: { message: "File not found" } }, { status: 404 }));
  const [code, body] = await curl("", ["--max-time", "5", "https://www.googleapis.com/drive/v3/files/nope"]);
  expect(code).toBe(404);
  expect(new TextDecoder().decode(body)).toContain("File not found");
  expect(library.driveError(403, '{"error":{"message":"no"}}')).toBe("Google Drive refused the sound library (403): no");
  expect(library.driveError(404, "")).toBe("Google Drive can't find the sound library folder (or that file).");
});

test("add_from_library downloads once, marks a short effect's hit and places it at its loudness", async () => {
  driveFolders();
  const { app, cleanup, native, home } = fixtureHome("library-add");
  try {
    native.loudestMoment = async () => 0.25;
    native.loudnessSpans = async (_path, spans) => spans.map(() => ({ integrated: -30, loudest: -18, peak: -6 }));
    // The stub's probe asks ffprobe, which can't read four bytes: the sound probes as a short WAV here.
    native.probe = async () => ({ kind: "audio", duration: 1.5, width: 0, height: 0, fps: 0, has_audio: true });
    const project = app.store.create("p", { width: 1920, height: 1080, fps: 30 }).project.id;
    const reply = (await dispatch(
      app,
      { id: 1, method: "tools/call", params: { name: "add_from_library", arguments: { id: "boom", times: [2], loudness: -20 } } },
      null,
    )) as { result: { content: { text: string }[]; isError: boolean } };
    expect(reply.result.isError).toBe(false);
    expect(reply.result.content[0]!.text).toBe(
      "placed Boom at 2.00s (replacing 0 already near those times); it measures -18.0 LUFS, so volume -2.0 dB puts it at -20.0 LUFS",
    );
    const saved = app.store.get(project)!.project;
    const media = saved.media[0]!;
    expect(media.path).toBe(`${home}/library/sfx/001122334455/Boom.wav`);
    expect(media.markers?.[0]?.name).toBe("hit");
    expect(media.markers?.[0]?.time).toBe(0.25);
    const clip = saved.clips.find((item) => item.type === "audio") as AudioClip;
    expect(clip.volume_db).toBe(-2);
    // Its hit (0.25 s in) on 2 s.
    expect(clip.start).toBe(Math.round((2 - 0.25) * 30));
    const downloads = mock.calls("/www.googleapis.com/drive/v3/files/boom").length;
    await library.importSound(app, project, "boom", "agent");
    expect(mock.calls("/www.googleapis.com/drive/v3/files/boom").length).toBe(downloads);
    const missing = (await dispatch(
      app,
      { id: 2, method: "tools/call", params: { name: "add_from_library", arguments: { id: "gone", times: [1] } } },
      null,
    )) as { result: { content: { text: string }[]; isError: boolean } };
    expect(missing.result.content[0]!.text).toBe("no sound gone in the library; list_library shows what's there");
  } finally {
    cleanup();
  }
});

test("list_library lists by kind and category with notes and the guide", async () => {
  driveFolders();
  const { app, cleanup } = fixtureHome("library-list");
  try {
    app.store.create("p", { width: 1920, height: 1080, fps: 30 });
    const reply = (await dispatch(app, { id: 1, method: "tools/call", params: { name: "list_library", arguments: {} } }, null)) as {
      result: { content: { text: string }[] };
    };
    expect(reply.result.content[0]!.text).toBe(
      "The team's sound library (Google Drive). Place one with add_from_library {id}.\n\nMusic / Investigative:\n- song | Out There — First ~20 seconds\n\nSound effects / Hits:\n- boom | Boom\n\nUsage guide (from the library's Doc):\nHits go on cuts.\n",
    );
  } finally {
    cleanup();
  }
});

/** A project with footage sound on A1 (10 s from 2 s in) and music on A2 (muted track ignored). */
async function withSound(app: import("../src/app.ts").App, dir: string): Promise<string> {
  const live = app.store.create("p", { width: 1920, height: 1080, fps: 30 });
  const project = structuredClone(live.project) as Project;
  project.media = [
    { id: "m1", name: "bodycam", path: `${dir}/bodycam.mp4`, kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, has_audio: true },
    { id: "m2", name: "song", path: `${dir}/song.wav`, kind: "audio", duration: 60, width: 0, height: 0, fps: 0, has_audio: true },
  ];
  const audio = (id: string, track: string, media: string, start: number, volume: number): AudioClip => ({
    id,
    track,
    start,
    duration: 300,
    color: "green",
    fade_in: 0,
    fade_out: 0,
    type: "audio",
    media,
    source_in: 2,
    speed: 1,
    volume_db: volume,
  });
  const [a1, a2] = project.tracks.filter((track) => track.kind === "audio").map((track) => track.id);
  project.clips = [audio("c1", a1!, "m1", 0, -3.2), audio("c2", a2!, "m2", 30, 0)];
  await app.store.replace(project.id, null, project, "test");
  return project.id;
}

test("measure_audio and set_loudness read the files' analysis as heard", async () => {
  const { app, cleanup, native, dir } = fixtureHome("library-measure");
  const isVoiceover = seams.voiceover.isVoiceover;
  (seams.voiceover as { isVoiceover: typeof isVoiceover }).isVoiceover = () => false;
  try {
    const asked: [string, number, number][] = [];
    native.loudnessSpans = async (path, spans) =>
      spans.map((span) => {
        asked.push([path, span.from, span.seconds]);
        return path.endsWith(".mp4") ? { integrated: -24, loudest: -15, peak: -4 } : { integrated: -14, loudest: -8, peak: -0.5 };
      });
    const id = await withSound(app, dir);
    const call = async (name: string, args: Record<string, unknown>) =>
      ((await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, null)) as {
        result: { content: { text: string }[]; isError: boolean };
      }).result;
    const measured = await call("measure_audio", {});
    expect(measured.content[0]!.text).toBe(
      "c1 A1 0.00–10.00s bodycam: -27.2 LUFS (volume -3.2 dB)\nc2 A2 1.00–11.00s song: -14.0 LUFS (volume +0.0 dB)",
    );
    expect(asked[0]).toEqual([`${dir}/bodycam.mp4`, 2, 10]);
    // The music to the footage's level (its gain held under -1 dBFS peaks).
    const set = await call("set_loudness", { clip_ids: ["c2"] });
    expect(set.content[0]!.text).toBe("set to -27.2 LUFS: c2 volume -13.2 dB");
    const clip = app.store.get(id)!.project.clips.find((item) => item.id === "c2") as AudioClip;
    expect(clip.volume_db).toBeCloseTo(-13.2, 4);
    const refused = await call("set_loudness", { clip_ids: ["nope"], loudness: -20 });
    expect(refused).toEqual({ content: [{ type: "text", text: "no clip nope" } as never], isError: true });
    const bad = await call("measure_audio", { clip_ids: null });
    expect(bad.content[0]!.text).toBe("clip_ids: invalid type: null, expected a sequence");
  } finally {
    (seams.voiceover as { isVoiceover: typeof isVoiceover }).isVoiceover = isVoiceover;
    cleanup();
  }
});

test("a sound with no speech to match under says how to ask instead", async () => {
  driveFolders();
  const { app, cleanup, native } = fixtureHome("library-under");
  try {
    native.loudestMoment = async () => 0.25;
    native.probe = async () => ({ kind: "audio", duration: 1.5, width: 0, height: 0, fps: 0, has_audio: true });
    app.store.create("p", { width: 1920, height: 1080, fps: 30 });
    const reply = (await dispatch(
      app,
      { id: 1, method: "tools/call", params: { name: "add_from_library", arguments: { id: "boom", times: [1], under_speech: 6 } } },
      null,
    )) as { result: { content: { text: string }[]; isError: boolean } };
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]!.text).toBe(
      "under_speech needs the edit's speech to measure (no footage sound or voice-over on the timeline to match); give loudness in LUFS instead",
    );
  } finally {
    cleanup();
  }
});

test("safe names keep files on every disk", () => {
  expect(library.safeName("a/b:c.wav")).toBe("a_b_c.wav");
  expect(library.safeName("  ..hidden.wav ")).toBe("hidden.wav");
  expect(library.safeName("...")).toBe("sound.wav");
});
