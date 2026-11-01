// Nov 1: Mathias resumed two imports 13 times, each ~41 minutes before the
// same 413. A failure the same build meets again is recorded with the build
// (`stuckOn`), and the lists don't offer Retry for it until Edit is updated.

import { expect, test } from "bun:test";

import type { Script } from "@edit/types/writer";

import { AudioUnreadable, RelayBusy, TooLongForOneRequest } from "../../src/transcribe.ts";
import { BUILD } from "../../src/version.ts";
import { stuck } from "../../src/writer/imports.ts";
import { summary } from "../../src/writer/store.ts";

test("only a failure the same build meets again is stuck", () => {
  expect(stuck(new TooLongForOneRequest({ bytes: 67_000_000, message: "transcription failed (413): That recording is too long for one request." }))).toBe(true);
  expect(stuck(new AudioUnreadable({ message: "could not extract audio: no sound" }))).toBe(true);
  expect(stuck(new RelayBusy({ message: "busy" }))).toBe(false);
  expect(stuck(new Error("transcription failed (413): That recording is too long for one request."))).toBe(false);
  expect(stuck("a string")).toBe(false);
});

test("a stopped import says Retry won't help only on the build it stopped on", () => {
  const script = { id: "a", title: "Case", status: "error", stage: "transcribing", progress: 60, error: "transcription failed (413)", durationMs: 1, updatedAt: 0, words: [], clips: [], sourceKind: "drive", createdAt: 0 } as unknown as Script;
  expect(summary({ ...script, stuckOn: BUILD }).retryHelps).toBe(false);
  // After an update the fix may be in: Retry is back.
  expect(summary({ ...script, stuckOn: "nightly-1" }).retryHelps).toBeUndefined();
  expect(summary(script).retryHelps).toBeUndefined();
  // Once it's moving again it isn't stopped at all.
  expect(summary({ ...script, status: "processing", stuckOn: BUILD }).retryHelps).toBeUndefined();
});
