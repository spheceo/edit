import { ChevronLeft, Redo2, Share, Undo2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { useConnection } from "../lib/api";
import { navigate } from "../lib/route";
import { useEditor } from "../lib/store";
import { OpenAIMark } from "./AgentPanel";
import { AppMenu } from "./AppMenu";
import { Mark } from "./Logo";
import { UpdateButton } from "./UpdateButton";
import { Button, cx, IconButton, spring } from "./ui";

export function TopBar({ onExport }: { onExport: () => void }) {
  const name = useEditor((state) => state.project?.name ?? "");
  const down = useConnection((state) => state.down);
  const agentActive = useEditor((state) => state.agentActive > 0);
  const showAgent = useEditor((state) => state.showAgent);
  const exportState = useEditor((state) => state.exportState);
  const toggle = useEditor((state) => state.toggle);
  const workspace = useEditor((state) => state.workspace);
  const setWorkspace = useEditor((state) => state.setWorkspace);

  return (
    <header className="relative flex h-12 shrink-0 items-center gap-2 px-3">
      <IconButton label="All projects" onClick={() => navigate("/")}>
        <ChevronLeft size={17} />
      </IconButton>
      <Mark size={20} />
      <NameField value={name} />
      <History />
      {/* Only worth a word when the server is away. */}
      <AnimatePresence>
        {down && (
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="ml-1 text-[12px] text-amber-300/80"
          >
            Reconnecting…
          </motion.span>
        )}
      </AnimatePresence>

      {/* Edit and Script views, centred like a document tab bar. */}
      <div className="absolute left-1/2 flex -translate-x-1/2 rounded-lg bg-panel p-0.5 ring-1 ring-line">
        {(["edit", "script"] as const).map((value) => (
          <button
            key={value}
            onClick={() => setWorkspace(value)}
            className={cx(
              "relative h-7 rounded-md px-3 text-[12px] font-medium transition-colors",
              workspace === value ? "text-fg" : "text-muted hover:text-fg",
            )}
          >
            {workspace === value && <motion.span layoutId="workspace" className="absolute inset-0 rounded-md bg-active" transition={spring} />}
            <span className="relative">{value === "edit" ? "Edit" : "Script"}</span>
          </button>
        ))}
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <UpdateButton />
        <IconButton label="Toggle Codex" active={showAgent} onClick={() => toggle("showAgent")} className="relative">
          <OpenAIMark size={14} />
          {agentActive && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-agent" />}
        </IconButton>
        <AppMenu />
        <Button variant="primary" className="ml-1.5" onClick={onExport}>
          {exportState?.state === "running" ? (
            <span className="tabular">{Math.round(exportState.progress * 100)}%</span>
          ) : (
            <Share size={14} strokeWidth={2.2} />
          )}
          Export
        </Button>
      </div>
    </header>
  );
}

function NameField({ value }: { value: string }) {
  const [draft, setDraft] = useState(value);
  const edit = useEditor((state) => state.edit);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const name = draft.trim();
    if (name && name !== value) edit((project) => void (project.name = name));
    else setDraft(value);
  };
  return (
    <input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        if (event.key === "Escape") {
          setDraft(value);
          (event.target as HTMLInputElement).blur();
        }
      }}
      spellCheck={false}
      title={value}
      // Long names end in a proper "…" (not cut mid-letter) until you click in to edit.
      className="h-8 min-w-0 truncate rounded-md bg-transparent px-1.5 text-[14px] font-medium text-fg outline-none hover:bg-hover focus:bg-hover"
      style={{ width: `${Math.min(40, Math.max(6, draft.length + 1))}ch` }}
    />
  );
}

/** Undo and redo (⌘Z, ⇧⌘Z): every edit, in and out points, imports and the agent's changes. */
function History() {
  const canUndo = useEditor((state) => state.past.length > 0);
  const canRedo = useEditor((state) => state.future.length > 0);
  return (
    <div className="flex items-center">
      <IconButton label="Undo (⌘Z)" disabled={!canUndo} onClick={() => useEditor.getState().undo()}>
        <Undo2 size={15} />
      </IconButton>
      <IconButton label="Redo (⇧⌘Z)" disabled={!canRedo} onClick={() => useEditor.getState().redo()}>
        <Redo2 size={15} />
      </IconButton>
    </div>
  );
}
