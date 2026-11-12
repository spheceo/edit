// Quoted words as a chat shows them: a chip among the words, in the composer
// before they're sent and in the message after (lib/chatQuotes.ts; Sphe, Nov
// 12: the quote "shows up in a bit within the message", not a block above it).

import { X } from "lucide-react";

import { piecesOf, quoteLabel } from "../lib/chatQuotes";

/** The chip's look, shared with the composer's own (built there as DOM, inside its editable box). */
export const CHIP = "mx-0.5 inline-flex max-w-[11rem] items-center gap-1 rounded-md bg-[#5b8cff]/12 px-1.5 align-bottom text-[12.5px] leading-[19px] text-[#8fb0ff]";
/** Its quote mark, the same in the composer's chip (built as DOM there). */
export const MARK = "shrink-0 font-serif text-[15px] leading-none opacity-80";

/** A quote among the words: what it's from on hover, with the whole of it; its first words in the line. */
export function QuoteChip({ from, text, onRemove }: { from: string; text: string; onRemove?: () => void }) {
  return (
    <span className={CHIP} title={`${quoteLabel(from)}: ${text}`}>
      <span className={MARK} aria-hidden>{"\u201c"}</span>
      <span className="truncate">{text}</span>
      {onRemove && (
        <button type="button" aria-label="Remove the quote" onClick={onRemove} className="-mr-0.5 flex size-4 shrink-0 items-center justify-center rounded text-[#8fb0ff]/70 hover:text-white">
          <X size={10} />
        </button>
      )}
    </span>
  );
}

/** Quoted words with what they're from, as a block (a quote shown on its own, not among words). */
export function QuoteView({ from, text, className }: { from: string; text: string; className?: string }) {
  return (
    <blockquote className={`min-w-0 flex-1 border-l-2 border-line-strong pl-2 text-[12px] leading-relaxed ${className ?? ""}`}>
      <span className="block text-[11px] text-faint">{quoteLabel(from)}</span>
      <span className="block whitespace-pre-wrap text-muted">{text}</span>
    </blockquote>
  );
}

/** What was sent: its words, with each quote a chip where it was put. */
export function UserWords({ text }: { text: string }) {
  const pieces = piecesOf(text);
  if (!pieces.some((piece) => piece.kind === "quote")) return text;
  return (
    <>
      {pieces.map((piece, index) =>
        piece.kind === "quote" ? <QuoteChip key={index} from={piece.from} text={piece.text} /> : <span key={index}>{piece.text}</span>,
      )}
    </>
  );
}
