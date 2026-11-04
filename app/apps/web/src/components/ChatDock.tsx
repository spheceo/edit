// The chat column at a screen's right: the editor's, an idea's and a thumbnail's.

import { motion } from "motion/react";
import { useRef, useState, type ReactNode } from "react";

import { useEditor } from "../lib/store";
import { cx, spring } from "./ui";

/**
 * The chat at the right, sized by its edge as the timeline is by its divider
 * (the user, Oct 30): drag the edge to make it wider or narrower, click it to
 * close the chat; closed, the edge stays at the window's very edge (the
 * cursor says so), and a click or a drag brings the chat back. No button: a
 * line, and violet while its agent works behind a closed chat. One width and
 * one open-or-closed for every screen's chat, remembered on this browser.
 *
 * The screen leaves no padding on its right: the edge sits there.
 */
export function ChatDock({ working = false, children }: { working?: boolean; children: ReactNode }) {
  const show = useEditor((state) => state.showAgent);
  const width = useEditor((state) => state.agentWidth);
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
          event.currentTarget.setPointerCapture(event.pointerId);
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
          {children}
        </div>
      </motion.aside>
    </>
  );
}
