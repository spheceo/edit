// pointers.ts's tests: what points at someone ends with their shot (Marc,
// Judge EXPLODES v2: "Text is still visible here despite not pointing to
// Timothy"), and blurs that stay put across a cut are flagged.

import { expect, test } from "bun:test";

import type { Project } from "../src/model.ts";
import { firstCut, pointerIssues } from "../src/pointers.ts";
import { fixtureHome } from "./helpers/home.ts";
import { clip, media } from "./helpers/model.ts";

const SETTINGS = { width: 1920, height: 1080, fps: 30 };

/** Two shots on V1 (a cut at 90), the second a continuation from 180 that isn't a cut. */
function footage(project: Project): void {
  project.media.push(media({ id: "m1", name: "a.mp4", path: "/nowhere/a.mp4", kind: "video", duration: 60, width: 1920, height: 1080 }));
  project.media.push(media({ id: "m2", name: "b.mp4", path: "/nowhere/b.mp4", kind: "video", duration: 60, width: 1920, height: 1080 }));
  const v1 = project.tracks[0]!.id;
  project.clips.push(clip({ id: "f1", type: "video", track: v1, media: "m1", start: 0, duration: 90, source_in: 0 }));
  project.clips.push(clip({ id: "f2", type: "video", track: v1, media: "m2", start: 90, duration: 90, source_in: 0 }));
  // m2 running on: the same shot.
  project.clips.push(clip({ id: "f3", type: "video", track: v1, media: "m2", start: 180, duration: 90, source_in: 3 }));
}

const callout = (project: Project, id: string, start: number, duration: number) =>
  clip({
    id,
    type: "text",
    track: project.tracks[2]!.id,
    name: "Callout O'Neill",
    start,
    duration,
    text: "THE FATHER",
    style: { leader: { x: 100, y: -50, width: 3, color: [1, 1, 1, 1], draw: 8 } },
  });

test("a callout up past its shot's cut ends at the cut, on any write; one inside its shot, or over a take running on, is left", async () => {
  const { store, cleanup } = fixtureHome("pointers");
  try {
    const id = store.createAs("Judge", "courtroom", SETTINGS).project.id;
    await store.update(id, "test", (project) => footage(project));
    await store.update(id, "agent", (project) => {
      project.clips.push(callout(project, "k1", 40, 120));
      project.clips.push(callout(project, "k2", 100, 150));
      project.clips.push(clip({ id: "s1", type: "adjustment", track: project.tracks[1]!.id, name: "Spotlight O'Neill", start: 40, duration: 120 }));
    });
    const after = store.get(id)!.project;
    const span = (one: string) => after.clips.find((clip) => clip.id === one)!;
    expect([span("k1").start, span("k1").duration]).toEqual([40, 50]);
    expect([span("s1").start, span("s1").duration]).toEqual([40, 50]);
    // From 100 to 250 it's one take (f2 then f3 running on): no cut.
    expect(span("k2").duration).toBe(150);
    expect(pointerIssues(after)).toEqual([]);
  } finally {
    cleanup();
  }
});

test("a cut made later under a callout that was fine ends it too; one from before over pictures left as they were is only flagged", async () => {
  const { store, cleanup } = fixtureHome("pointers-later");
  try {
    const live = store.createAs("Judge", "courtroom", SETTINGS);
    const old = structuredClone(live.project) as Project;
    footage(old);
    old.clips.push(callout(old, "old", 40, 120));
    // As an older Edit left it: across the cut at 90.
    store.putFromCloud(old, "cloud");
    const id = old.id;
    await store.update(id, "agent", (project) => void (project.name = "Judge v3"));
    expect(store.get(id)!.project.clips.find((clip) => clip.id === "old")!.duration).toBe(120);
    expect(pointerIssues(store.get(id)!.project)).toMatchObject([{ kind: "pointer_off_target", clip: "old", cut: 90 }]);
    // Now a cut lands under k2 (f2 shortened, a new shot after it): k2 ends there.
    await store.update(id, "agent", (project) => {
      project.clips.push(callout(project, "k2", 162, 90));
    });
    expect(store.get(id)!.project.clips.find((clip) => clip.id === "k2")!.duration).toBe(90);
    await store.update(id, "agent", (project) => {
      const f3 = project.clips.find((clip) => clip.id === "f3")!;
      if (f3.type === "video") f3.media = "m1";
    });
    expect(store.get(id)!.project.clips.find((clip) => clip.id === "k2")!.duration).toBe(18);
  } finally {
    cleanup();
  }
});

test("a blur that tracks but doesn't move at a cut is flagged as off its shot; one keyed at the cut is not", async () => {
  const { store, cleanup } = fixtureHome("pointers-blur");
  try {
    const id = store.createAs("Judge", "courtroom", SETTINGS).project.id;
    await store.update(id, "test", (project) => {
      footage(project);
      const blur = (bid: string, keys: number[], track = project.tracks[1]!.id) =>
        clip({
          id: bid,
          type: "adjustment",
          track,
          name: "Blur · face",
          start: 40,
          duration: 120,
          blur: { radius: 30, shape: "ellipse", x: 0, y: 0, width: 200, height: 200 },
          keyframes: { "blur.x": keys.map((frame) => ({ frame, value: frame })) },
        });
      project.clips.push(blur("b1", [0, 20]));
      project.clips.push(blur("b2", [0, 50], project.tracks[2]!.id));
    });
    const project = store.get(id)!.project;
    expect(firstCut(project, project.clips.find((clip) => clip.id === "b1")!)).toBe(90);
    expect(pointerIssues(project)).toMatchObject([{ kind: "blur_off_shot", clip: "b1", cut: 90 }]);
  } finally {
    cleanup();
  }
});

test("a callout named as one, with no leader line, ends with its shot too", async () => {
  const { store, cleanup } = fixtureHome("pointers-named");
  try {
    const id = store.createAs("Judge", "courtroom", SETTINGS).project.id;
    await store.update(id, "test", (project) => footage(project));
    await store.update(id, "agent", (project) => void project.clips.push(clip({ id: "n1", type: "text", track: project.tracks[2]!.id, name: "Callout O'Neill name", start: 40, duration: 120, text: "TIMOTHY O'NEILL" })));
    expect(store.get(id)!.project.clips.find((one) => one.id === "n1")!.duration).toBe(50);
  } finally {
    cleanup();
  }
});

test("a File Viewer over a cut in the footage under it is flagged; one over a single shot is not", async () => {
  // JJ on Mom & Teen v7: "We keep the file viewer even while changing scenes".
  const { viewersOverCuts } = await import("../src/edit_tools.ts");
  const { store, cleanup } = fixtureHome("pointers-viewer");
  try {
    const id = store.createAs("Mom", "bodycam", SETTINGS).project.id;
    await store.update(id, "test", (project) => {
      footage(project);
      project.media.push(media({ id: "mug", name: "mug.png", path: "/nowhere/mug.png", kind: "image", duration: 30, width: 600, height: 700 }));
      const viewer = (vid: string, start: number) => clip({ id: vid, type: "video", track: project.tracks[1]!.id, media: "mug", name: "File Viewer", start, duration: 120, source_in: 0 });
      project.clips.push(viewer("over", 30), viewer("one", 150));
    });
    const project = store.get(id)!.project;
    expect(viewersOverCuts(project)).toMatchObject([{ kind: "viewer_over_cut", clip: "over", cut: 90 }]);
  } finally {
    cleanup();
  }
});
