// Ideas (src/ideas/): the rules titles, guides and summaries keep to, a card
// written and read as the board writes one, and a repackaging end to end
// against a stand-in relay (mamagi's ideas functions in memory, YouTube's
// details, the board) with a stand-in Claude that calls the real tools.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

import type { Idea } from "@edit/types/ideas";

import * as board from "../src/ideas/board.ts";
import * as cloud from "../src/ideas/cloud.ts";
import { cleanGuide, cleanTitle, closest, guideProblem, lengthStyle, summaryProblem, titleProblem } from "../src/ideas/policy.ts";
import { applyPatch, linksIn, mayIdeas, mayWorkspace, readiness, workspacesOf } from "../src/ideas/routes.ts";
import * as run from "../src/ideas/run.ts";
import * as sources from "../src/ideas/sources.ts";
import * as live from "../src/writer/live.ts";
import { scratch } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;
let home: string;
let cleanup: () => void;

/** mamagi's ideas functions, in memory, refusing a stale rev as the real ones do. */
const rows = new Map<string, { body: Idea; rev: number }>();
let conflicts = 0;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "test-token" });
  ({ dir: home, cleanup } = scratch("ideas"));
  mock.on("POST", "/v1/ideas/convex", (request) => {
    const { path, args } = request.json<{ path: string; args: Record<string, unknown> }>();
    const ok = (value: unknown) => Response.json({ status: "success", value });
    const id = args.ideaId as string;
    if (path === "ideas:list") return ok([...rows.entries()].map(([ideaId, row]) => ({ ideaId, rev: row.rev, summary: cloud.summarize(row.body), updatedAt: row.body.updatedAt, updatedBy: "Test", createdBy: null })));
    if (path === "ideas:get") return ok(rows.has(id) ? { body: rows.get(id)!.body, rev: rows.get(id)!.rev } : null);
    if (path === "ideas:remove") return ok({ deleted: rows.delete(id) });
    const rev = rows.get(id)?.rev ?? 0;
    if (conflicts > 0 || args.baseRev !== rev) {
      conflicts = Math.max(0, conflicts - 1);
      return Response.json({ status: "error", errorMessage: "conflict", errorData: { code: "conflict", message: `now at rev ${rev + 1}` } });
    }
    rows.set(id, { body: args.body as Idea, rev: rev + 1 });
    return ok({ rev: rev + 1 });
  });
  mock.on("GET", "/v1/ideas/youtube", () =>
    Response.json({ title: "Dad Realizes His Wife Just Murdered Their Daughter", description: "The interrogation.", channel: "Interrogation Core", views: 65000, outlier: "1.5x", publishedAt: "2026-10-01T00:00:00Z", durationSeconds: 3000, thumbnail: "https://i.ytimg.com/vi/JcAHmNKiHic/maxresdefault.jpg" }),
  );
  mock.on("GET", "/v1/ideas/trello/approved", () =>
    Response.json({ titles: ["Evil Husband Thinks He Got Away With Killing His Wife", "Neglectful Mom Realizes Detectives Know How She Treated Her Toddler", "16 Year Old Thinks He Got Away With Murder", "Mom Realizes Her Made Up Story Isn't Making Sense", "21 Year Old Realizes Detectives Found Her Texts To The Victim Right Before The Murder", "Killer Boyfriend Has No Idea His Phone GPS Data Led Officers To The Body", "19 Year Old's Phone Caught His Killer Cleaning Blood Off His Hands After The Murder"].map((title, n) => ({ id: `a${n}`, title, list: "Uploaded (SI", url: `https://trello.com/c/a${n}`, cover: null })) }),
  );
  mock.on("POST", "/v1/ideas/trello/duplicates", () => Response.json({ found: {} }));
  // Captions, as yt-dlp through the proxy would give them.
  sources.captions.fetch = async () => ({ model: "youtube-captions", language: "en", words: ["Where", "were", "you", "that", "night?", "At", "home."].map((text, n) => ({ text, start: n, end: n + 0.5, speaker: n < 5 ? "caption_turn_1" : "caption_turn_2" })) });
});

afterEach(() => {
  rows.clear();
  conflicts = 0;
  board.forget();
});

