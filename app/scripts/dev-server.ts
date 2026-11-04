// The dev server, kept running (`just dev`, `just dev-server`). Each change to
// what the server is made of starts a fresh server: its source, the shared
// types, the agent's text (read in at build time) and the native addon `just
// native` swaps in. Not `bun --watch`, which reloads inside one process and
// keeps a handle on every file it has seen: after a day of reloads it ran out
// (EMFILE, Nov 2, 3 and 4 2026) and hung with 7700 closed, three times on Nov 4
// alone, until someone killed it. A fresh process each time can't pile them
// up, and the watch here is a handful of directory watchers.
//
// It's started again when it exits, and when it stops answering /api/health
// for a minute (a hang). Ctrl-C (or the recipe ending) stops it.
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

/** A fresh server, once whatever asked for it has settled. */
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
            const changed = pending?.file ?? name;
            pending = null;
            restart(`${changed} changed; starting a fresh server`);
          }, 300),
        };
      }),
    );
  } catch (error) {
    say(`can't watch ${one.dir}: ${(error as Error).message}`);
  }
}

// A server that stops answering for a minute (after a minute's grace to start) is a hang: started again.
let misses = 0;
setInterval(() => {
  if (stopping || restarting !== null || child === null || Date.now() - startedAt < 60_000) {
    misses = 0;
    return;
  }
  void fetch(HEALTH, { signal: AbortSignal.timeout(5000) }).then(
    (answer) => {
      misses = answer.ok ? 0 : misses + 1;
    },
    () => {
      misses++;
    },
  ).then(() => {
    if (misses >= 6) {
      misses = 0;
      restart("the server stopped answering for a minute; starting it again");
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
