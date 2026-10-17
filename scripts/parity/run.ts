// The parity harness (docs/rewrite-plan.md §5): the Rust server at tag
// `parity-base` (the reference) against the TS server, on two clones of one
// fixture home, against one record/replay mock of every outside service
// (an instance each, so their calls can be compared too). The same steps run
// on both; after each one the HTTP and MCP answers, rendered images, project
// files on disk and websocket events are compared.
//
//     bun scripts/parity/build.ts              # once: the two servers
//     bun scripts/parity/run.ts [--only <step name part>] [--reseed] [--keep]
//
// Writes <dir>/report.txt and report.json (<dir> is /tmp/edit-parity, or
// EDIT_PARITY_DIR / --dir). Exits 1 when an unexpected difference is found.

import * as fs from "node:fs";
import * as nodePath from "node:path";

import { ParityMock } from "../../apps/server/test/mocks/parity.ts";
import { compare, compareText, contextOf, normalize, replaceText, type Difference, type Context } from "./compare.ts";
import { makeFixtures, remapProject, type Fixtures } from "./fixtures.ts";
import { parityDir, writeStubWeb } from "./paths.ts";
import { Side, type ServerConfig, type SideName } from "./servers.ts";
import { steps, type Step, type World } from "./steps.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const dir = parityDir(flag("--dir"));
const repo = nodePath.resolve(import.meta.dir, "../..");
const only = flag("--only");
const bin = nodePath.join(dir, "bin");
const rustBin = flag("--rust") ?? nodePath.join(bin, "edit-rust");
const nativeNode = flag("--native") ?? nodePath.join(bin, "edit-native.node");
const web = nodePath.join(dir, "web");

/** The real projects copied into the seed (read only), remapped onto the fixtures. */
const REAL = [
  { id: "p1791811932480-23", role: "reference edit (script, cut-ins, voice-overs, music)" },
  { id: "p1792146274480-1", role: "subtitled video" },
];
const SEED_VERSION = 5;

for (const file of [rustBin, nativeNode]) {
  if (!fs.existsSync(file)) {
    console.error(`parity: ${file} is missing; run bun scripts/parity/build.ts first`);
    process.exit(2);
  }
}
writeStubWeb(web);

const fixtures = makeFixtures(nodePath.join(dir, "media"));
const mockFiles = { speech: fixtures.speech, sfx: fixtures.sfx, music: fixtures.music, footage: fixtures.short, photo: fixtures.photo };

/** The shared environment: every outside service at the mock, the sign-ins as stand-ins. */
function serviceEnv(mock: ParityMock, cloud: boolean): Record<string, string> {
  return {
    ...mock.env(),
    AI_GATEWAY_API_KEY: "parity-gateway-key",
    GOOGLE_DRIVE_CLIENT_ID: "parity-client",
    GOOGLE_DRIVE_CLIENT_SECRET: "parity-secret",
    GOOGLE_DOCS_REFRESH_TOKEN: "parity-refresh",
    EDIT_CLOUD_HOLDER: "parity-mac",
    // Both on the FFmpeg Edit ships (build.ts fetches it).
    ...(fs.existsSync(nodePath.join(bin, "ffmpeg/ffmpeg"))
      ? { EDIT_FFMPEG: nodePath.join(bin, "ffmpeg/ffmpeg"), EDIT_FFPROBE: nodePath.join(bin, "ffmpeg/ffprobe") }
      : {}),
    ...(cloud ? { EDIT_RELAY_TOKEN: "parity-relay-token" } : {}),
  };
}

function config(side: SideName, home: string, user: string, env: Record<string, string>, log: string): ServerConfig {
  return {
    side,
    port: side === "rust" ? 7801 : 7802,
    home,
    user,
    env,
    rust: rustBin,
    native: nativeNode,
    web,
    repo,
    log,
  };
}

// ---------------------------------------------------------------------------
// The seed home: made once by the Rust server (cloud off), then cloned.

interface Seed {
  small: string;
  reference: string;
  subtitled: string;
}

