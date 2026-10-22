import { Archive, Check, ChevronRight, CloudAlert, CloudCheck, CloudDownload, CloudOff, CloudUpload, Copy, Ellipsis, ExternalLink, FileVideo, Lock, MessageSquare, Pencil, Plus, Search, Trash2, TriangleAlert } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";

import { api, type ProjectStatus, type WriterScriptRow } from "../lib/api";
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
  const [statuses, setStatuses] = useState<Record<string, ProjectStatus>>({});
  const [writer, setWriter] = useState<WriterScriptRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [style, setStyle] = useState<Style | null>(null);
  const [subtitledOpen, setSubtitledOpen] = useState(() => localStorage.getItem(SUBTITLED_OPEN) === "1");
  const toast = useEditor((state) => state.toast);

  const refresh = () => {
    // The cloud's list is fetched beside this machine's, never in its way.
    void cloudApi
      .projects()
      .then(setCloud)
      .catch(() => setCloud(null));
    // Feedback waiting, and finished edits not exported as they are now.
    void api
      .projectStatus()
      .then(setStatuses)
      .catch(() => {});
    // Scripts written in Writer, ready to edit.
    void api
      .writerScripts()
      .then(({ scripts }) => setWriter(scripts))
      .catch(() => setWriter([]));
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

  // What the search and filters keep.
  const words = query.trim().toLowerCase();
  const kept = (name: string, own: Style | undefined) => (words === "" || name.toLowerCase().includes(words)) && (style === null || own === style);
  const all = projects ?? [];
  const edits = all.filter((project) => !project.subtitles && kept(project.name, project.style));
  const subtitled = all.filter((project) => project.subtitles && kept(project.name, project.style));
  const cloudKept = cloudOnly.filter((project) => kept(project.name, project.summary?.style as Style | undefined));
  const cloudSubtitled = cloudKept.filter((project) => project.summary?.subtitles === true);
  const cloudEdits = cloudKept.filter((project) => project.summary?.subtitles !== true);
  const cloudEditsAll = cloudOnly.filter((project) => project.summary?.subtitles !== true).length;
  // The two edits worked on last, big at the top, while nothing narrows the list
  // (from the cloud too: a Mac that has none here yet still gets them).
  const narrowed = words !== "" || style !== null || kind !== "all";
  const newest = [
    ...edits.filter((project) => !project.problem).map((project) => ({ at: project.modified_ms, local: project as ProjectSummary | null, cloud: null as CloudProject | null })),
    ...cloudEdits.map((project) => ({ at: project.updated_ms, local: null as ProjectSummary | null, cloud: project as CloudProject | null })),
  ].sort((a, b) => b.at - a.at);
  const continuing = narrowed ? [] : newest.slice(0, 2);
  const rest = edits.filter((project) => !continuing.some((one) => one.local === project));
  const restCloud = cloudEdits.filter((project) => !continuing.some((one) => one.cloud === project));
  const showEdits = kind !== "subtitled";
  const showSubtitled = kind !== "edits";
  const cardProps = (project: ProjectSummary) => ({
    project,
    onChanged: refresh,
    cloudOn: Boolean(cloud?.on),
    status: cloud?.statuses?.[project.id],
    remote: remote.get(project.id),
    state: statuses[project.id],
  });
  const toggleSubtitled = () => {
    localStorage.setItem(SUBTITLED_OPEN, subtitledOpen ? "0" : "1");
    setSubtitledOpen(!subtitledOpen);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1120px] px-8 pt-8 pb-16">
        <header className="flex items-center gap-4">
          <Logo size={22} />
          {projects && count > 0 && (
            <label className="ml-4 flex h-8 max-w-[420px] flex-1 items-center gap-2 rounded-lg border border-line px-2.5 text-muted focus-within:border-line-strong">
              <Search size={14} />
              <input
                value={query}
                placeholder="Search projects"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => event.key === "Escape" && setQuery("")}
                className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
              />
            </label>
          )}
          <div className="ml-auto flex items-center gap-1.5">
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
            <div className="mt-8 flex flex-wrap items-center gap-2">
              <div className="flex rounded-lg bg-panel p-0.5 ring-1 ring-line">
                {(
                  [
                    ["all", "All", all.length + cloudOnly.length],
                    ["edits", "Edits", all.filter((project) => !project.subtitles).length + cloudEditsAll],
                    ["subtitled", "Subtitled videos", all.filter((project) => project.subtitles).length + cloudOnly.length - cloudEditsAll],
                  ] as [Kind, string, number][]
                ).map(([value, label, total]) => (
                  <button
                    key={value}
                    onClick={() => setKind(value)}
                    className={cx(
                      "h-7 rounded-md px-3 text-[12px] font-medium transition-colors",
                      kind === value ? "bg-active text-fg" : "text-muted hover:text-fg",
                    )}
                  >
                    {label} <span className="text-faint tabular">{total}</span>
                  </button>
                ))}
              </div>
              {cloud?.on && cloud.error && (
                <span className="text-[12px] text-amber-300/80" title={cloud.error}>
                  {cloud.offline ? "Can't reach the cloud: showing what's on this Mac." : "The cloud's list didn't load."}
                </span>
              )}
              <div className="ml-auto flex gap-1.5">
                {STYLES.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => setStyle(style === option.value ? null : option.value)}
                    className={cx(
                      "flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] transition-colors",
                      style === option.value ? "border-line-strong bg-active text-fg" : "border-line text-muted hover:text-fg",
                    )}
                  >
                    <span className="size-1.5 rounded-full" style={{ background: STYLE_COLOURS[option.value] }} />
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {continuing.length > 0 && showEdits && (
              <section className="mt-8">
                <SectionTitle>Continue</SectionTitle>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {continuing.map((one, index) =>
                    one.local !== null ? (
                      <ProjectCard key={one.local.id} index={index} big {...cardProps(one.local)} />
                    ) : (
                      <CloudCard key={one.cloud!.id} project={one.cloud!} index={index} big onChanged={refresh} />
                    ),
                  )}
                </div>
              </section>
            )}

            {showEdits && !narrowed && writer.some((one) => one.project === null) && <FromWriter scripts={writer.filter((one) => one.project === null).slice(0, 6)} onChanged={refresh} />}

            {showEdits && (rest.length > 0 || restCloud.length > 0) && (
              <section className="mt-9">
                <SectionTitle count={rest.length + restCloud.length}>{continuing.length > 0 ? "More edits" : "Edits"}</SectionTitle>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4">
                  {rest.map((project, index) => (
                    <ProjectCard key={project.id} index={index} {...cardProps(project)} />
                  ))}
                  {restCloud.map((project, index) => (
                    <CloudCard key={project.id} project={project} index={rest.length + index} onChanged={refresh} />
                  ))}
                </div>
              </section>
            )}

            {showSubtitled && subtitled.length + cloudSubtitled.length > 0 && (
              <section className="mt-9">
                {kind === "subtitled" ? (
                  <SectionTitle count={subtitled.length + cloudSubtitled.length}>Subtitled videos</SectionTitle>
                ) : (
                  <button onClick={toggleSubtitled} className="group/title mb-3 flex items-center gap-1.5">
                    <ChevronRight size={14} className={cx("text-muted transition-transform", subtitledOpen && "rotate-90")} />
                    <span className="text-[12px] font-medium tracking-wide text-muted uppercase group-hover/title:text-fg">Subtitled videos</span>
                    <span className="text-[12px] text-faint tabular">{subtitled.length + cloudSubtitled.length}</span>
                  </button>
                )}
                {(subtitledOpen || kind === "subtitled") && (
                  <div className="overflow-hidden rounded-xl border border-line">
                    {subtitled.map((project) => (
                      <ProjectRow key={project.id} {...cardProps(project)} />
                    ))}
                    {cloudSubtitled.map((project) => (
                      <CloudRow key={project.id} project={project} />
                    ))}
                  </div>
                )}
              </section>
            )}

            {(showEdits ? edits.length + cloudEdits.length : 0) + (showSubtitled ? subtitled.length + cloudSubtitled.length : 0) === 0 && (
              <p className="mt-16 text-center text-muted">Nothing matches{words ? ` “${query.trim()}”` : ""}.</p>
            )}
          </>
        )}
      </div>
      <NewProject open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

