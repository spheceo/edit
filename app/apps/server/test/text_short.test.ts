// Killer Pastor (JJ, Nov 8): "This text right here doesn't stay there for long enough. We can't even read it
// before it disappears again"; "It's also the footage that the text is on that has to be longer."
import { expect, test } from "bun:test";

import { readingSeconds, textsShort } from "../src/edit_tools.ts";
import { project as made } from "./helpers/model.ts";

test("a quote held under its reading time, or over a B-roll cut, is flagged; a long-held one over one shot isn't", () => {
  {
    const project = made();
    {
      const video = project.tracks.find((track) => track.kind === "video")!.id;
      project.tracks.push({ ...project.tracks.find((track) => track.kind === "video")!, id: "v2" }, { ...project.tracks.find((track) => track.kind === "video")!, id: "v3" });
      const quote = (id2: string, start: number, seconds: number, text: string) =>
        ({ id: id2, track: "v3", start, duration: Math.round(seconds * 30), name: "Red quote", color: "red", fade_in: 0, fade_out: 0, type: "text", text, style: {} } as never);
      project.clips.push(
        quote("q1", 0, 2.2, "“Like that Lakewood Church feeling that I had…”"),
        quote("q2", 600, 6, "“When I rang the doorbell, Wayne answered.”"),
        quote("q3", 1200, 6, "“When I rang the doorbell, Wayne answered.”"),
        // B-roll under q3 cuts at 1290.
        { id: "b1", track: "v2", start: 1200, duration: 90, name: "Cut-in 3 · B-roll: room", color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 0, speed: 1 } as never,
        { id: "b2", track: "v2", start: 1290, duration: 90, name: "Cut-in 3 · B-roll: room", color: "blue", fade_in: 0, fade_out: 0, type: "video", media: "m", source_in: 3, speed: 1 } as never,
      );
      void video;
    }
    const issues = textsShort(project) as { clip: string; at_least: number; cut_under?: number }[];
    expect(issues.map((one) => one.clip)).toEqual(["q1", "q3"]);
    expect(issues[0]!.at_least).toBe(Math.round(readingSeconds(8) * 10) / 10);
    expect(issues[1]!.cut_under).toBe(1290);
    expect(readingSeconds(3)).toBe(4);
    expect(readingSeconds(15)).toBe(6.5);
  }
});
