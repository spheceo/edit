// Which player plays a script's cut (player.ts): Edit.app's window when every
// recording is a file on the Mac, the page's otherwise, and the cut moved from
// one to the other at the same moment when that changes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CutSource } from "@edit/types/script_cut";

import type { Item } from "./playback";
import { inWindow, monitor } from "./testing/window";

const sources = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock("./api", () => ({ windowSources: sources.ask }));
vi.mock("../lib/decoder", async (original) => {
  const actual = await original<typeof import("../lib/decoder")>();
  const frame = { codedWidth: 854, codedHeight: 480, displayWidth: 854, displayHeight: 480 };
  return {
    ...actual,
    Decoder: class {
      picture() { return frame; }
      nearbyPicture() { return frame; }
      pcm() { return { channels: [new Float32Array(48)], sampleRate: 48_000 }; }
      requestVideo() {}
      requestRough() {}
      requestAudio() {}
      retain() {}
      dispose() {}
    },
  };
});

const SRC = "/api/writer/scripts/s/proxy?v=1";
const proxy: CutSource = { path: "/scripts/s/proxy.mp4", width: 1280, height: 720, durationMs: 600_000, fps: 30, sound: true };
const clips = [{ id: "a", startMs: 60_000, endMs: 80_000 }, { id: "b", startMs: 5_000, endMs: 15_000 }] as Item[];
const here = { cache: "/cache", sources: { [SRC]: proxy }, coming: [] as string[] };

