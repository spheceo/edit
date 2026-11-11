import { Maximize, MessageSquarePlus, Minimize, Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useAgent } from "../lib/agent";
import { api, mediaHost } from "../lib/api";
import { openReport } from "../lib/diagnostics";
import { paramAt, projectDuration, setParam } from "../lib/edit";
import { clearInOut, inOutSpan, useInOut } from "../lib/inOut";
import { viewerMenu } from "../lib/menus";
import { playhead, preview } from "../lib/playback";
import { nativePreview } from "../lib/nativePreview";
import { mediaVersions } from "../lib/mediaVersions";
import { wantsLight } from "../lib/previewQuality";
import { goToEnd, goToStart } from "../lib/timelineView";
import { openMenu } from "./ContextMenu";
import { importProgress } from "../lib/import_progress";
import { toggleNote, useNotes } from "../lib/notes";
import { useEditor } from "../lib/store";
import { timecode } from "../lib/time";
import { AnimatePresence, motion } from "motion/react";
import { hqActivity } from "../lib/agentTurns";
import { useEffects } from "../lib/effects";
import { useNow } from "../lib/now";
import { EffectLayer } from "./EffectLayer";
import { NoteBoxLayer, NoteDraft } from "./NoteDraft";
import { ProblemView } from "./ProblemView";
import { WaitingFiles } from "./ScriptPanel";
import { cx, IconButton, Pulse } from "./ui";
import { Loader } from "./Logo";
import { rate } from "../lib/types";

const useFrame = () => useSyncExternalStore(playhead.subscribe, () => Math.floor(playhead.frame));
const usePlaying = () => useSyncExternalStore(playhead.subscribe, () => playhead.playing);
const useSpeed = () => useSyncExternalStore(preview.onStatus, () => preview.speed);
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

/** Each media's picture version (mediaVersions.ts), the same object until one changes. */
const selectVersions = mediaVersions(wantsLight);

/** Edits settle this long before smooth playback is rendered again (the agent changes things many times a turn). */
const SMOOTH_SETTLE_MS = 2500;

