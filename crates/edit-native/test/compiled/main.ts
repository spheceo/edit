// `bun build --compile` with the addon embedded (checked by `just native-compiled`):
// the binary must work from anywhere, the .node it was built with gone.
import type * as Native from "../../index";

const native: typeof Native = require("../../edit-native.node");
const home = process.argv[2];
if (!home) throw new Error("usage: compiled <home>");

native.init({
  home,
  cacheDir: `${home}/cache`,
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
  mediaFolders: [],
  log: () => {},
});
const project = {
  version: 1,
  id: "p",
  name: "compiled",
  settings: { width: 64, height: 36, fps: 30 },
  media: [],
  tracks: [{ id: "v1", kind: "video" }],
  clips: [{ id: "s", track: "v1", type: "solid", fill: [0, 0, 1, 1], start: 0, duration: 30 }],
};
const committed = native.projectPrepare("p", JSON.stringify(project));
const [image] = await native.renderFrames({
  project: { ref: { id: "p", rev: 1 } },
  frames: [0],
  maxSide: 0,
  priority: "ui",
  encode: "png",
});
console.log(JSON.stringify({ key: native.mediaKey(home), bytes: committed.json.length, png: image.data.length }));
