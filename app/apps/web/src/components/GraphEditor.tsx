import { readSetting, writeSetting } from "../lib/storage";
// After Effects-style graph editor for the selected clip’s keyframes: a value
// graph and a speed graph, bezier handles on the keyframes, and marquee
// selection. Shares the timeline’s zoom, scroll, ruler and playhead, so curves
// line up with the cut.

import { Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { controlPoints, effectiveHandles, isAnimated, paramAt, sample, segmentSpeed, setParam } from "../lib/edit";
import { playhead, preview } from "../lib/playback";
import { useEditor } from "../lib/store";
import { drawMarquee, drawPlayhead, drawRuler, getLanesWidth, leftTheWindow, MOST_PPF, RULER, setLanesWidth, setView, useView } from "../lib/timelineView";
import { ANIMATABLE, type Clip, type Ease, type Handle, type Keyframe, rate } from "../lib/types";
import { openMenu } from "./ContextMenu";
import { cx } from "./ui";

export const GRAPH_HEADER = 176;
const HIT = 7;
const MIN_INFLUENCE = 0.01;
/** ⇧ while dragging an arm: how close (px) it must come to flat or linear to lock on. */
const SNAP_PX = 18;

/** ⇧: reach in 5% steps, with AE’s ⅓ and ⅔ as stops too. */
function snapInfluence(influence: number) {
  const stops = [1 / 3, 2 / 3, Math.round(influence * 20) / 20];
  const nearest = stops.reduce((best, stop) => (Math.abs(stop - influence) < Math.abs(best - influence) ? stop : best));
  return Math.min(1, Math.max(0.05, nearest));
}
/** After Effects' Easy Ease: flat at the key, a third of the way along. */
const EASY: Handle = { speed: 0, influence: 1 / 3 };

const PARAM_INFO: Record<string, { label: string; color: string; format: (value: number) => string }> = {
  opacity: { label: "Opacity", color: "#e5e5e5", format: (v) => `${Math.round(v * 100)}%` },
  x: { label: "Position X", color: "#ff6b6b", format: (v) => `${Math.round(v)} px` },
  y: { label: "Position Y", color: "#4ade80", format: (v) => `${Math.round(v)} px` },
  scale: { label: "Scale", color: "#60a5fa", format: (v) => `${(v * 100).toFixed(1)}%` },
  rotation: { label: "Rotation", color: "#fbbf24", format: (v) => `${v.toFixed(1)}°` },
  shake: { label: "Shake", color: "#fb923c", format: (v) => `${v.toFixed(1)} px` },
  size: { label: "Size", color: "#c084fc", format: (v) => `${Math.round(v)} px` },
  tracking: { label: "Tracking", color: "#22d3ee", format: (v) => `${v.toFixed(1)} px` },
  "glow.radius": { label: "Glow blur", color: "#f472b6", format: (v) => `${Math.round(v)} px` },
  "glow.strength": { label: "Glow opacity", color: "#fb7185", format: (v) => `${Math.round(v * 100)}%` },
  volume_db: { label: "Volume", color: "#4ade80", format: (v) => `${v.toFixed(1)} dB` },
  exposure: { label: "Exposure", color: "#fde047", format: (v) => `${v.toFixed(2)} ev` },
  contrast: { label: "Contrast", color: "#a3e635", format: (v) => v.toFixed(2) },
  saturation: { label: "Saturation", color: "#38bdf8", format: (v) => v.toFixed(2) },
  temperature: { label: "Temperature", color: "#fb923c", format: (v) => v.toFixed(2) },
  vignette: { label: "Vignette", color: "#a78bfa", format: (v) => v.toFixed(2) },
  vignette_x: { label: "Vignette X", color: "#f87171", format: (v) => `${Math.round(v)} px` },
  vignette_y: { label: "Vignette Y", color: "#86efac", format: (v) => `${Math.round(v)} px` },
  vignette_size: { label: "Vignette size", color: "#c4b5fd", format: (v) => v.toFixed(2) },
  leak: { label: "Light leak", color: "#fdba74", format: (v) => v.toFixed(2) },
  leak_x: { label: "Leak from", color: "#fcd34d", format: (v) => v.toFixed(2) },
  glitch: { label: "Glitch", color: "#2dd4bf", format: (v) => `${Math.round(v)} px` },
  blur: { label: "Blur", color: "#93c5fd", format: (v) => `${Math.round(v)} px` },
  "blur.x": { label: "Blur X", color: "#f87171", format: (v) => `${Math.round(v)} px` },
  "blur.y": { label: "Blur Y", color: "#86efac", format: (v) => `${Math.round(v)} px` },
  "blur.width": { label: "Blur width", color: "#fcd34d", format: (v) => `${Math.round(v)} px` },
  "blur.height": { label: "Blur height", color: "#fdba74", format: (v) => `${Math.round(v)} px` },
  "leader.x": { label: "Line start X", color: "#f87171", format: (v) => `${Math.round(v)} px` },
  "leader.y": { label: "Line start Y", color: "#86efac", format: (v) => `${Math.round(v)} px` },
};

const EASES: { ease: Ease; label: string }[] = [
  { ease: "linear", label: "Linear" },
  { ease: "in", label: "Ease in" },
  { ease: "out", label: "Ease out" },
  { ease: "in_out", label: "Ease in & out" },
  { ease: "hold", label: "Hold" },
];

type Mode = "value" | "speed";
type Side = "in" | "out";
type KeyRef = { param: string; index: number };
type HandleRef = KeyRef & { side: Side };
const keyId = (ref: KeyRef) => `${ref.param}:${ref.index}`;
const parseId = (id: string): KeyRef => ({ param: id.slice(0, id.lastIndexOf(":")), index: Number(id.slice(id.lastIndexOf(":") + 1)) });

interface Range {
  lo: number;
  hi: number;
}

const padded = (values: number[], flat: number): Range => {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const pad = hi - lo < 1e-6 ? Math.max(Math.abs(lo) * 0.2, flat) : (hi - lo) * 0.15;
  lo -= pad;
  hi += pad;
  return { lo, hi };
};

/** Value range a param’s curve spans, overshoot included, as in AE’s auto-zoomed value graph. */
function valueRange(clip: Clip, param: string): Range {
  const keys = clip.keyframes?.[param] ?? [];
  const values = keys.length ? keys.map((key) => key.value) : [paramAt(clip, param, clip.start)];
  for (let i = 0; i < keys.length - 1; i++) {
    if (keys[i].ease === "hold") continue;
    for (let step = 1; step < 16; step++) values.push(sample(keys, keys[i].frame + ((keys[i + 1].frame - keys[i].frame) * step) / 16)!);
  }
  return padded(values, param.includes("x") || param === "y" || param === "size" ? 20 : 0.2);
}

/** Speed (value per frame) at a local frame: zero outside the keys and on holds. */
function speedAt(keys: Keyframe[], frame: number) {
  for (let i = 0; i < keys.length - 1; i++) {
    if (frame >= keys[i].frame && frame < keys[i + 1].frame) return segmentSpeed(keys[i], keys[i + 1], frame);
  }
  return 0;
}

/** Speed range: every handle’s speed and the curve between, always including zero. */
function speedRange(clip: Clip, param: string): Range {
  const keys = clip.keyframes?.[param] ?? [];
  const speeds = [0];
  for (let i = 0; i < keys.length - 1; i++) {
    if (keys[i].ease === "hold") continue;
    const [out, inn] = effectiveHandles(keys[i], keys[i + 1]);
    speeds.push(out.speed, inn.speed);
    for (let step = 1; step < 16; step++) speeds.push(segmentSpeed(keys[i], keys[i + 1], keys[i].frame + ((keys[i + 1].frame - keys[i].frame) * step) / 16));
  }
  return padded(speeds, 0.01);
}

/** The neighbour a handle reaches toward, if that side of the key has a curve. */
function neighbourOf(keys: Keyframe[], index: number, side: Side): Keyframe | undefined {
  if (side === "out") return keys[index].ease === "hold" ? undefined : keys[index + 1];
  const previous = keys[index - 1];
  return previous && previous.ease !== "hold" ? previous : undefined;
}

/** A key’s effective handle on one side. */
function handleOf(keys: Keyframe[], index: number, side: Side): Handle | undefined {
  const neighbour = neighbourOf(keys, index, side);
  if (!neighbour) return undefined;
  return side === "out" ? effectiveHandles(keys[index], neighbour)[0] : effectiveHandles(neighbour, keys[index])[1];
}

export function GraphEditor() {
  const project = useEditor((state) => state.project)!;
  const selection = useEditor((state) => state.selection);
  const clip = selection.length === 1 ? project.clips.find((candidate) => candidate.id === selection[0]) : undefined;
  const animated = clip ? ANIMATABLE[clip.type].filter((param) => isAnimated(clip, param)) : [];
  const [mode, setModeState] = useState<Mode>(() => (readSetting("edit.graph.mode") === "speed" ? "speed" : "value"));
  /** Properties picked to show; null = every animated one. */
  const [only, setOnly] = useState<string[] | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const picked = only ? animated.filter((param) => only.includes(param)) : animated;
  const shown = picked.length ? picked : animated;
  const focused = focus && shown.includes(focus) ? focus : (shown[0] ?? null);

  const setMode = (next: Mode) => {
    writeSetting("edit.graph.mode", next);
    setModeState(next);
  };

  // A new clip starts fresh.
  useEffect(() => {
    setSelected(new Set());
    setFocus(null);
    setOnly(null);
  }, [clip?.id]);

  /** Click: show just this one (again: show all). ⇧/⌘-click or the eye: add or remove it. */
  const pick = (param: string, add: boolean) => {
    setFocus(param);
    if (!add) {
      setOnly(only?.length === 1 && only[0] === param ? null : [param]);
      return;
    }
    const current = only ?? animated;
    const next = current.includes(param) ? current.filter((candidate) => candidate !== param) : [...current, param];
    if (next.length) setOnly(next.length === animated.length ? null : next);
  };

  return (
    <div className="absolute inset-0 z-10 flex bg-panel">
      <div className="flex shrink-0 flex-col overflow-y-auto border-r border-line" style={{ width: GRAPH_HEADER }}>
        <div className="flex shrink-0 items-center gap-1 px-1.5" style={{ height: RULER }}>
          <div className="flex rounded-md bg-black p-0.5 ring-1 ring-line">
            {(["value", "speed"] as const).map((value) => (
              <button
                key={value}
                title={value === "value" ? "Value graph: the curve itself" : "Speed graph: how fast it changes"}
                onClick={() => setMode(value)}
                className={cx("h-5 rounded px-2 text-[11px] transition-colors", mode === value ? "bg-active text-fg" : "text-faint hover:text-muted")}
              >
                {value === "value" ? "Value" : "Speed"}
              </button>
            ))}
          </div>
          {only && animated.length > 1 && (
            <button onClick={() => setOnly(null)} className="ml-auto px-1 text-[11px] text-faint transition-colors hover:text-fg">
              All
            </button>
          )}
        </div>
        {clip && !animated.length && <p className="px-2.5 py-2 text-[11px] leading-relaxed text-faint">Nothing on this clip is animated. Use ◇ in Info to animate a value.</p>}
        {clip &&
          animated.map((param) => (
            <ParamRow
              key={param}
              clip={clip}
              param={param}
              focused={param === focused}
              shown={shown.includes(param)}
              onPick={(add) => pick(param, add)}
            />
          ))}
      </div>
      <Curves clip={clip} params={shown} focused={focused} mode={mode} selected={selected} setSelected={setSelected} />
    </div>
  );
}

function ParamRow({ clip, param, focused, shown, onPick }: { clip: Clip; param: string; focused: boolean; shown: boolean; onPick: (add: boolean) => void }) {
  const info = PARAM_INFO[param];
  const frame = useFrame();
  return (
    <div
      onClick={(event) => onPick(event.shiftKey || event.metaKey || event.ctrlKey)}
      title="Click to show only this · ⇧-click to show alongside others"
      className={cx(
        "group flex h-7 shrink-0 cursor-pointer items-center gap-2 px-2.5 text-[12px] transition-colors",
        focused ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
        !shown && "opacity-45",
      )}
    >
      <span className="size-[7px] shrink-0 rotate-45 rounded-[1px]" style={{ background: shown ? info.color : "transparent", boxShadow: `inset 0 0 0 1.5px ${info.color}` }} />
      <span className="min-w-0 flex-1 truncate">{info.label}</span>
      <span className="font-mono text-[10px] text-faint tabular">{info.format(paramAt(clip, param, frame))}</span>
      <button
        title={shown ? "Hide curve" : "Show curve"}
        onClick={(event) => {
          event.stopPropagation();
          onPick(true);
        }}
        className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg"
      >
        {shown ? <Eye size={11} /> : <EyeOff size={11} />}
      </button>
    </div>
  );
}

function useFrame() {
  const [frame, setFrame] = useState(Math.floor(playhead.frame));
  useEffect(() => {
    const unsubscribe = playhead.subscribe(() => setFrame(Math.floor(playhead.frame / (playhead.playing ? 4 : 1)) * (playhead.playing ? 4 : 1)));
    return () => void unsubscribe();
  }, []);
  return frame;
}

type Drag =
  | { kind: "scrub" }
  | { kind: "keys"; x: number; y: number; ranges: Map<string, Range>; start: { ref: KeyRef; frame: number; value: number }[]; moved: boolean }
  | { kind: "handle"; ref: HandleRef; x: number; y: number; ranges: Map<string, Range>; moved: boolean; snapped: number | null }
  | { kind: "marquee"; x0: number; y0: number; x: number; y: number; base: Set<string> };

function Curves({
  clip,
  params,
  focused,
  mode,
  selected,
  setSelected,
}: {
  clip?: Clip;
  params: string[];
  focused: string | null;
  mode: Mode;
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const hover = useRef<{ x: number; y: number } | null>(null);
  const frozen = useRef<Map<string, Range> | null>(null);
  const queued = useRef(0);
  const state = useRef({ clip, params, focused, mode, selected });
  state.current = { clip, params, focused, mode, selected };
  const fps = useEditor((editor) => (editor.project ? rate(editor.project.settings) : 30));

  const requestDraw = () => {
    if (queued.current) return;
    queued.current = requestAnimationFrame(() => {
      queued.current = 0;
      draw();
    });
  };

  // The graph owns the lane width while it’s open; hand it back on close.
  useEffect(() => {
    const wrap = wrapRef.current!;
    const previous = getLanesWidth();
    const observer = new ResizeObserver(() => {
      setLanesWidth(wrap.clientWidth);
      setView({});
      requestDraw();
    });
    observer.observe(wrap);
    // The timeline’s own zoom comes back on close.
    const { ppf, scrollX } = useView.getState();
    return () => {
      observer.disconnect();
      setLanesWidth(previous);
      setView({ ppf, scrollX });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Frame the clip’s keyframes (or the clip) so short moves are big enough to work on.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!clip || !wrap) return;
    const frames = Object.values(clip.keyframes ?? {}).flatMap((keys) => keys.map((key) => key.frame));
    const from = clip.start + (frames.length > 1 ? Math.min(...frames) : 0);
    const to = clip.start + (frames.length > 1 ? Math.max(...frames) : clip.duration);
    const span = Math.max(8, to - from);
    const pad = span * 0.15;
    setLanesWidth(wrap.clientWidth);
    const next = Math.min(MOST_PPF, wrap.clientWidth / (span + pad * 2));
    setView({ ppf: next, scrollX: (from - pad) * next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.id]);

  useEffect(() => {
    const offPlayhead = playhead.subscribe(requestDraw);
    const offView = useView.subscribe(requestDraw);
    const offEditor = useEditor.subscribe(requestDraw);
    return () => {
      offPlayhead();
      offView();
      offEditor();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(requestDraw);

  // Delete removes selected keyframes (and not the clip); F9 eases them, as in After Effects.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      const { clip, selected } = state.current;
      if (!clip || !selected.size) return;
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        event.stopPropagation();
        deleteKeys(clip, [...selected]);
        setSelected(new Set());
      } else if (event.key === "F9") {
        event.preventDefault();
        easyEase(clip, [...selected]);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [setSelected]);

  const geometry = () => {
    const canvas = canvasRef.current!;
    const top = RULER + 14;
    const bottom = canvas.clientHeight - 16;
    return { width: canvas.clientWidth, height: canvas.clientHeight, top, bottom };
  };
  const frameToX = (frame: number) => frame * useView.getState().ppf - useView.getState().scrollX;
  const xToFrame = (x: number) => (x + useView.getState().scrollX) / useView.getState().ppf;
  const onPlayhead = (x: number) => Math.abs(x - frameToX(playhead.frame)) <= 5;
  /** Each shown param’s vertical range: values, or speeds (value per frame). */
  const ranges = () => {
    const { clip, params, mode } = state.current;
    if (frozen.current) return frozen.current;
    return new Map(params.map((param) => [param, mode === "value" ? valueRange(clip!, param) : speedRange(clip!, param)]));
  };
  const toY = (value: number, range: Range) => {
    const { top, bottom } = geometry();
    return bottom - ((value - range.lo) / (range.hi - range.lo || 1)) * (bottom - top);
  };
  const fromY = (y: number, range: Range) => {
    const { top, bottom } = geometry();
    return range.lo + ((bottom - y) / (bottom - top || 1)) * (range.hi - range.lo);
  };

  /** Where a key is drawn: one point on the value curve, or its in/out speeds on the speed graph. */
  function keyPoints(clip: Clip, param: string, index: number, range: Range): { x: number; y: number }[] {
    const keys = clip.keyframes![param];
    const x = frameToX(clip.start + keys[index].frame);
    if (state.current.mode === "value") return [{ x, y: toY(keys[index].value, range) }];
    const speeds = (["in", "out"] as const).map((side) => handleOf(keys, index, side)?.speed).filter((speed) => speed !== undefined);
    return (speeds.length ? speeds : [0]).map((speed) => ({ x, y: toY(speed, range) }));
  }

  /** A handle’s arm: from its root at the key to the end you drag. */
  function handleArm(clip: Clip, ref: HandleRef, range: Range): { root: { x: number; y: number }; end: { x: number; y: number } } | null {
    const keys = clip.keyframes![ref.param];
    const key = keys[ref.index];
    const neighbour = neighbourOf(keys, ref.index, ref.side);
    if (!neighbour) return null;
    const keyX = frameToX(clip.start + key.frame);
    if (state.current.mode === "value") {
      const point = ref.side === "out" ? controlPoints(key, neighbour)[0] : controlPoints(neighbour, key)[1];
      return { root: { x: keyX, y: toY(key.value, range) }, end: { x: frameToX(clip.start + point[0]), y: toY(point[1], range) } };
    }
    const handle = handleOf(keys, ref.index, ref.side)!;
    const span = Math.abs(neighbour.frame - key.frame);
    const endFrame = key.frame + (ref.side === "out" ? 1 : -1) * handle.influence * span;
    const y = toY(handle.speed, range);
    return { root: { x: keyX, y }, end: { x: frameToX(clip.start + endFrame), y } };
  }

  /** Keys that show their handles: selected ones, and all of the focused property’s. */
  function handleRefs(): HandleRef[] {
    const { clip, params, focused, selected } = state.current;
    if (!clip) return [];
    const refs: HandleRef[] = [];
    for (const param of params) {
      (clip.keyframes?.[param] ?? []).forEach((_, index) => {
        if (param !== focused && !selected.has(keyId({ param, index }))) return;
        for (const side of ["in", "out"] as const) refs.push({ param, index, side });
      });
    }
    return refs;
  }

  function hitHandle(x: number, y: number): HandleRef | null {
    const { clip } = state.current;
    if (!clip) return null;
    const all = ranges();
    for (const ref of handleRefs().reverse()) {
      const arm = handleArm(clip, ref, all.get(ref.param)!);
      if (arm && Math.abs(arm.end.x - x) <= HIT - 1 && Math.abs(arm.end.y - y) <= HIT - 1) return ref;
    }
    return null;
  }

  /** Keyframe under the pointer, preferring the focused param. */
  function hit(x: number, y: number): KeyRef | null {
    const { clip, params, focused } = state.current;
    if (!clip) return null;
    const all = ranges();
    const order = focused ? [focused, ...params.filter((param) => param !== focused)] : params;
    for (const param of order) {
      const keys = clip.keyframes?.[param];
      const range = all.get(param);
      if (!keys || !range) continue;
      for (let index = keys.length - 1; index >= 0; index--) {
        if (keyPoints(clip, param, index, range).some((point) => Math.abs(point.x - x) <= HIT && Math.abs(point.y - y) <= HIT)) return { param, index };
      }
    }
    return null;
  }

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const { width, height, top, bottom } = geometry();
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const { clip, params, focused, mode, selected } = state.current;
    const { ppf, scrollX } = useView.getState();

    const message = (text: string) => {
      ctx.fillStyle = "#5c5c5c";
      ctx.font = "13px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(text, width / 2, (top + bottom) / 2);
      ctx.textAlign = "left";
    };

    if (!clip) {
      message("Select a clip to see its animation curves");
      drawRuler(ctx, width, fps, ppf, scrollX, preview.sections);
      drawPlayhead(ctx, Math.round(frameToX(playhead.frame)) + 0.5, height);
      return;
    }

    // The clip’s span; outside it is dimmed.
    const x0 = frameToX(clip.start);
    const x1 = frameToX(clip.start + clip.duration);
    ctx.fillStyle = "rgba(255,255,255,0.025)";
    ctx.fillRect(Math.max(0, x0), RULER, Math.min(width, x1) - Math.max(0, x0), height - RULER);

    const all = ranges();
    const focusRange = focused ? all.get(focused) : undefined;
    // Grid labelled with the focused param’s values (or speeds per second).
    ctx.font = "10px ui-monospace, 'SF Mono', Menlo, monospace";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const y = Math.round(top + ((bottom - top) * i) / 4) + 0.5;
      ctx.fillStyle = "rgba(255,255,255,0.05)";
      ctx.fillRect(0, y, width, 1);
      if (focused && focusRange) {
        const value = focusRange.hi - ((focusRange.hi - focusRange.lo) * i) / 4;
        ctx.fillStyle = "#5c5c5c";
        ctx.fillText(mode === "value" ? PARAM_INFO[focused].format(value) : formatSpeed(focused, value, fps), 6, y - 7);
      }
    }
    // Zero speed, for reference.
    if (mode === "speed" && focusRange) {
      const y = Math.round(toY(0, focusRange)) + 0.5;
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.fillRect(0, y, width, 1);
    }

    if (!params.length) message("Nothing on this clip is animated yet. Use ◇ in Info to animate a value.");

    // Curves: focused on top.
    const order = focused && params.includes(focused) ? [...params.filter((param) => param !== focused), focused] : params;
    const handles = handleRefs();
    for (const param of order) {
      const keys = clip.keyframes?.[param] ?? [];
      const range = all.get(param)!;
      const color = PARAM_INFO[param].color;
      const isFocused = param === focused;
      ctx.strokeStyle = color;
      ctx.globalAlpha = isFocused ? 1 : 0.55;
      ctx.lineWidth = isFocused ? 2 : 1.25;
      ctx.beginPath();
      const from = Math.max(0, Math.floor(x0));
      const to = Math.min(width, Math.ceil(x1));
      for (let x = from; x <= to; x += 1) {
        const local = xToFrame(x) - clip.start;
        const value = mode === "value" ? (sample(keys, local) ?? paramAt(clip, param, clip.start)) : speedAt(keys, local);
        const y = toY(value, range);
        if (x === from) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      // ⇧-snapped arm: a guide along the speed it locked to, out to the neighbouring key.
      const held = drag.current;
      if (held?.kind === "handle" && held.snapped !== null && held.ref.param === param) {
        const key = keys[held.ref.index];
        const neighbour = key && neighbourOf(keys, held.ref.index, held.ref.side);
        if (neighbour) {
          const value = (frame: number) => (mode === "speed" ? held.snapped! : key.value + held.snapped! * (frame - key.frame));
          ctx.save();
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = "rgba(255,255,255,0.35)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(frameToX(clip.start + key.frame), toY(value(key.frame), range));
          ctx.lineTo(frameToX(clip.start + neighbour.frame), toY(value(neighbour.frame), range));
          ctx.stroke();
          ctx.restore();
        }
      }

      // Handles: an arm from the key, a dot to drag.
      for (const ref of handles) {
        if (ref.param !== param) continue;
        const arm = handleArm(clip, ref, range);
        if (!arm || Math.max(arm.root.x, arm.end.x) < -10 || Math.min(arm.root.x, arm.end.x) > width + 10) continue;
        const active = (drag.current?.kind === "handle" && sameHandle(drag.current.ref, ref)) || selected.has(keyId(ref));
        ctx.globalAlpha = isFocused || active ? 0.9 : 0.5;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(arm.root.x, arm.root.y);
        ctx.lineTo(arm.end.x, arm.end.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(arm.end.x, arm.end.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = drag.current?.kind === "handle" && sameHandle(drag.current.ref, ref) ? "#ffffff" : "#0a0a0a";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Keyframes.
      keys.forEach((key: Keyframe, index) => {
        const isSelected = selected.has(keyId({ param, index }));
        for (const { x: kx, y: ky } of keyPoints(clip, param, index, range)) {
          if (kx < -10 || kx > width + 10) continue;
          ctx.beginPath();
          if (key.ease === "hold") ctx.rect(kx - 4, ky - 4, 8, 8);
          else {
            ctx.moveTo(kx, ky - 5.5);
            ctx.lineTo(kx + 5.5, ky);
            ctx.lineTo(kx, ky + 5.5);
            ctx.lineTo(kx - 5.5, ky);
            ctx.closePath();
          }
          ctx.fillStyle = isSelected ? "#ffffff" : "#0a0a0a";
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = isSelected ? "#ffffff" : color;
          ctx.globalAlpha = isFocused || isSelected ? 1 : 0.7;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      });
    }

    // Hover readout on a handle or keyframe.
    const point = hover.current;
    if (point && !drag.current) {
      const overHandle = hitHandle(point.x, point.y);
      const over = overHandle ? null : hit(point.x, point.y);
      let label = "";
      let at: { x: number; y: number } | null = null;
      if (overHandle) {
        const handle = handleOf(clip.keyframes![overHandle.param], overHandle.index, overHandle.side)!;
        label = `${overHandle.side === "in" ? "In" : "Out"} · ${formatSpeed(overHandle.param, handle.speed, fps)} · influence ${Math.round(handle.influence * 100)}%`;
        at = handleArm(clip, overHandle, all.get(overHandle.param)!)!.end;
      } else if (over) {
        const keys = clip.keyframes![over.param];
        const key = keys[over.index];
        const speeds = (["in", "out"] as const)
          .map((side) => [side, handleOf(keys, over.index, side)] as const)
          .filter(([, handle]) => handle)
          .map(([side, handle]) => `${side} ${formatSpeed(over.param, handle!.speed, fps)}`);
        label =
          mode === "value"
            ? `${PARAM_INFO[over.param].label} ${PARAM_INFO[over.param].format(key.value)} · f${Math.round(key.frame)}`
            : `${PARAM_INFO[over.param].label} · ${speeds.join(" · ") || "held"}`;
        at = keyPoints(clip, over.param, over.index, all.get(over.param)!)[0];
      }
      if (label && at) {
        ctx.font = "11px Inter, system-ui, sans-serif";
        const w = ctx.measureText(label).width + 12;
        const bx = Math.max(4, Math.min(width - w - 4, at.x + 10));
        ctx.fillStyle = "rgba(19,19,19,0.95)";
        ctx.beginPath();
        ctx.roundRect(bx, at.y - 22, w, 20, 6);
        ctx.fill();
        ctx.fillStyle = "#ededed";
        ctx.textBaseline = "middle";
        ctx.fillText(label, bx + 6, at.y - 12);
      }
    }

    drawMarquee(ctx, drag.current?.kind === "marquee" ? drag.current : null);
    drawRuler(ctx, width, fps, ppf, scrollX, preview.sections);
    drawPlayhead(ctx, Math.round(frameToX(playhead.frame)) + 0.5, height);
  }

  const local = (event: { clientX: number; clientY: number }) => {
    const box = canvasRef.current!.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const select = (next: Set<string>) => {
    setSelected(next);
    state.current.selected = next;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const { x, y } = local(event);
    canvasRef.current!.setPointerCapture(event.pointerId);
    const handle = y >= RULER ? hitHandle(x, y) : null;
    const ref = handle ? null : hit(x, y);
    if (y < RULER || (onPlayhead(x) && !handle && !ref)) {
      drag.current = { kind: "scrub" };
      preview.seek(Math.round(xToFrame(x)));
      return;
    }
    const { clip, selected } = state.current;
    if (!clip) return;
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    if (handle) {
      if (!selected.has(keyId(handle))) select(additive ? new Set([...selected, keyId(handle)]) : new Set([keyId(handle)]));
      frozen.current = ranges();
      drag.current = { kind: "handle", ref: handle, x, y, ranges: frozen.current, moved: false, snapped: null };
      return;
    }
    if (!ref) {
      // Empty space: drag out a box to select keyframes.
      const base = additive ? new Set(selected) : new Set<string>();
      select(base);
      drag.current = { kind: "marquee", x0: x, y0: y, x, y, base };
      return;
    }
    const id = keyId(ref);
    let next = selected;
    if (additive) {
      next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
    } else if (!selected.has(id)) next = new Set([id]);
    select(next);
    const startRanges = ranges();
    frozen.current = startRanges;
    drag.current = {
      kind: "keys",
      x,
      y,
      ranges: startRanges,
      moved: false,
      start: [...next].map((key) => {
        const ref = parseId(key);
        const keyframe = clip.keyframes![ref.param][ref.index];
        return { ref, frame: keyframe.frame, value: keyframe.value };
      }),
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = local(event);
    hover.current = point;
    const current = drag.current;
    if (!current) {
      canvasRef.current!.style.cursor =
        point.y >= RULER && hitHandle(point.x, point.y)
          ? "grab"
          : hit(point.x, point.y)
            ? "move"
            : onPlayhead(point.x)
              ? point.y < RULER
                ? "default"
                : "col-resize"
              : point.y < RULER
                ? "text"
                : "default";
      requestDraw();
      return;
    }
    if (current.kind === "scrub") {
      if (leftTheWindow(event)) {
        drag.current = null;
        canvasRef.current!.releasePointerCapture(event.pointerId);
        return;
      }
      preview.seek(Math.round(xToFrame(point.x)));
      return;
    }
    const clip = state.current.clip!;
    if (current.kind === "marquee") {
      current.x = point.x;
      current.y = point.y;
      const [left, right] = [Math.min(current.x0, current.x), Math.max(current.x0, current.x)];
      const [upper, lower] = [Math.min(current.y0, current.y), Math.max(current.y0, current.y)];
      const next = new Set(current.base);
      const all = ranges();
      for (const param of state.current.params) {
        (clip.keyframes?.[param] ?? []).forEach((_, index) => {
          const inside = keyPoints(clip, param, index, all.get(param)!).some(({ x, y }) => x >= left && x <= right && y >= upper && y <= lower);
          if (inside) next.add(keyId({ param, index }));
        });
      }
      select(next);
      requestDraw();
      return;
    }
    if (!current.moved) {
      if (Math.abs(point.x - current.x) < 3 && Math.abs(point.y - current.y) < 3) return;
      current.moved = true;
      useEditor.getState().beginGesture();
      if (current.kind === "handle") canvasRef.current!.style.cursor = "grabbing";
    }

    if (current.kind === "handle") {
      const { ref, ranges: frozenRanges } = current;
      const range = frozenRanges.get(ref.param)!;
      const mode = state.current.mode;
      const pointer = xToFrame(point.x) - clip.start;
      const linked = !event.altKey;
      const snap = event.shiftKey;
      current.snapped = null;
      useEditor.getState().gesture((draft) => {
        const keys = draft.clips.find((candidate) => candidate.id === clip.id)?.keyframes?.[ref.param];
        const key = keys?.[ref.index];
        const neighbour = keys && neighbourOf(keys, ref.index, ref.side);
        if (!keys || !key || !neighbour) return;
        const span = Math.max(1e-6, Math.abs(neighbour.frame - key.frame));
        const reach = ref.side === "out" ? pointer - key.frame : key.frame - pointer;
        let influence = Math.min(1, Math.max(MIN_INFLUENCE, reach / span));
        if (snap) influence = snapInfluence(influence);
        const pointerValue = fromY(point.y, range);
        const along = ref.side === "out" ? 1 : -1;
        let speed = mode === "speed" ? pointerValue : (along * (pointerValue - key.value)) / (influence * span);
        if (snap) {
          // ⇧: pull the arm flat (ease) or straight at the next key (linear) when near either.
          const endY = (target: number) => toY(mode === "speed" ? target : key.value + along * target * influence * span, range);
          const linear = (neighbour.value - key.value) / (neighbour.frame - key.frame);
          const target = [0, linear].map((value) => ({ value, gap: Math.abs(endY(value) - point.y) })).sort((a, b) => a.gap - b.gap)[0];
          if (target.gap <= SNAP_PX) {
            speed = target.value;
            current.snapped = speed;
          }
        }
        const other: Side = ref.side === "out" ? "in" : "out";
        // Continuous by default, like After Effects: the other side keeps its reach but matches the speed. ⌥ breaks it.
        const otherHandle = linked ? handleOf(keys, ref.index, other) : undefined;
        if (ref.side === "out") key.handle_out = { speed, influence };
        else key.handle_in = { speed, influence };
        if (otherHandle) {
          if (other === "out") key.handle_out = { speed, influence: otherHandle.influence };
          else key.handle_in = { speed, influence: otherHandle.influence };
        }
      });
      return;
    }

    let dx = point.x - current.x;
    let dy = point.y - current.y;
    if (event.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    // The speed graph moves keys in time only.
    if (state.current.mode === "speed") dy = 0;
    const { top, bottom } = geometry();
    const dFrames = Math.round(dx / useView.getState().ppf);
    useEditor.getState().gesture((draft) => {
      const live = draft.clips.find((candidate) => candidate.id === clip.id);
      if (!live?.keyframes) return;
      for (const { ref, frame, value } of current.start) {
        const keys = live.keyframes[ref.param];
        const key = keys?.[ref.index];
        if (!key) continue;
        const range = current.ranges.get(ref.param)!;
        // Keys keep their order: stay between neighbours, inside the clip.
        const before = keys[ref.index - 1]?.frame ?? -Infinity;
        const after = keys[ref.index + 1]?.frame ?? Infinity;
        key.frame = Math.min(after - 1, Math.max(before + 1, Math.max(0, Math.min(live.duration, frame + dFrames))));
        key.value = value - (dy / (bottom - top)) * (range.hi - range.lo);
      }
    });
  };

  const onPointerUp = () => {
    const current = drag.current;
    drag.current = null;
    frozen.current = null;
    if ((current?.kind === "keys" || current?.kind === "handle") && current.moved) useEditor.getState().endGesture();
    requestDraw();
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const { clip, focused } = state.current;
    if (!clip || !focused) return;
    const { x, y } = local(event);
    if (y < RULER) return;
    const frame = Math.round(xToFrame(x));
    if (frame < clip.start || frame > clip.start + clip.duration) return;
    useEditor.getState().edit((draft) => {
      const live = draft.clips.find((candidate) => candidate.id === clip.id) as Clip | undefined;
      const keys = live?.keyframes?.[focused];
      if (!live || !keys) return;
      const localFrame = frame - live.start;
      if (keys.some((key) => Math.abs(key.frame - localFrame) < 0.5)) return;
      keys.push({ frame: localFrame, value: sample(keys, localFrame) ?? paramAt(live, focused, frame), ease: "in_out" });
      keys.sort((a, b) => a.frame - b.frame);
    });
  };

  const onContextMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const { clip } = state.current;
    const { x, y } = local(event);
    const ref = clip ? (hitHandle(x, y) ?? hit(x, y)) : null;
    if (!clip || !ref) return;
    event.preventDefault();
    const key = clip.keyframes![ref.param][ref.index];
    const id = keyId(ref);
    const targets = state.current.selected.has(id) ? [...state.current.selected] : [id];
    select(new Set(targets));
    const shaped = targets.some((target) => {
      const { param, index } = parseId(target);
      const keyframe = clip.keyframes?.[param]?.[index];
      return keyframe?.handle_in || keyframe?.handle_out;
    });
    openMenu(event, [
      { heading: "Ease out of this keyframe" },
      ...EASES.map(({ ease, label }) => ({
        label,
        checked: key.ease === ease && !key.handle_out,
        onSelect: () => setEase(clip, targets, ease),
      })),
      { separator: true },
      { label: "Easy ease both sides", shortcut: "F9", onSelect: () => easyEase(clip, targets) },
      { label: "Reset handles", disabled: !shaped, onSelect: () => resetHandles(clip, targets) },
      { separator: true },
      { label: targets.length > 1 ? "Delete keyframes" : "Delete keyframe", danger: true, shortcut: "⌫", onSelect: () => deleteKeys(clip, targets) },
    ]);
  };

  const onWheel = (event: React.WheelEvent) => {
    const { x } = local(event);
    const { ppf, scrollX } = useView.getState();
    if (event.ctrlKey || event.metaKey || event.altKey) {
      const frame = (x + scrollX) / ppf;
      const next = Math.min(MOST_PPF, ppf * Math.exp(-event.deltaY * 0.0035));
      setView({ ppf: next, scrollX: frame * next - x });
      return;
    }
    setView({ scrollX: scrollX + (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) });
  };

  return (
    <div ref={wrapRef} className="relative min-w-0 flex-1">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 size-full touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => {
          hover.current = null;
          requestDraw();
        }}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onWheel={onWheel}
      />
    </div>
  );
}

const sameHandle = (a: HandleRef, b: HandleRef) => a.param === b.param && a.index === b.index && a.side === b.side;

const formatSpeed = (param: string, perFrame: number, fps: number) => `${PARAM_INFO[param].format(perFrame * fps)}/s`;


/** Edits keyframes picked by id ("param:index") on the live clip. */
function editKeys(clip: Clip, ids: string[], recipe: (keys: Keyframe[], index: number) => void) {
  useEditor.getState().edit((draft) => {
    const live = draft.clips.find((candidate) => candidate.id === clip.id);
    for (const id of ids) {
      const { param, index } = parseId(id);
      const keys = live?.keyframes?.[param];
      if (keys?.[index]) recipe(keys, index);
    }
  });
}

/** A preset for the segment after each key; it replaces that segment’s handles. */
function setEase(clip: Clip, ids: string[], ease: Ease) {
  editKeys(clip, ids, (keys, index) => {
    keys[index].ease = ease;
    delete keys[index].handle_out;
    if (keys[index + 1]) delete keys[index + 1].handle_in;
  });
}

/** After Effects' F9: flat into and out of each key. */
function easyEase(clip: Clip, ids: string[]) {
  editKeys(clip, ids, (keys, index) => {
    const key = keys[index];
    if (key.ease === "hold") key.ease = "in_out";
    if (index > 0) key.handle_in = { ...EASY };
    if (index < keys.length - 1) key.handle_out = { ...EASY };
  });
}

function resetHandles(clip: Clip, ids: string[]) {
  editKeys(clip, ids, (keys, index) => {
    delete keys[index].handle_in;
    delete keys[index].handle_out;
  });
}

/** Deletes keyframes; a param left with none stops animating at its last value. */
function deleteKeys(clip: Clip, ids: string[]) {
  useEditor.getState().edit((draft) => {
    const live = draft.clips.find((candidate) => candidate.id === clip.id) as Clip | undefined;
    if (!live?.keyframes) return;
    const byParam = new Map<string, number[]>();
    for (const id of ids) {
      const { param, index } = parseId(id);
      byParam.set(param, [...(byParam.get(param) ?? []), index]);
    }
    for (const [param, indexes] of byParam) {
      const keys = live.keyframes[param];
      if (!keys) continue;
      const remaining = keys.filter((_, index) => !indexes.includes(index));
      if (remaining.length) live.keyframes[param] = remaining;
      else {
        // Stop animating, keeping the last keyed value so nothing jumps.
        const last = keys[keys.length - 1].value;
        delete live.keyframes[param];
        setParam(live, param, last, live.start);
      }
    }
  });
}
