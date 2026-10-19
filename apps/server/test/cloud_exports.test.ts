import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as cloud from "../src/cloud.ts";
import { run, timing } from "../src/cloud_exports.ts";
import * as seams from "../src/seams.ts";
import { fixtureHome } from "./helpers/home.ts";

test("a lost status response does not submit a second paid render", async () => {
  const { dir, store, native, cleanup } = fixtureHome("cloud-export-protocol");
  const project = store.create("one", { width: 64, height: 36, fps: 30 }).project;
  const options = native.exportDefaults();
  const id = `export-${"a".repeat(64)}`;
  let polls = 0;
  const relay = spyOn(cloud, "relayJson").mockImplementation(async (route) => {
    if (route === "exports/config") return { enabled: true };
    if (route === "exports/start") return { id, status: "queued", reservedUsd: 0.67 };
    if (route === "exports/status") {
      polls++;
      if (polls === 1) throw new Error("temporary connection loss");
      return { id, status: "done", output: { key: `edit/exports/results/${id}.mp4` } };
    }
    throw new Error(`unexpected ${route}`);
  });
  const stage = spyOn(seams.cloudMedia, "forWorker").mockResolvedValue({ project, assets: [] });
  const head = spyOn(cloud, "head").mockResolvedValue(null);
  const upload = spyOn(cloud, "uploadStream").mockResolvedValue(1);
  const download = spyOn(cloud, "download").mockImplementation(async (_key, output) => { fs.writeFileSync(output, "verified output"); });
  const sleep = timing.sleep;
  timing.sleep = async () => {};
  try {
    await run(project, options, { start: 0, end: 30, width: 64, height: 36, audio: false }, `${dir}/result.mp4`, () => false, () => {});
    expect(relay.mock.calls.filter(([route]) => route === "exports/start")).toHaveLength(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(`${dir}/result.mp4`, "utf8")).toBe("verified output");
  } finally {
    relay.mockRestore(); stage.mockRestore(); head.mockRestore(); upload.mockRestore(); download.mockRestore(); timing.sleep = sleep; cleanup();
  }
});

test("a saved remote receipt resumes without reconstructing local source files", async () => {
  const { dir, store, native, cleanup } = fixtureHome("remote-export-receipt");
  const project = store.create("one", { width: 64, height: 36, fps: 30 }).project;
  const id = `export-${"b".repeat(64)}`;
  const relay = spyOn(cloud, "relayJson").mockImplementation(async route => {
    if (route !== "exports/status") throw new Error("resuming must not create or stage an export");
    return { id, status: "done", output: { key: `edit/exports/results/${id}.mp4` } };
  });
  const stage = spyOn(seams.cloudMedia, "forWorker").mockRejectedValue(new Error("the local inputs are gone"));
  const download = spyOn(cloud, "download").mockImplementation(async (_key, output) => { fs.writeFileSync(output, "saved result"); });
  try {
    await run(project, native.exportDefaults(), { start: 0, end: 30, width: 64, height: 36, audio: false }, `${dir}/result.mp4`, () => false, () => {}, "old-request", { id });
    expect(stage).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledTimes(1);
    expect(relay).toHaveBeenCalledTimes(1);
  } finally { relay.mockRestore(); stage.mockRestore(); download.mockRestore(); cleanup(); }
});
