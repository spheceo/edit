// The subtitles package end to end on the stub: its MCP tools, its routes,
// and the pieces it shares with captions.

import { afterEach, expect, test } from "bun:test";

import type { App } from "../src/app.ts";
import { hex, subtitleName, timing, transcriptOf } from "../src/captions_core.ts";
import { baseRouter, respond } from "../src/http/server.ts";
import { dispatch } from "../src/mcp/index.ts";
import type { AudioClip, Media, Project, TextClip } from "../src/model.ts";
import { f32, fixed } from "../src/rust.ts";
import { routes } from "../src/subtitles_tools.ts";
import { serialize, type Transcript } from "../src/transcribe.ts";
import { fixtureHome, write } from "./helpers/home.ts";

const realTiming = { ...timing };
afterEach(() => {
  Object.assign(timing, realTiming);
});

function bodycam(dir: string): Media {
  return { id: "m", name: "bodycam", path: `${dir}/bodycam.mp4`, kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, has_audio: true };
}

const TRANSCRIPT: Transcript = {
  model: "scribe_v2",
  language: "eng",
  words: [
    { text: "Stop", start: 1.0, end: 1.3, speaker: "speaker_0" },
    { text: "fucking", start: 1.35, end: 1.7, speaker: "speaker_0" },
    { text: "moving.", start: 1.75, end: 2.0, speaker: "speaker_0" },
    { text: "Okay.", start: 3.0, end: 3.3, speaker: "speaker_1" },
  ],
  speakers: { speaker_0: "Officer", speaker_1: "Jane (Mother)" },
  roles: { speaker_0: "officer", speaker_1: "witness" },
  colors: { speaker_0: "#00e5c7", speaker_1: "#e57e00" },
};

/** A project of one bodycam file (picture and sound, 30 s) whose transcript is in the cache. */
async function footage(app: App, dir: string): Promise<string> {
  const media = bodycam(dir);
  write(app.media.paths(media.path).transcript, serialize(TRANSCRIPT));
  const live = app.store.create("p", { width: 1920, height: 1080, fps: 30 });
  const project: Project = structuredClone(live.project) as Project;
  project.media = [media];
  project.clips = [
    {
      id: "f",
      track: "v1",
      start: 0,
      duration: 900,
      color: "blue",
      fade_in: 0,
      fade_out: 0,
      type: "video",
      media: "m",
      source_in: 0,
      speed: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      opacity: 1,
      link: "l1",
    },
    { id: "a", track: "a4", start: 0, duration: 900, color: "blue", fade_in: 0, fade_out: 0, type: "audio", media: "m", source_in: 0, speed: 1, volume_db: 0, link: "l1" },
  ];
  await app.store.replace(project.id, null, project, "test");
  return project.id;
}

async function call(app: App, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const reply = (await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, null)) as {
    result: { content: { text: string }[]; isError: boolean };
  };
  return { text: reply.result.content[0]!.text, isError: reply.result.isError };
}

test("repack_subtitles subtitles the footage in its speakers' colours, mutes and stars", async () => {
  const { app, dir, store, cleanup } = fixtureHome("repack");
  try {
    const id = await footage(app, dir);
    const { text, isError } = await call(app, "repack_subtitles", { project_id: id });
    expect(isError).toBe(false);
    expect(text.startsWith("subtitled 0.00–30.00s: {")).toBe(true);
    const summary = JSON.parse(text.slice(text.indexOf("{"))) as Record<string, unknown>;
    expect(summary).toEqual({
      rev: 3,
      subtitles: 2,
      skipped: 0,
      outside_segments: 0,
      texts_starred: 0,
      speakers: [
        { voice: "m/speaker_0", name: "Officer", role: "officer", color: "#00e5c7", lines: 1, shown: true },
        { voice: "m/speaker_1", name: "Jane (Mother)", role: "witness", color: "#e57e00", lines: 1, shown: true },
      ],
      mutes: [{ term: "fucking", time: 1.35, starred: true, clip: "a" }],
    });
    // Keys sorted.
    expect(text.indexOf('"mutes"')).toBeLessThan(text.indexOf('"rev"'));
    const project = store.get(id)!.project;
    const subtitles = project.clips.filter((clip): clip is TextClip => clip.type === "text");
    expect(subtitles.map((clip) => [clip.name, clip.text, clip.start, clip.duration, clip.transform.y])).toEqual([
      ["Subtitle · Officer", "Stop f****** moving.", 30, 60, 432],
      ["Subtitle · Jane (Mother)", "Okay.", 90, 39, 432],
    ]);
    expect(project.tracks.find((track) => track.id === subtitles[0]!.track)?.subtitles).toBe(true);
    expect(subtitles[0]!.style.color).toEqual([0, f32(229 / 255), f32(199 / 255), 1]);
    expect(subtitles[0]!.style).toMatchObject({ font: "Montserrat", weight: 600, size: 48, max_width: 1512 });
    const sound = project.clips.find((clip) => clip.id === "a") as AudioClip;
    expect(sound.mutes).toEqual([{ from: 1.32, to: 1.725 }]);
    // A re-run replaces its own subtitles.
    await call(app, "repack_subtitles", { project_id: id });
    expect(store.get(id)!.project.clips.filter((clip) => clip.type === "text").length).toBe(2);
    // An empty span says so.
    expect(await call(app, "repack_subtitles", { project_id: id, start: 5, end: 5 })).toEqual({ text: "the span is empty", isError: true });
  } finally {
    cleanup();
  }
});

