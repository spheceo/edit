// kinds.ts's tests: work outside someone's kinds of video is hidden, not read-only
// (the user, Oct 23): not listed, not opened, not changed, not started.

import { afterEach, expect, test } from "bun:test";

import * as accounts from "../src/accounts.ts";
import * as kinds from "../src/kinds.ts";
import type { Project, Style } from "../src/model.ts";
import { respond } from "../src/http/server.ts";
import { buildRouter } from "../src/routes.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip, media } from "./helpers/model.ts";

afterEach(() => accounts.resetForTests());

const SETTINGS = { width: 1920, height: 1080, fps: 30 };

/** Footage on the first track, and (`subtitles`) a subtitle over it, or (`narration`) a caption card. */
function fill(project: Project, add: { subtitles?: boolean; caption?: boolean }): void {
  project.media.push(media({ id: "m1", name: "a.mp4", path: "/nowhere/a.mp4", kind: "video", duration: 10 }));
  const [v1, v2] = project.tracks;
  project.clips.push(clip({ id: "c1", type: "video", track: v1!.id, media: "m1", start: 0, duration: 90, source_in: 0 }));
  if (add.subtitles) project.clips.push(clip({ id: "c2", type: "text", track: v2!.id, name: "Subtitle · Officer", start: 0, duration: 30, text: "Hands up." }));
  if (add.caption) project.clips.push(clip({ id: "c3", type: "text", track: v2!.id, name: "Caption · Officer", start: 30, duration: 30, text: "Officer" }));
}

test("who may work on what: a style's edits, subtitled videos, and footage-only projects for subtitlers", () => {
  const shape = (style: Style, subtitles = false, footageOnly = false) => ({ style, subtitles, footageOnly });
  const subtitler = new Set(["use", "video.subtitles"]);
  const courtroom = new Set(["use", "edit.courtroom"]);
  expect(kinds.mayWork(shape("bodycam", true), subtitler)).toBe(true);
  expect(kinds.mayWork(shape("courtroom", false, true), subtitler)).toBe(true);
  expect(kinds.mayWork(shape("bodycam"), subtitler)).toBe(false);
  expect(kinds.mayWork(shape("courtroom"), courtroom)).toBe(true);
  expect(kinds.mayWork(shape("courtroom", true), courtroom)).toBe(false);
  expect(kinds.mayWork(shape("bodycam", false, true), courtroom)).toBe(false);
  expect([kinds.mayStart("bodycam", subtitler), kinds.mayStart("bodycam", courtroom), kinds.mayStart("courtroom", courtroom)]).toEqual([true, false, true]);
  expect([kinds.mayEdit("bodycam", subtitler), kinds.mayEdit("courtroom", courtroom), kinds.editsAny(subtitler), kinds.editsAny(courtroom)]).toEqual([false, true, false, true]);
  // Everything: nobody signed in (tests, a local relay), an admin, a token from before the kinds.
  expect(kinds.granted()).toBeNull();
  accounts.signedInForTests(["use"], true);
  expect(kinds.granted()).toBeNull();
  accounts.signedInForTests(["use", "cloud", "drive"]);
  expect(kinds.granted()).toBeNull();
  accounts.signedInForTests(["use", "cloud", "video.subtitles"]);
  expect(kinds.granted()).toEqual(new Set(["use", "cloud", "video.subtitles"]));
});

