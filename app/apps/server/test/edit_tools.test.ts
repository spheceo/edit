import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

import * as fs from "node:fs";

import type { App } from "../src/app.ts";
import { hooks as planHooks } from "../src/edit_plan.ts";
import { addedClip, closeGaps, clipRow, EDITING_TOOLS, hooks, lineSeconds, registerEditingTools, resolveRefs } from "../src/edit_tools.ts";
import { dispatch } from "../src/mcp/index.ts";
import { unregistered } from "../src/mcp/registry.ts";
import type { Project } from "../src/model.ts";
import { clipOf, newProject } from "../src/project.ts";
import { fixtureHome, write, type Fixture } from "./helpers/home.ts";
import { clip } from "./helpers/model.ts";

const savedHooks = { ...hooks };
const savedPlanHooks = { ...planHooks };
let savedToken: string | undefined;

beforeAll(() => {
  registerEditingTools();
  // Cloud off: the house sounds import as they are.
  savedToken = process.env.EDIT_RELAY_TOKEN;
  delete process.env.EDIT_RELAY_TOKEN;
  // The packages these tools reach that a test doesn't provide answer as an empty edit would.
  Object.assign(hooks, {
    peopleSummary: () => ({}),
    calloutTiming: () => [],
    subtitleCoverage: () => ({ uncovered: [] }),
    smoothingPending: () => [],
    smoothInBackground: () => [],
    waitForSmoothing: async () => true,
    waitForMaps: async () => {},
    watchInBackground: () => {},
    footageLoudness: async () => {
      throw new Error("no speech");
    },
  });
  Object.assign(planHooks, { oneColourPerPerson: () => [], textOnFaces: () => [] });
});

afterAll(() => {
  Object.assign(hooks, savedHooks);
  Object.assign(planHooks, savedPlanHooks);
  if (savedToken !== undefined) process.env.EDIT_RELAY_TOKEN = savedToken;
});

let fixture: Fixture | null = null;
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

function setUp(name: string): { app: App; id: string; fixture: Fixture } {
  fixture = fixtureHome(name);
  const id = fixture.store.create("tools", { width: 1920, height: 1080, fps: 30 }).project.id;
  fixture.store.setActive(id);
  return { app: fixture.app, id, fixture };
}

async function tool(app: App, name: string, args: Record<string, unknown> = {}, scope: string | null = null) {
  const reply = (await dispatch(app, { id: 1, method: "tools/call", params: { name, arguments: args } }, scope)) as {
    result: { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError: boolean };
  };
  return reply.result;
}

async function said(app: App, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await tool(app, name, args);
  expect(result.isError, result.content[0]?.text).toBe(false);
  return result.content[0]!.text!;
}

async function refused(app: App, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await tool(app, name, args);
  expect(result.isError).toBe(true);
  return result.content[0]!.text!;
}

const projectOf = (app: App, id: string): Project => app.store.get(id)!.project;

test("closing_a_gap_moves_every_track_together", () => {
  const project = newProject("p", "t", { width: 1920, height: 1080, fps: 30 });
  const solid = (id: string, track: string, start: number, duration: number) =>
    clip({ id, track, start, duration, type: "solid", fill: [0, 0, 0, 1] });
  const [v1, v2] = [project.tracks[0]!.id, project.tracks[1]!.id];
  const heading = [solid("card", v1, 0, 90), solid("words", v2, 0, 90)];
  project.clips = [solid("footage", v1, 90, 100), solid("caption", v2, 120, 30)];
  project.mark_out = 150;
  expect(closeGaps(project, heading)).toBe(90);
  expect(clipOf(project, "footage")!.start).toBe(0);
  expect(clipOf(project, "caption")!.start).toBe(30);
  expect(project.mark_out).toBe(60);
  // Something still playing in the span keeps it open.
  const other = newProject("p", "t", { width: 1920, height: 1080, fps: 30 });
  other.clips = [solid("music", v2, 0, 300), solid("footage", v1, 90, 100)];
  expect(closeGaps(other, [solid("card", v1, 0, 90)])).toBe(0);
  expect(clipOf(other, "footage")!.start).toBe(90);
});

