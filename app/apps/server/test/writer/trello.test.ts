import { expect, test } from "bun:test";

import { compilationLines } from "../../src/writer/imports.ts";
import { cardId, cardLinks, caseLinks, compilationLinks, line, linksIn, parse, pastedCard } from "../../src/writer/trello.ts";

test("numbered cases and the canonical round trip keep shared recordings and time hints", () => {
  const found = compilationLinks("Case 1: [A](https://youtu.be/aaaaaaaaaaa?t=10)\nCase 2: https://youtu.be/aaaaaaaaaaa?t=120\nCase 3: https://youtu.be/aaaaaaaaaaa?t=120");
  expect(found.length).toBe(3);
  const [urls, reuses] = compilationLines(found.map(line));
  expect(urls).toEqual(found.map((one) => one.url));
  expect(reuses).toEqual([]);
});

test("attachment cases fill their numbered slot, and references never become cases", () => {
  const desc = "Case 1: https://youtu.be/aaaaaaaaaaa\nCase 3 (reuse): https://docs.google.com/document/d/1docdocdocdocdoc/edit\nFootage: https://youtu.be/ccccccccccc";
  const more = ["Case 2 <https://youtu.be/aaaaaaaaaaa>", "Case 3 (reuse) <https://docs.google.com/document/d/1docdocdocdocdoc/edit>", "Thumbnail <https://youtu.be/ddddddddddd>", "https://youtu.be/ddddddddddd"];
  expect(cardLinks(desc, more).map(line)).toEqual(["https://youtu.be/aaaaaaaaaaa", "https://youtu.be/aaaaaaaaaaa", "REUSE https://docs.google.com/document/d/1docdocdocdocdoc/edit"]);
  expect(compilationLinks(desc).length).toBe(2);
  expect(compilationLinks("Case 1:\nFootage: https://youtu.be/aaaaaaaaaaa\nCase 2: https://youtu.be/bbbbbbbbbbb").length).toBe(2);
  const duplicate = cardLinks("Case 1: https://youtu.be/aaaaaaaaaaa", ["Case 1 (reuse) <https://youtu.be/aaaaaaaaaaa>"]);
  expect(duplicate.length).toBe(1);
  expect(duplicate[0]!.reuse).toBe(true);
});

test("a Drive folder is kept from description labels and attachments", () => {
  const desc = "Case 1: [751) Teacher - Google Drive](https://drive.google.com/drive/folders/1folderfolderfolder)\nCase 2: [Special Ed Teacher](https://youtu.be/aaaaaaaaaaa)\nCase 3 (reuse): [Interrogation: Principal](https://docs.google.com/document/d/1docdocdocdocdoc/edit)\nCase 4: [Substitute Teacher](https://youtu.be/bbbbbbbbbbb)";
  const card = { name: "Predator Teacher", desc, attachments: ["https://drive.google.com/drive/folders/1folderfolderfolder?usp=sharing", "https://drive.google.com/file/d/1additionalvideo/view"], attachmentLabels: ["Case 5 (reuse) <https://drive.google.com/file/d/1additionalvideo/view>"] };
  const list = parse(card, true, [])!;
  const pasted = pastedCard(card, "card1234", "https://trello.com/c/card1234", []);
  expect(list.lines).toEqual(pasted.lines);
  expect(pasted.kind).toBe("compilation");
  expect(cardLinks(desc, ["Case 5 (reuse) <https://drive.google.com/file/d/1additionalvideo/view>"]).length).toBe(5);
  expect([list.lines.length, list.videos, list.reuses]).toEqual([5, 3, 2]);
  expect(list.lines[0]).toContain("folders/");
  expect(list.lines[2]!.startsWith("REUSE https://docs")).toBe(true);
  expect(list.lines[4]!.startsWith("REUSE https://drive")).toBe(true);
});

test("an inline reuse doesn't leak into the next numbered case", () => {
  const links = linksIn("Reused:\nCase 1 (reuse): https://youtu.be/aaaaaaaaaaa\nCase 2: https://youtu.be/bbbbbbbbbbb\nCase 3:\nhttps://drive.google.com/drive/folders/1folderfolderfolder");
  expect(links.map((one) => one.reuse)).toEqual([true, false, false]);
});

test("card ids from links", () => {
  expect(cardId("https://trello.com/c/fCTopHe2/999-cop-reports-dead-body")).toBe("fCTopHe2");
  expect(cardId("trello.com/c/fCTopHe2")).toBe("fCTopHe2");
  expect(cardId("https://trello.com/b/abc/board")).toBeNull();
});

