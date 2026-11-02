// A thumbnail's page (Nov 2 2026): the canvas in the middle (drawn by the same
// code Claude's looks use), its layers and pictures on the left, the selected
// layer's controls under the canvas (Photoshop's few the team uses:
// exposure, contrast, saturation… a caption's box, stroke and drop shadow
// with its spread), the conversation with Claude on the right. Pictures
// dropped or pasted anywhere join the thumbnail and go to Claude with the
// next message.

import { ArrowDown, ArrowLeft, ArrowUp, Download, Eye, EyeOff, Image as ImageIcon, Layers, MoreHorizontal, Paperclip, Plus, Trash2, Type, Upload, X } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChatComposer, ChatLoading, ChatTurns, Empty } from "../components/AgentPanel";
import { AppMenu } from "../components/AppMenu";
import { toggleMenu } from "../components/ContextMenu";
import { Button, cx, IconButton, Modal, Scrub, Select, Spinner, Switch } from "../components/ui";
import type { AgentEntry } from "../lib/agent";
import { buildTurns } from "../lib/agentTurns";
import { navigate } from "../lib/route";
import { useEditor } from "../lib/store";
import { sourceUrl, thumbnailsApi, working, type Adjust, type Asset, type Design, type ImageLayer, type Layer, type Shadow, type TextLayer, type Thumbnail } from "../lib/thumbnails";
import { drawThumbnail, textBounds, type Context as DrawContext } from "@edit/types/thumbnail_render";
import { FONTS, HEIGHT, NO_ADJUST, WIDTH } from "@edit/types/thumbnails";

const newId = () => Math.random().toString(36).slice(2, 10);

// Montserrat ships with Edit (the server has it); the other fonts are the Mac's own.
let fontsAdded = false;
function addFonts(): void {
  if (fontsAdded) return;
  fontsAdded = true;
  const face = new FontFace("Montserrat", 'url("/api/thumbnails/fonts/Montserrat.ttf")', { weight: "100 900" });
  void face.load().then((loaded) => document.fonts.add(loaded), () => {});
}

// ---------------------------------------------------------------- pictures, as the canvas loads them

const loaded = new Map<string, HTMLImageElement | null>();
function usePictures(id: string, design: Design | null): [(source: string) => HTMLImageElement | null, number] {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    for (const layer of design?.layers ?? []) {
      if (layer.kind !== "image") continue;
      const url = sourceUrl(id, layer.source);
      if (loaded.has(url)) continue;
      loaded.set(url, null);
      const image = new Image();
      image.onload = () => {
        loaded.set(url, image);
        setTick((n) => n + 1);
      };
      image.src = url;
    }
  }, [id, design]);
  return [(source) => loaded.get(sourceUrl(id, source)) ?? null, tick];
}

function draw(canvas: HTMLCanvasElement, design: Design, picture: (source: string) => HTMLImageElement | null): void {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return;
  drawThumbnail(context as unknown as DrawContext, design, {
    picture,
    canvas: (width, height) => {
      const made = document.createElement("canvas");
      made.width = width;
      made.height = height;
      return made;
    },
  }, WIDTH, HEIGHT);
}

/** A layer's box on the canvas (before rotation), for picking and its handles. */
function boundsOf(layer: Layer): { x: number; y: number; width: number; height: number } {
  if (layer.kind === "image") return { x: layer.x, y: layer.y, width: layer.width, height: layer.height };
  const scratch = document.createElement("canvas").getContext("2d")!;
  const box = textBounds(scratch as unknown as DrawContext, layer);
  const pad = layer.box ? { x: layer.box.padX, y: layer.box.padY } : { x: 0, y: 0 };
  return { x: box.x - pad.x, y: box.y - pad.y, width: box.width + pad.x * 2, height: box.height + pad.y * 2 };
}

// ---------------------------------------------------------------- the screen

