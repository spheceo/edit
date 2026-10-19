import { AnimatePresence, motion } from "motion/react";

import { AppDialogs } from "./components/AppMenu";
import { ContextMenuHost } from "./components/ContextMenu";
import { Editor } from "./components/Editor";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Home } from "./components/Home";
import { Toasts } from "./components/Toasts";
import { usePath } from "./lib/route";

export function App() {
  const path = usePath();
  const projectId = path.match(/^\/p\/([\w-]+)/)?.[1];
  return (
    <>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={projectId ?? "home"}
          className="h-full"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
        >
          <ErrorBoundary key={projectId ?? "home"}>{projectId ? <Editor id={projectId} /> : <Home />}</ErrorBoundary>
        </motion.div>
      </AnimatePresence>
      <Toasts />
      <AppDialogs />
      <ContextMenuHost />
    </>
  );
}
