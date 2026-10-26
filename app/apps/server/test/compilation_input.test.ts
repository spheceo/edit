import { expect, test } from "bun:test";
import { cardSources, markReusedScript, parseScriptText, readCard, readCompilation, sourceLines, WHOLE_SOURCE } from "../src/compilation_input.ts";
import { fixtureHome } from "./helpers/home.ts";
import { reusedScriptBlock } from "../src/project.ts";

const folder = "https://drive.google.com/drive/folders/1folderfolderfolder";
const video = "https://youtu.be/abcdefghijk";
const other = "https://youtu.be/ABCDEFGHIJK";
const doc = "https://docs.google.com/document/d/1scriptdocscriptdoc/edit";
const footage = "https://drive.google.com/file/d/1footagefootagefootage/view";
const html = `<html><head><title>The earlier case</title></head><body><p>The earlier case</p><p><a href="${footage}">(01:02 - 01:07)</a></p><p>These are the finished cut-in words.</p><p><a href="${footage}">(01:12 - 01:15)</a></p></body></html>`;

test("the four-case Trello screenshot retains the Drive folder, YouTube, reused Doc and final YouTube in order", () => {
  const sources = sourceLines(`Case 1: [Drive footage](${folder})\nCase 2: [New case](${video})\nCase 3 (reuse): [Earlier script](${doc})\nCase 4: [New case](${other})`);
  expect(sources.map((one) => [one.kind, one.reuse, one.url])).toEqual([
    ["folder", false, folder], ["video", false, video], ["script", true, doc], ["video", false, other],
  ]);
});

test("single-line case paste, explicit finished reuse and earlier-script references do not leak into new cases", () => {
  const sources = sourceLines(`Case 1: ${video} Case 2 (reuse): ${other} ${doc} case 4 Case 3: ${folder}`);
  expect(sources.map((one) => [one.url, one.reuse])).toEqual([[video, false], [other, true], [folder, false]]);
  expect(sources[1]?.earlier).toBe(doc);
  expect(sourceLines(`${video} REUSE ${other}`).map((one) => one.reuse)).toEqual([false, true]);
});

test("card descriptions lead, labeled attachments/checklists/comments add every supported source once", () => {
  const sources = cardSources({ desc: `Case 1: ${folder}`, attachments: [{ name: "Case 2", url: video }, { name: "Case 3 (reuse)", url: doc }], checklists: [{ checkItems: [{ name: other }] }], comments: [folder] });
  expect(sources.map((one) => one.url)).toEqual([folder, video, doc, other]);
  expect(sources.find((one) => one.url === doc)?.reuse).toBe(true);
});

test("numbered attachments fill missing case slots while reference links and smart-card duplicates stay out", () => {
  const sources = cardSources({ desc: `Case 1: [${folder}](${folder})\nCase 3 (reuse): ${doc}\nFootage: ${other}`,
    attachments: [{ name: "Case 2", url: video }, { name: "Case 3 (reuse)", url: doc }, { name: "Thumbnail", url: other }] });
  expect(sources.map((one) => one.url)).toEqual([folder, video, doc]);
  expect(cardSources({ desc: `Case 1: ${video}`, attachments: [{ name: "Case 2", url: video }] }).map((one) => one.case)).toEqual(["1", "2"]);
  expect(cardSources({ desc: `Case 1: ${video}`, attachmentLabels: [`Thumbnail <${other}>`], attachments: [other] }).map((one) => one.url)).toEqual([video]);
});

test("a single reused Doc from a Trello card keeps range protection while a normal standalone Doc remains editable", async () => {
  const home = fixtureHome("single-card-doc");
  try {
    const readers = { doc: async (): Promise<[string, string]> => [html, "Earlier case"], card: async () => ({ desc: `Case 1 (reuse): ${doc}` }) };
    const reused = await readCompilation("https://trello.com/c/AbCd1234/title", home.app, readers);
    expect(reused.blocks.every(reusedScriptBlock)).toBe(true);
    const normal = await readCompilation(doc, home.app, readers);
    expect(normal.blocks.some(reusedScriptBlock)).toBe(false);
  } finally { home.cleanup(); }
});

