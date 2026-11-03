import { ChevronLeft, Cloud, CloudAlert, CloudCheck, CloudOff, CloudSync, CloudUpload, Copy, ExternalLink, FileText, Lock, Redo2, Share, Undo2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useConnection } from "../lib/api";
import { syncLabel } from "../lib/cloud";
import { capitalize } from "../lib/export-face";
import { copyDriveLink, openDrive, useDriveLink } from "../lib/drive";
import { navigate } from "../lib/route";
import { useEditor } from "../lib/store";
import { AppMenu } from "./AppMenu";
import { DocChangesButton } from "./DocChangesBar";
import { toggleMenu } from "./ContextMenu";
import { Tile } from "./Logo";
import { StartedBy } from "./StartedBy";
import { UpdateButton } from "./UpdateButton";
import { Button, cx, IconButton } from "./ui";

export function TopBar({ onShare }: { onShare: () => void }) {
  const name = useEditor((state) => state.project?.name ?? "");
  const createdBy = useEditor((state) => state.project?.created_by);
  const projectId = useEditor((state) => state.project?.id);
  const down = useConnection((state) => state.down);
  const exportState = useEditor((state) => state.exportState);
  // Made from a script in Script mode: the same project's other mode.
  const scriptId = useEditor((state) => state.project?.script?.source)?.match(/^writer:([\w-]+)$/)?.[1];

  return (
    <header className="relative flex h-12 shrink-0 items-center gap-2 px-3">
      <IconButton label="All projects" onClick={() => navigate("/")}>
        <ChevronLeft size={17} />
      </IconButton>
      <Tile size={22} />
      <NameField value={name} />
      <StartedBy by={createdBy} projectId={projectId} size={32} />
      {/* Only worth a word when the server is away. */}
      <AnimatePresence>
        {down && (
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="ml-1 text-[12px] text-warning/80"
          >
            Reconnecting…
          </motion.span>
        )}
      </AnimatePresence>

      <div className="ml-auto flex items-center gap-1.5">
        <UpdateButton />
        {scriptId && (
          <Button variant="subtle" onClick={() => navigate(`/scripts/${scriptId}`)} title="This video's script, in Script mode">
            <FileText size={14} /> Script
          </Button>
        )}
        <DriveButton />
        <DocChangesButton />
        <History />
        <SyncState />
        <Button
          variant="primary"
          className="ml-1.5"
          onClick={onShare}
          title={exportState?.state === "running" && exportState.phase ? capitalize(exportState.phase) : exportState?.state === "queued" && exportState.waiting ? capitalize(exportState.waiting) : undefined}
        >
          {exportState?.state === "running" ? (
            <span className="tabular">{Math.round(exportState.progress * 100)}%</span>
          ) : (
            <Share size={14} strokeWidth={2.2} />
          )}
          Share
        </Button>
        <AppMenu />
      </div>
    </header>
  );
}

/** A cloud project’s sync as an icon only (its words are its tooltip): saved, syncing, offline, conflict, read-only. */
function SyncState() {
  const cloud = useEditor((state) => state.cloud);
  const label = syncLabel(cloud);
  if (!label) return null;
  const Icon = { ok: CloudCheck, busy: CloudSync, warn: label.text === "Read-only" ? Lock : CloudOff, bad: CloudAlert }[label.tone];
  const title = cloud?.missing ?? cloud?.message ?? (cloud?.sync === "readonly" ? `${cloud.holder} is editing` : cloud?.sync === "offline" ? "Changes are saved on this Mac and go to the cloud when it’s back" : label.text);
  return (
    <span
      role="status"
      aria-label={label.text}
      title={title}
      className={cx(
        "flex size-7 items-center justify-center rounded-md",
        label.tone === "ok" && "text-faint",
        label.tone === "busy" && "text-muted",
        label.tone === "warn" && "text-warning/80",
        label.tone === "bad" && "text-danger",
      )}
    >
      <Icon size={16} className={label.tone === "busy" ? "animate-pulse" : undefined} />
    </span>
  );
}

/** The edit’s export on the team’s Drive: its upload, then its link. */
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

/** Past this width the title stops growing and its tail is cut off. */
const NAME_MAX_PX = 480;

function NameField({ value }: { value: string }) {
  const [draft, setDraft] = useState(value);
  const [width, setWidth] = useState(120);
  const input = useRef<HTMLInputElement>(null);
  const edit = useEditor((state) => state.edit);
  useEffect(() => setDraft(value), [value]);
  // Fit the words, not a character count: `ch` overstates a proportional
  // font, so the field ran wide past its text. Measured, capped, and the
  // input scrolls its tail off past the cap until clicked into.
  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    const style = getComputedStyle(node);
    const canvas = document.createElement("canvas").getContext("2d");
    if (!canvas) return;
    canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const text = Math.ceil(canvas.measureText(draft || " ").width);
    setWidth(Math.min(NAME_MAX_PX, Math.max(56, text + 18)));
  }, [draft]);
  const commit = () => {
    const name = draft.trim();
    if (name && name !== value) edit((project) => void (project.name = name));
    else setDraft(value);
  };
  return (
    <input
      ref={input}
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
      className="h-8 min-w-0 shrink rounded-md bg-transparent px-1.5 text-[14px] font-medium text-fg outline-none hover:bg-hover focus:bg-hover"
      style={{ width, maxWidth: "38vw" }}
    />
  );
}

/** Undo and redo (⌘Z, ⇧⌘Z): every edit, in and out points, imports and the agent’s changes. */
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
