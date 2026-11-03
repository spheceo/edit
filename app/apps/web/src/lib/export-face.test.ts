import { describe, expect, it } from "vitest";

import { activityLine, cardFace, exportLabel, shareChip, type FaceJob } from "./export-face";

const job = (over: Partial<FaceJob>): FaceJob => ({ name: "Republican Chairman", state: "running", progress: 0, ...over });

describe("the exports card", () => {
  it("says what a queued edit waits for, and keeps the name for the hover", () => {
    const face = cardFace([job({ state: "queued", waiting: "waiting for smooth playback's render to finish" })]);
    expect(face).toMatchObject({ percent: 0, subtitle: "waiting for smooth playback's render to finish", attention: false });
    expect(face.title).toBe("Republican Chairman: waiting for smooth playback's render to finish");
  });

  it("names the prep while frames are not encoding yet", () => {
    const face = cardFace([job({ progress: 0.12, phase: "cutting the footage, 40 of 225" })]);
    expect(face.subtitle).toBe("cutting the footage, 40 of 225");
    expect(face.percent).toBe(12);
    expect(face.title).toBe("Republican Chairman: cutting the footage, 40 of 225");
  });

  it("keeps the edit's name once the encoder is reporting, and for a script share", () => {
    expect(cardFace([job({ progress: 0.42 })]).subtitle).toBe("Republican Chairman");
    expect(cardFace([job({ kind: "script", name: "Polite", phase: "cutting the footage, 1 of 2" })]).subtitle).toBe("Polite");
    expect(activityLine(job({ kind: "script", state: "queued", waiting: "waiting for the encoder (this Mac has one)" }))).toBeNull();
  });

  it("counts several at once, and a failure after they finish", () => {
    expect(cardFace([job({ state: "running", progress: 0.5 }), job({ name: "Other", state: "queued" })]).subtitle).toBe("1 exporting · 1 queued");
    expect(cardFace([job({ state: "failed", error: "disk full" })]).attention).toBe(true);
  });

  it("labels a prep by its stage, and a queued edit by what it waits for", () => {
    expect(exportLabel(job({ phase: "fetching the last export, 40%" }))).toBe("Fetching the last export, 40%");
    expect(exportLabel(job({ progress: 0.4 }))).toBe("Exporting · 40%");
    expect(exportLabel(job({ state: "queued", waiting: "waiting for the encoder (this Mac has one)" }))).toBe("Queued · waiting for the encoder (this Mac has one)");
    expect(exportLabel(job({ state: "queued" }))).toBe("Queued · waiting for the renderer");
    expect(exportLabel(job({ kind: "script", stage: "uploading the footage 42%" }))).toBe("Uploading the footage 42%…");
  });
});

describe("the share chip", () => {
  it("stays Sharing until the export names a stage", () => {
    expect(shareChip("exporting")).toBe("Sharing");
    expect(shareChip("cancelling")).toBe("Cancelling…");
    expect(shareChip("waiting for smooth playback's render to finish")).toBe("Waiting for smooth playback's render to finish");
    expect(shareChip("cutting the footage, 40 of 225")).toBe("Cutting the footage, 40 of 225");
    expect(shareChip("exporting 20%")).toBe("Exporting 20%");
  });
});
