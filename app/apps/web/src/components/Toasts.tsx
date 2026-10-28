import { Bot, CircleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { holdToast, useEditor } from "../lib/store";
import { ToastProblem } from "./ProblemView";

export function Toasts() {
  const toasts = useEditor((state) => state.toasts);
  const dismiss = useEditor((state) => state.dismiss);
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            layout
            key={toast.id}
            role={toast.problem ? "alert" : "status"}
            onClick={() => dismiss(toast.id)}
            onMouseEnter={() => holdToast(toast.id)}
            onMouseLeave={() => holdToast(null)}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
            // The kit’s toast: one look for every tone, a red icon saying it’s an error.
            className="pointer-events-auto flex max-w-[440px] cursor-default items-start gap-2.5 rounded-[10px] border border-line-strong bg-raised py-2.5 pr-3 pl-3.5 text-[13px] text-fg shadow-[0_12px_32px_#0009]"
          >
            {toast.tone === "error" && <CircleAlert size={16} className="mt-px shrink-0 text-danger" />}
            {toast.tone === "agent" && <Bot size={15} className="mt-px shrink-0 text-agent" />}
            {toast.problem ? <ToastProblem problem={toast.problem} onDismiss={() => dismiss(toast.id)} /> : <span className="text-left">{toast.text}</span>}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
