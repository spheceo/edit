import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";

import { importProgress } from "../lib/import_progress";
import { useEditor, type SideTab } from "../lib/store";
import { Inspector } from "./Inspector";
import { Library } from "./Library";
import { Presets } from "./Presets";
import { ScriptDownloads, ScriptPanel } from "./ScriptPanel";
import { TranscriptPanel } from "./TranscriptPanel";
import { Tabs } from "./ui";

/** Info (inspector), Presets, Library, Transcript, Script and (while a script imports) Downloads, next to the media bin. */
export function SidePanel() {
  const tab = useEditor((state) => state.sideTab);
  const setTab = useEditor((state) => state.setSideTab);
  const selection = useEditor((state) => state.selection);
  const job = useEditor((state) => state.scriptJob);
  const downloading = Boolean(job && job.state !== "done");

  // Picking something on the timeline while browsing presets shows its settings.
  const previous = useRef(selection);
  useEffect(() => {
    const picked = selection.length > 0 && selection.join() !== previous.current.join();
    previous.current = selection;
    if (picked && useEditor.getState().sideTab === "presets") setTab("info");
  }, [selection, setTab]);

  // Downloads finished: back to the script they were for.
  useEffect(() => {
    if (!downloading && useEditor.getState().sideTab === "downloads") setTab("script");
  }, [downloading, setTab]);

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex h-11 shrink-0 items-center border-b border-line px-2">
        <Tabs<SideTab>
          id="side"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "info", label: "Info" },
            { value: "presets", label: "Presets" },
            { value: "library", label: "Library" },
            { value: "transcript", label: "Transcript" },
            { value: "script", label: "Script" },
            ...(downloading && job ? [{ value: "downloads" as const, label: job.state === "failed" ? "Downloads ⚠" : `Downloads ${Math.round(importProgress(job).fraction * 100)}%` }] : []),
          ]}
        />
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -2 }}
          transition={{ duration: 0.12 }}
          className="flex min-h-0 flex-1 flex-col"
        >
          {tab === "info" ? (
            <Inspector />
          ) : tab === "script" ? (
            <ScriptPanel />
          ) : tab === "downloads" ? (
            <ScriptDownloads />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-2">{tab === "presets" ? <Presets /> : tab === "library" ? <Library /> : <TranscriptPanel />}</div>
          )}
        </motion.div>
      </AnimatePresence>
    </section>
  );
}
