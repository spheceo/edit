// script.ts's tests, plus the Drive and Docs paths against the mock.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";

import type { ScriptBlock } from "../src/model.ts";
import { native } from "../src/native/index.ts";
import { clipEnd, fps as fpsOf } from "../src/project.ts";
import {
  align,
  clock,
  confirmLink,
  cueWords,
  dispositionName,
  docId,
  download,
  driveFileId,
  durationOf,
  excerptExtension,
  excerpts,
  fetchDoc,
  joinCases,
  findRanges,
  layOut,
  likeness,
  parse,
  placed,
  resolve,
  safeName,
  spans,
  CUT_IN_SECONDS,
  WORD_PAD,
} from "../src/script.ts";
import { MockServer } from "./mocks/server.ts";
import { scratch } from "./helpers/home.ts";
import { media, project as newProject, stubNative } from "./helpers/model.ts";
import type { Word } from "../src/transcribe.ts";

const DOC = `<html><head><title>Kent crash</title><style>.c1{color:red}</style></head><body>
<p><span>Kent crash</span></p><p><span>Total Duration: 27m</span></p>
<p><span>FOIA Kent Police - Mother Finds Out Her Son Caused The Crash That Killed Her Neighbour Months Later</span></p>
<p><span>(</span><a href="https://www.google.com/url?q=https://drive.google.com/file/d/1H9hY3w4LjzWlSAqY8hfp3I5Ft5PP0X9Y/view?usp%3Dsharing%26t%3D91.506&amp;sa=D">01:31 - 01:</a><a href="https://www.google.com/url?q=https://drive.google.com/file/d/1H9hY3w4LjzWlSAqY8hfp3I5Ft5PP0X9Y/view?usp%3Dsharing%26t%3D91.506&amp;sa=D">37</a><sup><a href="#cmnt1" id="cmnt_ref1">[a]</a></sup><sup><a href="#cmnt2" id="cmnt_ref2">[b]</a></sup><sup><a href="#cmnt3" id="cmnt_ref3">[c]</a></sup><span>) (</span><a href="https://www.google.com/url?q=https://drive.google.com/file/d/1N4zyXbvBcdg9Y1ZzpeZ6-0e_TgB_rMC9/view?usp%3Dsharing%26t%3D68.674&amp;sa=D">01:08 - 01:10</a><span>)</span></p>
<p><span>This mother had absolutely no idea that her son&rsquo;s role&hellip;</span></p>
<p><span>A second paragraph of the same cut-in.</span><sup><a href="#cmnt4" id="cmnt_ref4">[d]</a></sup></p>
<p><span>(1:02:03 &ndash; 1:02:09)</span></p>
<div><p><a href="#cmnt_ref1" id="cmnt1">[a]</a><span>Extend to 1:37</span></p></div>
<div><p><a href="#cmnt_ref2" id="cmnt2">[b]</a><span>fixed</span></p></div>
<div><p><a href="#cmnt_ref3" id="cmnt3">[c]</a><span>A little accident....car crash</span></p></div>
<div><p><a href="#cmnt_ref4" id="cmnt4">[d]</a><span>To Editor: blur the victim</span></p></div>
</body></html>`;

type Footage = Extract<ScriptBlock, { kind: "footage" }>;
type Narration = Extract<ScriptBlock, { kind: "narration" }>;