export function Viewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null);
  const project = useEditor((state) => state.project);
  const rev = useEditor((state) => state.rev);
  const dirty = useEditor((state) => state.dirty);
  const playback = useEditor((state) => state.playback);
  const [smoothShown, setSmoothShown] = useState(preview.smoothShown);
  const [error, setError] = useState<string | null>(null);
  const [buffering, setBuffering] = useState(false);
  const [stuck, setStuck] = useState(false);
  const [framed, setFramed] = useState(preview.framed);
  const [native, setNative] = useState(preview.native);
  const fullscreen = useFullscreen();
  // Bodycam HQ (Edit V2) watches like a video: its controls float over the picture, as a video site's do.
  const hq = useEditor((state) => state.project?.hq === true);
  const playing = usePlaying();
  const overlay = fullscreen || hq;
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wake = () => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    if (overlay) idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
  };
  useEffect(() => { wake(); return () => clearTimeout(idleTimer.current); }, [overlay]);

  const versions = useEditor(selectVersions);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const off = preview.onStatus(() => { setError(preview.error); setBuffering(preview.buffering); setStuck(preview.stuck); setFramed(preview.framed); setSmoothShown(preview.smoothShown); setNative(preview.native); });
    void preview.attach(canvas);
    preview.attachVideo(videoRef.current);
    return () => {
      off();
      preview.attachVideo(null);
      preview.detach();
    };
  }, []);

  // Smooth playback: the rendered edit plays when it shows what's on screen (its
  // revision, nothing waiting to save); else the canvas draws live.
  const projectId = project?.id ?? null;
  // Rendered here, it plays a chunk at a time as each lands, while it renders too.
  const streamed = playback?.stream === true && (playback.state === "ready" || playback.state === "rendering") && playback.rev === rev && !dirty;
  const smooth = streamed ? `stream:${projectId}:${rev}` : playback?.url && playback.state === "ready" && playback.rev === rev && !dirty ? mediaHost(playback.url) : null;
  useEffect(() => { preview.setSmooth(smooth); }, [smooth]);
  // Edit.app's window draws the edit live: no render to wait for, also while full screen hands the
  // picture to the page for a while (a render took a place in the export line and the encoder, Nov 8 audit).
  const drawnByWindow = native || preview.nativeHere;
  useEffect(() => {
    if (projectId === null || drawnByWindow) return;
    let live = true;
    api.playback(projectId).then((status) => { if (live && useEditor.getState().project?.id === projectId) useEditor.setState({ playback: status }); }).catch(() => {});
    return () => { live = false; };
  }, [projectId, drawnByWindow]);
  // While it renders, looked at now and then: a server started again meanwhile (an update, a crash) has
  // forgotten the render, says "none", and it's asked for again below, rather than waited on for ever.
  const renderingNow = playback?.state === "rendering" || playback?.state === "waiting";
  useEffect(() => {
    if (projectId === null || !renderingNow || drawnByWindow) return;
    const timer = setInterval(() => {
      api.playback(projectId).then((status) => { if (useEditor.getState().project?.id === projectId) useEditor.setState({ playback: status }); }).catch(() => {});
    }, 10_000);
    return () => clearInterval(timer);
  }, [projectId, renderingNow, drawnByWindow]);
  // Asked for once the edits settle, unless it's rendering (or failed on) this revision; never mid-turn
  // (the agent changes the edit many times a turn: each render would be stale before it landed).
  const hasClips = (project?.clips.length ?? 0) > 0;
  const agentBusy = useAgent((state) => state.project === projectId && state.running);
  useEffect(() => {
    if (projectId === null || dirty || !hasClips || agentBusy || drawnByWindow) return;
    if (playback !== null && playback.rev === rev && playback.state !== "none") return;
    const timer = setTimeout(() => {
      api.renderPlayback(projectId, Math.floor(playhead.frame)).then((status) => { if (useEditor.getState().project?.id === projectId) useEditor.setState({ playback: status }); }).catch(() => {});
    }, SMOOTH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [projectId, rev, dirty, hasClips, agentBusy, playback, drawnByWindow]);

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

  // Full screen is the page's to draw: the window's layer isn't in the full-screen one.
  useEffect(() => { preview.setNativeAllowed(!fullscreen); }, [fullscreen]);
  // The window's layer under the viewer, where the picture is (lib/nativePreview.ts), shown once
  // its first frame is drawn and the screen's fade-in is over; the page turns see-through there.
  const nativeShown = native && framed && !error && !fullscreen;
  useEffect(() => {
    if (!native) return;
    const root = document.documentElement;
    root.classList.add("native-preview");
    // index.html paints <html> itself (inline, before the app loads): see-through too.
    const painted = root.style.getPropertyValue("background");
    root.style.setProperty("background", "transparent");
    const wrap = wrapRef.current!;
    const opened = performance.now();
    let last = "";
    let frame = 0;
    const place = () => {
      frame = requestAnimationFrame(place);
      const box = wrap.getBoundingClientRect();
      // After the screen's 160 ms fade-in, so the picture doesn't show ahead of the page around it.
      const visible = nativeShown && performance.now() - opened > 200;
      const key = `${box.left},${box.top},${box.width},${box.height},${visible}`;
      if (key === last) return;
      last = key;
      // The viewer's top corners: its box's radius (12 px) inside its 1 px border.
      void nativePreview.place({ x: box.left, y: box.top, width: box.width, height: box.height }, 11, visible).catch(() => {});
    };
    place();
    return () => {
      cancelAnimationFrame(frame);
      root.classList.remove("native-preview");
      root.style.setProperty("background", painted);
      void nativePreview.place({ x: 0, y: 0, width: 1, height: 1 }, 0, false).catch(() => {});
    };
  }, [native, nativeShown]);

  const empty = project && project.clips.length === 0;
  // An effect being made plays on an empty timeline (EffectLayer's bench): nothing to say over it.
  const benchShown = useEffects((state) => state.effects.length > 0);
  const job = useEditor((state) => state.scriptJob);
  const importing = job !== null && job.state !== "done" ? importProgress(job) : null;

  // Full screen's controls go when the mouse rests; HQ's only while it plays, and when the mouse leaves the picture.
  const hidden = fullscreen ? idle : hq && idle && playing;
  return (
    <section
      ref={(element) => { viewer = element; }}
      onPointerMove={overlay ? wake : undefined}
      onPointerLeave={hq && !fullscreen ? () => setIdle(true) : undefined}
      className={fullscreen
        ? cx("relative flex bg-black", hidden && "cursor-none")
        : cx("flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line", hq && "relative", hidden && "cursor-none", native ? "bg-transparent" : "bg-panel")}
    >
      <div ref={(element) => { wrapRef.current = element; setWrap(element); }} className={cx("relative min-h-0 flex-1", native ? "bg-transparent" : "bg-black")}>
        {/* Fullscreen is for watching: a click plays or pauses instead of moving the selection. */}
        {/* Drawn by Edit.app's window under the page when `native` (still here for its clicks and drags). */}
        <canvas ref={canvasRef} className={cx("absolute inset-0 size-full", native && "opacity-0")}
          onPointerDown={(event) => { if (overlay) preview.toggle(); else dragTransform(event, wrapRef.current!); }}
          onContextMenu={(event) => { if (!fullscreen) openMenu(event, viewerMenu()); }}
        />
        {/* Smooth playback over the canvas; clicks go through to it. */}
        <video ref={videoRef} playsInline preload="auto" className={cx("pointer-events-none absolute inset-0 size-full object-contain", !smoothShown && "invisible")} />
        {/* Coded effects (Edit V2) play here, each its own page over the picture. */}
        <EffectLayer wrap={wrap} />
        {hq && !fullscreen && <HqWorking />}
        {/* A note being left here: its box over the picture, and the bubble it's written in at the bottom left. */}
        {!fullscreen && <NoteBoxLayer wrap={wrap} />}
        {!fullscreen && <NoteDraft />}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center p-8">
            <ProblemView error={error} doing="show the preview" className="max-w-[380px]" />
          </div>
        )}
        {/* Its first frame on the way: said in the middle, not a corner badge on a black screen (the user, Oct 30: "we need a better loading view"). */}
        {!error && !framed && !empty && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Loader size={32} label="Loading the preview…" />
          </div>
        )}
        {!error && framed && buffering && (
          <div role="status" className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-2 rounded-md bg-black/70 px-2.5 py-1.5 text-[11px] text-muted">
            <Pulse size={12} /> Loading frame…
          </div>
        )}
        {!error && buffering && stuck && (
          <button
            className={cx("absolute rounded-md bg-black/70 px-2.5 py-1.5 text-[11px] text-muted underline underline-offset-2 hover:text-fg", framed ? "right-3 bottom-11" : "bottom-[calc(50%-64px)] left-1/2 -translate-x-1/2")}
            onClick={() => openReport(`The preview has been stuck on "Loading frame…" at frame ${Math.floor(playhead.frame)}`)}
          >
            Stuck? Report it
          </button>
        )}
        {!error && empty && importing !== null && job?.state === "waiting" && project && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-[13px]">
            <span className="text-muted">{importing.line}</span>
            <WaitingFiles project={project} job={job} />
          </div>
        )}
        {!error && empty && importing !== null && job?.state !== "waiting" && (
          <button
            onClick={() => useEditor.getState().setMediaTab("downloads")}
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[13px]"
          >
            <span className={cx("text-muted", job?.state !== "failed" && "shimmer")}>{importing.line}</span>
            <span className="h-1 w-56 overflow-hidden rounded-full bg-white/10">
              <span className={cx("block h-full rounded-full transition-[width] duration-500", job?.state === "failed" ? "bg-danger" : "bg-white/70")} style={{ width: `${Math.max(2, Math.round(importing.fraction * 100))}%` }} />
            </span>
            <span className="text-[11px] text-faint tabular">{Math.round(importing.fraction * 100)}% · the edit appears here as soon as it’s laid out</span>
          </button>
        )}
        {!error && empty && importing === null && !(hq && benchShown) && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-faint">
            Import footage or add a title to start
          </div>
        )}
      </div>
      {hq ? (
        <div className={cx("absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/35 to-transparent pt-14 transition-opacity duration-300", hidden && "pointer-events-none opacity-0")}>
          <VideoControls fullscreen={fullscreen} />
        </div>
      ) : (
        <div className={fullscreen
          ? cx("absolute inset-x-0 bottom-0 bg-black/75 backdrop-blur transition-opacity duration-300", hidden && "pointer-events-none opacity-0")
          : native ? "bg-panel" : undefined}>
          <Transport fullscreen={fullscreen} />
        </div>
      )}
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
  const noting = useNotes((state) => state.draft !== null);
  const speed = useSpeed();
  return (
    <div className="flex flex-col">
      {fullscreen && <ScrubBar frame={frame} duration={duration} />}
      <div className={cx("flex h-11 shrink-0 items-center px-3", !fullscreen && "border-t border-line")}>
      <div className="w-[220px] font-mono text-[13px] text-fg tabular">{timecode(frame, fps)}</div>
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
      <div className="flex w-[220px] items-center justify-end gap-2">
        {!fullscreen && (
          <IconButton label={noting ? "Close the note" : "Leave a note here (Q)"} active={noting} aria-pressed={noting} onClick={toggleNote}>
            <MessageSquarePlus size={15} />
          </IconButton>
        )}
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
        {/* Watching an edit through in half the time; Script mode's monitor has the same button. */}
        <IconButton
          label={speed === 1 ? "Play at 2× speed (L while playing)" : "Play at normal speed (L while playing)"}
          active={speed !== 1}
          aria-pressed={speed !== 1}
          onClick={() => preview.setSpeed(speed === 1 ? 2 : 1)}
          className="font-mono text-[12px] tabular"
        >
          {speed}×
        </IconButton>
        <IconButton label={fullscreen ? "Exit full screen (F)" : "Full screen (F)"} onClick={toggleFullscreen}>
          {fullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
        </IconButton>
      </div>
    </div>
    </div>
  );
}

