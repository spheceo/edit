// Claude's runs on ideas and thumbnails (ideas/run.ts, thumbnails/run.ts):
// who holds one, and how its ending reaches the cloud (the Nov 8 audit, 5.9).
//
// A run is held by a lease the Mac running it renews every minute while the
// turn goes (as cloud_projects renews a project's lock); another Mac may take
// the run only once the lease has lapsed. Before, a run was another Mac's for
// 20 minutes from its start while a thumbnail's turn may run 25, so a second
// Mac could start over a live one, and a dead one blocked it for 20.
//
// A run's ending is written to jobs.json (kind `idea` or `thumbnail`,
// waiting) before the cloud is told, then saved until it lands: now, then a
// minute or more apart, and after a restart by its resumer. Before, a failed
// save was logged and forgotten, and the page showed the run "running" for good.

import * as diag from "./diag.ts";
import * as jobs from "./jobs.ts";

/** Renewed this often; lapsed after `ms` without; an ending tried `tries` times, `retryMs` apart (hooks for tests). */
export const lease = { renewMs: 60_000, ms: 3 * 60_000, tries: 60, retryMs: (attempt: number): number => Math.min(attempt, 10) * 60_000 };
/** A run from a build before leases (no `renewedAt`): another Mac's for this long from its start, as before. */
const UNLEASED_MS = 20 * 60_000;

type Run = { state: string; holder: string; startedAt: number; renewedAt?: number };

const going = (run: Run): boolean => run.state === "running" || run.state === "queued";

/** Whether a run's lease has lapsed (its Mac stopped renewing it). */
export function lapsed(run: Run, now = Date.now()): boolean {
  return now - (run.renewedAt ?? run.startedAt) >= (run.renewedAt === undefined ? UNLEASED_MS : lease.ms);
}

/** Whether another Mac holds `run` now: it's going there and its lease hasn't lapsed. */
export function heldElsewhere(run: Run | null, holder: string, now = Date.now()): boolean {
  return run !== null && going(run) && run.holder !== holder && !lapsed(run, now);
}

/** A run going on a Mac that stopped renewing it, for the page: shown stopped, not running. */
export function stale<T extends Run & { endedAt?: number; error?: string }>(run: T, now = Date.now()): T {
  if (!going(run) || !lapsed(run, now)) return run;
  return { ...run, state: "stopped", error: `${run.holder} stopped answering before Claude finished. Ask again.` };
}

/** Renews a run's lease (`renew`, the cloud write) and its job every `renewMs` while it runs; the returned function stops it. */
export function renewing(home: string | null, key: string, renew: () => Promise<unknown>, area: string): () => void {
  const timer = setInterval(() => {
    jobs.touch(home, key);
    void renew().catch((error: unknown) => diag.warn(area, `${key}: renewing its lease: ${diag.messageOf(error)}`));
  }, lease.renewMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** A run's ending, noted in its job before the cloud is told. */
export function ended(home: string | null, key: string, ending: Record<string, unknown>): void {
  jobs.settle(home, key, "waiting", { step: "saving how it ended", args: { ending } });
}

const landing = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Saves a run's noted ending (`save`, the cloud write; false when there's
 * nowhere for it any more: the idea deleted, a newer run) and crosses its job
 * off; failing, tries again `retryMs` later, and after `tries` keeps it
 * failed (named in the diagnostics). Whether it landed now.
 */
export async function land(home: string | null, key: string, save: (ending: Record<string, unknown>) => Promise<boolean>, area: string, attempt = 1): Promise<boolean> {
  const waiting = landing.get(key);
  if (waiting !== undefined) clearTimeout(waiting);
  landing.delete(key);
  const job = jobs.get(home, key);
  const ending = job?.args.ending as Record<string, unknown> | undefined;
  if (job === undefined || ending === undefined) return true;
  try {
    if (!(await save(ending))) diag.info(area, `${key}: how it ended had nowhere to go (deleted, or a newer run); dropped`);
    jobs.end(home, key);
    return true;
  } catch (error) {
    const message = diag.messageOf(error);
    if (attempt >= lease.tries) {
      jobs.settle(home, key, "failed", { error: `how it ended never reached the cloud: ${message}` });
      diag.warn(area, `${key}: how it ended never reached the cloud after ${attempt} tries: ${message}`);
      return false;
    }
    diag.warn(area, `${key}: saving how it ended (try ${attempt}): ${message}; trying again`);
    const timer = setTimeout(() => void land(home, key, save, area, attempt + 1), lease.retryMs(attempt));
    timer.unref?.();
    landing.set(key, timer);
    return false;
  }
}