async function waitMedia(side: Side, project: string, transcripts: boolean): Promise<void> {
  const settled = (stage: unknown) => stage === "ready" || stage === "skipped" || stage === "failed";
  const ok = await side.until(async () => {
    const reply = await side.http("GET", `/api/projects/${project}/media-status`);
    const media = (reply.body as { media: Record<string, Record<string, unknown>> }).media;
    return Object.values(media).every(
      (status) =>
        settled(status.proxy) &&
        settled(status.light) &&
        settled(status.thumbs) &&
        settled(status.peaks) &&
        (!transcripts || status.transcript !== "working"),
    );
  }, 900_000, 1000);
  if (!ok) throw new Error(`${side.name}: ${project}'s media didn't finish`);
}

async function makeSeed(seedDir: string, fixtures: Fixtures): Promise<Seed> {
  const stamp = nodePath.join(seedDir, "parity-seed.json");
  if (!args.includes("--reseed") && fs.existsSync(stamp)) {
    const kept = JSON.parse(fs.readFileSync(stamp, "utf8")) as Seed & { version: number };
    if (kept.version === SEED_VERSION) return kept;
  }
  console.log("parity: making the seed home with the Rust server");
  fs.rmSync(seedDir, { recursive: true, force: true });
  const home = nodePath.join(seedDir, "home");
  const user = nodePath.join(seedDir, "user");
  fs.mkdirSync(nodePath.join(home, "projects"), { recursive: true });
  fs.mkdirSync(user, { recursive: true });
  for (const { id } of REAL) {
    const source = nodePath.join(process.env.HOME ?? "", ".edit/projects", `${id}.json`);
    const project = remapProject(source, fixtures, JSON.parse(fs.readFileSync(source, "utf8")).name as string);
    fs.writeFileSync(nodePath.join(home, "projects", `${id}.json`), JSON.stringify(project, null, 2));
  }
  seedResearch(home, fixtures);
  // The subtitled project's agent chat (small), for the chat route.
  const chat = nodePath.join(process.env.HOME ?? "", ".edit/projects", `${REAL[1]!.id}.chat.json`);
  if (fs.existsSync(chat)) fs.copyFileSync(chat, nodePath.join(home, "projects", `${REAL[1]!.id}.chat.json`));
  const mock = new ParityMock(mockFiles);
  const side = new Side(config("rust", home, user, serviceEnv(mock, false), nodePath.join(seedDir, "rust.log")));
  try {
    await side.start();
    // The copies saved once, as the store writes them.
    for (const { id } of REAL) {
      const live = (await side.http("GET", `/api/projects/${id}`)).body as { rev: number; project: unknown };
      const saved = await side.http("PUT", `/api/projects/${id}`, { base_rev: live.rev, project: live.project, origin: "seed" });
      if (saved.status !== 200) throw new Error(`seed: saving ${id}: ${JSON.stringify(saved.body)}`);
    }
    const created = (await side.http("POST", "/api/projects", { name: "Parity small" })).body as { project: { id: string } };
    const small = created.project.id;
    const imported = await side.http("POST", `/api/projects/${small}/import`, {
      paths: [fixtures.short, fixtures.voice, fixtures.still, fixtures.sfx],
      place: true,
      origin: "seed",
    });
    if (imported.status !== 200) throw new Error(`seed: import: ${JSON.stringify(imported.body)}`);
    for (const id of [small, ...REAL.map((real) => real.id)]) {
      await side.http("GET", `/api/projects/${id}`);
      await waitMedia(side, id, false);
    }
    // Transcripts (on request only: they cost money) for the footage and voice-overs.
    for (const id of [small, ...REAL.map((real) => real.id)]) {
      const project = ((await side.http("GET", `/api/projects/${id}`)).body as { project: { media: { id: string; path: string; kind: string }[] } }).project;
      const asked = new Set<string>();
      for (const media of project.media) {
        if (media.kind === "image" || media.path === fixtures.sfx || media.path === fixtures.music || asked.has(media.path)) continue;
        asked.add(media.path);
        await side.http("POST", `/api/projects/${id}/media/${media.id}/transcribe`);
      }
      await waitMedia(side, id, true);
    }
    await side.settle(2000, 120_000);
  } finally {
    await side.stop();
    mock.stop();
  }
  for (const volatile of ["logs", "server.lock"]) fs.rmSync(nodePath.join(home, volatile), { recursive: true, force: true });
  const seed = { version: SEED_VERSION, small: "", reference: REAL[0]!.id, subtitled: REAL[1]!.id };
  seed.small = fs
    .readdirSync(nodePath.join(home, "projects"))
    .filter((name) => name.endsWith(".json") && !REAL.some((real) => name.startsWith(real.id)))
    .map((name) => name.replace(/\.json$/, ""))[0]!;
  fs.writeFileSync(stamp, JSON.stringify(seed, null, 2));
  return seed;
}

