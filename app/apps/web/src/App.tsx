import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useState } from "react";

import { AppDialogs } from "./components/AppMenu";
import { ContextMenuHost } from "./components/ContextMenu";
import { Editor } from "./components/Editor";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ExportActivity } from "./components/ExportActivity";
import { Home } from "./components/Home";
import { HomeClassic } from "./components/HomeClassic";
import { ScriptMode } from "./writer/script-mode";
import { IdeaScreen } from "./ideas/page";
import { ThumbnailScreen } from "./thumbnails/page";
import { ThumbnailsScreen } from "./thumbnails/list";
import { SignInGate } from "./components/SignInScreen";
import { Toasts } from "./components/Toasts";
import { useConnection } from "./lib/api";
import { loadBeta, tabHome, useBeta } from "./lib/beta";
import { watchPresence } from "./lib/presence";
import { usePath } from "./lib/route";

export function App() {
  const path = usePath();
  // How long the window has been idle, for diagnostics (lib/presence.ts).
  useEffect(() => watchPresence(), []);
  const projectId = path.match(/^\/p\/([\w-]+)/)?.[1];
  // Script mode: /scripts (the library) and /scripts/<id> (a script), one screen that keeps its state across them.
  const scripts = path === "/scripts" || path.startsWith("/scripts/");
  // An idea's page: /ideas/<id> (Home's Ideas section lists them).
  const ideaId = path.match(/^\/ideas\/([\w-]+)/)?.[1];
  // Thumbnails (Nov 2): /thumbnails (the list) and /thumbnails/<id> (one, with its conversation).
  const thumbId = path.match(/^\/thumbnails\/([\w-]+)/)?.[1];
  // With the sidebar Home on, the list is Home's Thumbnails, in its panel (Sphe, Nov 2), so it's Home's screen too.
  const sidebarHome = useBeta((beta) => tabHome ?? beta.home);
  const thumbs = path === "/thumbnails" && !sidebarHome;
  const screen = projectId ?? (scripts ? "scripts" : ideaId !== undefined ? `idea-${ideaId}` : thumbId !== undefined ? `thumb-${thumbId}` : thumbs ? "thumbnails" : "home");
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
            <SignInGate>
              {projectId ? <Editor id={projectId} /> : scripts ? <ScriptMode /> : ideaId !== undefined ? <IdeaScreen id={ideaId} /> : thumbId !== undefined ? <ThumbnailScreen id={thumbId} /> : thumbs ? <ThumbnailsScreen /> : <HomeScreen />}
            </SignInGate>
          </ErrorBoundary>
        </motion.div>
      </AnimatePresence>
      <ServerDown />
      <Toasts />
      {/* Edit's exports, in the editor and the Home everyone has (the sidebar Home has them in its header); a script page has none of its own, and the pill sat over its top bar (the user, Oct 31). */}
      {!scripts && ideaId === undefined && thumbId === undefined && !thumbs && !(sidebarHome && screen === "home") && <ExportActivity />}
      <AppDialogs />
      <ContextMenuHost />
    </MotionConfig>
  );
}

/**
 * Home: the sidebar one (Home.tsx) when this Mac has it on in Settings → Beta,
 * else the Home everyone has (HomeClassic.tsx). The user, Oct 31: "put the new
 * Home … behind a beta option in Settings that can easily be toggled on and
 * off". A check in headless Chrome opens `/?home=new` instead (tabHome).
 */
function HomeScreen() {
  const sidebar = useBeta((beta) => tabHome ?? beta.home);
  useEffect(() => {
    void loadBeta().catch(() => {});
  }, []);
  return sidebar ? <Home /> : <HomeClassic />;
}

/**
 * Edit's server not answering for a while: said on every screen. The user,
 * Nov 2: "sometimes i launch [the dev URL] and i just get a blank screen":
 * the server behind Vite had stopped that morning, and Home waited on it with
 * nothing on the page but its header (the editor's "Reconnecting…" is in its
 * own top bar only). A restart takes a few seconds; this comes after 8.
 */
function ServerDown() {
  const down = useConnection((state) => state.down);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!down) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), 8000);
    return () => clearTimeout(timer);
  }, [down]);
  return (
    <AnimatePresence>
      {shown && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          role="status"
          className="fixed bottom-5 left-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 rounded-xl border border-white/[0.08] bg-[#161616] px-4 py-3 text-[13px] shadow-2xl"
        >
          <p className="font-medium text-fg">Edit's server isn't answering</p>
          <p className="mt-1 leading-relaxed text-muted">
            {import.meta.env.DEV ? (
              <>
                Still trying. If it doesn't come back, it has stopped: run <code className="rounded bg-white/[0.06] px-1 py-0.5 text-fg">just dev</code> again.
              </>
            ) : (
              "Still trying. If it doesn't come back, quit Edit and open it again."
            )}
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
