// Dev projects (dev_projects.ts): marked "dev" when made on a dev build,
// listed as dev, promoted one at a time, and deleted all at once only when the
// count matches; real projects are never touched.

import { expect, test } from "bun:test";
import * as fs from "node:fs";

import { respond } from "../src/http/server.ts";
import { buildRouter } from "../src/routes.ts";
import { fixtureHome } from "./helpers/home.ts";

const settings = { width: 1920, height: 1080, fps: 30 };

async function ask(app: Parameters<typeof respond>[0], path: string, body?: unknown) {
  const response = (await respond(app, buildRouter(), new Request(`http://localhost:7700${path}`, { method: body === undefined ? "GET" : "POST", headers: { host: "localhost:7700", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), null))!;
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("projects made on a dev build are marked dev; others and older ones aren't", () => {
  const { store, cleanup } = fixtureHome("dev-mark");
  try {
    expect(store.marksDev).toBe(false);
    const real = store.createAs("Real", "bodycam", settings);
    store.marksDev = true;
    const dev = store.createAs("Trial", "bodycam", settings);
    expect(real.project.origin).toBeUndefined();
    expect(dev.project.origin).toBe("dev");
    const listed = new Map(store.list().map((summary) => [summary.id, summary]));
    expect(listed.get(dev.project.id)?.dev).toBe(true);
    expect(listed.get(real.project.id)?.dev).toBeUndefined();
  } finally {
    cleanup();
  }
});

test("a dev project promoted is an ordinary project", async () => {
  const { app, store, cleanup } = fixtureHome("dev-promote");
  try {
    store.marksDev = true;
    const dev = store.createAs("Became real", "bodycam", settings);
    expect((await ask(app, `/api/projects/${dev.project.id}/promote`, {})).status).toBe(200);
    expect(store.get(dev.project.id)?.project.origin).toBeUndefined();
    expect(store.list().find((summary) => summary.id === dev.project.id)?.dev).toBeUndefined();
    expect((await ask(app, "/api/projects/p1-nope/promote", {})).status).toBe(404);
  } finally {
    cleanup();
  }
});

test("Home's list says whether this is a dev build: only then are test projects and their controls shown", async () => {
  const { app, store, cleanup } = fixtureHome("dev-build");
  try {
    expect((await ask(app, "/api/projects")).body.dev_build).toBe(false);
    store.marksDev = true;
    expect((await ask(app, "/api/projects")).body.dev_build).toBe(true);
  } finally {
    cleanup();
  }
});

test("an older throwaway marked a test project by hand is listed, and deleted, with the rest", async () => {
  const { app, store, cleanup } = fixtureHome("dev-test");
  try {
    const real = store.createAs("Real case", "bodycam", settings);
    const trial = store.createAs("R1: 16-Year-Old Kills Her Best Friend", "interrogation", settings);
    expect((await ask(app, `/api/projects/${trial.project.id}/test`, {})).status).toBe(200);
    expect(store.list().find((summary) => summary.id === trial.project.id)?.dev).toBe(true);
    expect(store.list().find((summary) => summary.id === real.project.id)?.dev).toBeUndefined();
    expect((await ask(app, "/api/projects/p1-nope/test", {})).status).toBe(404);
    expect((await ask(app, "/api/dev-projects/delete", { count: 1 })).body.deleted).toEqual([trial.project.id]);
    expect(store.list().map((summary) => summary.id)).toEqual([real.project.id]);
  } finally {
    cleanup();
  }
});

test("delete all dev projects deletes only those, and only when the count is what the confirm showed", async () => {
  const { app, store, home, cleanup } = fixtureHome("dev-delete");
  try {
    const real = store.createAs("Real", "bodycam", settings);
    store.marksDev = true;
    const first = store.createAs("Trial 1", "bodycam", settings);
    const second = store.createAs("Trial 2", "interrogation", settings);
    const promoted = store.createAs("Trial 3", "bodycam", settings);
    await ask(app, `/api/projects/${promoted.project.id}/promote`, {});

    expect((await ask(app, "/api/dev-projects/delete", {})).status).toBe(400);
    const wrong = await ask(app, "/api/dev-projects/delete", { count: 3 });
    expect(wrong.status).toBe(409);
    expect(store.list()).toHaveLength(4);

    const done = await ask(app, "/api/dev-projects/delete", { count: 2 });
    expect(done.status).toBe(200);
    expect((done.body.deleted as string[]).sort()).toEqual([first.project.id, second.project.id].sort());
    expect(done.body.failed).toEqual([]);
    expect(store.list().map((summary) => summary.id).sort()).toEqual([real.project.id, promoted.project.id].sort());
    // Kept aside in projects/deleted, as Home's Delete does.
    expect(fs.readdirSync(`${home}/projects/deleted`).filter((name) => name.startsWith(first.project.id))).toHaveLength(1);
    // None left: nothing to delete.
    expect((await ask(app, "/api/dev-projects/delete", { count: 1 })).status).toBe(409);
  } finally {
    cleanup();
  }
});