test("batch_refs_become_the_clips_earlier_calls_added", () => {
  const added = [
    addedClip({ type: "text", text: "added clip c12" }),
    addedClip({ type: "text", text: "set opacity keyframes on c12" }),
    addedClip({ type: "text", text: "added text clip c13" }),
  ];
  expect(added).toEqual(["c12", null, "c13"]);
  const args = resolveRefs({ clip_id: "$1", follow: ["$3", "$x", "c9"], n: 2 }, added);
  expect(args).toEqual({ clip_id: "c12", follow: ["c13", "$x", "c9"], n: 2 });
  expect(() => resolveRefs("$2", added)).toThrow("$2: call 2 added no clip");
  expect(() => resolveRefs("$4", added)).toThrow("$4: there's no earlier call 4");
});

test("every editing tool is declared and registered", () => {
  for (const name of EDITING_TOOLS) expect(unregistered()).not.toContain(name);
  // Registering again changes nothing.
  registerEditingTools();
});

test("clip rows and transcript line times read as they always have", () => {
  const project = newProject("p", "t", { width: 1920, height: 1080, fps: 30 });
  const row = (fields: Record<string, unknown>) => clipRow(project, clip(fields));
  expect(row({ id: "c1", track: "v1", start: 0, duration: 30, type: "video", media: "m1", source_in: 12.345, speed: 0.5, link: "l1" })).toBe(
    "c1 V1 video [0,30) m1@12.35s x0.50 link l1",
  );
  expect(row({ id: "c2", track: "a4", start: 5, duration: 10, type: "audio", media: "m1", volume_db: -3.45, name: "Voice-over" })).toBe(
    'c2 A1 audio [5,15) "Voice-over" m1@0.00s -3.5dB',
  );
  expect(
    row({
      id: "c3",
      track: "v2",
      start: 0,
      duration: 3,
      type: "text",
      text: 'He said "go"\nnow',
      style: { label: { text: "Officer:" } },
      keyframes: { y: [{ frame: 0, value: 0 }], opacity: [{ frame: 0, value: 1 }] },
    }),
  ).toBe('c3 V2 text [0,3) "He said \\"go\\" / now" label "Officer:" kf opacity,y');
  expect(lineSeconds("[12.30s] (Officer) hello")).toBe(12.3);
  expect(lineSeconds("1:02.5 hi")).toBe(62.5);
  expect(lineSeconds("No transcribed speech")).toBeNull();
});

test("one call recolours every subtitle of one person", async () => {
  const { app, id } = setUp("tools-person");
  const yellow = [1, 0.85, 0.1, 1];
  const blue = [0.2, 0.5, 1, 1];
  const line = (who: string, start: number, color: number[]) =>
    clip({ id: `s${start}`, type: "text", track: projectOf(app, id).tracks[0]!.id, name: `Subtitle · ${who}`, start, duration: 30, text: "line", style: { color } });
  await app.store.update(id, "test", (project) => {
    project.clips.push(line("Stephanie Lazarus", 0, yellow), line("Jim Nuttall", 30, blue), line("Stephanie Lazarus", 60, yellow));
    savedPlanHooks.oneColourPerPerson(project);
  });
  Object.assign(planHooks, { oneColourPerPerson: savedPlanHooks.oneColourPerPerson });
  try {
    const red = [0.9, 0.15, 0.15, 1];
    const answer = await said(app, "update_clips", { person: "stephanie lazarus", patch: { style: { color: red } } });
    expect(answer).toStartWith("updated 2 clip(s)");
    const project = projectOf(app, id);
    const colours = project.clips.map((one) => (one.type === "text" ? one.style.color.map((c) => Math.round(c * 100) / 100) : null));
    expect(colours).toEqual([red, blue, red]);
    expect(project.people!.find((one) => one.name === "Stephanie Lazarus")!.color).toBe("#e62626");
    expect(await refused(app, "update_clips", { person: "Nobody", patch: {} })).toStartWith("no person Nobody in the cast");
  } finally {
    Object.assign(planHooks, { oneColourPerPerson: () => [] });
  }
});

