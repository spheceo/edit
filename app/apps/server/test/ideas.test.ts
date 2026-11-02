// Ideas (src/ideas/): the rules titles, guides and summaries keep to, a card
// written and read as the board writes one, and a repackaging end to end
// against a stand-in relay (mamagi's ideas functions in memory, YouTube's
// details, the board) with a stand-in Claude that calls the real tools.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";

import { footageIn, footageKind, footageLine, type Idea } from "@edit/types/ideas";

import * as board from "../src/ideas/board.ts";
import * as cloud from "../src/ideas/cloud.ts";
import * as frames from "../src/ideas/frames.ts";
import { cleanGuide, cleanTitle, closest, framesProblem, guideProblem, lookProblem, lengthStyle, sourceProblem, summaryProblem, titleProblem } from "../src/ideas/policy.ts";
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
  // A quoted word at its start or end stays whole (Nov 1: `"Chill" 16-Year-Old…` had lost its first quote).
  expect(cleanTitle('"Chill" 16-Year-Old Stabs Girl Who Showed Up At Her Door')).toBe('"Chill" 16-Year-Old Stabs Girl Who Showed Up At Her Door');
  expect(cleanTitle("“Perfect” Mom Has No Idea Police Are About To Arrest Her")).toBe("“Perfect” Mom Has No Idea Police Are About To Arrest Her");
  expect(cleanTitle("Cops Find Mom 'Caring For' Grandma")).toBe("Cops Find Mom 'Caring For' Grandma");
});

test("a guide is Repack's lowercase edits to the base with its caption in quotes, and a summary one compact paragraph", () => {
  expect(cleanGuide("Make the man a middle-aged man with a shaved head")).toBe("make the man a middle-aged man with a shaved head");
  expect(guideProblem("make the man a middle-aged man with a shaved head in a grey t-shirt. have the suspect fold his arms. change the current “CAUGHT” text to “He knew”.")).toBeNull();
  expect(guideProblem("make her look like Dina Thetford")).toContain("Dina");
  expect(guideProblem("make the man older. use a close-up camera angle.")).toContain("camera");
  expect(guideProblem("x".repeat(601))).toContain("600");
  // Where the subject's picture comes from, as the tool was told (the user, Nov 1).
  expect(guideProblem("find an image of the woman. make the woman a heavyset woman. keep her seated on the porch. change the current “He abused me” text to “He used a belt”.")).toBeNull();
  expect(sourceProblem("find an image of the woman. make her older.", "find")).toBeNull();
  expect(sourceProblem("take the woman from the original thumbnail. make her older.", "case_thumbnail")).toBeNull();
  expect(sourceProblem("make the woman older.", "find")).toContain("find an image");
  expect(sourceProblem("find an image of the woman.", "case_thumbnail")).toContain("original thumbnail");
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
  const idea = run.fresh("i1-test", "Sphe", { sources: [{ kind: "youtube", url: "https://www.youtube.com/watch?v=JcAHmNKiHic", videoId: "JcAHmNKiHic", title: "Dad Realizes", channel: "C", views: 1, outlier: "1x", publishedAt: null, durationSeconds: 1, thumbnail: "https://i.ytimg.com/vi/JcAHmNKiHic/maxresdefault.jpg" }], steer: "", wantsSummary: false, footage: [{ id: "f1", url: "https://drive.google.com/drive/folders/abc", kind: "drive", reuse: false }, { id: "f2", url: "https://youtu.be/old1", kind: "youtube", reuse: true }] });
  idea.titles = [{ id: "1", text: "First Title", by: "claude", at: 0 }, { id: "2", text: "Main Title", by: "claude", at: 0 }];
  idea.main = "Main Title";
  idea.thumbnailGuide = "we use the interrogation room and have the mom in the middle";
  // The video's thumbnail isn't put on by itself (the user, Nov 1: "just automatically passed through").
  expect(idea.images).toEqual([]);
  idea.images = [{ id: "t", name: "thumbnail", url: "https://i.ytimg.com/vi/JcAHmNKiHic/maxresdefault.jpg", from: "video" }];
  expect(board.cardText(idea)).toBe("Titles:\n- Main Title\n- First Title\n\nThumbnail Guide:\nwe use the interrogation room and have the mom in the middle\n[image]\n\nCase:\nhttps://www.youtube.com/watch?v=JcAHmNKiHic\n\nFootage:\nhttps://drive.google.com/drive/folders/abc\nREUSE https://youtu.be/old1");
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
  expect(() => applyPatch(idea, { footage: [{ url: "https://evil.example/x" }] }, "Sphe")).toThrow("isn't a YouTube or Google Drive link");
  // A list of links, each kept by its id with its name; a script's Doc only ever a reuse.
  idea.footage = [{ id: "f1", url: "https://drive.google.com/drive/folders/abc", kind: "drive", reuse: false }];
  applyPatch(idea, { footage: [{ id: "f1", url: "https://drive.google.com/drive/folders/abc", title: "Bodycam folder" }, { url: "https://docs.google.com/document/d/xyz/edit" }, { url: "https://youtu.be/new1", reuse: true }, { url: "https://youtu.be/new1" }] }, "Sphe");
  expect(idea.footage.map((one) => [one.id === "f1", one.kind, one.reuse, one.title ?? null])).toEqual([[true, "drive", false, "Bodycam folder"], [false, "doc", true, null], [false, "youtube", true, null]]);
});

