// Ported as it is from Repack's script chat (apps/web/src/components/markdown.tsx), the user, Oct 30:
// "have the EXACT chat viewer that repack has". Keep it in step with Repack's.
import { Check, Copy } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";
import { copyText } from "./copy-text";
import {
  type Block,
  type Inline,
  type List,
  parseMarkdown,
} from "./parse-markdown";
import styles from "./markdown.module.css";

const inlineText = (spans: Inline[]): string =>
  spans
    .map((span) =>
      span.kind === "break"
        ? "\n"
        : "children" in span
          ? inlineText(span.children)
          : span.kind === "time" || span.kind === "quote"
            ? span.label
            : span.text,
    )
    .join("");
const quotedText = (blocks: Block[]): string =>
  blocks
    .flatMap((block) =>
      block.kind === "list"
        ? block.items.map((item) => quotedText(item.blocks))
        : "children" in block
          ? [inlineText(block.children)]
          : block.kind === "quote"
            ? [quotedText(block.blocks)]
            : [],
    )
    .join(" ");

/** A chat answer as formatted text; timestamps call `onJump` with seconds. */
/**
 * How a moment in the footage is written on its chip, where the plain clock
 * would mislead: a compilation’s footage is several videos end to end, and a
 * moment is read as its video and that video’s own time. Timeline chips keep
 * their clock.
 */
export const FootageTime = createContext<
  ((seconds: number, end?: number) => string | undefined) | null
>(null);

export function Markdown({
  text,
  onJump,
  onQuote,
  live = false,
  caret = true,
}: {
  text: string;
  onJump?: (seconds: number, end?: number, timeline?: boolean) => void;
  onQuote?: (quote: string, url?: string) => void;
  /** Still streaming: new blocks ease in. */
  live?: boolean;
  /** While streaming, a caret trails the last block. */
  caret?: boolean;
}) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div
      className={`${styles.markdown}${live ? ` ${styles.live}${caret ? ` ${styles.caret}` : ""}` : ""}`}
    >
      {blocks.map((block, index) => (
        <BlockView
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks only grow while streaming
          key={index}
          block={block}
          onJump={onJump}
          onQuote={onQuote}
        />
      ))}
    </div>
  );
}

