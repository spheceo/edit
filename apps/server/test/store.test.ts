import { expect, test } from "bun:test";

import * as fs from "node:fs";

import type { Project } from "../src/model.ts";
import { Store, UpdateError, isSubtitled, type CloudHook } from "../src/store.ts";
import { fixtureHome } from "./helpers/home.ts";

const SETTINGS = { width: 1920, height: 1080, fps: 30 };

function names(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

test("nothing_is_lost_quietly", async () => {
  const { home, store, cleanup } = fixtureHome("store-safety");
  try {
    // A file that won't parse is listed with why, not hidden, and left alone.
    const broken = `${home}/projects/p1-1.json`;
    fs.writeFileSync(broken, '{"id": "p1-1", "name": "Old one", "clips": 7}');
    const summary = store.list().find((entry) => entry.id === "p1-1")!;
    expect(summary.name).toBe("Old one");
    expect(summary.problem).toContain("can't be read");
    expect(store.get("p1-1")).toBeNull();
    expect(fs.readFileSync(broken, "utf8")).toBe('{"id": "p1-1", "name": "Old one", "clips": 7}');

    // Saving keeps the previous version (once per interval).
    const live = store.create("kept", SETTINGS);
    const id = live.project.id;
    const renamed = structuredClone(live.project) as Project;
    renamed.name = "renamed";
    await store.replace(id, live.rev, renamed, "test");
    await store.replace(id, null, renamed, "test");
    expect(names(`${home}/projects/history/${id}`).length).toBe(1);

    // Deleting moves it aside.
    expect(store.delete(id)).toBe(true);
    expect(store.get(id)).toBeNull();
    expect(names(`${home}/projects/deleted`).some((name) => name.startsWith(id) && name.endsWith(".json"))).toBe(true);
  } finally {
    cleanup();
  }
});

test("stale_writer_gets_a_conflict_and_deleted_projects_stay_deleted", async () => {
  const { store, cleanup } = fixtureHome("store-stale");
  try {
    const original = store.create("test", SETTINGS);
    const id = original.project.id;
    const newer = await store.replace(id, original.rev, structuredClone(original.project) as Project, "test");
    const stale = store.commit(id, original.rev, structuredClone(original.project) as Project, "stale");
    await expect(stale).rejects.toBeInstanceOf(UpdateError);
    await stale.catch((error: UpdateError) => expect(error.kind).toBe("conflict"));
    expect(store.delete(id)).toBe(true);
    const late = store.commit(id, newer.rev, structuredClone(newer.project) as Project, "late");
    await late.catch((error: UpdateError) => expect(error.kind).toBe("not_found"));
    await expect(late).rejects.toBeInstanceOf(UpdateError);
    expect(store.get(id)).toBeNull();
  } finally {
    cleanup();
  }
});

test("simultaneous_project_creation_does_not_overwrite_projects", () => {
  const { store, cleanup } = fixtureHome("store-create");
  try {
    const ids = new Set(Array.from({ length: 100 }, () => store.create("test", SETTINGS).project.id));
    expect(ids.size).toBe(100);
    expect(store.list().length).toBe(100);
  } finally {
    cleanup();
  }
});

test("a new project has the house tracks and saves with them", () => {
  const { home, store, cleanup } = fixtureHome("store-new");
  try {
    const live = store.create("  Mom & Teen  ", SETTINGS);
    expect(live.rev).toBe(1);
    expect(live.project.name).toBe("Mom & Teen");
    expect(live.project.tracks.map((track) => `${track.kind}:${track.id}`)).toEqual([
      "video:v1",
      "video:v2",
      "video:v3",
      "audio:a4",
      "audio:a5",
    ]);
    expect(live.project.next_id).toBe(6);
    expect(store.create("   ", SETTINGS).project.name).toBe("Untitled");
    const saved = fs.readFileSync(`${home}/projects/${live.project.id}.json`, "utf8");
    expect(JSON.parse(saved)).toEqual(JSON.parse(JSON.stringify(live.project)));
    // A fresh store reads it back as rev 1.
    const reopened = Store.open(home);
    expect(reopened.get(live.project.id)?.project.name).toBe("Mom & Teen");
  } finally {
    cleanup();
  }
});

test("update edits a copy, validates, and words its failures", async () => {
  const { store, cleanup } = fixtureHome("store-update");
  try {
    const live = store.create("p", SETTINGS);
    const id = live.project.id;
    const events: unknown[] = [];
    store.subscribe((event) => events.push(event));
    const [next, value] = await store.update(id, "agent", (project) => {
      project.name = "edited";
      return 42;
    });
    expect([next.rev, value, next.project.name]).toEqual([2, 42, "edited"]);
    expect(events).toEqual([{ type: "project", id, rev: 2, origin: "agent", project: next.project }]);
    // The live project is frozen; the update's copy was its own.
    expect(Object.isFrozen(next.project)).toBe(true);
    expect(() => {
      (next.project as Project).name = "changed in place";
    }).toThrow();
    await expect(
      store.update(id, "agent", (project) => {
        project.clips.push({ id: "c1", track: "nowhere", start: 0, duration: 10, color: "blue", fade_in: 0, fade_out: 0, type: "solid", fill: [0, 0, 0, 1], opacity: 1 });
      }),
    ).rejects.toThrow("clip c1 is on unknown track nowhere");
    expect(store.get(id)?.rev).toBe(2);
    await expect(store.update("p0-0", "agent", () => 0)).rejects.toThrow("no project p0-0");
  } finally {
    cleanup();
  }
});

test("the cloud hook is asked before every write and told after", async () => {
  const { store, cleanup } = fixtureHome("store-cloud");
  try {
    const asked: string[] = [];
    let refuse: string | null = null;
    // The next mayWrite waits for this (a lock taken over the network).
    let gate: Promise<void> | null = null;
    const hook: CloudHook = {
      async mayWrite(id) {
        asked.push(`may ${id}`);
        if (refuse !== null) throw new Error(refuse);
        const waiting = gate;
        gate = null;
        if (waiting !== null) await waiting;
      },
      wrote: (id) => asked.push(`wrote ${id}`),
      created: (id) => asked.push(`created ${id}`),
    };
    store.attachCloud(hook);
    const live = store.create("cloud", SETTINGS);
    const id = live.project.id;
    expect(asked).toEqual([`created ${id}`]);
    await store.update(id, "ui", (project) => {
      project.name = "one";
    });
    expect(asked.slice(1)).toEqual([`may ${id}`, `wrote ${id}`]);

    refuse = "Sam is editing this project on kenobi";
    await expect(store.update(id, "ui", () => 0)).rejects.toThrow("Sam is editing this project on kenobi");
    refuse = null;

    // A write waiting on the lock loses to one that landed meanwhile: the rev is checked again.
    let open = () => {};
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const slow = store.update(id, "ui", (project) => {
      project.name = "slow";
    });
    const fast = store.checkout(id)!;
    fast.project.name = "fast";
    await store.commit(id, fast.rev, fast.project, "ui");
    open();
    await expect(slow).rejects.toThrow("project changed while editing; retry");
    expect(store.get(id)?.project.name).toBe("fast");

    // Invalid before refused.
    refuse = "held elsewhere";
    const bad = store.checkout(id)!;
    bad.project.settings.fps = 0;
    const invalid = (await store.commit(id, bad.rev, bad.project, "ui").catch((error: unknown) => error)) as UpdateError;
    expect([invalid.kind, invalid.message]).toEqual(["invalid", "settings width, height and fps must be positive"]);
  } finally {
    cleanup();
  }
});

test("put_from_cloud takes the cloud's copy without asking the hook", () => {
  const { store, cleanup } = fixtureHome("store-put");
  try {
    let asked = 0;
    store.attachCloud({
      async mayWrite() {
        asked += 1;
      },
      wrote() {
        asked += 1;
      },
      created() {},
    });
    const live = store.create("mine", SETTINGS);
    const theirs = structuredClone(live.project) as Project;
    theirs.name = "theirs";
    const taken = store.putFromCloud(theirs, "cloud");
    expect([taken.rev, taken.project.name, asked]).toEqual([2, "theirs", 0]);
    const fresh = structuredClone(live.project) as Project;
    fresh.id = "p9-9";
    expect(store.putFromCloud(fresh, "cloud").rev).toBe(1);
    expect(() => store.putFromCloud({ ...fresh, id: "../x" }, "cloud")).toThrow('not a project id: "../x"');
  } finally {
    cleanup();
  }
});

test("resolve takes the id given, else the open one, else the newest", () => {
  const { store, cleanup } = fixtureHome("store-resolve");
  try {
    expect(() => store.resolve(null)).toThrow("no projects yet; create one in the UI first");
    const a = store.create("a", SETTINGS).project.id;
    expect(store.resolve(undefined)).toBe(a);
    expect(() => store.resolve("p0-0")).toThrow("no project p0-0");
    const b = store.create("b", SETTINGS).project.id;
    store.setActive(a);
    expect(store.resolve("")).toBe(a);
    expect(store.resolve(b)).toBe(b);
  } finally {
    cleanup();
  }
});

test("a file holding another project says so", () => {
  const { home, store, cleanup } = fixtureHome("store-other");
  try {
    const live = store.create("x", SETTINGS);
    fs.writeFileSync(`${home}/projects/p5-5.json`, JSON.stringify(live.project));
    expect(store.list().find((entry) => entry.id === "p5-5")?.problem).toBe(`its file holds project ${live.project.id}`);
    // Chats sit beside projects and are never taken for one.
    fs.writeFileSync(store.chatPath(live.project.id), "[]");
    expect(store.list().map((entry) => entry.id).sort()).toEqual([live.project.id, "p5-5"].sort());
  } finally {
    cleanup();
  }
});

test("a subtitled video is subtitles over footage and nothing else", () => {
  const project = {
    media: [{ id: "m1", name: "a", path: "/a.mp4", kind: "video", duration: 10 }],
    clips: [
      { id: "c1", type: "video", media: "m1" },
      { id: "c2", type: "text", name: "Subtitle · Officer" },
    ],
  } as unknown as Project;
  expect(isSubtitled(project)).toBe(true);
  (project.clips as unknown[]).push({ id: "c3", type: "text", name: "Caption · Officer" });
  expect(isSubtitled(project)).toBe(false);
});
