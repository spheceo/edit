import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { addElement, addMarker, clipEnd, deleteClips, duplicateClips, rippleDelete, splitAt } from "../lib/edit";
import { playhead, preview } from "../lib/playback";
import { api, ApiError, useMachine } from "../lib/api";
import { cloudApi } from "../lib/cloud";
import { clientId, connectEvents, flushSave, syncScriptJob, useEditor } from "../lib/store";
import { clearIn, clearInOut, clearOut, markIn, markOut } from "../lib/inOut";
import { goToEnd, goToStart, useView } from "../lib/timelineView";
import { uploadFiles } from "../lib/upload";
import { ExportDialog } from "./ExportDialog";
import { FileBrowser } from "./FileBrowser";
import { Research } from "./Research";
import { AgentPanel } from "./AgentPanel";
import { CloudBanner } from "./CloudBanner";
import { MediaPanel } from "./MediaPanel";
import { SidePanel } from "./SidePanel";
import { Timeline } from "./Timeline";
import { TopBar } from "./TopBar";
import { cx, spring, Spinner } from "./ui";
import { toggleFullscreen, Viewer } from "./Viewer";
import { rate } from "../lib/types";

const MEDIA_WIDTH = 280;
const SIDE_WIDTH = 296;
const AGENT_WIDTH = 340;
const SCRIPT_WIDTH = 440;

/** A panel that springs open and closed, keeping its gap to the viewer. */
/** Panels keep their share of the window: sized for a ~1640 px wide window and
 * grown in step on wider ones (an ultrawide), so the viewer doesn't take all the extra width. */
