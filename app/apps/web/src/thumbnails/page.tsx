// A thumbnail's page: the thumbnail big in the middle (drawn by the same code
// Claude's looks use), its versions side by side under it once it has more
// than one, the conversation with Claude on the right. The page has no
// controls of its own (Sphe, Nov 4: "give more of that to the agents on the
// right and then have the user just chat with it"): no layers, pictures or
// sliders; every change is asked of Claude. Pictures dropped or pasted
// anywhere go to Claude with the next message.

import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Check, ChevronDown, Download, Image as ImageIcon, MessageSquare, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ChatShell, ChatTurns, Empty, useChatTurns, useSentNow } from "../components/AgentPanel";
import { ChatComposer } from "../components/ChatComposer";
import { ChatDock } from "../components/ChatDock";
import { attachFiles, picturesOnly, postFile, type Uploader } from "../lib/chatFiles";
import { AppMenu } from "../components/AppMenu";
import { toggleMenu } from "../components/ContextMenu";
import { Button, cx, IconButton, spring } from "../components/ui";
import { conversationEntries, thumbActivity } from "../lib/agentTurns";
import { saveFile } from "../lib/files";
import { useAccount } from "../lib/account";
import { navigate } from "../lib/route";
import { ago } from "../lib/time";
import { useEditor } from "../lib/store";
import { sourceUrl, thumbnailsApi, working, type Design, type OpenArtAccount, type OpenArtState, type Thumbnail, type ThumbComment, type ThumbRun, type ThumbVersion } from "../lib/thumbnails";
import { drawThumbnail, type Context as DrawContext } from "@edit/types/thumbnail_render";
import { captionShadow, HEIGHT, WIDTH } from "@edit/types/thumbnails";
import { Loader } from "../components/Logo";

// The caption faces ship with Edit (the server has them); Helvetica Neue, Arial Black and Impact are the Mac's own.
let fontsAdded = false;
function addFonts(): void {
  if (fontsAdded) return;
  fontsAdded = true;
  for (const [family, file] of [
    ["Montserrat", "Montserrat.ttf"],
    ["Arabic-font-2013", "Arabic-font-2013.ttf"],
    ["ITC Avant Garde Gothic", "ITCAvantGardeGothic-Bold.otf"],
  ] as const) {
    const face = new FontFace(family, `url("/api/thumbnails/fonts/${encodeURIComponent(file)}")`, { weight: "100 900" });
    void face.load().then((loaded) => document.fonts.add(loaded), () => {});
  }
}

// ---------------------------------------------------------------- pictures, as the canvas loads them

const loaded = new Map<string, HTMLImageElement | null>();
/** Every picture the given layouts show (the one showing and each version's), loaded once; the tick moves as they land. */
function usePictures(id: string, designs: Design[]): [(source: string) => HTMLImageElement | null, number] {
  const [tick, setTick] = useState(0);
  const sources = [...new Set(designs.flatMap((design) => design.layers.flatMap((layer) => (layer.kind === "image" ? [layer.source] : []))))].join("\n");
  useEffect(() => {
    for (const source of sources === "" ? [] : sources.split("\n")) {
      const url = sourceUrl(id, source);
      if (loaded.has(url)) continue;
      loaded.set(url, null);
      const image = new Image();
      image.onload = () => {
        loaded.set(url, image);
        setTick((n) => n + 1);
      };
      // Tried again with the next change, not never.
      image.onerror = () => loaded.delete(url);
      image.src = url;
    }
  }, [id, sources]);
  // A caption's face landing redraws too (what was drawn in a stand-in face isn't kept).
  useEffect(() => {
    const landed = () => {
      faces++;
      setTick((n) => n + 1);
    };
    document.fonts.addEventListener("loadingdone", landed);
    return () => document.fonts.removeEventListener("loadingdone", landed);
  }, []);
  const picture = useCallback((source: string) => loaded.get(sourceUrl(id, source)) ?? null, [id]);
  return [picture, tick];
}

const surface = (width: number, height: number) => {
  const made = document.createElement("canvas");
  made.width = width;
  made.height = height;
  return made;
};

/** How many caption faces have landed: a drawing made before one did isn't the same drawing. */
let faces = 0;

/**
 * Each layout drawn whole, kept (Sphe, Nov 4: switching versions should be
 * "a lot more instant"): the canvas and the version tiles show a layout drawn
 * once, so moving between versions is a copy, not the adjustments worked out
 * again. Only a drawing with all its pictures in is kept; the last dozen.
 */
const drawings = new Map<string, HTMLCanvasElement>();
function drawingOf(design: Design, picture: (source: string) => HTMLImageElement | null): HTMLCanvasElement {
  const key = `${faces}:${JSON.stringify(design)}`;
  const kept = drawings.get(key);
  if (kept !== undefined) {
    drawings.delete(key);
    drawings.set(key, kept);
    return kept;
  }
  const made = surface(WIDTH, HEIGHT);
  const context = made.getContext("2d", { willReadFrequently: true })!;
  drawThumbnail(context as unknown as DrawContext, design, { picture, canvas: surface }, WIDTH, HEIGHT);
  if (design.layers.every((layer) => layer.kind !== "image" || layer.hidden || picture(layer.source) !== null)) {
    drawings.set(key, made);
    if (drawings.size > 12) drawings.delete(drawings.keys().next().value!);
  }
  return made;
}

