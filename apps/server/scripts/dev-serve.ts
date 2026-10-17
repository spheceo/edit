// Runs the TS foundation on its own, for a smoke test before WP2's `edit serve`
// lands: the store, media processor, MCP (list_projects and the declarations)
// and the web UI, with whatever addon is found (else the stub).
//
//     bun apps/server/scripts/dev-serve.ts [--home DIR] [--port N]

import * as nodePath from "node:path";

import { createApp } from "../src/app.ts";
import * as diag from "../src/diag.ts";
import { setListening } from "../src/broll.ts";
import { registerEditingTools } from "../src/edit_tools.ts";
import { registerMediaTools, routes as mediaRoutes } from "../src/media_tools.ts";
import { allowedHosts } from "../src/http/host.ts";
import { baseRouter, listen } from "../src/http/server.ts";
import { holdLock } from "../src/media_drive/layout.ts";
import { initNative, isReal } from "../src/native/index.ts";
import { Store } from "../src/store.ts";
import * as tools from "../src/tools.ts";

const flag = (name: string) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const home = nodePath.resolve(flag("--home") ?? nodePath.join(process.env.HOME ?? ".", ".edit-ts-dev"));
const port = Number(flag("--port") ?? "7790");

diag.open(home);
const store = Store.open(home);
initNative({
  home: store.layout().home,
  cacheDir: store.cacheDir(),
  ffmpeg: tools.ffmpeg(),
  ffprobe: tools.ffprobe(),
  mediaFolders: store.layout().known,
});
store.publishLayout();
holdLock(home);
registerEditingTools();
registerMediaTools();
const app = createApp({ store, port, allowedHosts: allowedHosts() });
const router = baseRouter();
mediaRoutes(router);
setListening("127.0.0.1", port);
listen(app, router, "127.0.0.1", port);
console.log(`edit (ts foundation): http://127.0.0.1:${port} — data in ${home}; addon: ${isReal() ? "native" : "stub"}`);