type Kind = "all" | "edits" | "subtitled";

/** Whether the subtitled videos' list is open (remembered on this browser). */
const SUBTITLED_OPEN = "edit.home.subtitledOpen";

/** Each kind of video's colour (its dot on cards and filters). */
const STYLE_COLOURS: Record<Style, string> = { bodycam: "#7aa2ff", interrogation: "#ff5f6d", courtroom: "#ffd166" };

function SectionTitle({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <h2 className="mb-3 flex items-baseline gap-2 text-[12px] font-medium tracking-wide text-muted uppercase">
      {children}
      {count !== undefined && <span className="text-faint tabular">{count}</span>}
    </h2>
  );
}

/**
 * The card's picture: the server's pick (plain footage running, no cut-in,
 * graphic or cut on screen, its file here; the same until the project
 * changes), null when it has none.
 */
function coverFrame(project: ProjectSummary): number | null {
  if (project.duration_frames <= 0) return null;
  return project.cover_frame ?? null;
}

/** A card with no picture: a dark wash of its style's colour. */
function wash(style: Style): string {
  const colour = STYLE_COLOURS[style] ?? STYLE_COLOURS.bodycam;
  return `radial-gradient(120% 90% at 20% 0%, ${colour}33 0%, transparent 60%), radial-gradient(90% 80% at 100% 100%, ${colour}1f 0%, transparent 55%), #0b0b0b`;
}

