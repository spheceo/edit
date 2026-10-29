// The producer's own edits to a footage script, each a saved revision and a
// version: the timeline, a respelled word, the heading, a restored version, a
// proposed rewrite accepted or declined, and starting over.

import type { Clip, Script } from "@edit/types/writer";

import * as chat from "./chat.ts";
import { settle } from "./revise.ts";
import { isCutIn } from "./blocks.ts";
import * as store from "./store.ts";
import * as versions from "./versions.ts";

/** Timeline items stay in the order given (a hook plays footage from anywhere); refused when one is malformed. */
export function checkClips(clips: Clip[], durationMs: number): Clip[] {
  if (clips.length > 500) throw new Error("Too many clips.");
  const seen = new Set<string>();
  for (const clip of clips) {
    const badId = clip.id === "" || clip.id.length > 80 || /[\s\p{Cc}]/u.test(clip.id) || seen.has(clip.id);
    seen.add(clip.id);
    const badRange = !(clip.endMs > clip.startMs) || (!isCutIn(clip) && durationMs > 0 && clip.endMs > durationMs);
    if (badId || badRange) throw new Error("A clip has invalid boundaries.");
    const notes = clip.notes ?? [];
    const badNote = (note: NonNullable<Clip["notes"]>[number]) =>
      note.text.trim() === "" ||
      [...note.text].length > 2_000 ||
      note.id === "" ||
      note.id.length > 80 ||
      (note.anchor !== undefined && (note.anchor.start >= note.anchor.end || note.anchor.end > 12_000 || note.anchor.quote === "" || [...note.anchor.quote].length > 6_000));
    if (notes.length > 50 || notes.some(badNote)) throw new Error("A timestamp holds up to 50 comments of up to 2,000 characters.");
    if (clip.kind === undefined) {
      if (clip.narration !== undefined || clip.narrationRole !== undefined || clip.reuse !== undefined) throw new Error("Only a cut-in holds narration.");
    } else if (clip.kind === "cut-in") {
      if ([...(clip.narration ?? "")].length > 6_000) throw new Error("A cut-in holds at most 6,000 characters.");
      if (clip.narrationRole !== undefined && !["intro", "bridge", "conclusion"].includes(clip.narrationRole)) throw new Error("Unknown narration role.");
    } else throw new Error("Unknown timeline item.");
  }
  return clips;
}

const changed = "This script changed. Reload it.";

/** A save of the producer's: refused when the script moved on since `revision`; recorded as a version. */
function edit(data: string, id: string, revision: number | null, change: (script: Script) => void, author: versions.Author = "you"): Script {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  if (revision !== null && script.revision !== revision) throw new Error(changed);
  const before = structuredClone(script);
  change(script);
  script.revision++;
  script.updatedAt = Date.now();
  store.write(dir, script);
  versions.keep(dir, author, before, script);
  return script;
}

export function saveClips(data: string, id: string, revision: number, clips: Clip[]): Script {
  return edit(data, id, revision, (script) => {
    script.clips = checkClips(clips, script.durationMs);
    script.proposals = settle(script.clips, script.proposals ?? []);
  });
}

/** Respells a transcript word, or puts it back with an empty text; its timing never changes. */
export function correctWord(data: string, id: string, revision: number, word: string, text: string): Script {
  return edit(data, id, revision, (script) => {
    const found = script.words.find((item) => item.id === word);
    if (found === undefined) throw new Error("That word is not in the transcript.");
    const given = text.trim();
    if ([...given].length > 200) throw new Error("Keep the word under 200 characters.");
    const corrections = { ...(script.corrections ?? {}) };
    if (given === "" || given === found.text) delete corrections[word];
    else corrections[word] = given;
    script.corrections = corrections;
  });
}

/** The producer's own heading in place of the generated one; empty puts the generated one back. */
export function setHeading(data: string, id: string, revision: number, heading: string): Script {
  return edit(data, id, revision, (script) => {
    const given = heading.trim();
    if ([...given].length > 300 || /\p{Cc}/u.test(given)) throw new Error("Keep the heading to one line of up to 300 characters.");
    if (given === "") delete script.heading;
    else script.heading = given;
  });
}

export function rename(data: string, id: string, title: string): Script {
  const given = title.trim();
  if (given === "" || [...given].length > 180 || /\p{Cc}/u.test(given)) throw new Error("Give it a title of up to 180 characters.");
  // The title heads the script, so its Google Doc is out of date now.
  return store.update(store.scriptDir(data, id), (script) => {
    script.title = given;
  });
}

/** Makes an earlier version the script again; the restore is a version too. Respellings of words no longer there are left out. */
export function restoreVersion(data: string, id: string, revision: number, version: string): Script {
  const dir = store.scriptDir(data, id);
  const script = store.read(dir);
  if (script.revision !== revision) throw new Error(changed);
  const snapshot = versions.read(dir, version);
  const at = versions.list(dir).find((item) => item.id === version)?.at ?? 0;
  const before = structuredClone(script);
  script.clips = checkClips(snapshot.clips, script.durationMs);
  const words = new Set(script.words.map((word) => word.id));
  script.corrections = Object.fromEntries(Object.entries(snapshot.corrections).filter(([word]) => words.has(word)));
  if (snapshot.heading) script.heading = snapshot.heading;
  else delete script.heading;
  script.proposals = settle(script.clips, script.proposals ?? []);
  script.revision++;
  script.updatedAt = Date.now();
  store.write(dir, script);
  versions.keepRestored(dir, before, script, at);
  return script;
}

/** Accepts or declines the chosen proposals together, against the revision reviewed. */
export function resolveProposals(data: string, id: string, revision: number, chosen: string[], accept: boolean): Script {
  return edit(data, id, revision, (script) => {
    const waiting = script.proposals ?? [];
    if (chosen.length === 0 || chosen.some((one) => !waiting.some((item) => item.id === one))) throw new Error("These suggested changes are no longer waiting for review.");
    if (accept) {
      for (const proposal of waiting.filter((item) => chosen.includes(item.id))) {
        const cue = script.clips.find((clip) => clip.id === proposal.cutIn && isCutIn(clip));
        if (cue === undefined) throw new Error("A proposed paragraph is no longer in the script.");
        if ((cue.narration ?? "") !== proposal.before) throw new Error("A proposed paragraph changed. Review it again before accepting.");
        cue.narration = proposal.after;
      }
      script.clips = checkClips(script.clips, script.durationMs);
    }
    script.proposals = waiting.filter((item) => !chosen.includes(item.id));
  });
}

/**
 * The producer's answer to Claude asking to start over: accepted, the built
 * script goes (every clip and cut-in, or a commentary's draft); the transcript,
 * speakers, sources and research stay, and Versions keeps the script as it was.
 */
export function resetScript(data: string, id: string, accept: boolean): Script {
  const dir = store.scriptDir(data, id);
  chat.settleReset(dir, accept);
  if (!accept) return store.read(dir);
  return edit(data, id, null, (script) => {
    if (script.commentary) delete script.commentary.draft;
    else {
      script.clips = [];
      script.proposals = [];
    }
  });
}