test("reads_ranges_links_narration_and_notes", () => {
  const parsed = parse(DOC);
  expect(parsed.title).toBe("Kent crash");
  expect(parsed.blocks.length).toBe(4);
  const first = parsed.blocks[0] as Footage;
  expect(first.file).toBe("1H9hY3w4LjzWlSAqY8hfp3I5Ft5PP0X9Y");
  // The link's t= is the exact start.
  expect(Math.abs(first.start - 91.506)).toBeLessThan(1e-9);
  expect(first.end).toBe(97);
  expect(first.label).toBe("01:31 - 01:37");
  // A 'fixed' reply resolves the note before it.
  expect(first.notes).toEqual(["A little accident....car crash"]);
  const second = parsed.blocks[1] as Footage;
  expect(second.file).toBe("1N4zyXbvBcdg9Y1ZzpeZ6-0e_TgB_rMC9");
  expect(Math.abs(second.start - 68.674)).toBeLessThan(1e-9);
  const narration = parsed.blocks[2] as Narration;
  expect(narration.text).toBe("This mother had absolutely no idea that her son's role…\n\nA second paragraph of the same cut-in.");
  expect(narration.notes).toEqual(["To Editor: blur the victim"]);
  // An unlinked range belongs to the file before it; hours parse.
  const last = parsed.blocks[3] as Footage;
  expect(last.file).toBe("1N4zyXbvBcdg9Y1ZzpeZ6-0e_TgB_rMC9");
  expect([last.start, last.end]).toEqual([3723, 3729]);
});

test("finds_drive_ids_and_ranges", () => {
  expect(driveFileId("https://drive.google.com/open?id=1abcdefghijkl")).toBe("1abcdefghijkl");
  expect(driveFileId("https://drive.google.com/file/d/1abcdefghijkl/view?usp=sharing")).toBe("1abcdefghijkl");
  expect(driveFileId("https://youtube.com/watch?v=1abcdefghijkl")).toBeNull();
  expect(docId("https://docs.google.com/document/d/1hB2Prvupx1Yhz2y9MZNqQ1rl9y88uarGNe4CmGbiLaE/edit?tab=t.0")).toBe(
    "1hB2Prvupx1Yhz2y9MZNqQ1rl9y88uarGNe4CmGbiLaE",
  );
  const ranges = findRanges("( ) (00:54 - 01:57) 12:30 and (4:12–5:24) 2024");
  expect(ranges.map((range) => [range.from, range.to])).toEqual([
    [54, 117],
    [252, 324],
  ]);
  expect(dispositionName('attachment; filename="Bodycam 1.mp4"')).toBe("Bodycam 1.mp4");
  expect(dispositionName("attachment; filename*=UTF-8''Body%20cam.mov")).toBe("Body cam.mov");
  const page =
    '<form id="download-form" action="https://drive.usercontent.google.com/download" method="get"><input type="hidden" name="id" value="X1"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-1"></form>';
  const restore = process.env.EDIT_GOOGLE_API_URL;
  delete process.env.EDIT_GOOGLE_API_URL;
  try {
    expect(confirmLink(page)).toBe("https://drive.usercontent.google.com/download?id=X1&confirm=t&uuid=u-1");
  } finally {
    if (restore !== undefined) process.env.EDIT_GOOGLE_API_URL = restore;
  }
  for (const action of [
    "file:///etc/passwd",
    "http://127.0.0.1:7700/api/projects",
    "https://evil.example/download",
    "https://drive.usercontent.google.com.evil.example/download",
  ]) {
    expect(confirmLink(page.replace("https://drive.usercontent.google.com/download", action))).toBeNull();
  }
});

const ffmpeg = Bun.which("ffmpeg");

test.skipIf(ffmpeg === null || Bun.which("ffprobe") === null)(
  "concurrent_local_excerpts_keep_exact_ranges_and_separate_temporary_files",
  async () => {
    stubNative();
    const { dir, cleanup } = scratch("excerpt");
    try {
      const source = `${dir}/source.mp4`;
      const made = Bun.spawnSync([ffmpeg!, "-v", "error", "-y", "-f", "lavfi", "-i", "color=red:s=32x32:r=30:d=60", "-c:v", "libx264", "-g", "1", "-pix_fmt", "yuv420p", source]);
      expect(made.exitCode).toBe(0);
      const [a, b] = await Promise.all([excerpts(source, [[20.1, 20.61]]), excerpts(source, [[20.2, 20.7]])]);
      expect(a[0]!.path).not.toBe(b[0]!.path);
      for (const excerpt of [a[0]!, b[0]!]) {
        const seconds = await durationOf(excerpt.path);
        expect(seconds >= 20.4 && seconds < 20.7).toBe(true);
      }
      expect(fs.readdirSync(`${dir}/excerpts`).every((name) => !name.startsWith(".cutting"))).toBe(true);
    } finally {
      cleanup();
    }
  },
);

