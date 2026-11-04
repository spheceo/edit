// A thumbnail's page: the thumbnail big in the middle (drawn by the same code
// Claude's looks use), its versions side by side under it once it has more
// than one, the conversation with Claude on the right. The page has no
// controls of its own (Sphe, Nov 4: "give more of that to the agents on the
// right and then have the user just chat with it"): no layers, pictures or
// sliders; every change is asked of Claude. Pictures dropped or pasted
// anywhere go to Claude with the next message.

import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Check, ChevronDown, Download, Image as ImageIcon, MoreHorizontal, Redo2, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ChatShell, ChatTurns, Empty, useChatTurns } from "../components/AgentPanel";
import { ChatComposer } from "../components/ChatComposer";
import { ChatDock } from "../components/ChatDock";
import { attachFiles, picturesOnly, postFile, type Uploader } from "../lib/chatFiles";
import { AppMenu } from "../components/AppMenu";
import { toggleMenu, type MenuItem } from "../components/ContextMenu";
import { Button, ConfirmDialog, cx, IconButton, Spinner, spring } from "../components/ui";
import { conversationEntries } from "../lib/agentTurns";
import { saveFile } from "../lib/files";
import { navigate } from "../lib/route";
import { useEditor } from "../lib/store";
import { sourceUrl, thumbnailsApi, working, type Design, type OpenArtState, type Thumbnail, type ThumbVersion } from "../lib/thumbnails";
import { drawThumbnail, type Context as DrawContext } from "@edit/types/thumbnail_render";
import { captionShadow, HEIGHT, WIDTH } from "@edit/types/thumbnails";

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
  const picture = useCallback((source: string) => loaded.get(sourceUrl(id, source)) ?? null, [id]);
  return [picture, tick];
}

const surface = (width: number, height: number) => {
  const made = document.createElement("canvas");
  made.width = width;
  made.height = height;
  return made;
};

