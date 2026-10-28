import { readSetting, writeSetting } from "../lib/storage";
import { AudioLines, ChevronRight, Film, Folder, HardDrive } from "lucide-react";
import { useEffect, useState } from "react";

import { api, useMachine, type FsListing } from "../lib/api";
import { useEditor, clientId } from "../lib/store";
import { Button, cx, Modal, Spinner } from "./ui";

const AUDIO = /\.(wav|mp3|m4a|aac|flac|aif|aiff|ogg|opus)$/i;

function formatSize(bytes: number) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** Picks files on the machine running Edit (works the same over Tailscale). */
export function FileBrowser({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [place, setPlace] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [driveLink, setDriveLink] = useState("");
  const machine = useMachine();

  const go = (path?: string) =>
    api
      .browse(path ?? (readSetting("edit.lastFolder") || undefined))
      .then((next) => {
        setListing(next);
        setPathInput(next.path);
        writeSetting("edit.lastFolder", next.path);
      })
      .catch((error) => {
        if (!path) return api.browse().then(setListing);
        useEditor.getState().toastError(error, "open that folder");
      });

  useEffect(() => {
    if (open) {
      setPicked([]);
      void go();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const importPicked = async () => {
    const project = useEditor.getState().project;
    if (!project || !picked.length) return;
    setBusy(true);
    try {
      const result = await api.importMedia(project.id, picked, place, clientId);
      useEditor.getState().adopt(result.rev, result.project);
      for (const error of result.errors) useEditor.getState().toastError(error, "import a file");
      onClose();
    } catch (error) {
      useEditor.getState().toastError(error, "import it");
    } finally {
      setBusy(false);
    }
  };

  // A Drive folder’s videos (or one file): downloaded on the machine running Edit, then imported.
  const importDrive = async () => {
    const project = useEditor.getState().project;
    if (!project || !driveLink.trim()) return;
    setBusy(true);
    try {
      const result = await api.importDrive(project.id, driveLink.trim(), place, clientId);
      useEditor.getState().adopt(result.rev, result.project);
      for (const error of result.errors) useEditor.getState().toastError(error, "import a file");
      setDriveLink("");
      onClose();
    } catch (error) {
      useEditor.getState().toastError(error, "import it");
    } finally {
      setBusy(false);
    }
  };

  const crumbs = listing ? listing.path.split("/").filter(Boolean) : [];

  return (
    <Modal open={open} onClose={onClose} width={720}>
      <div className="flex h-[520px]">
        <aside className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-line p-2">
          <div className="px-2 pt-1 pb-2 text-[13px] font-medium text-muted">On {machine}</div>
          {listing?.places.map((place) => (
            <button
              key={place.path}
              onClick={() => void go(place.path)}
              className={cx(
                "flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors",
                listing.path === place.path ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
              )}
            >
              {place.name === "Home" ? <HardDrive size={14} /> : <Folder size={14} />}
              {place.name}
            </button>
          ))}
          <form
            className="mt-auto flex flex-col gap-1.5 border-t border-line px-1 pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              void importDrive();
            }}
          >
            <label htmlFor="edit-drive-link" className="px-1 text-[13px] font-medium text-muted">
              From Google Drive
            </label>
            <input
              id="edit-drive-link"
              value={driveLink}
              onChange={(event) => setDriveLink(event.target.value)}
              placeholder="Folder or file link"
              spellCheck={false}
              className="h-7 w-full min-w-0 rounded-md bg-raised px-2 text-[12px] text-fg outline-none ring-1 ring-line focus:ring-line-strong"
            />
            <Button size="sm" variant="subtle" disabled={!driveLink.trim() || busy} type="submit">
              {busy ? <Spinner /> : null}
              Download and import
            </Button>
          </form>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-1 overflow-hidden border-b border-line px-3">
            <form
              className="min-w-0 flex-1"
              onSubmit={(event) => {
                event.preventDefault();
                void go(pathInput);
              }}
            >
              <div className="flex items-center gap-0.5 overflow-x-auto text-[12px] whitespace-nowrap text-muted">
                <button type="button" onClick={() => void go("/")} className="rounded px-1 hover:text-fg">
                  /
                </button>
                {crumbs.map((crumb, index) => (
                  <span key={index} className="flex items-center">
                    <ChevronRight size={12} className="text-faint" />
                    <button
                      type="button"
                      onClick={() => void go(`/${crumbs.slice(0, index + 1).join("/")}`)}
                      className={cx("rounded px-1", index === crumbs.length - 1 ? "text-fg" : "hover:text-fg")}
                    >
                      {crumb}
                    </button>
                  </span>
                ))}
              </div>
            </form>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {!listing && (
              <div className="flex h-full items-center justify-center text-muted">
                <Spinner />
              </div>
            )}
            {listing && listing.entries.length === 0 && <div className="p-6 text-center text-muted">No folders or media here</div>}
            {listing?.entries.map((entry) => {
              const isPicked = picked.includes(entry.path);
              return (
                <button
                  key={entry.path}
                  onClick={(event) => {
                    if (entry.dir) return void go(entry.path);
                    setPicked((current) =>
                      event.metaKey || event.shiftKey || event.ctrlKey || current.length
                        ? isPicked
                          ? current.filter((path) => path !== entry.path)
                          : [...current, entry.path]
                        : [entry.path],
                    );
                  }}
                  onDoubleClick={() => {
                    if (!entry.dir) {
                      setPicked([entry.path]);
                      setTimeout(() => document.getElementById("edit-import-button")?.click());
                    }
                  }}
                  className={cx(
                    "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors",
                    isPicked ? "bg-white/10 text-fg" : "text-fg/90 hover:bg-hover",
                  )}
                >
                  {entry.dir ? (
                    <Folder size={15} className="shrink-0 text-info" />
                  ) : AUDIO.test(entry.name) ? (
                    <AudioLines size={15} className="shrink-0 text-success" />
                  ) : (
                    <Film size={15} className="shrink-0 text-pink-300" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {!entry.dir && <span className="shrink-0 text-[11px] text-faint tabular">{formatSize(entry.size)}</span>}
                  {isPicked && <span className="size-1.5 shrink-0 rounded-full bg-white" />}
                </button>
              );
            })}
          </div>
          <div className="flex h-14 shrink-0 items-center gap-3 border-t border-line px-4">
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted">
              <input type="checkbox" checked={place} onChange={(event) => setPlace(event.target.checked)} className="accent-white" />
              Add to the end of the timeline
            </label>
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button id="edit-import-button" variant="primary" disabled={!picked.length || busy} onClick={() => void importPicked()}>
                {busy ? <Spinner /> : null}
                Import{picked.length > 1 ? ` ${picked.length}` : ""}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
