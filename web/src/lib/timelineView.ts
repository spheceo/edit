// The timeline's shared view: zoom and scroll for the lanes and the graph
// editor, the time ruler, and the limits every view change respects.

import { create } from "zustand";

import { projectDuration } from "./edit";
import { playhead } from "./playback";
import { useEditor } from "./store";

/** Height of the time ruler, in px. */
export const RULER = 28;

interface View {
  ppf: number; // pixels per frame
  scrollX: number;
  scrollY: number;
  fitted: boolean;
  /** Graph editor instead of lanes (keyframe curves of the selected clip). */
  graph: boolean;
  /** Width of whichever lanes are showing (timeline or graph), for the zoom bar. */
  lanes: number;
}

export const useView = create<View>(() => ({ ppf: 4, scrollX: 0, scrollY: 0, fitted: false, graph: false, lanes: 1 }));

/** Most zoomed in: pixels per frame. */
export const MOST_PPF = 40;
/** Width of the lanes, kept current by the Timeline. */
let lanesWidth = 1;
export const getLanesWidth = () => lanesWidth;
export const setLanesWidth = (width: number) => {
  lanesWidth = width;
  if (useView.getState().lanes !== width) useView.setState({ lanes: width });
};

/** Frames the view can cover: the edit (or the playhead, if past it) plus room, and at least a minute. */
export function contentFrames() {
  const project = useEditor.getState().project;
  const fps = project?.settings.fps ?? 30;
  const end = project ? projectDuration(project) : 0;
  return Math.max(end * 1.05, playhead.frame + fps, fps * 60);
}

/**
 * Where a project opens: zoomed in on its start (a small zoom-bar thumb),
 * showing the edit if it's short, else about 30 seconds. Drag the thumb
 * bigger to zoom out.
 */
export function initialPpf() {
  const project = useEditor.getState().project;
  const fps = project?.settings.fps ?? 30;
  const end = project ? projectDuration(project) : 0;
  const seconds = Math.min(30, Math.max(10, (end / fps) * 1.2));
  return lanesWidth / (seconds * fps);
}

/**
 * Every zoom and scroll goes through here (as in Repack's lanes): never
 * further out than the whole edit, never scrolled past it. So the zoom bar's
 * thumb is the whole bar exactly when everything is in view.
 */
export function setView(next: { ppf?: number; scrollX?: number }) {
  const current = useView.getState();
  const content = contentFrames();
  const fit = lanesWidth / content;
  const ppf = Math.min(MOST_PPF, Math.max(fit, next.ppf ?? current.ppf));
  const scrollX = Math.min(Math.max(0, content * ppf - lanesWidth), Math.max(0, next.scrollX ?? current.scrollX));
  if (ppf !== current.ppf || scrollX !== current.scrollX) useView.setState({ ppf, scrollX });
}

export function drawRuler(ctx: CanvasRenderingContext2D, width: number, fps: number, ppf: number, scrollX: number) {
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, width, RULER);
  ctx.fillStyle = "rgba(255,255,255,0.07)";
  ctx.fillRect(0, RULER - 1, width, 1);
  const pxPerSecond = ppf * fps;
  const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
  const major = steps.find((step) => step * pxPerSecond >= 90) ?? 3600;
  const minor = major / (major * pxPerSecond >= 180 ? 10 : 5);
  const first = Math.floor(scrollX / pxPerSecond / minor) * minor;
  ctx.font = "10px 'Geist Mono Variable', ui-monospace, monospace";
  ctx.textBaseline = "top";
  for (let t = first; t * pxPerSecond - scrollX < width; t += minor) {
    const x = Math.round(t * pxPerSecond - scrollX) + 0.5;
    if (x < -1) continue;
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    ctx.fillStyle = isMajor ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.1)";
    ctx.fillRect(x, isMajor ? RULER - 12 : RULER - 6, 1, isMajor ? 11 : 5);
    if (isMajor) {
      ctx.fillStyle = "#8f8f8f";
      ctx.fillText(rulerLabel(t, fps, major), x + 4, 5);
    }
  }
}

function rulerLabel(seconds: number, fps: number, step: number) {
  const whole = Math.floor(seconds + 1e-6);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  const base = `${m}:${String(s).padStart(2, "0")}`;
  if (step >= 1) return base;
  const frames = Math.round((seconds - whole) * fps);
  return `${base}:${String(frames).padStart(2, "0")}`;
}

/** A drag-to-select box (timeline and graph editor). */
export function drawMarquee(ctx: CanvasRenderingContext2D, drag: { x0: number; y0: number; x: number; y: number } | null) {
  if (!drag) return;
  const x = Math.min(drag.x0, drag.x);
  const y = Math.min(drag.y0, drag.y);
  const w = Math.abs(drag.x - drag.x0);
  const h = Math.abs(drag.y - drag.y0);
  if (w < 2 && h < 2) return;
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.45)";
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
}

/** The pointer left the window mid-drag (or the button came up unseen): let go of the playhead. */
export const leftTheWindow = (event: { clientX: number; clientY: number; buttons: number }) =>
  event.buttons === 0 || event.clientX < 0 || event.clientY < 0 || event.clientX > window.innerWidth || event.clientY > window.innerHeight;
