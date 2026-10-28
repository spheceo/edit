// The script, a tab beside the media bin: footage ranges and the narration
// between them, in order. The block under the playhead lights up; click one to
// jump there. Also attaches a Google Doc; its downloads have their own tab.

import { explain } from "@edit/types/problems";
import { ArrowUpRight, FileText, RotateCw, Scissors } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { api } from "../lib/api";
import { importPaste } from "../lib/import-input";
import { CLIP_HEX } from "../lib/colors";
import { clipEnd, withLinked } from "../lib/edit";
import { playhead, preview } from "../lib/playback";
import { useEditor } from "../lib/store";
import type { Project, ScriptBlock, ScriptJob } from "../lib/types";
import { ProblemView } from "./ProblemView";
import { Button, cx } from "./ui";

export function ScriptPanel() {
  const project = useEditor((state) => state.project)!;
  const job = useEditor((state) => state.scriptJob);
  const script = project.script;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {script && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line pr-2 pl-3.5">
          <FileText size={14} className="text-muted" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{script.blocks.length} blocks</span>
          <button
            title="Lay the script out again, cutting each range at its first and last words in the transcript"
            disabled={job?.state === "downloading" || job?.state === "transcribing" || job?.state === "placing" || job?.state === "voicing"}
            onClick={() => void api.resumeScript(project.id, true).then(({ job }) => useEditor.setState({ scriptJob: job }))}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"
          >
            <Scissors size={12} /> Re-cut
          </button>
          {script.source && (
            <a
              href={script.source}
              target="_blank"
              rel="noreferrer"
              title="Open the Google Doc"
              className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              Doc <ArrowUpRight size={12} />
            </a>
          )}
        </div>
      )}
      {script ? <Blocks project={project} /> : <AttachScript project={project} />}
    </div>
  );
}

/** The script import’s downloads and progress, as their own tab. */
export function ScriptDownloads() {
  const project = useEditor((state) => state.project)!;
  const job = useEditor((state) => state.scriptJob);
  if (!job) return <div className="p-4 text-[12px] text-muted">Nothing downloading.</div>;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Downloads project={project} job={job} />
    </div>
  );
}

/** Footage files in script order, labelled the way the Doc’s assets are ("Footage 1"…). */
function fileLabels(project: Project) {
  const labels = new Map<string, { label: string; color: string; name?: string }>();
  const colors = [CLIP_HEX.blue, CLIP_HEX.cyan, CLIP_HEX.green, CLIP_HEX.orange, CLIP_HEX.pink, CLIP_HEX.yellow];
  for (const block of project.script?.blocks ?? []) {
    if (block.kind !== "footage" || labels.has(block.file)) continue;
    const media = block.media ? project.media.find((candidate) => candidate.id === block.media) : undefined;
    labels.set(block.file, { label: `Footage ${labels.size + 1}`, color: colors[labels.size % colors.length], name: media?.name });
  }
  return labels;
}