test("lays_out_footage_and_cut_ins_in_order", () => {
  stubNative();
  const project = newProject("Test");
  project.media.push(
    media({ id: "m1", name: "a.mp4", path: "/tmp/a.mp4", kind: "video", duration: 120, width: 1920, height: 1080, fps: 30, has_audio: true }),
  );
  const footage = (start: number, end: number): ScriptBlock => ({ kind: "footage", url: "", file: "f1", start, end, label: "", media: "m1" });
  project.script = {
    blocks: [
      footage(91.506, 97),
      { kind: "narration", text: "Words between." },
      footage(10, 12),
      // Past the end of the file: skipped, not stretched.
      footage(150, 160),
    ],
  };
  layOut(project);
  expect(native().projectValidate(JSON.stringify(project))).toBeNull();
  const fps = fpsOf(project);
  const video = project.clips.filter((clip) => clip.type === "video" || clip.type === "solid");
  expect(video.length).toBe(3);
  expect([video[0]!.start, video[0]!.duration]).toEqual([0, Math.round((97 - 91.506) * fps)]);
  expect(video[0]!.type === "video" && Math.abs(video[0]!.source_in - 91.506) < 1e-9).toBe(true);
  expect(video[1]!.start).toBe(clipEnd(video[0]!));
  expect(video[1]!.duration).toBe(CUT_IN_SECONDS * fps);
  expect(video[2]!.start).toBe(clipEnd(video[1]!));
  // Picture and sound are linked; the cut-in's words sit above its card.
  expect(project.clips.filter((clip) => clip.type === "audio").length).toBe(2);
  expect(project.clips.some((clip) => clip.type === "text" && clip.text === "Words between.")).toBe(true);
  // Placed blocks remember their clips, so a second pass adds nothing.
  const count = project.clips.length;
  layOut(project);
  expect(project.clips.length).toBe(count);
  // A covered cut-in whose card id was cleared (as cover_cut_in once did)
  // but whose voice-over is on the timeline isn't laid out again.
  const sound = project.clips.find((clip) => clip.type === "audio")?.id;
  for (const block of project.script.blocks) {
    if (block.kind !== "narration") continue;
    delete block.clip;
    block.voiceover = sound;
  }
  layOut(project);
  expect(project.clips.length).toBe(count);
  expect(project.script.blocks.filter((block) => block.kind === "narration").every((block) => placed(project, block))).toBe(true);
});

// Downloads a real (715 MB) Drive file; ignored in Rust too.
test.skip("drive_download", () => {});

test("excerpt_spans_pad_and_merge", () => {
  // Close ranges share a span; far ones get their own; padding stays inside the file.
  const ranges: [number, number][] = [
    [54, 117],
    [120, 141],
    [5, 8],
    [3600, 3610],
    [19_710, 19_714],
  ];
  expect(spans(ranges, 19_714.35)).toEqual([
    [0, 151],
    [3590, 3620],
    [19_700, 19_714.35],
  ]);
});

test("reads_cue_words", () => {
  const notes = (text: string) => ["Extend to 1:37", text];
  expect(cueWords(notes("A little accident....car crash, perhaps?"))).toEqual(["A", "perhaps?"]);
  expect(cueWords(notes("Do you.....arm injured?"))).toEqual(["Do", "injured?"]);
  expect(cueWords(notes("*Victim groans*....hey man"))).toEqual(["*Victim", "man"]);
  expect(cueWords(["To Editor: Blur the victim"])).toBeNull();
});

