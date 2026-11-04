import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { quotedMessage } from "../lib/chatQuotes";
import { UserWords } from "./Quotes";

describe("a sent message in the chat", () => {
  it("shows its quotes as quotes, labelled, then the words", () => {
    const html = renderToStaticMarkup(<UserWords text={quotedMessage([{ id: 1, from: "title 2", text: "Cops Surprise Husband" }, { id: 2, from: "the thumbnail guide", text: "find an image of the woman." }], "punchier")} />);
    expect(html.match(/<blockquote/g)).toHaveLength(2);
    expect(html).toContain("Title 2");
    expect(html).toContain("Thumbnail guide");
    expect(html).not.toContain("Quoted from");
    expect(html.endsWith("punchier")).toBe(true);
  });

  it("shows a message with no quotes as it was written", () => {
    expect(renderToStaticMarkup(<UserWords text="make it shorter" />)).toBe("make it shorter");
  });
});