function draw(canvas: HTMLCanvasElement, design: Design, picture: (source: string) => HTMLImageElement | null): void {
  canvas.getContext("2d")?.drawImage(drawingOf(design, picture), 0, 0);
}

/** A box-less caption still carrying an older house shadow shows the current one (opacity 100, spread 36, size 32, angle 90). */
function settleCaptions(design: Design): Design {
  let changed = false;
  const layers = design.layers.map((layer) => {
    if (layer.kind !== "text") return layer;
    const shadow = captionShadow(layer);
    if (shadow === layer.shadow) return layer;
    changed = true;
    return { ...layer, shadow: shadow === undefined ? undefined : { ...shadow } };
  });
  return changed ? { ...design, layers } : design;
}

// ---------------------------------------------------------------- the screen

export function ThumbnailScreen({ id }: { id: string }) {
  const [thumb, setThumb] = useState<Thumbnail | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const toastError = useEditor((state) => state.toastError);
  const canvas = useRef<HTMLCanvasElement>(null);

  // The last revision shown: a poll that brings the same one back changes nothing (and redraws nothing).
  const shownRev = useRef<number | null>(null);
  const show = useCallback((next: Thumbnail, rev: number) => {
    shownRev.current = rev;
    setThumb({ ...next, design: settleCaptions(next.design) });
  }, []);
  // Changes made here (a version shown, a comment) not yet answered for: a poll meanwhile would show what was before.
  const switching = useRef(0);
  const load = useCallback(
    () =>
      thumbnailsApi
        .get(id)
        .then(({ thumb, rev }) => {
          setMissing(null);
          if (rev !== shownRev.current && switching.current === 0) show(thumb, rev);
        })
        .catch((error: unknown) => setMissing((error as Error).message)),
    [id, show],
  );
  const running = thumb !== null && working(thumb);
  useEffect(() => {
    addFonts();
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, running ? 1_500 : 10_000);
    return () => clearInterval(timer);
  }, [load, running]);

  /**
   * The version the person is looking at is theirs (Sphe, Nov 4: the agent
   * "shouldn't have to switch my view as well, it can do it with tool calls in
   * the background"): Claude works on the version it's on, shown lit on its
   * tile, and the page stays where the person put it. Left alone, the page
   * follows Claude (a draft it starts shows up); a click pins it, until the
   * person's next message starts its turn on what they're looking at.
   */
  const [view, setView] = useState<string | null>(null);
  const versions = thumb?.versions ?? [];
  const viewing = view !== null && versions.some((one) => one.id === view) ? view : thumb?.activeVersion;
  const viewed = viewing === thumb?.activeVersion ? undefined : versions.find((one) => one.id === viewing);
  const viewedDesign = useMemo(() => (viewed === undefined ? null : settleCaptions(viewed.design)), [viewed]);
  const design = thumb === null ? null : (viewedDesign ?? thumb.design);
  const runningNow = useRef(false);
  useEffect(() => {
    // A turn starting on the version the person is looking at: from here the page follows it again.
    if (running && !runningNow.current && view !== null && thumb?.activeVersion === view) setView(null);
    runningNow.current = running;
  }, [running, view, thumb?.activeVersion]);
  const [picture, tick] = usePictures(id, [...(thumb ? [thumb.design] : []), ...versions.map((one) => one.design)]);
  useEffect(() => {
    if (canvas.current === null || design === null) return;
    const frame = requestAnimationFrame(() => draw(canvas.current!, design, picture));
    return () => cancelAnimationFrame(frame);
  }, [design, tick, picture]);

  /**
   * Another version shown at once, from the layouts already here; the server
   * is told behind it (and draws the list's picture again). The last one asked
   * for is what stays; a refusal puts back what was showing.
   */
  const asked = useRef(0);
  const showVersion = (version: string) => {
    if (thumb === null) return;
    const target = thumb.versions?.find((one) => one.id === version);
    if (target === undefined) return;
    setView(version);
    // While Claude works the view is the person's alone; otherwise the thumbnail shows it too (the list, teammates, Claude's next turn).
    if (running || version === thumb.activeVersion) return;
    const before = thumb;
    const versions = (thumb.versions ?? []).map((one) => (one.id === thumb.activeVersion ? { ...one, design: thumb.design } : one));
    setThumb({ ...thumb, versions, activeVersion: version, design: settleCaptions(target.design), history: [], future: [] });
    const mine = ++asked.current;
    switching.current++;
    void thumbnailsApi
      .switchVersion(id, version)
      .then(
        ({ thumb, rev }) => {
          if (mine === asked.current) show(thumb, rev);
        },
        (error: unknown) => {
          if (mine === asked.current) {
            setThumb(before);
            setView(null);
          }
          toastError(error, "show that version");
        },
      )
      .finally(() => switching.current--);
  };
  // The comment tool (C, or the header's button): the cursor pins a comment where it's clicked; Escape puts it down.
  const [commenting, setCommenting] = useState(false);
  useEffect(() => {
    const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    const onKey = (event: KeyboardEvent) => {
      if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey || document.querySelector('[role="dialog"]') !== null) return;
      if (event.key.toLowerCase() === "c") setCommenting((was) => !was);
      else if (event.key === "Escape") setCommenting(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  /**
   * A comment left, or taken back, at once (Sphe, Nov 4: "have the ui assume
   * when you press enter or comment it just happens instantly"): the page shows
   * it straight away and the server is told behind it. Its answer is shown
   * once no other change from here is still on its way; a refusal undoes just
   * that one.
   */
  const me = useAccount((state) => (state.account?.signed_in ? (state.account.person?.name ?? null) : null));
  const behind = (call: Promise<{ thumb: Thumbnail; rev: number }>, undo: () => void, what: string) => {
    switching.current++;
    void call
      .then(
        ({ thumb, rev }) => {
          if (switching.current === 1) show(thumb, rev);
        },
        (error: unknown) => {
          undo();
          toastError(error, what);
        },
      )
      .finally(() => switching.current--);
  };
  const comment = (at: { x: number; y: number }, text: string) => {
    const local: ThumbComment = { id: `local-${Math.random().toString(36).slice(2, 10)}`, n: (thumb?.comments ?? []).reduce((most, one) => Math.max(most, one.n), 0) + 1, x: Math.round(at.x), y: Math.round(at.y), text: text.trim(), by: me ?? "You", at: Date.now(), ...(viewing !== undefined ? { version: viewing } : {}) };
    setThumb((was) => (was === null ? was : { ...was, comments: [...(was.comments ?? []), local] }));
    behind(thumbnailsApi.comment(id, at, text, viewing), () => setThumb((was) => (was === null ? was : { ...was, comments: (was.comments ?? []).filter((one) => one.id !== local.id) })), "leave the comment");
  };
  const removeComment = (comment: string) => {
    const gone = thumb?.comments?.find((one) => one.id === comment);
    if (gone === undefined) return;
    setThumb((was) => (was === null ? was : { ...was, comments: (was.comments ?? []).filter((one) => one.id !== comment) }));
    behind(thumbnailsApi.removeComment(id, comment), () => setThumb((was) => (was === null ? was : { ...was, comments: [...(was.comments ?? []), gone].sort((a, b) => a.n - b.n) })), "remove the comment");
  };
  const takeFinal = (version: string) => {
    if (thumb === null) return;
    const before = thumb;
    setThumb({ ...thumb, finalVersion: version });
    switching.current++;
    void thumbnailsApi
      .takeFinal(id, version)
      .then(
        ({ thumb, rev }) => show(thumb, rev),
        (error: unknown) => {
          setThumb(before);
          toastError(error, "mark it final");
        },
      )
      .finally(() => switching.current--);
  };

  // The chat's uploader (lib/chatFiles.ts): a picture into the thumbnail's images, given to Claude with the message.
  const chatKey = `thumb:${id}`;
  const chatUpload = useMemo<Uploader>(
    () => async (file, progress, signal) => {
      const { image } = (await postFile(`/api/thumbnails/${encodeURIComponent(id)}/images?name=${encodeURIComponent(file.name)}`, file, progress, signal, { "content-type": file.type })) as { image: { id: string } };
      return image.id;
    },
    [id],
  );
  const attachToChat = (files: File[]) => {
    const refused = attachFiles(chatKey, files, chatUpload, picturesOnly);
    if (refused.length > 0) toastError(new Error(refused.join(" · ")), "attach the files");
  };
  // Pictures pasted anywhere on the page go to Claude with the next message.
  useEffect(() => {
    // Into a field (the chat's composer above all) is that field's own; with a dialog open, the dialog's.
    const elsewhere = (target: EventTarget | null) =>
      (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) || document.querySelector('[role="dialog"]') !== null;
    const onPaste = (event: ClipboardEvent) => {
      if (elsewhere(event.target)) return;
      const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
      if (files.length === 0) return;
      event.preventDefault();
      attachToChat(files);
    };
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("paste", onPaste);
    };
  });

  const download = (type: "image/png" | "image/jpeg") => {
    canvas.current?.toBlob(
      (blob) => {
        if (blob !== null) void saveFile(`${(thumb?.title || "thumbnail").replace(/[^\w -]+/g, "").trim() || "thumbnail"}.${type === "image/png" ? "png" : "jpg"}`, blob);
      },
      type,
      0.92,
    );
  };

  return (
    <div
      className="flex h-full flex-col bg-black"
      onDragOver={(event) => {
        if ([...event.dataTransfer.items].some((item) => item.kind === "file")) event.preventDefault();
      }}
      onDrop={(event) => {
        const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith("image/"));
        if (files.length === 0) return;
        event.preventDefault();
        attachToChat(files);
      }}
    >
      <Header
        thumb={thumb}
        running={running}
        commenting={commenting}
        onCommenting={() => setCommenting((was) => !was)}
        onTitle={(title) =>
          void thumbnailsApi.change(id, { title }).then(
            ({ thumb, rev }) => show(thumb, rev),
            (error: unknown) => toastError(error, "rename it"),
          )
        }
        onDownload={download}
      />
      {/* No padding on the right: the chat's edge sits there. */}
      <div className="flex min-h-0 flex-1 pb-2 pl-2">
        <main className="flex min-w-0 flex-1 flex-col items-center gap-3 px-4 pt-2 pb-2">
          {thumb === null || design === null ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-white/40">{missing ?? <Loader size={32} />}</div>
          ) : (
            <>
              <Stage canvas={canvas} empty={design.layers.length === 0} run={viewing === thumb.activeVersion ? thumb.run : null}>
                {(scale) => <Comments thumb={thumb} viewing={viewing} scale={scale} commenting={commenting} onComment={comment} onRemove={removeComment} />}
              </Stage>
              <Versions thumb={thumb} viewing={viewing} picture={picture} tick={tick} running={running} onShow={showVersion} onFinal={takeFinal} />
            </>
          )}
        </main>
        <ChatDock working={running}>
          <div className="flex min-h-0 flex-1 flex-col pt-2">{thumb === null ? <ChatShell loading /> : <Chat id={id} thumb={thumb} upload={chatUpload} viewing={viewing} onSending={() => viewing !== undefined && setView(viewing)} onAsked={() => void load()} />}</div>
        </ChatDock>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the header

let scratch: CanvasRenderingContext2D | null = null;

/** The way back, its name, the comment tool, its OpenArt account and Download: nothing else (Sphe, Nov 4: undo and redo are the agent's, the ⋯ went; delete is on the list). */
function Header({ thumb, running, commenting, onCommenting, onTitle, onDownload }: { thumb: Thumbnail | null; running: boolean; commenting: boolean; onCommenting: () => void; onTitle: (title: string) => void; onDownload: (type: "image/png" | "image/jpeg") => void }) {
  const [title, setTitle] = useState(thumb?.title ?? "");
  useEffect(() => setTitle(thumb?.title ?? ""), [thumb?.title]);
  // The title's box fits its words, as the edit page's name does: measured, capped.
  const titleInput = useRef<HTMLInputElement>(null);
  const [titleWidth, setTitleWidth] = useState(120);
  useLayoutEffect(() => {
    const node = titleInput.current;
    if (!node) return;
    const style = getComputedStyle(node);
    scratch ??= document.createElement("canvas").getContext("2d")!;
    scratch.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const text = Math.ceil(scratch.measureText(title || node.placeholder || " ").width);
    setTitleWidth(Math.min(480, Math.max(56, text + 20)));
  }, [title]);
  return (
    <header className="flex h-12 shrink-0 items-center gap-1.5 px-3">
      <IconButton label="Thumbnails" onClick={() => navigate("/thumbnails")}>
        <ArrowLeft size={16} />
      </IconButton>
      <input
        ref={titleInput}
        value={title}
        placeholder="Thumbnail 1"
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => {
          if (title.trim() === "") setTitle(thumb?.title ?? "");
          else if (title !== (thumb?.title ?? "")) onTitle(title);
        }}
        onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
        className="h-8 min-w-0 shrink rounded-md bg-transparent px-2 text-[14px] font-semibold text-fg outline-none transition-colors placeholder:text-faint hover:bg-hover focus:bg-active"
        style={{ width: titleWidth, maxWidth: "38vw" }}
      />
      <div className="flex-1" />
      {thumb !== null && thumb.design.layers.length > 0 && (
        <button
          type="button"
          title={commenting ? "Stop commenting (Esc)" : "Comment on the thumbnail (C)"}
          aria-pressed={commenting}
          onClick={onCommenting}
          className={cx("mr-1 flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] transition-colors", commenting ? "bg-fg text-black" : "text-secondary hover:bg-hover hover:text-fg")}
        >
          <MessageSquare size={14} /> Comment
        </button>
      )}
      {thumb !== null && <OpenArtMenu thumb={thumb} running={running} />}
      <Button
        variant="subtle"
        size="sm"
        className="mr-1.5"
        disabled={thumb === null || thumb.design.layers.length === 0}
        onClick={(event) =>
          toggleMenu(event.currentTarget, [
            { label: "PNG", onSelect: () => onDownload("image/png") },
            { label: "JPEG", onSelect: () => onDownload("image/jpeg") },
          ])
        }
      >
        <Download size={14} /> Download
      </Button>
      <AppMenu />
    </header>
  );
}

