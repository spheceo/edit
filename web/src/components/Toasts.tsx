import { Bot, CircleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { useEditor } from "../lib/store";
import { cx, spring } from "./ui";

export function Toasts() {
  const toasts = useEditor((state) => state.toasts);
  const dismiss = useEditor((state) => state.dismiss);
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.button
            layout
            key={toast.id}
            onClick={() => dismiss(toast.id)}
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={spring}
            className={cx(
              "pointer-events-auto flex max-w-[520px] items-center gap-2 rounded-xl border px-3.5 py-2 text-[13px] shadow-[0_12px_40px_rgba(0,0,0,0.6)] backdrop-blur",
              toast.tone === "error" ? "border-red-500/30 bg-red-950/80 text-red-100" : "border-line-strong bg-raised/90 text-fg",
            )}
          >
            {toast.tone === "error" && <CircleAlert size={15} className="shrink-0 text-red-300" />}
            {toast.tone === "agent" && <Bot size={15} className="shrink-0 text-agent" />}
            <span className="text-left">{toast.text}</span>
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}
