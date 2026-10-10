import { Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { paramAt, projectDuration, setParam } from "../lib/edit";
import { viewerMenu } from "../lib/menus";
import { playhead, preview } from "../lib/playback";
import { openMenu } from "./ContextMenu";
import { useEditor } from "../lib/store";
import { timecode } from "../lib/time";
import { IconButton } from "./ui";

const useFrame = () => useSyncExternalStore(playhead.subscribe, () => Math.floor(playhead.frame));
const usePlaying = () => useSyncExternalStore(playhead.subscribe, () => playhead.playing);

export function Viewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const project = useEditor((state) => state.project);
  const media = useEditor((state) => state.media);
  const [error, setError] = useState<string | null>(null);

  const versions = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [id, status] of Object.entries(media)) out[id] = status.proxy === "ready" ? "proxy" : "source";
    return out;
  }, [media]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const off = preview.onStatus(() => setError(preview.error));
    void preview.attach(canvas);
    return () => {
      off();
      preview.detach();
    };
  }, []);

  useEffect(() => {
    if (project) preview.setProject(project, versions);
  }, [project, versions]);

  useEffect(() => {
    const wrap = wrapRef.current!;
    const canvas = canvasRef.current!;
    const observer = new ResizeObserver(() => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(wrap.clientWidth * dpr));
      const height = Math.max(1, Math.round(wrap.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        preview.resize(width, height);
      }
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  const empty = project && project.clips.length === 0;

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <div ref={wrapRef} className="relative min-h-0 flex-1 bg-black">
        <canvas ref={canvasRef} className="absolute inset-0 size-full" onPointerDown={(event) => dragTransform(event, wrapRef.current!)}
          onContextMenu={(event) => openMenu(event, viewerMenu())}
        />
        {error && (
          <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-muted">
            <p className="max-w-[380px]">{error}</p>
          </div>
        )}
        {!error && empty && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-faint">
            Import footage or add a title to start
          </div>
        )}
      </div>
      <Transport />
    </section>
  );
}

/** Drag the selected clip's position directly on the canvas. */
function dragTransform(event: React.PointerEvent, wrap: HTMLDivElement) {
  const state = useEditor.getState();
  const project = state.project;
  const id = state.selection.length === 1 ? state.selection[0] : null;
  const clip = id ? project?.clips.find((candidate) => candidate.id === id) : null;
  if (!project || !clip || !("transform" in clip)) return;
  const frame = Math.floor(playhead.frame);
  if (frame < clip.start || frame >= clip.start + clip.duration) return;
  const fit = Math.min(wrap.clientWidth / project.settings.width, wrap.clientHeight / project.settings.height);
  const startX = paramAt(clip, "x", frame);
  const startY = paramAt(clip, "y", frame);
  const origin = { x: event.clientX, y: event.clientY };
  const target = event.currentTarget as HTMLElement;
  target.setPointerCapture(event.pointerId);
  state.beginGesture();
  const move = (moveEvent: PointerEvent) => {
    let dx = (moveEvent.clientX - origin.x) / fit;
    let dy = (moveEvent.clientY - origin.y) / fit;
    if (moveEvent.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    useEditor.getState().gesture((draft) => {
      const live = draft.clips.find((candidate) => candidate.id === clip.id);
      if (!live) return;
      setParam(live, "x", Math.round(startX + dx), frame);
      setParam(live, "y", Math.round(startY + dy), frame);
    });
  };
  const up = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", up);
    useEditor.getState().endGesture();
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", up);
}

function Transport() {
  const frame = useFrame();
  const playing = usePlaying();
  const fps = useEditor((state) => state.project?.settings.fps ?? 30);
  const duration = useEditor((state) => (state.project ? projectDuration(state.project) : 0));
  return (
    <div className="flex h-11 shrink-0 items-center border-t border-line px-3">
      <div className="w-[120px] font-mono text-[13px] text-fg tabular">{timecode(frame, fps)}</div>
      <div className="flex flex-1 items-center justify-center gap-0.5">
        <IconButton label="Go to start (Home)" onClick={() => preview.seek(0)}>
          <SkipBack size={15} />
        </IconButton>
        <IconButton label="Previous frame (←)" onClick={() => preview.seek(playhead.frame - 1)}>
          <StepBack size={15} />
        </IconButton>
        <button
          aria-label={playing ? "Pause" : "Play"}
          title="Play / pause (Space)"
          onClick={() => preview.toggle()}
          className="mx-1.5 flex size-8 items-center justify-center rounded-full bg-white text-black transition-transform duration-150 hover:scale-105 active:scale-95"
        >
          {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="translate-x-px" />}
        </button>
        <IconButton label="Next frame (→)" onClick={() => preview.seek(playhead.frame + 1)}>
          <StepForward size={15} />
        </IconButton>
        <IconButton label="Go to end (End)" onClick={() => preview.seekEnd()}>
          <SkipForward size={15} />
        </IconButton>
      </div>
      <div className="w-[120px] text-right font-mono text-[13px] text-faint tabular">{timecode(duration, fps)}</div>
    </div>
  );
}
