import { Check, ChevronDown, CircleAlert, Copy, Download, FolderOpen, ListOrdered } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api, useMachine } from "../lib/api";
import { projectDuration } from "../lib/edit";
import {
  chaptersInSpan,
  DEFAULTS,
  estimateBytes,
  extensionOf,
  formatBytes,
  FORMATS,
  hasAudio,
  hasChapters,
  hasVideo,
  isMp4,
  LOUDNESS,
  outputSize,
  scriptChapters,
  youtubeChapters,
  type Encoders,
  type ExportOptions,
  type Fill,
  type Format,
  type Quality,
  type Shape,
  type SpanChoice,
} from "../lib/exporting";
import { inOutSpan, useInOut } from "../lib/inOut";
import { playhead, preview } from "../lib/playback";
import { readSetting, writeSetting } from "../lib/storage";
import { flushSave, useEditor } from "../lib/store";
import { shortDuration, timecode } from "../lib/time";
import { Button, cx, Modal, Select, spring, Switch, Tabs } from "./ui";

type Settings = Omit<ExportOptions, "range" | "chapters">;

const SAVED = "edit.export.v2";

/** The settings used last, so the dialog opens where you left it. */
function saved(): { settings: Settings; chapters: boolean } {
  try {
    const value = JSON.parse(readSetting(SAVED) ?? "null");
    return { settings: { ...DEFAULTS, ...value?.settings }, chapters: value?.chapters !== false };
  } catch {
    return { settings: DEFAULTS, chapters: true };
  }
}

const safeName = (name: string) => name.replace(/[^\w\- ]+/g, "_").trim() || "Edit";