test("footage is read from a paste or a card as Script mode reads it: YouTube and Drive links, a reuse when its line says so", () => {
  let n = 0;
  const read = footageIn("https://drive.google.com/drive/folders/1y9\nREUSE https://www.youtube.com/watch?v=abc123\nreused: https://docs.google.com/document/d/doc1/edit\nhttps://vimeo.com/1\nhttps://youtu.be/xyz.", () => `f${++n}`);
  expect(read.footage).toEqual([
    { id: "f1", url: "https://drive.google.com/drive/folders/1y9", kind: "drive", reuse: false },
    { id: "f2", url: "https://www.youtube.com/watch?v=abc123", kind: "youtube", reuse: true },
    { id: "f3", url: "https://docs.google.com/document/d/doc1/edit", kind: "doc", reuse: true },
    { id: "f4", url: "https://youtu.be/xyz", kind: "youtube", reuse: false },
  ]);
  expect(read.refused).toEqual(["https://vimeo.com/1"]);
  expect(footageKind("https://drive.google.com/file/d/1/view")).toBe("drive");
  expect(footageKind("drive.google.com/x")).toBeNull();
  expect(read.footage.map(footageLine)).toEqual(["https://drive.google.com/drive/folders/1y9", "REUSE https://www.youtube.com/watch?v=abc123", "REUSE https://docs.google.com/document/d/doc1/edit", "https://youtu.be/xyz"]);
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
    { name: "save_thumbnail_guide", arguments: { guide: "we use the interrogation room and have the mom in the middle", subject_from: "find" } },
    { name: "save_thumbnail_guide", arguments: { guide: "take the mom from the original thumbnail. we use the interrogation room and have the mom in the middle", subject_from: "case_thumbnail" } },
    { name: "save_thumbnail_guide", arguments: { guide: "We use the interrogation room and have the mom in the middle" } },
    { name: "save_thumbnail_guide", arguments: { guide: "Find an image of the mom. we use the interrogation room and have the mom in the middle", subject_from: "find" } },
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
  expect(seen.answers[2]).toContain("find an image of the subject");
  expect(seen.answers[3]).toContain("no YouTube thumbnail");
  expect(seen.answers[4]).toContain("subject_from");
  expect(idea.thumbnailGuide).toBe("find an image of the mom. we use the interrogation room and have the mom in the middle");
  expect(idea.images).toEqual([]);
  expect(idea.summary).toBe("A mother drowned her 6-year-old daughter and her 16-year-old escaped.");
  expect(idea.run).toMatchObject({ what: "repackage", state: "done", holder: "test-mac" });
  expect(idea.chat.map((turn) => [turn.role, turn.text])).toEqual([["you", "Repackage this case. Angle: the dress"], ["claude", "Done."]]);
  expect(idea.chat[1]!.tools?.map((one) => `${one.name}:${one.state}`)).toEqual(["save_titles:done", "save_titles:done", "save_thumbnail_guide:error", "save_thumbnail_guide:error", "save_thumbnail_guide:error", "save_thumbnail_guide:done", "save_summary:done"]);
});