describe("the script's player, chosen where it runs", () => {
  let page: ReturnType<typeof inWindow>;
  let players: typeof import("./player");
  let playback: typeof import("./playback");

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    page = inWindow();
    vi.stubGlobal("AudioContext", class {
      currentTime = 0; state = "running"; destination = {};
      resume() { return Promise.resolve(); }
      close() { return Promise.resolve(); }
      createGain() { return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }; }
      createBuffer() { return { copyToChannel: vi.fn() }; }
      createBufferSource() { return { buffer: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null }; }
    });
    sources.ask.mockReset();
    sources.ask.mockResolvedValue(here);
    players = await import("./player");
    playback = await import("./playback");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** A script page's player as editor.tsx sets one up. */
  function opened() {
    const playhead = new playback.Playhead();
    const player = players.newPlayer(clips, playhead, SRC, 600_000) as InstanceType<typeof players.EitherPlayer>;
    player.update(clips);
    player.setSource(SRC, 600_000);
    const screen = monitor();
    player.attach(screen.canvas);
    return { player, playhead, screen };
  }

  it("in a browser it's the page's player, and the window is never asked about", () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = undefined;
    const player = players.newPlayer(clips, new playback.Playhead());
    expect(player).toBeInstanceOf(playback.ScriptPlayer);
    expect(sources.ask).not.toHaveBeenCalled();
    player.dispose();
  });

  it("in Edit.app with the preview on this Mac it's the window's, and a play asked for before it was chosen starts on it", async () => {
    const { player, playhead } = opened();
    expect(player.drawnBy).toBe("choosing");
    player.setRate(2);
    player.play(4_000);
    await page.settle();
    expect(sources.ask).toHaveBeenCalledTimes(1);
    expect(sources.ask).toHaveBeenCalledWith([SRC]);
    expect(player.drawnBy).toBe("window");
    expect(page.fake.of("preview_open")).toHaveLength(1);
    expect(page.fake.last("preview_rate")).toEqual({ rate: 2 });
    expect(page.fake.last("preview_play")).toEqual({ frame: 120 });
    expect([playhead.ms, playhead.playing, player.playing]).toEqual([4_000, true, true]);
    player.dispose();
    expect(page.fake.of("preview_close")).toHaveLength(1);
  });

  it("a preview still in the cloud plays on the page's player, and moves to the window where it rests once it has come down", async () => {
    sources.ask.mockResolvedValue({ cache: "/cache", sources: {}, coming: [SRC] });
    const { player, playhead } = opened();
    await page.settle();
    expect(player.drawnBy).toBe("page");
    expect(page.fake.of("preview_open")).toEqual([]);
    player.seek(12_000);
    // Asked again a while later: here now.
    sources.ask.mockResolvedValue(here);
    await vi.advanceTimersByTimeAsync(15_000);
    await page.settle();
    expect(sources.ask).toHaveBeenCalledTimes(2);
    expect(player.drawnBy).toBe("window");
    expect(page.fake.last("preview_frame")).toEqual({ frame: 360 });
    expect([playhead.ms, playhead.playing]).toEqual([12_000, false]);
  });

  it("mid-play it stays on the page's player until it rests", async () => {
    sources.ask.mockResolvedValue({ cache: "/cache", sources: {}, coming: [SRC] });
    const { player } = opened();
    await page.settle();
    player.play(0);
    sources.ask.mockResolvedValue(here);
    await vi.advanceTimersByTimeAsync(15_000);
    await page.settle();
    expect([player.drawnBy, player.playing]).toEqual(["page", true]);
    player.pause();
    await vi.advanceTimersByTimeAsync(15_000);
    await page.settle();
    expect(player.drawnBy).toBe("window");
  });

  it("a recording that isn't on this Mac at all leaves the cut to the page's player, with nothing asked again", async () => {
    sources.ask.mockResolvedValue({ cache: "/cache", sources: {}, coming: [] });
    const { player } = opened();
    await page.settle();
    expect(player.drawnBy).toBe("page");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sources.ask).toHaveBeenCalledTimes(1);
    // A commentary's clip whose footage has arrived names a new recording: asked about then.
    const other = "/api/writer/scripts/s/footage/yt-abc-0.mp4";
    sources.ask.mockResolvedValue({ cache: "/cache", sources: { [SRC]: proxy, [other]: { ...proxy, path: "/scripts/s/footage/yt-abc-0.mp4" } }, coming: [] });
    player.update([...clips, { id: "c", startMs: 0, endMs: 3_000, src: other } as Item]);
    await page.settle();
    expect(sources.ask).toHaveBeenLastCalledWith([SRC, other]);
    expect(player.drawnBy).toBe("window");
    expect(page.fake.project!.media.map((media) => media.id).sort()).toEqual([SRC, other].sort());
  });

  it("a window that can't go on hands the cut back to the page's player at the same moment, still playing, and isn't tried again", async () => {
    const { player, playhead, screen } = opened();
    await page.settle();
    player.play(0);
    await page.settle();
    page.fake.frame = 150;
    await page.frames();
    expect(playhead.ms).toBe(5_000);
    // Its player thread is gone: every ask of it fails.
    page.fake.refuse = (command) => (command === "preview_close" || command === "preview_place" ? null : "the preview stopped");
    for (let turn = 0; turn < 3; turn++) {
      await page.frames();
      await vi.advanceTimersByTimeAsync(300);
      await page.settle();
    }
    expect(player.drawnBy).toBe("page");
    expect(page.fake.of("preview_close")).toHaveLength(1);
    expect(page.root.classes.has("native-preview")).toBe(false);
    expect(screen.panel.attributes.has("data-window")).toBe(false);
    expect([playhead.ms, player.playing]).toEqual([5_000, true]);
    // A changed cut doesn't bring the window back.
    page.fake.refuse = () => null;
    player.update([clips[0]!]);
    await page.settle();
    expect(player.drawnBy).toBe("page");
  });

  it("a player nobody sees asks for nothing: no canvas, no question to the server, no window", async () => {
    const player = players.newPlayer(clips, new playback.Playhead(), SRC, 600_000) as InstanceType<typeof players.EitherPlayer>;
    player.update(clips);
    player.setSource(SRC, 600_000);
    await page.settle();
    expect(sources.ask).not.toHaveBeenCalled();
    expect(page.fake.calls).toEqual([]);
    expect(player.drawnBy).toBe("choosing");
  });

  it("disposed and used again (React's StrictMode in development) it's the window's again, at the same moment", async () => {
    // StrictMode makes the player twice; the one it keeps is unmounted once and mounted again.
    const never = players.newPlayer(clips, new playback.Playhead(), SRC, 600_000);
    const { player, playhead, screen } = opened();
    await page.settle();
    expect(player.drawnBy).toBe("window");
    player.attach(null);
    player.dispose();
    expect(page.fake.of("preview_close")).toHaveLength(1);
    player.attach(screen.canvas);
    player.update(clips);
    player.setSource(SRC, 600_000);
    await page.settle();
    expect(player.drawnBy).toBe("window");
    expect(page.fake.of("preview_open")).toHaveLength(2);
    expect(screen.panel.attributes.has("data-window")).toBe(true);
    player.seek(8_000);
    await page.settle();
    expect(page.fake.last("preview_frame")).toEqual({ frame: 240 });
    expect(playhead.ms).toBe(8_000);
    // What checks drive is the player on screen, not the one never shown.
    expect((window as unknown as { __editScript: { player: unknown } }).__editScript.player).toBe(player);
    expect(sources.ask.mock.calls.every(([srcs]) => srcs.length === 1)).toBe(true);
    never.dispose();
  });

  it("a window that can't open its layer leaves the page's player", async () => {
    page.fake.refuse = (command) => (command === "preview_open" ? "no GPU for the preview" : null);
    const { player } = opened();
    await page.settle();
    expect(player.drawnBy).toBe("page");
    expect(player.framed).toBe(false);
  });
});
