import { describe, expect, it } from "vitest";

import { editStyles, makesVideos, writesScripts, type Account } from "./account";

const signedIn = (perms: string[], admin = false) => ({ person: { email: "a@b.c", name: "A", image: null }, perms, admin }) as unknown as Account;

describe("what the signed-in person may do", () => {
  it("someone who only writes scripts makes no videos, so Home sends them to Scripts", () => {
    const writer = signedIn(["use", "scripts.foia-compilation", "review.share"]);
    expect([makesVideos(writer), writesScripts(writer)]).toEqual([false, true]);
    expect(editStyles(writer)).toEqual(new Set());
  });

  it("`use` alone opens nothing; an admin and nobody signed in have everything", () => {
    expect([makesVideos(signedIn(["use", "cloud"])), writesScripts(signedIn(["use", "cloud"]))]).toEqual([false, false]);
    expect([makesVideos(signedIn(["use"], true)), writesScripts(signedIn(["use"], true)), editStyles(signedIn(["use"], true))]).toEqual([true, true, null]);
    expect([makesVideos(null), writesScripts(null)]).toEqual([true, true]);
    expect([makesVideos(signedIn(["use", "video.subtitles"])), editStyles(signedIn(["use", "edit.bodycam"]))]).toEqual([true, new Set(["bodycam"])]);
  });
});