afterAll(() => {
  restore();
  mock.stop();
  cleanup();
});

const STYLE = lengthStyle(["Evil Husband Thinks He Got Away With Killing His Wife", "16 Year Old Thinks He Got Away With Murder", "Mom Realizes Her Made Up Story Isn't Making Sense", "Killer Boyfriend Has No Idea His Phone GPS Data Led Officers To The Body", "21 Year Old Realizes Detectives Found Her Texts To The Victim Right Before The Murder"]);

test("titles keep the channel's rules: no suicide, no dash split, no quoted line, the approved titles' length", () => {
  expect(titleProblem("18-Year-Old Ex-Girlfriend Realizes Cops Have Her Texts", STYLE)).toBeNull();
  expect(titleProblem("'Perfect Teen' Has No Idea Police Are About To Arrest Her", null)).toBeNull();
  expect(titleProblem("Man's Suicide Was Really Murder", null)).toContain("suicide");
  expect(titleProblem("Killer Smiles — Then The Video Plays", null)).toContain("dash");
  expect(titleProblem("Caught - Then Arrested", null)).toContain("dash");
  expect(titleProblem('Killer Realizes His "I Never Went Downtown" Story Is Dead', null)).toContain("quotes a spoken line");
  expect(titleProblem("Titles: something", null)).toContain("label");
  expect(titleProblem("A Very Long Title That Goes On And On Past Every Approved Title The Team Has", STYLE)).toMatch(/the team's approved titles run to \d+/);
  expect(cleanTitle('- "Killer Realizes His Story Collapsed"')).toBe("Killer Realizes His Story Collapsed");
  expect(cleanTitle("2) Mom   Thinks She Got Away")).toBe("Mom Thinks She Got Away");
});

test("a guide is Repack's lowercase edits to the base with its caption in quotes, and a summary one compact paragraph", () => {
  expect(cleanGuide("Make the man a middle-aged man with a shaved head")).toBe("make the man a middle-aged man with a shaved head");
  expect(guideProblem("make the man a middle-aged man with a shaved head in a grey t-shirt. have the suspect fold his arms. change the current “CAUGHT” text to “HE KNEW”.")).toBeNull();
  expect(guideProblem("make her look like Dina Thetford")).toContain("Dina");
  expect(guideProblem("make the man older. use a close-up camera angle.")).toContain("camera");
  expect(guideProblem("x".repeat(601))).toContain("600");
  expect(summaryProblem("A mother drowned her 4-year-old daughter in the bathtub. Her 16-year-old son escaped and called police. She told detectives the drowning was an accident, but she later admitted it.")).toBeNull();
  expect(summaryProblem("One. Two. Three. Four.")).toContain("three sentences");
  expect(summaryProblem(Array(66).fill("word").join(" "))).toContain("66 words");
});

test("the closest approved titles share the act and the rare words, and never borrow a relationship the case doesn't name", () => {
  const titles = ["Evil Husband Thinks He Got Away With Killing His Wife", "Neglectful Mom Realizes Detectives Know How She Treated Her Toddler", "Predator Realizes His Deleted Messages Weren't Gone", "Mom Kills Her Daughter Then Calls 911"];
  const near = closest(titles, "Husband Shoots His Wife And Fakes A Home Invasion", "");
  expect(near[0]).toBe("Evil Husband Thinks He Got Away With Killing His Wife");
  expect(closest(titles, "Woman Kills Her Roommate", "")[0]).not.toBe("Mom Kills Her Daughter Then Calls 911");
});

test("a card is written as the board writes one, and read back from the shapes people write by hand", () => {
  const idea = run.fresh("i1-test", "Sphe", { sources: [{ kind: "youtube", url: "https://www.youtube.com/watch?v=JcAHmNKiHic", videoId: "JcAHmNKiHic", title: "Dad Realizes", channel: "C", views: 1, outlier: "1x", publishedAt: null, durationSeconds: 1, thumbnail: "https://i.ytimg.com/vi/JcAHmNKiHic/maxresdefault.jpg" }], steer: "", wantsSummary: false, footage: "https://drive.google.com/drive/folders/abc" });
  idea.titles = [{ id: "1", text: "First Title", by: "claude", at: 0 }, { id: "2", text: "Main Title", by: "claude", at: 0 }];
  idea.main = "Main Title";
  idea.thumbnailGuide = "we use the interrogation room and have the mom in the middle";
  expect(board.cardText(idea)).toBe("Titles:\n- Main Title\n- First Title\n\nThumbnail Guide:\nwe use the interrogation room and have the mom in the middle\n[image]\n\nCase:\nhttps://www.youtube.com/watch?v=JcAHmNKiHic\n\nFootage:\nhttps://drive.google.com/drive/folders/abc");
  expect(board.cardImages(idea)).toEqual([{ name: "thumbnail", url: "https://i.ytimg.com/vi/JcAHmNKiHic/maxresdefault.jpg" }]);
  // Sphe Research's own cards.
  const sphe = board.parseCard("18 Year Old Killer", "Titles:\n\n- 18 Year Old Killer Realizes\n- 18 Year Old Has No Idea\n\nThumbnail Guide:\n\nwe use the interrogation room and have the detective showing her the footage\n\n![shot](https://trello.com/1/cards/a/attachments/b/download/shot.png)\n\nCase:\n\n[https://youtu.be/XfGOTlci\\_-Q](https://youtu.be/XfGOTlci\\_-Q \"smartCard-inline\")");
  expect(sphe).toEqual({ titles: ["18 Year Old Killer Realizes", "18 Year Old Has No Idea"], guide: "we use the interrogation room and have the detective showing her the footage", links: ["https://youtu.be/XfGOTlci_-Q"], footage: "", summary: "", pictures: ["https://trello.com/1/cards/a/attachments/b/download/shot.png"] });
  // Repack's and the team's: "Title:" numbered, "Thumb:", a lowercase "case:", zero-width lines, a footage folder.
  const team = board.parseCard("745) Killer Father & Daughter Duo", "Title:\n\n1. Killer Father & Daughter Realizes\n2. Killer Duo Realizes\n\nThumb:\n\n- Image of daughter and dad together in interrogation\n\n‌\n\n- Text:\n  - ‌\n\ncase: [https://www.youtube.com/watch?v=rTlArPSQAzU](https://www.youtube.com/watch?v=rTlArPSQAzU \"‌\")\n\nFootage: [https://drive.google.com/drive/folders/1y9](https://drive.google.com/drive/folders/1y9 \"smartCard-inline\")");
  expect(team).toMatchObject({ titles: ["Killer Father & Daughter Realizes", "Killer Duo Realizes"], guide: "Image of daughter and dad together in interrogation", links: ["https://www.youtube.com/watch?v=rTlArPSQAzU"], footage: "https://drive.google.com/drive/folders/1y9" });
  // A card with only its name and a link: the name is the title, without its case number.
  expect(board.parseCard("304) Cops Find Mom Of Two", "[https://youtu.be/OYCXYcBkorc](https://youtu.be/OYCXYcBkorc)")).toMatchObject({ titles: ["Cops Find Mom Of Two"], links: ["https://youtu.be/OYCXYcBkorc"] });
});

test("what was pasted gives each link once (a video by its id), and an idea needs titles, a guide and its case to be ready", () => {
  expect(linksIn("look https://youtu.be/JcAHmNKiHic and https://www.youtube.com/watch?v=JcAHmNKiHic&t=5, plus https://news.example/story.")).toEqual(["https://www.youtube.com/watch?v=JcAHmNKiHic", "https://news.example/story"]);
  const idea = run.fresh("i2-test", "Sphe", { sources: [], steer: "", wantsSummary: false });
  expect(readiness(idea)).toEqual(["a title", "a thumbnail guide", "the case link"]);
  expect(mayIdeas(new Set(["edit.interrogation"]))).toBe(false);
  expect(mayIdeas(new Set(["ideas.interrogation"]))).toBe(true);
  expect(mayIdeas(null)).toBe(true);
});

test("each workspace is its own capability and craft: bodycam ideas are Repack's teachings adapted, sent to Raw Channels", async () => {
  // The user, Nov 1: "for bodycam, we want to go with the teachings on interrogation… it just adapts some of those parts".
  expect(workspacesOf(new Set(["ideas.bodycam"]))).toEqual(["bodycam"]);
  expect(mayWorkspace("interrogation", new Set(["ideas.bodycam"]))).toBe(false);
  expect(workspacesOf(null)).toEqual(["interrogation", "bodycam"]);
  expect(run.fresh("i9-test", "Sphe", { workspace: "bodycam", sources: [], steer: "", wantsSummary: false }).workspace).toBe("bodycam");
  expect(run.fresh("i9-test", "Sphe", { sources: [], steer: "", wantsSummary: false }).workspace).toBe("interrogation");
  const { ideasGuide } = await import("../src/agent_text.ts");
  expect(ideasGuide("interrogation")).toContain("You write compelling YouTube titles for true-crime interrogation videos.");
  expect(ideasGuide("bodycam")).toContain("You write compelling YouTube titles for true-crime bodycam videos.");
  expect(ideasGuide("bodycam")).toContain("Raw Channels");
});

test("a person's change: their reworded title stays the main one, theirs by name, and an idea is ready only with titles, a guide and its case", () => {
  const idea = videoIdea("i10-test");
  idea.titles = [{ id: "a", text: "First Title", by: "claude", at: 0 }, { id: "b", text: "Main Title", by: "claude", at: 0 }];
  idea.main = "Main Title";
  applyPatch(idea, { titles: [{ id: "a", text: "First Title" }, { id: "b", text: "Main Title Reworded" }] }, "Sphe");
  expect(idea.main).toBe("Main Title Reworded");
  expect(idea.titles.map((one) => [one.id, one.by])).toEqual([["a", "claude"], ["b", "Sphe"]]);
  applyPatch(idea, { titles: [{ id: "a", text: "First Title" }] }, "Sphe");
  expect(idea.main).toBe("First Title");
  expect(() => applyPatch(idea, { status: "ready" }, "Sphe")).toThrow("Not ready: a thumbnail guide.");
  applyPatch(idea, { thumbnailGuide: "We use the interrogation room and have the mom in the middle" }, "Sphe");
  expect([idea.thumbnailGuide, idea.guideBy]).toEqual(["we use the interrogation room and have the mom in the middle", "Sphe"]);
  applyPatch(idea, { status: "ready" }, "Sphe");
  expect(idea.status).toBe("ready");
  expect(() => applyPatch(idea, { footage: "https://evil.example/x" }, "Sphe")).toThrow("Google Drive");
});

test("a change overtaken by another Mac's is made again on top of it", async () => {
  const idea = run.fresh("i3-test", "Sphe", { sources: [], steer: "", wantsSummary: false });
  await cloud.commit(idea, 0, "Sphe");
  conflicts = 2;
  const { rev, idea: changed } = await cloud.change("i3-test", "Sphe", (one) => void (one.notes = "on top"));
  expect(rev).toBe(2);
  expect(changed.notes).toBe("on top");
  expect(rows.get("i3-test")!.body.notes).toBe("on top");
});

/** Claude, standing in: it calls the run's tools through its MCP endpoint as the real one would. */
function claudeCalls(calls: { name: string; arguments: Record<string, unknown> }[], text = "Done.") {
  const seen: { prompt: string; answers: string[] } = { prompt: "", answers: [] };
  run.asking.ask = async (question) => {
    seen.prompt = question.prompt;
    const token = /\/mcp\/ideas\/([a-f0-9]+)$/.exec(question.tools ?? "")![1]!;
    for (const [index, one] of calls.entries()) {
      // As Claude's stream records each tool into the live turn (writer/claude.ts).
      live.tool({ id: `t${index}`, tool: one.name, label: "", state: "running" });
      const answer = (await run.answerTo(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: one })) as { result: { content: { text: string }[]; isError: boolean } };
      seen.answers.push(answer.result.content[0]!.text);
      live.tool({ id: `t${index}`, label: "", state: answer.result.isError ? "error" : "done" });
    }
    return { structured: null, text, session: null, costUsd: 0, result: {}, replies: 1, biggestReply: 0 };
  };
  return seen;
}

