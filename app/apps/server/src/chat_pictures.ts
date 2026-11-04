// Pictures in an agent's answer (Sphe, Nov 4: "all of the agents have the
// ability to inline images… if I ask an agent, 'Hey, can you just include an
// image for me?'"). An agent writes Markdown, and a picture as Markdown:
// ![what it is](where it is). Where it is is the agent's own: a file on this
// Mac (the pictures it reads, a look it drew) or the id of a picture it works
// with. Each agent's chat turns those into addresses the page (and a teammate
// on another Mac) can load, before the answer is kept; one it can't place is
// left for the page to show as a named picture it couldn't load.

import * as fs from "node:fs";

/** A picture written as Markdown: its words and where it is. */
const PICTURE = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;

/** The image files an agent may hand on: what a browser draws. */
export const PICTURE_FILE = /\.(png|jpe?g|webp|gif)$/i;

/**
 * The answer with each picture's address made one the page can load: `place`
 * answers the address for what the agent wrote (null when it can't). Each
 * distinct source is placed once.
 */
export async function inlinePictures(text: string, place: (source: string) => Promise<string | null>): Promise<string> {
  const sources = new Set([...text.matchAll(PICTURE)].map((match) => match[2]!));
  if (sources.size === 0) return text;
  const placed = new Map<string, string | null>();
  for (const source of sources) {
    let path = source;
    try {
      path = decodeURI(source);
    } catch {
      // As written.
    }
    placed.set(source, await place(path).catch(() => null));
  }
  return text.replace(PICTURE, (_whole, words: string, source: string) => {
    const address = placed.get(source);
    return address ? `![${words}](${address})` : `![${words}](unavailable:${encodeURIComponent(source.split("/").pop() ?? "picture")})`;
  });
}

/** A file the agent named that this Mac has and a browser can show, inside one of `roots`. */
export function pictureFile(path: string, roots: string[]): string | null {
  if (!path.startsWith("/") || !PICTURE_FILE.test(path)) return null;
  let real: string;
  try {
    real = fs.realpathSync(path);
  } catch {
    return null;
  }
  if (!roots.some((root) => real.startsWith(fs.existsSync(root) ? `${fs.realpathSync(root)}/` : `${root}/`))) return null;
  return fs.statSync(real).isFile() ? real : null;
}
