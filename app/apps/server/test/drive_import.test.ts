import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import { folderId, removeStagedCopy } from "../src/drive_import.ts";

test("folderId reads a Drive folder link", () => {
  expect(folderId("https://drive.google.com/drive/folders/1yg-M2MtATPMklbr1buzd0mgR9sNzsgOZ")).toBe("1yg-M2MtATPMklbr1buzd0mgR9sNzsgOZ");
  expect(folderId("https://example.com/folders/1yg-M2MtATPMklbr1buzd0mgR9sNzsgOZ")).toBeNull();
});

test("removeStagedCopy deletes only Edit's staging copies under the uploads root", () => {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/edit-stage-`);
  try {
    const root = `${dir}/media/p1`;
    const staged = `${root}/drive/abc/file.mp4`;
    fs.mkdirSync(`${root}/drive/abc`, { recursive: true });
    fs.writeFileSync(staged, "x");
    const outside = `${dir}/Movies/file.mp4`;
    fs.mkdirSync(`${dir}/Movies`, { recursive: true });
    fs.writeFileSync(outside, "x");
    expect(removeStagedCopy(outside, root)).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
    expect(removeStagedCopy(staged, root)).toBe(true);
    expect(fs.existsSync(staged)).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
