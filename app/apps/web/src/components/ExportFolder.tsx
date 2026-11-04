// The exports folder. Until someone saves one, the next export asks. Settings
// can change it later. The folder is on the Mac running Edit, so the picker is
// Edit's own file list (`/api/fs`), which works over Tailscale too.

import { useEffect, useState } from "react";
import { create } from "zustand";

import { api, type ExportFolder as FolderChoice, type FsListing } from "../lib/api";
import { closeDialog, openDialog } from "../lib/dialogs";
import { folderDetail } from "../lib/export-face";
import { FolderBrowser } from "./FolderBrowser";
import { Button, DialogTitle, Modal } from "./ui";

const LATER = "edit.exportFolder.later";

interface Prompt {
  open: boolean;
  /** Ask: an export, and no folder is saved yet. Settings: they came to change it. */
  from: "ask" | "settings" | null;
  folder: FolderChoice | null;
}

export const useExportFolder = create<Prompt>(() => ({ open: false, from: null, folder: null }));

function readLater(): boolean {
  try {
    return sessionStorage.getItem(LATER) === "1";
  } catch {
    return false;
  }
}

function writeLater(): void {
  try {
    sessionStorage.setItem(LATER, "1");
  } catch {
    // Private browsing: the ask simply comes back on the next export.
  }
}

function forgetLater(): void {
  try {
    sessionStorage.removeItem(LATER);
  } catch {
    // As above.
  }
}

/** Loads the saved folder for Settings. Does not open the picker. */
export async function loadExportFolder(): Promise<void> {
  try {
    useExportFolder.setState({ folder: await api.exportFolder() });
  } catch {
    // The editor still works; Settings tries again when it's opened.
  }
}

/** Exports waiting on the picker. Answering (or leaving it) lets them go on. */
let waiting: (() => void)[] = [];

function settleAsk(): void {
  const pending = waiting;
  waiting = [];
  for (const done of pending) done();
}

/**
 * Before an export: ask where it should go, once, when no folder is saved yet.
 * Not now keeps the usual folder for this tab. A folder already saved, or a
 * server that doesn't answer, lets the export go straight on.
 */
export async function askExportFolder(): Promise<void> {
  if (readLater()) return;
  let folder: FolderChoice;
  try {
    folder = await api.exportFolder();
  } catch {
    return;
  }
  useExportFolder.setState({ folder });
  if (folder.chosen || readLater()) return;
  const state = useExportFolder.getState();
  if (!(state.open && state.from === "ask")) useExportFolder.setState({ open: true, from: "ask" });
  return new Promise((resolve) => {
    waiting.push(resolve);
  });
}

export function openExportFolder(from: "ask" | "settings"): void {
  if (from === "settings") closeDialog();
  useExportFolder.setState({ open: true, from });
}

export function closeExportFolder(): void {
  const from = useExportFolder.getState().from;
  useExportFolder.setState({ open: false, from: null });
  if (from === "settings") openDialog("settings");
  if (from === "ask") settleAsk();
}

/** Settings → Exports. The path, and Choose or Change. */
export function ExportsSettings() {
  const folder = useExportFolder((state) => state.folder);
  useEffect(() => {
    void loadExportFolder();
  }, []);
  return (
    <section className="flex flex-col">
      <h3 className="mb-2 text-[12px] font-medium text-muted">Exports</h3>
      <div className="flex flex-col rounded-[10px] border border-line bg-panel">
        <div className="flex min-h-[52px] items-center gap-3.5 px-3 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-[13px]">
            <span className="font-medium">Folder</span>
            <span className="text-[12px] leading-[1.45] break-all text-muted">{folder ? folderDetail(folder.chosen, folder.shown) : "Loading…"}</span>
          </div>
          <Button size="sm" variant="subtle" disabled={folder === null} onClick={() => openExportFolder("settings")}>
            {folder?.chosen ? "Change" : "Choose"}
          </Button>
        </div>
      </div>
    </section>
  );
}

/** The picker. An export opens it when no folder is saved yet; Settings opens it to change one. */
export function ExportFolderPrompt() {
  const open = useExportFolder((state) => state.open);
  const from = useExportFolder((state) => state.from);
  return (
    <Modal open={open} onClose={dismiss} width={640}>
      <Picker ask={from === "ask"} />
    </Modal>
  );
}

function dismiss(): void {
  if (useExportFolder.getState().from === "ask") writeLater();
  closeExportFolder();
}

function Picker({ ask }: { ask: boolean }) {
  const folder = useExportFolder((state) => state.folder);
  const [listing, setListing] = useState<FsListing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = (path?: string) => {
    setProblem(null);
    api
      .browse(path)
      .then((next) => setListing(next))
      .catch((error: Error) => {
        if (path !== undefined) return go();
        setProblem(error.message);
      });
  };
  useEffect(() => {
    const start = folder?.chosen ? folder.path : folder?.suggested;
    go(start);
    // The folder already loaded is the place to open. A later save closes this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const use = async (path: string) => {
    setBusy(true);
    setProblem(null);
    try {
      const saved = await api.setExportFolder(path);
      forgetLater();
      useExportFolder.setState({ folder: saved });
      closeExportFolder();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Couldn't use that folder");
      setBusy(false);
    }
  };
  const here = listing?.path ?? "";
  const elsewhere = folder !== null && here !== "" && here !== folder.suggested && here !== folder.path;
  return (
    <div className="flex h-[520px] flex-col">
      <div className="border-b border-line px-6 pt-6 pb-4">
        <DialogTitle
          title={ask ? "Where should exports go?" : "Exports folder"}
          detail={ask ? "Pick a folder on this Mac. Exports go there from now on. You can change this in Settings." : "Exports on this Mac go in the folder you pick. One already exporting keeps the folder it started in."}
        />
      </div>
      <FolderBrowser listing={listing} problem={problem} onGo={go} foldersOnly empty="No folders in here. Exports can still go in this one." />
      <div className="flex items-center gap-2 border-t border-line px-4 py-3">
        {elsewhere && folder && (
          <button type="button" className="min-w-0 truncate text-left text-[12px] text-muted hover:text-fg hover:underline" title={folder.suggested} disabled={busy} onClick={() => void use(folder.suggested)}>
            Use {folder.suggestedShown}
          </button>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="ghost" disabled={busy} onClick={dismiss}>
            {ask ? "Not now" : "Cancel"}
          </Button>
          <Button variant="primary" disabled={busy || here === ""} onClick={() => void use(here)}>
            {busy ? "Saving…" : "Use this folder"}
          </Button>
        </div>
      </div>
    </div>
  );
}