function draw(canvas: HTMLCanvasElement, design: Design, picture: (source: string) => HTMLImageElement | null): void {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return;
  drawThumbnail(context as unknown as DrawContext, design, { picture, canvas: surface }, WIDTH, HEIGHT);
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
  const toast = useEditor((state) => state.toast);
  const canvas = useRef<HTMLCanvasElement>(null);

  // The last revision shown: a poll that brings the same one back changes nothing (and redraws nothing).
  const shownRev = useRef<number | null>(null);
  const show = useCallback((next: Thumbnail, rev: number) => {
    shownRev.current = rev;
    setThumb({ ...next, design: settleCaptions(next.design) });
  }, []);
  const load = useCallback(
    () =>
      thumbnailsApi
        .get(id)
        .then(({ thumb, rev }) => {
          setMissing(null);
          if (rev !== shownRev.current) show(thumb, rev);
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

  const design = thumb?.design ?? null;
  const versions = thumb?.versions ?? [];
  const [picture, tick] = usePictures(id, [...(design ? [design] : []), ...versions.map((one) => one.design)]);
  useEffect(() => {
    if (canvas.current === null || design === null) return;
    const frame = requestAnimationFrame(() => draw(canvas.current!, design, picture));
    return () => cancelAnimationFrame(frame);
  }, [design, tick, picture]);

  /** The thumbnail as drawn here kept as the list's picture (after an undo, or another version shown). */
  const keepDrawing = () =>
    requestAnimationFrame(() =>
      canvas.current?.toBlob((png) => {
        if (png !== null) void thumbnailsApi.saveRender(id, png).catch(() => {});
      }, "image/png"),
    );

  /**
   * Undo and redo walk the thumbnail's own timeline (Sphe, Nov 2: "we should have
   * undo both for us and for the agent"): Claude's changes, newest first.
   */
  const [stepping, setStepping] = useState(false);
  const walk = async (back: boolean) => {
    if (stepping) return;
    setStepping(true);
    try {
      const { thumb, rev, step } = await thumbnailsApi.step(id, back);
      show(thumb, rev);
      if (step === null) toast(back ? "Nothing to undo." : "Nothing to redo.");
      else {
        toast(`${back ? "Undid" : "Redid"}: ${step}`);
        keepDrawing();
      }
    } catch (error) {
      toastError(error, back ? "undo" : "redo");
    } finally {
      setStepping(false);
    }
  };
  const undo = () => void walk(true);
  const redo = () => void walk(false);
  const showVersion = (version: string) =>
    void thumbnailsApi.switchVersion(id, version).then(({ thumb, rev }) => {
      show(thumb, rev);
      keepDrawing();
    }, (error: unknown) => toastError(error, "show that version"));
  const takeFinal = (version: string) =>
    void thumbnailsApi.takeFinal(id, version).then(({ thumb, rev }) => show(thumb, rev), (error: unknown) => toastError(error, "mark it final"));

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
  // Pictures pasted anywhere on the page go to Claude with the next message; ⌘Z and ⇧⌘Z step through the changes.
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
    const onKey = (event: KeyboardEvent) => {
      if (elsewhere(event.target) || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKey);
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
        onUndo={undo}
        onRedo={redo}
        onTitle={(title) =>
          void thumbnailsApi.change(id, { title }).then(
            ({ thumb, rev }) => show(thumb, rev),
            (error: unknown) => toastError(error, "rename it"),
          )
        }
        onDownload={download}
        onDelete={() =>
          void thumbnailsApi.remove(id).then(
            () => navigate("/thumbnails"),
            (error: unknown) => toastError(error, "delete it"),
          )
        }
      />
      {/* No padding on the right: the chat's edge sits there. */}
      <div className="flex min-h-0 flex-1 pb-2 pl-2">
        <main className="flex min-w-0 flex-1 flex-col items-center gap-3 px-4 pt-2 pb-2">
          {thumb === null || design === null ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-white/40">{missing ?? <Spinner size={20} />}</div>
          ) : (
            <>
              <Stage canvas={canvas} empty={design.layers.length === 0} running={running} step={thumb.run?.step} />
              <Versions thumb={thumb} picture={picture} tick={tick} running={running} onShow={showVersion} onFinal={takeFinal} />
            </>
          )}
        </main>
        <ChatDock working={running}>
          <div className="flex min-h-0 flex-1 flex-col pt-2">{thumb === null ? <ChatShell loading /> : <Chat id={id} thumb={thumb} upload={chatUpload} onAsked={() => void load()} />}</div>
        </ChatDock>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the header

let scratch: CanvasRenderingContext2D | null = null;

function Header({ thumb, running, onUndo, onRedo, onTitle, onDownload, onDelete }: { thumb: Thumbnail | null; running: boolean; onUndo: () => void; onRedo: () => void; onTitle: (title: string) => void; onDownload: (type: "image/png" | "image/jpeg") => void; onDelete: () => void }) {
  const last = thumb?.history?.at(-1);
  const next = thumb?.future?.at(-1);
  const who = (by: string) => (by === "claude" ? "Claude" : by.split(" ")[0]);
  const [title, setTitle] = useState(thumb?.title ?? "");
  const [confirm, setConfirm] = useState(false);
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
      {thumb !== null && <OpenArtMenu thumb={thumb} running={running} />}
      <IconButton label={last ? `Undo ${who(last.by)}'s change: ${last.label} (⌘Z)` : "Nothing to undo"} disabled={last === undefined || running} onClick={onUndo}>
        <Undo2 size={15} />
      </IconButton>
      <IconButton label={next ? `Redo ${who(next.by)}'s change: ${next.label} (⇧⌘Z)` : "Nothing to redo"} disabled={next === undefined || running} onClick={onRedo}>
        <Redo2 size={15} />
      </IconButton>
      <Button
        variant="subtle"
        size="sm"
        className="ml-1.5"
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
      <IconButton label="More" onClick={(event) => toggleMenu(event.currentTarget, [{ label: "Delete thumbnail", danger: true, icon: <Trash2 size={14} />, onSelect: () => setConfirm(true) }], { width: 180 })}>
        <MoreHorizontal size={16} />
      </IconButton>
      <AppMenu />
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete this thumbnail?"
        detail="It goes for everyone on the team, with its versions, pictures and conversation."
        confirm="Delete"
        onConfirm={() => {
          setConfirm(false);
          onDelete();
        }}
      />
    </header>
  );
}

const credits = (value: number) => `${value.toLocaleString()} credit${value === 1 ? "" : "s"}`;

/**
 * The team's OpenArt accounts (Sphe, Nov 4: "make things more clear in terms of
 * the credits and then maybe have an accounts switcher"): the one in use with
 * its credits and about how many pictures they make, the others a click away,
 * and what this thumbnail has spent. Read again after each of Claude's turns.
 */
function OpenArtMenu({ thumb, running }: { thumb: Thumbnail; running: boolean }) {
  const [state, setState] = useState<OpenArtState | null>(null);
  const toastError = useEditor((store) => store.toastError);
  useEffect(() => {
    if (running) return;
    void thumbnailsApi.openart().then(setState, () => setState(null));
  }, [running]);
  if (state === null) return null;
  const inUse = state.accounts.find((one) => one.id === state.current) ?? state.accounts[0];
  if (inUse === undefined) return null;
  const cost = state.picture?.credits ?? null;
  const left = inUse.credits !== null && cost !== null && cost > 0 ? Math.floor(inUse.credits / cost) : null;
  // Low: under twenty pictures' worth; out: not one.
  const tone = left === null ? "neutral" : left < 1 ? "out" : left < 20 ? "low" : "neutral";
  const spent = thumb.images.reduce((sum, one) => sum + (one.credits ?? 0), 0);
  const items: MenuItem[] = [
    { heading: "The team's OpenArt accounts" },
    ...state.accounts.map(
      (one): MenuItem => ({
        label: one.name,
        hint: one.plan ?? undefined,
        detail: one.credits === null ? "Not answering" : credits(one.credits),
        checked: one.id === inUse.id,
        disabled: running && one.id !== inUse.id,
        onSelect: () => {
          if (one.id !== inUse.id) void thumbnailsApi.useOpenart(one.id).then(setState, (error: unknown) => toastError(error, "switch the account"));
        },
      }),
    ),
    { separator: true },
    ...(state.picture !== null ? [{ heading: `${state.picture.model}: ${credits(state.picture.credits)} a picture${left !== null ? `, enough for about ${left.toLocaleString()}` : ""}` }] : []),
    ...(spent > 0 ? [{ heading: `This thumbnail has used ${credits(spent)}` }] : []),
  ];
  return (
    <button
      type="button"
      title={state.accounts.length > 1 ? "Switch OpenArt account" : "The team's OpenArt account"}
      onClick={(event) => toggleMenu(event.currentTarget, items, { width: 300 })}
      className="mr-1.5 flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 text-[12px] text-secondary transition-colors hover:border-line-strong hover:text-fg"
    >
      <span className={cx("size-1.5 rounded-full", tone === "out" ? "bg-danger" : tone === "low" ? "bg-warning" : "bg-success")} />
      <span className="max-w-[140px] truncate">{inUse.name}</span>
      <span className="text-faint">·</span>
      <span className={cx("tabular", tone === "out" ? "text-danger" : tone === "low" ? "text-warning" : "")}>{inUse.credits === null ? "–" : credits(inUse.credits)}</span>
      <ChevronDown size={12} className="text-faint" />
    </button>
  );
}

// ---------------------------------------------------------------- the canvas

function Stage({ canvas, empty, running, step }: { canvas: React.RefObject<HTMLCanvasElement | null>; empty: boolean; running: boolean; step?: string }) {
  const area = useRef<HTMLDivElement>(null);
  // The canvas as big as the space allows, at 16:9.
  const [size, setSize] = useState({ width: 640, height: 360 });
  useEffect(() => {
    const node = area.current;
    if (node === null) return;
    const observer = new ResizeObserver(() => {
      const width = Math.min(node.clientWidth, (node.clientHeight * WIDTH) / HEIGHT);
      setSize({ width, height: (width * HEIGHT) / WIDTH });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={area} className="flex min-h-0 w-full flex-1 items-center justify-center">
      <div style={{ width: size.width, height: size.height }} className="relative shrink-0 select-none">
        <canvas ref={canvas} width={WIDTH} height={HEIGHT} className="block size-full rounded-xl bg-panel" />
        {empty && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-[13px] text-faint">
            <ImageIcon size={26} />
            Drop a frame or a thumbnail here, or ask Claude for one.
          </div>
        )}
        <AnimatePresence>
          {running && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={spring}
              className="pointer-events-none absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-black/75 px-2.5 py-1 text-[12px] text-white backdrop-blur-sm"
            >
              <Spinner size={11} /> {step ?? "Claude is working"}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the versions

/**
 * Its versions under the canvas, each drawn as it stands, once it has more
 * than one (Sphe, Nov 4: the V1 / V2 pills "changed significantly"): a click
 * shows one, and the one that ships is marked Final, on its own tile.
 */
function Versions({ thumb, picture, tick, running, onShow, onFinal }: { thumb: Thumbnail; picture: (source: string) => HTMLImageElement | null; tick: number; running: boolean; onShow: (version: string) => void; onFinal: (version: string) => void }) {
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
                  showing={version.id === thumb.activeVersion}
                  final={version.id === thumb.finalVersion}
                  running={running}
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

// One full-size canvas every tile draws on before it's scaled into its own.
let full: HTMLCanvasElement | null = null;

function VersionTile({ version, design, showing, final, running, picture, tick, onShow, onFinal }: { version: ThumbVersion; design: Design; showing: boolean; final: boolean; running: boolean; picture: (source: string) => HTMLImageElement | null; tick: number; onShow: () => void; onFinal: () => void }) {
  const small = useRef<HTMLCanvasElement>(null);
  const shape = JSON.stringify(design);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const target = small.current?.getContext("2d");
      if (!target) return;
      full ??= surface(WIDTH, HEIGHT);
      draw(full, settleCaptions(JSON.parse(shape) as Design), picture);
      target.imageSmoothingQuality = "high";
      target.drawImage(full, 0, 0, target.canvas.width, target.canvas.height);
    });
    return () => cancelAnimationFrame(frame);
  }, [shape, picture, tick]);
  // While Claude works it changes the version showing: another isn't shown until it's done.
  const locked = running && !showing;
  return (
    <motion.div layout initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={spring} className="group flex w-[clamp(120px,13vw,176px)] shrink-0 flex-col gap-1.5">
      <button
        type="button"
        title={locked ? "Claude is working on the version showing" : showing ? `${version.name} is showing` : `Show ${version.name}`}
        disabled={locked}
        onClick={() => !showing && onShow()}
        className={cx(
          "relative aspect-video overflow-hidden rounded-lg bg-panel ring-offset-2 ring-offset-black transition-[box-shadow,opacity] duration-200",
          showing ? "ring-2 ring-white" : "ring-1 ring-line hover:ring-line-strong",
          locked && "opacity-50",
        )}
      >
        <canvas ref={small} width={352} height={198} className="block size-full" />
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

function Chat({ id, thumb, upload, onAsked }: { id: string; thumb: Thumbnail; upload: Uploader; onAsked: () => void }) {
  const toastError = useEditor((state) => state.toastError);
  const running = working(thumb);
  const entries = conversationEntries(thumb.chat, thumb.createdAt, running ? thumb.run : null, (turn) => (turn.images ?? []).map((image) => ({ name: thumb.images.find((one) => one.id === image)?.name ?? "picture", kind: "image" as const, url: sourceUrl(thumb.id, image) })));
  const { turns, known } = useChatTurns(id, entries, running);
  const quiet = running && thumb.run !== null && thumb.run.trace === undefined && thumb.run.tools === undefined && thumb.run.said === undefined;
  const other = quiet ? ` · on ${thumb.run?.holder}` : "";
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
          onSend={(message, files) => void thumbnailsApi.chat(id, message, files.map((one) => one.landed as string)).then(onAsked, (error: unknown) => toastError(error, "ask Claude"))}
          onStop={() => void thumbnailsApi.stop(id).then(onAsked, (error: unknown) => toastError(error, "stop it"))}
        />
      }
    >
      {entries.length === 0 ? (
        <Empty title="Make a thumbnail with Claude" detail="Drop in a frame or a thumbnail and say what you want: “clean this base and put the REC overlay on”, “three versions of the mom at the door”, “add ‘he abused me’ in a black box”, “a touch brighter”." />
      ) : (
        <ChatTurns turns={turns} known={known} thinking={running ? `Thinking${other}` : undefined} />
      )}
    </ChatShell>
  );
}