test("set_segments fills the gaps with footage and says what's wrong with a segment", async () => {
  const { app, dir, store, cleanup } = fixtureHome("segments");
  try {
    const id = await footage(app, dir);
    const done = await call(app, "set_segments", {
      project_id: id,
      segments: [
        { start: 5, end: 10, kind: "narration", note: "map" },
        { start: 20, end: 20, kind: "other" },
      ],
    });
    expect(done).toEqual({ text: "3 segments set (gaps are footage)", isError: false });
    expect(store.get(id)!.project.segments).toEqual([
      { start: 0, end: 150, kind: "footage" },
      { start: 150, end: 300, kind: "narration", note: "map" },
      { start: 300, end: 900, kind: "footage" },
    ]);
    expect(await call(app, "set_segments", { project_id: id, segments: "x" })).toEqual({ text: "segments must be a list", isError: true });
    expect((await call(app, "set_segments", { project_id: id, segments: [{ start: 1, kind: "x" }] })).text).toBe("each segment needs end (seconds)");
    expect((await call(app, "set_segments", { project_id: id, segments: [{ start: 1, end: 2, kind: "x" }] })).text).toBe(
      "kind is footage, captioned, narration or other",
    );
  } finally {
    cleanup();
  }
});

test("mute_house_words mutes the sound and stars the subtitles already there, moving nothing", async () => {
  const { app, dir, store, cleanup } = fixtureHome("mute");
  // No voice-overs in this edit (voiceover.voiceoverSound finds none).
  try {
    const id = await footage(app, dir);
    await store.update(id, "test", (project) => {
      project.clips.push({
        id: "s",
        track: "v2",
        start: 30,
        duration: 60,
        color: "cyan",
        name: "Subtitle · Officer",
        fade_in: 0,
        fade_out: 0,
        type: "text",
        text: "Stop fucking moving.",
        style: { font: "Geist", weight: 700, size: 96, color: [1, 1, 1, 1], tracking: 0, line_height: 1.15, glow: { enabled: true, color: null, radius: 46, strength: 0.5 } },
        transform: { x: 0, y: -200, scale: 1, rotation: 0 },
        animation: { preset: "none", duration: 12, stagger: 1.5 },
        opacity: 1,
      });
    });
    const { text, isError } = await call(app, "mute_house_words", { project_id: id, end: 10 });
    expect(isError).toBe(false);
    expect(text).toBe(
      'muted 0.00–10.00s: {"mutes":[{"clip":"a","starred":true,"term":"fucking","time":1.35}],"rev":4,"subtitles_starred":1,"texts_starred":0}',
    );
    const project = store.get(id)!.project;
    const subtitle = project.clips.find((clip) => clip.id === "s") as TextClip;
    expect([subtitle.text, subtitle.transform.y]).toEqual(["Stop f****** moving.", -200]);
    expect((project.clips.find((clip) => clip.id === "a") as AudioClip).mutes).toEqual([{ from: 1.32, to: 1.725 }]);
  } finally {
    cleanup();
  }
});

