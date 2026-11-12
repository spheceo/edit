import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { inlineQuote, quotedMessage } from "../lib/chatQuotes";
import { UserWords } from "./Quotes";

describe("a sent message in the chat", () => {
  it("shows each quote as a chip where it was put among the words (Sphe, Nov 12)", () => {
    const html = renderToStaticMarkup(<UserWords text={`make ${inlineQuote({ from: "title 2", text: "Cops Surprise Husband" })} punchier, like ${inlineQuote({ from: "the thumbnail guide", text: "find an image of the woman." })}`} />);
    expect(html).not.toContain("<blockquote");
    expect(html).not.toContain("Quoted from");
    expect(html.indexOf("make")).toBeLessThan(html.indexOf("Cops Surprise Husband"));
    expect(html.indexOf("Cops Surprise Husband")).toBeLessThan(html.indexOf("punchier"));
    expect(html).toContain('title="Title 2: Cops Surprise Husband"');
    expect(html).toContain('title="Thumbnail guide: find an image of the woman."');
  });

  it("shows a message from before (its quotes in front) as chips too", () => {
    const html = renderToStaticMarkup(<UserWords text={quotedMessage([{ id: 1, from: "title 2", text: "Cops Surprise Husband" }], "punchier")} />);
    expect(html).toContain("Cops Surprise Husband");
    expect(html).not.toContain("Quoted from");
    expect(html.endsWith("<span>punchier</span>")).toBe(true);
    // In a row of their own on top, the words under them.
    expect(html.startsWith('<span class="flex flex-wrap gap-1 mb-1.5">')).toBe(true);
  });

  it("shows a message with no quotes as it was written", () => {
    expect(renderToStaticMarkup(<UserWords text="make it shorter" />)).toBe("make it shorter");
  });
});
