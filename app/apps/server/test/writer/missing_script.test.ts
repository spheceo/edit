// A deleted script is answered as gone (404), so the page's preview reads stop asking (JJ's Mac, Nov 3:
// a 500 for one deleted script, retried 6,632 times in five minutes).

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { ApiError } from "../../src/http/errors.ts";
import { readFor } from "../../src/writer/routes.ts";

test("a script that isn't here is a 404", () => {
  const data = fs.mkdtempSync(join(os.tmpdir(), "edit-missing-"));
  try {
    let thrown: unknown;
    try {
      readFor(data, "3e4f7694-82ce-4fb0-94b7-19cb5ae0fa22");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(404);
    expect((thrown as ApiError).message).toBe("That script is missing.");
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});
