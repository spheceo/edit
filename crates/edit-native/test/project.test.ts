import { describe, expect, test } from "bun:test";

import { native, solidProject } from "./native";

describe("project JSON", () => {
  test("commit validates, fills defaults and writes serde's pretty JSON", () => {
    const committed = native.projectCommit("p-commit", 2, JSON.stringify(solidProject("other")));
    const saved = JSON.parse(committed.pretty);
    // The id given wins; defaults are filled.
    expect(saved.id).toBe("p-commit");
    expect(saved.tracks[0].hidden).toBe(false);
    expect(saved.clips[0].opacity).toBe(1);
    // serde_json's pretty printer: two spaces, no trailing newline.
    expect(committed.pretty.startsWith('{\n  "version": 1,\n  "id": "p-commit",')).toBe(true);
    expect(committed.pretty.endsWith("\n}")).toBe(true);
    expect(JSON.parse(committed.json)).toEqual(saved);
    // Committing what was written gives the same bytes back.
    expect(native.projectCommit("p-commit", 3, committed.pretty).pretty).toBe(committed.pretty);
  });

  test("an invalid project is refused with Project::validate's words", () => {
    const project = solidProject("p-bad");
    project.clips[0].track = "nowhere";
    const why = native.projectValidate(JSON.stringify(project));
    expect(why).toContain("nowhere");
    expect(() => native.projectCommit("p-bad", 1, JSON.stringify(project))).toThrow(why!);
    expect(native.projectValidate(JSON.stringify(solidProject()))).toBeNull();
    expect(native.projectValidate("{not json")).toBeString();
  });

  test("load says why a file can't be used", () => {
    expect(native.projectLoad(JSON.stringify(solidProject())).problem).toBeUndefined();
    expect(native.projectLoad('{"id": "x", "clips": 7}').problem).toStartWith("it can't be read: ");
    const project = solidProject();
    project.clips[0].track = "nowhere";
    expect(native.projectLoad(JSON.stringify(project)).problem).toStartWith("it doesn't validate: ");
  });

  test("a negative zero keeps its sign where it can", () => {
    const project = solidProject("p-floats") as ReturnType<typeof solidProject> & { clips: Record<string, unknown>[] };
    project.clips[0]!.keyframes = { opacity: [{ frame: 0, value: 1, ease: "linear", handle_in: { speed: 1, influence: 0.5 } }] };
    let json = JSON.stringify(project).replace('"speed":1', '"speed":-0');
    let saved = JSON.parse(native.projectCommit("p-floats", 1, json).pretty);
    expect(saved.clips[0].keyframes.opacity[0].handle_in.speed).toBe(-0);
    // A `-0` in an integer field (JS's Math.round(-0.2)) reads as 0, and then every -0 does.
    json = json.replace('"start":0', '"start":-0');
    saved = JSON.parse(native.projectCommit("p-floats", 2, json).pretty);
    expect(Object.is(saved.clips[0].start, 0)).toBe(true);
    expect(Object.is(saved.clips[0].keyframes.opacity[0].handle_in.speed, 0)).toBe(true);
    // A "-0" in a string is left alone.
    const named = { ...project, name: "-0" };
    expect(JSON.parse(native.projectCommit("p-floats", 3, JSON.stringify(named).replace('"start":0', '"start":-0')).pretty).name).toBe("-0");
  });

  test("refs reach the committed project; an old one is stale", () => {
    const json = JSON.stringify(solidProject("p-ref", 90));
    native.projectCommit("p-ref", 1, json);
    const done = native.removeTime({ ref: { id: "p-ref", rev: 1 } }, 30, 60);
    expect(done.rippled.frames).toBe(30);
    expect(JSON.parse(done.json).clips[0].duration).toBe(60);
    // Only the last two revs are kept.
    native.projectCommit("p-ref", 2, json);
    native.projectCommit("p-ref", 3, json);
    expect(() => native.sections({ ref: { id: "p-ref", rev: 1 } })).toThrow("stale project");
    expect(native.sections({ ref: { id: "p-ref", rev: 3 } }).parts).toEqual([]);
    expect(() => native.sections({ ref: { id: "p-never", rev: 1 } })).toThrow("stale project");
  });

  test("speeding a span up holds the clips asked to keep their speed", () => {
    const project = solidProject("p-speed", 90);
    const done = native.speedSpanHolding({ json: JSON.stringify(project) }, 30, 90, 2, []);
    expect(done.rippled.frames).toBe(30);
    expect(JSON.parse(done.json).clips[0].duration).toBe(60);
  });

  test("animatable params and keyframe sampling", () => {
    const params = native.animatableParams();
    expect(Object.keys(params).sort()).toEqual(["adjustment", "audio", "solid", "text", "video", "waveform"]);
    expect(params.audio).toEqual(["volume_db"]);
    expect(params.video).toContain("scale");
    const keys = [
      { frame: 0, value: 0, ease: "linear" as const },
      { frame: 10, value: 10, ease: "linear" as const },
    ];
    expect(native.sampleKeyframes(keys, [-5, 0, 5, 10, 20])).toEqual([0, 0, 5, 10, 10]);
    expect(native.sampleKeyframes([], [0])).toEqual([null]);
  });
});
