// Who is using the hardware encoder on this computer right now (Nov 8 audit,
// item F; item D will make it one lease with priorities). Exports, review
// copies and smooth renders run in the engine; proxies, Writer's preview pieces
// and the like are FFmpeg run from here. Neither side knew of the other, so on
// JJ's Mac an export and 56 Writer pieces shared the encoder and the pieces'
// pace judge stopped them as "too slow", which was only the export's share.
//
// Work that encodes holds it (`hold`) while it runs; work only another module
// knows about says so through `register`. `shared(self)` is whether anything
// else holds it now, which a pace judge or a timeout reads before it calls a
// slow encode stuck.

/** Encodes started from here, by token: what each is ("an import's proxy"). */
const held = new Map<number, string>();
/** Work other modules know about (an export running), each saying what it is or null. */
const sources = new Set<() => string | null>();
let next = 1;

/** Notes `what` as using the encoder until the function returned is called; its token, for `shared(token)`. */
export function hold(what: string): { token: number; release: () => void } {
  const token = next++;
  held.set(token, what);
  return { token, release: () => void held.delete(token) };
}

/** Adds work only its own module knows about (the export registry); undone by the function returned. */
export function register(what: () => string | null): () => void {
  sources.add(what);
  return () => void sources.delete(what);
}

/** What uses the encoder now, other than `self` (a token from `hold`). */
export function others(self?: number): string[] {
  const out: string[] = [];
  for (const [token, what] of held) if (token !== self) out.push(what);
  for (const source of sources) {
    try {
      const what = source();
      if (what !== null) out.push(what);
    } catch {
      // A source that can't say isn't counted.
    }
  }
  return out;
}

/** Whether anything other than `self` uses the encoder now. */
export function shared(self?: number): boolean {
  return others(self).length > 0;
}

/** Whether anything at all uses it (a wait for the encoder ends when this is false). */
export function busy(): boolean {
  return others().length > 0;
}