test("mute_house_words keep leaves a word unmuted and unstarred there, and later runs leave it too", async () => {
  const { app, dir, store, cleanup } = fixtureHome("keep");
  try {
    const id = await footage(app, dir);
    await store.update(id, "test", (project) => {
      project.clips.push({
        id: "s",
        track: "v2",
        start: 30,
        duration: 60,
        color: "cyan",
        name: "Subtitle · Officer",
        fade_in: 0,
        fade_out: 0,
        type: "text",
        text: "Stop fucking moving.",
        style: { font: "Geist", weight: 700, size: 96, color: [1, 1, 1, 1], tracking: 0, line_height: 1.15, glow: { enabled: true, color: null, radius: 46, strength: 0.5 } },
        transform: { x: 0, y: -200, scale: 1, rotation: 0 },
        animation: { preset: "none", duration: 12, stagger: 1.5 },
        opacity: 1,
      });
    });
    const kept = await call(app, "mute_house_words", { project_id: id, end: 10, keep: [1.4] });
    expect(kept.isError).toBe(false);
    expect(kept.text).toContain('"not_muted":[{"term":"fucking","time":1.35}]');
    const again = await call(app, "mute_house_words", { project_id: id, end: 10 });
    expect(again.text).toContain('"mutes":[]');
    const project = store.get(id)!.project;
    expect((project.clips.find((clip) => clip.id === "s") as TextClip).text).toBe("Stop fucking moving.");
    expect((project.clips.find((clip) => clip.id === "a") as AudioClip).mutes).toEqual([]);
    expect(project.media[0]!.markers).toEqual([{ time: 1.35, name: "not muted", note: "fucking" }]);
    expect((await call(app, "mute_house_words", { project_id: id, end: 10, keep: [5] })).text).toContain("no house word is muted near 5.00s");
  } finally {
    cleanup();
  }
});

test("add_subtitles goes to the captions package; place_subtitles works with no faces found", async () => {
  const { app, dir, cleanup } = fixtureHome("add");
  // No voice-overs in this edit (voiceover.voiceoverSound finds none).
  try {
    const id = await footage(app, dir);
    const placed = await call(app, "place_subtitles", { project_id: id });
    expect(placed).toEqual({
      text: '{"footage_not_analysed":[],"moved":0,"moved_by_hand_left_alone":0,"off_bottom_middle_now":0,"rev":3,"subtitles":0,"with_a_face_under_them":0}',
      isError: false,
    });
    // captions.ts makes them.
    const added = await call(app, "add_subtitles", { project_id: id });
    expect(added.isError).toBe(false);
    expect(added.text.startsWith("subtitled 0.00–30.00s: {")).toBe(true);
  } finally {
    cleanup();
  }
});

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("host", "localhost:7700");
  return new Request(`http://localhost:7700${path}`, { ...init, headers });
}

test("the repack and speaker routes answer", async () => {
  const { app, dir, cleanup } = fixtureHome("routes");
  try {
    const id = await footage(app, dir);
    const router = baseRouter();
    routes(router);
    const post = (path: string, body?: unknown, type = "application/json") =>
      respond(
        app,
        router,
        request(path, {
          method: "POST",
          ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": type } }),
        }),
        null,
      ) as Promise<Response>;
    // No body: all of it, defaults.
    let response = await post(`/api/projects/${id}/repack-subtitles`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { subtitles: number }).subtitles).toBe(2);
    response = await post(`/api/projects/${id}/repack-subtitles`, { start: "x" });
    expect(response.status).toBe(422);
    response = await post(`/api/projects/${id}/repack-subtitles`, { start: 0 }, "text/plain");
    expect(response.status).toBe(415);
    response = await post(`/api/projects/nope/repack-subtitles`);
    expect([response.status, await response.json()]).toEqual([404, { error: "no such project" }]);
    response = await post(`/api/projects/${id}/repack-subtitles`, { start: 5, end: 5 });
    expect([response.status, await response.json()]).toEqual([400, { error: "the span is empty" }]);
    // Who a voice is, by hand.
    response = await post(`/api/projects/${id}/media/m/speakers`, { voice: "speaker_1", role: "victim" });
    expect(response.status).toBe(200);
    const transcript = (await response.json()) as Transcript;
    expect(transcript.roles?.speaker_1).toBe("victim");
    expect(transcript.speakers?.speaker_1).toBe("Jane (Mother)");
    response = await post(`/api/projects/${id}/media/x/speakers`, { voice: "speaker_1", role: "victim" });
    expect([response.status, await response.json()]).toEqual([404, { error: "no such media" }]);
    response = await post(`/api/projects/${id}/media/m/speakers`, { voice: "speaker_1", role: "chief" });
    expect(response.status).toBe(400);
    response = await post(`/api/projects/${id}/media/m/speakers`, { role: "victim" });
    expect(response.status).toBe(422);
  } finally {
    cleanup();
  }
});