/** A dropdown that reads as a field in the dialog. */
const FIELD = "h-8 justify-between bg-raised px-3 ring-1 ring-line hover:bg-hover";

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useEditor((state) => state.project);
  const exportState = useEditor((state) => state.exportState);
  const toast = useEditor((state) => state.toast);
  const points = useInOut();
  const machine = useMachine();
  const initial = useMemo(saved, []);
  const [settings, setSettings] = useState<Settings>(initial.settings);
  const [embed, setEmbed] = useState(initial.chapters);
  const [spanChoice, setSpanChoice] = useState<SpanChoice>("whole");
  const [more, setMore] = useState(false);
  const [path, setPath] = useState("");
  const [pathEdited, setPathEdited] = useState(false);
  const [encoders, setEncoders] = useState<Encoders | null>(null);
  const [preparing, setPreparing] = useState(false);
  const starting = useRef(false);
  const renderStarted = useRef(0);
  const [, setTick] = useState(0);

  const fps = project?.settings.fps ?? 30;
  const duration = project ? projectDuration(project) : 0;
  const inOut = inOutSpan(duration, points);
  const intro = preview.sections?.intro ?? null;
  const still = settings.format === "png";

  // On opening: the in/out span when there is one (export is limited to it), else the whole edit.
  useEffect(() => {
    if (!open) return;
    setSpanChoice(inOut ? "inout" : "whole");
    if (!encoders) void api.exportEncoders().then(setEncoders).catch(() => setEncoders({ videotoolbox: false, hevc: false, prores: false, mp3: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The file name follows the format until you type your own; then only its extension does.
  useEffect(() => {
    if (!open || !project) return;
    const extension = extensionOf(settings.format);
    if (!pathEdited) setPath(`~/Movies/Edit/${safeName(project.name)}.${extension}`);
    else setPath((current) => current.replace(/\.[a-z0-9]{2,4}$/i, "") + `.${extension}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project?.name, settings.format]);

  useEffect(() => writeSetting(SAVED, JSON.stringify({ settings, chapters: embed })), [settings, embed]);

  // While rendering: time the run for an estimate of what's left, and say when it's done.
  useEffect(() => {
    if (exportState?.state === "running") {
      if (!renderStarted.current) renderStarted.current = performance.now();
      const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
      return () => clearInterval(timer);
    }
    if (exportState?.state === "done" && renderStarted.current && document.hidden && "Notification" in window && Notification.permission === "granted") {
      new Notification("Export finished", { body: exportState.path.split("/").pop() });
    }
    renderStarted.current = 0;
  }, [exportState?.state, exportState?.path]);

  // Sections come from the preview engine, which may finish starting after this mounts.
  const sections = preview.sections;
  const chapters = useMemo(() => (project ? scriptChapters(project, sections) : []), [project, sections]);

  if (!project) return null;

  const range: [number, number] = still
    ? [Math.floor(playhead.frame), Math.floor(playhead.frame) + 1]
    : spanChoice === "inout" && inOut
      ? inOut
      : spanChoice === "intro" && intro
        ? [intro[0], intro[1]]
        : [0, duration];
  const seconds = (range[1] - range[0]) / fps;
  const outFps = settings.fps ?? fps;
  const spanChapters = chaptersInSpan(chapters, range, fps);
  const embedding = hasChapters(settings.format) && embed && spanChapters.length >= 2;
  const [width, height] = outputSize(settings, project.settings.width, project.settings.height);
  const bytes = estimateBytes(settings, width, height, seconds, outFps);
  const running = exportState?.state === "running";
  const busy = running || preparing;
  const available = (format: Format) =>
    !encoders ||
    (format === "hevc" ? encoders.hevc || encoders.videotoolbox : format === "prores" ? encoders.prores : format === "mp3" ? encoders.mp3 : true);
  const set = (next: Partial<Settings>) => setSettings((current) => ({ ...current, ...next }));

  const start = async () => {
    if (starting.current || useEditor.getState().exportState?.state === "running") return;
    starting.current = true;
    setPreparing(true);
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission().catch(() => {});
    let requested = false;
    try {
      useEditor.getState().endGesture();
      const intended = useEditor.getState().project;
      await flushSave();
      const saved = useEditor.getState();
      if (saved.project?.id !== project.id) return;
      if (saved.dirty) throw new Error("The latest changes couldn't be saved. Try exporting again once the connection returns.");
      if (saved.project !== intended) throw new Error("The project changed while preparing the export. Review the latest version and try again.");
      useEditor.setState({ exportState: { state: "running", progress: 0, path } });
      requested = true;
      renderStarted.current = performance.now();
      const options: ExportOptions = { ...settings, fps: settings.fps === fps ? null : settings.fps, range, chapters: embedding ? spanChapters : [] };
      const { path: output } = await api.exportProject(project.id, path, options);
      const current = useEditor.getState();
      if (current.project?.id === project.id && current.exportState?.state === "running") useEditor.setState({ exportState: { ...current.exportState, path: output } });
    } catch (error) {
      const current = useEditor.getState();
      if (requested && current.project?.id === project.id && current.exportState?.state === "running") useEditor.setState({ exportState: null });
      toast((error as Error).message, "error");
    } finally {
      starting.current = false;
      setPreparing(false);
    }
  };

  const copyChapters = () => {
    void navigator.clipboard
      .writeText(youtubeChapters(spanChapters, range, fps))
      .then(() => toast(`Copied ${spanChapters.length} chapters for the YouTube description`))
      .catch(() => toast("Couldn't copy to the clipboard", "error"));
  };

  const spans = [
    inOut && { value: "inout" as const, label: `In–Out · ${shortDuration((inOut[1] - inOut[0]) / fps)}` },
    { value: "whole" as const, label: `Whole · ${shortDuration(duration / fps)}` },
    intro && { value: "intro" as const, label: `Intro · ${shortDuration((intro[1] - intro[0]) / fps)}` },
  ].filter((entry): entry is { value: SpanChoice; label: string } => Boolean(entry));
  const sizes = [2160, 1440, 1080, 720].map((size) => ({ value: size, label: `${size}p` }));
  const rates = [...new Set([30, 60, fps])].sort((a, b) => a - b);
  const formatLabel = FORMATS.find((entry) => entry.value === settings.format)?.label ?? "";
  // What "More options" holds, at a glance.
  const extras = [
    formatLabel,
    settings.shape !== "original" && { vertical: "9:16", square: "1:1", portrait: "4:5" }[settings.shape],
    isMp4(settings.format) && (settings.target_mb ? `under ${settings.target_mb} MB` : settings.quality !== "high" && settings.quality),
    isMp4(settings.format) && settings.hardware && "hardware",
    hasAudio(settings.format) && (settings.audio ? (settings.loudness ? `${settings.loudness} LUFS` : null) : "no sound"),
    embedding && `${spanChapters.length} chapters`,
  ].filter(Boolean);
  const elapsed = renderStarted.current ? (performance.now() - renderStarted.current) / 1000 : 0;
  const left = running && exportState.progress > 0.03 ? (elapsed * (1 - exportState.progress)) / exportState.progress : null;

  return (
    <Modal open={open} onClose={onClose} width={920}>
      <div className="flex max-h-[88vh] flex-col">
        <div className="flex min-h-0 flex-1 gap-6 overflow-y-auto p-6">
          {/* The render, as it will look. */}
          <div className="w-[360px] shrink-0">
            <h2 className="text-[16px] font-semibold tracking-[-0.01em]">Export</h2>
            <p className="mt-1 text-[12px] text-muted">{inOut ? "In to out" : "The whole edit"}, rendered exactly as the preview shows it.</p>
            <RenderPreview
              projectId={project.id}
              range={range}
              shape={hasVideo(settings.format) ? settings.shape : "original"}
              fill={settings.fill}
              size={[width, height]}
              progress={running ? exportState.progress : null}
              still={still}
            />
            <div className="mt-2 flex items-center justify-between font-mono text-[11px] text-faint tabular">
              <span>{timecode(range[0], fps)}</span>
              {!still && <span>{timecode(range[1], fps)}</span>}
            </div>
            <p className="mt-3 text-[12px] text-muted tabular">
              {[hasVideo(settings.format) && `${width}×${height}`, hasVideo(settings.format) && !still && `${outFps} fps`, still ? "one frame" : shortDuration(seconds), bytes !== null && `≈ ${formatBytes(bytes)}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-4 pt-1">
            {!still && (
              <Field label="Span">
                <Tabs<SpanChoice> id="export-span" value={spanChoice} tabs={spans} onChange={setSpanChoice} />
              </Field>
            )}
            {hasVideo(settings.format) && (
              <div className="flex gap-4">
                <Field label="Resolution">
                  <div className="w-[150px]">
                    <Select<number> value={settings.size ?? 1080} options={sizes} onChange={(size) => set({ size })} className={FIELD} />
                  </div>
                </Field>
                {!still && settings.format !== "gif" && (
                  <Field label="Frame rate">
                    <Tabs<string>
                      id="export-fps"
                      value={String(settings.fps ?? fps)}
                      tabs={rates.map((rate) => ({ value: String(rate), label: `${rate} fps` }))}
                      onChange={(rate) => set({ fps: Number(rate) })}
                    />
                  </Field>
                )}
              </div>
            )}
            {hasVideo(settings.format) && !still && outFps > fps && (
              <p className="-mt-2 text-[11px] text-faint">The project is {fps} fps: {outFps} fps repeats its frames, so motion looks the same.</p>
            )}

            <div className="rounded-xl ring-1 ring-line">
              <button onClick={() => setMore((value) => !value)} className="flex h-10 w-full items-center gap-2 px-3.5 text-left text-[12px]">
                <motion.span animate={{ rotate: more ? 0 : -90 }} transition={spring} className="text-faint">
                  <ChevronDown size={14} />
                </motion.span>
                <span className="font-medium text-fg">More options</span>
                <span className="truncate text-faint">{extras.join(" · ")}</span>
              </button>
              <AnimatePresence initial={false}>
                {more && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    className="overflow-hidden"
                  >
                    <div className="grid grid-cols-[84px_1fr] items-center gap-x-3 gap-y-3 border-t border-line px-3.5 py-3.5">
                      <Label>Format</Label>
                      <div className="w-[240px]">
                        <Select<Format>
                          value={settings.format}
                          options={FORMATS.filter((entry) => available(entry.value))}
                          onChange={(format) => set({ format, audio: hasAudio(format) ? settings.audio || !hasVideo(format) : false })}
                          className={FIELD}
                        />
                      </div>
                      {hasVideo(settings.format) && (
                        <>
                          <Label>Shape</Label>
                          <div className="flex items-center gap-3">
                            <Tabs<Shape>
                              id="export-shape"
                              value={settings.shape}
                              tabs={[
                                { value: "original", label: "16:9" },
                                { value: "vertical", label: "9:16" },
                                { value: "square", label: "1:1" },
                                { value: "portrait", label: "4:5" },
                              ]}
                              onChange={(shape) => set({ shape })}
                            />
                            {settings.shape !== "original" && (
                              <div className="w-[140px]">
                                <Select<Fill>
                                  value={settings.fill}
                                  options={[
                                    { value: "blur", label: "Blurred fill" },
                                    { value: "crop", label: "Crop to fill" },
                                    { value: "black", label: "Black bars" },
                                  ]}
                                  onChange={(fill) => set({ fill })}
                                  className={FIELD}
                                />
                              </div>
                            )}
                          </div>
                        </>
                      )}
                      {(isMp4(settings.format) || settings.format === "mp3") && (
                        <>
                          <Label>Quality</Label>
                          <div className="flex items-center gap-3">
                            <Tabs<Quality | "size">
                              id="export-quality"
                              value={settings.target_mb && isMp4(settings.format) ? "size" : settings.quality}
                              tabs={[
                                { value: "high", label: "High" },
                                { value: "balanced", label: "Balanced" },
                                { value: "small", label: "Small" },
                                ...(isMp4(settings.format) ? [{ value: "size" as const, label: "File size" }] : []),
                              ]}
                              onChange={(value) => set(value === "size" ? { target_mb: settings.target_mb ?? 25 } : { quality: value, target_mb: null })}
                            />
                            {settings.target_mb && isMp4(settings.format) ? (
                              <label className="flex items-center gap-1.5 text-[12px] text-muted">
                                under
                                <input
                                  type="number"
                                  min={1}
                                  value={settings.target_mb}
                                  onChange={(event) => set({ target_mb: Math.max(1, Number(event.target.value) || 1) })}
                                  className="h-7 w-16 rounded-md border border-line bg-black px-2 font-mono text-[12px] text-fg outline-none focus:border-line-strong"
                                />
                                MB
                              </label>
                            ) : null}
                          </div>
                        </>
                      )}
                      {isMp4(settings.format) && encoders?.videotoolbox && (
                        <>
                          <Label>Encoding</Label>
                          <label className="flex items-center gap-2.5 text-[12px] text-muted" title="The Mac's media engine: several times faster, files a little bigger.">
                            <Switch checked={settings.hardware} onChange={(hardware) => set({ hardware })} />
                            Fast hardware encoding
                          </label>
                        </>
                      )}
                      {hasAudio(settings.format) && (
                        <>
                          <Label>Sound</Label>
                          <div className="flex items-center gap-3">
                            {hasVideo(settings.format) && <Switch checked={settings.audio} onChange={(audio) => set({ audio })} />}
                            {settings.audio && (
                              <div className="w-[240px]">
                                <Select<number>
                                  value={settings.loudness ?? 0}
                                  options={[{ value: 0, label: "Mix as it is" }, ...LOUDNESS]}
                                  onChange={(loudness) => set({ loudness: loudness || null })}
                                  className={FIELD}
                                />
                              </div>
                            )}
                          </div>
                        </>
                      )}
                      {hasChapters(settings.format) && spanChapters.length > 0 && (
                        <>
                          <Label>Chapters</Label>
                          <div className="flex items-center gap-3" title={spanChapters.map((chapter) => chapter.title).join(" · ")}>
                            <label className="flex items-center gap-2.5 text-[12px] text-muted">
                              <Switch checked={embed && spanChapters.length >= 2} onChange={setEmbed} />
                              Embed {spanChapters.length} from the script
                            </label>
                            <Button size="sm" variant="ghost" onClick={copyChapters} title={spanChapters.length < 3 ? "YouTube shows chapters only when there are at least 3" : undefined}>
                              <ListOrdered size={13} /> Copy for YouTube
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <Field label={`Save to, on ${machine}`}>
              <input
                id="export-path"
                value={path}
                onChange={(event) => {
                  setPath(event.target.value);
                  setPathEdited(true);
                }}
                disabled={busy}
                spellCheck={false}
                className="h-9 w-full rounded-lg border border-line bg-black px-3 font-mono text-[12px] outline-none focus:border-line-strong disabled:opacity-50"
              />
            </Field>
          </div>
        </div>

        <div className="flex min-h-16 items-center gap-3 border-t border-line px-6 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-x-3 text-[12px]">
            {exportState?.state === "running" && (
              <span className="text-muted tabular">
                Rendering… {Math.round(exportState.progress * 100)}%{left !== null && ` · about ${shortDuration(Math.max(1, left))} left`}
              </span>
            )}
            {exportState?.state === "done" && (
              <>
                <span className="flex min-w-0 items-center gap-1.5 text-green-300">
                  <Check size={13} className="shrink-0" />
                  <span className="truncate">
                    Exported in {exportState.seconds?.toFixed(1)}s{exportState.bytes ? ` · ${formatBytes(exportState.bytes)}` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <a href={`/api/exports/file?path=${encodeURIComponent(exportState.path)}`} download>
                    <Button size="sm" variant="subtle">
                      <Download size={13} /> Download
                    </Button>
                  </a>
                  <Button size="sm" variant="ghost" onClick={() => void api.revealExport(exportState.path).catch((error) => toast((error as Error).message, "error"))}>
                    <FolderOpen size={13} /> Show on {machine}
                  </Button>
                  <Button size="sm" variant="ghost" title="Copy the file's path" onClick={() => void navigator.clipboard.writeText(exportState.path).then(() => toast("Copied the path"))}>
                    <Copy size={13} />
                  </Button>
                </span>
              </>
            )}
            {exportState?.state === "failed" && (
              <span className="flex min-w-0 items-center gap-1.5 text-red-300">
                <CircleAlert size={13} className="shrink-0" /> <span className="truncate">{exportState.error}</span>
              </span>
            )}
            {exportState?.state === "cancelled" && <span className="text-muted">Cancelled</span>}
          </div>
          {running ? (
            <Button variant="danger" onClick={() => void api.cancelExport(project.id)}>
              Cancel export
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" disabled={seconds <= 0 || preparing} onClick={() => void start()}>
                {preparing ? "Preparing…" : exportState?.state === "done" ? "Export again" : "Export"}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <span className="text-[12px] text-muted">{children}</span>;
}

/**
 * A frame of the span as the export will frame it (shape and fill), from the
 * server's renderer. Hover to look through the span; while exporting it
 * follows the render.
 */
function RenderPreview({
  projectId,
  range,
  shape,
  fill,
  size,
  progress,
  still,
}: {
  projectId: string;
  range: [number, number];
  shape: Shape;
  fill: Fill;
  size: [number, number];
  progress: number | null;
  still: boolean;
}) {
  const [start, end] = range;
  const [hover, setHover] = useState<number | null>(null);
  // The middle of the span shows what it is better than its first frame (often a fade from black).
  const resting = still ? start : start + Math.floor((end - start) / 2);
  const [frame, setFrame] = useState(resting);
  // Ask for a new picture at most every so often: each is a server render.
  useEffect(() => {
    const at = progress !== null ? start + Math.floor(progress * (end - start - 1)) : hover !== null ? start + Math.floor(hover * (end - start - 1)) : resting;
    const timer = setTimeout(() => setFrame(Math.max(start, Math.min(end - 1, at))), progress !== null ? 1500 : 120);
    return () => clearTimeout(timer);
  }, [start, end, hover, progress, resting]);
  const src = `/api/projects/${projectId}/frame/${frame}.png?max=640`;
  const [w, h] = size;
  const fit = shape === "original" ? "object-contain" : fill === "crop" ? "object-cover" : "object-contain";
  return (
    <div className="mt-4 flex h-[220px] items-center justify-center rounded-xl bg-black ring-1 ring-line">
      <div
        className="relative h-full max-h-[200px] max-w-[340px] overflow-hidden rounded-md bg-black"
        style={{ aspectRatio: `${w} / ${h}` }}
        onPointerMove={(event) => {
          if (still) return;
          const box = event.currentTarget.getBoundingClientRect();
          setHover(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)));
        }}
        onPointerLeave={() => setHover(null)}
      >
        {shape !== "original" && fill === "blur" && <img src={src} alt="" className="absolute inset-0 size-full scale-125 object-cover blur-xl brightness-[0.85]" />}
        <img src={src} alt="Export preview" className={cx("absolute inset-0 size-full", fit)} />
        {hover !== null && progress === null && <div className="absolute inset-y-0 w-px bg-playhead" style={{ left: `${hover * 100}%` }} />}
        {progress !== null && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
            <motion.div className="h-full bg-white" animate={{ width: `${progress * 100}%` }} transition={{ ease: "easeOut", duration: 0.25 }} />
          </div>
        )}
      </div>
    </div>
  );
}