function BlockView({
  block,
  onJump,
  onQuote,
}: {
  block: Block;
  onJump?: (seconds: number, end?: number, timeline?: boolean) => void;
  onQuote?: (quote: string, url?: string) => void;
}) {
  const inline = (children: Inline[]) => (
    <Spans spans={children} onJump={onJump} onQuote={onQuote} />
  );
  switch (block.kind) {
    case "heading": {
      const Tag = (["h3", "h4", "h5"] as const)[block.level - 1];
      return <Tag>{inline(block.children)}</Tag>;
    }
    case "paragraph":
      return <p>{inline(block.children)}</p>;
    case "list":
      return <ListView list={block} onJump={onJump} onQuote={onQuote} />;
    case "quote": {
      const quote = quotedText(block.blocks);
      // Keep timestamp chips interactive inside quoted transcript passages.
      if (onQuote && quote.length >= 3 && !/\d{1,3}:\d{2}/.test(quote))
        return (
          <blockquote>
            <button
              type="button"
              className={styles.quoteCitation}
              title="Show quote in source"
              onClick={() => onQuote(quote)}
            >
              {quote}
            </button>
          </blockquote>
        );
      return (
        <blockquote>
          {block.blocks.map((child, index) => (
            <BlockView
              // biome-ignore lint/suspicious/noArrayIndexKey: parsed blocks never reorder
              key={index}
              block={child}
              onJump={onJump}
              onQuote={onQuote}
            />
          ))}
        </blockquote>
      );
    }
    case "code":
      return <CodeBlock language={block.language} text={block.text} />;
    case "rule":
      return <hr />;
    case "table":
      return (
        <div className={styles.table}>
          <table>
            <thead>
              <tr>
                {block.head.map((cell, index) => (
                  <th
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns never reorder
                    key={index}
                    style={{ textAlign: block.align[index] ?? undefined }}
                  >
                    {inline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows never reorder
                <tr key={r}>
                  {row.map((cell, index) => (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: columns never reorder
                      key={index}
                      style={{ textAlign: block.align[index] ?? undefined }}
                    >
                      {inline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function ListView({
  list,
  onJump,
  onQuote,
}: {
  list: List;
  onJump?: (seconds: number, end?: number, timeline?: boolean) => void;
  onQuote?: (quote: string, url?: string) => void;
}) {
  const items = list.items.map((item, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: items only grow while streaming
    <li key={index}>
      {item.checked !== undefined && item.checked !== null ? (
        <input
          className={styles.task}
          type="checkbox"
          checked={item.checked}
          readOnly
          disabled
          aria-label={item.checked ? "Completed" : "Not completed"}
        />
      ) : null}
      {item.blocks.map((child, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parsed blocks never reorder
        <BlockView key={i} block={child} onJump={onJump} onQuote={onQuote} />
      ))}
    </li>
  ));
  return list.ordered ? (
    <ol start={list.start === 1 ? undefined : list.start}>{items}</ol>
  ) : (
    <ul>{items}</ul>
  );
}

function Spans({
  spans,
  onJump,
  onQuote,
}: {
  spans: Inline[];
  onJump?: (seconds: number, end?: number, timeline?: boolean) => void;
  onQuote?: (quote: string, url?: string) => void;
}): ReactNode {
  const footageTime = useContext(FootageTime);
  // Punctuation right after a timestamp stays with it, so it can’t wrap alone.
  const glue = new Map<number, string>();
  const items = spans.map((span, index) => {
    const before = spans[index - 1];
    if (span.kind !== "text" || before?.kind !== "time") return span;
    const trail = /^[.,;:!?)\]]+/.exec(span.text)?.[0];
    if (!trail) return span;
    glue.set(index - 1, trail);
    return { ...span, text: span.text.slice(trail.length) };
  });
  return items.map((span, index) => {
    const key = `${span.kind}-${index}`;
    switch (span.kind) {
      case "text":
        return span.text;
      case "break":
        return <br key={key} />;
      case "quote":
        return onQuote ? (
          <button
            key={key}
            type="button"
            className={styles.quoteCitation}
            title="Show quote in source"
            onClick={() => onQuote(span.text)}
          >
            {span.label}
          </button>
        ) : (
          span.label
        );
      case "strong":
        return (
          <strong key={key}>
            <Spans spans={span.children} onJump={onJump} onQuote={onQuote} />
          </strong>
        );
      case "em":
        return (
          <em key={key}>
            <Spans spans={span.children} onJump={onJump} onQuote={onQuote} />
          </em>
        );
      case "strike":
        return (
          <s key={key}>
            <Spans spans={span.children} onJump={onJump} onQuote={onQuote} />
          </s>
        );
      case "code":
        return <code key={key}>{span.text}</code>;
      case "link": {
        if (
          onJump &&
          span.children.some((child) => child.kind === "time") &&
          span.children.every(
            (child) =>
              child.kind === "time" ||
              (child.kind === "text" && /^[,\s]*$/.test(child.text)),
          )
        )
          return (
            <span key={key}>
              <Spans spans={span.children} onJump={onJump} />
            </span>
          );
        const quote =
          span.children.length === 1 && span.children[0].kind === "quote"
            ? span.children[0]
            : null;
        if (quote && onQuote)
          return (
            <button
              key={key}
              type="button"
              className={styles.quoteCitation}
              title="Show quote in source"
              onClick={() => onQuote(quote.text, span.href)}
            >
              {quote.label}
            </button>
          );
        return (
          <a key={key} href={span.href} target="_blank" rel="noreferrer">
            <Spans spans={span.children} />
          </a>
        );
      }
      case "time": {
        const chip = onJump ? (
          <button
            key={key}
            type="button"
            className={`${styles.time}${span.timeline ? ` ${styles.timeline}` : ""}`}
            title={
              span.timeline
                ? "In the cut: moves the playhead here"
                : "In the footage: shows these words in the transcript"
            }
            onClick={() => onJump(span.seconds, span.end, span.timeline)}
          >
            {(span.timeline
              ? undefined
              : footageTime?.(span.seconds, span.end)) ?? span.label}
          </button>
        ) : (
          <span key={key} className={styles.time}>
            {span.label}
          </span>
        );
        const trail = glue.get(index);
        return trail ? (
          <span key={key} className={styles.glued}>
            {chip}
            {trail}
          </span>
        ) : (
          chip
        );
      }
    }
    return null;
  });
}

function CodeBlock({ language, text }: { language: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.code}>
      <div className={styles.codeHead}>
        <span>{language || "text"}</span>
        <button
          type="button"
          onClick={() =>
            void copyText(text).then((done) => {
              if (!done) return;
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}