/**
 * The reference project's research (found images and saved articles) from
 * ~/.edit/research, read only: the first items of its index with every image
 * the fixture photo, and its articles. Paths point into the home; each clone
 * gets them rewritten to its own (`homePaths`).
 */
function seedResearch(home: string, fixtures: Fixtures): void {
  const id = REAL[0]!.id;
  const from = nodePath.join(process.env.HOME ?? "", ".edit/research", id);
  if (!fs.existsSync(nodePath.join(from, "index.json"))) return;
  const to = nodePath.join(home, "research", id);
  fs.mkdirSync(to, { recursive: true });
  const index = (JSON.parse(fs.readFileSync(nodePath.join(from, "index.json"), "utf8")) as Record<string, unknown>[]).slice(0, 14);
  for (const item of index) {
    const file = nodePath.join(to, `${String(item.id)}.jpg`);
    fs.copyFileSync(fixtures.photo, file);
    fs.utimesSync(file, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    item.file = file;
    item.width = 800;
    item.height = 600;
    delete item.media;
    if (item.status === "kept") item.status = "new";
  }
  fs.writeFileSync(nodePath.join(to, "index.json"), JSON.stringify(index));
  if (fs.existsSync(nodePath.join(from, "articles.json"))) {
    const articles = (JSON.parse(fs.readFileSync(nodePath.join(from, "articles.json"), "utf8")) as Record<string, unknown>[])
      .slice(0, 3)
      .map((article) => ({ ...article, text: String(article.text).slice(0, 4000) }));
    fs.writeFileSync(nodePath.join(to, "articles.json"), JSON.stringify(articles, null, 2));
  }
}

/** A clone's files that name the seed home by path, pointed at the clone. */
function homePaths(seedHome: string, home: string): void {
  const research = nodePath.join(home, "research");
  if (!fs.existsSync(research)) return;
  for (const project of fs.readdirSync(research)) {
    const index = nodePath.join(research, project, "index.json");
    if (!fs.existsSync(index)) continue;
    const stat = fs.statSync(index);
    fs.writeFileSync(index, fs.readFileSync(index, "utf8").split(seedHome).join(home));
    fs.utimesSync(index, stat.atime, stat.mtime);
  }
}

// ---------------------------------------------------------------------------
// The run.

interface Finding {
  step: string;
  kind: "answer" | "files" | "events" | "calls" | "error";
  differences: Difference[];
  /** Expected (a known, listed divergence) or pending: reported, not failed. */
  expected?: string;
}

const seed = await makeSeed(nodePath.join(dir, "seed"), fixtures);
const runDir = nodePath.join(dir, "run");
fs.rmSync(runDir, { recursive: true, force: true });
const user = nodePath.join(runDir, "user");
fs.mkdirSync(user, { recursive: true });
// --replay FILE: the mock answers from a recording (an earlier run's <dir>/recording.json) where it has one.
const replayFile = flag("--replay");
const replay = replayFile === undefined ? null : new Map(Object.entries(JSON.parse(fs.readFileSync(replayFile, "utf8")) as Record<string, { status: number; type: string; body: string }>));
const mocks = { rust: new ParityMock(mockFiles, replay), ts: new ParityMock(mockFiles, replay) };
const sides: Record<SideName, Side> = {} as Record<SideName, Side>;
for (const name of ["rust", "ts"] as const) {
  const home = nodePath.join(runDir, name);
  // cp -p: mtimes kept, so every cache file's key and stamp is the seed's.
  const copied = Bun.spawnSync(["cp", "-Rp", nodePath.join(dir, "seed/home"), home]);
  if (copied.exitCode !== 0) throw new Error(`cp: ${copied.stderr.toString()}`);
  homePaths(nodePath.join(dir, "seed/home"), home);
  sides[name] = new Side(config(name, home, user, serviceEnv(mocks[name], true), nodePath.join(runDir, `${name}.log`)));
}
const ids = { rust: new Map<string, string>(), ts: new Map<string, string>() };
const world: World = {
  fixtures,
  seed,
  dir: runDir,
  alias(side, id, label) {
    ids[side.name].set(id, label);
  },
  mock: (side) => mocks[side.name],
};

const contexts = (): Record<SideName, Context> => ({
  rust: contextOf(sides.rust, mocks.rust.url, ids.rust, runDir),
  ts: contextOf(sides.ts, mocks.ts.url, ids.ts, runDir),
});

/** The project files on disk, normalized: projects/*.json, history counts, deleted names. */
function projectFiles(side: Side, context: Context): Record<string, string> {
  const out: Record<string, string> = {};
  const projects = nodePath.join(side.home, "projects");
  if (!fs.existsSync(projects)) return out;
  for (const name of fs.readdirSync(projects).sort()) {
    const full = nodePath.join(projects, name);
    if (name.endsWith(".tmp") || name.includes(".tmp")) continue;
    if (fs.statSync(full).isDirectory()) {
      if (name === "history") {
        for (const id of fs.readdirSync(full).sort()) {
          out[`history/${contextLabel(id, context)}`] = `${fs.readdirSync(nodePath.join(full, id)).length} versions`;
        }
      } else if (name === "deleted") {
        out.deleted = fs
          .readdirSync(full)
          .map((file) => replaceText(file, context))
          .sort()
          .join(", ");
      }
      continue;
    }
    let text = fs.readFileSync(full, "utf8");
    if (name.endsWith(".chat.json")) {
      // Codex failing to start ends a turn twice (the turn's error, the process's exit): which
      // lands first is a race, and both can be kept. Compared without them.
      try {
        const chat = JSON.parse(text) as { entries?: { kind?: string; text?: string }[] };
        chat.entries = (chat.entries ?? []).filter((entry) => !(entry.kind === "error" && /^Codex stopped/.test(entry.text ?? "")));
        text = JSON.stringify(chat);
      } catch {
        // compared as it is
      }
    }
    out[contextLabel(name, context)] = replaceText(text, context);
  }
  return out;
}

function contextLabel(text: string, context: Context): string {
  let out = text;
  for (const [from, to] of context.replacements) out = out.split(from).join(to);
  return out;
}

function eventsOf(side: Side, from: number, context: Context): { project: unknown[]; other: string[] } {
  const project: unknown[] = [];
  const other = new Set<string>();
  const lastMedia = new Map<string, unknown>();
  for (const event of side.events.slice(from)) {
    const normalized = normalize(event, context) as Record<string, unknown>;
    if (event.type === "project") project.push(normalized);
    else if (event.type === "media") lastMedia.set(String(normalized.path), normalized);
    // Codex failing to start ends a turn twice (the turn's error, the process's exit):
    // which lands first is a race, and the later one replaces the entry. The chat file says how it ended.
    else if (event.type === "agent" && (event.entry as { kind?: string } | undefined)?.kind === "error") continue;
    else {
      // Progress is a matter of timing: only the states reached count.
      const { progress: _progress, bytes: _bytes, frames: _frames, fps: _fps, done: _done, ...rest } = normalized;
      if (event.type === "export") delete rest.seconds;
      other.add(JSON.stringify(sortKeys(rest)));
    }
  }
  for (const media of lastMedia.values()) other.add(JSON.stringify(sortKeys(media)));
  return { project, other: [...other].sort() };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function expectedFor(step: Step, differences: Difference[]): string | undefined {
  if (step.pending !== undefined) return `pending: ${step.pending}`;
  if (differences.length === 0) return undefined;
  const known = step.expect ?? [];
  const why = differences.map((difference) => known.find((rule) => rule.path.test(difference.path))?.why);
  if (why.every((reason) => reason !== undefined)) return [...new Set(why)].join("; ");
  return undefined;
}

const findings: Finding[] = [];
/** File differences already reported (file → the difference), so one isn't reported again by every later step. */
const reported = new Map<string, string>();
/** Steps whose (Rust) answer was a refusal or failure: the same on both sides, but not a success. */
const outcomes = new Map<string, string>();
const log: string[] = [];
const say = (line: string) => {
  log.push(line);
  console.log(line);
};

try {
  await Promise.all([sides.rust.start(), sides.ts.start()]);
  say(`parity: rust on :7801 (${rustBin}), ts on :7802 (bun, ${nativeNode}); homes in ${runDir}`);
  for (const step of steps) {
    if (only !== undefined && !step.name.includes(only) && !step.always) continue;
    const started = Date.now();
    const before = { rust: sides.rust.events.length, ts: sides.ts.events.length };
    const callsBefore = { rust: mocks.rust.server.requests.length, ts: mocks.ts.server.requests.length };
    const said: Record<SideName, unknown> = { rust: null, ts: null };
    const failed: Record<SideName, string | null> = { rust: null, ts: null };
    for (const name of ["rust", "ts"] as const) {
      try {
        said[name] = await step.run(sides[name], world);
      } catch (error) {
        failed[name] = error instanceof Error ? (error.stack ?? error.message) : String(error);
      }
    }
    await Promise.all([sides.rust.settle(step.settle ?? 500), sides.ts.settle(step.settle ?? 500)]);
    const context = contexts();
    const stepFindings: Finding[] = [];
    if (failed.rust !== null || failed.ts !== null) {
      stepFindings.push({ step: step.name, kind: "error", differences: [{ path: "(step)", rust: failed.rust, ts: failed.ts }] });
    }
    const answer = compare(normalize(said.rust, context.rust), normalize(said.ts, context.ts));
    if (answer.length > 0) stepFindings.push({ step: step.name, kind: "answer", differences: answer });
    if (step.files !== false) {
      const files: Difference[] = [];
      const left = projectFiles(sides.rust, context.rust);
      const right = projectFiles(sides.ts, context.ts);
      for (const name of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        if (!(name in left) || !(name in right)) {
          files.push({ path: name, rust: name in left ? "present" : "(missing)", ts: name in right ? "present" : "(missing)" });
          continue;
        }
        compareText(left[name]!, right[name]!, name, files);
      }
      // A difference already reported stays until the file changes: only what this step changed is its own.
      const fresh = files.filter((difference) => {
        const name = difference.path.replace(/:\d+$/, "");
        const seen = JSON.stringify([difference.rust, difference.ts]);
        const same = reported.get(name) === seen;
        reported.set(name, seen);
        return !same;
      });
      for (const name of [...reported.keys()]) {
        if (!files.some((difference) => difference.path.replace(/:\d+$/, "") === name)) reported.delete(name);
      }
      if (fresh.length > 0) stepFindings.push({ step: step.name, kind: "files", differences: fresh });
    }
    if (step.events !== "none") {
      const left = eventsOf(sides.rust, before.rust, context.rust);
      const right = eventsOf(sides.ts, before.ts, context.ts);
      const events = compare(left.project, right.project, "project events");
      if (step.events !== "project") compare(left.other, right.other, "other events", events);
      if (events.length > 0) stepFindings.push({ step: step.name, kind: "events", differences: events });
    }
    if (step.calls !== false) {
      // The cloud's sync runs in the background on its own clock: compared over the whole run instead.
      const own = (side: SideName, from: number) =>
        callKeys(mocks[side].server.requests.slice(from), context[side]).filter((key) => !isCloudCall(key));
      const calls = multisetDifference(own("rust", callsBefore.rust), own("ts", callsBefore.ts), "outside calls");
      if (calls.length > 0) stepFindings.push({ step: step.name, kind: "calls", differences: calls });
    }
    const outcome = (value: unknown) => outcomeOf(normalize(value, context.rust));
    if (failed.rust === null && failed.ts === null) {
      const rustOutcome = outcome(said.rust);
      fs.mkdirSync(nodePath.join(dir, "answers"), { recursive: true });
      fs.writeFileSync(
        nodePath.join(dir, "answers", `${String(steps.indexOf(step)).padStart(3, "0")} ${step.name.replace(/[^\w .()-]+/g, "_")}.json`),
        JSON.stringify(normalize(said.rust, context.rust), (_key, item) => (item instanceof Uint8Array ? `<${item.length} bytes>` : item), 2),
      );
      if (rustOutcome !== "ok") outcomes.set(step.name, rustOutcome);
    }
    for (const finding of stepFindings) {
      finding.expected = expectedFor(step, finding.differences);
      findings.push(finding);
    }
    const unexpected = stepFindings.filter((finding) => finding.expected === undefined);
    const status = stepFindings.length === 0 ? "same" : unexpected.length === 0 ? "expected" : "DIFFERENT";
    const note = outcomes.has(step.name) ? ` [rust answered: ${outcomes.get(step.name)}]` : "";
    say(`${status.padEnd(9)} ${step.name} (${((Date.now() - started) / 1000).toFixed(1)} s)${note}`);
    for (const finding of stepFindings) {
      for (const difference of finding.differences.slice(0, 12)) {
        say(
          `    ${finding.expected === undefined ? "!" : "~"} ${finding.kind} ${difference.path}: rust ${JSON.stringify(difference.rust)} | ts ${JSON.stringify(difference.ts)}${difference.note ? ` (${difference.note})` : ""}`,
        );
      }
      if (finding.differences.length > 12) say(`    … ${finding.differences.length - 12} more`);
      if (finding.expected !== undefined) say(`    (${finding.expected})`);
    }
  }
} finally {
  await Promise.all([sides.rust?.stop(), sides.ts?.stop()]);
  mocks.rust.stop();
  mocks.ts.stop();
  // What the mock answered, by request hash (for --replay).
  const recording = Object.fromEntries([...mocks.rust.answers, ...mocks.ts.answers]);
  fs.writeFileSync(nodePath.join(dir, "recording.json"), JSON.stringify(recording));
}

/** Lease renewals and the like: how many depends on how long the run took. */
const BACKGROUND = /renew|heartbeat|getLock|listProjects|edit:status/i;

// The outside calls over the whole run (the cloud's background sync included), as counts.
{
  const context = contexts();
  const all = (side: SideName) => callKeys(mocks[side].server.requests, context[side]).filter((key) => !BACKGROUND.test(key));
  const calls = multisetDifference(all("rust"), all("ts"), "all outside calls");
  if (calls.length > 0) {
    const finding: Finding = { step: "(the whole run)", kind: "calls", differences: calls };
    findings.push(finding);
    say("calls over the whole run differ:");
    for (const difference of calls) say(`    ! ${difference.path}: rust ${JSON.stringify(difference.rust)} | ts ${JSON.stringify(difference.ts)}`);
  }
}

// Coverage: every route in the Rust router and every tool in tools/list.
const routes = rustRoutes();
const asked = new Set([...sides.rust.asked]);
const matched = (route: string) => {
  const [method, pattern] = route.split(" ") as [string, string];
  const regex = new RegExp(`^${pattern.replace(/\{[^}]+\}/g, "[^/]+")}$`);
  return [...asked].some((call) => {
    const [askedMethod, path] = call.split(" ") as [string, string];
    return askedMethod === method && regex.test(path);
  });
};
const uncoveredRoutes = routes.filter((route) => !matched(route));
const toolNames = (JSON.parse(fs.readFileSync(nodePath.join(repo, "apps/server/src/mcp/tools.json"), "utf8")) as { name: string }[] | { tools: { name: string }[] });
const tools = (Array.isArray(toolNames) ? toolNames : toolNames.tools).map((tool) => tool.name);
const uncoveredTools = tools.filter((tool) => !asked.has(`tool ${tool}`));
say("");
say(`routes: ${routes.length - uncoveredRoutes.length}/${routes.length} exercised${uncoveredRoutes.length ? `; not: ${uncoveredRoutes.join(", ")}` : ""}`);
say(`tools: ${tools.length - uncoveredTools.length}/${tools.length} exercised${uncoveredTools.length ? `; not: ${uncoveredTools.join(", ")}` : ""}`);
const unexpected = findings.filter((finding) => finding.expected === undefined);
say(`differences: ${unexpected.length} unexpected, ${findings.length - unexpected.length} expected or pending`);
fs.writeFileSync(nodePath.join(dir, "report.txt"), `${log.join("\n")}\n`);
fs.writeFileSync(
  nodePath.join(dir, "report.json"),
  JSON.stringify({ findings, uncoveredRoutes, uncoveredTools }, (_key, value) => (value instanceof Uint8Array ? `<${value.length} bytes>` : value), 2),
);
if (!args.includes("--keep")) {
  // The homes stay for a look until the next run; the servers are stopped.
}
process.exit(unexpected.length > 0 ? 1 : 0);

/** A mock request as compared: method, path, and for Convex the function called. */
function callKeys(requests: { method: string; path: string; text(): string }[], context: Context): string[] {
  return requests.map((request) => {
    let key = `${request.method} ${replaceText(request.path, context)}`;
    if (request.path === "/v1/cloud/convex") {
      try {
        key += ` ${String((JSON.parse(request.text()) as { path?: unknown }).path)}`;
      } catch {
        // not JSON
      }
    }
    return key;
  });
}

function isCloudCall(key: string): boolean {
  return / \/v1\/cloud\/| \/r2\/| \/convex\//.test(key);
}


function multisetDifference(left: string[], right: string[], label: string): Difference[] {
  const counts = new Map<string, [number, number]>();
  for (const key of left) counts.set(key, [(counts.get(key)?.[0] ?? 0) + 1, counts.get(key)?.[1] ?? 0]);
  for (const key of right) counts.set(key, [counts.get(key)?.[0] ?? 0, (counts.get(key)?.[1] ?? 0) + 1]);
  const out: Difference[] = [];
  for (const [key, [a, b]] of [...counts].sort()) if (a !== b) out.push({ path: `${label}: ${key}`, rust: a, ts: b });
  return out;
}

/** "ok", or what went wrong, from a step's answer (HTTP >= 400, an MCP error). */
function outcomeOf(value: unknown): string {
  const found: string[] = [];
  const visit = (item: unknown): void => {
    if (found.length > 0 || item === null || typeof item !== "object") return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.status === "number" && record.status >= 400) {
      found.push(`${record.status} ${JSON.stringify(record.body ?? "").slice(0, 120)}`);
      return;
    }
    if (record.isError === true) {
      found.push(`error ${JSON.stringify(record.content ?? "").slice(0, 160)}`);
      return;
    }
    if (record.error !== undefined && record.error !== null && typeof record.error === "object") {
      found.push(`rpc error ${JSON.stringify(record.error).slice(0, 120)}`);
      return;
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return found[0] ?? "ok";
}

/** The Rust router's routes (server.rs `router`, cloud_projects `routes`), as "METHOD /path/{param}". */
function rustRoutes(): string[] {
  const out: string[] = [];
  for (const file of ["crates/edit/src/server.rs", "crates/edit/src/cloud_projects.rs"]) {
    const text = fs.readFileSync(nodePath.join(repo, file), "utf8");
    for (const match of text.matchAll(/\.route\(\s*"([^"]+)",\s*([\s\S]*?)\)\s*(?=\.route|\.merge|\.fallback|\n\s*\}|$)/g)) {
      const path = match[1]!;
      const handlers = match[2]!;
      for (const method of handlers.matchAll(/\b(get|post|put|delete)\(/g)) out.push(`${method[1]!.toUpperCase()} ${path}`);
    }
  }
  return [...new Set(out)];
}
