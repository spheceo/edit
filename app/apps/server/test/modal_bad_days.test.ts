// The Modal export driver on its bad days: a job that never started, a status lost for a while,
// a refusal, a job that failed, a cancel, a job past its deadline; and the local driver's process
// group, its lines, its error and its cancel.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";

import { kindOf } from "../src/effect/service.ts";
import * as modal from "../src/modal_exports.ts";
import { runtime } from "../src/effect/runtime.ts";
import { scratch } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;
const saved = { ...modal.timing };

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "relay-token" });
});
afterEach(() => Object.assign(modal.timing, saved, { pollMs: 5 }));
afterAll(() => {
  Object.assign(modal.timing, saved);
  restore();
  mock.stop();
});

const START = "/v1/cloud/v3/start_export";
const STATUS = "/v1/cloud/v3/status";
const CANCEL = "/v1/cloud/v3/cancel";
const go = (cancelled: () => boolean = () => false) => modal.throughRelay("export", { id: "job-1" }, cancelled, () => {}).catch((error: unknown) => error as Error);

test("a job the cloud didn't start says why; a status lost for a moment is waited out", async () => {
  modal.timing.pollMs = 5;
  mock.on("POST", START, () => Response.json({ error: "Modal's pool is full" }), 1);
  expect((await go()).message).toBe("Modal's pool is full");

  mock.on("POST", START, () => Response.json({ call: "fc-1" }));
  mock.on("POST", STATUS, () => Response.json({ state: "done", result: { bytes: 42, sections: 8, rendered: 1 } }));
  mock.on("POST", STATUS, () => Response.json({ error: "down" }, { status: 503 }), 2);
  expect(await go()).toEqual({ bytes: 42, sections: 8, rendered: 1 });
});

test("a status the relay refuses, or a job that failed, is said at once", async () => {
  modal.timing.pollMs = 5;
  mock.on("POST", START, () => Response.json({ call: "fc-2" }));
  mock.on("POST", STATUS, () => Response.json({ error: "Not yours." }, { status: 403 }), 1);
  const refused = await go();
  expect(refused.message).toBe("Not yours. (403)");

  mock.on("POST", STATUS, () => Response.json({ state: "failed", error: "GPU lost" }), 1);
  const failed = await go();
  expect(failed).toBeInstanceOf(modal.ModalJobFailed);
  expect(failed.message).toBe("GPU lost");
});

test("a status gone too long, a job past its deadline, and a cancel each stop it, the last two cancelling it in the cloud", async () => {
  Object.assign(modal.timing, { pollMs: 5, statusLostMs: 100 });
  mock.on("POST", START, () => Response.json({ call: "fc-3" }));
  mock.on("POST", STATUS, () => Response.json({ error: "down" }, { status: 503 }));
  const lost = await go();
  expect(lost).toBeInstanceOf(modal.ModalUnanswered);
  expect(kindOf(lost)).toBe("temporary");

  Object.assign(modal.timing, { statusLostMs: 60_000, deadlineMs: 100 });
  mock.on("POST", STATUS, () => Response.json({ state: "running", progress: 0.5 }));
  let cancels = mock.calls(CANCEL, "POST").length;
  const late = await go();
  expect(late).toBeInstanceOf(modal.ModalUnanswered);
  expect(mock.calls(CANCEL, "POST").length - cancels).toBe(1);

  modal.timing.deadlineMs = 60_000;
  cancels = mock.calls(CANCEL, "POST").length;
  let asked = 0;
  const cancelled = await go(() => ++asked > 3);
  expect(cancelled.message).toBe("cancelled");
  expect(mock.calls(CANCEL, "POST").length - cancels).toBe(1);
});

test("the local driver: its progress and done lines read, its error said, and a cancel ending its whole group", async () => {
  const { dir, cleanup } = scratch("modal-drive");
  try {
    const driver = `${dir}/driver.sh`;
    fs.writeFileSync(driver, `#!/bin/sh\necho '{"progress":0.5,"phase":"rendering"}'\necho 'not json'\necho '{"done":true,"bytes":7,"sections":8}'\n`, { mode: 0o755 });
    const seen: number[] = [];
    const done = await runtime.runPromise(modal.driving([driver], dir, `${dir}/job.json`, `${dir}/job.json.cancel`, "job-1", () => false, (progress) => seen.push(progress)));
    expect(done).toEqual({ done: true, bytes: 7, sections: 8 });
    expect(seen).toEqual([0.5]);

    fs.writeFileSync(driver, `#!/bin/sh\necho '{"error":"R2 refused the upload"}'\nexit 1\n`);
    const failed = await runtime.runPromise(modal.driving([driver], dir, `${dir}/job.json`, `${dir}/job.json.cancel`, "job-1", () => false, () => {})).catch((error: unknown) => error as Error);
    expect(failed.message).toBe("R2 refused the upload");

    // Infisical, uv and Python stand-ins: a child that would outlive a SIGTERM to its parent alone.
    fs.writeFileSync(driver, `#!/bin/sh\nsleep 30 & echo $! > ${dir}/child\nwait\n`);
    let polls = 0;
    const stopped = await runtime.runPromise(modal.driving([driver], dir, `${dir}/job.json`, `${dir}/job.json.cancel`, "job-1", () => ++polls > 2, () => {})).catch((error: unknown) => error as Error);
    expect(stopped.message).toBe("cancelled");
    expect(fs.existsSync(`${dir}/job.json.cancel`)).toBe(true);
    await Bun.sleep(300);
    const child = Number(fs.readFileSync(`${dir}/child`, "utf8").trim());
    expect(() => process.kill(child, 0)).toThrow();
  } finally {
    cleanup();
  }
}, 30_000);