test("a media's transcript is read when it's in, and waited for no longer than 20 minutes", async () => {
  const { app, dir, cleanup } = fixtureHome("transcript-of");
  try {
    const media = bodycam(dir);
    write(app.media.paths(media.path).transcript, serialize(TRANSCRIPT));
    const got = await transcriptOf(app, media);
    expect(got.words.length).toBe(4);
    expect(got.speakers?.speaker_1).toBe("Jane (Mother)");
    // A file with no sound is never transcribed: the wait gives up.
    let now = 0;
    timing.now = () => now;
    timing.sleep = async (ms) => {
      now += ms;
    };
    const silent = { ...media, id: "s", path: `${dir}/silent.mp4`, has_audio: false };
    await expect(transcriptOf(app, silent)).rejects.toThrow("transcription took too long");
    expect(now).toBeGreaterThan(20 * 60 * 1000);
  } finally {
    cleanup();
  }
});

test("hex colours, speakers' short names and Rust's number formatting", () => {
  expect(hex("#00e5c7")).toEqual([0, f32(229 / 255), f32(199 / 255), 1]);
  expect(hex("00e5c7")).toBeNull();
  expect(hex("#zz")).toBeNull();
  expect(subtitleName("Jane Doe (Mother)")).toBe("Jane");
  expect(subtitleName("Hayven:")).toBe("Hayven");
  expect(subtitleName("Officer Diaz")).toBe("Diaz");
  expect(subtitleName("Deputy 2")).toBe("Deputy 2");
  expect(subtitleName("Child 2")).toBe("Child 2");
  expect(subtitleName("Sister 3")).toBe("Sister 3");
  expect(subtitleName("")).toBe("Speaker");
  // {:.2}: the exact value, ties to even.
  expect(fixed(0.125, 2)).toBe("0.12");
  expect(fixed(0.375, 2)).toBe("0.38");
  expect(fixed(2.5, 0)).toBe("2");
  expect(fixed(3.5, 0)).toBe("4");
  expect(fixed(1.005, 2)).toBe("1.00");
  expect(fixed(29.999, 2)).toBe("30.00");
  expect(fixed(-0.001, 2)).toBe("-0.00");
});

test("add_subtitles gives a short line squeezed by the next one a lead into the quiet before it", async () => {
  // Mom Leaves 5 Kids: Tabitha's "it was." (0.16 s) just before the social worker's line was left out, and the audit flagged it.
  const { app, dir, store, cleanup } = fixtureHome("squeezed");
  try {
    const id = await footage(app, dir);
    const squeezed: Transcript = {
      ...TRANSCRIPT,
      words: [
        { text: "it", start: 1.18, end: 1.25, speaker: "speaker_1" },
        { text: "was.", start: 1.26, end: 1.34, speaker: "speaker_1" },
        { text: "That's", start: 1.4, end: 1.6, speaker: "speaker_0" },
        { text: "his", start: 1.62, end: 1.8, speaker: "speaker_0" },
        { text: "first", start: 1.82, end: 2.1, speaker: "speaker_0" },
        { text: "thing.", start: 2.12, end: 2.62, speaker: "speaker_0" },
      ],
    };
    write(app.media.paths(bodycam(dir).path).transcript, serialize(squeezed));
    expect((await call(app, "add_subtitles", { project_id: id })).isError).toBe(false);
    const lines = store.get(id)!.project.clips.filter((clip): clip is TextClip => clip.type === "text").sort((a, b) => a.start - b.start);
    expect(lines.map((clip) => clip.text)).toEqual(["it was.", "That's his first thing."]);
    expect(lines[0]!.start).toBeLessThanOrEqual(Math.floor(1.18 * 30));
    expect(lines[0]!.start + lines[0]!.duration).toBeLessThanOrEqual(lines[1]!.start);
  } finally {
    cleanup();
  }
});

test("add_subtitles over a span makes a subtitle across its edge again whole rather than dropping it", async () => {
  const { app, dir, store, cleanup } = fixtureHome("edges");
  try {
    const id = await footage(app, dir);
    expect((await call(app, "add_subtitles", { project_id: id })).isError).toBe(false);
    const texts = () => store.get(id)!.project.clips.filter((clip): clip is TextClip => clip.type === "text").map((clip) => clip.text).sort();
    const whole = texts();
    expect(whole.length).toBe(2);
    // From the middle of the first line: it was replaced and never made again.
    expect((await call(app, "add_subtitles", { project_id: id, start: 1.5, end: 10 })).isError).toBe(false);
    expect(texts()).toEqual(whole);
  } finally {
    cleanup();
  }
});

