// mcp/index.ts `once`: a long tool asked again joins its run instead of running twice, and a late result waits for the next call.

import { expect, test } from "bun:test";

import { longTiming, once, text } from "../src/mcp/index.ts";

test("a long tool asked twice runs once; past the wait it says it's still working, and the next call collects the result", async () => {
  const before = { ...longTiming };
  try {
    let runs = 0;
    let finish: () => void = () => {};
    const work = async () => {
      runs += 1;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return text(`muted, run ${runs}`);
    };
    longTiming.answerAfterMs = 50;
    const first = await once("p|mute_house_words|{}", "mute_house_words", work);
    expect(first[0]!.type === "text" && first[0]!.text).toContain("still working");
    const second = once("p|mute_house_words|{}", "mute_house_words", work);
    finish();
    expect(await second).toEqual(text("muted, run 1"));
    expect(runs).toBe(1);
    // Finished with nobody waiting: the next call collects it without running again.
    longTiming.answerAfterMs = 20;
    const late = await once("p|mute_house_words|{}", "mute_house_words", work);
    expect(late[0]!.type === "text" && late[0]!.text).toContain("still working");
    finish();
    await Bun.sleep(5);
    expect(await once("p|mute_house_words|{}", "mute_house_words", work)).toEqual(text("muted, run 2"));
    expect(runs).toBe(2);
  } finally {
    Object.assign(longTiming, before);
  }
});

test("a piece heard as gibberish in many scripts is garbled; English isn't", async () => {
  const { garbledShare } = await import("../src/transcribe.ts");
  const said = "Give me something that's good I need to know I need some information".split(" ").map((text) => ({ text }));
  expect(garbledShare(said)).toBe(0);
  const m91 = "reeesz 及其1 in szyst dменти 没azz1ěř consのでしょうか hmm not ovichific7дика Ziquementiquement 潇łaś затра jotenтельность herk po Jстилишко".split(" ").map((text) => ({ text }));
  expect(garbledShare(m91)).toBeGreaterThan(0.2);
});

test("B-roll batches answer promptly with a partial-inventory route while identical requests share their result", async () => {
  const before = longTiming.importAnswerAfterMs;
  longTiming.importAnswerAfterMs = 5;
  try {
    let finish: () => void = () => {};
    let runs = 0;
    const work = async () => { runs++; await new Promise<void>((resolve) => { finish = resolve; }); return text("source bank ready"); };
    const first = await once("p|import_broll|test", "import_broll", work);
    expect(first[0]?.type === "text" && first[0].text).toContain("completed ranges as they arrive");
    const collect = once("p|import_broll|test", "import_broll", work);
    finish();
    expect(await collect).toEqual(text("source bank ready"));
    expect(runs).toBe(1);
  } finally { longTiming.importAnswerAfterMs = before; }
});