const credits = (value: number) => `${value.toLocaleString()} credit${value === 1 ? "" : "s"}`;

/** About how many pictures an account's credits make on the house's model, and whether that's running low (under twenty) or out. */
function standing(account: OpenArtAccount, cost: number | null): { left: number | null; tone: "fine" | "low" | "out" } {
  const left = account.credits !== null && cost !== null && cost > 0 ? Math.floor(account.credits / cost) : null;
  return { left, tone: left === null ? "fine" : left < 1 ? "out" : left < 20 ? "low" : "fine" };
}

const toneText = { fine: "", low: "text-warning", out: "text-danger" } as const;

/**
 * The team's OpenArt accounts (Sphe, Nov 4: "make things more clear in terms of
 * the credits and then maybe have an accounts switcher"; then "a much nicer
 * dropdown… animate it a bit better"): the one in use with its credits on the
 * button; its panel lists each account with its plan, credits and about how
 * many pictures they make, the others a click away, and what a picture costs
 * and this thumbnail has spent. Read again after each of Claude's turns.
 */
function OpenArtMenu({ thumb, running }: { thumb: Thumbnail; running: boolean }) {
  const [state, setState] = useState<OpenArtState | null>(null);
  const [open, setOpen] = useState(false);
  const toastError = useEditor((store) => store.toastError);
  const box = useRef<HTMLDivElement>(null);
  // Read when the page opens and again as each of Claude's turns ends (what it spent).
  const known = state !== null;
  useEffect(() => {
    if (running && known) return;
    void thumbnailsApi.openart().then(setState, () => {});
  }, [running, known]);
  // Closed by a click anywhere else, or Escape.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  if (state === null) return null;
  const inUse = state.accounts.find((one) => one.id === state.current) ?? state.accounts[0];
  if (inUse === undefined) return null;
  const cost = state.picture?.credits ?? null;
  const shown = standing(inUse, cost);
  const spent = thumb.images.reduce((sum, one) => sum + (one.credits ?? 0), 0);
  const pick = (id: string) => {
    if (id === inUse.id) return setOpen(false);
    void thumbnailsApi.useOpenart(id).then(
      (next) => {
        setState(next);
        setOpen(false);
      },
      (error: unknown) => toastError(error, "switch the account"),
    );
  };
  return (
    <div ref={box} className="relative mr-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className={cx("flex h-8 items-center gap-2 rounded-lg px-2.5 text-[12.5px] transition-colors", open ? "bg-active text-fg" : "text-secondary hover:bg-hover hover:text-fg")}
      >
        <span className="max-w-[140px] truncate text-muted">{inUse.name}</span>
        <span className={cx("font-medium tabular", toneText[shown.tone])}>{inUse.credits === null ? "–" : credits(inUse.credits)}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={spring} className="flex text-faint">
          <ChevronDown size={13} />
        </motion.span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.12 } }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
            style={{ transformOrigin: "top right" }}
            className="absolute top-[calc(100%+6px)] right-0 z-[70] w-[300px] rounded-xl border border-line-strong bg-raised p-1.5 shadow-[0_16px_40px_#000a]"
          >
            <div className="px-2.5 pt-1.5 pb-2 text-[11px] font-medium text-faint">OpenArt accounts</div>
            {state.accounts.map((one, index) => {
              const each = standing(one, cost);
              const chosen = one.id === inUse.id;
              return (
                <motion.button
                  key={one.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={chosen}
                  disabled={running && !chosen}
                  onClick={() => pick(one.id)}
                  initial={{ opacity: 0, y: -3 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...spring, delay: 0.03 * (index + 1) }}
                  className={cx("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors disabled:opacity-40", chosen ? "bg-active" : "hover:bg-menu-hover")}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-fg">{one.name}</div>
                    <div className="truncate text-[11.5px] text-faint">{one.plan ?? "OpenArt"}</div>
                  </div>
                  <div className="flex flex-col items-end">
                    <span className={cx("text-[13px] tabular", one.credits === null ? "text-faint" : toneText[each.tone] || "text-fg")}>{one.credits === null ? "Not answering" : credits(one.credits)}</span>
                    {each.left !== null && <span className="text-[11.5px] text-faint tabular">about {each.left.toLocaleString()} pictures</span>}
                  </div>
                  <span className="flex w-4 justify-end">{chosen && <Check size={14} className="text-fg" />}</span>
                </motion.button>
              );
            })}
            {(state.picture !== null || spent > 0) && (
              <div className="mt-1.5 flex flex-col gap-1 border-t border-line px-2.5 pt-2.5 pb-1.5 text-[12px]">
                {state.picture !== null && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-muted">A picture on {state.picture.model}</span>
                    <span className="shrink-0 text-secondary tabular">{credits(state.picture.credits)}</span>
                  </div>
                )}
                {spent > 0 && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted">This thumbnail so far</span>
                    <span className="shrink-0 text-secondary tabular">{credits(spent)}</span>
                  </div>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------- the canvas

function Stage({ canvas, empty, run, children }: { canvas: React.RefObject<HTMLCanvasElement | null>; empty: boolean; run: ThumbRun | null; children: (scale: number) => ReactNode }) {
  const area = useRef<HTMLDivElement>(null);
  const running = run !== null && (run.state === "running" || run.state === "queued");
  // The canvas as big as the space allows, at 16:9.
  const [size, setSize] = useState({ width: 640, height: 360 });
  useEffect(() => {
    const node = area.current;
    if (node === null) return;
    const observer = new ResizeObserver(() => {
      // Inside the room kept under it for the working pill.
      const height = node.clientHeight - parseFloat(getComputedStyle(node).paddingBottom || "0");
      const width = Math.min(node.clientWidth, (height * WIDTH) / HEIGHT);
      setSize({ width, height: (width * HEIGHT) / WIDTH });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const doing = thumbActivity(run);
  const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.5, ease: [0.2, 0, 0, 1] } } as const;
  return (
    <div ref={area} className="relative flex min-h-0 w-full flex-1 items-center justify-center pb-4">
      {/* While Claude works: the page breathes behind the thumbnail. */}
      <AnimatePresence>{running && <motion.div key="aura" {...fade} className="pointer-events-none absolute -inset-x-4 -inset-y-2"><div className="working-aura" /></motion.div>}</AnimatePresence>
      <div style={{ width: size.width, height: size.height }} className="relative isolate shrink-0 rounded-xl select-none">
        <AnimatePresence>
          {running && (
            <motion.div key="light" {...fade} className="pointer-events-none absolute inset-0 -z-10 rounded-xl">
              <div className="working-glow" />
            </motion.div>
          )}
        </AnimatePresence>
        <canvas ref={canvas} width={WIDTH} height={HEIGHT} className="block size-full rounded-xl bg-panel" />
        {empty && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-[13px] text-faint">
            <ImageIcon size={26} />
            Drop a frame or a thumbnail here, or ask Claude for one.
          </div>
        )}
        <AnimatePresence>
          {running && (
            <motion.div key="working" {...fade} className="pointer-events-none absolute inset-0 rounded-xl">
              <div className="working-sheen" />
              <div className="working-ring" />
              {/* What it's doing, on a dark pill sitting on the lit edge, an orb turning in the edge's light (Sphe, Nov 4: the words over the picture were "very difficult to see"). */}
              <div className="absolute inset-x-0 -bottom-3.5 flex justify-center">
                <motion.div layout transition={spring} className="flex h-7 items-center gap-2 rounded-full bg-[#0b0b0b] pr-3.5 pl-2 shadow-[0_0_0_1px_rgb(255_255_255/0.1),0_8px_24px_#000c]">
                  <span className="working-orb" />
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span key={doing} initial={{ opacity: 0, y: 6, filter: "blur(3px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={{ opacity: 0, y: -6, filter: "blur(3px)" }} transition={{ duration: 0.26, ease: [0.2, 0, 0, 1] }} className="text-[12.5px] font-medium whitespace-nowrap text-white">
                      {doing}
                    </motion.span>
                  </AnimatePresence>
                </motion.div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {children(size.width / WIDTH)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- comments

/** The cursor while commenting: a pin, its point at the bottom left where the comment goes. */
const PIN_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><path d="M2 24V12C2 6.5 6.5 2 12 2h2c5.5 0 10 4.5 10 10s-4.5 10-10 10H4z" fill="#fff" stroke="#000" stroke-width="1.5"/><path d="M9 12h8M13 8v8" stroke="#000" stroke-width="1.8" stroke-linecap="round"/></svg>')}") 2 24, crosshair`;

/**
 * Comments pinned on the thumbnail (Sphe, Nov 4: "our cursor sort of takes on
 * that comment tool, and we can click on areas in the image"): the open ones
 * on the version showing, each a numbered pin; hovered, its words; clicked,
 * the comment with Claude's answers. Claude reads them every turn and settles
 * each once it's done (settled ones leave the page).
 */
function Comments({ thumb, viewing, scale, commenting, onComment, onRemove }: { thumb: Thumbnail; viewing: string | undefined; scale: number; commenting: boolean; onComment: (at: { x: number; y: number }, text: string) => void; onRemove: (id: string) => void }) {
  const open = (thumb.comments ?? []).filter((one) => one.settled === undefined && one.version === viewing);
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!commenting) setDraft(null);
  }, [commenting]);
  // The comment open goes with Delete or Backspace; Escape puts it down.
  useEffect(() => {
    if (opened === null) return;
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        onRemove(opened);
        setOpened(null);
      } else if (event.key === "Escape") setOpened(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [opened, onRemove]);
  // A click anywhere else puts an open comment down.
  useEffect(() => {
    if (opened === null && draft === null) return;
    const away = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest("[data-comment]") === null) {
        setOpened(null);
        if (!commenting || !layer.current?.contains(event.target as Node)) setDraft(null);
      }
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [opened, draft, commenting]);
  return (
    <div
      ref={layer}
      className={cx("absolute inset-0", commenting ? "pointer-events-auto" : "pointer-events-none")}
      style={commenting ? { cursor: PIN_CURSOR } : undefined}
      onClick={(event) => {
        if (!commenting || (event.target as Element).closest("[data-comment]") !== null) return;
        const box = event.currentTarget.getBoundingClientRect();
        setOpened(null);
        setDraft({ x: (event.clientX - box.left) / scale, y: (event.clientY - box.top) / scale });
      }}
    >
      <AnimatePresence>
        {open.map((one) => (
          <Pin key={one.n} comment={one} scale={scale} opened={opened === one.id} onOpen={() => setOpened(opened === one.id ? null : one.id)} onRemove={() => onRemove(one.id)} />
        ))}
        {draft !== null && (
          <Draft
            key="draft"
            at={draft}
            scale={scale}
            n={(thumb.comments ?? []).reduce((most, one) => Math.max(most, one.n), 0) + 1}
            onCancel={() => setDraft(null)}
            onSave={(text) => {
              onComment(draft, text);
              setDraft(null);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/** A comment's bubble, its point at the bottom left on the spot. */
function Bubble({ n, active, replied }: { n: number | null; active: boolean; replied?: boolean }) {
  return (
    <span className={cx("relative flex size-7 items-center justify-center rounded-full rounded-bl-none text-[12px] font-semibold shadow-[0_2px_10px_#0008] ring-2 transition-colors duration-150 tabular", active ? "bg-fg text-black ring-black" : "bg-black/85 text-white ring-white/90")}>
      {n ?? <MessageSquare size={12} />}
      {replied && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-agent ring-2 ring-black" />}
    </span>
  );
}

/** Where a comment's card goes beside its pin: to the right, or the left near the right edge; below, or above near the bottom. */
function cardSide(at: { x: number; y: number }): string {
  return cx(at.x > WIDTH * 0.62 ? "right-full mr-2" : "left-full ml-2", at.y > HEIGHT * 0.6 ? "bottom-0" : "top-0");
}

function Pin({ comment, scale, opened, onOpen, onRemove }: { comment: ThumbComment; scale: number; opened: boolean; onOpen: () => void; onRemove: () => void }) {
  const [hover, setHover] = useState(false);
  const replies = comment.replies ?? [];
  return (
    <motion.div
      data-comment
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.14 } }}
      transition={{ type: "spring", stiffness: 520, damping: 32 }}
      style={{ left: comment.x * scale, top: comment.y * scale, transformOrigin: "bottom left" }}
      className={cx("pointer-events-auto absolute -translate-y-full", opened ? "z-30" : "z-20 hover:z-30")}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <button type="button" aria-label={`Comment ${comment.n}`} onClick={onOpen} className="block cursor-pointer">
        <Bubble n={comment.n} active={opened || hover} replied={replies.length > 0} />
      </button>
      <AnimatePresence>
        {(opened || hover) && (
          <motion.div
            initial={{ opacity: 0, y: 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={spring}
            // Padding, not a margin, between the pin and its card: the pointer crosses to the card without leaving it.
            className={cx("absolute", comment.x > WIDTH * 0.62 ? "right-full pr-2" : "left-full pl-2", comment.y > HEIGHT * 0.6 ? "bottom-0" : "top-0")}
          >
            <div className="w-[264px] rounded-xl border border-line-strong bg-raised p-3 text-left shadow-[0_16px_40px_#000a]">
              <div className="flex items-center gap-2 text-[11.5px]">
                <span className="truncate font-medium text-fg">{comment.by.split(" ")[0]}</span>
                <span className="text-faint">{ago(comment.at)}</span>
                <div className="flex-1" />
                <IconButton label={opened ? "Remove the comment (Delete)" : "Remove the comment"} onClick={onRemove} className="-my-1 size-6">
                  <Trash2 size={12} />
                </IconButton>
              </div>
              <p className={cx("mt-1 text-[13px] leading-snug whitespace-pre-wrap text-secondary", !opened && "line-clamp-3")}>{comment.text}</p>
              {opened &&
                replies.map((reply) => (
                  <div key={reply.at} className="mt-2.5 border-t border-line pt-2.5">
                    <div className="flex items-center gap-2 text-[11.5px]">
                      <span className={cx("font-medium", reply.by === "claude" ? "text-agent" : "text-fg")}>{reply.by === "claude" ? "Claude" : reply.by.split(" ")[0]}</span>
                      <span className="text-faint">{ago(reply.at)}</span>
                    </div>
                    <p className="mt-1 text-[13px] leading-snug whitespace-pre-wrap text-secondary">{reply.text}</p>
                  </div>
                ))}
              {!opened && replies.length > 0 && <p className="mt-1.5 text-[11.5px] text-agent">Claude answered</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** A new comment where the person clicked: its words, Enter to leave it, Escape to drop it. */
function Draft({ at, scale, n, onCancel, onSave }: { at: { x: number; y: number }; scale: number; n: number; onCancel: () => void; onSave: (text: string) => void }) {
  const [text, setText] = useState("");
  const save = () => {
    if (text.trim() !== "") onSave(text);
  };
  return (
    <motion.div
      data-comment
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.12 } }}
      transition={{ type: "spring", stiffness: 520, damping: 32 }}
      style={{ left: at.x * scale, top: at.y * scale, transformOrigin: "bottom left", cursor: "auto" }}
      className="pointer-events-auto absolute z-40 -translate-y-full"
    >
      <Bubble n={n} active />
      <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={spring} className={cx("absolute w-[280px] rounded-xl border border-line-strong bg-raised p-2 shadow-[0_16px_40px_#000a]", cardSide(at))}>
        <textarea
          autoFocus
          rows={2}
          value={text}
          placeholder="What should change here?"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              onCancel();
            } else if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              save();
            }
          }}
          className="block w-full resize-none bg-transparent px-1.5 py-1 text-[13px] leading-snug text-fg outline-none placeholder:text-faint"
        />
        <div className="flex items-center justify-end gap-1.5 pt-1">
          <Button variant="light" size="sm" disabled={text.trim() === ""} onClick={save}>
            Comment
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ---------------------------------------------------------------- the versions

/**
 * Its versions under the canvas, each drawn as it stands, once it has more
 * than one (Sphe, Nov 4: the V1 / V2 pills "changed significantly"): a click
 * shows one, and the one that ships is marked Final, on its own tile.
 */
function Versions({ thumb, viewing, picture, tick, running, onShow, onFinal }: { thumb: Thumbnail; viewing: string | undefined; picture: (source: string) => HTMLImageElement | null; tick: number; running: boolean; onShow: (version: string) => void; onFinal: (version: string) => void }) {
  const versions = thumb.versions ?? [];
  return (
    <AnimatePresence initial={false}>
      {versions.length > 1 && (
        <motion.div
          key="versions"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={spring}
          className="w-full shrink-0 overflow-hidden"
        >
          <div className="flex justify-center gap-3 overflow-x-auto px-1 pt-1 pb-1.5">
            <AnimatePresence initial={false}>
              {versions.map((version) => (
                <VersionTile
                  key={version.id}
                  version={version}
                  // The one showing is drawn from the layout on the canvas, so it follows Claude's changes as they land.
                  design={version.id === thumb.activeVersion ? thumb.design : version.design}
                  showing={version.id === viewing}
                  worked={running && version.id === thumb.activeVersion}
                  final={version.id === thumb.finalVersion}
                  comments={(thumb.comments ?? []).filter((one) => one.settled === undefined && one.version === version.id).length}
                  picture={picture}
                  tick={tick}
                  onShow={() => onShow(version.id)}
                  onFinal={() => onFinal(version.id)}
                />
              ))}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function VersionTile({ version, design, showing, worked, final, comments, picture, tick, onShow, onFinal }: { version: ThumbVersion; design: Design; showing: boolean; worked: boolean; final: boolean; comments: number; picture: (source: string) => HTMLImageElement | null; tick: number; onShow: () => void; onFinal: () => void }) {
  const small = useRef<HTMLCanvasElement>(null);
  const shape = JSON.stringify(design);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const target = small.current?.getContext("2d");
      if (!target) return;
      target.imageSmoothingQuality = "high";
      target.drawImage(drawingOf(settleCaptions(JSON.parse(shape) as Design), picture), 0, 0, target.canvas.width, target.canvas.height);
    });
    return () => cancelAnimationFrame(frame);
  }, [shape, picture, tick]);
  return (
    <motion.div layout initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={spring} className="group flex w-[clamp(84px,7vw,112px)] shrink-0 flex-col gap-1">
      <button
        type="button"
        title={showing ? `${version.name} is showing` : `Show ${version.name}`}
        onClick={() => !showing && onShow()}
        className={cx(
          "relative aspect-video overflow-hidden rounded-md bg-panel ring-offset-2 ring-offset-black transition-[box-shadow,opacity] duration-200",
          showing ? "ring-2 ring-white" : "ring-1 ring-line hover:ring-line-strong",
        )}
      >
        <canvas ref={small} width={224} height={126} className="block size-full" />
        {worked && <span className="working-ring inset-0! rounded-md" />}
        {comments > 0 && (
          <span title={`${comments} open comment${comments === 1 ? "" : "s"}`} className="absolute top-1 right-1 flex h-4 items-center gap-0.5 rounded-full bg-black/80 px-1 text-[10px] font-medium text-white tabular">
            <MessageSquare size={9} /> {comments}
          </span>
        )}
      </button>
      <div className="flex h-6 items-center gap-1.5 px-0.5">
        <span className={cx("text-[12px] font-medium tabular", showing ? "text-fg" : "text-muted")}>{version.name}</span>
        <div className="flex-1" />
        {final ? (
          <span className="flex h-5 items-center gap-1 rounded-full bg-success-soft px-1.5 text-[11px] font-medium text-success">
            <Check size={11} strokeWidth={2.5} /> Final
          </span>
        ) : (
          <button
            type="button"
            onClick={onFinal}
            className="h-5 rounded-full px-1.5 text-[11px] text-faint opacity-0 transition-[opacity,color,background-color] duration-150 group-hover:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100"
          >
            Make final
          </button>
        )}
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------- the conversation

function Chat({ id, thumb, upload, viewing, onSending, onAsked }: { id: string; thumb: Thumbnail; upload: Uploader; viewing: string | undefined; onSending: () => void; onAsked: () => void }) {
  const toastError = useEditor((state) => state.toastError);
  const running = working(thumb);
  const entries = conversationEntries(thumb.chat, thumb.createdAt, running ? thumb.run : null, (turn) => (turn.images ?? []).map((image) => ({ name: thumb.images.find((one) => one.id === image)?.name ?? "picture", kind: "image" as const, url: sourceUrl(thumb.id, image) })));
  // A message shows the moment it's sent.
  const sent = useSentNow(entries);
  const { turns, known } = useChatTurns(id, sent.entries, running || sent.sending);
  const quiet = running && thumb.run !== null && thumb.run.trace === undefined && thumb.run.tools === undefined && thumb.run.said === undefined;
  return (
    <ChatShell
      resetKey={id}
      footer={
        <ChatComposer
          running={running}
          disabled={false}
          modelName="Opus 5.5"
          placeholder="Ask for a thumbnail, or a change…"
          draft={`thumbnails.chat-draft.${id}`}
          chat={`thumb:${id}`}
          files={{ upload, accept: picturesOnly }}
          onSend={(message, files) => {
            sent.hold(message, files.map((one) => ({ name: one.name, kind: one.kind, url: one.preview })));
            onSending();
            void thumbnailsApi.chat(id, message, files.map((one) => one.landed as string), viewing).then(onAsked, (error: unknown) => {
              sent.drop();
              toastError(error, "ask Claude");
            });
          }}
          onStop={() => void thumbnailsApi.stop(id).then(onAsked, (error: unknown) => toastError(error, "stop it"))}
        />
      }
    >
      {sent.entries.length === 0 ? (
        <Empty title="Make a thumbnail with Claude" detail="Drop in a frame or a thumbnail and say what you want: “clean this base and put the REC overlay on”, “three versions of the mom at the door”, “add ‘he abused me’ in a black box”, “a touch brighter”." />
      ) : (
        <ChatTurns turns={turns} known={known} thinking={quiet ? `On ${thumb.run?.holder}` : undefined} />
      )}
    </ChatShell>
  );
}