test("adding, changing and removing clips answer", async () => {
  const { app, id } = setUp("tools-clips");
  expect(await said(app, "add_text", { text: "Hello", start: 1, duration: 2 })).toMatch(/^added text clip c\d+$/);
  const text = projectOf(app, id).clips[0]!;
  expect(text).toMatchObject({ type: "text", start: 30, duration: 60, color: "pink", track: projectOf(app, id).tracks[1]!.id });
  expect(await refused(app, "add_text", { text: "x", start: 0, duration: 1, color: "mauve" })).toBe(
    "color: unknown variant `mauve`, expected one of `blue`, `cyan`, `green`, `yellow`, `orange`, `red`, `purple`, `pink`",
  );
  expect(await refused(app, "add_text", { start: 0, duration: 1 })).toBe("text is required");
  expect(await said(app, "add_clip", { clip: { type: "solid", start: 0, duration: 30, fill: [0, 0, 0, 1] } })).toMatch(/^added clip c\d+$/);
  expect(await refused(app, "add_clip", { clip: { type: "video", start: 0, duration: 30 } })).toBe("clip: missing field `media`");
  expect(await refused(app, "add_clip", {})).toBe("clip must be an object");
  const updated = await said(app, "update_clip", { clip_id: text.id, patch: { start: 90 } });
  expect(updated.startsWith(`updated ${text.id}: {"id":"${text.id}"`)).toBe(true);
  expect(clipOf(projectOf(app, id), text.id)!.start).toBe(90);
  expect(await refused(app, "update_clip", { clip_id: "nope", patch: {} })).toBe("no clip nope");
  expect(await refused(app, "update_clip", { clip_id: text.id, patch: { start: "soon" } })).toBe(
    'patched clip is invalid: invalid type: string "soon", expected i64',
  );
  expect(await said(app, "update_clips", { clip_ids: [text.id], patch: { opacity: 0.5 } })).toBe(`updated 1 clip(s): ${text.id}`);
  expect(await said(app, "update_clips", { track: text.track, start: 2, patch: { opacity: 0.5 } })).toBe(`updated 1 clip(s): ${text.id}`);
  expect(await said(app, "update_clips", { label: "Nobody:", patch: { opacity: 0.5 } })).toBe("no clips matched; nothing changed");
  expect(await refused(app, "update_clips", { patch: {} })).toBe("pick the clips: clip_ids, label, person or track");
  expect(await said(app, "set_keyframes", { clip_id: text.id, param: "opacity", keyframes: [{ frame: 10, value: 1 }, { frame: 0, value: 0 }] })).toBe(
    `set opacity keyframes on ${text.id}`,
  );
  expect(clipOf(projectOf(app, id), text.id)!.keyframes!.opacity!.map((key) => key.frame)).toEqual([0, 10]);
  expect(await refused(app, "set_keyframes", { clip_id: text.id, param: "volume_db", keyframes: [] })).toBe(
    "volume_db is not animatable here; use one of opacity, x, y, scale, rotation, shake, size, tracking, glow.radius, glow.strength, leader.x, leader.y",
  );
  expect(await refused(app, "set_keyframes", { clip_id: text.id, param: "opacity" })).toBe(
    "keyframes: invalid type: null, expected a sequence",
  );
  expect(await said(app, "set_in_out", { in: 1, out: 2 })).toBe("in/out: 1.00s to 2.03s (31 frames)");
  expect(await refused(app, "set_in_out", { in: 3 })).toBe("mark_in must not come after mark_out");
  expect(await said(app, "set_in_out", { in: null, out: null })).toBe("in and out points cleared");
  expect(await said(app, "delete_clips", { clip_ids: [text.id] })).toBe("deleted 1 clip(s)");
  expect(await refused(app, "delete_clips", {})).toBe("invalid type: null, expected a sequence");
  // Only the solid is left, on V2: V3 and A2 go (V1 and A1 always stay).
  expect(await said(app, "tidy_tracks")).toBe("moved 0 clip(s) down, removed 2 empty track(s)");
});

test("deleting a card can close the gap it leaves and drop it from the script", async () => {
  const { app, id, fixture } = setUp("tools-gap");
  await fixture.store.update(id, "test", (project) => {
    const [v1, v2] = [project.tracks[0]!.id, project.tracks[1]!.id];
    project.clips.push(clip({ id: "card", track: v1, start: 0, duration: 90, type: "solid" }));
    project.clips.push(clip({ id: "after", track: v2, start: 90, duration: 30, type: "solid" }));
    project.script = { blocks: [{ kind: "narration", text: "Words.", clip: "card" }] };
  });
  expect(await said(app, "delete_clips", { clip_ids: ["card"], close_gap: true, drop_from_script: true })).toBe(
    "deleted 1 clip(s); closed 90 frame(s) of gap",
  );
  const project = projectOf(app, id);
  expect(clipOf(project, "after")!.start).toBe(0);
  expect(project.script!.blocks).toEqual([]);
});

