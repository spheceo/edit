// The script's cut on Edit.app's window player (window-player.ts), against a
// window that answers as crates/edit-window/src/preview.rs does: what it's
// sent, what the playhead says, and when it gives the cut back.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CutSource } from "@edit/types/script_cut";

import { Playhead, type Item } from "./playback";
import { inWindow, monitor } from "./testing/window";
import { WindowPlayer } from "./window-player";

const SRC = "/api/writer/scripts/s/proxy?v=1";
const proxy: CutSource = { path: "/scripts/s/proxy.mp4", width: 1280, height: 720, durationMs: 600_000, fps: 30, sound: true };
// 20 s of footage from 1:00, a 4 s card, 10 s from 0:05, a 3 s card: 37 s, 1110 frames.
const clips = [
  { id: "a", startMs: 60_000, endMs: 80_000 },
  { id: "card", startMs: 0, endMs: 4_000, kind: "cut-in", narration: "Meanwhile." },
  { id: "b", startMs: 5_000, endMs: 15_000 },
  { id: "end", startMs: 0, endMs: 3_000, kind: "cut-in" },
] as Item[];

describe("the script's cut on the window's player", () => {
  let page: ReturnType<typeof inWindow>;
  let lost: string[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    page = inWindow();
    lost = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function started(items = clips) {
    const playhead = new Playhead();
    const player = new WindowPlayer(items, playhead, { [SRC]: proxy }, "/cache", (why) => lost.push(why));
    const screen = monitor();
    player.setSource(SRC);
    player.attach(screen.canvas);
    await page.settle();
    return { player, playhead, screen };
  }

  it("hands the window the cut as an edit and rests on the playhead's frame, the picture shaped as the footage", async () => {
    const { player } = await started();
    const sent = page.fake.last("preview_project")!;
    expect(sent.sources).toEqual({ [SRC]: "/scripts/s/proxy.mp4" });
    expect(sent.sounds).toEqual({ [SRC]: "/scripts/s/proxy.mp4" });
    expect(sent.cache).toBe("/cache");
    const edit = page.fake.project!;
    expect(edit.clips.filter((clip) => clip.type === "video").map((clip) => [clip.start, clip.duration, clip.source_in])).toEqual([[0, 600, 60], [720, 300, 5]]);
    expect(page.fake.last("preview_frame")).toEqual({ frame: 0 });
    expect(player.framed).toBe(true);
    expect(player.frameRatio).toBeCloseTo(16 / 9);
    expect(player.duration).toBe(37_000);
    expect(lost).toEqual([]);
  });

  it("puts the window's layer under the monitor's screen with the page see-through there, off the edge while the monitor is out of sight, and gives the page back as it leaves", async () => {
    const { player, screen } = await started();
    expect(page.fake.last("preview_place")).toEqual({ x: 10, y: 50, width: 640, height: 360, radius: 9, visible: true });
    expect(page.root.classes.has("native-preview")).toBe(true);
    expect(page.root.background).toBe("transparent");
    expect([screen.screen.attributes.has("data-window"), screen.panel.attributes.has("data-window")]).toEqual([true, true]);
    // The Script view: the monitor a pixel wide. The layer leaves the window's sight, still open (a cut plays on).
    screen.canvas.box = { left: 0, top: 0, width: 1, height: 1 };
    await page.frames();
    expect(page.fake.last("preview_place")).toMatchObject({ x: -8, y: -8, visible: true });
    expect(page.root.classes.has("native-preview")).toBe(false);
    expect(screen.screen.attributes.has("data-window")).toBe(false);
    // Back in sight, at a new size: placed there and its frame drawn at that size.
    screen.canvas.box = { left: 20, top: 60, width: 800, height: 450 };
    const before = page.fake.of("preview_frame").length;
    await page.frames();
    expect(page.fake.last("preview_place")).toMatchObject({ x: 20, y: 60, width: 800, height: 450, visible: true });
    expect(page.fake.of("preview_frame").length).toBe(before + 1);
    player.dispose();
    expect(page.fake.of("preview_close")).toHaveLength(1);
    expect(page.root.classes.has("native-preview")).toBe(false);
    expect(page.root.background).toBe("#0b0b0b");
    expect(screen.panel.attributes.has("data-window")).toBe(false);
  });

  it("a seek rests on that moment's frame, and a drag asks only for where it is now", async () => {
    const { player, playhead } = await started();
    player.seek(25_000);
    await page.settle();
    expect(page.fake.last("preview_frame")).toEqual({ frame: 750 });
    // In the second footage item: a second in, so 6 s of the footage.
    expect([playhead.ms, playhead.sourceMs, playhead.playing]).toEqual([25_000, 6_000, false]);
    // A drag while a frame is still being drawn: the positions in between are never asked for.
    let done = () => {};
    page.fake.hold = new Promise((resolve) => { done = resolve; });
    player.seek(1_000);
    await page.settle();
    for (const ms of [2_000, 3_000, 4_000, 5_000]) player.seek(ms);
    page.fake.hold = null;
    done();
    await page.settle();
    expect(page.fake.of("preview_frame").slice(-2)).toEqual([{ frame: 30 }, { frame: 150 }]);
    expect(playhead.ms).toBe(5_000);
  });

  it("plays on the window's clock, the playhead following it through footage and cards, and rests on the cut's end", async () => {
    const { player, playhead } = await started();
    player.play(10_000);
    await page.settle();
    expect(page.fake.last("preview_play")).toEqual({ frame: 300 });
    expect(playhead.playing).toBe(true);
    page.fake.frame = 330.5;
    await page.frames();
    expect(playhead.ms).toBeCloseTo(11_016.67, 1);
    expect(playhead.sourceMs).toBeCloseTo(71_016.67, 1);
    expect(player.current?.id).toBe("a");
    // Into the card: the clock goes on (black under the card's words).
    page.fake.frame = 660;
    await page.frames();
    expect(playhead.ms).toBe(22_000);
    expect(player.current?.id).toBe("card");
    // The window reaches the end, which is the last card's.
    page.fake.frame = 1110; page.fake.playing = false; page.fake.ended = true;
    await page.frames();
    expect([playhead.ms, playhead.playing, player.playing]).toEqual([37_000, false, false]);
    expect(page.fake.last("preview_frame")).toEqual({ frame: 1109 });
    // Play again from the end starts over.
    player.play();
    await page.settle();
    expect(page.fake.last("preview_play")).toEqual({ frame: 0 });
  });

  it("a seek while playing plays on from there, and where the window was before it is never put back in the playhead", async () => {
    const { player, playhead } = await started();
    player.play(0);
    await page.settle();
    page.fake.frame = 60;
    await page.frames();
    expect(playhead.ms).toBe(2_000);
    // The old position is asked for, then the seek lands before its answer.
    let answer = (_value: unknown) => {};
    const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = invoke.invoke;
    invoke.invoke = (command, args) => (command === "preview_position" ? new Promise((resolve) => { answer = resolve; }) : original(command, args));
    await page.frames();
    player.seek(30_000);
    answer({ frame: 61, playing: true, ended: false, drawn: 1, skipped: 0, slow: 0, draws: [], starved: 0 });
    invoke.invoke = original;
    await page.settle();
    expect(page.fake.last("preview_play")).toEqual({ frame: 900 });
    expect(page.fake.of("preview_pause")).toEqual([]);
    expect([playhead.ms, playhead.playing]).toEqual([30_000, true]);
  });

  it("a pause rests on the frame the window stopped at", async () => {
    const { player, playhead } = await started();
    player.play(0);
    await page.settle();
    page.fake.frame = 44.2;
    await page.frames();
    // The clock moved on a little before the pause reached it.
    page.fake.frame = 47.9;
    player.pause();
    await page.settle();
    expect(page.fake.of("preview_pause")).toHaveLength(1);
    expect([playhead.ms, playhead.playing]).toEqual([(47 * 1000) / 30, false]);
    expect(page.fake.last("preview_frame")).toEqual({ frame: 47 });
    // And Space plays on from there.
    player.toggle();
    await page.settle();
    expect(page.fake.last("preview_play")).toEqual({ frame: 47 });
  });

  it("a play on the script writes its line in the log as it ends, as the editor's do", async () => {
    const posted: { level: string; message: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).includes("/api/diagnostics/client")) posted.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }));
    const { player } = await started();
    player.play(0);
    await page.settle();
    // 70 answers from the window while it plays, a frame shown in each.
    for (let n = 1; n <= 70; n++) {
      page.fake.frame = n;
      await page.frames();
    }
    player.pause();
    await page.settle();
    const line = posted.find((one) => one.message.includes("on the script"));
    expect(line).toMatchObject({ level: "info" });
    expect(line!.message).toMatch(/^preview: played 2\.3 s from 0:00 on the script: 70 frames shown, 0 passed over, 0 drawn late, the longest 3 ms; the sound never ran short$/);
  });

  it("a footage moment outside the cut is shown, and played straight through, as the whole recording; back in the cut it's the cut again", async () => {
    const { player, playhead } = await started();
    // 30 s of the footage: in neither item.
    player.cue(30_000);
    await page.settle();
    const audition = page.fake.project!;
    expect(audition.clips.filter((clip) => clip.type === "video").map((clip) => [clip.start, clip.duration, clip.source_in])).toEqual([[0, 18_000, 0]]);
    expect(page.fake.last("preview_frame")).toEqual({ frame: 900 });
    expect([playhead.sourceMs, playhead.auditioning, playhead.playing]).toEqual([30_000, true, false]);
    expect(player.current).toBeNull();
    // Space plays the footage from there.
    player.toggle();
    await page.settle();
    expect(page.fake.last("preview_play")).toEqual({ frame: 900 });
    // It runs into footage the cut plays (1:00 is the cut's start): the edited playhead follows.
    page.fake.frame = 1830;
    await page.frames();
    expect([playhead.sourceMs, playhead.ms, playhead.auditioning]).toEqual([61_000, 1_000, true]);
    // A word clicked that the cut plays: the cut is back, at that moment.
    player.cue(7_000);
    await page.settle();
    expect(page.fake.project!.clips.filter((clip) => clip.type === "video")).toHaveLength(2);
    expect(page.fake.last("preview_frame")).toEqual({ frame: 780 });
    expect([playhead.ms, playhead.auditioning, playhead.playing]).toEqual([26_000, false, false]);
    // A word double-clicked plays the footage from it.
    player.audition(100_000);
    await page.settle();
    expect(page.fake.last("preview_play")).toEqual({ frame: 3000 });
    // To the recording's end: the cut is what the next Space plays.
    page.fake.frame = 18_000; page.fake.playing = false; page.fake.ended = true;
    await page.frames();
    expect([playhead.auditioning, playhead.playing]).toEqual([false, false]);
    expect(page.fake.project!.clips.filter((clip) => clip.type === "video")).toHaveLength(2);
  });

  it("2× and the volume go to the window, the speed before the play it's for and during one", async () => {
    const { player } = await started();
    player.setVolume(0.4);
    player.setRate(2);
    player.play(0);
    await page.settle();
    const order = page.fake.calls.map(([name]) => name).filter((name) => name === "preview_rate" || name === "preview_play");
    expect(order).toEqual(["preview_rate", "preview_play"]);
    expect(page.fake.last("preview_rate")).toEqual({ rate: 2 });
    expect(page.fake.last("preview_volume")).toEqual({ level: 0.4 });
    player.setRate(1);
    await page.settle();
    expect(page.fake.last("preview_rate")).toEqual({ rate: 1 });
    // Playing carried on: no second play, no pause.
    expect(page.fake.of("preview_play")).toHaveLength(1);
    expect(page.fake.of("preview_pause")).toEqual([]);
  });

  it("the same cut read again sends nothing; a changed cut under a play goes whole and plays on from the same moment", async () => {
    const { player, playhead } = await started();
    player.play(0);
    await page.settle();
    page.fake.frame = 90;
    await page.frames();
    const sent = page.fake.of("preview_project").length;
    player.update(clips.map((clip) => ({ ...clip })));
    await page.settle();
    expect(page.fake.of("preview_project")).toHaveLength(sent);
    // The first item trimmed to 10 s.
    player.update([{ ...clips[0]!, endMs: 70_000 }, ...clips.slice(1)]);
    await page.settle();
    expect(page.fake.of("preview_project")).toHaveLength(sent + 1);
    expect(page.fake.project!.clips.find((clip) => clip.id === "v0")).toMatchObject({ duration: 300 });
    expect(page.fake.last("preview_play")).toEqual({ frame: 90 });
    expect([playhead.ms, playhead.playing, player.duration]).toEqual([3_000, true, 27_000]);
  });

  it("an ask that fails is tried again, and after three in a row the cut is handed back", async () => {
    const { player } = await started();
    page.fake.refuse = (command) => (command === "preview_frame" ? "No such file or directory" : null);
    player.seek(5_000);
    await page.settle();
    expect(lost).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    await page.settle();
    expect(lost).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    await page.settle();
    expect(lost).toEqual(["No such file or directory"]);
    // One that works in between starts the count again.
    lost.length = 0;
    page.fake.refuse = () => null;
    player.seek(6_000);
    await page.settle();
    page.fake.refuse = (command) => (command === "preview_frame" ? "busy" : null);
    player.seek(7_000);
    await page.settle();
    expect(lost).toEqual([]);
  });

  it("a window whose sound went silent (the recording gone from under it) hands the cut back at once, not after three asks", async () => {
    const { player, playhead } = await started();
    player.play(3_000);
    await page.settle();
    page.fake.frame = 150;
    await page.frames();
    expect([playhead.ms, lost]).toEqual([5_000, []]);
    // Its pictures still come (the file it had open), its mixer can't open the sound: said with the next position.
    page.fake.problem = "could not decode the sound of /scripts/s/proxy.mp4";
    await page.frames();
    expect(lost).toEqual(["its sound: could not decode the sound of /scripts/s/proxy.mp4"]);
    // Where it had got to stays in the playhead for the player that takes over.
    expect([playhead.ms, playhead.playing]).toEqual([5_000, true]);
  });

  it("a cut with nothing in it yet, and a play at its end, ask the window for nothing it would refuse", async () => {
    const { player, playhead } = await started([]);
    player.play();
    player.seek(0);
    await page.settle();
    expect(page.fake.of("preview_play")).toEqual([]);
    expect(playhead.playing).toBe(false);
    expect(lost).toEqual([]);
  });
});
