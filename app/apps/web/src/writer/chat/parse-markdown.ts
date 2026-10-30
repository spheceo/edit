import type { Definition, PhrasingContent, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { parseClock } from "./clock";

/**
 * The Markdown a chat model writes, parsed into blocks. It covers what
 * answers use (headings, lists, quotes, code, tables, emphasis, links) and
 * `[m:ss]` timestamps. It never produces HTML, so output can't inject markup,
 * and half-written input from a stream parses to something sensible.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "break" }
  | { kind: "strong" | "em" | "strike"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: Inline[] }
  /**
   * `[1:15]`, or a range `[1:15]–[2:00]` that jumps to its start. `[@1:15]`
   * is a position in an edited timeline rather than in the source.
   */
  | {
      kind: "time";
      label: string;
      seconds: number;
      end?: number;
      timeline?: boolean;
    }
  | { kind: "quote"; label: string; text: string };

export type ListItem = { blocks: Block[]; checked?: boolean | null };
export type List = { ordered: boolean; start: number; items: ListItem[] };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; children: Inline[] }
  | { kind: "paragraph"; children: Inline[] }
  | ({ kind: "list" } & List)
  | { kind: "quote"; blocks: Block[] }
  | { kind: "code"; language: string; text: string }
  | { kind: "rule" }
  | {
      kind: "table";
      head: Inline[][];
      rows: Inline[][][];
      align: ("left" | "center" | "right" | null)[];
    };

const safeHref = (href: string) =>
  /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : null;

/** Add source timestamps and quote citations to already-parsed literal text. */
/** A timestamp as people read it: m:ss, or h:mm:ss from an hour on, so 78:11 shows as 1:18:11. */
export function clockLabel(seconds: number, end?: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor(seconds / 60) % 60;
  const label = hours
    ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}`
    : `${minutes}:${pad(seconds % 60)}`;
  return end === undefined ? label : `${label}–${clockLabel(end)}`;
}

function sourceSpans(source: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ kind: "text", text });
    text = "";
  };
  const take = (length: number, ...spans: Inline[]) => {
    flush();
    out.push(...spans);
    i += length;
  };
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const clocks =
      /^\[([^\]\n]+)\](?:\s*[–—-]\s*\[@?(\d{1,3}(?::\d{2}){1,2})\])?(?!\()/.exec(
        rest,
      );
    if (clocks) {
      const tokens = clocks[1].split(/\s*,\s*/);
      const times: Inline[] = [];
      let valid = true;
      for (const [index, token] of tokens.entries()) {
        const range =
          /^(@)?(\d{1,3}(?::\d{2}){1,2})(?:\s*[–—-]\s*@?(\d{1,3}(?::\d{2}){1,2}))?$/.exec(
            token.trim(),
          );
        const start = range ? parseClock(range[2]) : null;
        const endClock =
          range?.[3] ?? (tokens.length === 1 ? clocks[2] : undefined);
        const end = endClock ? parseClock(endClock) : undefined;
        if (
          !range ||
          start === null ||
          end === null ||
          (end !== undefined && end < start)
        ) {
          valid = false;
          break;
        }
        if (index) times.push({ kind: "text", text: ", " });
        times.push({
          kind: "time",
          label: clockLabel(start, end),
          seconds: start,
          end,
          ...(range[1] ? { timeline: true } : {}),
        });
      }
      if (valid) {
        take(clocks[0].length, ...times);
        continue;
      }
    }
    const bare =
      /^(\d{1,3}(?::\d{2}){1,2})(?:\s*[–—-]\s*(\d{1,3}(?::\d{2}){1,2}))?(?![\d:])/.exec(
        rest,
      );
    if (bare && (i === 0 || !/[\w:]/.test(source[i - 1]))) {
      const seconds = parseClock(bare[1]);
      const end = bare[2] ? parseClock(bare[2]) : undefined;
      if (
        seconds !== null &&
        end !== null &&
        (end === undefined || end >= seconds)
      ) {
        take(bare[0].length, {
          kind: "time",
          label: clockLabel(seconds, end),
          seconds,
          end,
        });
        continue;
      }
    }
    const quote = /^(?:“([^”\n]{3,})”|"([^"\n]{3,})")/.exec(rest);
    if (quote) {
      take(quote[0].length, {
        kind: "quote",
        label: quote[0],
        text: quote[1] ?? quote[2],
      });
      continue;
    }
    text += source[i];
    i++;
  }
  flush();
  return out;
}

/** CommonMark + GFM handle loose lists, nesting, escapes and streaming partials. */
export function parseMarkdown(source: string): Block[] {
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const definitions = new Map<string, Definition>();
  for (const node of tree.children)
    if (node.type === "definition")
      definitions.set(node.identifier.toLowerCase(), node);
  const spans = (nodes: PhrasingContent[]): Inline[] =>
    nodes.flatMap((node): Inline[] => {
      switch (node.type) {
        case "text":
          return sourceSpans(node.value);
        case "break":
          return [{ kind: "break" }];
        case "inlineCode":
          return [{ kind: "code", text: node.value }];
        case "strong":
          return [{ kind: "strong", children: spans(node.children) }];
        case "emphasis":
          return [{ kind: "em", children: spans(node.children) }];
        case "delete":
          return [{ kind: "strike", children: spans(node.children) }];
        case "link": {
          const children = spans(node.children),
            href = safeHref(node.url);
          return href ? [{ kind: "link", href, children }] : children;
        }
        case "linkReference": {
          const href = safeHref(
            definitions.get(node.identifier.toLowerCase())?.url ?? "",
          );
          const children = spans(node.children);
          return href ? [{ kind: "link", href, children }] : children;
        }
        case "image":
        case "imageReference":
          return [{ kind: "text", text: node.alt ?? "" }];
        case "html":
          return [{ kind: "text", text: node.value }];
        default:
          return [];
      }
    });
  const blocks = (nodes: RootContent[]): Block[] =>
    nodes.flatMap((node): Block[] => {
      switch (node.type) {
        case "paragraph":
          return [{ kind: "paragraph", children: spans(node.children) }];
        case "heading":
          return [
            {
              kind: "heading",
              level: Math.min(3, node.depth) as 1 | 2 | 3,
              children: spans(node.children),
            },
          ];
        case "thematicBreak":
          return [{ kind: "rule" }];
        case "blockquote":
          return [{ kind: "quote", blocks: blocks(node.children) }];
        case "code":
          return [
            { kind: "code", language: node.lang ?? "", text: node.value },
          ];
        case "list":
          return [
            {
              kind: "list",
              ordered: node.ordered ?? false,
              start: node.start ?? 1,
              items: node.children.map((item) => ({
                blocks: blocks(item.children),
                checked: item.checked,
              })),
            },
          ];
        case "table":
          return [
            {
              kind: "table",
              head:
                node.children[0]?.children.map((cell) =>
                  spans(cell.children),
                ) ?? [],
              rows: node.children
                .slice(1)
                .map((row) => row.children.map((cell) => spans(cell.children))),
              align: node.align ?? [],
            },
          ];
        case "html":
          return [
            {
              kind: "paragraph",
              children: [{ kind: "text", text: node.value }],
            },
          ];
        default:
          return [];
      }
    });
  return blocks(tree.children);
}
