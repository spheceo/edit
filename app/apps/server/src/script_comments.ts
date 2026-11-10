// The producer's comments on a script, at the moment they're about (Sphe,
// Nov 10: "leave notes which the edit agent will pick up and follow at that
// exact moment"; JJ: notes "where the editor understands and actually listens
// to them"). Script mode keeps each comment on the words it's about; the edit's
// blocks keep them as `comments` (writer_handoff.commentsOf, kept in step by
// script_sync.syncComments), and get_edit_context gives the agent each one
// with the frame those words are heard at: the voice-over's for a cut-in, the
// footage's for a range, else where they fall in the card or the clip's start.

/** A word as it's compared: lower case, letters and digits only. */
const token = (word: string): string => word.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");

const tokens = (text: string): string[] => text.split(/\s+/).map(token).filter((one) => one !== "");

/**
 * Where `quote` starts among `heard` (each a word as transcribed): the index
 * of the run that matches the most of its words in order, at least three (or
 * all of a shorter quote); null when none does.
 */
export function quoteStart(heard: string[], quote: string): number | null {
  const wanted = tokens(quote);
  if (wanted.length === 0) return null;
  const said = heard.map(token);
  let best: [number, number] | null = null;
  for (let at = 0; at < said.length; at++) {
    if (said[at] === "") continue;
    // Words the transcript splits or joins differently are passed over on its side.
    let matched = 0;
    let index = at;
    while (index < said.length && matched < wanted.length) {
      if (said[index] === "") index++;
      else if (said[index] === wanted[matched]) {
        matched++;
        index++;
      } else break;
    }
    if (best === null || matched > best[1]) best = [at, matched];
    if (matched === wanted.length) break;
  }
  return best !== null && best[1] >= Math.min(wanted.length, 3) ? best[0] : null;
}

/** Where `quote` falls through `text`, as a share of it (0 at its start), or null when it isn't there. */
export function shareThrough(text: string, quote: string): number | null {
  const at = text.toLowerCase().indexOf(quote.trim().toLowerCase());
  return at < 0 || text.length === 0 ? null : at / text.length;
}

/** A comment as the agent is given it. */
export interface Placed {
  /** The frame its words are said at (the block's start when it's on all of it). */
  at: number;
  text: string;
  on?: string;
  cut_in?: number;
  footage_block?: number;
}

/** A clip that plays words from a transcript (seconds of its media). */
export interface Heard {
  start: number;
  end: number;
  sourceIn: number;
  speed: number;
  fps: number;
  words: { text: string; start: number; end: number }[];
}

/**
 * The frame `on` is said at in `heard` (only words the clip plays), or null.
 */
export function heardAt(heard: Heard, on: string): number | null {
  const to = heard.sourceIn + ((heard.end - heard.start) / heard.fps) * heard.speed;
  const words = heard.words.filter((word) => word.end > heard.sourceIn && word.start < to);
  const at = quoteStart(
    words.map((word) => word.text),
    on,
  );
  if (at === null) return null;
  const frame = heard.start + Math.round(((words[at]!.start - heard.sourceIn) / heard.speed) * heard.fps);
  return Math.min(Math.max(frame, heard.start), heard.end - 1);
}