/**
 * While Bodycam HQ's agent works, the viewer says so as the thumbnail page
 * does (Sphe, Nov 11: "something like the thumbnail page… where we see a cool
 * animation and the stage it's at"): its light turning round the picture's
 * edge, a sheen across it, and the stage on a dark pill with the turning orb.
 */
function HqWorking() {
  const running = useAgent((state) => state.running);
  const entries = useAgent((state) => state.entries);
  const now = useNow(running);
  const doing = hqActivity(entries, now);
  const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.5, ease: [0.2, 0, 0, 1] } } as const;
  return (
    <AnimatePresence>
      {running && (
        <motion.div key="working" {...fade} className="pointer-events-none absolute inset-0 rounded-[inherit]">
          <div className="working-sheen" />
          <div className="working-ring" />
          <div className="absolute inset-x-0 top-3 flex justify-center">
            <motion.div layout transition={{ type: "spring", stiffness: 420, damping: 34 }} className="flex h-7 items-center gap-2 rounded-full bg-[#0b0b0b] pr-3.5 pl-2 shadow-[0_0_0_1px_rgb(255_255_255/0.1),0_8px_24px_#000c]">
              <span className="working-orb" />
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={doing} initial={{ opacity: 0, y: 6, filter: "blur(3px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={{ opacity: 0, y: -6, filter: "blur(3px)" }} transition={{ duration: 0.26, ease: [0.2, 0, 0, 1] }} className="text-[12.5px] font-medium whitespace-nowrap text-white">
                  {doing}
                </motion.span>
              </AnimatePresence>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** A time as a video site says it: 0:04, 12:30, 1:02:09. */
function clock(frame: number, fps: number): string {
  const seconds = Math.max(0, Math.floor(frame / fps));
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`;
}

/**
 * Bodycam HQ's controls (Edit V2; Sphe, Nov 11: "much cleaner, without the
 * clumsy background almost like a youtube video controls"): a thin line to
 * scrub along, then play and the time on the left, a note, the speed and full
 * screen on the right, over a shade that fades up from the picture's foot.
 * Frame steps and the ends are the keys' (arrows, Home, End).
 */
function VideoControls({ fullscreen }: { fullscreen: boolean }) {
  const frame = useFrame();
  const playing = usePlaying();
  const fps = useEditor((state) => (state.project ? rate(state.project.settings) : 30));
  const duration = useEditor((state) => (state.project ? projectDuration(state.project) : 0));
  const noting = useNotes((state) => state.draft !== null);
  const speed = useSpeed();
  const light = "text-white/90 hover:bg-white/10 hover:text-white";
  return (
    <div className="flex flex-col px-3 pb-1">
      <ScrubBar frame={frame} duration={duration} thin />
      <div className="flex h-10 items-center gap-1">
        <IconButton label={playing ? "Pause (Space)" : "Play (Space)"} onClick={() => preview.toggle()} className={cx("size-8", light)}>
          {playing ? <Pause size={18} fill="currentColor" strokeWidth={0} /> : <Play size={18} fill="currentColor" strokeWidth={0} className="translate-x-px" />}
        </IconButton>
        <span className="ml-1.5 text-[13px] text-white/90 tabular">
          {clock(frame, fps)}
          <span className="text-white/50"> / {clock(duration, fps)}</span>
        </span>
        <div className="ml-auto flex items-center gap-1">
          {!fullscreen && (
            <IconButton label={noting ? "Close the note" : "Leave a note here (Q)"} active={noting} aria-pressed={noting} onClick={toggleNote} className={noting ? undefined : light}>
              <MessageSquarePlus size={16} />
            </IconButton>
          )}
          <IconButton
            label={speed === 1 ? "Play at 2× speed (L while playing)" : "Play at normal speed (L while playing)"}
            aria-pressed={speed !== 1}
            onClick={() => preview.setSpeed(speed === 1 ? 2 : 1)}
            className={cx("w-auto px-1.5 text-[12.5px] font-medium tabular", speed !== 1 ? "text-white" : light)}
          >
            {speed}×
          </IconButton>
          <IconButton label={fullscreen ? "Exit full screen (F)" : "Full screen (F)"} onClick={toggleFullscreen} className={light}>
            {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
          </IconButton>
        </div>
      </div>
    </div>
  );
}

/**
 * Fullscreen's scrub bar (no border above the controls there, Nov 3): a
 * tall hit area over a playhead-pink track; click or drag to move through
 * the edit while watching.
 */
function ScrubBar({ frame, duration, thin = false }: { frame: number; duration: number; thin?: boolean }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const fraction = duration > 0 ? Math.min(1, Math.max(0, frame / duration)) : 0;
  const seekFrom = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || duration <= 0) return;
    preview.seek(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration);
  };
  return (
    <div
      role="slider"
      aria-label="Scrub"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(frame)}
      title="Click or drag to scrub"
      className={cx("group flex cursor-pointer touch-none items-center", thin ? "h-4" : "h-6 px-3")}
      onPointerDown={(event) => {
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        seekFrom(event.clientX);
        const move = (moveEvent: PointerEvent) => seekFrom(moveEvent.clientX);
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
      }}
    >
      <div ref={trackRef} className={cx("relative w-full rounded-full bg-white/20 transition-[height]", thin ? "h-[3px] group-hover:h-[5px]" : "h-1.5 group-hover:h-2")}>
        <div className="absolute inset-y-0 left-0 rounded-full bg-playhead" style={{ width: `${fraction * 100}%` }} />
        <div className={cx("absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-playhead opacity-0 transition-opacity group-hover:opacity-100", thin ? "size-3" : "size-3.5")} style={{ left: `${fraction * 100}%` }} />
      </div>
    </div>
  );
}
