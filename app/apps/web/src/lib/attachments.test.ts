import { describe, expect, it, vi } from "vitest";

vi.mock("./upload", () => ({ uploadFiles: vi.fn(() => []), cancelUpload: vi.fn(), useUploads: { subscribe: vi.fn() } }));
const { uploading, withAttachments } = await import("./attachments");
type Attachment = import("./attachments").Attachment;

const one = (name: string, state: Attachment["state"]): Attachment => ({ id: name.length, name, size: 10, kind: "file", preview: null, state, loaded: 0 });

describe("files attached in the chat", () => {
  it("names what's in under the message, and only that", () => {
    expect(withAttachments("use these as the intro", [one("a.png", "done"), one("brief.pdf", "done"), one("bad.mov", "failed")])).toBe("use these as the intro\n\nAttached: a.png, brief.pdf");
    expect(withAttachments("just words", [])).toBe("just words");
  });

  it("holds the message while any is still on its way", () => {
    expect(uploading([one("a.png", "done"), one("b.mov", "processing")])).toBe(true);
    expect(uploading([one("a.png", "done"), one("bad.mov", "failed")])).toBe(false);
  });
});
