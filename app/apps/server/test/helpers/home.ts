// A fixture home: a fresh data folder in the temp dir with its store, a fresh
// native stub told about it, and an App over them. Each test gets its own, and
// `cleanup()` removes it (tests call it in `finally` or afterEach).

import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import { createApp, type App, type AppOptions } from "../../src/app.ts";
import { useNative, wrap, type Native } from "../../src/native/index.ts";
import { createStub } from "../../src/native/stub.ts";
import { Store } from "../../src/store.ts";

export interface Fixture {
  /** The scratch folder holding the home (and anything else a test makes). */
  dir: string;
  home: string;
  store: Store;
  app: App;
  native: Native;
  cleanup(): void;
}

let counter = 0;

/** A scratch folder (canonical, so paths compare as the code sees them). */
export function scratch(name: string): { dir: string; cleanup(): void } {
  const dir = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), `edit-${name}-${process.pid}-${counter++}-`)),
  );
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A fresh stub addon, initialised for `home`. */
export function freshNative(home: string): Native {
  const native = wrap(createStub());
  native.init({
    home,
    cacheDir: nodePath.join(home, "cache"),
    ffmpeg: "ffmpeg",
    ffprobe: "ffprobe",
    mediaFolders: [],
    log: () => {},
  });
  useNative(native);
  return native;
}

export function fixtureHome(name = "fixture", options: Omit<AppOptions, "store"> = {}): Fixture {
  const { dir, cleanup } = scratch(name);
  const home = nodePath.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  const native = freshNative(home);
  const store = Store.open(home);
  const app = createApp({ store, ...options });
  return { dir, home, store, app, native, cleanup };
}

/** Writes `bytes` at `path`, making its folder. */
export function write(path: string, bytes: string | Uint8Array): void {
  fs.mkdirSync(nodePath.dirname(path), { recursive: true });
  fs.writeFileSync(path, bytes);
}
