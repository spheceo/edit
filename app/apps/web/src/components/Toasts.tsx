import { Bot, CircleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { openReport } from "../lib/diagnostics";
import { useEditor } from "../lib/store";

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
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
            // The kit’s toast: one look for every tone, a red icon saying it’s an error.
            className="pointer-events-auto flex max-w-[520px] items-center gap-2.5 rounded-[10px] border border-line-strong bg-raised py-2.5 pr-2.5 pl-3.5 text-[13px] text-fg shadow-[0_12px_32px_#0009]"
          >
            {toast.tone === "error" && <CircleAlert size={16} className="shrink-0 text-danger" />}
            {toast.tone === "agent" && <Bot size={15} className="shrink-0 text-agent" />}
            <span className="text-left">{toast.text}</span>
            {toast.tone === "error" && (
              <span
                role="button"
                tabIndex={0}
                className="ml-1 shrink-0 rounded-md border border-line-strong px-2 py-0.5 text-[12px] text-fg hover:bg-hover"
                onClick={(event) => {
                  event.stopPropagation();
                  dismiss(toast.id);
                  openReport(toast.text);
                }}
              >
                Report
              </span>
            )}
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}