/** A quiet mark at the end of a card's line: it isn't on this Mac yet (opening it downloads it). */
function NotHere({ title }: { title: string }) {
  return (
    <span title={title} className="ml-auto flex shrink-0 items-center gap-1 pl-2 text-white/55">
      <CloudDownload size={13} />
    </span>
  );
}

interface NoticeProps {
  tone: "warn" | "bad" | "info";
  text: string;
  title: string;
}

/** A small chip on a card saying what's off: footage missing, footage still in the cloud. */
function Notice({ tone, text, title }: NoticeProps) {
  const Icon = tone === "info" ? CloudDownload : TriangleAlert;
  return (
    <span
      title={title}
      className={cx(
        "flex h-6 shrink-0 items-center gap-1 rounded-md bg-black/75 px-2 text-[11px] font-medium",
        tone === "info" ? "text-fg" : tone === "bad" ? "text-red-300" : "text-amber-300",
      )}
    >
      <Icon size={12} />
      {text}
    </span>
  );
}

/** What a project's card says about it, and what can be done to it (rename, delete, move to cloud). */
function useProject(project: ProjectSummary, onChanged: () => void, cloudOn: boolean, status?: CloudStatus, remote?: CloudProject) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [moving, setMoving] = useState(false);
  const toast = useEditor((state) => state.toast);
  const drive = useDriveLink(project.id, project.drive);
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
  // The cloud is only worth a word when something's off.
  const cloudNews = inCloud && (editor !== null || status?.sync === "conflict" || status?.dirty === true || status?.sync === "offline");

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
  const open = () => {
    if (renaming) return;
    if (project.problem) toast(`“${project.name}” can't be opened: ${project.problem}`, "error");
    else navigate(`/p/${project.id}`);
  };
  const menu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    toggleMenu(
      event.currentTarget,
      [
        { label: "Rename", icon: <Pencil size={14} />, onSelect: () => setRenaming(true) },
        ...(drive
          ? [
              { label: "Copy Drive link", icon: <Copy size={14} />, onSelect: () => void copyDriveLink(drive.url, toast) },
              { label: "Open on Drive", icon: <ExternalLink size={14} />, onSelect: () => openDrive(drive.url) },
            ]
          : []),
        ...(cloudOn && !status?.cloud && !project.problem
          ? [{ label: "Move to cloud…", icon: <CloudUpload size={14} />, onSelect: () => setMoving(true) }]
          : []),
        { separator: true },
        { label: "Delete…", icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(true) },
      ],
      { width: 190 },
    );
  };
  const driveMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    if (!drive) return;
    const box = event.currentTarget.getBoundingClientRect();
    toggleMenu(
      event.currentTarget,
      [
        { label: "Copy Drive link", icon: <Copy size={14} />, onSelect: () => void copyDriveLink(drive.url, toast) },
        { label: "Open on Drive", icon: <ExternalLink size={14} />, onSelect: () => openDrive(drive.url) },
      ],
      { width: 180, at: { x: box.left, y: box.bottom + 4 } },
    );
  };
  const nameInput = renaming ? (
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
      className="-mx-1.5 h-7 w-[calc(100%+12px)] rounded-md bg-black/80 px-1.5 font-semibold text-fg outline-none"
    />
  ) : null;
  const dialogs = (
    <>
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
  // What's worth a word on the card, as a chip beside "On Drive".
  const notice: NoticeProps | null = project.problem
    ? { tone: "bad", text: "Can't be opened", title: project.problem }
    : missing > 0
      ? {
          tone: "warn",
          text: mostlyMissing ? "Footage missing" : `${missing} ${missing === 1 ? "file" : "files"} missing`,
          title: `${missing} of ${used} footage files the edit plays aren't on this Mac (deleted, or on a drive that isn't plugged in)`,
        }
      : null;
  return { drive, missing, used, mostlyMissing, mostlyRemote, editor, cloudNews, status, notice, open, menu, driveMenu, nameInput, dialogs };
}

