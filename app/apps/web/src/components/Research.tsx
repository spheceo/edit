import { Check, ExternalLink, Images, Newspaper, Search, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, type FoundArticle, type FoundImage } from "../lib/api";
import { clientId, useEditor } from "../lib/store";
import { Button, cx, IconButton, Modal, Spinner } from "./ui";

type Tab = "new" | "kept" | "rejected" | "articles";

const TABS: { id: Tab; label: string }[] = [
  { id: "new", label: "To review" },
  { id: "kept", label: "Kept" },
  { id: "rejected", label: "Rejected" },
  { id: "articles", label: "Articles" },
];

/** The project’s found images, polled while anything might be adding to them. */
export function useResearch(projectId: string, fast: boolean) {
  const [items, setItems] = useState<FoundImage[]>([]);
  const [articles, setArticles] = useState<FoundArticle[]>([]);
  const [collecting, setCollecting] = useState(false);
  const refresh = useCallback(() => {
    api
      .research(projectId)
      .then((research) => {
        setItems(research.items);
        setArticles(research.articles);
        setCollecting(research.collecting);
      })
      .catch(() => {});
  }, [projectId]);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, collecting || fast ? 2000 : 6000);
    return () => clearInterval(timer);
  }, [refresh, collecting, fast]);
  return { items, setItems, articles, collecting, setCollecting, refresh };
}

const site = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** The media bin’s way in: a folder-like tile with how many found images wait for review. */
export function ResearchTile({ onOpen }: { onOpen: () => void }) {
  const project = useEditor((state) => state.project)!;
  const { items, collecting } = useResearch(project.id, false);
  const waiting = items.filter((item) => item.status === "new").length;
  return (
    <button onClick={onOpen} title="Review images found for this project" className="group block w-full text-left">
      <div className="relative flex aspect-video items-center justify-center rounded-lg bg-raised ring-1 ring-line transition-[box-shadow] group-hover:ring-line-strong">
        {collecting ? <Spinner /> : <Images size={22} strokeWidth={1.6} className="text-danger transition-transform duration-150 group-hover:scale-105" />}
        {waiting > 0 && (
          <span className="absolute top-1.5 right-1.5 rounded-full bg-playhead px-1.5 text-[10px] leading-4 font-semibold text-white tabular-nums">{waiting}</span>
        )}
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2 px-0.5 text-[12px] text-muted group-hover:text-fg">
        <span className="truncate">Research</span>
        <span className="shrink-0 font-mono text-[11px] text-faint tabular">{items.length}</span>
      </div>
    </button>
  );
}