test("a project too big to send whole gives its clips up to the budget and says where to carry on", async () => {
  const { app } = setUp("tools-big");
  for (let at = 0; at < 400; at++) {
    await said(app, "add_clip", { clip: { type: "solid", track: "v2", start: 30 + at * 2, duration: 2, fill: [0, 0, 0, 1], name: "x".repeat(60) } });
  }
  const big = await said(app, "get_project");
  expect(big.length).toBeLessThan(37_000);
  const cut = JSON.parse(big) as { clips_shown: { shown: number; of: number; next_start_seconds: number }; project: Project };
  expect(cut.clips_shown.of).toBe(400);
  expect(cut.project.clips.length).toBe(cut.clips_shown.shown);
  const after = JSON.parse(await said(app, "get_project", { start: cut.clips_shown.next_start_seconds })) as { project: Project };
  expect(after.project.clips[0]!.start).toBe(Math.round(cut.clips_shown.next_start_seconds * 30));
});

test("markers, the project and the edit context read back as JSON", async () => {
  const { app, id } = setUp("tools-read");
  expect(await said(app, "markers")).toBe('{"markers":[]}');
  expect(await said(app, "markers", { add: [{ name: "door slam", frame: 40 }] })).toBe(
    '{"added":[{"frame":40,"name":"door slam"}],"markers":["door slam@40"],"removed":0}',
  );
  expect(await refused(app, "markers", { add: [{ frame: 1 }] })).toBe('add 1: name is required ("door slam")');
  await said(app, "add_clip", { clip: { type: "solid", track: "v1", start: 0, duration: 30, fill: [0, 0, 0, 1] } });
  const project = JSON.parse(await said(app, "get_project")) as Record<string, unknown>;
  expect(project.rev).toBe(3);
  expect(project.duration_frames).toBe(30);
  expect(project.duration_seconds).toBe(1);
  expect(project.track_labels).toEqual({ v1: "V1", v2: "V2", v3: "V3", a4: "A1", a5: "A2" });
  expect((project.project as Project).id).toBe(id);
  const context = JSON.parse(await said(app, "get_edit_context")) as Record<string, unknown>;
  expect(Object.keys(context)).toEqual([
    "audit",
    "clips",
    "cut_ins",
    "duration_frames",
    "footage_blocks",
    "id",
    "markers",
    "media",
    "rev",
    "sections",
    "settings",
    "smoothing",
    "speaker_line_counts",
    "style",
    "subtitles_in_span",
    "times",
    "tracks",
  ]);
  expect(context.clips).toEqual(["c6 V1 solid [0,30)"]);
  expect(context.tracks).toEqual(["v1 V1", "v2 V2", "v3 V3", "a4 A1", "a5 A2"]);
  expect(context.markers).toEqual(["door slam@40"]);
  expect(context.audit).toEqual({ clips: 1, frames: 30, issues: [] });
  const byId = JSON.parse(await said(app, "get_edit_context", { clip_ids: ["c6"] })) as Record<string, unknown>;
  expect(Object.keys(byId)).toEqual(["audit", "clips", "duration_frames", "rev"]);
  expect((byId.clips as { id: string }[])[0]!.id).toBe("c6");
  const transcript = JSON.parse(await said(app, "get_edit_context", { include_transcript: true })) as Record<string, unknown>;
  expect(transcript.transcript).toBe("No transcribed speech on the timeline.");
});

