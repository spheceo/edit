import { Eye, EyeOff, Lock, LockOpen, Magnet, MousePointer2, Plus, Scissors, Spline, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { mediaUrl } from "../lib/api";
import { CLIP_HEX } from "../lib/colors";
import {
  addElement,
  addTrack,
  clearRange,
  clipEnd,
  maxDuration,
  mediaOf,
  peekFreeTrack,
  placeMedia,
  splitAt,
  trackLabel,
  trimStart,
  withLinked,
  ELEMENT_SECONDS,
  type Element,
} from "../lib/edit";
import { playhead, preview } from "../lib/playback";
import { useEditor } from "../lib/store";
import { contentFrames, drawMarquee, drawRuler, getLanesWidth, leftTheWindow, initialPpf, MOST_PPF, RULER, setLanesWidth, setView, useView } from "../lib/timelineView";
import { uploadFiles } from "../lib/upload";
import type { Clip, Project, Track } from "../lib/types";
import { clipMenu, timelineMenu, trackMenu } from "../lib/menus";
import { openMenu } from "./ContextMenu";
import { GRAPH_HEADER, GraphEditor } from "./GraphEditor";
import { clipTitle } from "./Inspector";
import { ELEMENT_MIME, MEDIA_MIME } from "./MediaPanel";
import { cx, IconButton } from "./ui";

const HEADER = 84;
const VIDEO_ROW = 48;
const AUDIO_ROW = 40;
const ROW_GAP = 3;
const DIVIDER = 10;
const EDGE = 7;
const SNAP_PX = 8;

interface Row {
  track: Track;
  y: number;
  h: number;
}

function layoutRows(project: Project): { rows: Row[]; height: number } {
  const video = project.tracks.filter((track) => track.kind === "video").reverse();
  const audio = project.tracks.filter((track) => track.kind === "audio");
  const rows: Row[] = [];
  let y = RULER + 6;
  for (const track of video) {
    rows.push({ track, y, h: VIDEO_ROW });
    y += VIDEO_ROW + ROW_GAP;
  }
  y += DIVIDER;
  for (const track of audio) {
    rows.push({ track, y, h: AUDIO_ROW });
    y += AUDIO_ROW + ROW_GAP;
  }
  return { rows, height: y + 8 };
}

// --- asset caches (sprites and waveforms), shared across renders -----------

const sprites = new Map<string, HTMLImageElement | "loading" | "missing">();
const peaks = new Map<string, Uint8Array | "loading" | "missing">();

function sprite(project: Project, media: string, ready: boolean, onLoad: () => void) {
  const key = `${project.id}/${media}`;
  const cached = sprites.get(key);
  if (cached instanceof HTMLImageElement) return cached;
  if (cached === "loading" || !ready) return null;
  sprites.set(key, "loading");
  const image = new Image();
  image.onload = () => {
    sprites.set(key, image);
    onLoad();
  };
  image.onerror = () => sprites.set(key, "missing");
  image.src = mediaUrl(project.id, media, "thumbs");
  return null;
}

function waveform(project: Project, media: string, ready: boolean, onLoad: () => void) {
  const key = `${project.id}/${media}`;
  const cached = peaks.get(key);
  if (cached instanceof Uint8Array) return cached;
  if (cached === "loading" || !ready) return null;
  peaks.set(key, "loading");
  fetch(mediaUrl(project.id, media, "peaks"))
    .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject()))
    .then((buffer) => {
      peaks.set(key, new Uint8Array(buffer));
      onLoad();
    })
    .catch(() => peaks.set(key, "missing"));
  return null;
}

// --- component -------------------------------------------------------------

type Drag =
  | { kind: "scrub" }
  | { kind: "move"; x: number; y: number; anchor: Clip; ids: Set<string>; moved: boolean }
  | { kind: "trim"; x: number; clip: Clip; edge: "start" | "end"; ids: Set<string> }
  | { kind: "pending"; clip: Clip; additive: boolean }
  | { kind: "marquee"; x0: number; y0: number; x: number; y: number; base: string[] };

