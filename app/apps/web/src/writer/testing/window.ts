// Edit.app's window for the script players' tests: its calls answered as
// crates/edit-window/src/preview.rs answers them, a page with a monitor to put
// the picture under, and animation frames that run when the test says.

import { vi } from "vitest";

type Args = Record<string, unknown>;

export interface FakeWindow {
  calls: [string, Args][];
  /** The edit it was last sent. */
  project: { clips: { id: string; type: string; start: number; duration: number; source_in?: number; media?: string }[]; media: { id: string; path: string }[]; settings: { width: number; height: number } } | null;
  /** Its clock while playing: the test moves it. */
  frame: number;
  playing: boolean;
  /** Reached the end since the last ask. */
  ended: boolean;
  /** Why its sound went silent since the last ask, or null. */
  problem: string | null;
  /** Why a command is refused, or null. */
  refuse: (command: string, args: Args) => string | null;
  /** A frame asked for waits on this, when set. */
  hold: Promise<void> | null;
  of(command: string): Args[];
  last(command: string): Args | undefined;
}

/** A monitor's canvas inside its screen and panel, `box` where it is on the page. */
export function monitor(box = { left: 10, top: 50, width: 640, height: 360 }) {
  const marked = (name: string) => {
    const attributes = new Map<string, string>();
    return { name, attributes, setAttribute: (key: string, value: string) => attributes.set(key, value), removeAttribute: (key: string) => attributes.delete(key) };
  };
  const screen = marked("screen");
  const panel = marked("monitor");
  const canvas = { width: 300, height: 150, box, getBoundingClientRect: () => canvas.box, closest: (selector: string) => (selector === ".screen" ? screen : selector === ".monitor" ? panel : null), getContext: () => ({ drawImage: vi.fn() }) };
  return { canvas: canvas as unknown as HTMLCanvasElement & { box: typeof box }, screen, panel };
}

/** Puts the page in Edit.app's window; `frames()` runs the animation frames asked for, `settle()` lets answers land. */
export function inWindow() {
  const fake: FakeWindow = {
    calls: [], project: null, frame: 0, playing: false, ended: false, problem: null, refuse: () => null, hold: null,
    of: (command) => fake.calls.filter(([name]) => name === command).map(([, args]) => args),
    last: (command) => fake.of(command).at(-1),
  };
  const length = () => Math.max(0, ...(fake.project?.clips ?? []).map((clip) => clip.start + clip.duration));
  const invoke = async (command: string, args: Args = {}) => {
    fake.calls.push([command, args]);
    const refused = fake.refuse(command, args);
    if (refused !== null) throw refused;
    switch (command) {
      case "preview_open": return true;
      case "preview_project": fake.project = JSON.parse(String(args.json)); return args.revision;
      case "preview_frame":
        if (fake.hold !== null) await fake.hold;
        return { revision: 0, drawn: true, skipped: false, ms: 4, decode: 3, composite: 0.5, present: 0.3, opens: 0, seeks: 0, ffmpeg: 0 };
      case "preview_play":
        if (Number(args.frame) >= length()) throw "at the end";
        fake.frame = Number(args.frame); fake.playing = true; fake.ended = false;
        return null;
      case "preview_pause": {
        if (!fake.playing) return null;
        fake.playing = false;
        return Math.floor(fake.frame);
      }
      case "preview_position": {
        const ended = fake.ended;
        fake.ended = false;
        const problem = fake.problem;
        fake.problem = null;
        return { frame: fake.frame, playing: fake.playing, ended, drawn: 1, skipped: 0, slow: 0, draws: [2.5], starved: 0, ...(problem === null ? {} : { problem }) };
      }
      default: return null;
    }
  };
  const root = { classes: new Set<string>(), background: "#0b0b0b" };
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke }, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.stubGlobal("document", {
    documentElement: {
      classList: { add: (name: string) => root.classes.add(name), remove: (name: string) => root.classes.delete(name) },
      style: { getPropertyValue: () => root.background, setProperty: (_name: string, value: string) => { root.background = value; } },
    },
  });
  const due = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { due.set(++next, callback); return next; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => due.delete(id));
  const settle = async () => { for (let turn = 0; turn < 40; turn++) await Promise.resolve(); };
  /** One animation frame, then the answers it asked for. */
  const frames = async (count = 1) => {
    for (let at = 0; at < count; at++) {
      const now = [...due.values()];
      due.clear();
      for (const callback of now) callback(0);
      await settle();
    }
  };
  return { fake, root, settle, frames };
}
