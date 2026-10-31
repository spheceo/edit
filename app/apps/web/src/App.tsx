import { AnimatePresence, MotionConfig, motion } from "motion/react";

import { AppDialogs } from "./components/AppMenu";
import { ContextMenuHost } from "./components/ContextMenu";
import { Editor } from "./components/Editor";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ExportActivity } from "./components/ExportActivity";
import { Home } from "./components/Home";
import { ScriptMode } from "./writer/script-mode";
import { IdeaScreen } from "./ideas/page";
import { SignInGate } from "./components/SignInScreen";
import { Toasts } from "./components/Toasts";
import { usePath } from "./lib/route";

export function App() {
  const path = usePath();
  const projectId = path.match(/^\/p\/([\w-]+)/)?.[1];
  // Script mode: /scripts (the library) and /scripts/<id> (a script), one screen that keeps its state across them.
  const scripts = path === "/scripts" || path.startsWith("/scripts/");
  // An idea's page: /ideas/<id> (Home's Ideas section lists them).
  const ideaId = path.match(/^\/ideas\/([\w-]+)/)?.[1];
  const screen = projectId ?? (scripts ? "scripts" : ideaId !== undefined ? `idea-${ideaId}` : "home");
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
            <SignInGate>{projectId ? <Editor id={projectId} /> : scripts ? <ScriptMode /> : ideaId !== undefined ? <IdeaScreen id={ideaId} /> : <Home />}</SignInGate>
          </ErrorBoundary>
        </motion.div>
      </AnimatePresence>
      <Toasts />
      {/* Edit's exports, on Home and in the editor; a script page has none of its own, and the pill sat over its top bar (the user, Oct 31). */}
      {!scripts && ideaId === undefined && <ExportActivity />}
      <AppDialogs />
      <ContextMenuHost />
    </MotionConfig>
  );
}
