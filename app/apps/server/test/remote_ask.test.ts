import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";

import * as ask from "../src/remote_ask.ts";
import { resume } from "../src/remote_actions.ts";
import { buildRouter } from "../src/routes.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
});

afterAll(() => {
  restore();
  mock.stop();
});

test("a question goes as a resume target the database takes, and comes back as it was", () => {
  const target = ask.encodeAsk("log since=2h grep=pieces|upload level=warn");
  expect(target).toMatch(/^ask-[A-Za-z0-9_-]+$/);
  expect(target.length).toBeLessThanOrEqual(120);
  expect(ask.decodeAsk(target)).toBe("log since=2h grep=pieces|upload level=warn");
  expect(() => ask.encodeAsk(`file ${"x".repeat(120)}`)).toThrow("too long");
  expect(ask.parse("log since=2h grep=a=b extra")).toEqual({ verb: "log", words: ["extra"], options: new Map([["since", "2h"], ["grep", "a=b"]]) });
  expect([ask.duration("30m"), ask.duration("2h"), ask.duration("1d"), ask.duration("90"), ask.duration("soon")]).toEqual([1_800_000, 7_200_000, 86_400_000, 90_000, null]);
});

test("the log is read across its rotations, by time, level, area and pattern", () => {
  const { dir, cleanup } = fixtureHome("remote-ask-log");
  try {
    fs.mkdirSync(`${dir}/logs`, { recursive: true });
    fs.writeFileSync(`${dir}/logs/edit.log.2`, "2026-11-04 08:00:00.000 INFO [pieces] old piece made\n");
    fs.writeFileSync(`${dir}/logs/edit.log.1`, "2026-11-04 11:00:00.000 WARN [cloud] upload of x failed\n  its stack\n");
    fs.writeFileSync(`${dir}/logs/edit.log`, "2026-11-04 12:00:00.000 INFO [pieces] picture piece 3 made\n2026-11-04 12:30:00.000 ERROR [pieces] piece 4 failed\n");
    const now = new Date(2026, 10, 4, 13, 0, 0).getTime();
    const read = (text: string) => ask.logLines(dir, ask.parse(`log ${text}`).options, now).split("\n\n")[1]!.split("\n").filter((line) => line !== "");
    expect(read("")).toHaveLength(5);
    // Since 3 h ago: not the 08:00 line; the stack line goes with its stamped line.
    expect(read("since=3h")).toEqual(["2026-11-04 11:00:00.000 WARN [cloud] upload of x failed", "  its stack", "2026-11-04 12:00:00.000 INFO [pieces] picture piece 3 made", "2026-11-04 12:30:00.000 ERROR [pieces] piece 4 failed"]);
    expect(read("level=warn")).toEqual(["2026-11-04 11:00:00.000 WARN [cloud] upload of x failed", "2026-11-04 12:30:00.000 ERROR [pieces] piece 4 failed"]);
    expect(read("area=pieces lines=1")).toEqual(["2026-11-04 12:30:00.000 ERROR [pieces] piece 4 failed"]);
    expect(read("grep=PICTURE")).toEqual(["2026-11-04 12:00:00.000 INFO [pieces] picture piece 3 made"]);
  } finally {
    cleanup();
  }
});

test("the data folder is read from afar, but never outside it or a sign-in's file", async () => {
  const { app, cleanup } = fixtureHome("remote-ask-files");
  const dir = app.store.home;
  try {
    fs.writeFileSync(`${dir}/jobs.json`, '[{"kind":"upload"}]');
    fs.writeFileSync(`${dir}/settings.json`, '{"token":"secret"}');
    expect(await ask.respondTo(app, "ls")).toContain("jobs.json");
    expect(await ask.respondTo(app, "file jobs.json")).toContain('"kind":"upload"');
    expect(await ask.respondTo(app, "file settings.json")).toContain("isn't read from afar");
    await expect(ask.respondTo(app, "file ../../etc/hosts")).rejects.toThrow();
    expect(() => ask.inside(dir, "../")).toThrow("isn't in Edit's data folder");
    expect(await ask.respondTo(app, "nonsense")).toContain("isn't something Edit answers");
  } finally {
    cleanup();
  }
});

test("Edit's own GET routes are answered inside, never one that opens a project in their window", async () => {
  const { app, cleanup } = fixtureHome("remote-ask-get");
  try {
    ask.useRouter(buildRouter());
    expect(await ask.respondTo(app, "get /api/health")).toMatch(/^200 \/api\/health/);
    expect(await ask.respondTo(app, "get /api/projects/p1")).toContain("ask project <id> instead");
    expect(await ask.respondTo(app, "get /etc/passwd")).toContain("Give one of Edit's GET routes");
  } finally {
    cleanup();
  }
});

test("an admin's question is answered, scrubbed, and sent up with the reports; the outcome says where", async () => {
  const { app, cleanup } = fixtureHome("remote-ask-answer");
  const dir = app.store.home;
  try {
    fs.mkdirSync(`${dir}/logs`, { recursive: true });
    fs.writeFileSync(`${dir}/logs/edit.log`, "2026-11-04 12:00:00.000 WARN [cloud] fetching https://bucket.r2.cloudflarestorage.com/edit/x?X-Amz-Signature=abc123 failed\n");
    const said = await resume(app, ask.encodeAsk("log"));
    expect(said).toMatch(/^Sent: edit\/reports\/remote\/\d{4}-\d\d-\d\d\/.+\.txt$/);
    const sent = new TextDecoder().decode(mock.cloud.objects.get(said.slice("Sent: ".length))!);
    expect(sent).toContain("Asked: log");
    expect(sent).toContain("[cloud] fetching");
    expect(sent).not.toContain("abc123");
  } finally {
    cleanup();
  }
});

test("cpu says the server's CPU, how late its event loop ran, its threads and its JS heap", async () => {
  const answer = await ask.respondTo({} as never, "cpu");
  expect(answer).toMatch(/^over 5 s: \d+% CPU .* event loop ran up to \d+ ms late/);
  expect(answer).toContain("JS heap:");
  expect(answer).toMatch(/#0 \d+\.\d% now/);
}, 15_000);
