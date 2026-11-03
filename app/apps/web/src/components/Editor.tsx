import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { addElement, addMarker, clipEnd, deleteClips, duplicateClips, rippleDelete, splitAt } from "../lib/edit";
import { playhead, preview } from "../lib/playback";
import { api, ApiError } from "../lib/api";
import { cloudApi } from "../lib/cloud";
import { clientId, connectEvents, leave, settled, syncScriptJob, useEditor } from "../lib/store";
import { clearIn, clearInOut, clearOut, markIn, markOut } from "../lib/inOut";
import { goToEnd, goToStart, useView } from "../lib/timelineView";
import { followNotes, startNote } from "../lib/notes";
import { attachFiles } from "../lib/chatFiles";
import { projectUploader } from "../lib/upload";
import { ShareDialog } from "./ShareDialog";
import { FileBrowser } from "./FileBrowser";
import { Research } from "./Research";
import { AgentPanel } from "./AgentPanel";
import { CloudBanner } from "./CloudBanner";
import { MissingBanner } from "./MissingBanner";
import { Timeline } from "./Timeline";
import { TopBar } from "./TopBar";
import { ProblemView } from "./ProblemView";
import { cx, spring } from "./ui";
import { Loader } from "./Logo";
import { toggleFullscreen, Viewer } from "./Viewer";
import { rate } from "../lib/types";

export function Editor({ id }: { id: string }) {
  const project = useEditor((state) => state.project);
  const timelineHeight = useEditor((state) => state.timelineHeight);
  const [resizing, setResizing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [researching, setResearching] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The team's notes on this edit, for the player and the row above the composer.
  useEffect(() => {
    followNotes(id);
    return () => followNotes(null);
  }, [id]);

  useEffect(() => {
    let alive = true;
    connectEvents();
    // The project left last saves everything first (reopening it shows its last edits).
    // A cloud project: downloaded first if it’s only in the cloud, and its
    // lock asked for, so the editor knows whether it’s read-only.
    settled()
      .then(() => cloudApi.open(id, clientId))
      .then((cloud) => alive && useEditor.setState({ cloud }))
      .catch((error) => {
        // Unreachable server: the project request below says so.
        // Or not this account’s kind of video (403): says so instead of opening.
        if (error instanceof ApiError && (error.status === 404 || error.status === 403)) throw error;
      })
      .then(() => api.project(id))
      .then(({ rev, project }) => {
        if (!alive) return;
        useEditor.getState().load(rev, project);
        void syncScriptJob(id);
        // A reset the agent was already asking about when the page (re)loaded.
        void api
          .resetAsked(id)
          .then(({ pending }) => alive && pending !== null && useEditor.setState({ resetAsked: true }))
          .catch(() => {});
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
      preview.pause();
      void leave().finally(() => cloudApi.close(id, clientId).catch(() => {}));
    };
  }, [id]);

  useShortcuts({ onImport: () => setImporting(true), onExport: () => setSharing(true) });
  useDropToChat();

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <ProblemView error={error} doing="open this project" className="max-w-[420px]" />
      </div>
    );
  }
  if (!project || project.id !== id) {
    return (
      // Said, not just a dot: a long edit takes a while to open (the user, Oct 30: "we need a better loading view").
      <div className="flex h-full items-center justify-center">
        <Loader label="Opening the project…" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-black">
      <TopBar onShare={() => setSharing(true)} />
      <CloudBanner />
      <MissingBanner />
      {/* No padding on the right: the chat's edge sits there, at the window's very edge while the chat is closed. */}
      <div className="flex min-h-0 flex-1 pb-2 pl-2">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Experiment (Nov 3): no media/script panel and no Info/Presets/Transcript panel — the viewer takes the whole left side. Their components and state stay; only this layout stopped mounting them, so putting them back is this block again. */}
          <div className="flex min-h-0 flex-1">
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
        <AgentDock />
      </div>
      <FileBrowser open={importing} onClose={() => setImporting(false)} />
      <Research open={researching} onClose={() => setResearching(false)} />
      <ShareDialog open={sharing} onClose={() => setSharing(false)} />
    </div>
  );
}

