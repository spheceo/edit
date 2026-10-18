import { Captions, Cloud, CloudAlert, CloudCheck, CloudDownload, CloudOff, CloudUpload, Copy, Ellipsis, ExternalLink, Lock, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { cloudApi, type CloudList, type CloudProject, type CloudStatus } from "../lib/cloud";
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
  const [cloud, setCloud] = useState<CloudList | null>(null);
  const [creating, setCreating] = useState(false);
  const toast = useEditor((state) => state.toast);

  const refresh = () => {
    // The cloud's list is fetched beside this machine's, never in its way.
    void cloudApi
      .projects()
      .then(setCloud)
      .catch(() => setCloud(null));
    return api
      .projects()
      .then(({ projects }) => setProjects(projects))
      .catch((error) => toast(`Couldn't reach Edit: ${error.message}`, "error"));
  };

  useEffect(() => {
    void refresh();
    // Who's editing what changes while the list is up.
    const timer = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remote = new Map((cloud?.projects ?? []).map((project) => [project.id, project]));
  const cloudOnly = (cloud?.projects ?? []).filter((project) => !project.local && !projects?.some((local) => local.id === project.id));
  const count = (projects?.length ?? 0) + cloudOnly.length;

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

        {projects && count === 0 && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={spring}
            className="mt-[18vh] flex flex-col items-center text-center"
          >
            <Mark size={64} />
            <h1 className="mt-6 text-[22px] font-semibold tracking-[-0.02em]">Make your first edit</h1>
            <p className="mt-2 max-w-[360px] text-muted">
              {cloud?.on
                ? "Projects are kept in the team's cloud, so anyone can pick one up where you left off. Import footage, cut it, and let an agent build the polish."
                : "Projects live on this machine. Import footage, cut it, and let an agent build the polish."}
            </p>
            <Button variant="primary" className="mt-6" onClick={() => setCreating(true)}>
              <Plus size={15} strokeWidth={2.2} /> New project
            </Button>
          </motion.div>
        )}

        {projects && count > 0 && (
          <>
            <div className="mt-12 mb-4 flex items-baseline gap-3">
              <h2 className="text-[12px] font-medium tracking-wide text-muted uppercase">Projects</h2>
              {cloud?.on && cloud.error && (
                <span className="text-[12px] text-amber-300/80" title={cloud.error}>
                  {cloud.offline ? "Can't reach the cloud: showing what's on this Mac." : "The cloud's list didn't load."}
                </span>
              )}
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4">
              {projects.map((project, index) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  index={index}
                  onChanged={refresh}
                  cloudOn={Boolean(cloud?.on)}
                  status={cloud?.statuses?.[project.id]}
                  remote={remote.get(project.id)}
                />
              ))}
              {cloudOnly.map((project, index) => (
                <CloudCard key={project.id} project={project} index={projects.length + index} onChanged={refresh} />
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

function ProjectCard({
  project,
  index,
  onChanged,
  cloudOn,
  status,
  remote,
}: {
  project: ProjectSummary;
  index: number;
  onChanged: () => void;
  /** Cloud is on here. */
  cloudOn: boolean;
  /** Its cloud state on this machine (a cloud project). */
  status?: CloudStatus;
  /** It as listed in the cloud. */
  remote?: CloudProject;
}) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [moving, setMoving] = useState(false);
  const toast = useEditor((state) => state.toast);
  const drive = useDriveLink(project.id, project.drive);
  const seconds = project.duration_frames / project.fps;
  const aspect = project.width / project.height;
  const inCloud = cloudOn && Boolean(status?.cloud);
  // Footage the timeline plays that's gone from this Mac (deleted, or on a drive that isn't plugged in).
  const missing = project.missing ?? 0;
  const used = project.media_used ?? missing;
  const mostlyMissing = missing > 0 && missing * 2 >= used;
  // Cloud footage not on this Mac yet: it comes down when the project opens.
  const fetching = project.remote ?? 0;
  const mostlyRemote = !mostlyMissing && fetching > 0 && fetching * 2 >= used;
  // Someone else's live lock (this machine's own isn't news).
  const editor = remote?.holder && !remote.here ? remote.holder : null;

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

  const remove = async () => {
    setDeleting(false);
    try {
      await api.deleteProject(project.id);
    } catch (error) {
      toast(`Couldn't delete “${project.name}”: ${(error as Error).message}`, "error");
    }
    onChanged();
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
          ) : mostlyMissing ? (
            <div className="flex flex-col items-center gap-1.5 px-6 text-center" title={`${missing} of ${used} footage files the edit plays aren't on this Mac`}>
              <TriangleAlert size={20} className="text-amber-400" />
              <span className="text-[12.5px] font-medium text-fg">Footage missing</span>
              <span className="text-[11.5px] text-muted tabular">
                {missing} of {used} files aren't on this Mac
              </span>
            </div>
          ) : mostlyRemote ? (
            <div className="flex flex-col items-center gap-1.5 px-6 text-center">
              <CloudDownload size={20} className="text-muted" />
              <span className="text-[12.5px] font-medium text-fg">Footage in the cloud</span>
              <span className="text-[11.5px] text-muted">Downloads when you open it</span>
            </div>
          ) : project.duration_frames > 0 ? (
            <img
              src={`/api/projects/${project.id}/frame/${coverFrame(project)}.png?max=480&v=${project.modified_ms}`}
              loading="lazy"
              alt=""
              className="max-h-full max-w-full opacity-0 transition-opacity duration-300"
              style={{ aspectRatio: aspect }}
              onLoad={(event) => event.currentTarget.classList.remove("opacity-0")}
            />
          ) : (
            <Mark size={36} cut="#0a0a0a" />
          )}
          {(project.subtitles || drive || inCloud) && (
            <div className="absolute top-2 left-2 flex gap-1">
              {inCloud && <CloudBadge status={status} editor={editor} />}
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
                  ...(cloudOn && !status?.cloud && !project.problem
                    ? [{ label: "Move to cloud…", icon: <CloudUpload size={14} />, onSelect: () => setMoving(true) }]
                    : []),
                  { separator: true },
                  { label: "Delete…", icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(true) },
                ],
                { width: 180 },
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
            {!project.problem && missing > 0 && !mostlyMissing && (
              <span className="text-amber-300"> · {missing} {missing === 1 ? "file" : "files"} missing</span>
            )}
          </div>
        </div>
      </motion.div>
      <Modal open={deleting} onClose={() => setDeleting(false)} width={380}>
        <div className="p-6">
          <h2 className="text-[15px] font-semibold">Delete “{project.name}”?</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">
            {inCloud
              ? "It's deleted from the cloud too, for everyone on the team. A copy is kept in this Mac's Edit data folder; footage files stay where they are."
              : "The project and its edit are removed (a copy is kept in Edit's data folder). Your footage files stay where they are."}
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void remove()}>
              {inCloud ? "Delete everywhere" : "Delete project"}
            </Button>
          </div>
        </div>
      </Modal>
      <MoveToCloud project={project} open={moving} onClose={() => setMoving(false)} onMoved={onChanged} />
    </>
  );
}

/** A cloud project's badge: who's editing it, else whether it's in sync. */
function CloudBadge({ status, editor }: { status?: CloudStatus; editor: string | null }) {
  const [Icon, text, title] = editor
    ? [Lock, `${editor} is editing`, `${editor} is editing it now: it opens read-only until they close it.`]
    : status?.sync === "conflict"
      ? [CloudAlert, "Conflict", status.message ?? "A conflict: this Mac's changes were kept as a copy."]
      : status?.dirty || status?.sync === "offline"
        ? [CloudOff, "Not synced", "Changes saved on this Mac haven't reached the cloud yet."]
        : [CloudCheck, "Cloud", "In the team's cloud"];
  return (
    <div title={title} className="flex h-6 items-center gap-1 rounded-md bg-black/75 px-2 text-[11px] font-medium text-fg">
      <Icon size={13} className={editor ? "text-amber-300" : undefined} />
      {text}
    </div>
  );
}

/** "Move to cloud": a project from before cloud, uploaded so teammates can open it. Its footage isn't moved. */
function MoveToCloud({ project, open, onClose, onMoved }: { project: ProjectSummary; open: boolean; onClose: () => void; onMoved: () => void }) {
  const [localMedia, setLocalMedia] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useEditor((state) => state.toast);
  useEffect(() => {
    if (!open) return;
    setLocalMedia(null);
    api
      .project(project.id)
      .then(({ project }) => setLocalMedia(project.media.filter((media) => !media.cloud).length))
      .catch(() => setLocalMedia(null));
  }, [open, project.id]);
  const move = async () => {
    setBusy(true);
    try {
      await cloudApi.moveToCloud(project.id);
      toast(`“${project.name}” is going to the cloud.`);
      onClose();
      onMoved();
    } catch (error) {
      toast(`Couldn't move it to the cloud: ${(error as Error).message}`, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} width={400}>
      <div className="p-6">
        <h2 className="text-[15px] font-semibold">Move “{project.name}” to the cloud?</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">The edit is uploaded so a teammate can open it on their Mac and carry on. One machine edits it at a time.</p>
        {localMedia !== null && localMedia > 0 && (
          <p className="mt-2 text-[13px] leading-relaxed text-amber-300/90">
            Its footage ({localMedia} {localMedia === 1 ? "file" : "files"}) stays on this Mac: this doesn't upload it, so on another Mac those clips show as missing.
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void move()}>
            {busy ? "Moving…" : "Move to cloud"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** A project only in the cloud: opening it downloads it to this Mac. */
function CloudCard({ project, index, onChanged }: { project: CloudProject; index: number; onChanged: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const toast = useEditor((state) => state.toast);
  const summary = project.summary ?? {};
  const style = STYLES.find((option) => option.value === summary.style)?.label;
  const seconds = summary.durationFrames && summary.fps ? summary.durationFrames / summary.fps : null;
  const remove = async () => {
    setDeleting(false);
    try {
      await api.deleteProject(project.id);
    } catch (error) {
      toast(`Couldn't delete “${project.name}”: ${(error as Error).message}`, "error");
    }
    onChanged();
  };
  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...spring, delay: Math.min(index, 12) * 0.03 }}
        className="group cursor-pointer"
        onClick={() => navigate(`/p/${project.id}`)}
      >
        <div className="relative flex aspect-video flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border border-dashed border-line bg-panel text-[12px] text-muted transition-[border-color] duration-200 group-hover:border-line-strong">
          <CloudDownload size={22} />
          Open to download
          <div className="absolute top-2 left-2 flex gap-1">
            <CloudBadge editor={project.holder} />
          </div>
          <button
            title="More"
            onClick={(event) => {
              event.stopPropagation();
              toggleMenu(event.currentTarget, [{ label: "Delete…", icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(true) }], { width: 160 });
            }}
            className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-md bg-black/70 text-muted opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:text-fg"
          >
            <Ellipsis size={15} />
          </button>
        </div>
        <div className="mt-2.5 px-0.5">
          <div className="truncate font-medium">{project.name}</div>
          <div className="mt-0.5 truncate text-[12px] text-muted tabular">
            {[style, seconds !== null ? shortDuration(seconds) : null, `${ago(project.updated_ms)} by ${project.updated_by}`].filter(Boolean).join(" · ")}
          </div>
        </div>
      </motion.div>
      <Modal open={deleting} onClose={() => setDeleting(false)} width={380}>
        <div className="p-6">
          <h2 className="text-[15px] font-semibold">Delete “{project.name}”?</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">It's deleted from the cloud, for everyone on the team. It isn't on this Mac, so no copy is kept here.</p>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void remove()}>
              Delete everywhere
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
