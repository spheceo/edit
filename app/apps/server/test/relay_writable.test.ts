// Every place Edit writes in R2 is one the relay lets the team write (apps/relay/src/authz.ts WRITABLE): an
// admin may write anywhere, so a prefix missing there fails only for a teammate who isn't one (Nov 4: pieced
// proxies, chats, exports, scrub strips and research were each refused for them).
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { WRITABLE } from "../../relay/src/authz.ts";

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(full) : entry.name.endsWith(".ts") ? [full] : [];
  });
}

test("every edit/ prefix the server names is one the relay lets anyone signed in write", () => {
  const named = new Set<string>();
  for (const file of sources(path.join(import.meta.dir, "../src"))) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(/[`"'](edit\/[a-z_-]+\/)/g)) named.add(match[1]!);
  }
  expect(named.size).toBeGreaterThan(10);
  expect([...named].filter((prefix) => !WRITABLE.some((writable) => prefix.startsWith(writable))).sort()).toEqual([]);
});
