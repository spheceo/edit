import { AudioLines, ChevronRight, Music, Plus, RefreshCw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";

import { api, type LibrarySound } from "../lib/api";
import { CLIP_HEX } from "../lib/colors";
import { readSetting, writeSetting } from "../lib/storage";
import { clientId, useEditor } from "../lib/store";
import { cx, IconButton, Spinner } from "./ui";

const STORAGE = "edit.library.closed";

/** One read per page load; the refresh button reads Drive again. */
let cached: Promise<LibrarySound[]> | null = null;

/** The team’s sound library (a Google Drive folder): adding a sound downloads it into the media bin. */
export function Library() {
  const [sounds, setSounds] = useState<LibrarySound[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [closed, setClosed] = useState<string[]>(() => {
    try {
      return JSON.parse(readSetting(STORAGE) ?? "[]");
    } catch {
      return [];
    }
  });

  const load = (refresh = false) => {
    if (refresh || !cached) cached = api.library(refresh).then((library) => library.sounds);
    const request = cached;
    setLoading(true);
    request
      .then((sounds) => {
        setSounds(sounds);
        setError("");
      })
      .catch((error: Error) => {
        if (cached === request) cached = null;
        setError(error.message);
      })
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const folders = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    const found = (sounds ?? []).filter((sound) => {
      const text = `${sound.category} ${sound.name} ${sound.note ?? ""}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
    const folders = new Map<string, LibrarySound[]>();
    for (const sound of found) {
      const key = `${sound.kind === "music" ? "Music" : "Sound effects"} / ${sound.category}`;
      folders.set(key, [...(folders.get(key) ?? []), sound]);
    }
    return [...folders];
  }, [sounds, search]);

  const toggle = (id: string) => {
    const next = closed.includes(id) ? closed.filter((folder) => folder !== id) : [...closed, id];
    writeSetting(STORAGE, JSON.stringify(next));
    setClosed(next);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1 pb-1">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search the library"
          className="h-7 min-w-0 flex-1 rounded-md bg-raised px-2 text-[12px] ring-1 ring-line outline-none placeholder:text-faint focus:ring-line-strong"
        />
        <IconButton label="Read Drive again" onClick={() => load(true)} disabled={loading}>
          {loading ? <Spinner /> : <RefreshCw size={13} />}
        </IconButton>
      </div>
      {error && <p className="px-1.5 text-[12px] text-danger">{error}</p>}
      {!sounds && !error && <p className="px-1.5 text-[12px] text-muted">Reading the library from Drive…</p>}
      {folders.map(([folder, sounds]) => {
        const open = search !== "" || !closed.includes(folder);
        return (
          <div key={folder}>
            <button
              onClick={() => toggle(folder)}
              className="flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-[12px] font-medium text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <ChevronRight size={13} className={`shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
              <span className="truncate">{folder}</span>
              <span className="ml-auto text-[11px] text-faint tabular-nums">{sounds.length}</span>
            </button>
            <AnimatePresence initial={false}>
              {open && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
                  className="overflow-hidden"
                >
                  <div className="flex flex-col gap-0.5 pt-0.5 pb-1.5 pl-3">
                    {sounds.map((sound) => (
                      <SoundRow key={sound.id} sound={sound} />
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}

function SoundRow({ sound }: { sound: LibrarySound }) {
  const [busy, setBusy] = useState(false);
  const toast = useEditor((state) => state.toast);
  const add = async () => {
    const project = useEditor.getState().project;
    if (!project || busy) return;
    setBusy(true);
    try {
      const result = await api.importLibrary(project.id, sound.id, clientId);
      useEditor.getState().adopt(result.rev, result.project);
      toast(`${sound.name} is in the media bin`);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const megabytes = sound.bytes / 1e6;
  return (
    <button
      onClick={() => void add()}
      title={`Add to the media bin (${megabytes < 1 ? "<1" : Math.round(megabytes)} MB)`}
      className="group flex items-center gap-2.5 rounded-lg p-1 text-left transition-colors hover:bg-hover"
    >
      <span
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-raised ring-1 ring-line transition-colors group-hover:bg-active"
        style={{ color: sound.kind === "music" ? CLIP_HEX.green : CLIP_HEX.yellow }}
      >
        {sound.kind === "music" ? <Music size={14} /> : <AudioLines size={14} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{sound.name}</span>
        {sound.note && <span className="block truncate text-[11px] text-muted">{sound.note}</span>}
      </span>
      <span className={cx("shrink-0 pr-1 text-muted", busy ? "opacity-100" : "opacity-0 group-hover:opacity-100")}>
        {busy ? <Spinner /> : <Plus size={14} />}
      </span>
    </button>
  );
}
