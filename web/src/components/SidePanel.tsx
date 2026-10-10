import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";

import { useEditor, type SideTab } from "../lib/store";
import { Inspector } from "./Inspector";
import { Presets } from "./Presets";
import { TranscriptPanel } from "./TranscriptPanel";
import { Tabs } from "./ui";

/** Info (inspector), Presets and Transcript, next to the media bin. */
export function SidePanel() {
  const tab = useEditor((state) => state.sideTab);
  const setTab = useEditor((state) => state.setSideTab);
  const selection = useEditor((state) => state.selection);

  // Picking something on the timeline while browsing presets shows its settings.
  const previous = useRef(selection);
  useEffect(() => {
    const picked = selection.length > 0 && selection.join() !== previous.current.join();
    previous.current = selection;
    if (picked && useEditor.getState().sideTab === "presets") setTab("info");
  }, [selection, setTab]);

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
            { value: "transcript", label: "Transcript" },
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
          {tab === "info" ? <Inspector /> : <div className="min-h-0 flex-1 overflow-y-auto p-2">{tab === "presets" ? <Presets /> : <TranscriptPanel />}</div>}
        </motion.div>
      </AnimatePresence>
    </section>
  );
}