async function settled(id: string): Promise<Idea> {
  for (let i = 0; i < 200 && run.isRunning(id); i++) await Bun.sleep(10);
  return rows.get(id)!.body;
}

const context = (): run.Context => ({ home, port: 7700, holder: "test-mac", by: "Sphe" });

const videoIdea = (id: string, video = "JcAHmNKiHic") => run.fresh(id, "Sphe", { sources: [{ kind: "youtube", url: `https://www.youtube.com/watch?v=${video}`, videoId: video, title: "Dad Realizes His Wife Just Murdered Their Daughter", channel: "Interrogation Core", views: 65000, outlier: "1.5x", publishedAt: null, durationSeconds: 3000, thumbnail: null }], steer: "the dress", wantsSummary: true });

test("a repackaging reads the case in code, and Claude's titles, guide and summary are checked and saved as it writes them", async () => {
  await cloud.commit(videoIdea("i4-test"), 0, "Sphe");
  const seen = claudeCalls([
    { name: "save_titles", arguments: { niche: "child-related", titles: ["Mom Accidentally Admits Drowning Her Daughter Wasn't An Accident", "Dad Realizes What The Dress Really Meant", "Mom Blames Her Pills — Detectives Don't Buy It", "Mom Realizes Her Made Up Story Isn't Making Sense"] } },
    { name: "save_titles", arguments: { mode: "add", titles: ["Mom Has No Idea Detectives Found The Dress"] } },
    { name: "save_thumbnail_guide", arguments: { guide: "We use the interrogation room and have the mom in the middle" } },
    { name: "save_summary", arguments: { summary: "A mother drowned her 6-year-old daughter and her 16-year-old escaped." } },
  ]);
  await run.repackage(context(), "i4-test");
  const idea = await settled("i4-test");
  // One prompt with everything: the details, the captions as lines, the approved titles and their length, the steer and the summary asked for.
  expect(seen.prompt).toContain("Title: Dad Realizes His Wife Just Murdered Their Daughter");
  expect(seen.prompt).toContain("[0:00] Where were you that night?\n[0:05] At home.");
  expect(seen.prompt).toContain("- Evil Husband Thinks He Got Away With Killing His Wife");
  expect(seen.prompt).toMatch(/Their usual length is \d+–\d+ words/);
  expect(seen.prompt).toContain("Steer: the dress. Summary: asked for.");
  expect(seen.answers[0]).toContain("Saved 3 titles");
  expect(seen.answers[0]).toContain("split with a dash");
  expect(idea.titles.map((one) => one.text)).toEqual(["Mom Accidentally Admits Drowning Her Daughter Wasn't An Accident", "Dad Realizes What The Dress Really Meant", "Mom Realizes Her Made Up Story Isn't Making Sense", "Mom Has No Idea Detectives Found The Dress"]);
  expect(idea.main).toBe("Mom Accidentally Admits Drowning Her Daughter Wasn't An Accident");
  expect(idea.niche).toBe("child-related");
  expect(idea.thumbnailGuide).toBe("we use the interrogation room and have the mom in the middle");
  expect(idea.summary).toBe("A mother drowned her 6-year-old daughter and her 16-year-old escaped.");
  expect(idea.run).toMatchObject({ what: "repackage", state: "done", holder: "test-mac" });
  expect(idea.chat.map((turn) => [turn.role, turn.text])).toEqual([["you", "Repackage this case. Angle: the dress"], ["claude", "Done."]]);
  expect(idea.chat[1]!.tools?.map((one) => `${one.name}:${one.state}`)).toEqual(["save_titles:done", "save_titles:done", "save_thumbnail_guide:done", "save_summary:done"]);
});

