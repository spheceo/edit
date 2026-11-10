import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import * as fs from "node:fs";

import * as cloud from "../src/cloud.ts";
import * as diag from "../src/diag.ts";
import { scratch } from "./helpers/home.ts";
import { etagOf } from "./mocks/cloud.ts";
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
  cloud.timing.resumableFrom = 512 * MIB;
  cloud.keepUploadJournalsIn(null);
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

test("an upload nobody waits for holds its parts while a share has the line out, and goes on after; one stopped while it waits ends", async () => {
  const { dir, cleanup } = scratch("cloud-line");
  try {
    cloud.timing.filePart = MIB;
    const data = pattern(3 * MIB + 99);
    for (const resumable of [false, true]) {
      // Both ways a big file goes up: in one run, and resumably (an export is over the resumable size).
      cloud.timing.resumableFrom = resumable ? MIB : 512 * MIB;
      cloud.keepUploadJournalsIn(resumable ? `${dir}/uploads` : null);
      const key = `edit/test/behind-${resumable ? "resumable" : "plain"}.mp4`;
      const file = `${dir}/export-${resumable}.mp4`;
      fs.writeFileSync(file, data);
      const puts = () => mock.calls(`/r2/${key}`, "PUT").length;
      let release = () => {};
      const share = cloud.first(() => new Promise<void>((resolve) => (release = resolve)));
      expect(cloud.lineTaken()).toBe(true);
      const sent = cloud.uploadFile(file, key, undefined, undefined, true);
      await Bun.sleep(60);
      expect(puts()).toBe(0);
      // What someone waits on isn't held: a review copy goes up meanwhile.
      const copy = `${dir}/copy-${resumable}.mp4`;
      fs.writeFileSync(copy, pattern(2 * MIB + 5));
      await cloud.uploadFile(copy, `${key}.copy.mp4`);
      expect(mock.cloud.objects.has(`${key}.copy.mp4`)).toBe(true);
      expect(puts()).toBe(0);
      release();
      await share;
      await sent;
      expect(cloud.lineTaken()).toBe(false);
      expect(Buffer.from(mock.cloud.objects.get(key)!).equals(Buffer.from(data))).toBe(true);
    }
    // Stopped while it waits (a newer export of the same file): it ends, and nothing went up.
    let release = () => {};
    const share = cloud.first(() => new Promise<void>((resolve) => (release = resolve)));
    const stop = new AbortController();
    const file = `${dir}/stopped.mp4`;
    fs.writeFileSync(file, data);
    const sent = cloud.uploadFile(file, "edit/test/behind-stopped.mp4", undefined, stop.signal, true);
    await Bun.sleep(30);
    stop.abort();
    await expect(sent).rejects.toThrow("cancelled");
    expect(mock.cloud.objects.has("edit/test/behind-stopped.mp4")).toBe(false);
    release();
    await share;
  } finally {
    cloud.keepUploadJournalsIn(null);
    cleanup();
  }
});

/** A big file whose upload stops at part 4 (R2 refuses parts 4 and 5 until it's let go): parts 1 to 3 are up, its journal kept. */
async function stoppedUpload(dir: string, key: string): Promise<{ file: string; data: Uint8Array; journal: () => string[] }> {
  cloud.timing.filePart = MIB;
  cloud.timing.resumableFrom = MIB;
  cloud.keepUploadJournalsIn(`${dir}/uploads`);
  const data = pattern(4 * MIB + 777);
  const file = `${dir}/original.mp4`;
  fs.writeFileSync(file, data);
  let refusing = true;
  mock.on("PUT", `/r2/${key}`, (request) => {
    const n = Number(request.query.get("partNumber"));
    if (refusing && n >= 4) return new Response("<Error><Code>AccessDenied</Code><Message>not now</Message></Error>", { status: 403 });
    const upload = mock.cloud.uploads.get(request.query.get("uploadId")!);
    if (upload === undefined) return new Response("<Error><Code>NoSuchUpload</Code><Message>The specified multipart upload does not exist.</Message></Error>", { status: 404 });
    upload.parts.set(n, request.body);
    return new Response(null, { status: 200, headers: { etag: etagOf(request.body) } });
  });
  await expect(cloud.uploadFile(file, key)).rejects.toThrow("403");
  refusing = false;
  return { file, data, journal: () => (fs.existsSync(`${dir}/uploads`) ? fs.readdirSync(`${dir}/uploads`) : []) };
}

