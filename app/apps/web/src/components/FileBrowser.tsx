import { readSetting, writeSetting } from "../lib/storage";
import { useEffect, useState } from "react";

import { api, useMachine, type FsListing } from "../lib/api";
import { useEditor, clientId } from "../lib/store";
import { FolderBrowser } from "./FolderBrowser";
import { Button, Modal, Spinner } from "./ui";

/** Picks files on the machine running Edit (works the same over Tailscale). */
export function FileBrowser({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [place, setPlace] = useState(true);
  const [busy, setBusy] = useState(false);
  const [driveLink, setDriveLink] = useState("");
  const machine = useMachine();

  const go = (path?: string) =>
    api
      .browse(path ?? (readSetting("edit.lastFolder") || undefined))
      .then((next) => {
        setListing(next);
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

  const importPaths = async (paths: string[]) => {
    const project = useEditor.getState().project;
    if (!project || paths.length === 0 || busy) return;
    setBusy(true);
    try {
      const result = await api.importMedia(project.id, paths, place, clientId);
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

  return (
    <Modal open={open} onClose={onClose} width={720}>
      <div className="flex h-[520px] flex-col">
        <FolderBrowser
          listing={listing}
          onGo={(path) => void go(path)}
          heading={`On ${machine}`}
          empty="No folders or media here"
          picked={picked}
          onPick={(entry, adding) => setPicked((current) => (adding || current.length > 0 ? (current.includes(entry.path) ? current.filter((path) => path !== entry.path) : [...current, entry.path]) : [entry.path]))}
          onChoose={(entry) => void importPaths([entry.path])}
          side={
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
                className="h-7 w-full min-w-0 rounded-md bg-raised px-2 text-[12px] text-fg ring-1 ring-line outline-none focus:ring-line-strong"
              />
              <Button size="sm" variant="subtle" disabled={!driveLink.trim() || busy} type="submit">
                {busy ? <Spinner /> : null}
                Download and import
              </Button>
            </form>
          }
        />
        <div className="flex h-14 shrink-0 items-center gap-3 border-t border-line px-4">
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted">
            <input type="checkbox" checked={place} onChange={(event) => setPlace(event.target.checked)} className="accent-white" />
            Add to the end of the timeline
          </label>
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!picked.length || busy} onClick={() => void importPaths(picked)}>
              {busy ? <Spinner /> : null}
              Import{picked.length > 1 ? ` ${picked.length}` : ""}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