test("a fresh run keeps what the person wrote, and a chat turn adds, removes and picks the main title", async () => {
  const idea = videoIdea("i5-test");
  idea.titles = [{ id: "p", text: "Mom Thinks Nobody Noticed The Dress", by: "Sphe", at: 0 }];
  idea.main = "Mom Thinks Nobody Noticed The Dress";
  idea.thumbnailGuide = "we have the house of the mom and have her in the middle";
  idea.guideBy = "Sphe";
  await cloud.commit(idea, 0, "Sphe");
  const seen = claudeCalls([
    { name: "save_titles", arguments: { titles: ["Dad Realizes What The Dress Really Meant", "Mom Realizes Her Made Up Story Isn't Making Sense", "Mom Has No Idea Detectives Found The Dress"] } },
    { name: "save_thumbnail_guide", arguments: { guide: "we use the interrogation room and have the mom in the middle" } },
  ]);
  await run.repackage(context(), "i5-test");
  let now = await settled("i5-test");
  expect(now.titles.map((one) => one.text)).toContain("Mom Thinks Nobody Noticed The Dress");
  expect(now.titles).toHaveLength(4);
  expect(now.main).toBe("Mom Thinks Nobody Noticed The Dress");
  expect(seen.answers[1]).toContain("theirs stays");
  expect(now.thumbnailGuide).toBe("we have the house of the mom and have her in the middle");
  claudeCalls([
    { name: "remove_titles", arguments: { titles: ["dad realizes what the dress really meant"] } },
    { name: "set_main_title", arguments: { title: "Mom Has No Idea Detectives Found The Dress" } },
  ], "Removed it and made the dress title the main one.");
  await run.chat(context(), "i5-test", "drop the dad one and lead with the dress");
  now = await settled("i5-test");
  expect(now.titles.map((one) => one.text)).not.toContain("Dad Realizes What The Dress Really Meant");
  expect(now.main).toBe("Mom Has No Idea Detectives Found The Dress");
  expect(now.chat.at(-1)).toMatchObject({ role: "claude", text: "Removed it and made the dress title the main one." });
  expect(now.run).toMatchObject({ what: "chat", state: "done" });
});

