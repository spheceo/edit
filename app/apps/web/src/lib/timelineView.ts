// The timeline's shared view: zoom and scroll for the lanes and the graph
// editor, the time ruler, and the limits every view change respects.

import { create } from "zustand";

import { projectDuration } from "./edit";
import { inOutSpan, pointsOf } from "./inOut";
import { playhead, preview } from "./playback";
import { useEditor } from "./store";
import type { Project, Section, Sections, TimelineMarker } from "./types";
import { rate } from "./types";

/** Height of the band of sections (intro, B-roll, story, outro) atop the ruler, in px. */
const BAND = 18;
/** Height of the time ruler (the sections band and the time scale), in px. */
export const RULER = BAND + 28;

/** Each kind of section's colour. */
const SECTION_COLORS: Record<Section["kind"], string> = {
  intro: "56, 189, 248",
  broll: "251, 191, 36",
  story: "163, 163, 163",
  outro: "244, 114, 182",
  // A subtitled video's segments: footage gets subtitles, the rest doesn't.
  footage: "52, 211, 153",
  captioned: "167, 139, 250",
  narration: "251, 146, 60",
  other: "115, 115, 115",
};

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
export const MOST_PPF = 80;
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
  const fps = (project ? rate(project.settings) : 30);
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
  const fps = (project ? rate(project.settings) : 30);
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

/** Scrolls the lanes so `frame` is in view (at `at` of their width), unless it already is. */
function reveal(frame: number, at: number) {
  const { ppf, scrollX } = useView.getState();
  const x = frame * ppf - scrollX;
  if (x >= 0 && x <= lanesWidth) return;
  setView({ scrollX: frame * ppf - lanesWidth * at });
}

/** Go to start: the playhead to frame 0, and the lanes with it. */
export function goToStart() {
  preview.seek(0);
  reveal(0, 0);
}

/** Go to end: the playhead just after the last clip, and the lanes with it (the end most of the way across). */
export function goToEnd() {
  preview.seekEnd();
  reveal(playhead.frame, 0.85);
}

/** In and out points as the ruler draws them: the span `[start, end)` and which ends were marked. */
export interface Marks {
  span: [number, number] | null;
  in: number | null;
  out: number | null;
}

/** The project's in/out points for drawing. */
export function marksOf(project: Project): Marks {
  const points = pointsOf(project);
  return { span: inOutSpan(projectDuration(project), points), in: points.in, out: points.out };
}

export function drawRuler(
  ctx: CanvasRenderingContext2D,
  width: number,
  fps: number,
  ppf: number,
  scrollX: number,
  sections?: Sections | null,
  marks?: Marks,
  markers?: TimelineMarker[],
) {
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, width, RULER);
  ctx.fillStyle = "rgba(255,255,255,0.07)";
  ctx.fillRect(0, RULER - 1, width, 1);
  drawSections(ctx, width, ppf, scrollX, sections?.parts ?? []);
  if (marks?.span) drawSpan(ctx, ppf, scrollX, marks);
  drawTimelineMarkers(ctx, width, ppf, scrollX, markers ?? []);
  const pxPerSecond = ppf * fps;
  const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
  const major = steps.find((step) => step * pxPerSecond >= 90) ?? 3600;
  const minor = major / (major * pxPerSecond >= 180 ? 10 : 5);
  const first = Math.floor(scrollX / pxPerSecond / minor) * minor;
  ctx.font = "10px ui-monospace, 'SF Mono', Menlo, monospace";
  ctx.textBaseline = "top";
  for (let t = first; t * pxPerSecond - scrollX < width; t += minor) {
    const x = Math.round(t * pxPerSecond - scrollX) + 0.5;
    if (x < -1) continue;
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    ctx.fillStyle = isMajor ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.1)";
    ctx.fillRect(x, isMajor ? RULER - 12 : RULER - 6, 1, isMajor ? 11 : 5);
    if (isMajor) {
      ctx.fillStyle = "#8f8f8f";
      ctx.fillText(rulerLabel(t, fps, major), x + 4, BAND + 5);
    }
  }
}

/** Moments marked on the timeline (an agent planning its sounds): a small amber flag at the ruler's foot. */
function drawTimelineMarkers(ctx: CanvasRenderingContext2D, width: number, ppf: number, scrollX: number, markers: TimelineMarker[]) {
  ctx.fillStyle = "#fbbf24";
  for (const marker of markers) {
    const x = Math.round(marker.frame * ppf - scrollX) + 0.5;
    if (x < -6 || x > width + 6) continue;
    ctx.beginPath();
    ctx.moveTo(x - 4, RULER - 9);
    ctx.lineTo(x + 4, RULER - 9);
    ctx.lineTo(x, RULER - 3);
    ctx.closePath();
    ctx.fill();
  }
}

