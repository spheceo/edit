// A thumbnail's page (Nov 2 2026): the canvas in the middle (drawn by the same
// code Claude's looks use), its layers and pictures on the left, the selected
// layer's controls under the canvas (Photoshop's few the team uses:
// exposure, contrast, saturation… a caption's box, stroke and drop shadow
// with its spread), the conversation with Claude on the right. Pictures
// dropped or pasted anywhere join the thumbnail and go to Claude with the
// next message.

import { ArrowDown, ArrowLeft, ArrowUp, Download, Eye, EyeOff, Image as ImageIcon, Layers, MoreHorizontal, Plus, Redo2, SlidersHorizontal, Sticker, Trash2, Type, Undo2, Upload } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ChatShell, ChatTurns, Empty, useChatTurns } from "../components/AgentPanel";
import { ChatComposer } from "../components/ChatComposer";
import { ChatDock } from "../components/ChatDock";
import { attachFiles, attachLanded, picturesOnly, postFile, type Uploader } from "../lib/chatFiles";
import { AppMenu } from "../components/AppMenu";
import { toggleMenu } from "../components/ContextMenu";
import { Badge, Button, Chip, ColorField, ConfirmDialog, cx, DialogTitle, DialogActions, Field, IconButton, Modal, Panel, Section, Select, Slider, Spinner, Switch, TextArea, TextField } from "../components/ui";
import { conversationEntries } from "../lib/agentTurns";
import { saveFile } from "../lib/files";
import { navigate } from "../lib/route";
import { useEditor } from "../lib/store";
import { sourceUrl, thumbnailsApi, working, type Adjust, type Asset, type Design, type ImageLayer, type Layer, type Shadow, type TextLayer, type Thumbnail } from "../lib/thumbnails";
import { drawThumbnail, textBounds, type Context as DrawContext } from "@edit/types/thumbnail_render";
import { BLACK_BOX_FONT, captionShadow, FONTS, HEIGHT, HOUSE_SHADOW, NO_ADJUST, WHITE_RED_FONT, WIDTH } from "@edit/types/thumbnails";

const newId = () => Math.random().toString(36).slice(2, 10);

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
      // Tried again with the next change, not never.
      image.onerror = () => loaded.delete(url);
      image.src = url;
    }
  }, [id, design]);
  const picture = useCallback((source: string) => loaded.get(sourceUrl(id, source)) ?? null, [id]);
  return [picture, tick];
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

let scratch: CanvasRenderingContext2D | null = null;