test("the edit context keeps to its budget, saying how many clips it left out", async () => {
  const { app, id, fixture } = setUp("tools-budget");
  await fixture.store.update(id, "test", (project) => {
    for (let index = 0; index < 1500; index++) {
      project.clips.push(
        clip({ id: `x${index}`, track: "v1", start: index * 10, duration: 10, type: "text", text: `line number ${index} of a long edit` }),
      );
    }
  });
  const answer = await said(app, "get_edit_context");
  const context = JSON.parse(answer) as Record<string, unknown>;
  // Near the budget: the clips fill what the rest leaves (their list's brackets and the note on what was cut come on top, as in the Rust).
  expect(Buffer.byteLength(answer)).toBeLessThanOrEqual(36_200);
  expect(Buffer.byteLength(answer)).toBeGreaterThan(35_900);
  expect(context.clips_cut).toBe(`${(context.clips as string[]).length} of 1500 clips shown; narrow with section, start/end or clip_ids`);
  // Narrowed to a span, it all fits.
  const narrow = JSON.parse(await said(app, "get_edit_context", { start: 0, end: 10 })) as Record<string, unknown>;
  expect((narrow.clips as string[]).length).toBe(30);
  expect(narrow.clips_cut).toBeUndefined();
});

test("a plan saves once, dry runs save nothing, and a stale one is refused", async () => {
  const { app, id } = setUp("tools-plan");
  const operations = [
    { op: "add", as: "card", clip: { type: "solid", track: "v1", start: 0, duration: 60, fill: [0, 0, 0, 1] } },
    { op: "transition", kind: "dip", at: 30 },
  ];
  const dry = JSON.parse(await said(app, "apply_edit_plan", { base_rev: 1, operations, dry_run: true })) as Record<string, unknown>;
  expect(dry.saved).toBe(false);
  expect(dry.rev).toBe(1);
  expect(projectOf(app, id).clips).toEqual([]);
  const done = JSON.parse(await said(app, "apply_edit_plan", { base_rev: 1, operations })) as Record<string, unknown>;
  expect(done).toMatchObject({ rev: 2, saved: true, smoothing_started: [] });
  expect((done.audit as { issues: { kind: string }[] }).issues.map((issue) => issue.kind)).toEqual(["silent_transition"]);
  expect(projectOf(app, id).clips.length).toBe(2);
  expect(await refused(app, "apply_edit_plan", { base_rev: 1, operations })).toBe(
    "revision conflict: expected 1, current 2; nothing saved; refresh get_edit_context",
  );
  expect(await refused(app, "apply_edit_plan", { base_rev: 2, operations: [{ op: "nope" }] })).toBe(
    "operation 1: unknown op nope; use add, update, delete, keyframes, cover_cut_in, desktop, file_viewer, film_look, red_quote, annotate, call, transition, evidence_board, evidence_card, date_title, place_label, title_collage, desktop_profile, intro_captions, photo_inset, countdown, map_pin, split_screen, fast_forward, disclaimer, text_slam, timeline_bar, markers, tidy_tracks; nothing saved",
  );
  expect(await refused(app, "apply_edit_plan", { operations })).toBe("base_rev is required");
  expect(await refused(app, "apply_edit_plan", { base_rev: 2, operations, review_frames: [-1] })).toBe(
    "give at most 24 nonnegative integer frames",
  );
  // Review frames render after the save; a frame past the end is said in the report.
  const reviewed = await tool(app, "apply_edit_plan", { base_rev: 2, operations: [{ op: "tidy_tracks" }], review_frames: [500] });
  expect(reviewed.isError).toBe(false);
  expect(JSON.parse(reviewed.content[0]!.text!).review_error).toBe("a review frame is past the timeline's end");
  const review = JSON.parse(await said(app, "review_edit")) as Record<string, unknown>;
  expect(Object.keys(review)).toEqual(["audit", "rev", "smoothing", "subtitle_coverage"]);
});

test("a board's shutter comes in with the plan, saved once with it", async () => {
  const { app, id, fixture } = setUp("tools-board");
  const photo = `${fixture.dir}/photo.png`;
  // A tiny PNG as the photo's media (only its size matters here).
  write(photo, "not really a png");
  await fixture.store.update(id, "test", (project) => {
    project.media.push({ id: "m1", name: "photo.png", path: photo, kind: "image", duration: 30, width: 1200, height: 900, fps: 0, has_audio: false });
  });
  const result = JSON.parse(
    await said(app, "apply_edit_plan", {
      base_rev: 2,
      operations: [{ op: "evidence_board", start: 30, items: [{ media: "m1", label: "the note", at: 60 }] }],
    }),
  ) as Record<string, unknown>;
  expect(result.rev).toBe(3);
  const project = projectOf(app, id);
  const shutter = project.media.find((own) => own.name.startsWith("shutter-"))!;
  expect(shutter.markers).toEqual([{ time: 0.085, name: "hit" }]);
  const own = project.clips.find((clip) => clip.name === "Evidence board · shutter")!;
  // No speech to measure: about where it sits on a typical edit.
  expect(own).toMatchObject({ type: "audio", media: shutter.id, volume_db: -14, start: 60 - 3 });
});