interface CardProps {
  project: ProjectSummary;
  onChanged: () => void;
  /** Cloud is on here. */
  cloudOn: boolean;
  /** Its cloud state on this machine (a cloud project). */
  status?: CloudStatus;
  /** It as listed in the cloud. */
  remote?: CloudProject;
  /** Its feedback and export state. */
  state?: ProjectStatus;
}

/** Writer's newest scripts not edited here yet: one click makes the project and starts its import (footage from the shared registry). */
function FromWriter({ scripts, onChanged }: { scripts: WriterScriptRow[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useEditor((state) => state.toast);
  const start = async (one: WriterScriptRow) => {
    setBusy(one.id);
    try {
      const { project } = await api.importWriter(one.id);
      onChanged();
      navigate(`/p/${project}`);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="mt-9">
      <SectionTitle count={scripts.length}>From Writer</SectionTitle>
      <div className="overflow-hidden rounded-xl border border-line">
        {scripts.map((one) => (
          <div key={one.id} className="flex h-12 items-center gap-3 border-t border-line px-3 first:border-t-0">
            <img src="/writer-mark.svg" alt="Writer" className="size-5 shrink-0" />
            <div className="min-w-0 flex-1 truncate font-medium">{one.title}</div>
            {one.handoff !== null && (
              <span className="shrink-0 rounded-md bg-sky-400/15 px-2 py-0.5 text-[11px] font-medium text-sky-300" title={one.handoff.changed ? "Changed in Writer since it was sent" : undefined}>
                Sent to Edit{one.handoff.by ? ` by ${one.handoff.by}` : ""}
                {one.handoff.changed ? " · changed since" : ""}
              </span>
            )}
            <span className="shrink-0 text-[12px] text-faint">
              {one.updatedBy ? `${one.updatedBy} · ` : ""}
              {ago(one.handoff?.at ?? one.updatedAt)}
            </span>
            <Button size="sm" disabled={busy !== null} onClick={() => void start(one)}>
              {busy === one.id ? "Starting…" : "Edit it"}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Chips for a project's review notes waiting and a finished edit not exported as it is now. */
function StateChips({ state, projectId, onChanged }: { state?: ProjectStatus; projectId?: string; onChanged?: () => void }) {
  const toast = useEditor((store) => store.toast);
  if (state === undefined) return null;
  if (state.archived !== null) {
    const restore = (event: React.MouseEvent) => {
      event.stopPropagation();
      if (projectId === undefined) return;
      void api
        .restoreProject(projectId)
        .then(() => {
          toast("Restoring: its footage is downloading again", "info");
          onChanged?.();
        })
        .catch((error) => toast((error as Error).message, "error"));
    };
    return (
      <span
        title={state.archived.error ?? "Archived on Repack: its footage and exports were freed; the project and its transcripts are kept"}
        className="flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-black/75 px-2 text-[11px] font-medium text-muted"
      >
        <Archive size={12} />
        {state.archived.restoring ? "Restoring…" : "Archived"}
        {!state.archived.restoring && (
          <button onClick={restore} className="text-sky-300 hover:text-sky-200">
            Restore
          </button>
        )}
      </span>
    );
  }
  return (
    <>
      {state.approved !== null && (
        <span title={`Version ${state.approved} was approved on its review`} className="flex h-6 shrink-0 items-center gap-1 rounded-md bg-black/75 px-2 text-[11px] font-medium text-green-300">
          <Check size={12} />
          Approved v{state.approved}
        </span>
      )}
      {state.approved === null && state.feedback > 0 && (
        <span
          title={`${state.feedback} open note${state.feedback === 1 ? "" : "s"} on its Repack review`}
          className="flex h-6 shrink-0 items-center gap-1 rounded-md bg-black/75 px-2 text-[11px] font-medium text-sky-300"
        >
          <MessageSquare size={12} />
          {state.feedback} {state.feedback === 1 ? "note" : "notes"}
        </span>
      )}
      {state.complete && !state.exported && (
        <span title="The edit is finished, but what it is now hasn't been exported" className="flex h-6 shrink-0 items-center gap-1 rounded-md bg-black/75 px-2 text-[11px] font-medium text-amber-300">
          <FileVideo size={12} />
          Not exported
        </span>
      )}
    </>
  );
}

/** An edit: a frame of it with the title over a black gradient, as a streaming service's tile. */
function ProjectCard({ project, onChanged, cloudOn, status, remote, state, index, big = false }: CardProps & { index: number; big?: boolean }) {
  const card = useProject(project, onChanged, cloudOn, status, remote);
  const seconds = project.duration_frames / project.fps;
  const styleLabel = STYLES.find((option) => option.value === project.style)?.label ?? "Bodycam";
  const picture = !project.problem && coverFrame(project) !== null;
  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...spring, delay: Math.min(index, 12) * 0.03 }}
        className="group cursor-pointer"
        onClick={card.open}
      >
        <div
          className={cx(
            "relative aspect-video overflow-hidden rounded-xl border border-line bg-panel transition-[border-color,transform] duration-200 group-hover:border-line-strong",
            big && "md:aspect-[16/8]",
          )}
        >
          {picture ? (
            <img
              src={`/api/projects/${project.id}/cover/${coverFrame(project)}.jpg?max=${big ? 1280 : 720}&v=${project.modified_ms}`}
              loading="lazy"
              alt=""
              className="absolute inset-0 size-full object-cover opacity-0 transition-[opacity,transform] duration-500 group-hover:scale-[1.03]"
              onLoad={(event) => event.currentTarget.classList.remove("opacity-0")}
            />
          ) : (
            <div className="absolute inset-0" style={{ background: wash(project.style) }} />
          )}
          {/* The black gradient the title sits on. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[78%] bg-gradient-to-t from-black via-black/85 via-45% to-transparent" />
          <div className={cx("absolute inset-x-0 bottom-0", big ? "p-5" : "p-3.5")}>
            {card.nameInput ?? (
              <div className={cx("line-clamp-2 font-semibold tracking-[-0.01em] text-white drop-shadow", big ? "text-[19px] leading-tight" : "text-[14px] leading-snug")}>
                {project.name}
              </div>
            )}
            <div className="mt-1 flex items-center gap-1.5 truncate text-[12px] text-white/70 tabular">
              <span className="size-1.5 shrink-0 rounded-full" style={{ background: STYLE_COLOURS[project.style] ?? STYLE_COLOURS.bodycam }} />
              {project.problem ? (
                <span className="truncate" title={project.problem}>
                  {project.problem}
                </span>
              ) : (
                <span className="truncate">
                  {styleLabel} · {shortDuration(seconds)} · {ago(project.modified_ms)}
                </span>
              )}
              {card.mostlyRemote && <NotHere title="Its footage downloads when you open it" />}
            </div>
          </div>
          {(card.cloudNews || card.drive || card.notice || (state && (state.archived !== null || state.approved !== null || state.feedback > 0 || (state.complete && !state.exported)))) && (
            <div className="absolute top-2.5 left-2.5 flex gap-1">
              {card.notice && <Notice {...card.notice} />}
              <StateChips state={state} projectId={project.id} onChanged={onChanged} />
              {card.cloudNews && <CloudBadge status={card.status} editor={card.editor} />}
              {card.drive && (
                <button
                  onClick={card.driveMenu}
                  title={`On Drive: ${card.drive.name}`}
                  className="flex h-6 items-center rounded-md bg-black/75 px-2 text-[11px] font-medium text-green-300 hover:bg-black"
                >
                  On Drive ↗
                </button>
              )}
            </div>
          )}
          <button
            title="More"
            onClick={card.menu}
            className="absolute top-2.5 right-2.5 flex size-7 items-center justify-center rounded-md bg-black/70 text-muted opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:text-fg"
          >
            <Ellipsis size={15} />
          </button>
        </div>
      </motion.div>
      {card.dialogs}
    </>
  );
}

/** A subtitled video: a row in the list (they're mostly opened for their Drive link). */
function ProjectRow({ project, onChanged, cloudOn, status, remote, state }: CardProps) {
  const card = useProject(project, onChanged, cloudOn, status, remote);
  const seconds = project.duration_frames / project.fps;
  const picture = !project.problem && coverFrame(project) !== null;
  return (
    <>
      <div onClick={card.open} className="group flex h-14 cursor-pointer items-center gap-3 border-t border-line px-3 first:border-t-0 hover:bg-hover">
        <div className="flex h-9 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-panel">
          {picture ? (
            <img src={`/api/projects/${project.id}/cover/${coverFrame(project)}.jpg?max=192&v=${project.modified_ms}`} loading="lazy" alt="" className="size-full object-cover" />
          ) : (
            <div className="size-full" style={{ background: wash(project.style) }} />
          )}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {card.nameInput ?? <div className="truncate font-medium">{project.name}</div>}
          {card.notice && <Notice {...card.notice} />}
          <StateChips state={state} projectId={project.id} onChanged={onChanged} />
          {card.cloudNews && <CloudBadge status={card.status} editor={card.editor} />}
        </div>
        <span className="w-16 shrink-0 text-right text-[12px] text-muted tabular">{shortDuration(seconds)}</span>
        <span className="w-20 shrink-0 text-right text-[12px] text-faint">{ago(project.modified_ms)}</span>
        <span className="w-24 shrink-0 text-right text-[12px]">
          {card.drive ? (
            <button onClick={card.driveMenu} title={`On Drive: ${card.drive.name}`} className="text-green-300/90 hover:text-green-200">
              On Drive ↗
            </button>
          ) : (
            <span className="text-faint">Not uploaded</span>
          )}
        </span>
        <button
          title="More"
          onClick={card.menu}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:text-fg"
        >
          <Ellipsis size={15} />
        </button>
      </div>
      {card.dialogs}
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

/** A subtitled video only in the cloud: a row as the others, opening it downloads it. */
function CloudRow({ project }: { project: CloudProject }) {
  const summary = project.summary ?? {};
  const seconds = summary.durationFrames && summary.fps ? summary.durationFrames / summary.fps : null;
  return (
    <div onClick={() => navigate(`/p/${project.id}`)} className="group flex h-14 cursor-pointer items-center gap-3 border-t border-line px-3 first:border-t-0 hover:bg-hover">
      <div className="relative h-9 w-16 shrink-0 overflow-hidden rounded-md" style={{ background: wash((summary.style as Style | undefined) ?? "bodycam") }}>
        <img src={`/api/cloud/projects/${project.id}/cover.jpg?v=${project.updated_ms}`} loading="lazy" alt="" className="absolute inset-0 size-full object-cover" onError={(event) => event.currentTarget.remove()} />
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="truncate font-medium">{project.name}</div>
        {project.holder && <CloudBadge editor={project.holder} />}
      </div>
      <span className="w-16 shrink-0 text-right text-[12px] text-muted tabular">{seconds !== null ? shortDuration(seconds) : ""}</span>
      <span className="w-20 shrink-0 text-right text-[12px] text-faint">{ago(project.updated_ms)}</span>
      <span className="flex w-24 shrink-0 items-center justify-end gap-1 text-[12px] text-faint" title="Not on this Mac yet: opening it downloads it">
        <CloudDownload size={13} /> Not here
      </span>
      <span className="size-7 shrink-0" />
    </div>
  );
}

/** A project only in the cloud: opening it downloads it to this Mac. */
function CloudCard({ project, index, onChanged, big = false }: { project: CloudProject; index: number; onChanged: () => void; big?: boolean }) {
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
        <div className={cx("relative aspect-video overflow-hidden rounded-xl border border-line bg-panel transition-[border-color] duration-200 group-hover:border-line-strong", big && "md:aspect-[16/8]")}>
          <div className="absolute inset-0" style={{ background: wash((summary.style as Style | undefined) ?? "bodycam") }} />
          <img
            src={`/api/cloud/projects/${project.id}/cover.jpg?v=${project.updated_ms}`}
            loading="lazy"
            alt=""
            className="absolute inset-0 size-full object-cover opacity-0 transition-[opacity,transform] duration-500 group-hover:scale-[1.03]"
            onLoad={(event) => event.currentTarget.classList.remove("opacity-0")}
            onError={(event) => event.currentTarget.remove()}
          />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[78%] bg-gradient-to-t from-black via-black/85 via-45% to-transparent" />
          <div className={cx("absolute inset-x-0 bottom-0", big ? "p-5" : "p-3.5")}>
            <div className={cx("line-clamp-2 font-semibold tracking-[-0.01em] text-white drop-shadow", big ? "text-[19px] leading-tight" : "text-[14px] leading-snug")}>{project.name}</div>
            <div className="mt-1 flex items-center gap-1.5 truncate text-[12px] text-white/70 tabular">
              <span className="size-1.5 shrink-0 rounded-full" style={{ background: STYLE_COLOURS[(summary.style as Style | undefined) ?? "bodycam"] ?? STYLE_COLOURS.bodycam }} />
              <span className="truncate">{[style, seconds !== null ? shortDuration(seconds) : null, `${ago(project.updated_ms)} by ${project.updated_by}`].filter(Boolean).join(" · ")}</span>
              <NotHere title="Not on this Mac yet: opening it downloads it" />
            </div>
          </div>
          {project.holder && (
            <div className="absolute top-2.5 left-2.5 flex gap-1">
              <CloudBadge editor={project.holder} />
            </div>
          )}
          <button
            title="More"
            onClick={(event) => {
              event.stopPropagation();
              toggleMenu(event.currentTarget, [{ label: "Delete…", icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(true) }], { width: 160 });
            }}
            className="absolute top-2.5 right-2.5 flex size-7 items-center justify-center rounded-md bg-black/70 text-muted opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:text-fg"
          >
            <Ellipsis size={15} />
          </button>
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
