import { Maximize, Minimize, Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { openReport } from "../lib/diagnostics";
import { paramAt, projectDuration, setParam } from "../lib/edit";
import { clearInOut, inOutSpan, useInOut } from "../lib/inOut";
import { viewerMenu } from "../lib/menus";
import { playhead, preview } from "../lib/playback";
import { wantsLight } from "../lib/previewQuality";
import { goToEnd, goToStart } from "../lib/timelineView";
import { openMenu } from "./ContextMenu";
import { importProgress } from "../lib/import_progress";
import { useEditor } from "../lib/store";
import { timecode } from "../lib/time";
import { ProblemView } from "./ProblemView";
import { cx, IconButton } from "./ui";
import { rate } from "../lib/types";

const useFrame = () => useSyncExternalStore(playhead.subscribe, () => Math.floor(playhead.frame));
const usePlaying = () => useSyncExternalStore(playhead.subscribe, () => playhead.playing);
const useFullscreen = () => useSyncExternalStore(
  (listener) => {
    document.addEventListener("fullscreenchange", listener);
    return () => document.removeEventListener("fullscreenchange", listener);
  },
  () => document.fullscreenElement !== null && document.fullscreenElement === viewer,
);

/** In fullscreen the controls and cursor fade after this long without the mouse moving. */
const IDLE_MS = 2500;
let viewer: HTMLElement | null = null;

/** Fills the screen with the viewer alone (F); Esc or F again comes back. */
export function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void viewer?.requestFullscreen().catch(() => {});
}

export function Viewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const project = useEditor((state) => state.project);
  const media = useEditor((state) => state.media);
  const [error, setError] = useState<string | null>(null);
  const [buffering, setBuffering] = useState(false);
  const [stuck, setStuck] = useState(false);
  const fullscreen = useFullscreen();
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wake = () => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    if (fullscreen) idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
  };
  useEffect(() => { wake(); return () => clearTimeout(idleTimer.current); }, [fullscreen]);

  const light = wantsLight;
  // The picture each media streams: the light preview once it’s made (when
  // wanted), else the preview, else the original. Each with its files' stamps
  // ("light~<light>~<preview>"), so a version’s URL is only ever that version.
  const versionKey = JSON.stringify(
    Object.fromEntries(Object.entries(media).map(([id, status]) => {
      const preview = status.stamps?.preview ?? "";
      const version = light && status.light === "ready" ? `light~${status.stamps?.light ?? ""}~${preview}`
        : status.proxy === "ready" ? `preview~${preview}` : "source";
      return [id, version];
    })),
  );
  const versions = useMemo(() => JSON.parse(versionKey) as Record<string, string>, [versionKey]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const off = preview.onStatus(() => { setError(preview.error); setBuffering(preview.buffering); setStuck(preview.stuck); });
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
  const job = useEditor((state) => state.scriptJob);
  const importing = job !== null && job.state !== "done" ? importProgress(job) : null;

  const hidden = fullscreen && idle;
  return (
    <section
      ref={(element) => { viewer = element; }}
      onPointerMove={fullscreen ? wake : undefined}
      className={fullscreen
        ? cx("relative flex bg-black", hidden && "cursor-none")
        : "flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-panel"}
    >
      <div ref={wrapRef} className="relative min-h-0 flex-1 bg-black">
        {/* Fullscreen is for watching: a click plays or pauses instead of moving the selection. */}
        <canvas ref={canvasRef} className="absolute inset-0 size-full"
          onPointerDown={(event) => { if (fullscreen) preview.toggle(); else dragTransform(event, wrapRef.current!); }}
          onContextMenu={(event) => { if (!fullscreen) openMenu(event, viewerMenu()); }}
        />
        {error && (
          <div className="absolute inset-0 flex items-center justify-center p-8">
            <ProblemView error={error} doing="show the preview" className="max-w-[380px]" />
          </div>
        )}
        {!error && buffering && (
          <div role="status" className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-2 rounded-md bg-black/70 px-2.5 py-1.5 text-[11px] text-muted">
            <span className="size-3 animate-spin rounded-full border border-white/20 border-t-white/80" /> Loading frame…
          </div>
        )}
        {!error && buffering && stuck && (
          <button
            className="absolute right-3 bottom-11 rounded-md bg-black/70 px-2.5 py-1.5 text-[11px] text-muted underline underline-offset-2 hover:text-fg"
            onClick={() => openReport(`The preview has been stuck on "Loading frame…" at frame ${Math.floor(playhead.frame)}`)}
          >
            Stuck? Report it
          </button>
        )}
        {!error && empty && importing !== null && (
          <button
            onClick={() => useEditor.getState().setMediaTab("downloads")}
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[13px]"
          >
            <span className={cx("text-muted", job?.state !== "failed" && job?.state !== "waiting" && "shimmer")}>{importing.line}</span>
            <span className="h-1 w-56 overflow-hidden rounded-full bg-white/10">
              <span className={cx("block h-full rounded-full transition-[width] duration-500", job?.state === "failed" || job?.state === "waiting" ? "bg-danger" : "bg-white/70")} style={{ width: `${Math.max(2, Math.round(importing.fraction * 100))}%` }} />
            </span>
            <span className="text-[11px] text-faint tabular">{Math.round(importing.fraction * 100)}% · the edit appears here as soon as it’s laid out</span>
          </button>
        )}
        {!error && empty && importing === null && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-faint">
            Import footage or add a title to start
          </div>
        )}
      </div>
      <div className={fullscreen
        ? cx("absolute inset-x-0 bottom-0 bg-black/75 backdrop-blur transition-opacity duration-300", hidden && "pointer-events-none opacity-0")
        : undefined}>
        <Transport fullscreen={fullscreen} />
      </div>
    </section>
  );
}

/** Drag the selected clip’s position directly on the canvas. */
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

function Transport({ fullscreen }: { fullscreen: boolean }) {
  const frame = useFrame();
  const playing = usePlaying();
  const fps = useEditor((state) => (state.project ? rate(state.project.settings) : 30));
  const duration = useEditor((state) => (state.project ? projectDuration(state.project) : 0));
  const points = useInOut();
  const span = inOutSpan(duration, points);
  return (
    <div className="flex h-11 shrink-0 items-center border-t border-line px-3">
      <div className="w-[180px] font-mono text-[13px] text-fg tabular">{timecode(frame, fps)}</div>
      <div className="flex flex-1 items-center justify-center gap-0.5">
        <IconButton label="Go to start (Home)" onClick={goToStart}>
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
        <IconButton label="Go to end (End)" onClick={goToEnd}>
          <SkipForward size={15} />
        </IconButton>
      </div>
      <div className="flex w-[180px] items-center justify-end gap-2">
        {span ? (
          <button
            onClick={clearInOut}
            title="In to out: what play stops at and export renders. Click (or ⌥X) to clear."
            className="group flex items-center gap-1.5 font-mono text-[13px] text-fg tabular"
          >
            <span className="rounded bg-white/10 px-1 font-sans text-[10px] font-medium tracking-wide text-muted uppercase group-hover:bg-white/15 group-hover:text-fg">
              In–Out
            </span>
            {timecode(span[1] - span[0], fps)}
          </button>
        ) : (
          <div className="font-mono text-[13px] text-faint tabular">{timecode(duration, fps)}</div>
        )}
        <IconButton label={fullscreen ? "Exit full screen (F)" : "Full screen (F)"} onClick={toggleFullscreen}>
          {fullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
        </IconButton>
      </div>
    </div>
  );
}