test("a big upload that stops picks up where it was: only the parts R2 doesn't hold go again", async () => {
  const { dir, cleanup } = scratch("cloud-resume");
  try {
    const key = "edit/test/resume.mp4";
    const { file, data, journal } = await stoppedUpload(dir, key);
    expect(journal().length).toBe(1);
    expect(mock.cloud.objects.has(key)).toBe(false);
    const before = mock.calls(`/r2/${key}`, "PUT").length;
    const seen: number[] = [];
    await cloud.uploadFile(file, key, (sent) => seen.push(sent));
    // Parts 4 and 5 only; progress starts from the three already up.
    expect(mock.calls(`/r2/${key}`, "PUT").length - before).toBe(2);
    expect(seen[0]).toBeGreaterThanOrEqual(3 * MIB);
    expect(seen.at(-1)).toBe(data.length);
    expect(Buffer.from(mock.cloud.objects.get(key)!).equals(Buffer.from(data))).toBe(true);
    expect(journal()).toEqual([]);
  } finally {
    cleanup();
  }
});

/**
 * R2 behind a connection that hangs up (Nov 8 audit, item I: "a relay that
 * drops the socket mid-upload"): a raw socket, so the drop is the network's,
 * not an answer. Parts for which `drop` says so are cut off as their headers
 * arrive; the rest land in the mock's upload.
 */
function droppingR2(drop: (part: number) => boolean): { url: (key: string, uploadId: string, part: number) => string; sent: number[]; stop: () => void } {
  const sent: number[] = [];
  const server = Bun.listen<{ buffer: Buffer }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffer: Buffer.alloc(0) };
      },
      data(socket, chunk) {
        socket.data.buffer = Buffer.concat([socket.data.buffer, chunk]);
        const end = socket.data.buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = socket.data.buffer.subarray(0, end).toString();
        const url = new URL(head.split(" ")[1]!, "http://r2");
        const part = Number(url.searchParams.get("partNumber"));
        if (drop(part)) {
          socket.terminate();
          return;
        }
        const length = Number(/content-length: *(\d+)/i.exec(head)?.[1] ?? 0);
        if (socket.data.buffer.length < end + 4 + length) return;
        const body = new Uint8Array(socket.data.buffer.subarray(end + 4, end + 4 + length));
        socket.data.buffer = Buffer.alloc(0);
        sent.push(part);
        mock.cloud.uploads.get(url.searchParams.get("uploadId")!)!.parts.set(part, body);
        socket.write(`HTTP/1.1 200 OK\r\netag: ${etagOf(body)}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
        socket.end();
      },
    },
  });
  return {
    url: (key, uploadId, part) => `http://127.0.0.1:${server.port}/${key}?partNumber=${part}&uploadId=${uploadId}`,
    sent,
    stop: () => server.stop(true),
  };
}

