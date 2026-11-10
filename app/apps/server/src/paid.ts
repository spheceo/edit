// Paid requests in flight, from the moment one is sent until its answer is
// kept on disk: what Edit waits for before it restarts itself (an update,
// remote support's restart), so a restart never pays for the same request
// twice. A request cut by the restart had no saved answer, so the resumed
// work asked for it again: a transcription piece, a voice-over line, each
// billed twice (Nov 10 audit of restarts). Once the restart is under way,
// new requests wait for it; it happens within seconds.

let inFlight = 0;
const settled: (() => void)[] = [];
/** Set once a restart has begun: new requests wait for it (the process is about to become the new one). */
let holding: Promise<never> | null = null;

/** A paid request about to go: held while a restart is under way. Every `enter` has its `leave`. */
export async function enter(): Promise<void> {
  if (holding !== null) await holding;
  inFlight++;
}

/** The request's answer is kept (or it failed). */
export function leave(): void {
  inFlight = Math.max(inFlight - 1, 0);
  if (inFlight === 0) for (const done of settled.splice(0)) done();
}

/** Runs one paid request and the saving of its answer; held while a restart is under way. */
export async function paid<T>(work: () => Promise<T>): Promise<T> {
  await enter();
  try {
    return await work();
  } finally {
    leave();
  }
}

/** Requests sent and not yet saved. */
export function count(): number {
  return inFlight;
}

/**
 * Before a restart: no new paid request goes out, and the ones in flight get
 * up to `withinMs` to answer and be saved. Whether they all did.
 */
export async function settle(withinMs: number): Promise<boolean> {
  holding ??= new Promise<never>(() => {});
  if (inFlight === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = await Promise.race([
    new Promise<boolean>((resolve) => settled.push(() => resolve(true))),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), withinMs);
    }),
  ]);
  clearTimeout(timer);
  return done;
}

/** Tests: back to no restart under way. */
export function reset(): void {
  holding = null;
  inFlight = 0;
  settled.length = 0;
}