/** The intro (and its splits), B-roll spots, story and outro, as coloured spans with their names. */
function drawSections(ctx: CanvasRenderingContext2D, width: number, ppf: number, scrollX: number, parts: Section[]) {
  ctx.font = "500 10px Inter, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  for (const part of parts) {
    const x0 = part.start * ppf - scrollX;
    const x1 = part.end * ppf - scrollX;
    if (x1 < 0 || x0 > width) continue;
    const color = SECTION_COLORS[part.kind];
    const quiet = part.kind === "story" || part.kind === "other";
    const left = Math.round(x0) + 1;
    const w = Math.round(x1) - left - 1;
    if (w < 1) continue;
    ctx.fillStyle = `rgba(${color}, ${quiet ? 0.1 : 0.2})`;
    ctx.fillRect(left, 3, w, BAND - 4);
    ctx.fillStyle = `rgba(${color}, ${quiet ? 0.45 : 0.9})`;
    ctx.fillRect(left, 3, Math.min(2, w), BAND - 4);
    // The name stays in view while its span is scrolled partly off the left.
    const textX = Math.max(left, 0) + 7;
    const room = left + w - textX - 4;
    if (room < 18) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(textX, 0, room, BAND);
    ctx.clip();
    ctx.fillStyle = `rgba(${color}, ${quiet ? 0.7 : 1})`;
    ctx.fillText(part.label, textX, 3 + (BAND - 4) / 2);
    ctx.restore();
  }
  ctx.textBaseline = "top";
}

/** The in-to-out span in the time scale, with a bracket at each marked point. */
function drawSpan(ctx: CanvasRenderingContext2D, ppf: number, scrollX: number, marks: Marks) {
  const [start, end] = marks.span!;
  const x0 = Math.round(start * ppf - scrollX);
  const x1 = Math.round(end * ppf - scrollX);
  const top = BAND + 1;
  const bottom = RULER - 1;
  ctx.fillStyle = "rgba(255,255,255,0.1)";
  ctx.fillRect(x0, top, x1 - x0, bottom - top);
  ctx.fillStyle = "#f5f5f5";
  const bracket = (x: number, toward: 1 | -1) => {
    const stem = toward === 1 ? x : x - 2;
    ctx.fillRect(stem, top, 2, bottom - top);
    ctx.fillRect(toward === 1 ? x : x - 6, top, 6, 2);
    ctx.fillRect(toward === 1 ? x : x - 6, bottom - 2, 6, 2);
  };
  if (marks.in !== null) bracket(x0, 1);
  if (marks.out !== null) bracket(x1, -1);
}

/** Dims the lanes outside the in-to-out span, so what's in it stands out. */
export function dimOutsideSpan(ctx: CanvasRenderingContext2D, width: number, height: number, ppf: number, scrollX: number, marks: Marks) {
  if (!marks.span) return;
  const x0 = Math.round(marks.span[0] * ppf - scrollX);
  const x1 = Math.round(marks.span[1] * ppf - scrollX);
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  if (x0 > 0) ctx.fillRect(0, RULER, Math.min(x0, width), height - RULER);
  if (x1 < width) ctx.fillRect(Math.max(0, x1), RULER, width - Math.max(0, x1), height - RULER);
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  if (marks.in !== null && x0 >= 0 && x0 <= width) ctx.fillRect(x0, RULER, 1, height - RULER);
  if (marks.out !== null && x1 >= 0 && x1 <= width) ctx.fillRect(x1 - 1, RULER, 1, height - RULER);
}

/** The playhead: its line down the lanes and its head in the time scale (below the sections band). */
export function drawPlayhead(ctx: CanvasRenderingContext2D, px: number, height: number) {
  const top = BAND + 6;
  ctx.strokeStyle = "#ff3d6e";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(px, RULER - 4);
  ctx.lineTo(px, height);
  ctx.stroke();
  ctx.fillStyle = "#ff3d6e";
  ctx.beginPath();
  ctx.moveTo(px - 6, top);
  ctx.lineTo(px + 6, top);
  ctx.quadraticCurveTo(px + 7, top, px + 7, top + 2);
  ctx.lineTo(px + 7, top + 9);
  ctx.lineTo(px, RULER - 4);
  ctx.lineTo(px - 7, top + 9);
  ctx.lineTo(px - 7, top + 2);
  ctx.quadraticCurveTo(px - 7, top, px - 6, top);
  ctx.fill();
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
