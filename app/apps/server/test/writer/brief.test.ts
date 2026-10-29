import { expect, test } from "bun:test";

import { articlesOf, parse, partNumber, videosOf } from "../../src/writer/brief.ts";

const COURT = `Cop Used 15-Year-Old In Sadistic S*x Ring, Then She's Found Dead
Surveillance Footage:

https://www.youtube.com/watch?v=iIFlj7gV5Tc

More on the text messages etc:

https://www.youtube.com/watch?v=swTrrS-LupM&pp=ygUPTWF0dGhldyBGYXJ3ZWxs


Part 1:

https://www.youtube.com/watch?v=_OUHOqTMAb4&list=PLLq-6my_qlf8OBr5VKLKk0s7Z1cj4z1Yf&index=2

Part 2:

https://www.youtube.com/watch?v=wm_US4mlpoM&list=PLLq-6my_qlf8OBr5VKLKk0s7Z1cj4z1Yf&index=2

Part 3:

https://www.youtube.com/watch?v=X9S5DhhmvYg&list=PLLq-6my_qlf8OBr5VKLKk0s7Z1cj4z1Yf&index=3
`;

test("labels each link by the line above it", () => {
  const brief = parse(COURT);
  expect(brief.title).toBe("Cop Used 15-Year-Old In Sadistic S*x Ring, Then She's Found Dead");
  expect(brief.notes).toBe("");
  expect(brief.links.map((link) => [link.role, link.part ?? null])).toEqual([["supporting", null], ["background", null], ["hearing", 1], ["hearing", 2], ["hearing", 3]]);
  expect(brief.links[0]!.label).toBe("Surveillance Footage");
  expect(brief.links[1]!.url).toBe("https://www.youtube.com/watch?v=swTrrS-LupM");
  expect(brief.links[2]!.url).toBe("https://www.youtube.com/watch?v=_OUHOqTMAb4");
  // The hearing joins first, in its order; then the rest.
  expect(videosOf(brief).map((link) => link.label)).toEqual(["Part 1", "Part 2", "Part 3", "Surveillance Footage", "More on the text messages etc"]);
});

test("prose is the producer's notes", () => {
  const brief = parse("CORRUPT Jail Guard Caught Smuggling Dr*gs Into Jail — Judge DESTROYS Her\nContext, really great case:\n\nIn May 2021, Fulton County detention officer Jadon Young was found unresponsive in a locked jail tower. She was sentenced to 40 years.\n\nhttps://www.youtube.com/watch?v=48RFLHRSwiA\n");
  expect(brief.title).toBe("CORRUPT Jail Guard Caught Smuggling Dr*gs Into Jail — Judge DESTROYS Her");
  expect(brief.notes.startsWith("In May 2021, Fulton County")).toBe(true);
  expect(brief.links).toHaveLength(1);
  // Its heading is the context line, but a brief's only video is the case.
  expect(brief.links[0]!.role).toBe("hearing");
  expect(videosOf(brief)).toHaveLength(1);
});

test("words beside a link name it and pages are articles", () => {
  const brief = parse("Some case\nBodycam - https://youtu.be/abcdefghijk\nhttps://www.youtube.com/watch?v=ABCDEFGHIJK (sentencing)\nhttps://news.example.com/story.html\nDay 2: https://www.youtube.com/watch?v=BBBBBBBBBBB");
  expect(brief.links.map((link) => [link.role, link.part ?? null])).toEqual([["supporting", null], ["hearing", null], ["article", null], ["hearing", 2]]);
  expect(brief.links[0]!.label).toBe("Bodycam");
  expect(articlesOf(brief)).toHaveLength(1);
});

test("unlabelled videos are the hearing in order", () => {
  const brief = parse("Title here\nhttps://www.youtube.com/watch?v=AAAAAAAAAAA\nhttps://www.youtube.com/watch?v=BBBBBBBBBBB");
  expect(brief.links.map((link) => link.part)).toEqual([1, 2]);
  expect(partNumber("pt. three")).toBe(3);
  expect(partNumber("2 of 6")).toBe(2);
});