test("a big upload whose connection keeps dropping stops, then picks up from the part it was on: nothing sent twice", async () => {
  const { dir, cleanup } = scratch("cloud-dropped");
  let online = false;
  let done = false;
  const r2 = droppingR2((part) => !online && part >= 4);
  try {
    cloud.timing.filePart = MIB;
    cloud.timing.resumableFrom = MIB;
    cloud.keepUploadJournalsIn(`${dir}/uploads`);
    const key = "edit/test/dropped.mp4";
    const data = pattern(4 * MIB + 321);
    const file = `${dir}/original.mp4`;
    fs.writeFileSync(file, data);
    // This file's part URLs through the dropping socket; every other upload's (and this one's after the test) as the mock gives them.
    mock.on("POST", "/v1/cloud/r2/multipart/urls", (request) => {
      const body = request.json<{ key: string; uploadId: string; parts: number[] }>();
      const url = (part: number) => (body.key === key && !done ? r2.url(body.key, body.uploadId, part) : mock.cloud.url(body.key, { partNumber: String(part), uploadId: body.uploadId }));
      return Response.json({ urls: Object.fromEntries(body.parts.map((part) => [String(part), url(part)])) });
    });
    // The connection drops on part 4 every time it's tried: a passing failure, asked again, then the upload stops.
    await expect(cloud.uploadFile(file, key)).rejects.toThrow();
    expect(diag.lines(40).some((line) => /part 4 of edit\/test\/dropped\.mp4 failed \(try 1\)/.test(line.message))).toBe(true);
    expect(mock.cloud.objects.has(key)).toBe(false);
    expect(r2.sent.toSorted()).toEqual([1, 2, 3]);
    expect(fs.readdirSync(`${dir}/uploads`).length).toBe(1);
    // Back online (the Mac's Wi-Fi, a restart): only what R2 doesn't hold goes.
    online = true;
    await cloud.uploadFile(file, key);
    expect(r2.sent.toSorted()).toEqual([1, 2, 3, 4, 5]);
    expect(Buffer.from(mock.cloud.objects.get(key)!).equals(Buffer.from(data))).toBe(true);
    expect(fs.readdirSync(`${dir}/uploads`)).toEqual([]);
  } finally {
    done = true;
    r2.stop();
    cleanup();
  }
});

test("an upload R2 let go of, or a file that changed, begins again", async () => {
  const { dir, cleanup } = scratch("cloud-resume-again");
  try {
    const key = "edit/test/again.mp4";
    const { file, data, journal } = await stoppedUpload(dir, key);
    // R2 dropped the unfinished upload (after 7 days): the parts are refused, so it all goes again.
    mock.cloud.uploads.clear();
    const before = mock.calls(`/r2/${key}`, "PUT").length;
    await cloud.uploadFile(file, key);
    // Part 4 (and maybe 5, sent beside it) refused, then all five again.
    expect(mock.calls(`/r2/${key}`, "PUT").length - before).toBeGreaterThanOrEqual(6);
    expect(diag.lines(20).some((line) => line.message.includes("couldn't be picked up"))).toBe(true);
    expect(Buffer.from(mock.cloud.objects.get(key)!).equals(Buffer.from(data))).toBe(true);
    expect(journal()).toEqual([]);
    // A journal of another version of the file is never picked up.
    const second = await stoppedUpload(dir, "edit/test/again2.mp4");
    const changed = pattern(4 * MIB + 778).map((value) => value ^ 1);
    fs.writeFileSync(second.file, changed);
    const aborts = mock.calls("/v1/cloud/r2/multipart/abort").length;
    await cloud.uploadFile(second.file, "edit/test/again2.mp4");
    expect(Buffer.from(mock.cloud.objects.get("edit/test/again2.mp4")!).equals(Buffer.from(changed))).toBe(true);
    expect(mock.calls("/v1/cloud/r2/multipart/abort").length).toBe(aborts + 1);
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
    await expect(cloud.runCli(["ls", "edit/"], io)).rejects.toThrow("`edit cloud` needs EDIT_RELAY_TOKEN (a local relay's token): against the team's relay, use the running Edit (it's signed in)");
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

test("a weak etag (R2 gzips small JSON on the way) is the same object", () => {
  expect(cloud.strongEtag('W/"a172f7b0"')).toBe('"a172f7b0"');
  expect(cloud.strongEtag('"a172f7b0"')).toBe('"a172f7b0"');
});
