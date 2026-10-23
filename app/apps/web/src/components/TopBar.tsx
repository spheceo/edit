import { ChevronLeft, Cloud, CloudAlert, CloudCheck, CloudOff, CloudSync, CloudUpload, Copy, ExternalLink, Lock, Redo2, Share, Undo2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { useConnection } from "../lib/api";
import { syncLabel } from "../lib/cloud";
import { copyDriveLink, openDrive, useDriveLink } from "../lib/drive";
import { navigate } from "../lib/route";
import { useEditor } from "../lib/store";
import { AgentMark } from "./AgentPanel";
import { AppMenu } from "./AppMenu";
import { toggleMenu } from "./ContextMenu";
import { Mark } from "./Logo";
import { StartedBy } from "./StartedBy";
import { UpdateButton } from "./UpdateButton";
import { Button, cx, IconButton } from "./ui";

export function TopBar({ onExport }: { onExport: () => void }) {
  const name = useEditor((state) => state.project?.name ?? "");
  const createdBy = useEditor((state) => state.project?.created_by);
  const down = useConnection((state) => state.down);
  const agentActive = useEditor((state) => state.agentActive > 0);
  const showAgent = useEditor((state) => state.showAgent);
  const exportState = useEditor((state) => state.exportState);
  const toggle = useEditor((state) => state.toggle);

  return (
    <header className="relative flex h-12 shrink-0 items-center gap-2 px-3">
      <IconButton label="All projects" onClick={() => navigate("/")}>
        <ChevronLeft size={17} />
      </IconButton>
      <Mark size={20} />
      <NameField value={name} />
      <StartedBy by={createdBy} size={22} />
      <History />
      <SyncState />
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

      <div className="ml-auto flex items-center gap-1.5">
        <UpdateButton />
        <IconButton label="Toggle agent" active={showAgent} onClick={() => toggle("showAgent")} className="relative">
          <AgentMark size={14} />
          {agentActive && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-agent" />}
        </IconButton>
        <DriveButton />
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

/** A cloud project's sync: saved to cloud, syncing, offline, conflict, read-only. */
function SyncState() {
  const cloud = useEditor((state) => state.cloud);
  const label = syncLabel(cloud);
  if (!label) return null;
  const Icon = { ok: CloudCheck, busy: CloudSync, warn: label.text === "Read-only" ? Lock : CloudOff, bad: CloudAlert }[label.tone];
  const title = cloud?.missing ?? cloud?.message ?? (cloud?.sync === "readonly" ? `${cloud.holder} is editing` : cloud?.sync === "offline" ? "Changes are saved on this Mac and go to the cloud when it's back" : label.text);
  return (
    <span
      title={title}
      className={cx(
        "ml-1 flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12px]",
        label.tone === "ok" && "text-faint",
        label.tone === "busy" && "text-muted",
        label.tone === "warn" && "text-amber-300/80",
        label.tone === "bad" && "text-red-300",
      )}
    >
      <Icon size={14} className={label.tone === "busy" ? "animate-pulse" : undefined} />
      {label.text}
    </span>
  );
}

/** The edit's export on the team's Drive: its upload, then its link. */
function DriveButton() {
  const projectId = useEditor((state) => state.project?.id ?? "");
  const drive = useDriveLink(projectId, useEditor((state) => state.project?.drive));
  const driveState = useEditor((state) => state.driveState);
  const toast = useEditor((state) => state.toast);
  if (driveState?.state === "uploading") {
    return (
      <span className="flex h-8 items-center gap-1.5 px-2 text-[12px] text-muted tabular" title="Uploading the export to Drive">
        <CloudUpload size={15} />
        {Math.round((driveState.progress ?? 0) * 100)}%
      </span>
    );
  }
  if (!drive) return null;
  return (
    <IconButton
      label={`On Drive: ${drive.name}`}
      onClick={(event) =>
        toggleMenu(
          event.currentTarget,
          [
            { label: "Open on Drive", icon: <ExternalLink size={14} />, onSelect: () => openDrive(drive.url) },
            { label: "Copy Drive link", icon: <Copy size={14} />, onSelect: () => void copyDriveLink(drive.url, toast) },
          ],
          { width: 190 },
        )
      }
    >
      <Cloud size={16} />
    </IconButton>
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