function usePanelScale() {
  const scale = () => Math.min(2.4, Math.max(1, window.innerWidth / 1640));
  const [value, setValue] = useState(scale);
  useEffect(() => {
    const onResize = () => setValue(scale());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return value;
}

function SlideIn({
  show,
  width: base,
  side,
  fixed = false,
  children,
}: {
  show: boolean;
  width: number;
  side: "left" | "right";
  /** Keeps its width on wide windows (the chat reads best narrow). */
  fixed?: boolean;
  children: React.ReactNode;
}) {
  const scale = usePanelScale();
  const width = fixed ? base : Math.round(base * scale);
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.aside
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: width + 8, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={spring}
          className={side === "right" ? "flex shrink-0 justify-end overflow-hidden" : "shrink-0 overflow-hidden"}
        >
          <div className={side === "right" ? "h-full shrink-0 pl-2" : "h-full shrink-0 pr-2"} style={{ width: width + 8 }}>
            {children}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

export function Editor({ id }: { id: string }) {
  const project = useEditor((state) => state.project);
  const showMedia = useEditor((state) => state.showMedia);
  const showInspector = useEditor((state) => state.showInspector);
  const showAgent = useEditor((state) => state.showAgent);
  // The script reads better wider than the other side tabs.
  const wide = useEditor((state) => state.sideTab === "script" || state.sideTab === "downloads");
  const timelineHeight = useEditor((state) => state.timelineHeight);
  const [resizing, setResizing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [researching, setResearching] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    connectEvents();
    // A cloud project: downloaded first if it's only in the cloud, and its
    // lock asked for, so the editor knows whether it's read-only.
    cloudApi
      .open(id, clientId)
      .then((cloud) => alive && useEditor.setState({ cloud }))
      .catch((error) => {
        // Unreachable server: the project request below says so.
        if (error instanceof ApiError && error.status === 404) throw error;
      })
      .then(() => api.project(id))
      .then(({ rev, project }) => {
        if (!alive) return;
        useEditor.getState().load(rev, project);
        void syncScriptJob(id);
        return api.mediaStatus(id).then(({ media }) => alive && useEditor.setState({ media }));
      })
      .catch((error) => alive && setError(error.message));
    // Still open (an editor that stops saying so lets the lock go).
    const heartbeat = setInterval(() => {
      void cloudApi
        .open(id, clientId, true)
        .then((cloud) => alive && useEditor.setState({ cloud }))
        .catch(() => {});
    }, 30_000);
    return () => {
      alive = false;
      clearInterval(heartbeat);
      void flushSave().finally(() => cloudApi.close(id, clientId).catch(() => {}));
      preview.pause();
      useEditor.getState().close();
    };
  }, [id]);

  useShortcuts({ onImport: () => setImporting(true), onExport: () => setExporting(true) });
  const dropping = useFileDrop();
  const machine = useMachine();

  if (error) {
    return <div className="flex h-full items-center justify-center text-muted">{error}</div>;
  }
  if (!project || project.id !== id) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-black">
      <TopBar onExport={() => setExporting(true)} />
      <CloudBanner />
      <div className="flex min-h-0 flex-1 px-2 pb-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <SlideIn show={showMedia} width={MEDIA_WIDTH} side="left">
              <MediaPanel onImport={() => setImporting(true)} onResearch={() => setResearching(true)} />
            </SlideIn>
            <SlideIn show={showInspector} width={wide ? SCRIPT_WIDTH : SIDE_WIDTH} side="left">
              <SidePanel />
            </SlideIn>
            <Viewer />
          </div>
          <ResizeBar resizing={resizing} setResizing={setResizing} />
          <div
            className="shrink-0"
            // A reset glides to the default; while dragged it follows the pointer at once.
            style={{ height: timelineHeight, transition: resizing ? "none" : "height 0.32s cubic-bezier(0.2, 0.7, 0.2, 1)" }}
          >
            <Timeline />
          </div>
        </div>
        <SlideIn show={showAgent} width={AGENT_WIDTH} side="right" fixed>
          <AgentPanel />
        </SlideIn>
      </div>
      <FileBrowser open={importing} onClose={() => setImporting(false)} />
      <Research open={researching} onClose={() => setResearching(false)} />
      <AnimatePresence>
        {dropping && (
          <motion.div
            className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-black/55 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
          >
            <motion.div
              initial={{ scale: 0.96 }}
              animate={{ scale: 1 }}
              transition={spring}
              className="rounded-2xl border border-dashed border-white/40 bg-panel/90 px-8 py-6 text-center"
            >
              <div className="text-[15px] font-medium">Drop to upload to {machine}</div>
              <div className="mt-1 text-[12px] text-muted">Drop on the timeline to place it there</div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <ExportDialog open={exporting} onClose={() => setExporting(false)} />
    </div>
  );
}

/** True while files from the OS are dragged over the window; drops outside the timeline go to the bin. */
function useFileDrop() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth += 1;
      setActive(true);
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setActive(false);
    };
    const over = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    // Bubble phase: only drops nothing else handled (the timeline stops its own).
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      uploadFiles([...(event.dataTransfer?.files ?? [])]);
    };
    // Capture phase sees every drop, so the overlay always clears.
    const reset = () => {
      depth = 0;
      setActive(false);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    window.addEventListener("drop", reset, true);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
      window.removeEventListener("drop", reset, true);
      window.removeEventListener("dragend", reset);
    };
  }, []);
  return active;
}

/** The divider above the timeline (as Repack's panel gutters): a pill that grows when
 * you're on it and turns playhead red while dragged; double-click resets the height. */
