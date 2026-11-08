// The dev server, kept running (`just dev`, `just dev-server`). Each change to
// what the server is made of starts a fresh server: its source, the shared
// types, the agent's text (read in at build time) and the native addon `just
// native` swaps in. Not `bun --watch`, which reloads inside one process and
// keeps a handle on every file it has seen: after a day of reloads it ran out
// (EMFILE, Nov 2, 3 and 4 2026) and hung with 7700 closed, three times on Nov 4
// alone, until someone killed it. A fresh process each time can't pile them
// up, and the watch here is a handful of directory watchers.
//
// A change while the server is in the middle of something (Claude on a
// thumbnail, an export: /api/health's busy) waits for it, at most 20 minutes,
// so other sessions' saves don't cut a turn off. It's started again when it
// exits, and when it stops answering /api/health for a minute (a hang).
// Ctrl-C (or the recipe ending) stops it.
//
//   bun scripts/dev-server.ts [serve's options]    (from app/, with the recipe's environment)

import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
// Anything after the script goes to `serve` (`--port 7720 --home /tmp/x` for a second one); the port is watched for health.
const ARGS = process.argv.slice(2);
const portAt = ARGS.indexOf("--port");
const PORT = (portAt >= 0 ? Number(ARGS[portAt + 1]) : 0) || 7700;
const HEALTH = `http://127.0.0.1:${PORT}/api/health`;

/** What the server is made of: a change in any of these starts a fresh one. */
const WATCHED: { dir: string; recursive: boolean; matches: (file: string) => boolean }[] = [
  { dir: join(ROOT, "apps/server/src"), recursive: true, matches: (file) => /\.(ts|tsx|json|html|css|js)$/.test(file) },
  { dir: join(ROOT, "packages/edit-types/src"), recursive: true, matches: (file) => /\.ts$/.test(file) },
  { dir: join(ROOT, "../agent"), recursive: true, matches: (file) => /\.md$/.test(file) },
  // `just native` renames the new addon into place.
  { dir: join(ROOT, "crates/edit-native"), recursive: false, matches: (file) => file.endsWith(".node") },
];

const say = (line: string) => console.error(`dev: ${line}`);

let child: ReturnType<typeof Bun.spawn> | null = null;
let stopping = false;
let restarting: Promise<void> | null = null;
let startedAt = 0;

function start(): void {
  startedAt = Date.now();
  const spawned = Bun.spawn(["bun", "apps/server/src/main.ts", "serve", ...ARGS], { cwd: ROOT, stdin: "ignore", stdout: "inherit", stderr: "inherit", env: process.env });
  child = spawned;
  void spawned.exited.then((code) => {
    if (child !== spawned) return;
    child = null;
    if (stopping || restarting !== null) return;
    say(`the server stopped (exit ${code}); starting it again`);
    setTimeout(() => {
      if (!stopping && child === null && restarting === null) start();
    }, 2000);
  });
}

/** The server stopped (asked, then made to), and its port let go. */
async function stop(): Promise<void> {
  const running = child;
  if (running === null) return;
  child = null;
  running.kill("SIGTERM");
  const ended = await Promise.race([running.exited.then(() => true), Bun.sleep(4000).then(() => false)]);
  if (!ended) {
    running.kill("SIGKILL");
    await running.exited;
  }
}

/**
 * What the server is in the middle of (Claude on a thumbnail, an export…), by its /api/health. One that doesn't answer
 * (loaded, or still starting and about to carry on a cut turn) is taken as busy, not idle: Nov 6, an edit's turn was cut
 * four times in 18 minutes by other sessions' saves landing while health was slow. A server that stays silent is a hang,
 * and the check below starts it again; one that isn't running has nothing to cut off.
 */
