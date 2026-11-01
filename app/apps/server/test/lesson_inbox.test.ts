// The lessons inbox (lesson_inbox.ts): the agent notes a lasting lesson with
// the project it was said on, a teaching round lists the open ones and closes
// each with where it landed (or why it was dropped), and closed ones stay
// listed with `all`; through the relay's Convex (the cloud mock's editLessons).

import { afterAll, beforeAll, expect, test } from "bun:test";

import * as cloud from "../src/cloud.ts";
import { respond } from "../src/http/server.ts";
import { lessonsText } from "../src/lesson_text.ts";
import { handlerFor } from "../src/mcp/registry.ts";
import { buildRouter } from "../src/routes.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  cloud.timing.sleep = async () => {};
});

afterAll(() => {
  restore();
  mock.stop();
});

test("noted by the agent with its project, listed open, taught or dropped with where or why, kept with all", async () => {
  const { app, store } = fixtureHome("lessons");
  const router = buildRouter();
  const ask = async (method: string, path: string, body?: unknown) => {
    const response = (await respond(app, router, new Request(`http://localhost:7700${path}`, { method, headers: { host: "localhost:7700", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), null))!;
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const project = store.create("Mom & Teen", { width: 1920, height: 1080, fps: 30 }).project;
  const tool = handlerFor("note_lesson")!;
  const answer = await tool.handler({ app, projectId: project.id, scope: project.id, args: { lesson: "The music follows the story's mood.", quote: "change the music", part: "music-and-sound", scope: "style", from: "JJ" } });
  expect(JSON.stringify(answer)).toContain("noted in the lessons inbox");
  // A note missing its quote is refused, so the team's words always travel with it.
  await expect(Promise.resolve(tool.handler({ app, projectId: project.id, scope: null, args: { lesson: "x", part: "intro", scope: "house" } }))).rejects.toThrow(/quote/);
  expect((await ask("POST", "/api/lessons", { lesson: "Intros follow the script.", quote: "follow the script strictly", part: "intro", scope: "house" })).status).toBe(200);
  expect((await ask("POST", "/api/lessons", { lesson: "x", quote: "y", part: "../etc", scope: "house" })).status).toBe(400);

  const open = (await ask("GET", "/api/lessons")).body.lessons as { id: string; part: string; from: string | null; source: unknown; style: string | null }[];
  expect(open.map((lesson) => lesson.part)).toEqual(["music-and-sound", "intro"]);
  expect(open[0]).toMatchObject({ from: "JJ", style: project.style, source: { kind: "edit", id: project.id, name: "Mom & Teen" } });

  // Taught needs where it landed; dropped needs why.
  expect((await ask("POST", `/api/lessons/${open[0]!.id}`, { status: "taught" })).status).toBe(400);
  expect((await ask("POST", `/api/lessons/${open[0]!.id}`, { status: "taught", outcome: "music-and-sound.md, abc123" })).status).toBe(200);
  expect((await ask("POST", `/api/lessons/${open[1]!.id}`, { status: "dropped", outcome: "a one-off for that cut" })).status).toBe(200);
  expect((await ask("GET", "/api/lessons")).body.lessons).toEqual([]);
  const all = (await ask("GET", "/api/lessons?all=1")).body.lessons as { status: string; outcome: string }[];
  expect(all.map(({ status, outcome }) => ({ status, outcome }))).toEqual([
    { status: "dropped", outcome: "a one-off for that cut" },
    { status: "taught", outcome: "music-and-sound.md, abc123" },
  ]);
  // Opened again: back in the inbox, its outcome forgotten.
  await ask("POST", `/api/lessons/${open[1]!.id}`, { status: "open" });
  expect(((await ask("GET", "/api/lessons")).body.lessons as { id: string; outcome: string | null }[]).map(({ id, outcome }) => ({ id, outcome }))).toEqual([{ id: open[1]!.id, outcome: null }]);
});

test("edit lessons prints the inbox by part, with the team's words and where each was said", () => {
  const base = { from: null, style: "bodycam", scope: "style" as const, status: "open" as const, outcome: null, at: Date.UTC(2026, 10, 1), by: { sub: "u1", name: "Sphe", picture: null }, closedAt: null, closedBy: null };
  const printed = lessonsText([
    { ...base, id: "a", lesson: "Music follows the mood.", quote: "change the music", part: "music-and-sound", source: { kind: "edit", id: "p1", name: "Mom & Teen" } },
    { ...base, id: "b", lesson: "Intros follow the script.", quote: "follow the script", part: "intro", from: "Marius", source: null, status: "taught", outcome: "intro.md, 92555d25", closedAt: Date.UTC(2026, 10, 2) },
  ]);
  expect(printed).toBe([
    "## intro (1)",
    "- [b] Intros follow the script.",
    '  "follow the script" (Marius, 2026-11-01; bodycam, style)',
    "  taught 2026-11-02: intro.md, 92555d25",
    "",
    "## music-and-sound (1)",
    "- [a] Music follows the mood.",
    '  "change the music" (Sphe, 2026-11-01; Mom & Teen, bodycam, style)',
  ].join("\n"));
  expect(lessonsText([])).toBe("The lessons inbox is empty.");
});