/**
 * Files dropped anywhere off the timeline (which places its own) are attached
 * to the chat's next message, as a drop on the composer is. No overlay over
 * the page: the composer shows it takes them (Sphe, Nov 3: the big "Drop to
 * upload to kenobi" in the middle "should go").
 */
function useDropToChat() {
  useEffect(() => {
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
    const over = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    // Bubble phase: only drops nothing else handled (the timeline and the composer stop their own).
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      const project = useEditor.getState().project?.id;
      if (project === undefined) return;
      const refused = attachFiles(`project:${project}`, [...(event.dataTransfer?.files ?? [])], projectUploader(project));
      if (refused.length > 0) useEditor.getState().toast(refused.join(" · "), "error");
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);
}

/**
 * The chat at the right, sized by its edge as the timeline is by its divider
 * (the user, Oct 30): drag the edge to make it wider or narrower, click it to
 * close the chat; closed, the edge stays at the window's very edge (the
 * cursor says so), and a click or a drag brings the chat back. No button: a
 * line, and violet while its agent works behind a closed chat.
 */
function AgentDock() {
  const show = useEditor((state) => state.showAgent);
  const width = useEditor((state) => state.agentWidth);
  const working = useEditor((state) => state.agentActive > 0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; width: number; open: boolean; moved: boolean } | null>(null);
  const fit = (value: number) => Math.round(Math.min(Math.max(280, value), Math.max(280, Math.min(760, window.innerWidth - 640))));
  const end = () => {
    const was = drag.current;
    drag.current = null;
    setDragging(false);
    // A click, not a drag: closes the chat, or brings it back.
    if (was !== null && !was.moved) useEditor.getState().toggle("showAgent");
  };
  return (
    <>
      <div
        title={show ? "Drag to resize · click to close the chat" : "Click to open the chat"}
        className={cx(
          "group relative z-10 flex w-2 shrink-0 cursor-col-resize touch-none items-center justify-center",
          // A wider reach than the gap itself, so it's easy to catch.
          "before:absolute before:inset-y-0 before:-left-[5px] before:-right-[3px] before:content-['']",
        )}
        onPointerDown={(event) => {
          (event.target as HTMLElement).setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, width, open: show, moved: false };
        }}
        onPointerMove={(event) => {
          const at = drag.current;
          if (at === null) return;
          const pulled = at.x - event.clientX;
          if (!at.moved && Math.abs(pulled) < 4) return;
          if (!at.moved) {
            at.moved = true;
            setDragging(true);
          }
          // Closed, the chat comes out with the pointer once it's pulled far enough to read.
          const next = at.open ? at.width + pulled : pulled;
          if (!at.open && next < 160) return;
          if (!useEditor.getState().showAgent) useEditor.getState().toggle("showAgent");
          useEditor.getState().setAgentWidth(fit(next));
        }}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <div
          className={cx(
            "w-[3px] rounded-[3px] transition-[height,background-color] duration-200 ease-out",
            dragging ? "h-[72px] bg-playhead" : !show && working ? "h-14 animate-pulse bg-agent" : "h-9 bg-transparent group-hover:h-14 group-hover:bg-[#5a5a5a]",
          )}
        />
      </div>
      <motion.aside
        initial={false}
        animate={{ width: show ? width + 8 : 0, opacity: show ? 1 : 0 }}
        transition={dragging ? { duration: 0 } : spring}
        className="flex min-h-0 shrink-0 flex-col self-stretch overflow-hidden"
      >
        {/* A flex column with a real height, so a long transcript scrolls and the composer stays at the bottom. */}
        <div className="flex min-h-0 w-full flex-1 flex-col pr-2" style={{ width: width + 8 }}>
          <AgentPanel />
        </div>
      </motion.aside>
    </>
  );
}

/** The divider above the timeline (as Repack’s panel gutters): a pill that grows when
 * you’re on it and turns playhead red while dragged; double-click resets the height. */
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
        // A wider reach than the gap itself, so it’s easy to catch.
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
        // ⌥ changes the key’s character on a Mac, so match the physical key.
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
      } else if (key === "q") {
        // A note for the agent, at the playhead (lib/notes.ts).
        handled();
        startNote();
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