test("the case's thumbnail goes on the card only when the guide takes the subject from it, after the base", async () => {
  const before = sources.pictures.fetch;
  sources.pictures.fetch = async (_url, path) => (fs.writeFileSync(path, "jpg"), true);
  try {
    const idea = videoIdea("i9-test");
    (idea.sources[0] as { thumbnail: string | null }).thumbnail = "https://i.ytimg.com/vi/JcAHmNKiHic/maxresdefault.jpg";
    idea.images = [{ id: "u", name: "mugshot", key: "edit/ideas/i9-test/u.jpg", from: "upload" }];
    await cloud.commit(idea, 0, "Sphe");
    mock.on("GET", "/v1/ideas/trello/approved", () => Response.json({ titles: [{ id: "a1", title: "Mom Realizes Her Made Up Story Isn't Making Sense", list: "Uploaded (SI", url: "https://trello.com/c/a1", cover: "https://trello.com/1/cards/a1/attachments/c/download/cover.jpg" }] }), 1);
    board.forget();
    const seen = claudeCalls([
      { name: "save_titles", arguments: { titles: ["Mom Realizes Her Made Up Story Isn't Making Sense Again", "Dad Realizes What The Dress Really Meant", "Mom Has No Idea Detectives Found The Dress"] } },
      { name: "save_thumbnail_guide", arguments: { guide: "take the mom from the original thumbnail. have her in the middle.", subject_from: "case_thumbnail", base_card: "https://trello.com/c/a1" } },
      { name: "save_thumbnail_guide", arguments: { guide: "take the mom from the original thumbnail. have her in the middle.", subject_from: "case_thumbnail", base_card: "https://trello.com/c/a1", new_from_original: "she sits in the interrogation room, not her kitchen" } },
    ]);
    await run.repackage(context(), "i9-test");
    let now = await settled("i9-test");
    // Something new against the case's own thumbnail, said on purpose (Sphe, Nov 2: "way too similar to the original thumbnail").
    expect(seen.answers[1]).toContain("new_from_original");
    expect(now.images.map((one) => one.from)).toEqual(["base", "video", "upload"]);
    claudeCalls([{ name: "save_thumbnail_guide", arguments: { guide: "find an image of the mom. have her in the middle.", subject_from: "find", new_from_original: "a new picture of her in the room" } }], "Changed it.");
    await run.chat(context(), "i9-test", "she isn't in the thumbnail, find one");
    now = await settled("i9-test");
    expect(now.images.map((one) => one.from)).toEqual(["base", "upload"]);
  } finally {
    sources.pictures.fetch = before;
  }
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
    { name: "save_thumbnail_guide", arguments: { guide: "find an image of the mom. we use the interrogation room and have the mom in the middle", subject_from: "find" } },
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
  const answers = claudeCalls([
    { name: "rename_title", arguments: { title: "mom has no idea detectives found the dress", to: "Mom Has No Idea Police Found The Dress" } },
    { name: "rename_title", arguments: { title: "Mom Has No Idea Police Found The Dress", to: "Mom Thinks Nobody Noticed The Dress" } },
  ], "Reworded it.");
  await run.chat(context(), "i5-test", "say police, not detectives");
  now = await settled("i5-test");
  expect(now.titles.map((one) => one.text)).toContain("Mom Has No Idea Police Found The Dress");
  expect(now.titles.map((one) => one.text)).not.toContain("Mom Has No Idea Detectives Found The Dress");
  expect(now.main).toBe("Mom Has No Idea Police Found The Dress");
  expect(answers.answers[1]).toContain("already saved");
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

test("the video's times, storyboard and stream are read from yt-dlp's formats, and a sharp frame outscores a blur", () => {
  expect(frames.secondsOf("4:12")).toBe(252);
  expect(frames.secondsOf("[1:02:03]")).toBe(3723);
  expect(frames.secondsOf("41")).toBe(41);
  expect(frames.secondsOf("soon")).toBeNull();
  expect(frames.clock(252.9)).toBe("4:12");
  const found = frames.videoOf("J112wCvKWNY", 100, [
    { format_id: "sb1", width: 160, height: 90, rows: 5, columns: 5, fragments: [{ url: "https://i.ytimg.com/sb/small.jpg", duration: 100 }] },
    { format_id: "sb0", width: 320, height: 180, rows: 3, columns: 3, fragments: [{ url: "https://i.ytimg.com/sb/M0.jpg", duration: 45 }, { url: "https://i.ytimg.com/sb/M1.jpg", duration: 45 }, { url: "https://i.ytimg.com/sb/M2.jpg", duration: 10 }] },
    { format_id: "137", vcodec: "avc1.640028", acodec: "none", protocol: "https", height: 1080, url: "https://rr.googlevideo.com/1080" },
    { format_id: "399", vcodec: "av01.0.08M.08", acodec: "none", protocol: "https", height: 1080, url: "https://rr.googlevideo.com/av1" },
    { format_id: "18", vcodec: "avc1.42001E", acodec: "mp4a.40.2", protocol: "https", height: 360, url: "https://rr.googlevideo.com/muxed" },
  ]);
  expect(found).toMatchObject({ every: 5, columns: 3, width: 320, stream: "https://rr.googlevideo.com/1080" });
  expect(found.sheets).toEqual([{ url: "https://i.ytimg.com/sb/M0.jpg", start: 0, tiles: 9 }, { url: "https://i.ytimg.com/sb/M1.jpg", start: 45, tiles: 9 }, { url: "https://i.ytimg.com/sb/M2.jpg", start: 90, tiles: 2 }]);
  const edges = new Uint8Array(40 * 30).map((_, n) => ((n % 40) + Math.floor(n / 40)) % 2 === 0 ? 255 : 0);
  const flat = new Uint8Array(40 * 30).fill(128);
  expect(frames.sharpness(edges, 40, 30)).toBeGreaterThan(frames.sharpness(flat, 40, 30));
});

test("a guide with frames names each by its place on the card, and keeps the team's way of saying it", () => {
  const guide = "use the first frame as the base. take the father from the second frame and stand him at the front door. have the father look just above the camera.";
  expect(guideProblem(guide, 2)).toBeNull();
  expect(sourceProblem(guide, "video")).toBeNull();
  expect(sourceProblem("find an image of the father.", "video")).toContain("which frame");
  expect(framesProblem(guide, 2)).toBeNull();
  expect(framesProblem(guide, 3)).toContain("what the third frame is for");
  expect(framesProblem(guide, 1)).toContain("names the second frame, but the card has one frame");
  expect(framesProblem("use the frame at 3:09 as the base.", 1)).toContain("by its time");
  // Sphe's notes on the first try (Nov 2).
  expect(guideProblem("use the first frame. have the woman in the white top look into the camera.", 1)).toContain("look into the eyes of the POV");
  expect(guideProblem("use the first frame. have her look into the eyes of the POV.", 1)).toBeNull();
  expect(guideProblem("use the first frame. have her talking mid-sentence.", 1)).toContain("mouth a bit open");
  expect(guideProblem("use the first frame. remove the video's subtitles.", 1)).toContain("the editor always does");
  expect(guideProblem("use the first frame. add “SHE ADMITTED IT” text.", 1)).toContain("“She admitted it”");
  expect(guideProblem("use the first frame. add “She admitted it” text.", 1)).toBeNull();
  // Faces never blurred; the bodycam's angle moved on a frame, never on an approved thumbnail's base.
  expect(guideProblem("use the first frame as the base. take the mom from the second frame, holding the blurred baby.", 2)).toContain("never have blurred faces");
  expect(guideProblem("use the first frame as the base. move the camera angle up so that we can see the upper body of the mom and baby.", 1)).toBeNull();
  expect(guideProblem("find an image of the mom. move the camera angle up.")).toContain("camera");
  // The subject's look only when the editor has to find an image of them.
  const looks = "use the first frame as the base. take the mom from the second frame. make the mom a young woman with long dark curly hair pulled back, in a grey sweatshirt.";
  expect(lookProblem(looks, "video")).toContain("which shows it");
  expect(lookProblem("take the woman from the original thumbnail. make the woman a 60-year-old woman.", "case_thumbnail")).toContain("the original thumbnail");
  expect(lookProblem("find an image of the man. make the man a middle-aged man with a shaved head.", "find")).toBeNull();
  expect(lookProblem("use the first frame. make the mom look tired and upset.", "video")).toBeNull();
  // Repack's base caption is quoted as it is on the base.
  expect(guideProblem("find an image of the man. remove the current “CAUGHT” text.")).toBeNull();
});

test("a repackaging looks through the case's video and puts the frames its guide takes on the card, the base frame first", async () => {
  // A 12-second test video standing in for YouTube's 1080p stream, served by range as googlevideo does.
  const dir = fs.mkdtempSync(`${home}/frames-`);
  const clip = `${dir}/source.mp4`;
  const made = Bun.spawnSync(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=12", "-pix_fmt", "yuv420p", "-movflags", "+faststart", clip]);
  expect(made.exitCode).toBe(0);
  const bytes = fs.readFileSync(clip);
  const before = { ...frames.looks };
  frames.looks.info = async () => ({
    duration: 12,
    formats: [
      { format_id: "sb0", width: 320, height: 180, rows: 3, columns: 3, fragments: [{ url: "https://i.ytimg.com/sb/M0.jpg", duration: 12 }] },
      { format_id: "137", vcodec: "avc1.640028", acodec: "none", protocol: "https", height: 1080, url: "https://rr.googlevideo.com/stream" },
    ],
  });
  frames.looks.fetch = async (url, init = {}) => {
    if (url.includes("/sb/")) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const range = /bytes=(\d+)-(\d*)/.exec(init.range ?? "");
    if (range === null) return new Response(bytes, { headers: { "content-type": "video/mp4", "accept-ranges": "bytes" } });
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return new Response(bytes.subarray(start, end + 1), { status: 206, headers: { "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${bytes.length}`, "accept-ranges": "bytes" } });
  };
  try {
    const idea = videoIdea("i11-test");
    await cloud.commit(idea, 0, "Sphe");
    const seen = claudeCalls([
      { name: "scan_video", arguments: {} },
      { name: "grab_frames", arguments: { times: ["0:02", "0:08", "0:30"] } },
      { name: "grab_frames", arguments: { times: ["0:02", "0:08"] } },
      { name: "save_titles", arguments: { titles: ["Dad Realizes What The Dress Really Meant", "Mom Realizes Her Made Up Story Isn't Making Sense", "Mom Has No Idea Detectives Found The Dress"] } },
      { name: "save_thumbnail_guide", arguments: { guide: "use the first frame as the base. take the mom from the second frame.", subject_from: "video", frames: [{ at: "0:02", use: "base" }, { at: "0:08", use: "subject" }] } },
      { name: "save_thumbnail_guide", arguments: { guide: "use the first frame as the base. take the mom from the second frame.", subject_from: "video", frames: [{ at: "0:02", use: "base" }, { at: "0:09", use: "subject", who: "the mom" }] } },
      { name: "save_thumbnail_guide", arguments: { guide: "use the first frame as the base. take the mom from the second frame.", subject_from: "video", frames: [{ at: "0:08", use: "subject", who: "the mom" }, { at: "0:02", use: "base" }] } },
      { name: "save_thumbnail_guide", arguments: { guide: "use the first frame as the base. take the mom from the second frame.", subject_from: "video", frames: [{ at: "0:02", use: "base" }, { at: "0:08", use: "subject", who: "the mom" }] } },
    ]);
    await run.repackage(context(), "i11-test");
    const now = await settled("i11-test");
    expect(seen.prompt).toContain("# The case's video");
    expect(seen.answers[0]).toContain("1 storyboard sheet");
    expect(seen.answers[0]).toMatch(/storyboard-01\.jpg: 0:00–0:12, 9 tiles \(3 across\), one every 1\.3 s/);
    expect(seen.answers[1]).toContain("0:30 is past its end");
    expect(seen.answers[2]).toMatch(/the frame at 0:0[12].*frame-20\.jpg\n- the frame at 0:0[78].*frame-80\.jpg/);
    expect(seen.answers[4]).toContain('say who (who: "the father")');
    // A time it didn't give back, past a second of every frame grabbed.
    expect(seen.answers[5]).toContain("No frame at 0:09");
    expect(seen.answers[6]).toContain("The base frame goes first");
    expect(now.thumbnailGuide).toBe("use the first frame as the base. take the mom from the second frame.");
    expect(now.images.map((one) => [one.from, one.name.replace(/ · 0:0\d$/, ""), one.frame?.use])).toEqual([
      ["frame", "first frame · base", "base"],
      ["frame", "second frame · the mom", "subject"],
    ]);
    // On R2, as the person's own pictures are, so the board can attach them.
    for (const one of now.images) expect(mock.objects.get(one.key!)?.slice(0, 2)).toEqual(new Uint8Array([0xff, 0xd8]));
    expect(seen.answers[7]).toContain("on the first frame, with 2 frames on the card");
  } finally {
    Object.assign(frames.looks, before);
  }
});
