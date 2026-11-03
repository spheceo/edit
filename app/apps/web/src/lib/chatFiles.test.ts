import { describe, expect, it } from "vitest";

import { attachFiles, picturesOnly, takeFiles, uploading, useChatFiles } from "./chatFiles";

const picture = (name: string) => new File([new Uint8Array(10)], name, { type: "image/png" });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("files attached in a chat", () => {
  it("uploads each, keeps what it became, and a message takes only the ones that made it", async () => {
    let fail = "";
    const upload = async (file: File, progress: (loaded: number) => void) => {
      progress(5);
      if (file.name === fail) throw new Error("connection lost");
      return `id-${file.name}`;
    };
    fail = "b.png";
    const refused = attachFiles("t1", [picture("a.png"), picture("b.png"), new File(["x"], "notes.txt", { type: "text/plain" })], upload, picturesOnly);
    expect(refused).toEqual(["notes.txt: only pictures can be attached here"]);
    expect(uploading(useChatFiles.getState().chats.t1!)).toBe(true);
    await settle();
    await settle();
    const list = useChatFiles.getState().chats.t1!;
    expect(list.map((one) => [one.name, one.state, one.landed ?? one.error])).toEqual([
      ["a.png", "done", "id-a.png"],
      ["b.png", "failed", "connection lost"],
    ]);
    expect(uploading(list)).toBe(false);
    expect(takeFiles("t1").map((one) => one.landed)).toEqual(["id-a.png"]);
    expect(useChatFiles.getState().chats.t1).toEqual([]);
  });

  it("keeps each chat's files its own", async () => {
    attachFiles("one", [picture("a.png")], async () => "a");
    await settle();
    expect(useChatFiles.getState().chats.two).toBeUndefined();
    expect(takeFiles("two")).toEqual([]);
    expect(takeFiles("one")).toHaveLength(1);
  });
});