const word = (text: string, start: number, end: number): Word => ({ text, start, end });

test("matches_cue_words_spelt_a_little_differently", () => {
  // The Doc's range "i....priuses" over a transcript that heard "Prius".
  const words = [
    word("I", 77.1, 77.2),
    word("saw", 77.25, 77.5),
    word("hit", 81.4, 81.55),
    word("that", 81.56, 81.8),
    word("Prius", 81.82, 82.12),
    word("that's,", 82.14, 82.4),
    word("whatever,", 82.5, 83.0),
    word("behind", 83.6, 83.9),
    word("the", 83.92, 84.0),
    word("Prius", 84.14, 84.36),
    word("car.", 84.4, 84.7),
  ];
  const [, cutOut] = align(words, null, ["i", "priuses"], 77, 82);
  // Right after the "Prius" nearest the written end, not short of it.
  expect(cutOut).not.toBeNull();
  expect(cutOut! >= 82.12 && cutOut! <= 82.14).toBe(true);
  expect(likeness("Prius", "priuses")).toBe(1);
  expect(likeness("Prious", "prius")).toBe(1);
  expect(likeness("Prius", "prius")).toBe(0);
  // Short words and different words don't pass.
  expect(likeness("a", "i")).toBeNull();
  expect(likeness("Pickup", "priuses")).toBeNull();
});

test("cuts_at_the_first_and_last_words", () => {
  const words = [
    word("Okay.", 90.2, 90.6),
    word("A", 91.7, 91.78),
    word("little", 91.8, 92.1),
    word("accident,", 92.12, 92.7),
    word("a", 93.0, 93.05),
    word("car", 95.0, 95.3),
    word("crash,", 95.3, 95.8),
    word("perhaps?", 95.9, 96.62),
    word("Yes.", 96.66, 97.1),
  ];
  const [cutIn, cutOut] = align(words, null, ["A", "perhaps?"], 91.506, 97.0);
  // The nearest "A" to 91.5 (not the later "a"), a little room before it, never into "Okay.".
  expect(Math.abs(cutIn! - (91.7 - WORD_PAD))).toBeLessThan(1e-9);
  // "Yes." follows 40 ms after "perhaps?": no room, right at its end.
  expect(Math.abs(cutOut! - 96.62)).toBeLessThan(1e-9);
  // With the sound to go by, in the quietest instant near that end
  // (transcript times are loose): the dip at 96.60, not the quieter one inside "Yes.".
  const peaks = new Uint8Array(9800).fill(200);
  peaks[9660] = 40;
  peaks[9670] = 10;
  const [, quiet] = align(words, peaks, ["A", "perhaps?"], 91.506, 97.0);
  expect(Math.abs(quiet! - 96.6)).toBeLessThan(1e-9);
  // A described sound can't be found in speech: that side keeps the Doc's time.
  expect(align(words, null, ["*Victim", "perhaps?"], 91.5, 97.0)[0]).toBeNull();
  // Words far from where the range is written don't count.
  expect(align(words, null, ["Okay.", "Yes."], 40, 50)).toEqual([null, null]);
});

// ---------------------------------------------------------------------------
// Beyond the Rust tests: Docs and Drive through the mock (EDIT_GOOGLE_API_URL).

let mock: MockServer;
let restoreEnv: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restoreEnv = mock.useEnv();
});

afterAll(() => {
  restoreEnv();
  mock.stop();
});

