import { Captions, Cloud, Copy, Ellipsis, ExternalLink, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { copyDriveLink, openDrive, useDriveLink } from "../lib/drive";
import { navigate } from "../lib/route";
import { clientId, useEditor } from "../lib/store";
import { ago, shortDuration } from "../lib/time";
import { STYLES, type ProjectSummary, type Style } from "../lib/types";
import { AppMenu } from "./AppMenu";
import { toggleMenu } from "./ContextMenu";
import { Logo, Mark } from "./Logo";
import { SetupCard } from "./SetupCard";
import { UpdateButton } from "./UpdateButton";
import { Button, cx, Modal, spring } from "./ui";

// Every project is 1080p at 30 fps.
const FORMAT = { width: 1920, height: 1080, fps: 30 };

export function Home() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const toast = useEditor((state) => state.toast);

  const refresh = () =>
    api
      .projects()
      .then(({ projects }) => setProjects(projects))
      .catch((error) => toast(`Couldn't reach Edit: ${error.message}`, "error"));

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1040px] px-8 pt-8 pb-16">
        <header className="flex items-center justify-between">
          <Logo size={22} />
          <div className="flex items-center gap-1.5">
            <UpdateButton />
            <AppMenu />
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={15} strokeWidth={2.2} /> New project
            </Button>
          </div>
        </header>

        <SetupCard />

        {projects && projects.length === 0 && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={spring}
            className="mt-[18vh] flex flex-col items-center text-center"
          >
            <Mark size={64} />
            <h1 className="mt-6 text-[22px] font-semibold tracking-[-0.02em]">Make your first edit</h1>
            <p className="mt-2 max-w-[360px] text-muted">Projects live on this machine. Import footage, cut it, and let an agent build the polish.</p>
            <Button variant="primary" className="mt-6" onClick={() => setCreating(true)}>
              <Plus size={15} strokeWidth={2.2} /> New project
            </Button>
          </motion.div>
        )}

        {projects && projects.length > 0 && (
          <>
            <h2 className="mt-12 mb-4 text-[12px] font-medium tracking-wide text-muted uppercase">Projects</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4">
              {projects.map((project, index) => (
                <ProjectCard key={project.id} project={project} index={index} onChanged={refresh} />
              ))}
            </div>
          </>
        )}
      </div>
      <NewProject open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

/** The card's picture: a frame near the start rather than the first (often a
 * dip from black), between 1 s in and 15% of the way (at most the first
 * minute), picked per project so it stays the same between visits. */
function coverFrame(project: ProjectSummary) {
  const total = project.duration_frames;
  const from = Math.min(total - 1, Math.round(project.fps));
  const to = Math.max(from, Math.min(Math.round(total * 0.15), Math.round(project.fps * 60)));
  let hash = 2166136261;
  for (const c of project.id) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
  return from + (hash % (to - from + 1));
}

