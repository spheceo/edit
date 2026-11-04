// Settings → Storage (Sphe, Nov 4: "an edit content manager … we scour exports
// we think are related to edit and place them there so you can choose to
// delete them to clear more storage"). Every export file Edit knows of on this
// Mac (local_files.ts: its exports list, and any other video in its export
// folders), largest first, to pick and delete. One in use can't be; one kept
// in the cloud too is said, so deleting it frees the Mac and loses nothing.

import { Check, FolderSearch } from "lucide-react";
import { useEffect, useState } from "react";

import { api, type StoredExport } from "../lib/api";
import { onThisMac, showInFinder } from "../lib/files";
import { useEditor } from "../lib/store";
import { ago, formatBytes } from "../lib/time";
import { Badge, Button, ConfirmDialog, cx, DialogTitle, IconButton, Modal, Spinner } from "./ui";

/** The Settings row: how much the exports take, and the way into the list. */
export function StorageSettings() {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<{ bytes: number; files: number; free: number | null } | null>(null);
  const load = () =>
    api.storedExports().then(
      ({ exports, free }) => setSummary({ bytes: exports.reduce((sum, one) => sum + one.bytes, 0), files: exports.length, free }),
      () => setSummary(null),
    );
  useEffect(() => {
    void load();
  }, []);
  // From another device the files are on the Mac running Edit, not this one.
  if (!onThisMac()) return null;
  return (
    <section className="flex flex-col">
      <h3 className="mb-2 text-[12px] font-medium text-muted">Storage</h3>
      <div className="flex min-h-[52px] items-center gap-3.5 rounded-[10px] border border-line bg-panel px-3 py-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-[13px]">
          <span className="font-medium">Exports on this Mac</span>
          <span className="text-[12px] leading-[1.45] text-muted">
            {summary === null ? "Looking…" : summary.files === 0 ? "None." : `${summary.files} ${summary.files === 1 ? "file" : "files"}, ${formatBytes(summary.bytes)}`}
            {summary?.free != null && ` · ${formatBytes(summary.free)} free on the disk`}
          </span>
        </div>
        <Button size="sm" variant="subtle" disabled={summary === null || summary.files === 0} onClick={() => setOpen(true)}>
          Manage
        </Button>
      </div>
      <Modal open={open} onClose={() => setOpen(false)} width={680}>
        <ExportFiles
          onClose={() => {
            setOpen(false);
            void load();
          }}
        />
      </Modal>
    </section>
  );
}

function ExportFiles({ onClose }: { onClose: () => void }) {
  const [files, setFiles] = useState<StoredExport[] | null>(null);
  const [free, setFree] = useState<number | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useEditor((state) => state.toast);
  const load = () =>
    api.storedExports().then(
      ({ exports, free }) => {
        setFiles(exports);
        setFree(free);
        setPicked((was) => new Set([...was].filter((path) => exports.some((one) => one.path === path && !one.busy))));
      },
      (error: unknown) => useEditor.getState().toastError(error, "list the exports"),
    );
  useEffect(() => {
    void load();
  }, []);
  const chosen = (files ?? []).filter((one) => picked.has(one.path));
  const bytes = chosen.reduce((sum, one) => sum + one.bytes, 0);
  const toggle = (one: StoredExport) =>
    setPicked((was) => {
      const next = new Set(was);
      if (next.has(one.path)) next.delete(one.path);
      else next.add(one.path);
      return next;
    });
  // The quick pick: everything but each project's newest (a re-export copies from it) and what's in use.
  const older = (files ?? []).filter((one) => !one.newest && !one.busy);
  const remove = async () => {
    setBusy(true);
    try {
      const done = await api.deleteStored(chosen.map((one) => one.path));
      if (done.files > 0) toast(`Deleted ${done.files} ${done.files === 1 ? "export" : "exports"}, ${formatBytes(done.bytes)} freed`, "info");
      if (done.refused.length > 0) useEditor.getState().toastError(new Error(done.refused.join(" · ")), "delete some of them");
      setPicked(new Set());
      await load();
    } finally {
      setBusy(false);
      setAsking(false);
    }
  };
  return (
    <div className="flex h-[min(620px,calc(100vh-48px))] flex-col">
      <div className="border-b border-line px-6 pt-6 pb-4">
        <DialogTitle
          title="Exports on this Mac"
          detail={`Every export Edit made here, and any other video in its export folders, largest first.${free !== null ? ` ${formatBytes(free)} free on the disk.` : ""} One kept in the cloud too comes back down when it's shared or saved again.`}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {files === null ? (
          <div className="flex h-full items-center justify-center">
            <Spinner size={18} />
          </div>
        ) : files.length === 0 ? (
          <p className="p-8 text-center text-[13px] text-muted">No exports on this Mac.</p>
        ) : (
          files.map((one) => {
            const on = picked.has(one.path);
            return (
              <div
                key={one.path}
                role="checkbox"
                aria-checked={on}
                aria-disabled={one.busy}
                tabIndex={one.busy ? -1 : 0}
                onClick={() => !one.busy && toggle(one)}
                onKeyDown={(event) => event.key === " " && !one.busy && (event.preventDefault(), toggle(one))}
                className={cx("group flex min-h-12 items-center gap-3 rounded-lg px-2.5 py-2 transition-colors", one.busy ? "opacity-60" : "hover:bg-hover", on && "bg-active hover:bg-active")}
              >
                <span className={cx("flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors", on ? "border-fg bg-fg text-bg" : "border-line-strong")}>{on && <Check size={11} strokeWidth={3} />}</span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
                    <span className="truncate">{one.projectName ?? one.name}</span>
                    {one.newest && <Badge title="A re-export copies its unchanged parts from the newest">Newest</Badge>}
                    {one.inCloud && <Badge title="A copy is in the cloud: deleting this one frees the Mac">In the cloud</Badge>}
                    {one.busy && <Badge>In use</Badge>}
                    {one.project === null && <Badge title="In Edit's export folder, but not on Edit's list">Not listed</Badge>}
                  </span>
                  <span className="truncate text-[11.5px] text-faint" title={one.path}>
                    {one.shown} · {ago(one.at)}
                  </span>
                </div>
                <span className="shrink-0 text-[12px] text-secondary tabular">{formatBytes(one.bytes)}</span>
                <IconButton
                  label="Show in Finder"
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    showInFinder(one.path);
                  }}
                >
                  <FolderSearch size={14} />
                </IconButton>
              </div>
            );
          })
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-line px-4 py-3">
        {older.length > 0 && (
          <button type="button" className="text-[12px] text-muted hover:text-fg hover:underline" onClick={() => setPicked(new Set(older.map((one) => one.path)))}>
            Pick all but each project's newest
          </button>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
          <Button variant="destructive" disabled={chosen.length === 0 || busy} onClick={() => setAsking(true)}>
            {chosen.length === 0 ? "Delete" : `Delete ${chosen.length} · ${formatBytes(bytes)}`}
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        title={`Delete ${chosen.length} ${chosen.length === 1 ? "export" : "exports"}?`}
        detail={`${formatBytes(bytes)} goes from this Mac. ${chosen.some((one) => !one.inCloud) ? "Those not kept in the cloud are gone for good; a review link that shared one still plays it." : "Each is kept in the cloud, so nothing is lost."}`}
        confirm="Delete"
        busy={busy}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