test("a shared Doc is read with its title; one that isn't says how to share it", async () => {
  mock.on("GET", "/docs.google.com/document/d/DOC1234567890/export", (request) => {
    expect(request.query.get("format")).toBe("html");
    return new Response(DOC, { headers: { "content-type": "text/html", "content-disposition": 'attachment; filename="Kent crash.html"' } });
  });
  expect(await fetchDoc("DOC1234567890")).toEqual([DOC, "Kent crash"]);
  // Not shared: Google sends the sign-in page.
  mock.on("GET", "/docs.google.com/document/d/PRIVATE123456/export", (_request, server) =>
    Response.redirect(`${server.url}/accounts.google.com/ServiceLogin`, 302),
  );
  mock.on("GET", "/accounts.google.com/ServiceLogin", () => new Response("<html><body>sign in</body></html>"));
  await expect(fetchDoc("PRIVATE123456")).rejects.toThrow(
    "Couldn't read that Google Doc. Share it so anyone with the link can view, then try again.",
  );
});

test("Drive's virus-scan page is followed through its form, and a download resumes", async () => {
  const bytes = new Uint8Array(100_000).map((_, index) => index % 251);
  const serve = (request: Request | { headers: Headers }) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
    const headers = { "content-type": "video/mp4", "content-disposition": 'attachment; filename="Body cam.mp4"' };
    if (range === null) return new Response(bytes, { headers });
    const start = Number(range[1]);
    const end = range[2] === "" ? bytes.length - 1 : Number(range[2]);
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${bytes.length}` },
    });
  };
  mock.on("GET", "/drive.usercontent.google.com/download", (request) => {
    if (request.query.get("uuid") === "u-1") return serve(request);
    // The first ask: the "can't scan this file" page.
    return new Response(
      '<html><form id="download-form" action="https://drive.usercontent.google.com/download" method="get"><input type="hidden" name="id" value="FILE1234567"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-1"></form></html>',
      { headers: { "content-type": "text/html" } },
    );
  });
  const { dir, cleanup } = scratch("drive");
  try {
    const [url, head] = await resolve("FILE1234567", `${dir}/.probe`);
    expect(url).toBe(`${mock.url}/drive.usercontent.google.com/download?id=FILE1234567&confirm=t&uuid=u-1`);
    expect(head).toEqual({ status: 206, html: false, name: "Body cam.mp4", total: 100_000 });
    // Half there already: only the rest is asked for.
    const folder = `${dir}/FILE1234567`;
    fs.mkdirSync(folder);
    fs.writeFileSync(`${folder}/.download`, bytes.slice(0, 40_000));
    const seen: number[] = [];
    const path = await download(folder, "FILE1234567", (got) => seen.push(got));
    expect(path).toBe(`${folder}/Body cam.mp4`);
    expect(new Uint8Array(fs.readFileSync(path))).toEqual(bytes);
    expect(seen.at(-1)).toBe(100_000);
    const asked = mock.calls("/drive.usercontent.google.com/download").map((call) => call.headers.get("range"));
    expect(asked.at(-1)).toBe("bytes=40000-");
    // Finished files are reused, not fetched again.
    const before = mock.requests.length;
    expect(await download(folder, "FILE1234567", () => {})).toBe(path);
    expect(mock.requests.length).toBe(before);
  } finally {
    cleanup();
  }
});

test("Drive's refusals are said in words", async () => {
  mock.on("GET", "/drive.usercontent.google.com/download", (request) =>
    request.query.get("id") === "GONE1234567" ? new Response("", { status: 404 }) : new Response("", { status: 403 }),
  );
  const { dir, cleanup } = scratch("drive-refused");
  try {
    await expect(resolve("GONE1234567", `${dir}/.probe`)).rejects.toThrow("Google Drive can't find this file (deleted, or in the trash).");
    await expect(resolve("LOCKED12345", `${dir}/.probe`)).rejects.toThrow(
      "This Drive file isn't shared. Set it so anyone with the link can view.",
    );
  } finally {
    cleanup();
  }
});

test("names and clocks", () => {
  expect(safeName("../a/b:c")).toBe("_a_b_c");
  expect(safeName("  .hidden ")).toBe("hidden");
  expect(safeName("...")).toBe("footage.mp4");
  expect(clock(3723.4)).toBe("1h02m03s");
  expect(clock(59.5)).toBe("0h01m00s");
  expect(clock(-3)).toBe("0h00m00s");
});

test("follows_a_compilations_case_scripts_after_the_narration_naming_them", async () => {
  const link = (t: number) =>
    `<a href="https://www.google.com/url?q=https://drive.google.com/file/d/1CaseOneFileAbc/view?t%3D${t}&amp;sa=D">00:0${t} - 00:0${t + 2}</a>`;
  const main = `<html><body><p><span>Comp</span></p>
<p><span>(</span>${link(1)}<span>)</span></p>
<p><span>Eventually, she was sentenced to 15 years.</span></p>
<p><span>&mdash;</span></p>
<p><span>In a similar case, another young man reported the crime himself&hellip;</span><sup><a href="#cmnt1" id="cmnt_ref1">[a]</a></sup></p>
<p><span>__</span></p>
<p><span>Next up we have the case of a 16-year-old&hellip;</span><sup><a href="#cmnt2" id="cmnt_ref2">[b]</a></sup></p>
<div><p><a href="#cmnt_ref1" id="cmnt1">[a]</a><span>Edit case 2 based on this script here: </span><a href="https://www.google.com/url?q=https://docs.google.com/document/d/1CaseTwoDocAbcdef/edit?usp%3Dsharing&amp;sa=D">https://docs.google.com/document/d/1CaseTwoDocAbcdef/edit?usp=sharing</a></p></div>
<div><p><a href="#cmnt_ref2" id="cmnt2">[b]</a><span>Edit case 3 based on this script here: https://docs.google.com/document/d/1CaseThreeDocAbc/edit</span></p></div>
</body></html>`;
  const caseDoc = (name: string) =>
    `<html><body><p><span>INTERRO ${name}</span></p><p><span>Total Duration: 24m</span></p>
<p><span>(</span><a href="https://www.google.com/url?q=https://drive.google.com/file/d/1${name}FileAbcdef/view?t%3D5&amp;sa=D">00:05 - 00:09</a><span>)</span></p>
<p><span>${name} reported his own parents missing.</span></p></body></html>`;
  const parsed = parse(main);
  expect(parsed.cases).toEqual([
    { after: 2, doc: "1CaseTwoDocAbcdef" },
    { after: 3, doc: "1CaseThreeDocAbc" },
  ]);
  const read: string[] = [];
  await joinCases(parsed, async (id) => {
    read.push(id);
    return caseDoc(id === "1CaseTwoDocAbcdef" ? "Chandler" : "Lola");
  });
  expect(parsed.cases).toBeUndefined();
  expect(read.sort()).toEqual(["1CaseThreeDocAbc", "1CaseTwoDocAbcdef"]);
  const shape = parsed.blocks.map((block) => (block.kind === "footage" ? `footage ${block.file}` : block.text.split(/[,.…]/)[0]));
  expect(shape).toEqual([
    "footage 1CaseOneFileAbc",
    // The separator line is dropped; the case 2 teaser stays with the outcome before it.
    "Eventually",
    "footage 1ChandlerFileAbcdef",
    "Chandler reported his own parents missing",
    // After a case, the next narration is a cut-in of its own.
    "Next up we have the case of a 16-year-old",
    "footage 1LolaFileAbcdef",
    "Lola reported his own parents missing",
  ]);
  expect((parsed.blocks[1] as Narration).text).toBe("Eventually, she was sentenced to 15 years.\n\nIn a similar case, another young man reported the crime himself…");
});

test("excerpts_of_dvd_and_webm_files_are_mp4", () => {
  expect(excerptExtension("VOB")).toBe("mp4");
  expect(excerptExtension("webm")).toBe("mp4");
  expect(excerptExtension("mov")).toBe("mov");
  expect(excerptExtension("mp4")).toBe("mp4");
});
