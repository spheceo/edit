// The person's pick in the chats' model menu (`@edit/types/models`): the
// model a built edit's, script's or idea's revisions run on, and how hard
// every chat thinks. One for every chat on this computer, kept in
// `<home>/models.json`; Opus 5.5 at medium until they pick. A Bodycam HQ chat's
// pick (`hq_model`, `hq_effort`: Fable 5.2 at high until they pick) is kept
// beside it, and neither changes the other.

import * as fs from "node:fs";

import { DEFAULT_CHOICE, readChoice, type ModelChoice } from "@edit/types/models";

import { writeAtomic } from "./files.ts";
import { join } from "./paths.ts";

const FILE = "models.json";

let home: string | null = null;
let choice: ModelChoice | null = null;

/** Where the choice is kept (Edit's data folder); the default until it's given. */
export function use(dir: string): void {
  if (home === dir) return;
  home = dir;
  choice = null;
}

/** The current pick: what was saved, the default where nothing (or nothing readable) was. */
export function current(): ModelChoice {
  if (home === null) return DEFAULT_CHOICE;
  if (choice === null) {
    try {
      choice = readChoice(JSON.parse(fs.readFileSync(join(home, FILE), "utf8")));
    } catch {
      choice = DEFAULT_CHOICE;
    }
  }
  return choice;
}

/** Saves a pick; anything unknown in it is taken as the default. */
export function save(given: unknown): ModelChoice {
  const next = readChoice(given);
  if (home !== null) {
    fs.mkdirSync(home, { recursive: true });
    writeAtomic(join(home, FILE), `${JSON.stringify(next)}\n`);
  }
  choice = next;
  return next;
}
