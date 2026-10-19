/**
 * Byte-range reads for the decoder workers. Mediabunny's `UrlSource` asks for
 * `bytes=N-` and aborts the stream on every jump, and reads a seek's packets one
 * round trip at a time. Over Wi-Fi that made each scrub wait on bytes that were
 * thrown away. Here every request names its end and covers an aligned block, so
 * one or two requests fetch a whole GOP and keep-alive connections are reused.
 *
 * Blocks are small (a scrub over a remote link wants one keyframe, ~30–70 KB, not
 * a quarter megabyte) and cached for the whole worker by URL, with each file's
 * size: a file opened again (scrubbing back across a cut) costs no round trip.
 */
export const BLOCK = 64 * 1024;
/** Decoded media blocks kept per worker, across every file. */
const CACHE_BYTES = 192 * 1024 * 1024;
const LOOKAHEAD = 6;
/** Blocks fetched past a sequential read while playing, so playback never waits on a round trip. */
const READAHEAD = 8;
const RETRIES = 8;
/**
 * The most blocks one request fetches: neighbouring blocks a read or a
 * read-ahead needs come in one request, not one each. Over Tailscale (50 ms
 * a round trip) a preview played from another machine waited on eight
 * requests for every eight blocks it read ahead and fell behind ("loading
 * frame"); one request costs one round trip.
 */
const RUN = 16;
/** A read that hasn't finished by then is abandoned and tried again: a hung
 * connection must not leave the preview waiting on a frame for good. */
const READ_TIMEOUT_MS = 20_000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** How the media reads went in this worker (for problem reports: a slow connection shows here). */
export interface NetworkStats {
  requests: number;
  bytes: number;
  /** Time spent waiting on reads, summed. */
  ms: number;
  slowestMs: number;
  failures: number;
  /** Blocks served from the worker's cache instead of the network. */
  cached: number;
}

export const network: NetworkStats = { requests: 0, bytes: 0, ms: 0, slowestMs: 0, failures: 0, cached: 0 };
const wait = (attempt: number) => new Promise((resolve) => setTimeout(resolve, Math.min(2000, 250 * 2 ** attempt)));

/** Every file's size, learnt from its first read. */
const sizes = new Map<string, number>();
/** Recently used blocks of every file (`url#index`), oldest first. */
const blocks = new Map<string, Promise<Uint8Array>>();

/** Whether reads are for playback (sequential: read ahead) or a scrub (only what's asked). */
let streaming = false;
export function setStreaming(on: boolean) { streaming = on; }

/** Drops a file's blocks (its URL serves something else now). */
export function forgetBlocks(url: string) {
  sizes.delete(url);
  const prefix = `${url}#`;
  for (const key of [...blocks.keys()]) if (key.startsWith(prefix)) blocks.delete(key);
}

function remember(key: string, loading: Promise<Uint8Array>) {
  blocks.delete(key);
  blocks.set(key, loading);
  while (blocks.size * BLOCK > CACHE_BYTES) blocks.delete(blocks.keys().next().value!);
}