test("compilation expansion resolves the whole folder and preserves the reused Doc's exact ranges and finished words", async () => {
  const home = fixtureHome("compilation-input");
  try {
    const parsed = await readCompilation(`Case 1: ${folder}\nCase 2: ${video}\nCase 3 (reuse): ${doc}\nCase 4: ${other}`, home.app, {
      folder: async () => [{ id: "1firstfirstfirst", name: "01 first.mp4" }, { id: "1secondsecondsecond", name: "02 second.mp4" }],
      doc: async () => [html, "The earlier case"],
    });
    expect(parsed.blocks.map((block) => block.kind === "footage" ? block.file : block.text)).toEqual([
      "1firstfirstfirst", "1secondsecondsecond", "youtube:abcdefghijk", "1footagefootagefootage", "These are the finished cut-in words.", "1footagefootagefootage", "youtube:ABCDEFGHIJK",
    ]);
    expect(parsed.blocks[0]).toMatchObject({ label: WHOLE_SOURCE });
    expect(parsed.blocks[3]).toMatchObject({ start: 62, end: 67 });
    expect(reusedScriptBlock(parsed.blocks[3]!)).toBe(true);
    expect(parsed.blocks[6]).toMatchObject({ label: WHOLE_SOURCE });
  } finally { home.cleanup(); }
});

test("a finished video is untouched only when explicitly reused; invalid or failed case input never silently disappears", async () => {
  const home = fixtureHome("compilation-invalid");
  try {
    const parsed = await readCompilation(`REUSE ${video}`, home.app);
    expect(parsed.blocks[0]).toMatchObject({ label: "Reuse (the whole video)" });
    await expect(readCompilation("https://evil.example/drive.google.com/file/d/1footagefootagefootage", home.app)).rejects.toThrow("Paste Google");
    await expect(readCompilation(`${video}\n${doc}`, home.app, { doc: async () => { throw new Error("Doc is private"); } })).rejects.toThrow("Doc is private");
  } finally { home.cleanup(); }
});

test("Writer's complete plaintext ranges/links become reusable script blocks, never its narration summary", () => {
  const parsed = markReusedScript(parseScriptText(`The earlier case\n\n(01:02 - 01:07) <${footage}>\n\nThese are the finished cut-in words.\n\n(01:12 - 01:15) <${footage}>`, "The earlier case"), doc);
  expect(parsed.blocks).toHaveLength(3);
  expect(parsed.blocks[0]).toMatchObject({ file: "1footagefootagefootage", start: 62, end: 67 });
  expect(parsed.blocks[1]).toMatchObject({ text: "These are the finished cut-in words." });
  expect(parsed.blocks.every(reusedScriptBlock)).toBe(true);
});

test("the Trello relay receives Edit's bearer and retains labeled attachments; refused access surfaces before import", async () => {
  const oldUrl = process.env.EDIT_WRITER_RELAY_URL;
  const oldToken = process.env.EDIT_RELAY_TOKEN;
  let denied = false;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    expect(new URL(request.url).pathname).toBe("/v1/trello/card");
    expect(new URL(request.url).searchParams.get("card")).toBe("AbCd1234");
    expect(request.headers.get("authorization")).toBe("Bearer edit-test-bearer");
    return denied ? Response.json({ error: "Edit permission required" }, { status: 403 })
      : Response.json({ name: "Compilation", desc: `Case 1: ${video}`, attachmentLabels: [`Case 2 (reuse) <${doc}>`, `Case 3 <${folder}>`], attachments: [doc, folder] });
  } });
  try {
    process.env.EDIT_WRITER_RELAY_URL = server.url.origin;
    process.env.EDIT_RELAY_TOKEN = "edit-test-bearer";
    expect(cardSources(await readCard("https://trello.com/c/AbCd1234/title")).map((one) => one.url)).toEqual([video, doc, folder]);
    denied = true;
    await expect(readCard("https://trello.com/c/AbCd1234/title")).rejects.toThrow("Edit permission required");
  } finally {
    server.stop(true);
    if (oldUrl === undefined) delete process.env.EDIT_WRITER_RELAY_URL; else process.env.EDIT_WRITER_RELAY_URL = oldUrl;
    if (oldToken === undefined) delete process.env.EDIT_RELAY_TOKEN; else process.env.EDIT_RELAY_TOKEN = oldToken;
  }
});