test("a bundled sound lands its hit on each time asked, never on A1", async () => {
  const { app, id } = setUp("tools-sfx");
  expect(await refused(app, "add_sound_effect", { sound: "boom", times: [1] })).toBe("no sound boom; use one of shutter");
  expect(await refused(app, "add_sound_effect", { sound: "shutter" })).toBe("give times (timeline seconds) or markers (names)");
  expect(await said(app, "add_sound_effect", { sound: "shutter", times: [2, 0.05], volume_db: -6 })).toBe(
    "placed shutter at 2.00s, 0.05s (replacing 0 already near those times)",
  );
  const project = projectOf(app, id);
  const placed = project.clips.filter((clip) => clip.name === "shutter");
  expect(placed.map((clip) => [clip.start, clip.duration])).toEqual([
    [57, 5],
    [0, 4],
  ]);
  expect(placed.every((clip) => clip.track !== project.tracks.find((track) => track.kind === "audio")!.id)).toBe(true);
  // Again on the same time: the old one gives way.
  expect(await said(app, "add_sound_effect", { sound: "shutter", times: [2] })).toBe(
    "placed shutter at 2.00s (replacing 1 already near those times)",
  );
  expect(fs.existsSync(`${fixture!.home}/sfx`)).toBe(true);
});

test("a batch runs calls in order, fills in $N, and stops at the first failure", async () => {
  const { app, id } = setUp("tools-batch");
  const result = await tool(app, "batch", {
    calls: [
      { tool: "add_text", args: { text: "Hi", start: 0, duration: 1 } },
      { tool: "set_keyframes", args: { clip_id: "$1", param: "opacity", keyframes: [{ frame: 0, value: 0 }] } },
      { tool: "export" },
      { tool: "tidy_tracks" },
    ],
  });
  expect(result.isError).toBe(false);
  const texts = result.content.map((item) => item.text);
  const added = projectOf(app, id).clips[0]!.id;
  expect(texts).toEqual([
    `[1] add_text: added text clip ${added}`,
    `[2] set_keyframes: set opacity keyframes on ${added}`,
    "[3] export: FAILED: export can't run in a batch; call it on its own",
    "stopped; calls 4 to 4 didn't run",
  ]);
  const going = await tool(app, "batch", {
    keep_going: true,
    calls: [{ tool: "update_clip", args: { clip_id: "$2" } }, { tool: "tidy_tracks" }],
  });
  expect(going.content.map((item) => item.text)).toEqual([
    "[1] update_clip: FAILED: $2: there's no earlier call 2",
    "[2] tidy_tracks: moved 0 clip(s) down, removed 2 empty track(s)",
  ]);
  // Every call failed: the batch did.
  expect(await refused(app, "batch", { calls: [{ tool: "nope" }] })).toBe("[1] nope: FAILED: unknown tool nope");
  expect(await refused(app, "batch", {})).toBe("calls must be a list");
});

test("the workflow skill starts the watcher; an unknown skill lists the rest", async () => {
  const { app } = setUp("tools-skill");
  let watched = 0;
  hooks.watchInBackground = () => {
    watched += 1;
  };
  expect((await said(app, "skill", { name: "edit-workflow" })).startsWith("THE EDITING WORKFLOW")).toBe(true);
  expect(watched).toBe(1);
  expect(await said(app, "skill", { name: "final-pass" })).toContain("THE FINAL PASS");
  expect(watched).toBe(1);
  expect(await refused(app, "skill", { name: "nope" })).toBe(
    "no skill nope; there are edit-workflow, cut-ins, feedback, final-pass, intro, music-and-sound, outro, research, subtitle-video, subtitles, transitions",
  );
});

