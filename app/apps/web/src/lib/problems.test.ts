import { explain, resetTime } from "@edit/types/problems";
import { describe, expect, it } from "vitest";

// Messages as the team's logs had them (Oct 28).
describe("explain", () => {
  it("says a daily allowance is used up, and when it comes back in local time", () => {
    const said = explain("transcription failed (429): Today's transcription allowance for this connection is used up; it resets at midnight UTC.");
    expect(said.title).toBe("Today's transcription allowance is used up");
    expect(said.fix).toContain(resetTime());
    expect(said.known).toBe(true);
    expect(explain("watch window failed: no Gemini model left today").title).toBe("Today's AI allowance is used up");
    expect(explain("Edit's shared voice budget for today is used up; it resets at midnight UTC.").title).toBe("Today's voice-over allowance is used up");
  });

  it("tells signing out of Edit from Claude's sign-in", () => {
    expect(explain("reviews:changes: Sign in to Edit (this relay answers signed-in people only). (401)").action).toBe("sign-in");
    expect(explain("Claude Code's sign-in on this Mac has expired or was signed out. Open Terminal, run `claude`, type /login and sign in, then send your message again.").action).toBe(
      "claude-sign-in",
    );
  });

  it("works out when an allowance resets in the person's own time", () => {
    // 22:30 UTC: the next midnight UTC is an hour and a half on.
    const now = new Date(Date.UTC(2026, 9, 28, 22, 30));
    const at = (hours: number) => new Date(now.getTime() + hours * 3600_000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(resetTime("UTC", now)).toBe(at(1.5));
    // California is UTC-7 in late October: its midnight is 07:00 UTC.
    expect(resetTime("America/Los_Angeles", now)).toBe(at(8.5));
  });

  it("keeps the original words for Report, never as the title", () => {
    const raw = "the cloud export stopped (exit 1): Traceback (most recent call last): File \"/app/export_v3.py\", line 88, in <module> RuntimeError: CUDA out of memory";
    const said = explain(raw, "export the video");
    expect(said.title).toBe("The cloud export didn't finish");
    expect(said.details).toBe(raw);
    expect(said.title.length).toBeLessThan(60);
  });

  it("falls back to what was being done for anything technical it doesn't know", () => {
    const said = explain("downloading edit/originals/drive/1abc/x.mp4 (000): undefined is not an object", "open the footage");
    expect(said.title).toBe("Couldn't open the footage");
    expect(said.fix).toContain("Report");
    expect(said.known).toBe(false);
  });

  it("shows a message already written for a person as it is", () => {
    expect(explain("Choose a voice first.").title).toBe("Choose a voice first.");
    expect(explain("text is empty", "save the caption")).toMatchObject({ title: "Couldn't save the caption", fix: "Text is empty." });
  });

  it("knows the download failures the import hits", () => {
    expect(explain("This Drive file isn't shared. Set it so anyone with the link can view.").title).toBe("That Google file isn't shared");
    expect(explain("Google Drive's download limit for this file is used up for today. Try later, or upload a copy.").title).toBe(
      "Google Drive won't share that file again today",
    );
    expect(explain("YouTube video abc couldn't be downloaded: Sign in to confirm your age. This video may be inappropriate for some users.").title).toBe(
      "That YouTube video is age-restricted",
    );
    expect(explain("YouTube video abc couldn't be downloaded: Sign in to confirm you're not a bot").title).toBe("YouTube is blocking downloads for now");
    expect(explain("Download stopped ((56) The socket connection was closed). It resumes where it left off when you retry.").action).toBe("retry");
    expect(explain("write failed: ENOSPC: no space left on device").title).toBe("Your Mac's disk is full");
  });

  it("doesn't take another service's limit for Claude's", () => {
    expect(explain("Google Drive answered 429: Rate Limit Exceeded").title).toBe("Google Drive is having trouble");
  });
});
