import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import * as fs from "node:fs";

import * as cloud from "../src/cloud.ts";
import * as diag from "../src/diag.ts";
import { scratch } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

const MIB = 1024 * 1024;

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  cloud.timing.sleep = async () => {};
});

afterAll(() => {
  restore();
  mock.stop();
});

beforeEach(() => {
  cloud.timing.filePart = cloud.FILE_PART;
  cloud.timing.streamPart = cloud.STREAM_PART;
});

function pattern(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let n = 0; n < length; n++) out[n] = (n * 31) % 251;
  return out;
}

test("keys_stay_under_edit", () => {
  for (const key of ["edit/a.mp4", "edit/projects/p1/clip 1.mov"]) expect(cloud.validKey(key)).toBe(true);
  for (const key of ["", "edit", "edit/", "edit//a", "edit/a/", "edit/../x", "edit/./a", "/edit/a", "repack/a", "editor/a", "edit/a\nb", "edit\\a"]) {
    expect(cloud.validKey(key)).toBe(false);
  }
});

test("convex_answers_become_results", () => {
  expect(cloud.convexValue({ status: "success", value: { id: 1 }, logLines: [] })).toEqual({ id: 1 });
  expect(cloud.convexValue({ status: "success" })).toBeNull();
  const failure = (answer: unknown): cloud.ConvexFailure => {
    try {
      cloud.convexValue(answer);
    } catch (error) {
      return error as cloud.ConvexFailure;
    }
    throw new Error("no failure");
  };
  const plain = failure({ status: "error", errorMessage: "Uncaught Error: no" });
  expect(plain.message).toBe("Convex: Uncaught Error: no");
  expect(plain.code).toBeNull();
  // A ConvexError keeps its code and data (Edit's `conflict`, `locked`, …).
  const conflict = failure({
    status: "error",
    errorMessage: "Uncaught ConvexError: {...}",
    errorData: { code: "conflict", message: "saved elsewhere", rev: 7 },
  });
  expect(conflict.code).toBe("conflict");
  expect(conflict.message).toBe("Convex: saved elsewhere");
  expect(conflict.kind).toBe("function");
  expect((conflict.data as { rev: number }).rev).toBe(7);
  expect(failure({ what: 1 }).kind).toBe("relay");
});

test("parts_grow_only_for_huge_uploads", () => {
  expect(cloud.partSize(cloud.FILE_PART, null)).toBe(cloud.FILE_PART);
  expect(cloud.partSize(cloud.FILE_PART, 200 * MIB)).toBe(cloud.FILE_PART);
  const huge = 1024 * 1024 * MIB; // 1 TiB
  const part = cloud.partSize(cloud.FILE_PART, huge);
  expect(part > cloud.FILE_PART && part % MIB === 0 && Math.ceil(huge / part) <= cloud.MAX_PARTS).toBe(true);
});

test("parts_read_whole_until_the_end", async () => {
  const data = new Uint8Array(250).map((_, n) => n);
  const source = cloud.bytesSource(data);
  expect((await cloud.readPart(source, 100)).length).toBe(100);
  expect((await cloud.readPart(source, 100)).length).toBe(100);
  expect((await cloud.readPart(source, 100)).length).toBe(50);
  expect((await cloud.readPart(source, 100)).length).toBe(0);
  // From a stream of odd-sized chunks too.
  async function* chunks() {
    yield data.subarray(0, 7);
    yield data.subarray(7, 180);
    yield data.subarray(180);
  }
  const streamed = cloud.streamSource(chunks());
  expect(Array.from(await cloud.readPart(streamed, 100))).toEqual(Array.from(data.subarray(0, 100)));
  expect((await cloud.readPart(streamed, 200)).length).toBe(150);
});

test("progress_never_goes_backwards", () => {
  const seen: [number, number][] = [];
  const progress = new cloud.Progress(10, (sent, total) => seen.push([sent, total]));
  progress.add(4);
  progress.takeBack(4); // the part failed; its retry sends it again
  progress.add(3);
  progress.add(3);
  expect(seen).toEqual([
    [4, 10],
    [6, 10],
  ]);
});

test("r2_errors_read_well", () => {
  expect(cloud.r2Message("<?xml?><Error><Code>NoSuchUpload</Code><Message>gone</Message></Error>")).toBe("NoSuchUpload: gone");
  expect(cloud.r2Message(" plain ")).toBe("plain");
  expect(cloud.partialPath("/a/b.mp4")).toBe("/a/b.mp4.partial");
});

