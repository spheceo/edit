// The chat column at a screen's right: the editor's, an idea's and a thumbnail's.

import { motion } from "motion/react";
import { useRef, useState, type ReactNode } from "react";

import { useEditor } from "../lib/store";
import { cx, spring } from "./ui";

/**
 * The chat at the right, sized by its edge as the timeline is by its divider
 * (the user, Oct 30): drag the edge to make it wider or narrower, double-click
 * it for the screen's own width again. Always open (Sphe, Nov 12: closing it
 * by a click on its edge "I don't think we'll ever need"). No button: a line.
 * One width for every screen's chat once dragged, remembered on this browser;
 * until then each screen's own (`defaultWidth`: Bodycam HQ's is wider).
 *
 * The screen leaves no padding on its right: the edge sits there.
 */
export function ChatDock({ defaultWidth = 340, children }: { working?: boolean; defaultWidth?: number; children: ReactNode }) {
  const width = useEditor((state) => state.agentWidth) ?? defaultWidth;
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; width: number; moved: boolean } | null>(null);
  const fit = (value: number) => Math.round(Math.min(Math.max(280, value), Math.max(280, Math.min(760, window.innerWidth - 640))));
  const end = () => {
    drag.current = null;
    setDragging(false);
  };
  return (
    <>
      <div
        title="Drag to resize · double-click for the default width"
        onDoubleClick={() => useEditor.getState().setAgentWidth(null)}
        className={cx(
          "group relative z-10 flex w-2 shrink-0 cursor-col-resize touch-none items-center justify-center",
          // A wider reach than the gap itself, so it's easy to catch.
          "before:absolute before:inset-y-0 before:-left-[5px] before:-right-[3px] before:content-['']",
        )}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, width, moved: false };
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
          useEditor.getState().setAgentWidth(fit(at.width + pulled));
        }}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <div
          className={cx(
            "w-[3px] rounded-[3px] transition-[height,background-color] duration-200 ease-out",
            dragging ? "h-[72px] bg-playhead" : "h-9 bg-transparent group-hover:h-14 group-hover:bg-[#5a5a5a]",
          )}
        />
      </div>
      <motion.aside
        initial={false}
        animate={{ width: width + 8, opacity: 1 }}
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
