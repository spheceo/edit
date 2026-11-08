import { expect, test } from "bun:test";
import * as fs from "node:fs";

import type { App } from "../src/app.ts";
import type { Project } from "../src/model.ts";
import { linksIn, pageKey, unusedNoteLinks } from "../src/note_links.ts";
import { newProject } from "../src/project.ts";
import { scratch } from "./helpers/home.ts";

test("a note's links are read as the sources they name", () => {
  expect(linksIn("B-roll: Akihabara, April 2005 https://www.youtube.com/watch?v=fyBRZzYWpBA&t=8 (0:08-0:20, skip the title card).")).toEqual([
    { kind: "youtube", id: "fyBRZzYWpBA", start: 8, url: "https://www.youtube.com/watch?v=fyBRZzYWpBA&t=8" },
  ]);
  expect(linksIn("Animation 4: back on the blog post screenshot: https://drive.google.com/file/d/1Fk0yZZ-8j97jI9PoeEbdOtmJ2iO29nYJ/view")[0]).toMatchObject({ kind: "drive", id: "1Fk0yZZ-8j97jI9PoeEbdOtmJ2iO29nYJ" });
  // An archived page is the page; an X post is its id, whatever handle is written.
  expect(pageKey("https://web.archive.org/web/*/youtube.com/@Ryu-Kuriyama")).toBe("youtube.com/@Ryu-Kuriyama");
  expect(pageKey("https://web.archive.org/web/20251201000000/https://www.youtube.com/@Ryu-Kuriyama/")).toBe("youtube.com/@Ryu-Kuriyama");
  expect(pageKey("https://twitter.com/someone/status/1977247191426384356?s=20")).toBe(pageKey("https://x.com/1309WithJesus/status/1977247191426384356"));
});

test("a directing note's link with no clip showing its source is flagged; a bare source link isn't", () => {
  const { dir, cleanup } = scratch("note-links");
  try {
    const app = { store: { home: dir } } as unknown as App;
    const p: Project = newProject("p1", "horror", { width: 1920, height: 1080, fps: 30 }, "horror");
    p.media.push({ id: "m1", name: "akihabara.mp4", path: "/m1.mp4", kind: "video", duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true });
    p.script = {
      source: "https://docs.google.com/document/d/x/edit",
      blocks: [
        {
          kind: "narration",
          text: "But in that world, everyone understands it's a performance.",
          notes: [
            "B-roll: Akihabara, April 2005 https://www.youtube.com/watch?v=fyBRZzYWpBA&t=8 (0:08-0:20).",
            "Animation 4: LA Weekly article, highlight \"He knew today was the day\": https://www.laweekly.com/herbert-wong",
            "https://laist.com/news/police-public-safety/struggling-porn-actor",
          ],
        },
      ],
    };
    const research = `${dir}/research/p1`;
    fs.mkdirSync(research, { recursive: true });
    fs.writeFileSync(`${research}/broll.json`, JSON.stringify({ "range:fyBRZzYWpBA:8:20": { url: "https://www.youtube.com/watch?v=fyBRZzYWpBA", media: "m1", start: 8, end: 20 } }));
    // Brought in but not placed; the article never captured; the bare link (the writer's source) left alone.
    let flags = unusedNoteLinks(app, p);
    expect(flags.map((flag) => [flag.link, flag.state])).toEqual([
      ["https://www.youtube.com/watch?v=fyBRZzYWpBA&t=8", "brought in, not on the timeline"],
      ["https://www.laweekly.com/herbert-wong", "not brought in"],
    ]);
    // Placed: the range is done.
    p.clips.push({ id: "c1", type: "video", track: p.tracks[0]!.id, media: "m1", start: 0, duration: 90, source_in: 0 } as never);
    flags = unusedNoteLinks(app, p);
    expect(flags.map((flag) => flag.link)).toEqual(["https://www.laweekly.com/herbert-wong"]);
  } finally {
    cleanup();
  }
});
