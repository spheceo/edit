/**
 * Byte-range reads for the decoder workers. Mediabunny's `UrlSource` asks for
 * `bytes=N-` and aborts the stream on every jump, and reads a seek's packets one
 * round trip at a time. Over Wi-Fi that made each scrub wait on bytes that were
 * thrown away. Here every request names its end and covers an aligned block, so
 * one or two requests fetch a whole GOP and keep-alive connections are reused.
 */
export const BLOCK = 256 * 1024;
const MAX_BLOCKS = 64;
const LOOKAHEAD = 3;
/** Blocks fetched past a sequential read, so playback never waits on a round trip. */
const READAHEAD = 2;
const RETRIES = 8;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** How the media reads went in this worker (for problem reports: a slow connection shows here). */
export interface NetworkStats {
  requests: number;
  bytes: number;
  /** Time spent waiting on reads, summed. */
  ms: number;
  slowestMs: number;
  failures: number;
}

export const network: NetworkStats = { requests: 0, bytes: 0, ms: 0, slowestMs: 0, failures: 0 };
const wait = (attempt: number) => new Promise((resolve) => setTimeout(resolve, Math.min(2000, 250 * 2 ** attempt)));

export function rangeReader(url: string, fetcher: Fetch = (input, init) => fetch(input, init)) {
  let size = Infinity;
  /** Recently used blocks, oldest first. */
  const blocks = new Map<number, Promise<Uint8Array>>();
  let previous = -2;

  async function fetchRange(start: number, end: number) {
    for (let attempt = 0; ; attempt++) {
      const started = performance.now();
      try {
        const response = await fetcher(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
        // 503 is the dev server answering while `edit serve` restarts.
        if (response.status === 503 && attempt < RETRIES) throw new Error("restarting");
        if (response.status !== 200 && response.status !== 206) throw new Error(`HTTP ${response.status}`);
        const body = new Uint8Array(await response.arrayBuffer());
        const took = performance.now() - started;
        network.requests++;
        network.bytes += body.byteLength;
        network.ms += took;
        network.slowestMs = Math.max(network.slowestMs, took);
        return response.status === 200 ? body.slice(start, end) : body;
      } catch (error) {
        network.failures++;
        if (attempt >= RETRIES) throw error;
        await wait(attempt);
      }
    }
  }

  function block(index: number) {
    const loading = load(index);
    if (index === previous + 1) for (let i = 1; i <= READAHEAD && (index + i) * BLOCK < size; i++) load(index + i);
    previous = index;
    // The block being read stays the most recently used.
    blocks.delete(index);
    blocks.set(index, loading);
    return loading;
  }

  function load(index: number) {
    let loading = blocks.get(index);
    if (loading) blocks.delete(index);
    else {
      loading = fetchRange(index * BLOCK, Math.min(size, (index + 1) * BLOCK));
      // A failed block is fetched again next time rather than cached.
      loading.catch(() => { if (blocks.get(index) === loading) blocks.delete(index); });
    }
    blocks.set(index, loading);
    while (blocks.size > MAX_BLOCKS) blocks.delete(blocks.keys().next().value!);
    return loading;
  }

  return {
    async getSize() {
      for (let attempt = 0; ; attempt++) {
        const response = await fetcher(url, { headers: { Range: "bytes=0-0" } }).catch((error: unknown) => {
          if (attempt >= RETRIES) throw error;
          return null;
        });
        if (response && response.status !== 503) {
          void response.body?.cancel().catch(() => {});
          const header = response.headers.get("content-range")?.split("/")[1] ?? response.headers.get("content-length");
          const total = header === null ? NaN : Number(header);
          if (!response.ok || !Number.isFinite(total)) throw new Error(`HTTP ${response.status}`);
          return size = total;
        }
        if (attempt >= RETRIES) throw new Error("HTTP 503");
        await wait(attempt);
      }
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
          for (let i = first + pending.length; i <= Math.min(last, index + LOOKAHEAD); i++) pending.push(block(i));
          const bytes = await pending[index - first];
          const offset = index * BLOCK;
          controller.enqueue(bytes.subarray(Math.max(0, start - offset), Math.min(bytes.length, end - offset)));
          if (index++ === last) controller.close();
        },
      });
    },
  };
}
