// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addQuote, inlineQuote, takeQuotes, type ChatQuote } from "../lib/chatQuotes";
import { ChatComposer } from "./ChatComposer";

// happy-dom's Web Animations reject when cancelled; motion animates by itself without them.
delete (Element.prototype as { animate?: unknown }).animate;

const CHAT = "test-chat";
let root: Root;
let sent: { message: string; quotes: ChatQuote[] }[];
let saved: string[];

/** A chat that keeps its own words, as Writer's do (useChatDraft). */
function Controlled({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <ChatComposer
      chat={CHAT}
      running={false}
      disabled={false}
      placeholder="Ask"
      value={value}
      onValueChange={(next) => {
        saved.push(next);
        setValue(next);
      }}
      onSend={(message, _files, quotes) => sent.push({ message, quotes })}
      onStop={() => {}}
    />
  );
}

function mount(initial = "") {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Controlled initial={initial} />));
  return container.querySelector<HTMLElement>('[role="textbox"]')!;
}

/** Typing, as the browser leaves it: the box changed, then `input`. */
function type(box: HTMLElement, change: () => void) {
  act(() => {
    change();
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const enter = (box: HTMLElement, keyCode = 13) => {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  Object.defineProperty(event, "keyCode", { value: keyCode });
  act(() => void box.dispatchEvent(event));
};

describe("the chat's composer", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    sent = [];
    saved = [];
    takeQuotes(CHAT);
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("gives a chat that keeps its own words the words alone, the chip staying where it was put", () => {
    const box = mount();
    type(box, () => box.append("make the "));
    act(() => addQuote(CHAT, { from: "narration 3", text: "he ran for the door" }));
    type(box, () => box.append("calmer"));
    expect(saved.at(-1)).toBe("make the  calmer");
    expect(saved.some((one) => one.includes("⁣"))).toBe(false);
    // The chat's own copy of the words coming back didn't rewrite the box.
    expect(box.querySelectorAll("[data-quote-id]")).toHaveLength(1);
    expect(box.firstChild?.textContent).toBe("make the ");
    enter(box);
    expect(sent[0]!.message).toBe(`make the ${inlineQuote({ from: "narration 3", text: "he ran for the door" })} calmer`);
  });

  it("brings back a draft saved with a chip's mark (Nov 12's dev builds) without the stray number", () => {
    const box = mount("make the ⁣3⁣ calmer");
    expect(box.textContent).toBe("make the  calmer");
  });

  it("sends a chip an undo brought back, and drops one with no quote behind it", () => {
    const box = mount();
    act(() => addQuote(CHAT, { from: "title 2", text: "Cops Surprise Husband" }));
    const chip = box.querySelector<HTMLElement>("[data-quote-id]")!;
    type(box, () => chip.remove());
    // Gone with its quote: nothing to send.
    expect(box.closest("form")!.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    type(box, () => box.prepend(chip));
    expect(box.closest("form")!.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    const stray = chip.cloneNode(true) as HTMLElement;
    stray.dataset.quoteId = "999999";
    type(box, () => box.append(stray));
    expect(box.querySelector('[data-quote-id="999999"]')).toBeNull();
    enter(box);
    expect(sent[0]!.quotes.map((one) => one.text)).toEqual(["Cops Surprise Husband"]);
    expect(sent[0]!.message).toBe(inlineQuote({ from: "title 2", text: "Cops Surprise Husband" }));
  });

  it("doesn't send on the Enter that picks an input method's word (WebKit: key 229)", () => {
    const box = mount();
    type(box, () => box.append("にほん"));
    enter(box, 229);
    expect(sent).toEqual([]);
    enter(box);
    expect(sent.map((one) => one.message)).toEqual(["にほん"]);
  });

  it("copies a chip as its quote's words in quotation marks", () => {
    const box = mount();
    type(box, () => box.append("make "));
    act(() => addQuote(CHAT, { from: "title 2", text: "Cops Surprise Husband" }));
    type(box, () => box.append("punchier"));
    const range = document.createRange();
    range.selectNodeContents(box);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const data = new DataTransfer();
    const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: data });
    act(() => void box.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(data.getData("text/plain")).toBe("make “Cops Surprise Husband” punchier");
  });
});
