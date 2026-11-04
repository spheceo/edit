import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import { inlinePictures, pictureFile } from "../src/chat_pictures.ts";

test("an answer's pictures get addresses the page can load; one that can't be placed is named, not broken", async () => {
  const text = "Here it is:\n\n![the hallway](/tmp/run/abc123.png)\n\nand ![again](/tmp/run/abc123.png \"title\") and ![the porch](xyz) and ![gone](/nowhere/x.png)";
  const asked: string[] = [];
  const out = await inlinePictures(text, async (source) => {
    asked.push(source);
    return source === "/tmp/run/abc123.png" ? "/api/thumbnails/t/images/abc123" : source === "xyz" ? "/api/thumbnails/t/images/xyz" : null;
  });
  expect(asked).toEqual(["/tmp/run/abc123.png", "xyz", "/nowhere/x.png"]);
  expect(out).toBe("Here it is:\n\n![the hallway](/api/thumbnails/t/images/abc123)\n\nand ![again](/api/thumbnails/t/images/abc123) and ![the porch](/api/thumbnails/t/images/xyz) and ![gone](unavailable:x.png)");
  expect(await inlinePictures("no pictures here", async () => "never")).toBe("no pictures here");
});

test("a picture file is only one inside the agent's own folders, and a picture", () => {
  const root = fs.mkdtempSync(`${os.tmpdir()}/pictures-`);
  fs.writeFileSync(`${root}/look.png`, "png");
  fs.writeFileSync(`${root}/notes.txt`, "text");
  expect(pictureFile(`${root}/look.png`, [root])).toBe(fs.realpathSync(`${root}/look.png`));
  expect(pictureFile(`${root}/notes.txt`, [root])).toBeNull();
  expect(pictureFile(`${root}/look.png`, ["/somewhere/else"])).toBeNull();
  expect(pictureFile(`${root}/../${root.split("/").pop()}/look.png`, ["/somewhere/else"])).toBeNull();
  expect(pictureFile("look.png", [root])).toBeNull();
  fs.rmSync(root, { recursive: true, force: true });
});
