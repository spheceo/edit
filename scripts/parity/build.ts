// Builds the parity run's two servers (plan §5.1), into <dir>/bin:
// - edit-rust: the Rust server at tag `parity-base` (a worktree of the tag,
//   `[profile.serve]`, no Tauri), with the stub UI the TS server serves too;
// - edit-native.node: the addon from this checkout (`just native`).
// Each build has its own target and build dirs (the shared build-dir corrupts
// concurrent builds), deleted afterwards; CARGO_BUILD_JOBS=4 by default.
//
// - ffmpeg/: the FFmpeg that ships with Edit (scripts/ffmpeg.sh), which both use.
//
//     bun scripts/parity/build.ts [--dir /tmp/edit-parity] [--only rust|native|ffmpeg]

import * as fs from "node:fs";
import * as nodePath from "node:path";

import { parityDir, writeStubWeb } from "./paths.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const dir = parityDir(flag("--dir"));
const only = flag("--only");
const repo = nodePath.resolve(import.meta.dir, "../..");
const bin = nodePath.join(dir, "bin");
fs.mkdirSync(bin, { recursive: true });

function run(command: string[], cwd: string, env: Record<string, string> = {}): void {
  console.log(`$ ${command.join(" ")}`);
  const done = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "4", ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (done.exitCode !== 0) throw new Error(`${command.join(" ")} failed (${done.exitCode})`);
}

if (only === undefined || only === "rust") {
  const base = nodePath.join(dir, "base");
  if (!fs.existsSync(nodePath.join(base, "Cargo.toml"))) {
    run(["git", "worktree", "add", "--detach", base, "parity-base"], repo);
  }
  // rust-embed needs apps/web/dist; both servers serve the same stub UI.
  writeStubWeb(nodePath.join(base, "apps/web/dist"));
  const target = nodePath.join(base, "target");
  try {
    run(["nice", "cargo", "build", "--profile", "serve", "-p", "edit", "--no-default-features"], base, {
      CARGO_TARGET_DIR: nodePath.join(target, "serve"),
      CARGO_BUILD_BUILD_DIR: nodePath.join(target, "build"),
    });
    fs.copyFileSync(nodePath.join(target, "serve/serve/edit"), nodePath.join(bin, "edit-rust"));
    fs.chmodSync(nodePath.join(bin, "edit-rust"), 0o755);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

if (only === undefined || only === "native") {
  const target = nodePath.join(dir, "native-build");
  try {
    run(["nice", "just", "native"], repo, {
      CARGO_TARGET_DIR: nodePath.join(target, "target"),
      CARGO_BUILD_BUILD_DIR: nodePath.join(target, "build"),
    });
    fs.copyFileSync(nodePath.join(repo, "crates/edit-native/edit-native.node"), nodePath.join(bin, "edit-native.node"));
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
}
if (only === undefined || only === "ffmpeg") {
  // The FFmpeg Edit ships (the dev one on PATH lacks options the cloud paths use).
  const arch = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  run(["sh", "scripts/ffmpeg.sh", arch, nodePath.join(bin, "ffmpeg")], repo);
}
console.log(`parity: built into ${bin}`);
