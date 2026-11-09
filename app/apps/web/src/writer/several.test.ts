import { describe, expect, it } from "vitest";
import { shapeOf } from "./several";

const both = { single: true, compilation: true };

describe("what several videos in New project make", () => {
  it("Courtroom videos are one case until the person says otherwise (Marc, Nov 9: several POVs aren't a compilation)", () => {
    expect(shapeOf({ kind: "courtroom", reused: false, title: "Judge Loses It at Defendant", picked: null, may: both })).toEqual({ shape: "case", fixed: null });
  });

  it("a title that starts with \"When\" is Repack's standard compilation", () => {
    expect(shapeOf({ kind: "courtroom", reused: false, title: "When Judges Lose Their Patience", picked: null, may: both }).shape).toBe("compilation");
    expect(shapeOf({ kind: "courtroom", reused: false, title: "“When” the Gavel Falls", picked: null, may: both }).shape).toBe("compilation");
  });

  it("the person's pick wins over the title", () => {
    expect(shapeOf({ kind: "courtroom", reused: false, title: "When Judges Lose Their Patience", picked: "case", may: both })).toEqual({ shape: "case", fixed: null });
    expect(shapeOf({ kind: "courtroom", reused: false, title: "Judge Loses It", picked: "compilation", may: both })).toEqual({ shape: "compilation", fixed: null });
  });

  it("a reused case makes it a compilation, whatever was picked", () => {
    const got = shapeOf({ kind: "courtroom", reused: true, title: "Judge Loses It", picked: "case", may: both });
    expect(got.shape).toBe("compilation");
    expect(got.fixed).toMatch(/already covered/);
  });

  it("only Courtroom joins videos into one case: bodycam and interrogation videos are a compilation", () => {
    for (const kind of ["foia", "interrogation"] as const) {
      const got = shapeOf({ kind, reused: false, title: "Officer Arrests Man", picked: "case", may: both });
      expect(got.shape).toBe("compilation");
      expect(got.fixed).toMatch(/Drive folder/);
    }
  });

  it("someone who may write only cases, or only compilations, gets that one", () => {
    expect(shapeOf({ kind: "courtroom", reused: false, title: "When Judges Snap", picked: "compilation", may: { single: true, compilation: false } })).toEqual({ shape: "case", fixed: "Your account writes Courtroom cases, not compilations." });
    expect(shapeOf({ kind: "courtroom", reused: false, title: "Judge Snaps", picked: "case", may: { single: false, compilation: true } })).toEqual({ shape: "compilation", fixed: "Your account writes Courtroom compilations, not single cases." });
  });
});