test("a cut-in is covered in one call, its card gone and its voice-over on A1", async () => {
  const { app, id, fixture } = setUp("tools-cutin");
  await fixture.store.update(id, "test", (project) => {
    project.media.push({ id: "m1", name: "b.mp4", path: "/x/b.mp4", kind: "video", duration: 600, width: 1920, height: 1080, fps: 30, has_audio: true });
    project.media.push({ id: "vo", name: "vo.wav", path: "/x/vo.wav", kind: "audio", duration: 20, width: 0, height: 0, fps: 0, has_audio: true });
    project.clips.push(clip({ id: "card", track: "v1", start: 300, duration: 300, type: "solid", fill: [0, 0, 0, 1], link: "l9" }));
    project.clips.push(clip({ id: "words", track: "v2", start: 300, duration: 300, type: "text", text: "The building.", link: "l9" }));
    project.clips.push(clip({ id: "voice", track: "a5", start: 300, duration: 300, type: "audio", media: "vo", name: "Voice-over" }));
    project.script = { blocks: [{ kind: "narration", text: "The building.", clip: "card", voiceover: "voice" }] };
  });
  const report = JSON.parse(
    await said(app, "cover_cut_in", { cut_in: 1, shots: [{ media: "m1", source_in: 10 }, { media: "m1", source_in: 100, at: 15 }] }),
  ) as Record<string, unknown>;
  expect(report).toMatchObject({
    cut_in: 1,
    span: [10, 20],
    removed_card_and_words: ["card", "words"],
    voiceover: { clip: "voice", moved_to_a1: true },
    smoothing_started: [],
  });
  const project = projectOf(app, id);
  expect(clipOf(project, "voice")).toMatchObject({ track: "a4", color: "purple" });
  // Two moments dissolve: the first runs 12 frames on under the second, which fades in on the track above.
  const shots = project.clips.filter((own) => own.name?.startsWith("Cut-in 1 · B-roll:"));
  expect(shots.map((own) => [own.start, own.duration, own.fade_in, own.fade_out])).toEqual([
    [300, 162, 0, 0],
    [450, 150, 12, 0],
  ]);
  const level = (track: string) => project.tracks.findIndex((own) => own.id === track);
  expect(level(shots[1]!.track)).toBeGreaterThan(level(shots[0]!.track));
  // No vertical drop unless asked for (the team isn't a fan of it).
  expect(report.vertical_drop).toBeNull();
  expect(await refused(app, "cover_cut_in", { cut_in: 2, shots: [{ media: "m1", source_in: 0 }] })).toBe("cut_in is 1 to 1");
  expect(await refused(app, "cover_cut_in", { cut_in: 1 })).toBe("arguments: missing field `shots`");
  expect(await refused(app, "cover_cut_in", { cut_in: 1, shots: [{ media: "m1", source_in: 597 }] })).toBe(
    "shot 1: m1 runs out at 600.00 s; from 597.00 s at 0.8× this shot needs 8.00 s of it",
  );
});

test("export starts through the exports with the default path, and says a subtitled video goes to Drive", async () => {
  const { app, id } = setUp("tools-export");
  const started: unknown[] = [];
  app.exports = {
    start: async (_store, _library, project, options, path) => {
      started.push({ id: project.id, format: options.format, path });
      return `${path}.mp4`;
    },
    cancel: () => false,
    running: () => false,
    exported: () => false,
  };
  hooks.defaultExportPath = (_store, project) => `/tmp/${project.name}`;
  expect(await said(app, "export")).toBe("export started → /tmp/tools.mp4");
  expect(await said(app, "export", { path: "~/out", options: { format: "prores" } })).toBe(`export started → ${process.env.HOME}/out.mp4`);
  expect(started).toEqual([
    { id, format: "h264", path: "/tmp/tools" },
    { id, format: "prores", path: `${process.env.HOME}/out` },
  ]);
  expect(await refused(app, "export", { options: { format: "avi" } })).toBe(
    "export options: unknown variant `avi`, expected one of `h264`, `hevc`, `prores`, `gif`, `wav`, `mp3`, `png`",
  );
  hooks.waitForSmoothing = async () => false;
  expect(await refused(app, "export", { options: { wait_for_smoothing: true } })).toBe(
    "optional optical flow is still running; export the current timeline with wait_for_smoothing false or wait for it to finish",
  );
});