export function ThumbnailScreen({ id }: { id: string }) {
  const [thumb, setThumb] = useState<Thumbnail | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [design, setDesign] = useState<Design | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [library, setLibrary] = useState<Asset[]>([]);
  const [attached, setAttached] = useState<string[]>([]);
  const [uploading, setUploading] = useState(0);
  const [saving, setSaving] = useState<"saving" | "saved" | "error" | null>(null);
  const [credits, setCredits] = useState<string | null>(null);
  const toastError = useEditor((state) => state.toastError);
  // Edits not saved yet: the server's design doesn't replace them.
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const history = useRef<{ past: Design[]; future: Design[] }>({ past: [], future: [] });
  const canvas = useRef<HTMLCanvasElement>(null);

  const load = useCallback(
    () =>
      thumbnailsApi
        .get(id)
        .then(({ thumb }) => {
          setThumb(thumb);
          setMissing(null);
          if (!dirty.current) setDesign(thumb.design);
        })
        .catch((error: unknown) => setMissing((error as Error).message)),
    [id],
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
  const loadLibrary = useCallback(() => thumbnailsApi.assets().then(({ assets }) => setLibrary(assets), () => {}), []);
  useEffect(() => {
    void loadLibrary();
    void thumbnailsApi.openart().then(
      (account) => setCredits(account.credits === null ? null : `${account.credits.toLocaleString()} credits`),
      () => setCredits(null),
    );
  }, [loadLibrary]);

  const [picture, tick] = usePictures(id, design);
  useEffect(() => {
    if (canvas.current === null || design === null) return;
    const frame = requestAnimationFrame(() => draw(canvas.current!, design, picture));
    return () => cancelAnimationFrame(frame);
  }, [design, tick, picture]);

  /** The person's change: drawn at once, saved a moment after the last one (and its drawing kept as the list's picture). */
  const change = (next: Design, keep = true) => {
    if (design !== null && keep) {
      history.current.past = [...history.current.past.slice(-60), design];
      history.current.future = [];
    }
    dirty.current = true;
    setDesign(next);
    setSaving("saving");
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void thumbnailsApi
        .change(id, { design: next })
        .then(async ({ thumb }) => {
          setThumb(thumb);
          dirty.current = false;
          setSaving("saved");
          const png = await new Promise<Blob | null>((resolve) => canvas.current?.toBlob(resolve, "image/png") ?? resolve(null));
          if (png !== null) await thumbnailsApi.saveRender(id, png).catch(() => {});
        })
        .catch((error: unknown) => {
          setSaving("error");
          toastError(error, "save the thumbnail");
        });
    }, 700);
  };
  const undo = () => {
    const last = history.current.past.pop();
    if (last === undefined || design === null) return;
    history.current.future.push(design);
    change(last, false);
  };
  const redo = () => {
    const next = history.current.future.pop();
    if (next === undefined || design === null) return;
    history.current.past.push(design);
    change(next, false);
  };
  const changeLayer = (layerId: string, patch: Partial<ImageLayer> | Partial<TextLayer>, keep = true) => {
    if (design === null) return;
    change({ layers: design.layers.map((one) => (one.id === layerId ? ({ ...one, ...patch } as Layer) : one)) }, keep);
  };
  const addLayer = (layer: Layer, bottom = false) => {
    if (design === null) return;
    change({ layers: bottom ? [layer, ...design.layers] : [...design.layers, layer] });
    setSelected(layer.id);
  };

  const upload = async (files: File[], attach: boolean) => {
    setUploading((n) => n + files.length);
    for (const file of files) {
      try {
        const { image, thumb } = await thumbnailsApi.upload(id, file);
        setThumb(thumb);
        if (attach) setAttached((last) => [...last, image.id]);
      } catch (error) {
        toastError(error, "add the picture");
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  // Pictures dropped or pasted anywhere on the page: given to Claude with the next message.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
      if (files.length === 0) return;
      event.preventDefault();
      void upload(files, true);
    };
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName));
      if (typing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if ((event.key === "Backspace" || event.key === "Delete") && selected !== null && design !== null) {
        event.preventDefault();
        change({ layers: design.layers.filter((one) => one.id !== selected) });
        setSelected(null);
      } else if (selected !== null && design !== null && event.key.startsWith("Arrow")) {
        const layer = design.layers.find((one) => one.id === selected);
        if (layer === undefined) return;
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        changeLayer(layer.id, { x: layer.x + dx, y: layer.y + dy });
      }
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
        if (blob === null) return;
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `${(thumb?.title || "thumbnail").replace(/[^\w -]+/g, "").trim() || "thumbnail"}.${type === "image/png" ? "png" : "jpg"}`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      },
      type,
      0.92,
    );
  };

  const layer = design?.layers.find((one) => one.id === selected) ?? null;
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
        void upload(files, true);
      }}
    >
      <Header
        thumb={thumb}
        saving={saving}
        credits={credits}
        onTitle={(title) =>
          void thumbnailsApi.change(id, { title }).then(
            ({ thumb }) => setThumb(thumb),
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
      <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
        <aside className="flex w-[244px] shrink-0 flex-col gap-2 overflow-y-auto pt-2">
          {thumb !== null && design !== null && (
            <>
              <LayersPanel design={design} selected={selected} onSelect={setSelected} onChange={change} onAddText={() => addLayer(newText())} />
              <PicturesPanel
                thumb={thumb}
                uploading={uploading}
                onUpload={(files) => void upload(files, false)}
                onUse={(imageId, how) => {
                  if (how === "base") {
                    const bottom = design.layers[0];
                    if (bottom?.kind === "image" && !bottom.source.startsWith("asset:")) changeLayer(bottom.id, { source: imageId, fit: "cover", x: 0, y: 0, width: WIDTH, height: HEIGHT });
                    else addLayer({ id: newId(), kind: "image", name: "base", opacity: 100, source: imageId, x: 0, y: 0, width: WIDTH, height: HEIGHT, fit: "cover" }, true);
                  } else {
                    const image = thumb.images.find((one) => one.id === imageId);
                    const width = 480;
                    const height = image !== undefined ? Math.round((width * image.height) / image.width) : 270;
                    addLayer({ id: newId(), kind: "image", name: image?.name ?? "picture", opacity: 100, source: imageId, x: (WIDTH - width) / 2, y: (HEIGHT - height) / 2, width, height, fit: "contain" });
                  }
                }}
                onAttach={(imageId) => setAttached((last) => (last.includes(imageId) ? last : [...last, imageId]))}
                onRemove={(imageId) =>
                  void thumbnailsApi.removeImage(id, imageId).then(
                    ({ thumb }) => setThumb(thumb),
                    (error: unknown) => toastError(error, "remove the picture"),
                  )
                }
              />
              <LibraryPanel
                library={library}
                onAdd={(asset) => addLayer({ id: newId(), kind: "image", name: asset.name, opacity: 100, source: `asset:${asset.id}`, ...(asset.kind === "overlay" ? { x: 0, y: 0, width: WIDTH, height: HEIGHT, fit: "stretch" as const } : { x: (WIDTH - 320) / 2, y: (HEIGHT - (320 * asset.height) / asset.width) / 2, width: 320, height: (320 * asset.height) / asset.width, fit: "contain" as const }) })}
                onChanged={() => void loadLibrary()}
              />
            </>
          )}
        </aside>
        <main className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto pt-2">
          {thumb === null || design === null ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-white/40">{missing ?? <Spinner size={20} />}</div>
          ) : (
            <>
              <Stage canvas={canvas} design={design} selected={selected} onSelect={setSelected} onMove={(layerId, patch, keep) => changeLayer(layerId, patch, keep)} running={running} step={thumb.run?.step} />
              {layer !== null ? <Inspector key={layer.id} layer={layer} onChange={(patch, keep) => changeLayer(layer.id, patch, keep)} /> : <Hint empty={design.layers.length === 0} />}
            </>
          )}
        </main>
        <aside className="w-[380px] shrink-0 pt-2">
          {thumb === null ? (
            <ChatShell loading />
          ) : (
            <Chat
              id={id}
              thumb={thumb}
              attached={attached}
              onDetach={(imageId) => setAttached((last) => last.filter((one) => one !== imageId))}
              onAttachFiles={(files) => void upload(files, true)}
              onAsked={() => {
                setAttached([]);
                void load();
              }}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

const newText = (): TextLayer => ({ id: newId(), kind: "text", name: "caption", opacity: 100, text: "Your words", x: WIDTH / 2, y: 140, width: 900, font: "Montserrat", weight: 800, size: 72, color: "#ffffff", align: "center", lineHeight: 1.05, box: { color: "#000000", opacity: 100, padX: 22, padY: 10, radius: 0 } });

// ---------------------------------------------------------------- the header

function Header({ thumb, saving, credits, onTitle, onDownload, onDelete }: { thumb: Thumbnail | null; saving: string | null; credits: string | null; onTitle: (title: string) => void; onDownload: (type: "image/png" | "image/jpeg") => void; onDelete: () => void }) {
  const [title, setTitle] = useState(thumb?.title ?? "");
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setTitle(thumb?.title ?? ""), [thumb?.title]);
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 px-3">
      <IconButton label="Thumbnails" onClick={() => navigate("/thumbnails")}>
        <ArrowLeft size={16} />
      </IconButton>
      <input
        value={title}
        placeholder="New thumbnail"
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => title !== (thumb?.title ?? "") && onTitle(title)}
        onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
        className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-2 text-[14px] font-semibold text-fg outline-none placeholder:text-faint hover:bg-hover focus:bg-hover"
      />
      <span className="text-[12px] text-faint">{saving === "saving" ? "Saving…" : saving === "error" ? "Not saved" : saving === "saved" ? "Saved" : ""}</span>
      {credits !== null && <span title="The team's OpenArt account (mamagi-openart-1)" className="rounded-full border border-line px-2 py-0.5 text-[12px] text-muted">OpenArt · {credits}</span>}
      <Button
        variant="subtle"
        size="sm"
        disabled={thumb === null}
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
      <Modal open={confirm} onClose={() => setConfirm(false)} width={380}>
        <div className="p-5">
          <h2 className="text-[15px] font-semibold">Delete this thumbnail?</h2>
          <p className="mt-1.5 text-[13px] text-muted">It goes for everyone on the team, with its pictures and conversation.</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirm(false);
                onDelete();
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </Modal>
    </header>
  );
}

