// A big file from Google Drive in parts at once (Nov 4: one connection from
// Drive got 12-16 MB/s here, four 44 MB/s, eight 70 MB/s; an 83-minute
// recording's 5 GB took 5 min 38 s one at a time). Each part is a range of
// the file, written where it belongs and checked to start there; the parts
// done are noted beside it (`<dest>.parts`), so a download stopped by a
// dropped connection, a stall or a restart carries on with the parts left.
// A part that fails is asked again (a few times, waiting longer each time).

import * as fs from "node:fs";

import * as diag from "./diag.ts";
import { writeAtomic } from "./files.ts";

export const ranged = {
  /** Files this big or more come in parts; under it, one connection does (a part's start-up would cost more than it saves). */
  from: 64 << 20,
  /** Bytes a part asks for. */
  part: 32 << 20,
  /** Parts asked for at once. */
  parallel: 8,
  /** A part that gets nothing for this long is dropped and asked again. */
  stallMs: 60_000,
  /** Tries per part. */
  tries: 5,
  /** Waits between a part's tries (tests make them nothing). */
  sleep: (ms: number) => Bun.sleep(ms),
};

interface Journal {
  size: number;
  part: number;
  done: number[];
}

const journalOf = (dest: string) => `${dest}.parts`;

function readJournal(dest: string, size: number): Journal | null {
  try {
    const value = JSON.parse(fs.readFileSync(journalOf(dest), "utf8")) as Journal;
    return value.size === size && value.part === ranged.part && Array.isArray(value.done) ? value : null;
  } catch {
    return null;
  }
}

/** Whether a download of `dest` in parts was begun and not finished (its parts noted beside it). */
export function partlyDone(dest: string): boolean {
  return fs.existsSync(journalOf(dest));
}

/** "bytes 100-199/1000" → 100; null when it doesn't say. */
function rangeStart(header: string | null): number | null {
  const match = /^bytes (\d+)-\d+\/(?:\d+|\*)$/.exec(header?.trim() ?? "");
  return match === null ? null : Number(match[1]);
}

/** A part that failed in a way asking again can't fix (Drive refused it). */
export class Refused extends Error {}

/**
 * Downloads `size` bytes from `url` to `dest` in parts at once, carrying on
 * from the parts a stopped download noted. `fetch` makes each request (with
 * its sign-in); `onBytes` gets the bytes down so far. Throws when a part
 * fails after its tries (what's done stays noted, for the next try).
 */
export async function download(options: {
  url: string;
  size: number;
  dest: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  onBytes?: (bytes: number) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { url, size, dest } = options;
  const count = Math.ceil(size / ranged.part);
  // Parts noted for a file that's gone (removed as damaged) are no parts.
  const journal = (fs.existsSync(dest) ? readJournal(dest, size) : null) ?? { size, part: ranged.part, done: [] };
  if (journal.done.length === 0) fs.rmSync(dest, { force: true });
  const done = new Set(journal.done);
  const fd = fs.openSync(dest, fs.existsSync(dest) ? "r+" : "w");
  const lengthOf = (n: number) => Math.min(ranged.part, size - n * ranged.part);
  let down = [...done].reduce((sum, n) => sum + lengthOf(n), 0);
  const flowing = new Map<number, number>();
  const report = () => options.onBytes?.(down + [...flowing.values()].reduce((sum, bytes) => sum + bytes, 0));
  report();
  const left = Array.from({ length: count }, (_, n) => n).filter((n) => !done.has(n));
  let failure: unknown = null;

  const fetchPart = async (n: number): Promise<void> => {
    const from = n * ranged.part;
    const to = from + lengthOf(n) - 1;
    const stall = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, stall.signal]) : stall.signal;
    let idle = setTimeout(() => stall.abort(), ranged.stallMs);
    let at = from;
    try {
      const answer = await options.fetch(url, { headers: { range: `bytes=${from}-${to}` }, signal });
      if ([401, 403, 404].includes(answer.status)) throw new Refused(`Google Drive answered ${answer.status}`);
      if (answer.status !== 206 || answer.body === null) throw new Error(`Google Drive answered ${answer.status} to a part`);
      // A part from anywhere but where it was asked would land in the wrong place (Nov 1's damaged 5.3 GB copy).
      if (rangeStart(answer.headers.get("content-range")) !== from) throw new Error(`Google Drive answered part ${n} from ${answer.headers.get("content-range") ?? "nowhere said"}`);
      for await (const chunk of answer.body) {
        clearTimeout(idle);
        idle = setTimeout(() => stall.abort(), ranged.stallMs);
        if (at + chunk.length > to + 1) throw new Error(`part ${n} came down longer than asked`);
        fs.writeSync(fd, chunk, 0, chunk.length, at);
        at += chunk.length;
        flowing.set(n, at - from);
        report();
      }
      if (at !== to + 1) throw new Error(`part ${n} ended at ${at - from} of ${to + 1 - from} bytes`);
    } catch (error) {
      if (stall.signal.aborted && !options.signal?.aborted) throw new Error(`nothing came from Google Drive for ${Math.round(ranged.stallMs / 1000)} s`);
      throw error;
    } finally {
      clearTimeout(idle);
      flowing.delete(n);
    }
  };

  const worker = async () => {
    for (let n = left.shift(); n !== undefined && failure === null; n = left.shift()) {
      for (let attempt = 1; ; attempt++) {
        if (options.signal?.aborted) throw new Error("Stopped.");
        try {
          await fetchPart(n);
          break;
        } catch (error) {
          if (error instanceof Refused || options.signal?.aborted || attempt >= ranged.tries) throw error;
          diag.warn("drive", `part ${n + 1} of ${count} of ${dest.slice(dest.lastIndexOf("/") + 1)} failed (try ${attempt}): ${diag.messageOf(error)}; asking again`);
          await ranged.sleep(1000 * 2 ** attempt);
        }
      }
      done.add(n);
      down += lengthOf(n);
      report();
      writeAtomic(journalOf(dest), JSON.stringify({ size, part: ranged.part, done: [...done] }));
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(ranged.parallel, Math.max(left.length, 1)) }, () =>
        worker().catch((error: unknown) => {
          failure ??= error;
        }),
      ),
    );
  } finally {
    fs.closeSync(fd);
  }
  if (failure !== null) throw failure;
  fs.rmSync(journalOf(dest), { force: true });
}