// ---------------------------------------------------------------------------
// Against the mock relay (R2 and Convex in memory).

test("small files go up in one PUT with their content type, a presigned URL is never logged", async () => {
  const { dir, cleanup } = scratch("cloud-put");
  try {
    const file = `${dir}/clip.mov`;
    fs.writeFileSync(file, pattern(5000));
    const seen: [number, number][] = [];
    await cloud.uploadFile(file, "edit/test/clip.mov", (sent, total) => seen.push([sent, total]));
    expect(mock.cloud.objects.get("edit/test/clip.mov")?.length).toBe(5000);
    expect(mock.cloud.contentTypes.get("edit/test/clip.mov")).toBe("video/quicktime");
    expect(seen.at(-1)).toEqual([5000, 5000]);
    const put = mock.calls(/^\/r2\/edit\/test\/clip\.mov$/, "PUT")[0]!;
    expect(put.headers.get("content-length")).toBe("5000");
    expect(put.headers.get("transfer-encoding")).toBeNull();
    // The relay was asked with the bearer token, in a header.
    expect(mock.calls("/v1/cloud/r2/url").at(-1)!.headers.get("authorization")).toBe("Bearer cloud-token");
    expect(diag.lines(200).some((line) => line.message.includes("X-Amz-Signature"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("big files go up in parts, a failed part is retried with a fresh URL, and progress only grows", async () => {
  const { dir, cleanup } = scratch("cloud-multipart");
  try {
    cloud.timing.filePart = MIB;
    const data = pattern(2 * MIB + 12_345);
    const file = `${dir}/big.mp4`;
    fs.writeFileSync(file, data);
    // One part's first try fails.
    mock.on("PUT", /^\/r2\/edit\/test\/big\.mp4$/, () => new Response("<Error><Code>InternalError</Code><Message>try again</Message></Error>", { status: 500 }), 1);
    const before = mock.calls("/v1/cloud/r2/multipart/urls").length;
    const seen: number[] = [];
    await cloud.uploadFile(file, "edit/test/big.mp4", (sent) => seen.push(sent));
    expect(Buffer.from(mock.cloud.objects.get("edit/test/big.mp4")!).equals(Buffer.from(data))).toBe(true);
    expect(mock.calls("/v1/cloud/r2/multipart/urls").length - before).toBe(4);
    expect(seen.every((sent, index) => index === 0 || sent >= seen[index - 1]!)).toBe(true);
    expect(seen.at(-1)).toBe(data.length);
    expect(diag.lines(50).some((line) => line.message.includes("failed (try 1): R2 refused the upload (500): InternalError: try again"))).toBe(true);
  } finally {
    cleanup();
  }
});

test("a stream that breaks after a part aborts its upload and stores nothing", async () => {
  cloud.timing.streamPart = MIB;
  let given = 0;
  const failing: cloud.Source = {
    async read(max) {
      if (given >= MIB + 10) throw new Error("Drive went away");
      const n = Math.min(max, MIB + 10 - given);
      given += n;
      return new Uint8Array(n).fill(7);
    },
  };
  const aborts = mock.calls("/v1/cloud/r2/multipart/abort").length;
  await expect(cloud.uploadStream(failing, "edit/test/broken.bin", null)).rejects.toThrow("reading the upload: Drive went away");
  expect(mock.calls("/v1/cloud/r2/multipart/abort").length).toBe(aborts + 1);
  expect(await cloud.head("edit/test/broken.bin")).toBeNull();
  expect(mock.cloud.uploads.size).toBe(0);
});

test("downloads resume from the partial file while the object is unchanged, and start over when it changed", async () => {
  const { dir, cleanup } = scratch("cloud-get");
  try {
    const data = pattern(300_000);
    mock.cloud.put("edit/test/get.bin", data);
    const dest = `${dir}/sub/get.bin`;
    const object = (await cloud.head("edit/test/get.bin"))!;
    // A download cut short earlier: the first 100 kB, of this version.
    fs.mkdirSync(`${dir}/sub`, { recursive: true });
    fs.writeFileSync(`${dest}.partial`, data.subarray(0, 100_000));
    fs.writeFileSync(`${dest}.partial.etag`, object.etag!);
    await cloud.download("edit/test/get.bin", dest);
    expect(Buffer.from(fs.readFileSync(dest)).equals(Buffer.from(data))).toBe(true);
    const get = mock.calls(/^\/r2\/edit\/test\/get\.bin$/, "GET").at(-1)!;
    expect(get.headers.get("range")).toBe("bytes=100000-");
    expect(get.headers.get("if-range")).toBe(object.etag);
    expect(fs.existsSync(`${dest}.partial`) || fs.existsSync(`${dest}.partial.etag`)).toBe(false);
    // Bytes of another version are thrown away first.
    const other = `${dir}/other.bin`;
    fs.writeFileSync(`${other}.partial`, new Uint8Array(100_000).fill(1));
    fs.writeFileSync(`${other}.partial.etag`, '"old"');
    await cloud.download("edit/test/get.bin", other);
    expect(Buffer.from(fs.readFileSync(other)).equals(Buffer.from(data))).toBe(true);
    // An object that changes under a resumed download (R2 ignores If-Range): refused, the partial dropped.
    const third = `${dir}/third.bin`;
    fs.writeFileSync(`${third}.partial`, data.subarray(0, 10));
    fs.writeFileSync(`${third}.partial.etag`, object.etag!);
    mock.on("GET", /^\/r2\/edit\/test\/get\.bin$/, () => new Response(data.subarray(10), { status: 206, headers: { etag: '"new"' } }), 4);
    await expect(cloud.download("edit/test/get.bin", third)).rejects.toThrow("edit/test/get.bin changed while downloading; download it again");
    expect(fs.existsSync(`${third}.partial`)).toBe(false);
    // An empty object is an empty file.
    mock.cloud.put("edit/test/empty.bin", new Uint8Array());
    await cloud.download("edit/test/empty.bin", `${dir}/empty.bin`);
    expect(fs.statSync(`${dir}/empty.bin`).size).toBe(0);
    await expect(cloud.download("edit/test/none.bin", `${dir}/none.bin`)).rejects.toThrow("edit/test/none.bin isn't in the cloud");
  } finally {
    cleanup();
  }
});

test("lists follow the relay's cursor, deletes go in batches, and bad keys never leave", async () => {
  mock.cloud.listPage = 2;
  try {
    for (let n = 0; n < 5; n++) mock.cloud.put(`edit/test/list/${n}.bin`, "x");
    const listed = await cloud.list("edit/test/list/");
    expect(listed.map((object) => object.key)).toEqual([0, 1, 2, 3, 4].map((n) => `edit/test/list/${n}.bin`));
    const keys = Array.from({ length: 45 }, (_, n) => `edit/test/list/${n}.bin`);
    const before = mock.calls("/v1/cloud/r2/delete").length;
    await cloud.remove(keys);
    expect(mock.calls("/v1/cloud/r2/delete").length - before).toBe(2);
    expect(await cloud.list("edit/test/list/")).toEqual([]);
  } finally {
    mock.cloud.listPage = 1000;
  }
  await expect(cloud.presign("edit/../x", "GET")).rejects.toThrow('not a cloud key Edit may use: "edit/../x"');
  await expect(cloud.list("repack/")).rejects.toThrow('not a cloud prefix Edit may use: "repack/"');
});

test("convex calls keep their failure apart: offline, refused by the relay, thrown by the function", async () => {
  await cloud.mutation("edit:acquireLock", { projectId: "p1-1", holder: "kenobi" });
  await expect(cloud.mutation("edit:acquireLock", { projectId: "p1-1", holder: "yoda" })).resolves.toMatchObject({ acquired: false, heldBy: "kenobi" });
  const thrown = await cloud.convexCall("mutation", "edit:putMedia", { source: "sha256:x" }, 15).catch((error: unknown) => error as cloud.ConvexFailure);
  expect(thrown).toBeInstanceOf(cloud.ConvexFailure);
  expect((thrown as cloud.ConvexFailure).code).toBe("invalid");
  expect((thrown as cloud.ConvexFailure).message).toBe("Convex: New footage needs a name, originalKey and size.");
  const refused = await cloud.convexCall("query", "repack:secrets", {}, 15).catch((error: unknown) => error as cloud.ConvexFailure);
  expect((refused as cloud.ConvexFailure).kind).toBe("relay");
  expect((refused as cloud.ConvexFailure).message).toBe("Only edit: functions can be called. (403)");
  await expect(cloud.convexCall("subscribe", "edit:x", {}, 15)).rejects.toThrow("not a Convex function kind: subscribe");
  const back = mock.useEnv({ EDIT_RELAY_URL: "http://127.0.0.1:9" });
  try {
    const offline = await cloud.convexCall("query", "edit:getProject", { projectId: "x" }, 5).catch((error: unknown) => error as cloud.ConvexFailure);
    expect((offline as cloud.ConvexFailure).kind).toBe("unreachable");
    expect((offline as cloud.ConvexFailure).message.startsWith("could not reach Edit's relay")).toBe(true);
  } finally {
    back();
  }
});

test("edit cloud … prints what the relay answered, and refuses without a token", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const io: cloud.CliIo = { out: (text) => out.push(text), err: (text) => err.push(text), stdin: () => new Blob(["streamed"]).stream() };
  mock.cloud.put("edit/test/cli.txt", "hello", "text/plain");
  await cloud.runCli(["head", "edit/test/cli.txt"], io);
  expect(JSON.parse(out.pop()!)).toEqual({ contentType: "text/plain", etag: (await cloud.head("edit/test/cli.txt"))!.etag, size: 5 });
  await cloud.runCli(["put", "-", "edit/test/stdin.txt"], io);
  expect(JSON.parse(out.pop()!)).toEqual({ key: "edit/test/stdin.txt", size: 8 });
  expect(mock.cloud.text("edit/test/stdin.txt")).toBe("streamed");
  await cloud.runCli(["convex", "query", "edit:getMedia", '{"source":"nope"}'], io);
  expect(out.pop()).toBe("null\n");
  await cloud.runCli([], io);
  expect(out.pop()).toBe(cloud.CLI_HELP);
  await expect(cloud.runCli(["url"], io)).rejects.toThrow(`give a key\n\n${cloud.CLI_HELP}`);
  await expect(cloud.runCli(["url", "edit/x", "POST"], io)).rejects.toThrow("unknown method POST");
  const back = mock.useEnv({ EDIT_RELAY_TOKEN: undefined });
  try {
    await expect(cloud.runCli(["ls", "edit/"], io)).rejects.toThrow("set EDIT_RELAY_TOKEN (the relay's CLOUD_TOKEN) first");
  } finally {
    back();
  }
});

/**
 * Against a real relay (EDIT_RELAY_URL / EDIT_RELAY_TOKEN; e.g. `wrangler dev`
 * with apps/relay/.dev.vars) with EDIT_CLOUD_LIVE=1. Uses and cleans up
 * `edit/test/live-<pid>/`.
 */
test.skipIf(process.env.EDIT_CLOUD_LIVE !== "1")("live_stream_round_trip_and_failed_stream_aborts", async () => {
  restore();
  try {
    expect(cloud.enabled()).toBe(true);
    const prefix = `edit/test/live-${process.pid}/`;
    const data = pattern(2 * cloud.STREAM_PART + 12_345);
    const key = `${prefix}stream.bin`;
    const sent = await cloud.uploadStream(cloud.bytesSource(data), key, data.length);
    expect(sent).toBe(data.length);
    expect((await cloud.head(key))!.size).toBe(sent);
    const { dir, cleanup } = scratch("cloud-live");
    try {
      await cloud.download(key, `${dir}/stream.bin`);
      expect(Buffer.from(fs.readFileSync(`${dir}/stream.bin`)).equals(Buffer.from(data))).toBe(true);
    } finally {
      cleanup();
    }
    let left = cloud.STREAM_PART + 10;
    const failing: cloud.Source = {
      async read(max) {
        if (left === 0) throw new Error("Drive went away");
        const n = Math.min(max, left);
        left -= n;
        return new Uint8Array(n).fill(7);
      },
    };
    const broken = `${prefix}broken.bin`;
    await expect(cloud.uploadStream(failing, broken, null)).rejects.toThrow("Drive went away");
    expect(await cloud.head(broken)).toBeNull();
    const listed = (await cloud.list(prefix)).map((object) => object.key);
    expect(listed).toEqual([key]);
    await cloud.remove(listed);
    expect(await cloud.list(prefix)).toEqual([]);
  } finally {
    restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
  }
});
