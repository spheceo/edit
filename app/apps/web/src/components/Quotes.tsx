// Quoted words as a chat shows them: in the composer before they're sent,
// and in the message after (lib/chatQuotes.ts).

import { parseQuoted, quoteLabel } from "../lib/chatQuotes";

/** Quoted words with what they're from. */
export function QuoteView({ from, text, className }: { from: string; text: string; className?: string }) {
  return (
    <blockquote className={`min-w-0 flex-1 border-l-2 border-line-strong pl-2 text-[12px] leading-relaxed ${className ?? ""}`}>
      <span className="block text-[11px] text-faint">{quoteLabel(from)}</span>
      <span className="block whitespace-pre-wrap text-muted">{text}</span>
    </blockquote>
  );
}

/** What was sent: its quotes, as quotes, then the words about them. */
export function UserWords({ text }: { text: string }) {
  const { quotes, words } = parseQuoted(text);
  if (quotes.length === 0) return text;
  return (
    <>
      <span className="mb-1.5 flex flex-col gap-1.5 last:mb-0">
        {quotes.map((one, index) => (
          <QuoteView key={index} from={one.from} text={one.text} />
        ))}
      </span>
      {words}
    </>
  );
}
