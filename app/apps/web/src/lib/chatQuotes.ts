// Words quoted into a chat on the right (Sphe, Nov 4: "we need to be able to
// quote titles or thumbnail guide lines and include them in chat for ideas,
// and scripts we need a sort of shared system"). Kept per chat, as its files
// are (chatFiles.ts): a page adds a quote (the script's selection pill, or
// QuoteSelection over any text marked `data-quote`), the composer holds it
// as a chip among the words, where it was put, and the chat shows it back as
// the same chip in the sent message (Sphe, Nov 12: a quote "in between some
// other text", not a block that clouds the message). Claude reads each in
// place: "[Quoted from narration 3 (clip …, characters a–b): “…”]". A
// message from before reads back too: its quotes in front of the words,
// "Quoted from …:\n“…”\n\nrequest".

import { create } from "zustand";

export interface ChatQuote {
  id: number;
  /** What it's quoted from, as Claude reads it: "narration 3", "title 2", "the thumbnail guide". */
  from: string;
  text: string;
  /** Where in it, for Claude only: a narration's clip and characters. */
  where?: string;
  /** The script clip it's in, which a revision is pointed at. */
  clip?: string;
}

const useChatQuotes = create<{ chats: Record<string, ChatQuote[]> }>(() => ({ chats: {} }));
const NONE: ChatQuote[] = [];
let next = 0;

export function useQuotesOf(chat: string): ChatQuote[] {
  return useChatQuotes((state) => state.chats[chat] ?? NONE);
}

/** Quotes it into the chat's next message; the same words from the same place twice are one quote. */
export function addQuote(chat: string, quote: Omit<ChatQuote, "id">): void {
  if (quote.text.trim() === "") return;
  useChatQuotes.setState(({ chats }) => {
    const had = chats[chat] ?? NONE;
    if (had.some((one) => one.from === quote.from && one.text === quote.text)) return { chats };
    return { chats: { ...chats, [chat]: [...had, { ...quote, id: ++next }] } };
  });
}

export function removeQuote(chat: string, id: number): void {
  useChatQuotes.setState(({ chats }) => ({ chats: { ...chats, [chat]: (chats[chat] ?? NONE).filter((one) => one.id !== id) } }));
}

/** A quote taken out brought back as it was (its chip deleted in the composer, then undone). */
export function restoreQuote(chat: string, quote: ChatQuote): void {
  useChatQuotes.setState(({ chats }) => {
    const had = chats[chat] ?? NONE;
    return had.some((one) => one.id === quote.id) ? { chats } : { chats: { ...chats, [chat]: [...had, quote] } };
  });
}

/** The chat's quotes, cleared: they go with the message being sent. */
export function takeQuotes(chat: string): ChatQuote[] {
  const quotes = useChatQuotes.getState().chats[chat] ?? NONE;
  if (quotes.length > 0) useChatQuotes.setState(({ chats }) => ({ chats: { ...chats, [chat]: NONE } }));
  return quotes;
}

/** The message Claude reads: each quote, then what was asked about them. */
export function quotedMessage(quotes: readonly ChatQuote[], words: string): string {
  if (quotes.length === 0) return words;
  const blocks = quotes.map((one) => `Quoted from ${one.from}${one.where ? ` (${one.where})` : ""}:\n“${one.text}”`);
  return [...blocks, words].filter((one) => one !== "").join("\n\n");
}

/** "narration 3" → "Narration 3", "the thumbnail guide" → "Thumbnail guide": the quote's label in the chat. */
export function quoteLabel(from: string): string {
  const name = from.replace(/^the /u, "");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const BLOCK = /^Quoted from ([^\n]+?)(?: \(([^)\n]*)\))?:\n“([\s\S]*?)”(?:\n\n|$)/u;
const INLINE = /\[Quoted from ([^\n:\]]+?)(?: \(([^)\n]*)\))?: “([\s\S]*?)”\]/gu;

/** A quote as it sits among a message's words: its own words never close it early (a ” inside is a straight one). */
export function inlineQuote(quote: Pick<ChatQuote, "from" | "where" | "text">): string {
  return `[Quoted from ${quote.from}${quote.where ? ` (${quote.where})` : ""}: “${quote.text.replace(/”/gu, '"')}”]`;
}

/** A sent message's pieces in order: its words and its quotes, where they were put. */
export type Piece = { kind: "words"; text: string } | { kind: "quote"; from: string; text: string };

export function piecesOf(message: string): Piece[] {
  const pieces: Piece[] = [];
  let rest = message;
  // A message from before: its quotes in front of the words.
  for (let match = BLOCK.exec(rest); match !== null; match = BLOCK.exec(rest)) {
    pieces.push({ kind: "quote", from: match[1]!, text: match[3]! });
    rest = rest.slice(match[0].length);
  }
  let at = 0;
  for (const match of rest.matchAll(INLINE)) {
    if (match.index > at) pieces.push({ kind: "words", text: rest.slice(at, match.index) });
    pieces.push({ kind: "quote", from: match[1]!, text: match[3]! });
    at = match.index + match[0].length;
  }
  if (at < rest.length) pieces.push({ kind: "words", text: rest.slice(at) });
  return pieces;
}

/** A sent message read back into its quotes and what was asked; a message with none is all words. */
export function parseQuoted(message: string): { quotes: { from: string; text: string }[]; words: string } {
  const pieces = piecesOf(message);
  return {
    quotes: pieces.flatMap((piece) => (piece.kind === "quote" ? [{ from: piece.from, text: piece.text }] : [])),
    words: pieces.flatMap((piece) => (piece.kind === "words" ? [piece.text] : [])).join("").replace(/ {2,}/gu, " ").trim(),
  };
}