test("a video already on the board is the person's decision, not a run; no captions skip the case; a run that stops short says what's missing", async () => {
  await cloud.commit(videoIdea("i6-test"), 0, "Sphe");
  mock.on("POST", "/v1/ideas/trello/duplicates", () => Response.json({ found: { JcAHmNKiHic: { cardId: "c".repeat(24), name: "Dad Realizes", url: "https://trello.com/c/x", list: "Uploaded (SI", closed: false } } }), 1);
  let asked = false;
  run.asking.ask = async () => {
    asked = true;
    throw new Error("not asked");
  };
  await run.repackage(context(), "i6-test");
  let idea = await settled("i6-test");
  expect(asked).toBe(false);
  expect(idea.duplicate).toMatchObject({ name: "Dad Realizes", list: "Uploaded (SI" });
  expect(idea.chat.at(-1)!.text).toContain("already on the board");
  // Asked to improve it, Claude is told the card's title is the bad version.
  const seen = claudeCalls([]);
  await run.repackage(context(), "i6-test", { improve: true });
  idea = await settled("i6-test");
  expect(seen.prompt).toContain("that title is the bad version");
  expect(idea.run).toMatchObject({ state: "failed", error: "Claude stopped before saving 3–5 titles and the thumbnail guide." });
  // No English captions: skipped, with the reason, and Claude never asked.
  await cloud.commit(videoIdea("i7-test", "noCaptions1"), 0, "Sphe");
  const before = sources.captions.fetch;
  sources.captions.fetch = async () => null;
  asked = false;
  run.asking.ask = async () => {
    asked = true;
    throw new Error("not asked");
  };
  await run.repackage(context(), "i7-test");
  idea = await settled("i7-test");
  sources.captions.fetch = before;
  expect(asked).toBe(false);
  expect(idea.skipped).toContain("no English captions");
});

test("a run cut off by a restart is marked stopped, only on the Mac that ran it", async () => {
  const mine = videoIdea("i8-test");
  mine.run = { what: "repackage", state: "running", holder: "test-mac", by: "Sphe", startedAt: Date.now() };
  const theirs = videoIdea("i9-test");
  theirs.run = { what: "repackage", state: "running", holder: "other-mac", by: "JJ", startedAt: Date.now() };
  await cloud.commit(mine, 0, "Sphe");
  await cloud.commit(theirs, 0, "JJ");
  await run.markInterrupted("test-mac");
  expect(rows.get("i8-test")!.body.run).toMatchObject({ state: "stopped", error: "Edit restarted before Claude finished. Ask again." });
  expect(rows.get("i9-test")!.body.run!.state).toBe("running");
});