// ---------------------------------------------------------------- the canvas

function Stage({ canvas, design, selected, onSelect, onMove, running, step }: { canvas: React.RefObject<HTMLCanvasElement | null>; design: Design; selected: string | null; onSelect: (id: string | null) => void; onMove: (id: string, patch: Partial<ImageLayer> | Partial<TextLayer>, keep: boolean) => void; running: boolean; step?: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  useEffect(() => {
    const node = frame.current;
    if (node === null) return;
    const observer = new ResizeObserver(() => setScale(node.clientWidth / WIDTH));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const drag = useRef<{ id: string; mode: "move" | "resize"; x: number; y: number; start: Layer; kept: boolean } | null>(null);
  const layer = design.layers.find((one) => one.id === selected) ?? null;
  const box = layer !== null ? boundsOf(layer) : null;
  const pointAt = (event: ReactPointerEvent) => {
    const rect = frame.current!.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
  };
  const pick = (x: number, y: number): Layer | null => {
    for (const one of [...design.layers].reverse()) {
      if (one.hidden) continue;
      const bounds = boundsOf(one);
      // A full-canvas overlay isn't picked by a click through it: what's under it is.
      if (one.kind === "image" && one.source.startsWith("asset:") && bounds.width >= WIDTH && bounds.height >= HEIGHT) continue;
      if (x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height) return one;
    }
    return null;
  };
  const begin = (event: ReactPointerEvent, mode: "move" | "resize", target: Layer) => {
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    const point = pointAt(event);
    drag.current = { id: target.id, mode, x: point.x, y: point.y, start: structuredClone(target), kept: false };
  };
  const move = (event: ReactPointerEvent) => {
    const state = drag.current;
    if (state === null) return;
    const point = pointAt(event);
    const dx = point.x - state.x;
    const dy = point.y - state.y;
    if (!state.kept && Math.abs(dx) + Math.abs(dy) < 2) return;
    const keep = !state.kept;
    state.kept = true;
    const start = state.start;
    if (state.mode === "move") onMove(state.id, { x: Math.round(start.x + dx), y: Math.round(start.y + dy) }, keep);
    else if (start.kind === "image") {
      // From the bottom-right corner; the picture keeps its shape unless Shift is held.
      let width = Math.max(20, start.width + dx);
      let height = Math.max(20, start.height + dy);
      if (!event.shiftKey) height = (width * start.height) / start.width;
      else width = Math.max(20, width);
      onMove(state.id, { width: Math.round(width), height: Math.round(height) }, keep);
    } else {
      const bounds = boundsOf(start);
      const factor = Math.max(0.1, (bounds.width + dx * 2) / bounds.width);
      onMove(state.id, { size: Math.round(Math.max(8, start.size * factor)), width: Math.round(Math.max(40, start.width * factor)) }, keep);
    }
  };
  return (
    <div className="relative">
      <div
        ref={frame}
        className="relative aspect-video w-full overflow-hidden rounded-lg bg-[#0d0d0d] ring-1 ring-line select-none"
        onPointerDown={(event) => {
          const point = pointAt(event);
          const hit = pick(point.x, point.y);
          onSelect(hit?.id ?? null);
          if (hit !== null) begin(event, "move", hit);
        }}
        onPointerMove={move}
        onPointerUp={() => (drag.current = null)}
      >
        <canvas ref={canvas} width={WIDTH} height={HEIGHT} className="block size-full" />
        {box !== null && layer !== null && (
          <div className="pointer-events-none absolute border border-sky-400" style={{ left: box.x * scale, top: box.y * scale, width: box.width * scale, height: box.height * scale }}>
            <div
              className="pointer-events-auto absolute -right-1.5 -bottom-1.5 size-3 cursor-nwse-resize rounded-sm border border-sky-400 bg-white"
              onPointerDown={(event) => begin(event, "resize", layer)}
              onPointerMove={move}
              onPointerUp={() => (drag.current = null)}
            />
          </div>
        )}
        {design.layers.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-[13px] text-white/45">
            <ImageIcon size={26} />
            Drop a frame or a thumbnail here, or ask Claude for one.
          </div>
        )}
        {running && (
          <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[12px] text-white">
            <Spinner size={11} /> {step ?? "Claude is working"}
          </div>
        )}
      </div>
    </div>
  );
}

function Hint({ empty }: { empty: boolean }) {
  return <p className="px-1 text-[12px] text-faint">{empty ? "Ask Claude in the chat, or drop a picture in and choose Use as base." : "Click a layer on the canvas or in Layers to change it. Drag to move, the corner to resize; arrows nudge, ⌘Z undoes."}</p>;
}

// ---------------------------------------------------------------- the panels

function Panel({ title, icon, action, children }: { title: string; icon: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel">
      <div className="flex h-9 items-center gap-1.5 px-2.5 text-[12px] font-medium text-secondary">
        {icon}
        <span className="flex-1">{title}</span>
        {action}
      </div>
      <div className="px-1.5 pb-1.5">{children}</div>
    </section>
  );
}

function LayersPanel({ design, selected, onSelect, onChange, onAddText }: { design: Design; selected: string | null; onSelect: (id: string | null) => void; onChange: (design: Design) => void; onAddText: () => void }) {
  const move = (index: number, by: number) => {
    const layers = [...design.layers];
    const [one] = layers.splice(index, 1);
    layers.splice(index + by, 0, one!);
    onChange({ layers });
  };
  return (
    <Panel
      title="Layers"
      icon={<Layers size={13} />}
      action={
        <IconButton label="Add text" onClick={onAddText} className="size-6">
          <Type size={13} />
        </IconButton>
      }
    >
      {design.layers.length === 0 ? (
        <p className="px-1.5 pb-1 text-[12px] text-faint">None yet.</p>
      ) : (
        [...design.layers]
          .map((layer, index) => ({ layer, index }))
          .reverse()
          .map(({ layer, index }) => (
            <div key={layer.id} onClick={() => onSelect(layer.id)} className={cx("group flex h-8 cursor-default items-center gap-1.5 rounded-md px-1.5 text-[12px]", selected === layer.id ? "bg-active text-fg" : "text-secondary hover:bg-hover")}>
              {layer.kind === "text" ? <Type size={12} className="shrink-0 text-faint" /> : <ImageIcon size={12} className="shrink-0 text-faint" />}
              <span className={cx("min-w-0 flex-1 truncate", layer.hidden && "opacity-40")}>{layer.kind === "text" ? layer.text : layer.name}</span>
              <span className="hidden items-center group-hover:flex">
                <IconButton label="Up" disabled={index === design.layers.length - 1} onClick={(event) => (event.stopPropagation(), move(index, 1))} className="size-5">
                  <ArrowUp size={11} />
                </IconButton>
                <IconButton label="Down" disabled={index === 0} onClick={(event) => (event.stopPropagation(), move(index, -1))} className="size-5">
                  <ArrowDown size={11} />
                </IconButton>
                <IconButton label="Delete" onClick={(event) => (event.stopPropagation(), onChange({ layers: design.layers.filter((one) => one.id !== layer.id) }))} className="size-5">
                  <Trash2 size={11} />
                </IconButton>
              </span>
              <IconButton label={layer.hidden ? "Show" : "Hide"} onClick={(event) => (event.stopPropagation(), onChange({ layers: design.layers.map((one) => (one.id === layer.id ? ({ ...one, hidden: !one.hidden } as Layer) : one)) }))} className="size-5">
                {layer.hidden ? <EyeOff size={11} /> : <Eye size={11} />}
              </IconButton>
            </div>
          ))
      )}
    </Panel>
  );
}

function filesOf(input: HTMLInputElement): File[] {
  const files = [...(input.files ?? [])].filter((file) => file.type.startsWith("image/"));
  input.value = "";
  return files;
}

function PicturesPanel({ thumb, uploading, onUpload, onUse, onAttach, onRemove }: { thumb: Thumbnail; uploading: number; onUpload: (files: File[]) => void; onUse: (id: string, how: "base" | "layer") => void; onAttach: (id: string) => void; onRemove: (id: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <Panel
      title="Pictures"
      icon={<ImageIcon size={13} />}
      action={
        <IconButton label="Add pictures" onClick={() => input.current?.click()} className="size-6">
          {uploading > 0 ? <Spinner size={12} /> : <Plus size={13} />}
        </IconButton>
      }
    >
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(event) => onUpload(filesOf(event.currentTarget))} />
      {thumb.images.length === 0 ? (
        <p className="px-1.5 pb-1 text-[12px] text-faint">Drop or paste frames and thumbnails anywhere; Claude's pictures land here too.</p>
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          {[...thumb.images].reverse().map((image) => (
            <button
              key={image.id}
              title={image.prompt ?? image.name}
              onClick={(event) =>
                toggleMenu(
                  event.currentTarget,
                  [
                    { label: "Use as base", onSelect: () => onUse(image.id, "base") },
                    { label: "Add on top", onSelect: () => onUse(image.id, "layer") },
                    { label: "Give to Claude", onSelect: () => onAttach(image.id) },
                    { label: "Open full size", onSelect: () => window.open(sourceUrl(thumb.id, image.id), "_blank") },
                    { label: "Remove", danger: true, onSelect: () => onRemove(image.id) },
                  ],
                  { width: 170 },
                )
              }
              className="relative aspect-video overflow-hidden rounded-md bg-black ring-1 ring-line hover:ring-line-strong"
            >
              <img src={sourceUrl(thumb.id, image.id)} alt={image.name} loading="lazy" className="size-full object-cover" />
              {image.from === "openart" && <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[10px] text-white/80">OpenArt</span>}
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}

function LibraryPanel({ library, onAdd, onChanged }: { library: Asset[]; onAdd: (asset: Asset) => void; onChanged: () => void }) {
  const [adding, setAdding] = useState<File | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const toastError = useEditor((state) => state.toastError);
  return (
    <Panel
      title="Overlays"
      icon={<Layers size={13} />}
      action={
        <IconButton label="Upload an overlay" onClick={() => input.current?.click()} className="size-6">
          <Upload size={13} />
        </IconButton>
      }
    >
      <input ref={input} type="file" accept="image/png,image/webp,image/jpeg" hidden onChange={(event) => setAdding(filesOf(event.currentTarget)[0] ?? null)} />
      <div className="grid grid-cols-2 gap-1.5">
        {library.map((asset) => (
          <button
            key={asset.id}
            title={asset.note}
            onClick={(event) =>
              toggleMenu(
                event.currentTarget,
                [{ label: "Add on top", onSelect: () => onAdd(asset) }, ...(asset.builtIn ? [] : [{ label: "Remove from the library", danger: true, onSelect: () => void thumbnailsApi.removeAsset(asset.id).then(onChanged, (error: unknown) => toastError(error, "remove it")) }])],
                { width: 190 },
              )
            }
            className="flex flex-col gap-1 rounded-md p-1 text-left hover:bg-hover"
          >
            <span className="relative aspect-video w-full overflow-hidden rounded bg-[repeating-conic-gradient(#222_0_25%,#2c2c2c_0_50%)] bg-[length:12px_12px] ring-1 ring-line">
              <img src={`/api/thumbnails/assets/${encodeURIComponent(asset.id)}/file`} alt="" loading="lazy" className="size-full object-contain" />
            </span>
            <span className="truncate text-[11px] text-secondary">{asset.name}</span>
          </button>
        ))}
      </div>
      <AssetDialog
        file={adding}
        onClose={() => setAdding(null)}
        onAdded={() => {
          setAdding(null);
          onChanged();
        }}
      />
    </Panel>
  );
}

function AssetDialog({ file, onClose, onAdded }: { file: File | null; onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<Asset["kind"]>("overlay");
  const [busy, setBusy] = useState(false);
  const toastError = useEditor((state) => state.toastError);
  const preview = useMemo(() => (file === null ? null : URL.createObjectURL(file)), [file]);
  useEffect(() => {
    setName(file?.name.replace(/\.[a-z0-9]+$/i, "") ?? "");
    setNote("");
  }, [file]);
  return (
    <Modal open={file !== null} onClose={onClose} width={460}>
      <div className="flex flex-col gap-3 p-5">
        <h2 className="text-[15px] font-semibold">Add to the team's overlays</h2>
        {preview !== null && <img src={preview} alt="" className="aspect-video w-full rounded-md bg-[repeating-conic-gradient(#222_0_25%,#2c2c2c_0_50%)] bg-[length:12px_12px] object-contain ring-1 ring-line" />}
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} className="h-8 rounded-md border border-line bg-bg px-2 text-[13px] text-fg outline-none focus:border-line-strong" />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          What it is and where it goes (Claude reads this)
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} placeholder="A red arrow pointing left: put it beside the evidence it points at." className="rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] text-fg outline-none focus:border-line-strong" />
        </label>
        <div className="flex items-center gap-2 text-[12px] text-muted">
          Covers the whole picture
          <Switch checked={kind === "overlay"} onChange={(on) => setKind(on ? "overlay" : "sticker")} />
        </div>
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || file === null || name.trim() === ""}
            onClick={() => {
              if (file === null) return;
              setBusy(true);
              void thumbnailsApi
                .uploadAsset(file, name, note, kind)
                .then(onAdded, (error: unknown) => toastError(error, "add it"))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? <Spinner size={13} /> : null} Add
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- the inspector

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex h-7 items-center gap-2 text-[12px]">
      <span className="w-[86px] shrink-0 text-muted">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
    </label>
  );
}

/** A Photoshop slider: drag the bar, or scrub the number. */
function Slider({ label, value, min, max, onChange, onEnd, suffix }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void; onEnd: () => void; suffix?: string }) {
  return (
    <Row label={label}>
      <input type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} onPointerUp={onEnd} onKeyUp={onEnd} className="h-1 min-w-0 flex-1 accent-white" />
      <div className="w-14 shrink-0">
        <Scrub value={value} min={min} max={max} onChange={onChange} onEnd={onEnd} suffix={suffix} />
      </div>
    </Row>
  );
}

function ColorInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
  return (
    <span className="relative flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 hover:bg-hover">
      <span className="size-4 shrink-0 rounded-[5px] ring-1 ring-white/15" style={{ background: value }} />
      <span className="font-mono text-[12px] text-muted uppercase">{value.replace("#", "")}</span>
      <input type="color" value={hex} onChange={(event) => onChange(event.target.value)} className="absolute inset-0 opacity-0" />
    </span>
  );
}

function Group({ title, on, onToggle, children }: { title: string; on?: boolean; onToggle?: (on: boolean) => void; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-line bg-panel px-3 py-2">
      <div className="flex h-6 items-center justify-between text-[12px] font-medium text-secondary">
        {title}
        {onToggle !== undefined && <Switch checked={on === true} onChange={onToggle} />}
      </div>
      {(on === undefined || on) && children}
    </div>
  );
}

const ADJUSTMENTS: { key: keyof Adjust; label: string; min: number }[] = [
  { key: "exposure", label: "Exposure", min: -100 },
  { key: "contrast", label: "Contrast", min: -100 },
  { key: "saturation", label: "Saturation", min: -100 },
  { key: "warmth", label: "Warmth", min: -100 },
  { key: "shadows", label: "Shadows", min: -100 },
  { key: "highlights", label: "Highlights", min: -100 },
  { key: "vignette", label: "Vignette", min: 0 },
  { key: "sharpen", label: "Sharpen", min: 0 },
];

const DEFAULT_SHADOW: Shadow = { color: "#000000", opacity: 75, angle: 120, distance: 6, spread: 20, size: 18 };

function ShadowGroup({ shadow, set }: { shadow: Shadow | undefined; set: (shadow: Shadow | undefined, keep: boolean) => void }) {
  const value = shadow ?? DEFAULT_SHADOW;
  const one = (key: keyof Shadow, label: string, min: number, max: number, suffix?: string) => (
    <Slider label={label} value={value[key] as number} min={min} max={max} suffix={suffix} onChange={(next) => set({ ...value, [key]: next }, false)} onEnd={() => set({ ...value }, true)} />
  );
  return (
    <Group title="Drop shadow" on={shadow !== undefined} onToggle={(on) => set(on ? DEFAULT_SHADOW : undefined, true)}>
      <Row label="Colour">
        <ColorInput value={value.color} onChange={(color) => set({ ...value, color }, true)} />
      </Row>
      {one("opacity", "Opacity", 0, 100, "%")}
      {one("angle", "Angle", -180, 180, "°")}
      {one("distance", "Distance", 0, 100, "px")}
      {one("spread", "Spread", 0, 100, "%")}
      {one("size", "Size", 0, 150, "px")}
    </Group>
  );
}

function Inspector({ layer, onChange }: { layer: Layer; onChange: (patch: Partial<ImageLayer> | Partial<TextLayer>, keep: boolean) => void }) {
  // A slider's drag changes the canvas as it moves; one step of undo when it's let go.
  const started = useRef(false);
  const live = (patch: Partial<ImageLayer> | Partial<TextLayer>) => {
    onChange(patch, !started.current);
    started.current = true;
  };
  const done = () => (started.current = false);
  const set = (patch: Partial<ImageLayer> | Partial<TextLayer>, keep: boolean) => (keep ? (done(), onChange(patch, true)) : live(patch));
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-2 pb-2">
      <Group title={layer.kind === "text" ? "Text" : "Picture"}>
        {layer.kind === "text" ? (
          <>
            <textarea value={layer.text} rows={2} onChange={(event) => live({ text: event.target.value })} onBlur={done} className="mb-1 rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] text-fg outline-none focus:border-line-strong" />
            <Row label="Font">
              <Select value={layer.font} options={FONTS.map((one) => ({ value: one.family as string, label: one.family }))} onChange={(font) => set({ font }, true)} />
            </Row>
            <Row label="Weight">
              <Select value={layer.weight} options={[400, 500, 600, 700, 800, 900].map((one) => ({ value: one, label: String(one) }))} onChange={(weight) => set({ weight }, true)} />
            </Row>
            <Slider label="Size" value={layer.size} min={12} max={240} suffix="px" onChange={(size) => live({ size })} onEnd={done} />
            <Slider label="Wraps at" value={layer.width} min={100} max={1280} suffix="px" onChange={(width) => live({ width })} onEnd={done} />
            <Row label="Colour">
              <ColorInput value={layer.color} onChange={(color) => set({ color }, true)} />
            </Row>
            <Row label="Align">
              <Select value={layer.align} options={[{ value: "left", label: "Left" }, { value: "center", label: "Centre" }, { value: "right", label: "Right" }]} onChange={(align) => set({ align }, true)} />
            </Row>
            <Row label="Capitals">
              <Switch checked={layer.uppercase === true} onChange={(uppercase) => set({ uppercase }, true)} />
            </Row>
          </>
        ) : (
          <>
            <Row label="Fit">
              <Select value={layer.fit} options={[{ value: "cover", label: "Fill (crop)" }, { value: "contain", label: "Fit inside" }, { value: "stretch", label: "Stretch" }]} onChange={(fit) => set({ fit }, true)} />
            </Row>
            {layer.fit === "cover" && (
              <>
                <Slider label="Zoom" value={Math.round((layer.zoom ?? 1) * 100)} min={100} max={400} suffix="%" onChange={(zoom) => live({ zoom: zoom / 100 })} onEnd={done} />
                <Slider label="Across" value={Math.round((layer.focusX ?? 0.5) * 100)} min={0} max={100} suffix="%" onChange={(focus) => live({ focusX: focus / 100 })} onEnd={done} />
                <Slider label="Down" value={Math.round((layer.focusY ?? 0.5) * 100)} min={0} max={100} suffix="%" onChange={(focus) => live({ focusY: focus / 100 })} onEnd={done} />
              </>
            )}
            <Row label="Flip">
              <Switch checked={layer.flip === true} onChange={(flip) => set({ flip }, true)} />
            </Row>
          </>
        )}
        <Slider label="Opacity" value={layer.opacity} min={0} max={100} suffix="%" onChange={(opacity) => live({ opacity })} onEnd={done} />
        <Slider label="Rotation" value={layer.rotation ?? 0} min={-180} max={180} suffix="°" onChange={(rotation) => live({ rotation })} onEnd={done} />
      </Group>
      {layer.kind === "image" ? (
        <Group title="Adjustments">
          {ADJUSTMENTS.map((one) => (
            <Slider key={one.key} label={one.label} value={layer.adjust?.[one.key] ?? 0} min={one.min} max={100} onChange={(value) => live({ adjust: { ...NO_ADJUST, ...layer.adjust, [one.key]: value } })} onEnd={done} />
          ))}
          <button onClick={() => set({ adjust: undefined }, true)} className="self-start rounded px-1 text-[12px] text-faint hover:text-fg">
            Reset
          </button>
        </Group>
      ) : (
        <>
          <Group title="Box behind" on={layer.box !== undefined} onToggle={(on) => set({ box: on ? { color: "#000000", opacity: 100, padX: 22, padY: 10, radius: 0 } : undefined }, true)}>
            {layer.box !== undefined && (
              <>
                <Row label="Colour">
                  <ColorInput value={layer.box.color} onChange={(color) => set({ box: { ...layer.box!, color } }, true)} />
                </Row>
                <Slider label="Opacity" value={layer.box.opacity} min={0} max={100} suffix="%" onChange={(opacity) => live({ box: { ...layer.box!, opacity } })} onEnd={done} />
                <Slider label="Padding" value={layer.box.padX} min={0} max={80} suffix="px" onChange={(padX) => live({ box: { ...layer.box!, padX, padY: Math.round(padX * 0.45) } })} onEnd={done} />
                <Slider label="Rounding" value={layer.box.radius} min={0} max={60} suffix="px" onChange={(radius) => live({ box: { ...layer.box!, radius } })} onEnd={done} />
              </>
            )}
          </Group>
          <Group title="Stroke" on={layer.stroke !== undefined} onToggle={(on) => set({ stroke: on ? { color: "#000000", width: 4 } : undefined }, true)}>
            {layer.stroke !== undefined && (
              <>
                <Row label="Colour">
                  <ColorInput value={layer.stroke.color} onChange={(color) => set({ stroke: { ...layer.stroke!, color } }, true)} />
                </Row>
                <Slider label="Width" value={layer.stroke.width} min={0} max={30} suffix="px" onChange={(width) => live({ stroke: { ...layer.stroke!, width } })} onEnd={done} />
              </>
            )}
          </Group>
        </>
      )}
      <ShadowGroup shadow={layer.shadow} set={(shadow, keep) => set({ shadow }, keep)} />
    </div>
  );
}

// ---------------------------------------------------------------- the conversation

function entriesOf(thumb: Thumbnail): { entries: AgentEntry[]; running: boolean } {
  const entries: AgentEntry[] = [];
  let asked = thumb.createdAt;
  thumb.chat.forEach((turn, index) => {
    if (turn.role === "you") {
      asked = turn.at;
      const pictures = turn.images?.length ? `${turn.text ? "\n\n" : ""}(${turn.images.length} ${turn.images.length === 1 ? "picture" : "pictures"})` : "";
      entries.push({ id: `turn-${index}`, kind: "user", text: `${turn.text}${pictures}`, at: turn.at });
      return;
    }
    const began = turn.workedMs !== undefined ? turn.at - turn.workedMs : asked;
    (turn.tools ?? []).forEach((tool, at) =>
      entries.push({ id: `turn-${index}-${at}`, kind: "tool", tool: tool.name, text: tool.detail ?? "", status: tool.state === "error" ? "failed" : tool.state === "running" ? "stopped" : "done", at: began, updated: began }),
    );
    entries.push({ id: `turn-${index}`, kind: turn.failed ? "error" : "assistant", text: turn.text, at: turn.at, updated: turn.at });
  });
  const run = thumb.run;
  const running = working(thumb);
  if (running && run !== null) {
    (run.tools ?? []).forEach((tool, at) => entries.push({ id: `live-${run.startedAt}-${at}`, kind: "tool", tool: tool.name, text: tool.detail ?? "", status: tool.state === "running" ? "running" : tool.state === "error" ? "failed" : "done", at: run.startedAt }));
    if (run.said) entries.push({ id: `live-${run.startedAt}-said`, kind: "assistant", text: run.said, at: run.startedAt });
  }
  return { entries, running };
}

function ChatShell({ loading, children }: { loading?: boolean; children?: ReactNode }) {
  return (
    <section className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-panel">
      {loading ? (
        <div className="min-h-0 flex-1 px-3 py-3">
          <ChatLoading />
        </div>
      ) : (
        children
      )}
    </section>
  );
}

function Chat({ id, thumb, attached, onDetach, onAttachFiles, onAsked }: { id: string; thumb: Thumbnail; attached: string[]; onDetach: (id: string) => void; onAttachFiles: (files: File[]) => void; onAsked: () => void }) {
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  const toastError = useEditor((state) => state.toastError);
  const { entries, running } = entriesOf(thumb);
  const turns = buildTurns(entries, running);
  const known = useRef<{ id: string; ids: Set<string> } | null>(null);
  if (known.current?.id !== id) known.current = { id, ids: new Set(entries.map((entry) => entry.id)) };
  useEffect(() => {
    const node = list.current;
    if (node && stick.current) node.scrollTop = node.scrollHeight;
  });
  const other = running && thumb.run !== null && thumb.run.tools === undefined && thumb.run.said === undefined ? ` · on ${thumb.run.holder}` : "";
  return (
    <ChatShell>
      <div
        ref={list}
        onScroll={(event) => {
          const node = event.currentTarget;
          stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        {entries.length === 0 ? (
          <Empty title="Make a thumbnail with Claude" detail="Drop in a frame or a thumbnail and say what you want: “clean this base and put the REC overlay on”, “three drafts of the mom at the door”, “add ‘He abused me’ in a black box”." />
        ) : (
          <ChatTurns turns={turns} known={known.current.ids} thinking={running ? `${thumb.run?.step ?? "Working"}${other}` : undefined} />
        )}
      </div>
      {attached.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-line px-3 pt-2">
          {attached.map((imageId) => (
            <span key={imageId} className="relative">
              <img src={sourceUrl(id, imageId)} alt="" className="h-12 w-[86px] rounded-md object-cover ring-1 ring-line" />
              <button onClick={() => onDetach(imageId)} aria-label="Take it out" className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-fg text-bg">
                <X size={10} strokeWidth={3} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1 px-3 pt-1.5">
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(event) => onAttachFiles(filesOf(event.currentTarget))} />
        <button onClick={() => input.current?.click()} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-faint hover:bg-hover hover:text-fg">
          <Paperclip size={12} /> Add pictures
        </button>
      </div>
      <ChatComposer
        running={running}
        disabled={false}
        modelName="Opus 5.5"
        placeholder={running ? "Working…" : "Ask for a thumbnail, or a change…"}
        draft={`thumbnails.chat-draft.${id}`}
        onSend={(message) => void thumbnailsApi.chat(id, message, attached).then(onAsked, (error: unknown) => toastError(error, "ask Claude"))}
        onStop={() => void thumbnailsApi.stop(id).then(onAsked, (error: unknown) => toastError(error, "stop it"))}
      />
    </ChatShell>
  );
}
