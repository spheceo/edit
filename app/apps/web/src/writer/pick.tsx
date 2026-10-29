// "Choose a file on this Mac…": the Mac running Edit's folders, read through
// Edit's /api/fs (the page may be on another machine over Tailscale, so the
// browser's own picker can't give a path there). Resolves to the path picked,
// or null when the dialog is closed.

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { api, type FsListing } from "../lib/api";
import { message } from "./api";
import { portalRoot } from "./portal";
import { Dialog, Icon } from "./ui";

export interface PickOptions {
  multiple?: false;
  filters?: { name: string; extensions: string[] }[];
}

export function pickFile(options: PickOptions = {}): Promise<string | null> {
  const extensions = (options.filters ?? []).flatMap((filter) => filter.extensions);
  const host = document.createElement("div");
  portalRoot().append(host);
  const root = createRoot(host);
  return new Promise((resolve) => {
    const done = (path: string | null) => {
      root.unmount();
      host.remove();
      resolve(path);
    };
    root.render(<Picker title={options.filters?.[0]?.name ? `Choose a ${options.filters[0].name.toLowerCase()} file` : "Choose a file"} extensions={extensions} onDone={done} />);
  });
}

function Picker({ title, extensions, onDone }: { title: string; extensions: string[]; onDone: (path: string | null) => void }) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const go = (path?: string) =>
    api
      .browse(path, extensions)
      .then((next) => {
        setListing(next);
        setProblem(null);
        localStorage.setItem("writer.pickFolder", next.path);
      })
      .catch((cause) => setProblem(message(cause)));
  useEffect(() => {
    void go(localStorage.getItem("writer.pickFolder") ?? undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const close = (path: string | null) => {
    setOpen(false);
    window.setTimeout(() => onDone(path), 150);
  };
  return (
    <Dialog open={open} onClose={() => close(null)} title={title} description={listing?.path} width={560}>
      <div className="file-picker">
        <div className="file-picker-places">
          {listing?.parent && (
            <button type="button" className="ghost sm" onClick={() => void go(listing.parent ?? undefined)}>
              <Icon name="back" size={14} /> Up
            </button>
          )}
          {listing?.places.map((place) => (
            <button key={place.path} type="button" className={listing.path === place.path ? "ghost sm on" : "ghost sm"} onClick={() => void go(place.path)}>
              {place.name}
            </button>
          ))}
        </div>
        {problem && <p className="bad">{problem}</p>}
        <div className="file-picker-list">
          {listing?.entries.length === 0 && <p className="faint">Nothing to choose here.</p>}
          {listing?.entries.map((entry) => (
            <button key={entry.path} type="button" className="file-picker-row" onClick={() => (entry.dir ? void go(entry.path) : close(entry.path))}>
              <Icon name={entry.dir ? "folder" : "file"} size={14} />
              <span>{entry.name}</span>
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
