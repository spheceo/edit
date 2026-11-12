// Times in the agent's messages, made something to click (Sphe, Nov 12: "when
// the agent in the chat gives timestamps like 22:00 or 1:44:00 … we pick it up
// and we have the ability to click on it"): a time jumps the player there; a
// range (22:00–23:40, 19:40 to 20:10) plays from its start and stops at its
// end (playback.ts `playRange`).

import type { Root, RootContent, Text, Link } from "mdast";

/** A time or a range found in some text: where it is in the text, and its seconds. */
export interface Found {
  index: number;
  length: number;
  start: number;
  end: number | null;
}

const TIME = String.raw`(?:\d{1,2}:)?\d{1,2}:[0-5]\d(?:\.\d{1,2})?`;
const PATTERN = new RegExp(String.raw`(?<![\d:.])(${TIME})(?:\s*(?:–|—|-|to)\s*(${TIME}))?(?![\d:])`, "gu");

/** "1:44:00", "22:00", "0:17.5" → seconds. */
export function seconds(time: string): number {
  return time.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
}

/** Every time and range in `text`; a range's end after its start, else it's two times. */
export function timesIn(text: string): Found[] {
  const found: Found[] = [];
  for (const match of text.matchAll(PATTERN)) {
    const start = seconds(match[1]!);
    const end = match[2] === undefined ? null : seconds(match[2]);
    if (end !== null && end <= start) {
      found.push({ index: match.index, length: match[1]!.length, start, end: null });
      const second = match[0].lastIndexOf(match[2]!);
      found.push({ index: match.index + second, length: match[2]!.length, start: end, end: null });
      continue;
    }
    found.push({ index: match.index, length: match[0].length, start, end });
  }
  return found;
}

/** The address a found time links to (a hash, so the Markdown keeps it), and back. */
export const timeHref = (found: Pick<Found, "start" | "end">) => `#edit-time=${found.start}${found.end === null ? "" : `-${found.end}`}`;
export function timeOf(href: string | undefined): { start: number; end: number | null } | null {
  const match = /^#edit-time=([\d.]+)(?:-([\d.]+))?$/u.exec(href ?? "");
  return match === null ? null : { start: Number(match[1]), end: match[2] === undefined ? null : Number(match[2]) };
}

type Parent = { children: RootContent[] };

/** A remark plugin: each time in the message's text becomes a link to it (not inside code or another link). */
export function remarkTimes() {
  return (tree: Root) => {
    const walk = (node: Parent) => {
      const out: RootContent[] = [];
      for (const child of node.children) {
        if (child.type === "text") {
          out.push(...split(child));
          continue;
        }
        if (child.type !== "link" && child.type !== "inlineCode" && child.type !== "code" && "children" in child) walk(child as Parent);
        out.push(child);
      }
      node.children = out;
    };
    walk(tree as Parent);
  };
}

function split(node: Text): (Text | Link)[] {
  const found = timesIn(node.value);
  if (found.length === 0) return [node];
  const out: (Text | Link)[] = [];
  let at = 0;
  for (const one of found) {
    if (one.index > at) out.push({ type: "text", value: node.value.slice(at, one.index) });
    out.push({ type: "link", url: timeHref(one), children: [{ type: "text", value: node.value.slice(one.index, one.index + one.length) }] });
    at = one.index + one.length;
  }
  if (at < node.value.length) out.push({ type: "text", value: node.value.slice(at) });
  return out;
}
