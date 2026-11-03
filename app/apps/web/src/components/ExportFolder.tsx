// The exports folder. Until someone saves one, the next export asks. Settings
// can change it later. The folder is on the Mac running Edit, so the picker is
// Edit's own file list (`/api/fs`), which works over Tailscale too.

import { ChevronRight, Folder, HardDrive } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { api, type ExportFolder as FolderChoice, type FsListing } from "../lib/api";
import { closeDialog, openDialog } from "../lib/dialogs";
import { folderDetail } from "../lib/export-face";
import { Button, cx, Modal } from "./ui";

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
  const crumbs = listing ? listing.path.split("/").filter(Boolean) : [];
  const dirs = listing?.entries.filter((entry) => entry.dir) ?? [];
  return (
    <div className="flex h-[520px] flex-col">
      <div className="px-6 pt-6 pb-4">
        <h2 className="text-[18px] font-semibold tracking-[-0.3px]">{ask ? "Where should exports go?" : "Exports folder"}</h2>
        <p className="mt-1 text-[13px] leading-normal text-muted">
          {ask
            ? "Pick a folder on this Mac. Exports go there from now on. You can change this in Settings."
            : "Exports on this Mac go in the folder you pick. One already exporting keeps the folder it started in."}
        </p>
      </div>
      <div className="flex min-h-0 flex-1 border-t border-line">
        <aside className="flex w-40 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line p-2">
          {listing?.places.map((place) => (
            <button
              key={place.path}
              type="button"
              onClick={() => go(place.path)}
              className={cx(
                "flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors",
                listing.path === place.path ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
              )}
            >
              {place.name === "Home" ? <HardDrive size={14} /> : <Folder size={14} />}
              <span className="min-w-0 flex-1 truncate">{place.name}</span>
            </button>
          ))}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-3 text-[12px] whitespace-nowrap text-muted">
            <button type="button" onClick={() => go("/")} className="rounded px-1 hover:text-fg">
              /
            </button>
            {crumbs.map((crumb, index) => (
              <span key={`${crumb}-${index}`} className="flex items-center">
                <ChevronRight size={12} className="text-faint" />
                <button
                  type="button"
                  onClick={() => go(`/${crumbs.slice(0, index + 1).join("/")}`)}
                  className={cx("rounded px-1", index === crumbs.length - 1 ? "text-fg" : "hover:text-fg")}
                >
                  {crumb}
                </button>
              </span>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {problem && <p className="px-2 py-1.5 text-[12px] text-danger">{problem}</p>}
            {listing && dirs.length === 0 && <p className="p-6 text-center text-[13px] text-muted">No folders in here. Exports can still go in this one.</p>}
            {dirs.map((entry) => (
              <button
                key={entry.path}
                type="button"
                onClick={() => go(entry.path)}
                className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-fg/90 transition-colors hover:bg-hover"
              >
                <Folder size={15} className="shrink-0 text-info" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
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