async function busy(): Promise<string[]> {
  if (child === null) return [];
  try {
    const answer = (await (await fetch(HEALTH, { signal: AbortSignal.timeout(5000) })).json()) as { busy?: unknown };
    return Array.isArray(answer.busy) ? answer.busy.filter((one): one is string => typeof one === "string") : [];
  } catch {
    return ["a server that isn't answering"];
  }
}

/** Saved changes waiting for the server's work to finish (Nov 4: other sessions' saves stopped a thumbnail turn twice running). */
let waiting: { since: number; why: string } | null = null;
const HOLD_AT_MOST = 20 * 60_000;

/**
 * A fresh server for a change, once what it's in the middle of is done (a
 * restart cuts a Claude turn or an export off): held while /api/health says
 * it's busy, at most 20 minutes.
 */
function changed(why: string): void {
  if (stopping) return;
  if (waiting !== null) {
    waiting.why = why;
    return;
  }
  waiting = { since: Date.now(), why };
  void (async () => {
    let said = false;
    for (;;) {
      if (stopping || waiting === null) return;
      const doing = await busy();
      if (doing.length === 0 || Date.now() - waiting.since > HOLD_AT_MOST) break;
      if (!said) say(`${waiting.why}; waiting for ${doing.join(", ")} to finish before starting a fresh server`);
      said = true;
      await Bun.sleep(5000);
    }
    const why = waiting?.why ?? "changed";
    waiting = null;
    restart(`${why}; starting a fresh server`);
  })();
}

/** A fresh server now. */
function restart(why: string): void {
  if (stopping) return;
  if (restarting !== null) return;
  restarting = (async () => {
    say(why);
    await stop();
    start();
  })().finally(() => {
    restarting = null;
  });
}

// Saves come in bursts (an editor's save, a branch switch, `just native`'s rename): one restart after the last.
let pending: { timer: ReturnType<typeof setTimeout>; file: string } | null = null;
const watchers: FSWatcher[] = [];
for (const one of WATCHED) {
  try {
    watchers.push(
      watch(one.dir, { recursive: one.recursive }, (_event, file) => {
        const name = typeof file === "string" ? file : "";
        if (name === "" || !one.matches(name) || name.includes("node_modules") || /\.test\.ts$/.test(name)) return;
        if (pending !== null) clearTimeout(pending.timer);
        pending = {
          file: name,
          timer: setTimeout(() => {
            const file = pending?.file ?? name;
            pending = null;
            changed(`${file} changed`);
          }, 300),
        };
      }),
    );
  } catch (error) {
    say(`can't watch ${one.dir}: ${(error as Error).message}`);
  }
}

// A server that stops answering for a minute (after a minute's grace to start) is a hang: started again. One whose
// last answer said it was busy (an export, an agent turn) gets five: a heavy stretch held its answers past a minute
// and every restart cut three agents' watches and exports off (Nov 8, every ~4 min for an hour).
let misses = 0;
let busyWhenLastAnswered = false;
setInterval(() => {
  if (stopping || restarting !== null || child === null || Date.now() - startedAt < 60_000) {
    misses = 0;
    return;
  }
  void fetch(HEALTH, { signal: AbortSignal.timeout(5000) }).then(
    async (answer) => {
      misses = answer.ok ? 0 : misses + 1;
      if (answer.ok) {
        const said = (await answer.json().catch(() => ({}))) as { busy?: unknown };
        busyWhenLastAnswered = Array.isArray(said.busy) && said.busy.length > 0;
      }
    },
    () => {
      misses++;
    },
  ).then(() => {
    if (misses >= (busyWhenLastAnswered ? 30 : 6)) {
      misses = 0;
      restart(`the server stopped answering for ${busyWhenLastAnswered ? "five minutes (busy when it last answered)" : "a minute"}; starting it again`);
    }
  });
}, 10_000);

const quit = () => {
  if (stopping) return;
  stopping = true;
  for (const one of watchers) one.close();
  void stop().then(() => process.exit(0));
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
process.on("SIGHUP", quit);

start();