function ProjectCard({ project, index, onChanged }: { project: ProjectSummary; index: number; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const toast = useEditor((state) => state.toast);
  const drive = useDriveLink(project.id, project.drive);
  const seconds = project.duration_frames / project.fps;
  const aspect = project.width / project.height;

  const rename = async (name: string) => {
    setRenaming(false);
    if (!name || name === project.name) return;
    try {
      const live = await api.project(project.id);
      await api.saveProject(project.id, live.rev, { ...live.project, name }, clientId);
      onChanged();
    } catch (error) {
      toast(`Couldn't rename: ${(error as Error).message}`, "error");
    }
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...spring, delay: Math.min(index, 12) * 0.03 }}
        className="group cursor-pointer"
        onClick={() => {
          if (renaming) return;
          if (project.problem) toast(`“${project.name}” can't be opened: ${project.problem}`, "error");
          else navigate(`/p/${project.id}`);
        }}
      >
        <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl border border-line bg-panel transition-[border-color] duration-200 group-hover:border-line-strong">
          {project.problem ? (
            <div className="flex flex-col items-center gap-2 px-6 text-center text-[12px] text-muted">
              <TriangleAlert size={20} className="text-amber-400" />
              Can't be opened
            </div>
          ) : project.duration_frames > 0 ? (
            <img
              src={`/api/projects/${project.id}/frame/${coverFrame(project)}.png?max=480`}
              loading="lazy"
              alt=""
              className="max-h-full max-w-full opacity-0 transition-opacity duration-300"
              style={{ aspectRatio: aspect }}
              onLoad={(event) => event.currentTarget.classList.remove("opacity-0")}
            />
          ) : (
            <Mark size={36} cut="#0a0a0a" />
          )}
          {(project.subtitles || drive) && (
            <div className="absolute top-2 left-2 flex gap-1">
              {project.subtitles && (
                <div className="flex h-6 items-center gap-1 rounded-md bg-black/75 px-2 text-[11px] font-medium text-fg">
                  <Captions size={13} />
                  Subtitles
                </div>
              )}
              {drive && (
                <button
                  title={`On Drive: ${drive.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleMenu(
                      event.currentTarget,
                      [
                        { label: "Copy Drive link", icon: <Copy size={14} />, onSelect: () => void copyDriveLink(drive.url, toast) },
                        { label: "Open on Drive", icon: <ExternalLink size={14} />, onSelect: () => openDrive(drive.url) },
                      ],
                      { width: 180, at: { x: event.currentTarget.getBoundingClientRect().left, y: event.currentTarget.getBoundingClientRect().bottom + 4 } },
                    );
                  }}
                  className="flex h-6 items-center gap-1 rounded-md bg-black/75 px-2 text-[11px] font-medium text-fg hover:bg-black"
                >
                  <Cloud size={13} />
                  Drive
                </button>
              )}
            </div>
          )}
          <button
            title="More"
            onClick={(event) => {
              event.stopPropagation();
              toggleMenu(
                event.currentTarget,
                [
                  { label: "Rename", icon: <Pencil size={14} />, onSelect: () => setRenaming(true) },
                  { separator: true },
                  { label: "Delete…", icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(true) },
                ],
                { width: 160 },
              );
            }}
            className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-md bg-black/70 text-muted opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:text-fg"
          >
            <Ellipsis size={15} />
          </button>
        </div>
        <div className="mt-2.5 px-0.5">
          {renaming ? (
            <input
              autoFocus
              defaultValue={project.name}
              onClick={(event) => event.stopPropagation()}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={(event) => void rename(event.currentTarget.value.trim())}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setRenaming(false);
              }}
              className="-mx-1.5 h-6 w-[calc(100%+12px)] rounded-md bg-hover px-1.5 font-medium outline-none"
            />
          ) : (
            <div className="truncate font-medium">{project.name}</div>
          )}
          <div className="mt-0.5 truncate text-[12px] text-muted tabular" title={project.problem}>
            {project.problem
              ? `${project.problem} · ${ago(project.modified_ms)}`
              : `${STYLES.find((style) => style.value === project.style)?.label ?? "Bodycam"} · ${shortDuration(seconds)} · ${ago(project.modified_ms)}`}
          </div>
        </div>
      </motion.div>
      <Modal open={deleting} onClose={() => setDeleting(false)} width={380}>
        <div className="p-6">
          <h2 className="text-[15px] font-semibold">Delete “{project.name}”?</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">The project and its edit are removed (a copy is kept in Edit's data folder). Your footage files stay where they are.</p>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setDeleting(false);
                void api.deleteProject(project.id).then(onChanged);
              }}
            >
              Delete project
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

type Preview = Awaited<ReturnType<typeof api.scriptPreview>>;

const DOC = /docs\.google\.com\/document\/d\//;

/** One field (a name for a blank project, or a Google Doc link to start from its script) and the kind of video. */
function NewProject({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState("");
  const [style, setStyle] = useState<Style>("bodycam");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ url: string; result?: Preview; error?: string } | null>(null);
  const toast = useEditor((state) => state.toast);
  const url = text.trim();
  const script = DOC.test(url);

  // A fresh dialog each time.
  useEffect(() => {
    if (!open) return;
    setText("");
    setPreview(null);
  }, [open]);

  // Read the Doc as soon as a link is pasted: its title names the project.
  useEffect(() => {
    if (!script) {
      setPreview(null);
      return;
    }
    let alive = true;
    setPreview({ url });
    const timer = setTimeout(() => {
      api
        .scriptPreview(url)
        .then((result) => alive && setPreview({ url, result }))
        .catch((error) => alive && setPreview({ url, error: (error as Error).message }));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [url, script]);

  const ready = !script || Boolean(preview?.result);
  const create = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const name = script ? preview?.result?.title || "Untitled" : url || "Untitled";
      const { project } = await api.createProject({ name, style, ...FORMAT });
      if (script) {
        await api.attachScript(project.id, url);
        useEditor.getState().setSideTab("downloads");
      }
      onClose();
      navigate(`/p/${project.id}`);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={440}>
      <form
        className="p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <input
          autoFocus
          value={text}
          placeholder="Project name, or paste a Google Doc script"
          onChange={(event) => setText(event.target.value)}
          className="h-11 w-full rounded-lg bg-transparent px-3 text-[14px] outline-none placeholder:text-faint"
        />
        {script && (
          <div className="truncate px-3 pb-2 text-[12px] text-muted">
            {preview?.error ? (
              <span className="text-red-300">{preview.error}</span>
            ) : preview?.result ? (
              <span className="tabular">
                <span className="text-fg">{preview.result.title || "Untitled script"}</span> · {preview.result.files} Drive{" "}
                {preview.result.files === 1 ? "file" : "files"} · {preview.result.narration} cut-ins · {shortDuration(preview.result.seconds)}
              </span>
            ) : (
              <span className="shimmer">Reading the Doc…</span>
            )}
          </div>
        )}
        <div className="flex items-center gap-2 border-t border-line px-1 pt-2 pb-0.5">
          <div className="mr-auto flex rounded-lg bg-black p-0.5 ring-1 ring-line">
            {STYLES.map((option) => (
              <button
                type="button"
                key={option.value}
                onClick={() => setStyle(option.value)}
                className={cx(
                  "h-7 rounded-md px-3 text-[12px] font-medium transition-colors",
                  style === option.value ? "bg-active text-fg" : "text-muted hover:text-fg",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <Button type="submit" variant="primary" disabled={busy || !ready}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