/** Look through found images fast: arrows to move, K keep (into the media bin), X reject, Space to look closer. */
export function Research({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useEditor((state) => state.project)!;
  const toast = useEditor((state) => state.toast);
  const { items, setItems, articles, collecting, setCollecting, refresh } = useResearch(project.id, open);
  const [tab, setTab] = useState<Tab>("new");
  const [focus, setFocus] = useState(0);
  const [looking, setLooking] = useState(false);
  const [query, setQuery] = useState("");
  const grid = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => items.filter((item) => item.status === tab).reverse(), [items, tab]);
  const counts: Record<Tab, number> = useMemo(
    () => ({
      new: items.filter((item) => item.status === "new").length,
      kept: items.filter((item) => item.status === "kept").length,
      rejected: items.filter((item) => item.status === "rejected").length,
      articles: articles.length,
    }),
    [items, articles],
  );
  const current = shown[Math.min(focus, shown.length - 1)];

  useEffect(() => setFocus((index) => Math.max(0, Math.min(index, shown.length - 1))), [shown.length]);
  useEffect(() => {
    grid.current?.querySelector(`[data-index="${focus}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focus, tab]);

  const review = useCallback(
    async (item: FoundImage, status: FoundImage["status"]) => {
      // Optimistic: the next image is up at once.
      setItems((all) => all.map((other) => (other.id === item.id ? { ...other, status } : other)));
      try {
        const result = await api.reviewResearch(project.id, item.id, status, clientId);
        useEditor.getState().adopt(result.rev, result.project);
        setItems((all) => all.map((other) => (other.id === item.id ? result.item : other)));
      } catch (error) {
        toast((error as Error).message, "error");
        refresh();
      }
    },
    [project.id, refresh, setItems, toast],
  );

  const collect = async () => {
    const queries = query
      .split(/\n|;/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (!queries.length) return;
    try {
      await api.collectResearch(project.id, queries, 40);
      setCollecting(true);
      setQuery("");
      toast(`Searching images for ${queries.map((part) => `“${part}”`).join(", ")}…`);
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };

  // The desktop app’s webview has no window.confirm, so the bin asks for a second click.
  const [armed, setArmed] = useState<"new" | "rejected" | null>(null);
  useEffect(() => {
    if (!armed) return;
    const timeout = setTimeout(() => setArmed(null), 3000);
    return () => clearTimeout(timeout);
  }, [armed]);

  const clear = async (status: "new" | "rejected") => {
    if (armed !== status) {
      const what = status === "new" ? `the ${counts.new} images waiting for review` : `the ${counts.rejected} rejected images`;
      setArmed(status);
      toast(`Click the bin again to delete ${what}. Kept ones stay.`);
      return;
    }
    setArmed(null);
    try {
      const { removed } = await api.clearResearch(project.id, status);
      toast(`Deleted ${removed} ${status === "new" ? "unreviewed" : "rejected"} images`);
      refresh();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };


  useEffect(() => {
    if (!open || tab === "articles") return;
    const columns = () => {
      const tiles = grid.current?.querySelectorAll("[data-index]");
      if (!tiles || tiles.length < 2) return 1;
      const top = (tiles[0] as HTMLElement).offsetTop;
      return [...tiles].findIndex((tile) => (tile as HTMLElement).offsetTop !== top) || tiles.length;
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      const move = (by: number) => {
        event.preventDefault();
        setFocus((index) => Math.max(0, Math.min(shown.length - 1, index + by)));
      };
      switch (event.key) {
        case "ArrowRight":
          return move(1);
        case "ArrowLeft":
          return move(-1);
        case "ArrowDown":
          return move(looking ? 1 : columns());
        case "ArrowUp":
          return move(looking ? -1 : -columns());
        case " ":
        case "Enter":
          event.preventDefault();
          return setLooking((value) => !value);
        case "k":
        case "K":
          if (current) review(current, current.status === "kept" ? "new" : "kept");
          return;
        case "x":
        case "X":
        case "Backspace":
          if (current) review(current, current.status === "rejected" ? "new" : "rejected");
          return;
        case "Escape":
          if (looking) {
            event.stopPropagation();
            setLooking(false);
          }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, tab, shown.length, current, looking, review]);

  const imageUrl = (item: FoundImage) => `/api/projects/${project.id}/research/${item.id}/image`;

  return (
    <Modal open={open} onClose={onClose} width={Math.min(1320, window.innerWidth - 64)}>
      <div className="flex h-[86vh] flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
          <div className="flex items-center gap-2 font-medium">
            <Images size={15} /> Research
          </div>
          <div className="flex gap-1">
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => {
                  setTab(id);
                  setFocus(0);
                }}
                className={cx(
                  "h-7 rounded-md px-2.5 text-[12px] font-medium transition-colors",
                  tab === id ? "bg-active text-fg" : "text-muted hover:text-fg",
                )}
              >
                {label} <span className="text-faint tabular-nums">{counts[id]}</span>
              </button>
            ))}
          </div>
          <form
            className="ml-auto flex min-w-0 flex-1 items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void collect();
            }}
          >
            <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg bg-raised px-2.5 ring-1 ring-line focus-within:ring-line-strong">
              <Search size={13} className="shrink-0 text-faint" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find more images (separate searches with ;)"
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
              />
            </div>
            <Button size="sm" type="submit" disabled={collecting || !query.trim()}>
              {collecting ? <Spinner /> : "Search"}
            </Button>
          </form>
          {(tab === "new" || tab === "rejected") && counts[tab] > 0 && (
            <IconButton
              label={armed === tab ? "Click again to delete" : tab === "new" ? "Delete all images waiting for review" : "Delete all rejected images"}
              className={armed === tab ? "bg-danger-soft text-danger hover:bg-danger-soft hover:text-danger" : undefined}
              onClick={() => void clear(tab)}
            >
              <Trash2 size={14} />
            </IconButton>
          )}
          <IconButton label="Close" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </header>
        <div className="relative min-h-0 flex-1">
          {tab === "articles" ? (
            <Articles articles={articles} />
          ) : (
          <div ref={grid} className="h-full overflow-y-auto p-3">
            {shown.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-muted">
                {collecting ? <Spinner /> : <Images size={22} className="text-faint" />}
                {collecting
                  ? "Searching and downloading…"
                  : tab === "new"
                    ? "Nothing to review. Search above, or ask the agent to collect images for this case."
                    : `No ${tab} images yet.`}
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2.5">
                {shown.map((item, index) => (
                  <Tile
                    key={item.id}
                    item={item}
                    index={index}
                    src={imageUrl(item)}
                    focused={index === focus}
                    onFocus={() => setFocus(index)}
                    onLook={() => {
                      setFocus(index);
                      setLooking(true);
                    }}
                    onReview={(status) => review(item, status)}
                  />
                ))}
              </div>
            )}
          </div>
          )}
          <AnimatePresence>
            {looking && current && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12 }}
                className="absolute inset-0 flex flex-col bg-black/95"
                onClick={() => setLooking(false)}
              >
                <div className="flex min-h-0 flex-1 items-center justify-center p-4">
                  <img src={imageUrl(current)} alt={current.title} className="max-h-full max-w-full rounded-md object-contain" />
                </div>
                <div className="flex shrink-0 items-center gap-3 border-t border-line px-4 py-3" onClick={(event) => event.stopPropagation()}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{current.title || "Untitled"}</div>
                    <a href={current.page} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-fg">
                      {site(current.page)} <ExternalLink size={11} />
                    </a>
                    <span className="ml-3 text-[12px] text-faint tabular-nums">
                      {current.width}×{current.height} · “{current.query}”
                    </span>
                  </div>
                  <ReviewButtons item={current} onReview={(status) => review(current, status)} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <footer className="shrink-0 border-t border-line px-4 py-2 text-[11px] text-faint">
          ← → ↑ ↓ move · <b className="text-muted">K</b> keep (adds it to the media bin) · <b className="text-muted">X</b> reject · <b className="text-muted">Space</b> look closer ·
          Found privately from this machine; check you can use an image before you publish it.
        </footer>
      </div>
    </Modal>
  );
}

/** The case’s news coverage, saved by research: a list beside a reader. */
function Articles({ articles }: { articles: FoundArticle[] }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const article = articles.find((candidate) => candidate.id === chosen) ?? articles[0];
  if (!article) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-muted">
        <Newspaper size={22} className="text-faint" />
        No articles yet. Ask the agent to research the case.
      </div>
    );
  }
  const date = (value?: string) => {
    const time = value ? Date.parse(value) : NaN;
    return Number.isNaN(time) ? value : new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  };
  return (
    <div className="flex h-full">
      <div className="w-80 shrink-0 overflow-y-auto border-r border-line p-2">
        {articles.map((candidate) => (
          <button
            key={candidate.id}
            onClick={() => setChosen(candidate.id)}
            className={cx(
              "mb-1 block w-full rounded-lg p-2.5 text-left transition-colors",
              candidate.id === article.id ? "bg-active" : "hover:bg-hover",
            )}
          >
            <div className="line-clamp-2 text-[13px] font-medium">{candidate.title || candidate.url}</div>
            <div className="mt-0.5 text-[11px] text-muted">
              {candidate.outlet}
              {candidate.published ? ` · ${date(candidate.published)}` : ""}
            </div>
          </button>
        ))}
      </div>
      <article className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-[68ch]">
          <div className="text-[12px] text-muted">
            {article.outlet}
            {article.published ? ` · ${date(article.published)}` : ""}
          </div>
          <h2 className="mt-1 text-[20px] leading-snug font-semibold">{article.title}</h2>
          <a href={article.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[12px] text-muted hover:text-fg">
            Open the original <ExternalLink size={11} />
          </a>
          {article.summary && (
            <p className="mt-4 rounded-lg border border-line bg-raised px-3.5 py-3 text-[13px] leading-relaxed">
              <span className="font-medium">What it adds: </span>
              {article.summary}
            </p>
          )}
          <p className="mt-5 text-[14px] leading-7 whitespace-pre-line text-fg/85">{article.text}</p>
        </div>
      </article>
    </div>
  );
}

function ReviewButtons({ item, onReview }: { item: FoundImage; onReview: (status: FoundImage["status"]) => void }) {
  return (
    <div className="flex shrink-0 gap-1.5">
      <Button size="sm" variant={item.status === "rejected" ? "primary" : "subtle"} onClick={() => onReview(item.status === "rejected" ? "new" : "rejected")}>
        <X size={13} /> {item.status === "rejected" ? "Rejected" : "Reject"}
      </Button>
      <Button size="sm" variant={item.status === "kept" ? "primary" : "subtle"} onClick={() => onReview(item.status === "kept" ? "new" : "kept")}>
        <Check size={13} /> {item.status === "kept" ? "Kept" : "Keep"}
      </Button>
    </div>
  );
}

function Tile({
  item,
  index,
  src,
  focused,
  onFocus,
  onLook,
  onReview,
}: {
  item: FoundImage;
  index: number;
  src: string;
  focused: boolean;
  onFocus: () => void;
  onLook: () => void;
  onReview: (status: FoundImage["status"]) => void;
}) {
  return (
    <div
      data-index={index}
      onClick={onFocus}
      onDoubleClick={onLook}
      className={cx(
        "group relative aspect-[4/3] cursor-pointer overflow-hidden rounded-lg bg-raised ring-2 transition-shadow",
        focused ? "ring-playhead" : "ring-transparent hover:ring-line-strong",
      )}
    >
      <img src={src} alt={item.title} loading="lazy" className="h-full w-full object-cover" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-2 pt-6 pb-1.5">
        <div className="truncate text-[12px] font-medium text-white">{item.title || "Untitled"}</div>
        <div className="truncate text-[11px] text-white/60">
          {site(item.page)} · {item.width}×{item.height}
        </div>
      </div>
      <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          title="Reject (X)"
          onClick={(event) => {
            event.stopPropagation();
            onReview(item.status === "rejected" ? "new" : "rejected");
          }}
          className="flex size-7 items-center justify-center rounded-md bg-black/70 text-white hover:bg-black"
        >
          <X size={14} />
        </button>
        <button
          title="Keep (K)"
          onClick={(event) => {
            event.stopPropagation();
            onReview(item.status === "kept" ? "new" : "kept");
          }}
          className="flex size-7 items-center justify-center rounded-md bg-black/70 text-white hover:bg-success"
        >
          <Check size={14} />
        </button>
      </div>
    </div>
  );
}
