import { expect, test } from "bun:test";

import { assetFps, comments, placed, printUrl, seconds } from "../src/review.ts";
import { clip, project } from "./helpers/model.ts";

// Frame.io's print view as its scripts leave it (cut down): the author's
// initial and name, the date, #number, the timecode and the words; a reply
// has no number or timecode.
const PAGE = `<html><head><script>self.__next_f.push([1,"{\\"fps\\":30,\\"duration\\":1901}"])</script></head><body>
<div>Sorted by timecode</div>
<div><span>J</span><span>JJ</span><span>10/17/26 at 9:13 PM</span><span><span>#</span>1</span><span data-testid="comment-prefix-timestamp">00:00:01:07</span><span>remove the first 1 sec - this is where we want to start</span></div>
<div><span>J</span><span>JJ</span><span>10/17/26 at 9:14 PM</span><span><span>#</span>2</span><span>00:00:05:18</span><span>the intro clips are not good enough</span></div>
<div><span>J</span><span>JJ</span><span>10/17/26 at 9:23 PM</span><span>2 new intro clips in main intro:</span><span>https://docs.google.com/document/d/x/edit</span></div>
<div><span>J</span><span>JJ</span><span>10/17/26 at 9:32 PM</span><span><span>#</span>21</span><span>00:00:12:10</span><span>herself*</span><span>Can we regenerate the VO here please?</span></div>
<div>To pick up a draggable item, press the space bar.</div></body></html>`;

test("a_frameio_review_is_read_into_comments_and_replies", () => {
  const found = comments(PAGE);
  expect(found.map((one) => [one.number, one.timecode, one.text])).toEqual([
    [1, "00:00:01:07", "remove the first 1 sec - this is where we want to start"],
    [2, "00:00:05:18", "the intro clips are not good enough"],
    [21, "00:00:12:10", "herself*\nCan we regenerate the VO here please?"],
  ]);
  expect(found[1]!.replies.map((one) => [one.author, one.date, one.text])).toEqual([
    ["JJ", "10/17/26 at 9:23 PM", "2 new intro clips in main intro:\nhttps://docs.google.com/document/d/x/edit"],
  ]);
  expect(assetFps(PAGE)).toBe(30);
  expect(seconds("00:01:02:15", 30)).toBe(62.5);
});

test("each_comment_lands_on_the_timeline_with_whats_there", () => {
  const p = project("review");
  p.clips.push(clip({ id: "c1", type: "solid", track: "v1", start: 0, duration: 300, name: "Card" }));
  const [first] = placed(p, comments(PAGE), 30) as Record<string, unknown>[];
  expect(first).toEqual({
    author: "JJ",
    text: "remove the first 1 sec - this is where we want to start",
    number: 1,
    timecode: "00:00:01:07",
    time: 1.23,
    frame: 37,
    on_timeline: ["c1 v1 0–300: solid Card"],
  });
});

test("any_share_link_of_one_video_reads_its_print_view", () => {
  const share = "5e79ec78-86c6-4daf-a8c8-a3ba41294bcc";
  const asset = "56e0673d-f441-4963-95cb-cd5c9ed47afe";
  const print = `https://next.frame.io/share/${share}/print/comments/${asset}`;
  expect(printUrl(`https://next.frame.io/share/${share}/view/${asset}`)).toBe(print);
  expect(printUrl(print)).toBe(print);
  expect(() => printUrl(`https://next.frame.io/share/${share}`)).toThrow("one video's comments");
  expect(() => printUrl("https://example.com/")).toThrow("Frame.io share link");
});