function Blocks({ project }: { project: Project }) {
  const list = useRef<HTMLDivElement>(null);
  const blocks = project.script!.blocks;
  const labels = useMemo(() => fileLabels(project), [project.script, project.media]);
  const clips = useMemo(() => new Map(project.clips.map((clip) => [clip.id, clip])), [project.clips]);
  const clipOf = (block: ScriptBlock) => (block.clip ? clips.get(block.clip) : undefined);
  // Each placed block’s span, so the playhead only re-renders the list when it enters another block.
  const spans = useMemo(() => blocks.flatMap((block, index) => {
    const clip = block.clip ? clips.get(block.clip) : undefined;
    return clip ? [{ index, start: clip.start, end: clipEnd(clip) }] : [];
  }), [blocks, clips]);
  const active = useSyncExternalStore(playhead.subscribe, () => {
    const frame = Math.floor(playhead.frame);
    return spans.find((span) => frame >= span.start && frame < span.end)?.index ?? -1;
  });

  // Keep the block that’s playing in view.
  useEffect(() => {
    if (active < 0) return;
    list.current?.querySelector(`[data-block="${active}"]`)?.scrollIntoView({ block: "nearest", behavior: playhead.playing ? "smooth" : "auto" });
  }, [active]);

  const jump = (block: ScriptBlock) => {
    const clip = clipOf(block);
    if (!clip) return;
    preview.seek(clip.start);
    useEditor.getState().select([...withLinked(project, [clip.id])]);
  };

  // Consecutive footage reads as one line of timestamps, as in the Doc.
  const rows: ({ kind: "footage"; indexes: number[] } | { kind: "narration"; index: number })[] = [];
  blocks.forEach((block, index) => {
    const last = rows.at(-1);
    if (block.kind === "footage") {
      if (last?.kind === "footage") last.indexes.push(index);
      else rows.push({ kind: "footage", indexes: [index] });
    } else rows.push({ kind: "narration", index });
  });
  let cutIn = 0;

  return (
    <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
      <div className="flex flex-col gap-1">
        {rows.map((row) => {
          if (row.kind === "narration") {
            cutIn += 1;
            const block = blocks[row.index] as Extract<ScriptBlock, { kind: "narration" }>;
            const placed = Boolean(clipOf(block));
            return (
              <button
                key={row.index}
                data-block={row.index}
                onClick={() => jump(block)}
                className={cx(
                  "relative rounded-lg px-3 py-2.5 text-left transition-colors",
                  active === row.index ? "bg-raised" : "hover:bg-hover/60",
                  !placed && "opacity-50",
                )}
              >
                {active === row.index && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full" style={{ background: CLIP_HEX.purple }} />}
                <div className="mb-1 text-[10px] font-medium tracking-wide uppercase" style={{ color: CLIP_HEX.purple }}>
                  Cut-in {cutIn}
                </div>
                <p className="text-[13px] leading-relaxed whitespace-pre-line text-fg/90">{block.text}</p>
              </button>
            );
          }
          const isActive = row.indexes.includes(active);
          // The ranges flow side by side and wrap, as the Doc writes them on a line.
          return (
            <div key={row.indexes[0]} className={cx("flex flex-wrap gap-1 rounded-lg p-1.5 transition-colors", isActive && "bg-raised")}>
              {row.indexes.map((index) => {
                const block = blocks[index] as Extract<ScriptBlock, { kind: "footage" }>;
                const file = labels.get(block.file)!;
                const placed = Boolean(clipOf(block));
                const cue = cueOf(block);
                return (
                  <button
                    key={index}
                    data-block={index}
                    onClick={() => jump(block)}
                    title={`${file.name ?? file.label}\n${block.label}${cue ? `\n${cue}` : ""}${block.cut ? `\nCut ${clock(block.cut[0])} – ${clock(block.cut[1])}` : ""}${placed ? "" : "\nNot on the timeline yet"}`}
                    className={cx(
                      "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 font-mono text-[11px] tabular ring-1 transition-colors",
                      active === index ? "bg-active text-fg ring-line-strong" : "text-muted ring-line hover:bg-hover hover:text-fg",
                      !placed && "opacity-45",
                    )}
                  >
                    <span className="size-1.5 shrink-0 rounded-full" style={{ background: file.color }} />
                    {block.label}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Where the range starts and ends: its first and last words ("a...perhaps"),
 * or the whole described sound when that end is one ("*victim groans*...man").
 */
function cueOf(block: Extract<ScriptBlock, { kind: "footage" }>) {
  const note = block.notes?.find((text) => text.includes("..") || text.includes("…"));
  if (!note) return undefined;
  const parts = note.split(/\.{2,}|…/);
  const left = parts[0].trim();
  const right = parts.at(-1)!.trim();
  const word = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  const first = left.startsWith("*") ? left.slice(0, left.indexOf("*", 1) + 1 || undefined) : left.split(/\s+/)[0];
  const last = right.endsWith("*") ? right.slice(right.lastIndexOf("*", right.length - 2)) : right.split(/\s+/).at(-1)!;
  const show = (text: string) => (text.startsWith("*") ? `*${text.replace(/\*/g, "").trim().toLowerCase()}*` : word(text));
  if (!show(first) || !show(last)) return undefined;
  return `${show(first)}...${show(last)}`;
}

/** Seconds as m:ss.cc, to show a cut’s precision. */
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;

const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);

function Downloads({ project, job }: { project: Project; job: ScriptJob }) {
  const labels = fileLabels(project);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<unknown>(null);
  return (
    <div className="px-3.5 py-3">
      <div className="mb-2 flex items-center justify-between text-[12px]">
        <span className="font-medium">
          {job.state === "voicing"
            ? "Making the voice-over and splitting it across the cut-ins…"
            : job.state === "placing"
              ? "Laying out the edit…"
              : job.state === "transcribing"
                ? "Transcribing to find exact cuts…"
                : job.state === "failed"
                  ? job.files.some((file) => file.state === "failed")
                    ? "Some footage didn’t download"
                    : explain(job.error ?? "The import stopped", "finish the import").title
                  : "Downloading footage"}
        </span>
        {job.state === "failed" && (
          <button
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              setRetryError(null);
              void api
                .resumeScript(project.id)
                .then(({ job }) => useEditor.setState({ scriptJob: job }))
                // Never a Retry that quietly does nothing: say why it can't.
                .catch(setRetryError)
                .finally(() => setRetrying(false));
            }}
            className="flex h-6 items-center gap-1 rounded-md px-2 text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <RotateCw size={11} className={retrying ? "animate-spin" : undefined} /> Retry
          </button>
        )}
      </div>
      {job.state === "failed" && !job.files.some((file) => file.state === "failed") && job.error && (
        <ProblemView error={job.error} doing="finish the import" className="mb-2" />
      )}
      {retryError !== null && <ProblemView error={retryError} doing="retry the import" className="mb-2" />}
      <div className="flex flex-col gap-2">
        {job.files.map((file) => {
          const info = labels.get(file.file);
          const progress = file.state === "done" ? 1 : file.state === "cutting" ? (file.cut && file.cut.total > 0 ? file.cut.done / file.cut.total : 0) : file.total ? file.bytes / file.total : 0;
          return (
            <div key={file.file}>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: info?.color }} />
                <span className="min-w-0 flex-1 truncate text-muted" title={file.name}>
                  {info?.label}
                  {file.name && <span className="text-faint"> · {file.name}</span>}
                </span>
                <span className="shrink-0 text-faint tabular">
                  {file.state === "queued"
                    ? "Waiting"
                    : file.state === "cutting"
                      ? file.cut
                        ? `Cutting excerpts · ${file.cut.done} of ${file.cut.total}`
                        : "Cutting excerpts…"
                      : file.state === "done"
                        ? "Done"
                        : file.state === "failed"
                          ? "Failed"
                          : file.total
                            ? `${size(file.bytes)} / ${size(file.total)}`
                            : "Starting…"}
                </span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-hover">
                <div
                  className={cx("h-full rounded-full transition-[width] duration-300", file.state === "failed" ? "bg-danger" : "bg-white/70")}
                  style={{ width: `${Math.round((file.state === "failed" ? 1 : progress) * 100)}%` }}
                />
              </div>
              {file.error && <ProblemView error={file.error} doing="download this file" className="mt-1.5" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** No script yet: paste a Google Doc. */
function AttachScript({ project }: { project: Project }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attach = async () => {
    setBusy(true);
    setError(null);
    try {
      const { rev, project: next, job } = await api.attachScript(project.id, url.trim());
      useEditor.getState().adopt(rev, next);
      useEditor.setState({ scriptJob: job });
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-1 flex-col justify-center px-6"
      onSubmit={(event) => {
        event.preventDefault();
        void attach();
      }}
    >
      <span className="mx-auto flex size-11 items-center justify-center rounded-2xl bg-raised text-muted ring-1 ring-line">
        <FileText size={19} />
      </span>
      <div className="mt-3 text-center font-medium">Follow a script</div>
      <p className="mx-auto mt-1 max-w-[280px] text-center text-[12px] leading-relaxed text-muted">
        Paste a script or a compilation's case links: Google Docs, Drive folders or files, YouTube, or a Trello card. Existing scripts keep their ranges and cut-in words. Mark a finished video “reuse” to keep it whole.
      </p>
      <textarea
        rows={4}
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="Case 1: https://drive.google.com/drive/folders/…\nCase 2 (reuse): https://docs.google.com/document/d/…"
        onPaste={(event) => {
          const plain = event.clipboardData.getData("text/plain");
          const pasted = importPaste(event.clipboardData.getData("text/html"), plain);
          if (pasted === plain) return;
          event.preventDefault();
          const node = event.currentTarget;
          setUrl(url.slice(0, node.selectionStart) + pasted + url.slice(node.selectionEnd));
        }}
        className="mt-4 w-full resize-y rounded-lg border border-line bg-black px-3 py-2 text-[13px] outline-none placeholder:text-faint focus:border-muted"
      />
      {error && <ProblemView error={error} doing="read the case links" className="mt-2" />}
      <Button type="submit" variant="primary" className="mt-3 self-center" disabled={busy || !url.trim()}>
        {busy ? "Reading the case links…" : "Import"}
      </Button>
    </form>
  );
}