function ResizeBar({ resizing, setResizing }: { resizing: boolean; setResizing: (resizing: boolean) => void }) {
  const drag = useRef<{ y: number; height: number } | null>(null);
  const end = () => {
    drag.current = null;
    setResizing(false);
  };
  return (
    <div
      title="Drag to resize · double-click to reset"
      className={cx(
        "group relative z-10 flex h-2 shrink-0 cursor-row-resize touch-none items-center justify-center",
        // A wider reach than the gap itself, so it's easy to catch.
        "before:absolute before:inset-x-0 before:-inset-y-[5px] before:content-['']",
      )}
      onPointerDown={(event) => {
        (event.target as HTMLElement).setPointerCapture(event.pointerId);
        drag.current = {
          y: event.clientY,
          height: useEditor.getState().timelineHeight,
        };
        setResizing(true);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const height = drag.current.height - (event.clientY - drag.current.y);
        useEditor.getState().setTimelineHeight(Math.min(window.innerHeight - 260, Math.max(160, height)));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => useEditor.getState().resetTimelineHeight()}
    >
      <div
        className={cx(
          "h-[3px] rounded-[3px] transition-[width,background-color] duration-200 ease-out",
          resizing ? "w-[72px] bg-playhead" : "w-9 bg-transparent group-hover:w-14 group-hover:bg-[#5a5a5a]",
        )}
      />
    </div>
  );
}

function isTyping(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  return !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
}

function useShortcuts({ onImport, onExport }: { onImport: () => void; onExport: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event) || document.querySelector("[role=dialog], [data-menu]")) return;
      const state = useEditor.getState();
      const project = state.project;
      if (!project) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const fps = rate(project.settings);
      const handled = () => event.preventDefault();

      if (mod && key === "z") {
        handled();
        if (event.shiftKey) state.redo();
        else state.undo();
      } else if (mod && key === "y") {
        handled();
        state.redo();
      } else if (mod && key === "a") {
        handled();
        state.select(project.clips.map((clip) => clip.id));
      } else if (mod && key === "d") {
        handled();
        let created: string[] = [];
        state.edit((draft) => {
          created = duplicateClips(draft, state.selection);
        });
        state.select(created);
      } else if (mod && key === "i") {
        handled();
        onImport();
      } else if (mod && key === "e") {
        handled();
        onExport();
      } else if ((mod && key === "k") || (!mod && key === "s")) {
        handled();
        const frame = Math.round(playhead.frame);
        state.edit((draft) => splitAt(draft, frame, state.selection));
      } else if (mod) {
        return;
      } else if (key === " ") {
        handled();
        preview.toggle();
      } else if (key === "arrowleft" || key === "arrowright") {
        handled();
        preview.pause();
        preview.seek(playhead.frame + (key === "arrowright" ? 1 : -1) * (event.shiftKey ? fps : 1));
      } else if (key === "arrowup" || key === "arrowdown") {
        handled();
        const edges = [...new Set(project.clips.flatMap((clip) => [clip.start, clipEnd(clip)]))].sort((a, b) => a - b);
        const current = Math.round(playhead.frame);
        const target = key === "arrowdown" ? edges.find((edge) => edge > current) : [...edges].reverse().find((edge) => edge < current);
        if (target !== undefined) preview.seek(target);
      } else if (key === "home") {
        handled();
        goToStart();
      } else if (key === "end") {
        handled();
        goToEnd();
      } else if (key === "backspace" || key === "delete") {
        if (!state.selection.length) return;
        handled();
        state.edit((draft) => (event.shiftKey ? rippleDelete(draft, state.selection) : deleteClips(draft, state.selection)));
        state.select([]);
      } else if (key === "escape") {
        state.select([]);
      } else if (key === "v") {
        state.setTool("select");
      } else if (key === "c") {
        state.setTool("razor");
      } else if (key === "m") {
        handled();
        const frame = Math.round(playhead.frame);
        state.edit((draft) => addMarker(draft, state.selection, frame));
      } else if (key === "n") {
        state.toggle("snapping");
      } else if (key === "f") {
        handled();
        toggleFullscreen();
      } else if (key === "g") {
        useView.setState({ graph: !useView.getState().graph });
      } else if (key === "t") {
        handled();
        let id = "";
        state.edit((draft) => {
          id = addElement(draft, "title", Math.round(playhead.frame));
        });
        state.select([id]);
      } else if (event.altKey && (event.code === "KeyI" || event.code === "KeyO" || event.code === "KeyX")) {
        // ⌥ changes the key's character on a Mac, so match the physical key.
        handled();
        if (event.code === "KeyI") clearIn();
        else if (event.code === "KeyO") clearOut();
        else clearInOut();
      } else if (key === "i") {
        handled();
        markIn(playhead.frame);
      } else if (key === "o") {
        handled();
        markOut(playhead.frame);
      } else if (key === "k") {
        preview.pause();
      } else if (key === "l") {
        preview.play();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onImport, onExport]);
}