test("a compilation card reads as Repack reads it", () => {
  const desc = "Thumb:\nsomething https://www.youtube.com/watch?v=thumb0000a\n\nCase 1:\nhttps://www.youtube.com/watch?v=aaaaaaaaaaa\ncase 2 - Reuse:\n\nhttps://youtu.be/bbbbbbbbbbb?t=40\n**CASE #3**\n[https://drive.google.com/file/d/1abcdefghijklmnop/view](https://drive.google.com/file/d/1abcdefghijklmnop/view \"‌\")\nCase 4: the old bodycam script https://docs.google.com/document/d/1docdocdocdocdocdoc/edit\n## Notes\nhttps://www.youtube.com/watch?v=notes000000";
  expect(compilationLinks(desc)).toEqual([
    { url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", reuse: false, earlier: null },
    { url: "https://youtu.be/bbbbbbbbbbb?t=40", reuse: true, earlier: null },
    { url: "https://drive.google.com/file/d/1abcdefghijklmnop/view", reuse: false, earlier: null },
    { url: "https://docs.google.com/document/d/1docdocdocdocdocdoc/edit", reuse: true, earlier: null },
  ]);
});

test("a reused heading covers its cases and their earlier cards", () => {
  // Card 996, as Trello gives it: three reused cases, each with the earlier compilation it was in.
  const desc = "Cases:\n\n‌\n\nOfficers Traumatized By What These Parents Did To Their Kids:\n\n[Parents Keep 2y/o Trapped](https://www.youtube.com/watch?v=UxAuydwwtbQ \"‌\")\n\n[Police Rescue Child](https://www.youtube.com/watch?v=uJlVqE3UWjY \"‌\")\n\n‌\n\nReused:\n\n[Police RESCUE 5 Kids](https://www.youtube.com/watch?v=5cN67V8lkeE \"‌\")\n\n[https://trello.com/c/U0FrQAUk](https://trello.com/c/U0FrQAUk \"smartCard-inline\")    (Case 4)\n\n‌\n\n[DCF Steps In](https://www.youtube.com/watch?v=pWoE9YSIxMw \"‌\")\n\n[https://trello.com/c/FsehmKPF](https://trello.com/c/FsehmKPF \"smartCard-inline\")    (Case 2)\n";
  expect(compilationLinks(desc).map(line)).toEqual([
    "https://www.youtube.com/watch?v=UxAuydwwtbQ",
    "https://www.youtube.com/watch?v=uJlVqE3UWjY",
    "REUSE https://www.youtube.com/watch?v=5cN67V8lkeE https://trello.com/c/U0FrQAUk case 4",
    "REUSE https://www.youtube.com/watch?v=pWoE9YSIxMw https://trello.com/c/FsehmKPF case 2",
  ]);
  // Card 938's way: the earlier card on the reused video's own line.
  const other = "Cases:\n\n1. [**A**](https://www.youtube.com/watch?v=J572aDTcZdE \"‌\")\n2. [**B**](https://www.youtube.com/watch?v=pWoE9YSIxMw \"‌\")\n\n**Reuse:**\n\n1. [**C**](https://www.youtube.com/watch?v=U0MFeMW3R8s \"‌\") [https://trello.com/c/bAmtOq5N/615-when-good-cops](https://trello.com/c/bAmtOq5N/615-when-good-cops \"smartCard-inline\")  **case 2**";
  const lines = compilationLinks(other).map(line);
  expect(lines.at(-1)).toBe("REUSE https://www.youtube.com/watch?v=U0MFeMW3R8s https://trello.com/c/bAmtOq5N case 2");
  expect(lines.length).toBe(3);
});

test("a card without cases gives every link", () => {
  expect(compilationLinks("https://www.youtube.com/watch?v=aaaaaaaaaaa\nREUSE https://www.youtube.com/watch?v=bbbbbbbbbbb").map((one) => one.reuse)).toEqual([false, true]);
});

test("a case card reads as Repack reads it", () => {
  const desc = "Footage: https://drive.google.com/file/d/1filefilefilefile/view\nFolder https://drive.google.com/drive/folders/1folderfolderfolder?usp=sharing\nhttps://www.youtube.com/watch?v=x https://www.wsbtv.com/news/local/story-123/.";
  expect(caseLinks(desc, [])).toEqual(["https://drive.google.com/drive/folders/1folderfolderfolder", "https://www.wsbtv.com/news/local/story-123/"]);
});

test("mixed labelled sources keep the case order and reuse associations", () => {
  const lines = [
    "Case 1: [751) Teacher - Google Drive](https://drive.google.com/drive/folders/1folderfolderfolder)",
    "Case 2: [Special Ed Teacher](https://youtu.be/aaaaaaaaaaa)",
    "Case 3 (reuse): [Interrogation: Principal](https://docs.google.com/document/d/1docdocdocdocdoc/edit)",
    "Case 4: [Substitute Teacher](https://youtu.be/bbbbbbbbbbb)",
    "Case 5: https://youtu.be/ccccccccccc [reuse]",
  ];
  const [urls, reused] = compilationLines(lines);
  expect(urls).toEqual(["https://drive.google.com/drive/folders/1folderfolderfolder", "https://youtu.be/aaaaaaaaaaa", "https://youtu.be/bbbbbbbbbbb"]);
  expect(reused.map((one) => one.after)).toEqual([2, 3]);
  expect(reused[0]!.url).toContain("docs.google.com");
  const [again, reuses] = compilationLines(linksIn(lines.join("\n")).map(line));
  expect(again).toEqual(urls);
  expect(reuses).toEqual(reused);
});

test("a new case and a script are enough, and invalid sources aren't dropped", () => {
  const given = ["https://youtu.be/aaaaaaaaaaa https://docs.google.com/document/d/1docdocdocdocdoc/edit"];
  const [urls, reuses] = compilationLines(given);
  expect([urls.length, reuses.length, reuses[0]!.after]).toEqual([1, 1, 1]);
  expect(() => compilationLines([given[0]!, "https://example.com/wrong"])).toThrow();
});