test("add_subtitles keeps a line relabelled on its own when it runs over it again", async () => {
  // Mom & Teen: two of the officer voice's lines are the female sergeant's ("make her pink").
  const { app, dir, store, cleanup } = fixtureHome("one-off");
  try {
    const id = await footage(app, dir);
    write(
      app.media.paths(bodycam(dir).path).transcript,
      serialize({
        ...TRANSCRIPT,
        words: [
          { text: "Stop", start: 1.0, end: 1.3, speaker: "speaker_0" },
          { text: "moving.", start: 1.35, end: 1.7, speaker: "speaker_0" },
          { text: "Get", start: 6.0, end: 6.3, speaker: "speaker_0" },
          { text: "down.", start: 6.35, end: 6.7, speaker: "speaker_0" },
          { text: "Hands", start: 12.0, end: 12.3, speaker: "speaker_0" },
          { text: "up.", start: 12.35, end: 12.7, speaker: "speaker_0" },
        ],
      }),
    );
    expect((await call(app, "add_subtitles", { project_id: id })).isError).toBe(false);
    const pink: [number, number, number, number] = [1, 0.4, 0.8, 1];
    await store.update(id, "test", (project) => {
      const line = project.clips.find((clip): clip is TextClip => clip.type === "text" && clip.text === "Get down.")!;
      line.style.label = { ...line.style.label!, text: "Female Sergeant:", color: pink };
    });
    expect((await call(app, "add_subtitles", { project_id: id })).isError).toBe(false);
    const labels = store
      .get(id)!
      .project.clips.filter((clip): clip is TextClip => clip.type === "text")
      .sort((a, b) => a.start - b.start)
      .map((clip) => [clip.text, clip.style.label?.text]);
    expect(labels).toEqual([
      ["Stop moving.", "Officer:"],
      ["Get down.", "Female Sergeant:"],
      ["Hands up.", "Officer:"],
    ]);
  } finally {
    cleanup();
  }
});

test("subtitle recovery fills uncovered lines and preserves manual text, placement, colours and audio mutes on repeated runs", async () => {
  const { app, dir, store, cleanup } = fixtureHome("subtitle-recovery");
  try {
    const id = await footage(app, dir);
    expect((await call(app, "add_subtitles", { project_id: id, end: 2.8 })).isError).toBe(false);
    await store.update(id, "test", (project) => {
      const subtitle = project.clips.find((clip): clip is TextClip => clip.type === "text")!;
      subtitle.text = "A deliberately corrected line.";
      subtitle.transform.y = -180;
      subtitle.keyframes = { x: [{ frame: 0, value: 30, ease: "linear" }] };
      (project.clips.find((clip) => clip.id === "a") as AudioClip).mutes = [{ from: 8, to: 8.5 }];
    });
    const before = structuredClone(store.get(id)!.project.clips);
    for (let run = 0; run < 2; run++) {
      const reply = await call(app, "add_subtitles", { project_id: id, missing_only: true });
      expect(reply.isError).toBe(false);
      expect(reply.text).toContain('"missing_only":true');
      const after = store.get(id)!.project;
      for (const clip of before) expect(after.clips.find((one) => one.id === clip.id)).toEqual(clip);
      expect(after.clips.filter((clip) => clip.type === "text").map((clip) => clip.type === "text" && clip.text)).toEqual(["A deliberately corrected line.", "Okay."]);
    }
  } finally { cleanup(); }
});

test("subtitle recovery respects captioned and narration segments", async () => {
  const { app, dir, store, cleanup } = fixtureHome("subtitle-recovery-segments");
  try {
    const id = await footage(app, dir);
    await store.update(id, "test", (project) => {
      project.segments = [{ start: 0, end: 84, kind: "captioned" }, { start: 84, end: 900, kind: "footage" }];
    });
    const reply = await call(app, "add_subtitles", { project_id: id, missing_only: true });
    expect(reply.isError).toBe(false);
    expect(store.get(id)!.project.clips.filter((clip) => clip.type === "text").map((clip) => clip.type === "text" && clip.text)).toEqual(["Okay."]);
  } finally { cleanup(); }
});
