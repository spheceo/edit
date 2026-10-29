import { AnimatePresence, MotionConfig, motion } from "motion/react";

import { AppDialogs } from "./components/AppMenu";
import { ContextMenuHost } from "./components/ContextMenu";
import { Editor } from "./components/Editor";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ExportActivity } from "./components/ExportActivity";
import { Home } from "./components/Home";
import { ScriptMode } from "./writer/script-mode";
import { SignInGate } from "./components/SignInScreen";
import { Toasts } from "./components/Toasts";
import { usePath } from "./lib/route";

export function App() {
  const path = usePath();
  const projectId = path.match(/^\/p\/([\w-]+)/)?.[1];
  // Script mode: /scripts (the library) and /scripts/<id> (a script), one screen that keeps its state across them.
  const scripts = path === "/scripts" || path.startsWith("/scripts/");
  const screen = projectId ?? (scripts ? "scripts" : "home");
  return (
    // The kit: respect reduced motion (movement goes, fades stay).
    <MotionConfig reducedMotion="user">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={screen}
          className="h-full"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
        >
          <ErrorBoundary key={screen}>
            <SignInGate>{projectId ? <Editor id={projectId} /> : scripts ? <ScriptMode /> : <Home />}</SignInGate>
          </ErrorBoundary>
        </motion.div>
      </AnimatePresence>
      <Toasts />
      <ExportActivity />
      <AppDialogs />
      <ContextMenuHost />
    </MotionConfig>
  );
}
