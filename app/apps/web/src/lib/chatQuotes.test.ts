import { describe, expect, it } from "vitest";

import { addQuote, inlineQuote, parseQuoted, piecesOf, quotedMessage, quoteLabel, takeQuotes } from "./chatQuotes";

describe("words quoted into a chat", () => {
  it("sends the script's quote as Claude has always read it, and reads it back", () => {
    const quotes = [{ id: 1, from: "narration 3", where: "clip c4, characters 10–24", clip: "c4", text: "he ran for the door" }];
    const message = quotedMessage(quotes, "make it calmer");
    expect(message).toBe("Quoted from narration 3 (clip c4, characters 10–24):\n“he ran for the door”\n\nmake it calmer");
    expect(parseQuoted(message)).toEqual({ quotes: [{ from: "narration 3", text: "he ran for the door" }], words: "make it calmer" });
  });

  it("puts several quotes in front of the words, one after another", () => {
    const message = quotedMessage(
      [
        { id: 1, from: "title 2", text: "Cop Pulls Over the Wrong Judge" },
        { id: 2, from: "the thumbnail guide", text: "Judge on the left, badge in hand\nred arrow to the cruiser" },
      ],
      "punchier, like the guide",
    );
    const read = parseQuoted(message);
    expect(read.quotes.map((one) => one.from)).toEqual(["title 2", "the thumbnail guide"]);
    expect(read.quotes[1]!.text).toBe("Judge on the left, badge in hand\nred arrow to the cruiser");
    expect(read.words).toBe("punchier, like the guide");
  });

  it("reads a quote back where it was put among the words, its where for Claude only (Nov 12)", () => {
    const quote = { from: "narration 3", where: "clip c4, characters 10–24", text: "he said “stop” twice" };
    const message = `make ${inlineQuote(quote)} calmer`;
    expect(message).toBe('make [Quoted from narration 3 (clip c4, characters 10–24): “he said “stop" twice”] calmer');
    expect(piecesOf(message)).toEqual([
      { kind: "words", text: "make " },
      { kind: "quote", from: "narration 3", text: 'he said “stop" twice' },
      { kind: "words", text: " calmer" },
    ]);
    expect(parseQuoted(message)).toEqual({ quotes: [{ from: "narration 3", text: 'he said “stop" twice' }], words: "make calmer" });
  });

  it("leaves a message with no quotes as it is", () => {
    expect(parseQuoted("Quoted from memory, nothing more")).toEqual({ quotes: [], words: "Quoted from memory, nothing more" });
  });

  it("keeps each chat's quotes its own, the same words once, and clears them when sent", () => {
    addQuote("idea:a", { from: "title 1", text: "One" });
    addQuote("idea:a", { from: "title 1", text: "One" });
    addQuote("idea:b", { from: "title 1", text: "Other" });
    addQuote("idea:a", { from: "title 1", text: "   " });
    expect(takeQuotes("idea:a").map((one) => one.text)).toEqual(["One"]);
    expect(takeQuotes("idea:a")).toEqual([]);
    expect(takeQuotes("idea:b")).toHaveLength(1);
  });

  it("labels a quote by what it's from", () => {
    expect(quoteLabel("the thumbnail guide")).toBe("Thumbnail guide");
    expect(quoteLabel("narration 3")).toBe("Narration 3");
  });
});