test("a subtitler sees subtitled videos only, can start one, and can't turn it into an edit", async () => {
  const { store, cleanup } = fixtureHome("kinds-subtitler");
  try {
    // Made by someone who edits everything.
    const edit = store.createAs("Courtroom edit", "courtroom", SETTINGS).project.id;
    await store.update(edit, "test", (project) => fill(project, { caption: true }));
    const subtitled = store.createAs("Subtitled", "bodycam", SETTINGS).project.id;
    await store.update(subtitled, "test", (project) => fill(project, { subtitles: true }));

    accounts.signedInForTests(["use", "video.subtitles"]);
    expect(store.visible().map((one) => one.name).sort()).toEqual(["Subtitled"]);
    expect(store.list().length).toBe(2);
    expect(store.unavailable(edit)).toBe("This project isn't available to your account: it's one of the courtroom edits. An admin can give you Courtroom edits at accounts.spheceo.com.");
    expect(() => store.resolve(edit)).toThrow("isn't available to your account");
    expect(store.resolve()).toBe(subtitled);
    await expect(store.update(edit, "agent", (project) => void (project.name = "mine"))).rejects.toThrow("isn't available to your account");
    expect(store.get(edit)!.project.name).toBe("Courtroom edit");

    // A new one starts empty (open to them), takes footage, then subtitles.
    const mine = store.createAs("New subtitles", "bodycam", SETTINGS).project.id;
    expect(store.visible().some((one) => one.id === mine)).toBe(true);
    await store.update(mine, "ui", (project) => fill(project, {}));
    expect(store.visible().find((one) => one.id === mine)?.footage_only).toBe(true);
    await store.update(mine, "agent", (project) => void project.clips.push(clip({ id: "s1", type: "text", track: project.tracks[1]!.id, name: "Subtitle · Officer", start: 0, duration: 30, text: "Go." })));
    // A caption card would make it a bodycam edit: refused, nothing saved.
    const rev = store.get(mine)!.rev;
    await expect(store.update(mine, "agent", (project) => void project.clips.push(clip({ id: "k1", type: "text", track: project.tracks[1]!.id, name: "Caption · Officer", start: 40, duration: 30, text: "Officer" })))).rejects.toThrow(
      "Your account can't make bodycam edits: an admin can give you Bodycam edits at accounts.spheceo.com.",
    );
    expect(store.get(mine)!.rev).toBe(rev);
    // The same through a whole save (the UI's PUT).
    const changed = structuredClone(store.get(mine)!.project) as Project;
    changed.style = "courtroom";
    changed.clips = changed.clips.filter((one) => one.id !== "s1");
    changed.clips.push(clip({ id: "k2", type: "text", track: changed.tracks[1]!.id, name: "Caption · Officer", start: 40, duration: 30, text: "Officer" }));
    await expect(store.replace(mine, rev, changed, "ui")).rejects.toMatchObject({ kind: "refused" });
  } finally {
    cleanup();
  }
});

test("the routes: hidden projects aren't listed or opened, and other styles can't be started", async () => {
  const { app, store, cleanup } = fixtureHome("kinds-routes");
  try {
    const router = buildRouter();
    const call = async (method: string, path: string, body?: unknown) => {
      const response = (await respond(app, router, new Request(`http://localhost:7700${path}`, { method, headers: { host: "localhost:7700", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), null))!;
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const bodycam = store.createAs("Bodycam edit", "bodycam", SETTINGS).project.id;
    await store.update(bodycam, "test", (project) => fill(project, { caption: true }));
    const courtroom = store.createAs("Courtroom edit", "courtroom", SETTINGS).project.id;
    await store.update(courtroom, "test", (project) => fill(project, { caption: true }));

    accounts.signedInForTests(["use", "edit.courtroom"]);
    expect(((await call("GET", "/api/projects")).body.projects as { id: string }[]).map((one) => one.id)).toEqual([courtroom]);
    expect(await call("GET", `/api/projects/${bodycam}`)).toEqual({ status: 403, body: { error: kinds.unavailable({ style: "bodycam", subtitles: false, footageOnly: false }) } });
    expect((await call("GET", `/api/projects/${courtroom}`)).status).toBe(200);
    expect((await call("DELETE", `/api/projects/${bodycam}`)).status).toBe(403);
    expect(store.get(bodycam)).not.toBeNull();
    expect(await call("POST", "/api/projects", { name: "x", style: "bodycam" })).toEqual({ status: 403, body: { error: kinds.cantMake("edit.bodycam") } });
    expect((await call("POST", "/api/projects", { name: "x", style: "courtroom" })).status).toBe(200);
  } finally {
    cleanup();
  }
});