export function Timeline() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const project = useEditor((state) => state.project)!;
  const tool = useEditor((state) => state.tool);
  const snapping = useEditor((state) => state.snapping);
  const setTool = useEditor((state) => state.setTool);
  const toggle = useEditor((state) => state.toggle);
  const edit = useEditor((state) => state.edit);
  const view = useView();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const hover = useRef<{ x: number; y: number } | null>(null);
  /** What a drag from the bin or desktop would place, mirrored from placeMedia/addElement. */
  const drop = useRef<{ frame: number; track?: string; duration: number; kind: "video" | "audio" | "element"; withAudio: boolean } | null>(null);
  const snapLine = useRef<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const queued = useRef(0);

  const { rows, height: contentHeight } = layoutRows(project);
  const fps = project.settings.fps;

  const requestDraw = () => {
    if (queued.current) return;
    queued.current = requestAnimationFrame(() => {
      queued.current = 0;
      draw();
    });
  };

  // Size the canvas to its box.
  useEffect(() => {
    const wrap = wrapRef.current!;
    const observer = new ResizeObserver(() => setSize({ w: wrap.clientWidth, h: wrap.clientHeight }));
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  // Fit the whole edit on first show; afterwards keep the view inside the edit
  // as the lanes resize or the edit grows and shrinks.
  useEffect(() => {
    if (!size.w) return;
    // While the graph editor is open it owns the lane width.
    if (!useView.getState().graph) setLanesWidth(size.w);
    if (!useView.getState().fitted) {
      useView.setState({ fitted: true });
      setView({ ppf: initialPpf(), scrollX: 0 });
    } else setView({});
  }, [size.w, project]);

  useEffect(() => () => useView.setState({ fitted: false, scrollX: 0, scrollY: 0 }), [project.id]);

  // Redraw on anything that changes pixels.
  useEffect(() => {
    const offPlayhead = playhead.subscribe(() => {
      followPlayhead();
      requestDraw();
    });
    const offEditor = useEditor.subscribe(requestDraw);
    const offView = useView.subscribe(requestDraw);
    return () => {
      offPlayhead();
      offEditor();
      offView();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(requestDraw);

  // Keyboard zoom.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || document.querySelector("[role=dialog]")) return;
      if (event.key === "=" || event.key === "+") zoomAround(playheadX(), 1.25);
      else if (event.key === "-") zoomAround(playheadX(), 0.8);
      else if (event.key === "\\") fit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w]);

  const frameToX = (frame: number) => frame * useView.getState().ppf - useView.getState().scrollX;
  const xToFrame = (x: number) => (x + useView.getState().scrollX) / useView.getState().ppf;
  const playheadX = () => frameToX(playhead.frame);
  /** Within grabbing distance of the playhead's line (or its head in the ruler). */
  const onPlayhead = (x: number) => Math.abs(x - playheadX()) <= 5;

  function zoomAround(x: number, factor: number) {
    const { ppf, scrollX } = useView.getState();
    const frame = (x + scrollX) / ppf;
    const next = Math.min(MOST_PPF, ppf * factor);
    setView({ ppf: next, scrollX: frame * Math.max(next, getLanesWidth() / contentFrames()) - x });
  }

  /** The whole edit in view. */
  function fit() {
    setView({ ppf: 0, scrollX: 0 });
  }

  function followPlayhead() {
    if (!playhead.playing || drag.current) return;
    const x = playheadX();
    const width = canvasRef.current?.clientWidth ?? 0;
    if (x > width - 40 || x < 0) {
      setView({ scrollX: playhead.frame * useView.getState().ppf - 40 });
    }
  }

  function rowAt(y: number) {
    const sy = y + useView.getState().scrollY;
    return rows.find((row) => sy >= row.y && sy < row.y + row.h);
  }

  function clipAt(x: number, y: number): { clip: Clip; edge: "start" | "end" | null } | null {
    const row = rowAt(y);
    if (!row) return null;
    const project = useEditor.getState().project!;
    const frame = xToFrame(x);
    const ppf = useView.getState().ppf;
    for (const clip of project.clips) {
      if (clip.track !== row.track.id) continue;
      const x0 = frameToX(clip.start);
      const x1 = frameToX(clipEnd(clip));
      if (x < x0 - 1 || x > x1 + 1) continue;
      if (frame < clip.start - 1 / ppf || frame > clipEnd(clip) + 1 / ppf) continue;
      const wide = x1 - x0 > EDGE * 3;
      if (wide && x - x0 < EDGE) return { clip, edge: "start" };
      if (wide && x1 - x < EDGE) return { clip, edge: "end" };
      return { clip, edge: null };
    }
    return null;
  }

  function snapTargets(exclude: Set<string>) {
    const project = useEditor.getState().project!;
    const targets = [0, Math.round(playhead.frame)];
    for (const clip of project.clips) {
      if (exclude.has(clip.id)) continue;
      targets.push(clip.start, clipEnd(clip));
    }
    return targets;
  }

  /** Snaps any of `edges` (frames) to a target; returns the frame delta to apply. */
  function snap(edges: number[], exclude: Set<string>) {
    snapLine.current = null;
    if (!useEditor.getState().snapping) return 0;
    const threshold = SNAP_PX / useView.getState().ppf;
    let best: { delta: number; at: number } | null = null;
    for (const target of snapTargets(exclude)) {
      for (const edge of edges) {
        const delta = target - edge;
        if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, at: target };
      }
    }
    if (best) snapLine.current = best.at;
    return best?.delta ?? 0;
  }

  // --- pointer handling ----------------------------------------------------

  const local = (event: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const { x, y } = local(event);
    canvasRef.current!.setPointerCapture(event.pointerId);
    const state = useEditor.getState();
    // The ruler, or the playhead's line anywhere: grab it and scrub.
    if (y < RULER || (onPlayhead(x) && !clipAt(x, y)?.edge)) {
      drag.current = { kind: "scrub" };
      preview.seek(Math.round(xToFrame(x)));
      return;
    }
    const hit = clipAt(x, y);
    if (!hit) {
      // Empty space: drag out a box to select clips (⇧/⌘ adds to the selection).
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      if (!additive) state.select([]);
      drag.current = { kind: "marquee", x0: x, y0: y, x, y, base: additive ? state.selection : [] };
      return;
    }
    const track = state.project!.tracks.find((candidate) => candidate.id === hit.clip.track);
    if (track?.locked) return;
    if (state.tool === "razor") {
      const frame = Math.round(xToFrame(x));
      const target = snapping ? frame + snap([frame], new Set()) : frame;
      state.edit((draft) => splitAt(draft, target, [hit.clip.id]));
      snapLine.current = null;
      return;
    }
    const linked = withLinked(state.project!, [hit.clip.id]);
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    if (additive) {
      drag.current = { kind: "pending", clip: hit.clip, additive: true };
      return;
    }
    if (!state.selection.includes(hit.clip.id)) state.select([...linked]);
    if (hit.edge) {
      state.beginGesture();
      drag.current = { kind: "trim", x, clip: hit.clip, edge: hit.edge, ids: linked };
      return;
    }
    const ids = withLinked(state.project!, useEditor.getState().selection.includes(hit.clip.id) ? useEditor.getState().selection : [...linked]);
    drag.current = { kind: "move", x, y, anchor: hit.clip, ids, moved: false };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = local(event);
    hover.current = { x, y };
    const current = drag.current;
    const canvas = canvasRef.current!;
    if (!current) {
      const hit = y >= RULER ? clipAt(x, y) : null;
      // Playhead: plain arrow on its head, Premiere-style ⟷ on its line.
      canvas.style.cursor = onPlayhead(x) && !hit?.edge
        ? y < RULER
          ? "default"
          : "col-resize"
        : y < RULER
          ? "text"
          : useEditor.getState().tool === "razor" && hit
            ? "crosshair"
            : hit?.edge
              ? "ew-resize"
              : hit
                ? "grab"
                : "default";
      if (useEditor.getState().tool === "razor") requestDraw();
      return;
    }
    const state = useEditor.getState();
    const ppf = useView.getState().ppf;
    if (current.kind === "scrub") {
      if (leftTheWindow(event)) {
        drag.current = null;
        canvas.releasePointerCapture(event.pointerId);
        return;
      }
      preview.seek(Math.round(xToFrame(x)));
    } else if (current.kind === "marquee") {
      current.x = x;
      current.y = y;
      const project = state.project!;
      const { scrollY } = useView.getState();
      const [from, to] = [xToFrame(Math.min(current.x0, x)), xToFrame(Math.max(current.x0, x))];
      const [top, bottom] = [Math.min(current.y0, y) + scrollY, Math.max(current.y0, y) + scrollY];
      const { rows } = layoutRows(project);
      const hits = project.clips.filter((clip) => {
        const row = rows.find((candidate) => candidate.track.id === clip.track);
        return row && !row.track.locked && row.y + row.h > top && row.y < bottom && clipEnd(clip) > from && clip.start < to;
      });
      state.select([...withLinked(project, [...current.base, ...hits.map((clip) => clip.id)])]);
      requestDraw();
    } else if (current.kind === "move") {
      if (!current.moved) {
        if (Math.abs(x - current.x) < 3 && Math.abs(y - current.y) < 3) return;
        current.moved = true;
        state.beginGesture();
        canvas.style.cursor = "grabbing";
      }
      const base = state.gestureBase!;
      const moving = base.clips.filter((clip) => current.ids.has(clip.id));
      let delta = Math.round((x - current.x) / ppf);
      const minStart = Math.min(...moving.map((clip) => clip.start));
      delta = Math.max(delta, -minStart);
      const anchor = base.clips.find((clip) => clip.id === current.anchor.id) ?? current.anchor;
      delta += snap([anchor.start + delta, clipEnd(anchor) + delta], current.ids);
      delta = Math.max(delta, -minStart);
      // Vertical: shift tracks of the anchor's kind by the rows moved.
      const anchorTrack = base.tracks.find((track) => track.id === anchor.track)!;
      const sameKind = base.tracks.filter((track) => track.kind === anchorTrack.kind);
      const row = rowAt(y);
      let shift = 0;
      if (row && row.track.kind === anchorTrack.kind) {
        shift = sameKind.indexOf(row.track) - sameKind.indexOf(anchorTrack);
        for (const clip of moving) {
          const kindTracks = base.tracks.filter((track) => track.kind === anchorTrack.kind);
          const index = kindTracks.findIndex((track) => track.id === clip.track);
          if (index >= 0 && (index + shift < 0 || index + shift >= kindTracks.length || kindTracks[index + shift].locked)) shift = 0;
        }
      }
      state.gesture((draft) => {
        const kindTracks = draft.tracks.filter((track) => track.kind === anchorTrack.kind);
        for (const clip of draft.clips) {
          if (!current.ids.has(clip.id)) continue;
          clip.start += delta;
          const index = kindTracks.findIndex((track) => track.id === clip.track);
          if (index >= 0 && shift) clip.track = kindTracks[index + shift].id;
        }
        for (const clip of draft.clips.filter((candidate) => current.ids.has(candidate.id))) {
          clearRange(draft, clip.track, clip.start, clipEnd(clip), current.ids);
        }
      });
    } else if (current.kind === "trim") {
      const base = state.gestureBase!;
      const clip = base.clips.find((candidate) => candidate.id === current.clip.id)!;
      let delta = Math.round((x - current.x) / ppf);
      const edgeFrame = current.edge === "start" ? clip.start : clipEnd(clip);
      delta += snap([edgeFrame + delta], current.ids);
      // Don't trim into neighbours on the same tracks.
      for (const id of current.ids) {
        const own = base.clips.find((candidate) => candidate.id === id);
        if (!own) continue;
        const neighbours = base.clips.filter((other) => other.track === own.track && !current.ids.has(other.id));
        if (current.edge === "start") {
          const limit = Math.max(0, ...neighbours.filter((other) => clipEnd(other) <= own.start).map(clipEnd));
          delta = Math.max(delta, limit - own.start);
          delta = Math.min(delta, own.duration - 1);
        } else {
          const limit = Math.min(Number.POSITIVE_INFINITY, ...neighbours.filter((other) => other.start >= clipEnd(own)).map((other) => other.start));
          delta = Math.min(delta, limit - clipEnd(own), maxDuration(base, own) - own.duration);
          delta = Math.max(delta, 1 - own.duration);
        }
      }
      state.gesture((draft) => {
        for (const live of draft.clips) {
          if (!current.ids.has(live.id)) continue;
          if (current.edge === "start") trimStart(draft, live as Clip, delta);
          else live.duration = Math.max(1, live.duration + delta);
        }
      });
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const current = drag.current;
    drag.current = null;
    snapLine.current = null;
    const state = useEditor.getState();
    if (current?.kind === "pending") {
      state.select([...withLinked(state.project!, [current.clip.id])], "toggle");
    } else if (current?.kind === "move" && !current.moved) {
      state.select([...withLinked(state.project!, [current.anchor.id])]);
    } else if (current?.kind === "move" || current?.kind === "trim") {
      state.endGesture();
    }
    canvasRef.current!.style.cursor = "default";
    onPointerMove(event);
    requestDraw();
  };

  const onWheel = (event: React.WheelEvent) => {
    const { x } = local(event);
    if (event.ctrlKey || event.metaKey || event.altKey) {
      zoomAround(x, Math.exp(-event.deltaY * 0.0035));
      return;
    }
    const { scrollX, scrollY } = useView.getState();
    const overflow = contentHeight - size.h;
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey || overflow <= 0;
    if (horizontal) {
      const amount = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      setView({ scrollX: scrollX + amount });
    } else {
      useView.setState({ scrollY: Math.min(Math.max(0, overflow), Math.max(0, scrollY + event.deltaY)) });
    }
  };

  // --- drag and drop from the media panel ----------------------------------

  const dropInfo = (event: React.DragEvent) => {
    const { x, y } = local(event);
    const project = useEditor.getState().project!;
    const row = rowAt(y);
    const isElement = event.dataTransfer.types.includes(ELEMENT_MIME);
    let duration = fps * 4;
    let kind: "video" | "audio" | "element" = isElement ? "element" : "video";
    // Files from the desktop are unknown until uploaded; most footage has sound.
    let withAudio = !isElement;
    const dragging = window as unknown as { __editDragMedia?: string; __editDragElement?: Element };
    const mediaId = dragging.__editDragMedia;
    if (isElement && dragging.__editDragElement) duration = Math.round(ELEMENT_SECONDS[dragging.__editDragElement] * fps);
    if (!isElement && mediaId) {
      const media = mediaOf(project, mediaId);
      if (media) {
        duration = Math.floor(media.duration * fps);
        kind = media.kind === "audio" ? "audio" : "video";
        withAudio = media.has_audio;
      }
    }
    let frame = Math.max(0, Math.round(xToFrame(x)));
    frame += snap([frame, frame + duration], new Set());
    return { frame: Math.max(0, frame), track: row?.track.kind === "video" ? row.track.id : undefined, duration, kind, withAudio };
  };

  const onDragOver = (event: React.DragEvent) => {
    const types = event.dataTransfer.types;
    if (!types.includes(MEDIA_MIME) && !types.includes(ELEMENT_MIME) && !types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    drop.current = dropInfo(event);
    requestDraw();
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const info = dropInfo(event);
    drop.current = null;
    snapLine.current = null;
    if (event.dataTransfer.files.length) {
      // Files from the user's own device: upload, then place where dropped.
      event.stopPropagation();
      uploadFiles([...event.dataTransfer.files], { frame: info.frame, track: info.track });
      requestDraw();
      return;
    }
    const mediaId = event.dataTransfer.getData(MEDIA_MIME);
    const element = event.dataTransfer.getData(ELEMENT_MIME) as Element;
    let ids: string[] = [];
    edit((draft) => {
      if (mediaId) ids = placeMedia(draft, mediaId, info.frame, info.track);
      else if (element) ids = [addElement(draft, element, info.frame, info.track)];
    });
    useEditor.getState().select(ids);
    requestDraw();
  };

  // Remember which media is being dragged (dataTransfer is unreadable during dragover).
  useEffect(() => {
    const onStart = (event: DragEvent) => {
      const target = event.target as HTMLElement;
      const id = target?.closest?.("[draggable]") ? event.dataTransfer?.getData(MEDIA_MIME) : undefined;
      (window as unknown as { __editDragMedia?: string }).__editDragMedia = id || undefined;
    };
    const onEnd = () => {
      drop.current = null;
      snapLine.current = null;
      requestDraw();
    };
    window.addEventListener("dragstart", onStart);
    window.addEventListener("dragend", onEnd);
    return () => {
      window.removeEventListener("dragstart", onStart);
      window.removeEventListener("dragend", onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- drawing -------------------------------------------------------------

  function draw() {
    const canvas = canvasRef.current;
    const state = useEditor.getState();
    const project = state.project;
    if (!canvas || !project) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const { ppf, scrollY } = useView.getState();
    const { rows } = layoutRows(project);
    const selected = new Set(state.selection);
    const fps = project.settings.fps;
    const statuses = state.media;

    // Rows.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER, width, height - RULER);
    ctx.clip();
    for (const row of rows) {
      const y = row.y - scrollY;
      if (y > height || y + row.h < RULER) continue;
      ctx.fillStyle = "rgba(255,255,255,0.025)";
      ctx.fillRect(0, y, width, row.h);
    }

    // Clips.
    ctx.font = "500 11px 'Geist Variable', system-ui, sans-serif";
    ctx.textBaseline = "middle";
    for (const clip of project.clips) {
      const row = rows.find((candidate) => candidate.track.id === clip.track);
      if (!row) continue;
      const x0 = frameToX(clip.start);
      const x1 = frameToX(clipEnd(clip));
      if (x1 < 0 || x0 > width) continue;
      const y = row.y - scrollY + 1;
      const h = row.h - 2;
      if (y > height || y + h < RULER) continue;
      drawClip(ctx, project, clip, x0, x1, y, h, selected.has(clip.id), row.track, statuses, width, requestDraw);
    }

    // Drop ghost: picture where it will land and, for footage with sound, its audio too.
    const ghost = drop.current;
    if (ghost) {
      const unlocked = (kind: "video" | "audio") => project.tracks.find((track) => track.kind === kind && !track.locked)?.id;
      const targets: (string | undefined)[] = [];
      if (ghost.kind === "audio") targets.push(unlocked("audio"));
      else {
        targets.push(ghost.track ?? (ghost.kind === "video" ? unlocked("video") : undefined));
        if (ghost.kind === "video" && ghost.withAudio) targets.push(unlocked("audio"));
      }
      // Elements without a hovered video row go to the first free track above the footage.
      if (ghost.kind === "element" && !ghost.track) targets[0] = peekFreeTrack(project, "video", ghost.frame, ghost.frame + ghost.duration, true);
      const x0 = frameToX(ghost.frame);
      const w = ghost.duration * ppf;
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.setLineDash([4, 3]);
      for (const id of targets) {
        const row = id && rows.find((candidate) => candidate.track.id === id);
        if (!row) continue;
        roundRect(ctx, x0, row.y - scrollY + 1, w, row.h - 2, 6);
        ctx.fill();
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    ctx.restore();

    // Razor guide.
    if (state.tool === "razor" && hover.current && hover.current.y > RULER && !drag.current) {
      const hit = clipAt(hover.current.x, hover.current.y);
      if (hit) {
        const row = rows.find((candidate) => candidate.track.id === hit.clip.track)!;
        const x = Math.round(hover.current.x) + 0.5;
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.moveTo(x, row.y - scrollY);
        ctx.lineTo(x, row.y - scrollY + row.h);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if (drag.current?.kind === "marquee") drawMarquee(ctx, drag.current);

    // Snap guide.
    if (snapLine.current !== null) {
      const x = Math.round(frameToX(snapLine.current)) + 0.5;
      ctx.strokeStyle = "#facc15";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, RULER);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    drawRuler(ctx, width, fps, ppf, useView.getState().scrollX);

    // Playhead.
    const px = Math.round(frameToX(playhead.frame)) + 0.5;
    if (px >= -10 && px <= width + 10) {
      ctx.strokeStyle = "#ff3d6e";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, RULER - 4);
      ctx.lineTo(px, height);
      ctx.stroke();
      ctx.fillStyle = "#ff3d6e";
      ctx.beginPath();
      ctx.moveTo(px - 6, 6);
      ctx.lineTo(px + 6, 6);
      ctx.quadraticCurveTo(px + 7, 6, px + 7, 8);
      ctx.lineTo(px + 7, 15);
      ctx.lineTo(px, RULER - 4);
      ctx.lineTo(px - 7, 15);
      ctx.lineTo(px - 7, 8);
      ctx.quadraticCurveTo(px - 7, 6, px - 6, 6);
      ctx.fill();
    }

    if (!project.clips.length && !drop.current) {
      ctx.fillStyle = "#5c5c5c";
      ctx.font = "13px 'Geist Variable', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Drag media or elements here", width / 2, RULER + (height - RULER) / 2);
      ctx.textAlign = "left";
    }
  }

  const videoTracks = project.tracks.filter((track) => track.kind === "video");
  const audioTracks = project.tracks.filter((track) => track.kind === "audio");

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
        <IconButton label="Select (V)" active={tool === "select"} onClick={() => setTool("select")}>
          <MousePointer2 size={15} />
        </IconButton>
        <IconButton label="Razor (C)" active={tool === "razor"} onClick={() => setTool("razor")}>
          <Scissors size={15} />
        </IconButton>
        <div className="mx-1 h-4 w-px bg-line" />
        <IconButton label="Snapping (N)" active={snapping} onClick={() => toggle("snapping")}>
          <Magnet size={15} />
        </IconButton>
        <IconButton label="Graph editor (G)" active={view.graph} onClick={() => useView.setState({ graph: !useView.getState().graph })}>
          <Spline size={15} />
        </IconButton>
        <div className="mx-1 h-4 w-px bg-line" />
        <button
          title="Add video track"
          onClick={() => edit((draft) => void addTrack(draft, "video"))}
          className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted hover:bg-hover hover:text-fg"
        >
          <Plus size={13} /> Video
        </button>
        <button
          title="Add audio track"
          onClick={() => edit((draft) => void addTrack(draft, "audio"))}
          className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted hover:bg-hover hover:text-fg"
        >
          <Plus size={13} /> Audio
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1">
        <div className="relative shrink-0 overflow-hidden border-r border-line" style={{ width: HEADER }}>
          <div style={{ transform: `translateY(${-view.scrollY}px)` }}>
            {rows.map((row) => (
              <TrackHeader key={row.track.id} row={row} label={trackLabel(project, row.track)} />
            ))}
          </div>
          <div className="absolute inset-x-0 top-0 flex items-center bg-panel px-2.5 text-[10px] font-medium tracking-wide text-faint uppercase" style={{ height: RULER }}>
            {videoTracks.length}V · {audioTracks.length}A
          </div>
        </div>
        <div ref={wrapRef} className="relative min-w-0 flex-1" onDragOver={onDragOver} onDrop={onDrop} onDragLeave={() => ((drop.current = null), requestDraw())}>
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
            onWheel={onWheel}
            onContextMenu={(event) => {
              const { x, y } = local(event);
              const hit = y >= RULER ? clipAt(x, y) : null;
              const row = rowAt(y);
              if (hit) openMenu(event, clipMenu(hit.clip.id));
              else openMenu(event, timelineMenu(Math.max(0, Math.round(xToFrame(x))), row?.track.kind === "video" ? row.track.id : undefined, fit));
              requestDraw();
            }}
          />
        </div>
        {view.graph && <GraphEditor />}
      </div>
      <ZoomBar width={view.lanes} header={view.graph ? GRAPH_HEADER : HEADER} fps={fps} onFit={fit} />
    </section>
  );
}

/** Never narrower than this, in px (from Repack's lanes). */
const THUMB_LEAST = 28;

/**
 * The view as a bar under the lanes (from Repack's subtitle timeline): the
 * thumb is the stretch in view. Drag it to move, drag an end to zoom,
 * click beside it to jump there, double-click to see it all.
 */
function ZoomBar({ width, header, fps, onFit }: { width: number; header: number; fps: number; onFit: () => void }) {
  const { ppf, scrollX } = useView();
  const held = useRef<{ part: "thumb" | "in" | "out"; x: number; start: number; end: number } | null>(null);
  const start = scrollX / ppf;
  const span = width / ppf;
  // The bar is the whole edit; the thumb is the part in view.
  const total = Math.max(contentFrames(), start + span, 1);
  const thumbWidth = width > 0 ? Math.max(THUMB_LEAST, Math.min(width, (span / total) * width)) : 0;
  const thumbLeft = width > 0 ? Math.max(0, Math.min(width - thumbWidth, (start / total) * width)) : 0;
  const show = (from: number, to: number) => {
    const next = width / Math.max(1, to - from);
    setView({ ppf: next, scrollX: from * Math.min(MOST_PPF, Math.max(next, width / contentFrames())) });
  };
  const down = (event: React.PointerEvent<HTMLElement>, part: "thumb" | "in" | "out") => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    held.current = { part, x: event.clientX, start, end: start + span };
  };
  const move = (event: React.PointerEvent<HTMLElement>) => {
    const grip = held.current;
    if (!grip || width <= 0) return;
    const shift = ((event.clientX - grip.x) * total) / width;
    if (grip.part === "thumb") setView({ scrollX: (grip.start + shift) * ppf });
    else if (grip.part === "in") show(Math.max(0, Math.min(grip.end - fps, grip.start + shift)), grip.end);
    else show(grip.start, Math.max(grip.start + fps, grip.end + shift));
  };
  return (
    <div className="flex h-4 shrink-0 border-t border-line">
      <span className="shrink-0 border-r border-line" style={{ width: header }} aria-hidden />
      <div
        className="relative min-w-0 flex-1 touch-none select-none"
        title="Drag to move · drag an end to zoom · double-click to see it all"
        onPointerDown={(event) => {
          if (event.button !== 0 || width <= 0) return;
          const box = event.currentTarget.getBoundingClientRect();
          const at = ((event.clientX - box.left) / width) * total;
          setView({ scrollX: (at - span / 2) * ppf });
        }}
        onPointerMove={move}
        onPointerUp={() => (held.current = null)}
        onDoubleClick={onFit}
      >
        <span
          className="group absolute top-[3px] bottom-[3px] flex cursor-grab justify-between rounded-full bg-white/[0.13] transition-colors hover:bg-[#3a3a3a] active:cursor-grabbing active:bg-[#3a3a3a]"
          style={{ left: thumbLeft, width: thumbWidth }}
          onPointerDown={(event) => down(event, "thumb")}
          onPointerMove={move}
          onPointerUp={() => (held.current = null)}
        >
          {(["in", "out"] as const).map((part) => (
            <span
              key={part}
              className="flex w-[9px] cursor-ew-resize justify-center rounded-full"
              onPointerDown={(event) => down(event, part)}
              onPointerMove={move}
              onPointerUp={() => (held.current = null)}
            >
              <span className="h-full w-[3px] rounded-full bg-muted opacity-0 transition-opacity group-hover:opacity-100" />
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}

function TrackHeader({ row, label }: { row: Row; label: string }) {
  const edit = useEditor((state) => state.edit);
  const { track } = row;
  const set = (key: "hidden" | "muted" | "locked") =>
    edit((draft) => {
      const live = draft.tracks.find((candidate) => candidate.id === track.id);
      if (live) live[key] = !live[key];
    });
  return (
    <div
      className="absolute inset-x-0 flex items-center gap-0.5 pr-1 pl-2.5"
      style={{ top: row.y, height: row.h }}
      onContextMenu={(event) => openMenu(event, trackMenu(track.id))}
    >
      <span className={cx("mr-auto font-mono text-[11px] font-medium", track.kind === "video" ? "text-fg/80" : "text-green-300/80")}>{label}</span>
      {track.kind === "video" ? (
        <IconButton label={track.hidden ? "Show track" : "Hide track"} className="size-6" onClick={() => set("hidden")}>
          {track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
        </IconButton>
      ) : (
        <IconButton label={track.muted ? "Unmute track" : "Mute track"} className="size-6" onClick={() => set("muted")}>
          {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </IconButton>
      )}
      <IconButton label={track.locked ? "Unlock track" : "Lock track"} className={cx("size-6", track.locked && "text-amber-300")} onClick={() => set("locked")}>
        {track.locked ? <Lock size={12} /> : <LockOpen size={12} />}
      </IconButton>
    </div>
  );
}

// --- canvas helpers ----------------------------------------------------------

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(0, w), h, radius);
}

function shade(hex: string, alpha: number) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
}

function drawClip(
  ctx: CanvasRenderingContext2D,
  project: Project,
  clip: Clip,
  x0: number,
  x1: number,
  y: number,
  h: number,
  selected: boolean,
  track: Track,
  statuses: Record<string, { thumbs: string; peaks: string; thumb_count: number }>,
  width: number,
  onAsset: () => void,
) {
  const color = CLIP_HEX[clip.color];
  const w = Math.max(2, x1 - x0 - 1);
  const dim = track.hidden || track.muted;
  ctx.save();
  ctx.globalAlpha = dim ? 0.4 : 1;
  roundRect(ctx, x0, y, w, h, 6);
  ctx.save();
  ctx.clip();

  // Body.
  ctx.fillStyle = shade(color, clip.type === "audio" ? 0.28 : 0.32);
  ctx.fillRect(x0, y, w, h);
  const header = clip.type === "video" ? 17 : 0;

  const visible0 = Math.max(x0, -2);
  const visible1 = Math.min(x0 + w, width + 2);
  const fps = project.settings.fps;
  const ppf = (x1 - x0) / clip.duration;
  const sourceAt = (x: number) =>
    (clip.type === "video" || clip.type === "audio" ? clip.source_in : 0) + ((x - x0) / ppf / fps) * ("speed" in clip ? clip.speed : 1);

  if (clip.type === "video") {
    const media = mediaOf(project, clip.media);
    const status = statuses[clip.media];
    const image = media && sprite(project, clip.media, status?.thumbs === "ready", onAsset);
    if (media && image) {
      const count = Math.max(1, status?.thumb_count || 1);
      const cellW = image.naturalWidth / count;
      const th = h - header;
      const tw = Math.max(8, (th * cellW) / image.naturalHeight);
      const start = x0 + Math.floor((visible0 - x0) / tw) * tw;
      for (let x = start; x < visible1; x += tw) {
        const t = sourceAt(x + tw / 2);
        const index = Math.min(count - 1, Math.max(0, Math.floor((t / media.duration) * count)));
        ctx.drawImage(image, index * cellW, 0, cellW, image.naturalHeight, x, y + header, tw, th);
      }
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fillRect(x0, y + header, w, h - header);
    }
    ctx.fillStyle = shade(color, 0.92);
    ctx.fillRect(x0, y, w, header);
  } else if (clip.type === "audio") {
    const status = statuses[clip.media];
    const data = waveform(project, clip.media, status?.peaks === "ready", onAsset);
    if (data) {
      ctx.fillStyle = shade(color, 0.85);
      const mid = y + h / 2 + 5;
      const amp = (h - 18) / 2;
      for (let x = Math.floor(visible0); x < visible1; x += 2) {
        const a = Math.max(0, Math.floor(sourceAt(x) * 100));
        const b = Math.max(a + 1, Math.ceil(sourceAt(x + 2) * 100));
        let peak = 0;
        for (let i = a; i < b && i < data.length; i++) peak = Math.max(peak, data[i]);
        const bar = Math.max(0.5, (peak / 255) * amp * Math.pow(10, clip.volume_db / 40));
        ctx.fillRect(x, mid - bar, 1.5, bar * 2);
      }
    }
  } else {
    // Generated clips: one flat colour.
    ctx.fillStyle = shade(color, 0.6);
    ctx.fillRect(x0, y, w, h);
  }

  // Fades.
  const fade = (frames: number, atStart: boolean) => {
    if (frames <= 0) return;
    const fw = frames * ppf;
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    if (atStart) {
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + fw, y);
      ctx.lineTo(x0, y + h);
    } else {
      ctx.moveTo(x0 + w, y);
      ctx.lineTo(x0 + w - fw, y);
      ctx.lineTo(x0 + w, y + h);
    }
    ctx.fill();
  };
  fade(clip.fade_in, true);
  fade(clip.fade_out, false);

  // Keyframe ticks.
  if (clip.keyframes) {
    ctx.fillStyle = "#fcd34d";
    for (const keys of Object.values(clip.keyframes)) {
      for (const key of keys) {
        const kx = x0 + key.frame * ppf;
        if (kx < x0 || kx > x0 + w) continue;
        ctx.beginPath();
        ctx.moveTo(kx, y + h - 9);
        ctx.lineTo(kx + 3.5, y + h - 5.5);
        ctx.lineTo(kx, y + h - 2);
        ctx.lineTo(kx - 3.5, y + h - 5.5);
        ctx.fill();
      }
    }
  }

  // Label.
  if (w > 24) {
    const label = clipTitle(project, clip) + (("speed" in clip && clip.speed !== 1) ? `  ${Math.round(clip.speed * 100)}%` : "");
    ctx.fillStyle = clip.type === "video" ? "rgba(255,255,255,0.97)" : "rgba(255,255,255,0.92)";
    const textX = Math.max(x0 + 6, 6);
    const fitted = ellipsize(ctx, label, x0 + w - textX - 6);
    if (fitted) ctx.fillText(fitted, textX, clip.type === "video" || clip.type === "audio" ? y + 9 : y + h / 2);
  }
  ctx.restore();

  // Outline.
  roundRect(ctx, x0 + 0.5, y + 0.5, w - 1, h - 1, 6);
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeStyle = selected ? "#ffffff" : shade(color, 0.7);
  ctx.stroke();
  ctx.restore();
}

const fitted = new Map<string, string>();

/** `text` cut to fit `max` px with an ellipsis, at the current font size (never squashed). */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (max < 12) return "";
  const key = `${ctx.font}|${text}|${Math.floor(max)}`;
  const cached = fitted.get(key);
  if (cached !== undefined) return cached;
  let result = text;
  if (ctx.measureText(text).width > max) {
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (ctx.measureText(`${text.slice(0, mid).trimEnd()}…`).width <= max) low = mid;
      else high = mid - 1;
    }
    result = low > 0 ? `${text.slice(0, low).trimEnd()}…` : "";
  }
  if (fitted.size > 2000) fitted.clear();
  fitted.set(key, result);
  return result;
}