/** A layer's box on the canvas (before rotation), for picking and its handles. */
function boundsOf(layer: Layer): { x: number; y: number; width: number; height: number } {
  if (layer.kind === "image") return { x: layer.x, y: layer.y, width: layer.width, height: layer.height };
  scratch ??= document.createElement("canvas").getContext("2d")!;
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
  // The layer whose Camera Raw (a picture) or text dialog is open.
  const [openLayer, setOpenLayer] = useState<string | null>(null);
  // The picture whose big dialog is open (its options moved there).
  const [openPicture, setOpenPicture] = useState<string | null>(null);
  const [library, setLibrary] = useState<Asset[]>([]);
  const [uploading, setUploading] = useState(0);
  const [saving, setSaving] = useState<"saving" | "saved" | "error" | null>(null);
  const [credits, setCredits] = useState<string | null>(null);
  const toastError = useEditor((state) => state.toastError);
  const toast = useEditor((state) => state.toast);
  // Edits not saved yet: the server's design doesn't replace them.
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  // The last revision shown: a poll that brings the same one back changes nothing (and redraws nothing).
  const shownRev = useRef<number | null>(null);
  const load = useCallback(
    () =>
      thumbnailsApi
        .get(id)
        .then(({ thumb, rev }) => {
          setMissing(null);
          if (rev === shownRev.current) return;
          shownRev.current = rev;
          setThumb(thumb);
          if (!dirty.current) setDesign(settleCaptions(thumb.design));
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

  /** The thumbnail's drawing kept as the list's picture. */
  const keepDrawing = async () => {
    const png = await new Promise<Blob | null>((resolve) => canvas.current?.toBlob(resolve, "image/png") ?? resolve(null));
    if (png !== null) await thumbnailsApi.saveRender(id, png).catch(() => {});
  };
  // The person's change waiting to be saved: one save a moment after the last change, so a drag is one step of undo.
  const pending = useRef<Design | null>(null);
  const save = () => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next === null) return Promise.resolve();
    return thumbnailsApi
      .change(id, { design: next })
      .then(async ({ thumb, rev }) => {
        shownRev.current = rev;
        setThumb(thumb);
        if (pending.current === null) dirty.current = false;
        setSaving("saved");
        await keepDrawing();
      })
      .catch((error: unknown) => {
        setSaving("error");
        toastError(error, "save the thumbnail");
      });
  };
  /** The person's change: drawn at once, saved a moment after the last one. */
  const change = (next: Design) => {
    dirty.current = true;
    pending.current = next;
    setDesign(next);
    setSaving("saving");
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(), 700);
  };
  /**
   * Undo and redo walk the thumbnail's own timeline (Sphe, Nov 2: "we should have
   * undo both for us and for the agent"): the person's changes and Claude's
   * alike, newest first, whoever is on the page.
   */
  const [stepping, setStepping] = useState(false);
  const walk = async (back: boolean) => {
    if (stepping) return;
    setStepping(true);
    try {
      await save();
      const { thumb, rev, step } = await thumbnailsApi.step(id, back);
      shownRev.current = rev;
      setThumb(thumb);
      setDesign(settleCaptions(thumb.design));
      dirty.current = false;
      if (step === null) toast(back ? "Nothing to undo." : "Nothing to redo.");
      else {
        toast(`${back ? "Undid" : "Redid"}: ${step}`);
        requestAnimationFrame(() => void keepDrawing());
      }
    } catch (error) {
      toastError(error, back ? "undo" : "redo");
    } finally {
      setStepping(false);
    }
  };
  const undo = () => void walk(true);
  const redo = () => void walk(false);
  /** A version made or shown: its layout replaces what's drawn here. */
  const applyVersion = (next: Thumbnail) => {
    setThumb(next);
    setDesign(settleCaptions(next.design));
    setSelected(null);
    dirty.current = false;
  };
  const makeVersion = () =>
    void save()
      .then(() => thumbnailsApi.newVersion(id))
      .then(({ thumb, version }) => {
        applyVersion(thumb);
        toast(`Started ${version}: a copy of how it stands.`);
      }, (error: unknown) => toastError(error, "make a new version"));
  const showVersion = (version: string) =>
    void save()
      .then(() => thumbnailsApi.switchVersion(id, version))
      .then(({ thumb }) => applyVersion(thumb), (error: unknown) => toastError(error, "show that version"));
  const takeFinal = (version: string) =>
    void thumbnailsApi.takeFinal(id, version).then(({ thumb }) => {
      setThumb(thumb);
      toast(`${thumb.versions?.find((one) => one.id === thumb.finalVersion)?.name ?? version} is the final version.`);
    }, (error: unknown) => toastError(error, "take that version as final"));
  const changeLayer = (layerId: string, patch: Partial<ImageLayer> | Partial<TextLayer>) => {
    if (design === null) return;
    change({ layers: design.layers.map((one) => (one.id === layerId ? ({ ...one, ...patch } as Layer) : one)) });
  };
  const removeLayer = (layerId: string) => {
    if (design === null) return;
    change({ layers: design.layers.filter((one) => one.id !== layerId) });
    if (selected === layerId) setSelected(null);
  };
  const addLayer = (layer: Layer, bottom = false) => {
    if (design === null) return;
    change({ layers: bottom ? [layer, ...design.layers] : [...design.layers, layer] });
    setSelected(layer.id);
  };

  // The chat's uploader (lib/chatFiles.ts): a picture into the thumbnail's images, given to Claude with the message.
  const chatKey = `thumb:${id}`;
  const chatUpload = useMemo<Uploader>(
    () => async (file, progress, signal) => {
      const { image, thumb } = (await postFile(`/api/thumbnails/${encodeURIComponent(id)}/images?name=${encodeURIComponent(file.name)}`, file, progress, signal, { "content-type": file.type })) as { image: { id: string }; thumb: Thumbnail };
      setThumb(thumb);
      return image.id;
    },
    [id],
  );
  const attachToChat = (files: File[]) => {
    const refused = attachFiles(chatKey, files, chatUpload, picturesOnly);
    if (refused.length > 0) toastError(new Error(refused.join(" · ")), "attach the files");
  };
  const upload = async (files: File[]) => {
    setUploading((n) => n + files.length);
    for (const file of files) {
      try {
        const { thumb } = await thumbnailsApi.upload(id, file);
        setThumb(thumb);
      } catch (error) {
        toastError(error, "add the picture");
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  // Pictures dropped or pasted anywhere on the page: given to Claude with the next message.
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
      if (elsewhere(event.target)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if ((event.key === "Backspace" || event.key === "Delete") && selected !== null) {
        event.preventDefault();
        removeLayer(selected);
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
        if (blob !== null) void saveFile(`${(thumb?.title || "thumbnail").replace(/[^\w -]+/g, "").trim() || "thumbnail"}.${type === "image/png" ? "png" : "jpg"}`, blob);
      },
      type,
      0.92,
    );
  };

  const layer = design?.layers.find((one) => one.id === selected) ?? null;
  const opened = design?.layers.find((one) => one.id === openLayer) ?? null;
  const shownPicture = thumb?.images.find((one) => one.id === openPicture);
  // Each of the thumbnail's pictures on the canvas: the bottom one is its base.
  const used = new Map(design?.layers.flatMap((one, index) => (one.kind === "image" && !one.source.startsWith("asset:") ? [[one.source, index === 0 ? "Base" : "Used"] as const] : [])) ?? []);
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
        onUndo={undo}
        onRedo={redo}
        saving={saving}
        credits={credits}
        onTitle={(title) =>
          void thumbnailsApi.change(id, { title }).then(
            ({ thumb }) => setThumb(thumb),
            (error: unknown) => toastError(error, "rename it"),
          )
        }
        onDownload={download}
        onNewVersion={makeVersion}
        onDelete={() =>
          void thumbnailsApi.remove(id).then(
            () => navigate("/thumbnails"),
            (error: unknown) => toastError(error, "delete it"),
          )
        }
      />
      {/* No padding on the right: the chat's edge sits there. */}
      <div className="flex min-h-0 flex-1 pb-2 pl-2">
        <aside className="mr-2 flex w-[clamp(200px,17vw,244px)] shrink-0 flex-col gap-2 overflow-y-auto pt-2">
          {thumb !== null && design !== null && (
            <>
              <LayersPanel design={design} selected={selected} onSelect={setSelected} onOpen={setOpenLayer} onChange={change} onAddText={() => addLayer(newText())} />
              <PicturesPanel
                thumb={thumb}
                used={used}
                uploading={uploading}
                onUpload={(files) => void upload(files)}
                onOpen={setOpenPicture}
              />
              <LibraryPanel
                library={library}
                onAdd={(asset) => addLayer({ id: newId(), kind: "image", name: asset.name, opacity: 100, source: `asset:${asset.id}`, ...(asset.kind === "overlay" ? { x: 0, y: 0, width: WIDTH, height: HEIGHT, fit: "stretch" as const } : { x: (WIDTH - 320) / 2, y: (HEIGHT - (320 * asset.height) / asset.width) / 2, width: 320, height: (320 * asset.height) / asset.width, fit: "contain" as const }) })}
                onChanged={() => void loadLibrary()}
              />
            </>
          )}
        </aside>
        <main className="flex min-w-0 flex-1 flex-col gap-2 pt-2">
          {thumb === null || design === null ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-white/40">{missing ?? <Spinner size={20} />}</div>
          ) : (
            <>
              {(thumb.versions ?? []).length > 1 && (
                <Versions
                  thumb={thumb}
                  onShow={showVersion}
                  onFinal={takeFinal}
                  onNew={makeVersion}
                />
              )}
              <Stage canvas={canvas} design={design} selected={selected} onSelect={setSelected} onOpen={(layerId) => setOpenLayer(layerId)} onMove={changeLayer} running={running} step={thumb.run?.step} />
              <LayerBar layer={layer} onOpen={() => layer !== null && setOpenLayer(layer.id)} onDelete={() => layer !== null && removeLayer(layer.id)} />
              {shownPicture !== undefined && (
                <PictureDialog
                  thumbId={id}
                  image={shownPicture}
                  used={used.get(shownPicture.id) ?? null}
                  onClose={() => setOpenPicture(null)}
                  onUse={(how) => {
                    const image = shownPicture;
                    setOpenPicture(null);
                    if (how === "base") {
                      const bottom = design.layers[0];
                      if (bottom?.kind === "image" && !bottom.source.startsWith("asset:")) changeLayer(bottom.id, { source: image.id, fit: "cover", x: 0, y: 0, width: WIDTH, height: HEIGHT });
                      else addLayer({ id: newId(), kind: "image", name: "base", opacity: 100, source: image.id, x: 0, y: 0, width: WIDTH, height: HEIGHT, fit: "cover" }, true);
                    } else {
                      const width = 480;
                      const height = Math.round((width * image.height) / image.width);
                      addLayer({ id: newId(), kind: "image", name: image.name, opacity: 100, source: image.id, x: (WIDTH - width) / 2, y: (HEIGHT - height) / 2, width, height, fit: "contain" });
                    }
                  }}
                  onAttach={() => {
                    attachLanded(chatKey, { name: shownPicture.name, kind: "image", preview: sourceUrl(id, shownPicture.id), landed: shownPicture.id });
                    setOpenPicture(null);
                  }}
                  onRemove={() =>
                    void thumbnailsApi.removeImage(id, shownPicture.id).then(
                      ({ thumb }) => {
                        setThumb(thumb);
                        setOpenPicture(null);
                      },
                      (error: unknown) => toastError(error, "remove the picture"),
                    )
                  }
                />
              )}
              {opened !== null && (
                <LayerDialog
                  key={opened.id}
                  layer={opened}
                  design={design}
                  picture={picture}
                  tick={tick}
                  onClose={() => setOpenLayer(null)}
                  onApply={(next) => {
                    setOpenLayer(null);
                    const layer = next.kind === "text" && next.box === undefined ? (({ stroke: _stroke, ...rest }) => rest)(next) : next;
                    change({ layers: design.layers.map((one) => (one.id === layer.id ? layer : one)) });
                  }}
                />
              )}
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

const newText = (): TextLayer => ({ id: newId(), kind: "text", name: "caption", opacity: 100, text: "your words", x: WIDTH / 2, y: 140, width: 900, font: BLACK_BOX_FONT, weight: 700, size: 72, color: "#ffffff", align: "center", lineHeight: 1.05, box: { color: "#000000", opacity: 100, padX: 22, padY: 10, radius: 0 } });

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

// ---------------------------------------------------------------- the header

function Header({ thumb, onUndo, onRedo, saving, credits, onTitle, onDownload, onNewVersion, onDelete }: { thumb: Thumbnail | null; onUndo: () => void; onRedo: () => void; saving: "saving" | "saved" | "error" | null; credits: string | null; onTitle: (title: string) => void; onDownload: (type: "image/png" | "image/jpeg") => void; onNewVersion: () => void; onDelete: () => void }) {
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
      <span className="text-[12px] text-faint">{saving === "saving" ? "Saving…" : saving === "error" ? "Not saved" : saving === "saved" ? "Saved" : ""}</span>
      <div className="flex-1" />
      {credits !== null && (
        <Badge title="The team's OpenArt account (mamagi-openart-1)" className="mr-1.5">
          OpenArt · {credits}
        </Badge>
      )}
      <IconButton label={last ? `Undo ${who(last.by)}'s change: ${last.label} (⌘Z)` : "Nothing to undo"} disabled={last === undefined} onClick={onUndo}>
        <Undo2 size={15} />
      </IconButton>
      <IconButton label={next ? `Redo ${who(next.by)}'s change: ${next.label} (⇧⌘Z)` : "Nothing to redo"} disabled={next === undefined} onClick={onRedo}>
        <Redo2 size={15} />
      </IconButton>
      <Button
        variant="subtle"
        size="sm"
        className="ml-1.5"
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
      <IconButton label="More" onClick={(event) => toggleMenu(event.currentTarget, [{ label: "New version", icon: <Plus size={14} />, onSelect: onNewVersion }, { label: "Delete thumbnail", danger: true, icon: <Trash2 size={14} />, onSelect: () => setConfirm(true) }], { width: 180 })}>
        <MoreHorizontal size={16} />
      </IconButton>
      <AppMenu />
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete this thumbnail?"
        detail="It goes for everyone on the team, with its pictures and conversation."
        confirm="Delete"
        onConfirm={() => {
          setConfirm(false);
          onDelete();
        }}
      />
    </header>
  );
}

/** Its versions over the canvas, once it has more than one: the one showing, the final one, and a new one. */
function Versions({ thumb, onShow, onFinal, onNew }: { thumb: Thumbnail; onShow: (version: string) => void; onFinal: (version: string) => void; onNew: () => void }) {
  const showing = thumb.versions?.find((one) => one.id === thumb.activeVersion);
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 px-1">
      {(thumb.versions ?? []).map((version) => (
        <Chip key={version.id} active={version.id === thumb.activeVersion} onClick={() => version.id !== thumb.activeVersion && onShow(version.id)}>
          {version.name}
          {version.id === thumb.finalVersion && <Badge tone="success">Final</Badge>}
        </Chip>
      ))}
      <div className="flex-1" />
      {showing !== undefined && showing.id !== thumb.finalVersion && (
        <Button variant="ghost" size="sm" onClick={() => onFinal(showing.id)}>
          Take {showing.name} as final
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onNew}>
        <Plus size={13} /> New version
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- the canvas

function Stage({ canvas, design, selected, onSelect, onOpen, onMove, running, step }: { canvas: React.RefObject<HTMLCanvasElement | null>; design: Design; selected: string | null; onSelect: (id: string | null) => void; onOpen: (id: string) => void; onMove: (id: string, patch: Partial<ImageLayer> | Partial<TextLayer>) => void; running: boolean; step?: string }) {
  const area = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
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
  const scale = size.width / WIDTH;
  const drag = useRef<{ id: string; mode: "move" | "resize"; x: number; y: number; start: Layer; moved: boolean } | null>(null);
  const layer = design.layers.find((one) => one.id === selected) ?? null;
  // Whatever is picked shows where it is, the whole-canvas picture included.
  const box = layer !== null ? boundsOf(layer) : null;
  const pointAt = (event: ReactPointerEvent) => {
    const rect = frame.current!.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
  };
  const pick = (x: number, y: number): Layer | null => {
    for (const one of [...design.layers].reverse()) {
      if (one.hidden) continue;
      // A full-canvas overlay isn't picked by a click through it: what's under it is.
      if (one.kind === "image" && one.source.startsWith("asset:") && covers(one)) continue;
      const bounds = boundsOf(one);
      if (x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height) return one;
    }
    return null;
  };
  const begin = (event: ReactPointerEvent, mode: "move" | "resize", target: Layer) => {
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    const point = pointAt(event);
    drag.current = { id: target.id, mode, x: point.x, y: point.y, start: structuredClone(target), moved: false };
  };
  const move = (event: ReactPointerEvent) => {
    const state = drag.current;
    if (state === null) return;
    const point = pointAt(event);
    const dx = point.x - state.x;
    const dy = point.y - state.y;
    if (!state.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
    const start = state.start;
    // The picture under everything isn't dragged about by a click on it.
    if (state.mode === "move" && covers(start)) return;
    state.moved = true;
    if (state.mode === "move") onMove(state.id, { x: Math.round(start.x + dx), y: Math.round(start.y + dy) });
    else if (start.kind === "image") {
      // From the bottom-right corner; the picture keeps its shape unless Shift is held.
      const width = Math.max(20, start.width + dx);
      const height = event.shiftKey ? Math.max(20, start.height + dy) : (width * start.height) / start.width;
      onMove(state.id, { width: Math.round(width), height: Math.round(height) });
    } else {
      const bounds = boundsOf(start);
      const factor = Math.max(0.1, (bounds.width + dx * 2) / bounds.width);
      onMove(state.id, { size: Math.round(Math.max(8, start.size * factor)), width: Math.round(Math.max(40, start.width * factor)) });
    }
  };
  return (
    <div ref={area} className="flex min-h-0 flex-1 items-center justify-center">
      <div
        ref={frame}
        style={{ width: size.width, height: size.height }}
        className="relative shrink-0 select-none"
        onPointerDown={(event) => {
          const point = pointAt(event);
          const hit = pick(point.x, point.y);
          onSelect(hit?.id ?? null);
          if (hit !== null) begin(event, "move", hit);
        }}
        onDoubleClick={(event) => {
          const rect = frame.current!.getBoundingClientRect();
          const hit = pick((event.clientX - rect.left) / scale, (event.clientY - rect.top) / scale);
          if (hit !== null) onOpen(hit.id);
        }}
        onPointerMove={move}
        onPointerUp={() => (drag.current = null)}
      >
        <canvas ref={canvas} width={WIDTH} height={HEIGHT} className="block size-full rounded-lg bg-panel" />
        {box !== null && layer !== null && (
          <div className="pointer-events-none absolute outline outline-1 outline-white/80" style={{ left: box.x * scale, top: box.y * scale, width: box.width * scale, height: box.height * scale }}>
            {(["-top-1 -left-1", "-top-1 -right-1", "-bottom-1 -left-1"] as const).map((corner) => (
              <span key={corner} className={cx("absolute size-2 rounded-[2px] bg-white shadow-[0_0_0_1px_#0006]", corner)} />
            ))}
            <span
              className="pointer-events-auto absolute -right-1 -bottom-1 size-2 cursor-nwse-resize rounded-[2px] bg-white shadow-[0_0_0_1px_#0006]"
              onPointerDown={(event) => begin(event, "resize", layer)}
              onPointerMove={move}
              onPointerUp={() => (drag.current = null)}
            />
            <span className="absolute -bottom-7 left-1/2 -translate-x-1/2 rounded-[5px] bg-black/80 px-1.5 py-1 font-mono text-[10.5px] leading-none whitespace-nowrap text-white tabular">
              {Math.round(box.width)} × {Math.round(box.height)}
            </span>
          </div>
        )}
        {design.layers.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-[13px] text-faint">
            <ImageIcon size={26} />
            Drop a frame or a thumbnail here, or ask Claude for one.
          </div>
        )}
        {running && (
          <div className="pointer-events-none absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-black/75 px-2.5 py-1 text-[12px] text-white backdrop-blur-sm">
            <Spinner size={11} /> {step ?? "Claude is working"}
          </div>
        )}
      </div>
    </div>
  );
}

/** Whether a layer covers the whole canvas (the picture, a full overlay). */
const covers = (layer: Layer): boolean => layer.kind === "image" && layer.x <= 0 && layer.y <= 0 && layer.x + layer.width >= WIDTH && layer.y + layer.height >= HEIGHT;

/** Under the canvas: the selected layer, and the way into its dialog. */
function LayerBar({ layer, onOpen, onDelete }: { layer: Layer | null; onOpen: () => void; onDelete: () => void }) {
  if (layer === null) return <div className="h-9 shrink-0" />;
  return (
    <div className="flex h-9 shrink-0 items-center justify-center gap-2 px-1">
      <LayerIcon layer={layer} />
      <span className="max-w-[40%] min-w-0 truncate text-[13px] text-secondary">{layerName(layer)}</span>
      <Button variant="subtle" size="sm" onClick={onOpen}>
        <SlidersHorizontal size={13} /> {layer.kind === "text" ? "Text settings" : "Camera Raw"}
      </Button>
      <IconButton label="Delete layer" onClick={onDelete}>
        <Trash2 size={14} />
      </IconButton>
    </div>
  );
}

const layerName = (layer: Layer): string => (layer.kind === "text" ? layer.text : layer.name);

function LayerIcon({ layer }: { layer: Layer }) {
  const Icon = layer.kind === "text" ? Type : layer.source.startsWith("asset:") ? Sticker : ImageIcon;
  return <Icon size={13} className="shrink-0 text-faint" />;
}

// ---------------------------------------------------------------- the panels

function LayersPanel({ design, selected, onSelect, onOpen, onChange, onAddText }: { design: Design; selected: string | null; onSelect: (id: string | null) => void; onOpen: (id: string) => void; onChange: (design: Design) => void; onAddText: () => void }) {
  const move = (index: number, by: number) => {
    const layers = [...design.layers];
    const [one] = layers.splice(index, 1);
    layers.splice(index + by, 0, one!);
    onChange({ layers });
  };
  const patch = (id: string, change: Partial<Layer>) => onChange({ layers: design.layers.map((one) => (one.id === id ? ({ ...one, ...change } as Layer) : one)) });
  return (
    <Panel
      title="Layers"
      icon={<Layers size={13} />}
      action={
        <IconButton label="Add text" onClick={onAddText} className="size-6">
          <Plus size={13} />
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
            <div
              key={layer.id}
              onClick={() => onSelect(layer.id)}
              onDoubleClick={() => onOpen(layer.id)}
              className={cx("group flex h-8 items-center gap-2 rounded-md pr-1 pl-2 text-[12px] transition-colors", selected === layer.id ? "bg-active text-fg" : "text-secondary hover:bg-hover")}
            >
              <LayerIcon layer={layer} />
              <span className={cx("min-w-0 flex-1 truncate", layer.hidden && "opacity-40")}>{layerName(layer)}</span>
              <span className="hidden items-center group-hover:flex">
                <IconButton label="Move up" disabled={index === design.layers.length - 1} onClick={(event) => (event.stopPropagation(), move(index, 1))} className="size-6">
                  <ArrowUp size={12} />
                </IconButton>
                <IconButton label="Move down" disabled={index === 0} onClick={(event) => (event.stopPropagation(), move(index, -1))} className="size-6">
                  <ArrowDown size={12} />
                </IconButton>
                <IconButton label="Delete" onClick={(event) => (event.stopPropagation(), onChange({ layers: design.layers.filter((one) => one.id !== layer.id) }))} className="size-6">
                  <Trash2 size={12} />
                </IconButton>
              </span>
              <IconButton label={layer.hidden ? "Show" : "Hide"} onClick={(event) => (event.stopPropagation(), patch(layer.id, { hidden: !layer.hidden }))} className={cx("size-6", layer.hidden ? "text-fg" : "opacity-0 group-hover:opacity-100")}>
                {layer.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
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

/** A small picture in a side panel's grid, with its words in the corners. */
function Tile({ src, title, onClick, checker, children }: { src: string; title?: string; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void; checker?: boolean; children?: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cx(
        "relative aspect-video overflow-hidden rounded-md ring-1 ring-line transition-shadow hover:ring-line-strong",
        checker ? "bg-[repeating-conic-gradient(#222_0_25%,#2c2c2c_0_50%)] bg-[length:12px_12px]" : "bg-black",
      )}
    >
      <img src={src} alt="" loading="lazy" className={cx("size-full", checker ? "object-contain" : "object-cover")} />
      {children}
    </button>
  );
}

function PicturesPanel({ thumb, used, uploading, onUpload, onOpen }: { thumb: Thumbnail; used: Map<string, string>; uploading: number; onUpload: (files: File[]) => void; onOpen: (id: string) => void }) {
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
        <p className="px-1.5 pb-1 text-[12px] leading-normal text-faint">Drop or paste frames and thumbnails anywhere; Claude's pictures land here too.</p>
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          {[...thumb.images].reverse().map((image) => (
            <Tile key={image.id} src={sourceUrl(thumb.id, image.id)} title={image.prompt ?? image.name} onClick={() => onOpen(image.id)}>
              {used.get(image.id) !== undefined && (
                <Badge tone="over" className="absolute bottom-1 left-1">
                  {used.get(image.id)}
                </Badge>
              )}
            </Tile>
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
      icon={<Sticker size={13} />}
      action={
        <IconButton label="Upload an overlay" onClick={() => input.current?.click()} className="size-6">
          <Upload size={13} />
        </IconButton>
      }
    >
      <input ref={input} type="file" accept="image/png,image/webp,image/jpeg" hidden onChange={(event) => setAdding(filesOf(event.currentTarget)[0] ?? null)} />
      <div className="grid grid-cols-2 gap-1.5">
        {library.map((asset) => (
          <div key={asset.id} className="flex min-w-0 flex-col gap-1">
            <Tile
              src={`/api/thumbnails/assets/${encodeURIComponent(asset.id)}/file`}
              title={asset.note}
              checker
              onClick={(event) =>
                toggleMenu(
                  event.currentTarget,
                  [{ label: "Add on top", onSelect: () => onAdd(asset) }, ...(asset.builtIn ? [] : [{ label: "Remove from the library", danger: true, onSelect: () => void thumbnailsApi.removeAsset(asset.id).then(onChanged, (error: unknown) => toastError(error, "remove it")) }])],
                  { width: 190 },
                )
              }
            />
            <span className="truncate px-0.5 text-[11px] text-muted">{asset.name}</span>
          </div>
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
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    setName(file?.name.replace(/\.[a-z0-9]+$/i, "") ?? "");
    setNote("");
    if (file === null) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <Modal open={file !== null} onClose={onClose} width={460}>
      <div className="p-6">
        <DialogTitle title="Add to the team's overlays" detail="Claude reads the note to know where it goes." />
        <div className="mt-4 flex flex-col gap-3">
          {preview !== null && <img src={preview} alt="" className="aspect-video w-full rounded-md bg-[repeating-conic-gradient(#222_0_25%,#2c2c2c_0_50%)] bg-[length:12px_12px] object-contain ring-1 ring-line" />}
          <Field stacked label="Name">
            <TextField value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field stacked label="What it is and where it goes">
            <TextArea value={note} onChange={(event) => setNote(event.target.value)} rows={3} placeholder="A red arrow pointing left: put it beside the evidence it points at." />
          </Field>
          <label className="flex items-center justify-between text-[12px] text-muted">
            Covers the whole picture
            <Switch checked={kind === "overlay"} onChange={(on) => setKind(on ? "overlay" : "sticker")} />
          </label>
        </div>
        <DialogActions>
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="light"
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
            {busy && <Spinner size={13} />} Add
          </Button>
        </DialogActions>
      </div>
    </Modal>
  );
}

/**
 * The page's big dialog (Camera Raw's shape): a title bar, the picture large
 * on the left, a column of controls on the right, and its answers at the foot.
 */
function Workbench({ icon, title, meta, picture, side, foot, onClose, width = 1320, height = 820 }: { icon: ReactNode; title: string; meta?: ReactNode; picture: ReactNode; side: ReactNode; foot?: ReactNode; onClose: () => void; width?: number; height?: number }) {
  return (
    <Modal open onClose={onClose} width={Math.min(width, window.innerWidth - 48)}>
      <div className="flex flex-col" style={{ height: `min(${height}px, calc(100vh - 48px))` }}>
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <span className="text-muted">{icon}</span>
          <h2 className="min-w-0 truncate text-[14px] font-semibold">{title}</h2>
          {meta}
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 items-center justify-center bg-black p-6">{picture}</div>
          <div className="flex w-[340px] shrink-0 flex-col overflow-y-auto border-l border-line">{side}</div>
        </div>
        {foot && <div className="flex h-14 shrink-0 items-center justify-end gap-2 border-t border-line px-4">{foot}</div>}
      </div>
    </Modal>
  );
}

/**
 * A picture, big, with what can be done with it in one place (Sphe, Nov 3:
 * clicking a picture should open a big dialog, the options moved there): what
 * it is, whether it's used, the prompts stored for it, and its actions.
 */
function PictureDialog({ thumbId, image, used, onClose, onUse, onAttach, onRemove }: { thumbId: string; image: Thumbnail["images"][number]; used: string | null; onClose: () => void; onUse: (how: "base" | "layer") => void; onAttach: () => void; onRemove: () => void }) {
  const words = (title: string, text: string) => (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-muted">{title}</span>
      <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-secondary select-text">{text}</p>
    </div>
  );
  return (
    <Workbench
      icon={<ImageIcon size={15} />}
      title={image.name}
      width={1100}
      height={700}
      onClose={onClose}
      meta={
        <>
          {used !== null && <Badge>{used}</Badge>}
          <span className="text-[12px] text-faint tabular">
            {image.width} × {image.height}
            {image.model ? ` · ${image.model}` : image.from === "openart" ? " · OpenArt" : ""}
          </span>
        </>
      }
      picture={<img src={sourceUrl(thumbId, image.id)} alt={image.name} className="max-h-full max-w-full rounded-md object-contain" />}
      side={
        <div className="flex flex-1 flex-col gap-2 p-4">
          <Button variant="light" onClick={() => onUse("base")}>
            Use as base
          </Button>
          <Button variant="subtle" onClick={() => onUse("layer")}>
            Add on top
          </Button>
          <Button variant="subtle" onClick={onAttach}>
            Give to Claude
          </Button>
          <Button variant="subtle" onClick={() => window.open(sourceUrl(thumbId, image.id), "_blank")}>
            Open full size
          </Button>
          <div className="mt-3 flex flex-col gap-4">
            {image.request !== undefined && words("Your request", image.request)}
            {image.prompt !== undefined && words("OpenArt prompt", image.prompt)}
          </div>
          <Button variant="danger" className="mt-auto" onClick={onRemove}>
            <Trash2 size={14} /> Remove
          </Button>
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------- a layer's dialog (Camera Raw for a picture)

type AdjustSlider = { key: keyof Adjust; label: string; min: number; max: number; step?: number; precision?: number };
const BASIC: AdjustSlider[] = [
  // As Camera Raw's: exposure in stops, to two decimals; the rest whole numbers.
  { key: "exposure", label: "Exposure", min: -5, max: 5, step: 0.01, precision: 2 },
  { key: "contrast", label: "Contrast", min: -100, max: 100 },
  { key: "highlights", label: "Highlights", min: -100, max: 100 },
  { key: "shadows", label: "Shadows", min: -100, max: 100 },
];
const COLOUR: AdjustSlider[] = [
  { key: "warmth", label: "Temperature", min: -100, max: 100 },
  { key: "saturation", label: "Saturation", min: -100, max: 100 },
  { key: "vibrance", label: "Vibrance", min: -100, max: 100 },
];
const EFFECTS: AdjustSlider[] = [
  { key: "sharpen", label: "Sharpening", min: 0, max: 100 },
  { key: "vignette", label: "Vignette", min: 0, max: 100 },
];

/** A labelled slider in the dialog's column. */
function Knob({ label, ...slider }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void; suffix?: string; reset?: number; step?: number; precision?: number }) {
  return (
    <Field wide label={label}>
      <Slider label={label} steppers {...slider} />
    </Field>
  );
}

function ShadowSection({ shadow, set }: { shadow: Shadow | undefined; set: (shadow: Shadow | undefined) => void }) {
  const value = shadow ?? HOUSE_SHADOW;
  const one = (key: "opacity" | "angle" | "distance" | "spread" | "size", label: string, min: number, max: number, suffix: string) => (
    <Knob label={label} value={value[key]} min={min} max={max} suffix={suffix} reset={HOUSE_SHADOW[key]} onChange={(next) => set({ ...value, [key]: next })} />
  );
  return (
    <Section roomy title="Drop shadow" toggle={{ on: shadow !== undefined, onChange: (on) => set(on ? { ...HOUSE_SHADOW } : undefined) }}>
      <Field wide label="Colour">
        <ColorField value={value.color} onChange={(color) => set({ ...value, color })} />
      </Field>
      {one("opacity", "Opacity", 0, 100, "%")}
      {one("angle", "Angle", -180, 180, "°")}
      {one("distance", "Distance", 0, 100, "px")}
      {one("spread", "Spread", 0, 100, "%")}
      {one("size", "Size", 0, 150, "px")}
    </Section>
  );
}

/**
 * A layer's settings in a big dialog, as Photoshop's Camera Raw Filter (Sphe,
 * Nov 2: "the adjustments and what not should be on a sort of camera raw
 * filter dialog box menu thats big but the agent mainly controls this"): the
 * thumbnail large on the left with the change on it as it's made, the panels
 * on the right; OK keeps it (one step of undo), Cancel leaves it as it was.
 */
function LayerDialog({ layer, design, picture, tick, onClose, onApply }: { layer: Layer; design: Design; picture: (source: string) => HTMLImageElement | null; tick: number; onClose: () => void; onApply: (layer: Layer) => void }) {
  const [draft, setDraft] = useState<Layer>(layer);
  const preview = useRef<HTMLCanvasElement>(null);
  const set = (patch: Partial<ImageLayer> | Partial<TextLayer>) => setDraft((last) => ({ ...last, ...patch }) as Layer);
  useEffect(() => {
    if (preview.current === null) return;
    const frame = requestAnimationFrame(() => draw(preview.current!, { layers: design.layers.map((one) => (one.id === draft.id ? draft : one)) }, picture));
    return () => cancelAnimationFrame(frame);
  }, [draft, design, picture, tick]);
  return (
    <Workbench
      icon={<SlidersHorizontal size={15} />}
      title={draft.kind === "image" ? "Camera Raw" : "Text settings"}
      meta={<span className="min-w-0 truncate text-[13px] text-muted">{layerName(draft)}</span>}
      onClose={onClose}
      picture={<canvas ref={preview} width={WIDTH} height={HEIGHT} className="max-h-full max-w-full rounded-md" style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }} />}
      side={
        <>
          {draft.kind === "image" ? <PictureSections layer={draft} set={set} /> : <TextSections layer={draft} set={set} />}
          <ShadowSection shadow={draft.shadow} set={(shadow) => set({ shadow })} />
        </>
      }
      foot={
        <>
          <Button variant="ghost" className="mr-auto" onClick={() => setDraft(layer)}>
            Reset
          </Button>
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="light" onClick={() => onApply(draft)}>
            OK
          </Button>
        </>
      }
    />
  );
}

function PictureSections({ layer, set }: { layer: ImageLayer; set: (patch: Partial<ImageLayer>) => void }) {
  const adjust = (key: keyof Adjust, value: number) => set({ adjust: { ...NO_ADJUST, ...layer.adjust, [key]: value } });
  const knobs = (list: AdjustSlider[]) => list.map((one) => <Knob key={one.key} label={one.label} value={layer.adjust?.[one.key] ?? 0} min={one.min} max={one.max} step={one.step} precision={one.precision} onChange={(value) => adjust(one.key, value)} />);
  return (
    <>
      <Section roomy title="Basic">
        {knobs(BASIC)}
      </Section>
      <Section roomy title="Colour">
        {knobs(COLOUR)}
      </Section>
      <Section roomy title="Detail and effects">
        {knobs(EFFECTS)}
      </Section>
      <Section roomy title="Crop">
        <Field wide label="Fit">
          <Select className={choice} value={layer.fit} options={[{ value: "cover", label: "Fill (crop)" }, { value: "contain", label: "Fit inside" }, { value: "stretch", label: "Stretch" }]} onChange={(fit) => set({ fit })} />
        </Field>
        {layer.fit === "cover" && (
          <>
            <Knob label="Zoom" value={Math.round((layer.zoom ?? 1) * 100)} min={100} max={400} suffix="%" reset={100} onChange={(zoom) => set({ zoom: zoom / 100 })} />
            <Knob label="Across" value={Math.round((layer.focusX ?? 0.5) * 100)} min={0} max={100} suffix="%" reset={50} onChange={(focus) => set({ focusX: focus / 100 })} />
            <Knob label="Down" value={Math.round((layer.focusY ?? 0.5) * 100)} min={0} max={100} suffix="%" reset={50} onChange={(focus) => set({ focusY: focus / 100 })} />
          </>
        )}
        <Field wide label="Flip">
          <Switch checked={layer.flip === true} onChange={(flip) => set({ flip })} />
        </Field>
        <Knob label="Rotation" value={layer.rotation ?? 0} min={-180} max={180} suffix="°" onChange={(rotation) => set({ rotation })} />
        <Knob label="Opacity" value={layer.opacity} min={0} max={100} suffix="%" reset={100} onChange={(opacity) => set({ opacity })} />
      </Section>
    </>
  );
}

/** A dialog's pick-one control, as wide as the sliders beside it. */
const choice = "flex h-7 w-full items-center justify-between rounded-md bg-white/[0.05] px-2.5 text-[12px] hover:bg-white/[0.08]";

function TextSections({ layer, set }: { layer: TextLayer; set: (patch: Partial<TextLayer>) => void }) {
  const box = layer.box;
  const stroke = layer.stroke;
  return (
    <>
      <Section roomy title="Words">
        <TextArea value={layer.text} rows={2} onChange={(event) => set({ text: event.target.value })} className="mb-1" />
        <Field wide label="Font">
          <Select className={choice} value={layer.font} menuWidth={240} options={FONTS.map((one) => ({ value: one.family as string, label: one.family }))} onChange={(font) => set({ font })} />
        </Field>
        <Field wide label="Weight">
          <Select className={choice} value={layer.weight} options={[400, 500, 600, 700, 800, 900].map((one) => ({ value: one, label: String(one) }))} onChange={(weight) => set({ weight })} />
        </Field>
        <Knob label="Size" value={layer.size} min={12} max={240} suffix="px" reset={72} onChange={(size) => set({ size })} />
        <Knob label="Wraps at" value={layer.width} min={100} max={1280} suffix="px" reset={900} onChange={(width) => set({ width })} />
        <Field wide label="Colour">
          <ColorField value={layer.color} onChange={(color) => set({ color })} />
        </Field>
        <Field wide label="Align">
          <Select className={choice} value={layer.align} options={[{ value: "left", label: "Left" }, { value: "center", label: "Centre" }, { value: "right", label: "Right" }]} onChange={(align) => set({ align })} />
        </Field>
        <Field wide label="Case">
          <Select
            className={choice}
            value={layer.casing === "upper" || (layer.casing === undefined && layer.uppercase === true) ? "upper" : layer.casing === "keep" ? "keep" : "lower"}
            options={[
              { value: "lower", label: "Lower case" },
              { value: "upper", label: "Capitals" },
              { value: "keep", label: "As written" },
            ]}
            onChange={(casing) => set({ casing, uppercase: undefined })}
          />
        </Field>
        <Knob label="Rotation" value={layer.rotation ?? 0} min={-180} max={180} suffix="°" onChange={(rotation) => set({ rotation })} />
        <Knob label="Opacity" value={layer.opacity} min={0} max={100} suffix="%" reset={100} onChange={(opacity) => set({ opacity })} />
      </Section>
      <Section
        roomy
        title="Box behind"
        toggle={{
          on: box !== undefined,
          // A box takes the black-box face; without one, the white-and-red face and the house shadow.
          onChange: (on) =>
            set(
              on
                ? { box: { color: "#000000", opacity: 100, padX: 22, padY: 10, radius: 0 }, ...(layer.font === WHITE_RED_FONT ? { font: BLACK_BOX_FONT } : {}) }
                : { box: undefined, stroke: undefined, ...(layer.font === BLACK_BOX_FONT ? { font: WHITE_RED_FONT } : {}), shadow: layer.shadow === undefined || captionShadow({ shadow: layer.shadow }) === HOUSE_SHADOW ? { ...HOUSE_SHADOW } : layer.shadow },
            ),
        }}
      >
        {box !== undefined && (
          <>
            <Field wide label="Colour">
              <ColorField value={box.color} onChange={(color) => set({ box: { ...box, color } })} />
            </Field>
            <Knob label="Opacity" value={box.opacity} min={0} max={100} suffix="%" reset={100} onChange={(opacity) => set({ box: { ...box, opacity } })} />
            <Knob label="Padding" value={box.padX} min={0} max={80} suffix="px" reset={22} onChange={(padX) => set({ box: { ...box, padX, padY: Math.round(padX * 0.45) } })} />
            <Knob label="Rounding" value={box.radius} min={0} max={60} suffix="px" onChange={(radius) => set({ box: { ...box, radius } })} />
          </>
        )}
      </Section>
      {box !== undefined && (
        <Section roomy title="Stroke" toggle={{ on: stroke !== undefined, onChange: (on) => set({ stroke: on ? { color: "#000000", width: 4 } : undefined }) }}>
          {stroke !== undefined && (
            <>
              <Field wide label="Colour">
                <ColorField value={stroke.color} onChange={(color) => set({ stroke: { ...stroke, color } })} />
              </Field>
              <Knob label="Width" value={stroke.width} min={0} max={30} suffix="px" reset={4} onChange={(width) => set({ stroke: { ...stroke, width } })} />
            </>
          )}
        </Section>
      )}
    </>
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
        <Empty title="Make a thumbnail with Claude" detail="Drop in a frame or a thumbnail and say what you want: “clean this base and put the REC overlay on”, “three drafts of the mom at the door”, “add ‘he abused me’ in a black box”." />
      ) : (
        <ChatTurns turns={turns} known={known} thinking={running ? `Thinking${other}` : undefined} />
      )}
    </ChatShell>
  );
}