export function rangeReader(url: string, fetcher: Fetch = (input, init) => fetch(input, init)) {
  let previous = -2;
  const size = () => sizes.get(url) ?? Infinity;

  async function fetchRange(start: number, end: number) {
    for (let attempt = 0; ; attempt++) {
      const started = performance.now();
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(new Error(`no answer in ${READ_TIMEOUT_MS / 1000} s`)), READ_TIMEOUT_MS);
      try {
        const response = await fetcher(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal: abort.signal });
        // 503 is the dev server answering while `edit serve` restarts.
        if (response.status === 503 && attempt < RETRIES) throw new Error("restarting");
        if (response.status !== 200 && response.status !== 206) throw new Error(`HTTP ${response.status} reading ${url} (bytes ${start}-${end - 1})`);
        const total = Number(response.headers.get("content-range")?.split("/")[1] ?? (response.status === 200 ? response.headers.get("content-length") : NaN));
        if (Number.isFinite(total)) sizes.set(url, total);
        const body = new Uint8Array(await response.arrayBuffer());
        clearTimeout(timer);
        const took = performance.now() - started;
        network.requests++;
        network.bytes += body.byteLength;
        network.ms += took;
        network.slowestMs = Math.max(network.slowestMs, took);
        return response.status === 200 ? body.slice(start, end) : body;
      } catch (error) {
        clearTimeout(timer);
        network.failures++;
        if (attempt >= RETRIES) throw abort.signal.aborted ? new Error(`${abort.signal.reason} reading ${url}`) : error;
        await wait(attempt);
      }
    }
  }

  /** Block `index` (with the blocks after it up to `upTo`, and while playing sequentially the read-ahead, in the same request). */
  function block(index: number, upTo = index) {
    const ahead = streaming && index === previous + 1 ? index + READAHEAD : index;
    const loading = load(index, Math.max(upTo, ahead));
    previous = index;
    return loading;
  }

  /**
   * Block `index`, fetched (if it isn't here) together with the missing
   * blocks after it up to `upTo` in one request; each block is cached on its own.
   */
  function load(index: number, upTo = index) {
    const key = `${url}#${index}`;
    const known = blocks.get(key);
    if (known) {
      network.cached++;
      remember(key, known);
      // Read-ahead still wanted past it.
      if (upTo > index) fetchRun(index + 1, upTo);
      return known;
    }
    fetchRun(index, upTo);
    return blocks.get(key)!;
  }

  /** The missing blocks from `from` (up to `upTo`, `RUN` at most, the file's end) in one request. */
  function fetchRun(from: number, upTo: number) {
    let first = from;
    while (first <= upTo && blocks.has(`${url}#${first}`)) first++;
    if (first > upTo || first * BLOCK >= size()) return;
    // A file's size comes with its first read: until then, one block.
    let last = first;
    if (sizes.has(url)) {
      while (last + 1 <= upTo && last + 1 - first < RUN && (last + 1) * BLOCK < size() && !blocks.has(`${url}#${last + 1}`)) last++;
    }
    const whole = fetchRange(first * BLOCK, Math.min(size(), (last + 1) * BLOCK));
    for (let index = first; index <= last; index++) {
      const key = `${url}#${index}`;
      const offset = (index - first) * BLOCK;
      const part = whole.then((bytes) => bytes.slice(offset, Math.min(bytes.length, offset + BLOCK)));
      // A failed block is fetched again next time rather than cached.
      part.catch(() => { if (blocks.get(key) === part) blocks.delete(key); });
      remember(key, part);
    }
  }

  return {
    /** The size from an earlier read of this file, else from reading its first block (needed next anyway). */
    async getSize() {
      if (sizes.has(url)) return sizes.get(url)!;
      await load(0);
      const known = sizes.get(url);
      if (known === undefined) throw new Error(`no size for ${url}`);
      return known;
    },
    /**
     * Blocks load a few ahead of the one being handed over, so an abandoned read
     * leaves little in flight and a large prefetch doesn't queue ahead of a seek.
     */
    read(start: number, end: number): ReadableStream<Uint8Array> {
      const first = Math.floor(start / BLOCK);
      const last = Math.floor((end - 1) / BLOCK);
      const pending: Promise<Uint8Array>[] = [];
      let index = first;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const upTo = Math.min(last, index + LOOKAHEAD);
          // The blocks this read still needs come in one request with the first of them.
          for (let i = first + pending.length; i <= upTo; i++) pending.push(block(i, upTo));
          const bytes = await pending[index - first];
          const offset = index * BLOCK;
          controller.enqueue(bytes.subarray(Math.max(0, start - offset), Math.min(bytes.length, end - offset)));
          if (index++ === last) controller.close();
        },
      });
    },
  };
}
