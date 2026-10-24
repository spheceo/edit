import { Archive, Check, CloudAlert, CloudCheck, CloudDownload, CloudOff, CloudUpload, Copy, Ellipsis, ExternalLink, FileVideo, Lock, MessageSquare, Pencil, Plus, Search, Trash2, TriangleAlert } from "lucide-react";
import { motion } from "motion/react";
import { Fragment, useEffect, useState } from "react";

import { editStyles, useAccount } from "../lib/account";
import { api, type ProjectStatus, type WriterScriptRow } from "../lib/api";
import { cloudApi, type CloudList, type CloudProject, type CloudStatus } from "../lib/cloud";
import { copyDriveLink, openDrive, useDriveLink } from "../lib/drive";
import { navigate } from "../lib/route";
import { clientId, connectEvents, useEditor } from "../lib/store";
import { ago, shortDuration } from "../lib/time";
import { STYLES, type ProjectSummary, type Style } from "../lib/types";
import { AppMenu } from "./AppMenu";
import { toggleMenu } from "./ContextMenu";
import { Logo, Tile } from "./Logo";
import { SetupCard } from "./SetupCard";
import { StartedBy } from "./StartedBy";
import { UpdateButton } from "./UpdateButton";
import { Button, cx, Modal, spring } from "./ui";

// Every project is 1080p at 30 fps.
const FORMAT = { width: 1920, height: 1080, fps: 30 };

export function Home() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [cloud, setCloud] = useState<CloudList | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ProjectStatus>>({});
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind>(() => (localStorage.getItem(KIND) === "subtitled" ? "subtitled" : "edits"));
  const [style, setStyle] = useState<Style | null>(null);
  const toast = useEditor((state) => state.toast);

  const refresh = () => {
    // The cloud’s list is fetched beside this machine’s, never in its way.
    void cloudApi
      .projects()
      .then(setCloud)
      .catch(() => setCloud(null));
    // Feedback waiting, and finished edits not exported as they are now.
    void api
      .projectStatus()
      .then(setStatuses)
      .catch(() => {});
    return api
      .projects()
      .then(({ projects }) => setProjects(projects))
      .catch((error) => toast(`Couldn’t reach Edit: ${error.message}`, "error"));
  };

  useEffect(() => {
    // Home hears the server too: a client's review notes Edit had missed are said here as well.
    connectEvents();
    void refresh();
    // Who’s editing what changes while the list is up.
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
  const showEdits = kind !== "subtitled";
  // One table, newest change first, local and cloud-only projects together.
  const rows: Listed[] = [
    ...(showEdits ? edits : subtitled).map((project) => ({ at: project.modified_ms, local: project, cloud: null })),
    ...(showEdits ? cloudEdits : cloudSubtitled).map((project) => ({ at: project.updated_ms, local: null, cloud: project })),
  ].sort((a, b) => b.at - a.at);
  const cardProps = (project: ProjectSummary) => ({
    project,
    onChanged: refresh,
    cloudOn: Boolean(cloud?.on),
    status: cloud?.statuses?.[project.id],
    remote: remote.get(project.id),
    state: statuses[project.id],
  });
  const choose = (value: Kind) => {
    localStorage.setItem(KIND, value);
    setKind(value);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1120px] px-8 pt-8 pb-16">
        <header className="flex items-center gap-4">
          <Logo size={22} />
          {projects && count > 0 && (
            <label className="ml-4 flex h-[34px] max-w-[420px] flex-1 items-center gap-2 rounded-lg border border-line-strong bg-bg px-2.5 text-muted focus-within:border-muted">
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
            {/* One red main action a screen: on an empty Home, the empty state's button is it. */}
            <Button variant={projects && count === 0 ? "subtle" : "primary"} onClick={() => setCreating(true)}>
              <Plus size={15} strokeWidth={2.2} /> New project
            </Button>
            <AppMenu />
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
            <Tile size={64} />
            <h1 className="mt-6 text-[22px] font-semibold tracking-[-0.02em]">Make your first edit</h1>
            <p className="mt-2 max-w-[360px] text-muted">
              {cloud?.on
                ? "Projects are kept in the team’s cloud, so anyone can pick one up where you left off. Import footage, cut it, and let an agent build the polish."
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
              {/* The kit's segmented control (.sp-seg). */}
              <div className="flex h-[34px] gap-0.5 rounded-[9px] border border-line bg-panel p-0.5">
                {(
                  [
                    ["edits", "Edits", all.filter((project) => !project.subtitles).length + cloudEditsAll],
                    ["subtitled", "Subtitled videos", all.filter((project) => project.subtitles).length + cloudOnly.length - cloudEditsAll],
                  ] as [Kind, string, number][]
                ).map(([value, label, total]) => (
                  <button
                    key={value}
                    onClick={() => choose(value)}
                    className={cx(
                      "flex items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors",
                      kind === value ? "bg-active text-fg" : "text-muted hover:text-fg",
                    )}
                  >
                    {label} <span className="font-normal text-faint tabular">{total}</span>
                  </button>
                ))}
              </div>
              {cloud?.on && cloud.error && (
                <span className="text-[12px] text-warning/80" title={cloud.error}>
                  {cloud.offline ? "Can’t reach the cloud: showing what’s on this Mac." : "The cloud’s list didn’t load."}
                </span>
              )}
              <div className="ml-auto flex gap-1.5">
                {STYLES.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => setStyle(style === option.value ? null : option.value)}
                    className={cx(
                      // The kit's filter pill (.sp-pill, pressed fills with the surface).
                      "flex h-6 items-center gap-1.5 rounded-full border px-[9px] text-[12px] transition-colors",
                      style === option.value ? "border-line-strong bg-raised text-fg" : "border-line text-secondary hover:bg-hover",
                    )}
                  >
                    <span className="size-1.5 rounded-full" style={{ background: STYLE_COLOURS[option.value] }} />
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {rows.length > 0 ? (
              <ProjectTable rows={rows} cardProps={cardProps} onChanged={refresh} subtitled={!showEdits} />
            ) : (
              <p className="mt-16 text-center text-muted">Nothing matches{words ? ` “${query.trim()}”` : ""}.</p>
            )}
          </>
        )}
      </div>
      <NewProject open={creating} onClose={() => setCreating(false)} only={style} />
    </div>
  );
}

type Kind = "edits" | "subtitled";

/** A row of Home's table: a project on this Mac, or one only in the cloud. */
type Listed = { at: number; local: ProjectSummary; cloud: null } | { at: number; local: null; cloud: CloudProject };

/** Which list Home shows (remembered on this browser). */
const KIND = "edit.home.kind";

/** Each kind of video’s colour (its dot on cards and filters). */
const STYLE_COLOURS: Record<Style, string> = { bodycam: "#7aa2ff", interrogation: "#ff5f6d", courtroom: "#c4a7ff" };

/** A quiet mark among a row’s chips: its footage isn’t on this Mac yet (opening it downloads it). */
function NotHere({ title }: { title: string }) {
  return (
    <span title={title} className="flex shrink-0 items-center px-1 text-faint">
      <CloudDownload size={13} />
    </span>
  );
}

interface NoticeProps {
  tone: "warn" | "bad" | "info";
  text: string;
  title: string;
}

/** A small chip on a card saying what’s off: footage missing, footage still in the cloud. */
function Notice({ tone, text, title }: NoticeProps) {
  const Icon = tone === "info" ? CloudDownload : TriangleAlert;
  return (
    <span
      title={title}
      className={cx(
        "flex h-[22px] shrink-0 items-center gap-1 rounded-full bg-raised px-2 text-[12px] font-medium",
        tone === "info" ? "text-fg" : tone === "bad" ? "text-danger" : "text-warning",
      )}
    >
      <Icon size={12} />
      {text}
    </span>
  );
}

/** What a project’s card says about it, and what can be done to it (rename, delete, move to cloud). */
function useProject(project: ProjectSummary, onChanged: () => void, cloudOn: boolean, status?: CloudStatus, remote?: CloudProject) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [moving, setMoving] = useState(false);
  const toast = useEditor((state) => state.toast);
  const drive = useDriveLink(project.id, project.drive);
  const inCloud = cloudOn && Boolean(status?.cloud);
  // Footage the timeline plays that’s gone from this Mac (deleted, or on a drive that isn’t plugged in).
  const missing = project.missing ?? 0;
  const used = project.media_used ?? missing;
  const mostlyMissing = missing > 0 && missing * 2 >= used;
  // Cloud footage not on this Mac yet: it comes down when the project opens.
  const fetching = project.remote ?? 0;
  const mostlyRemote = !mostlyMissing && fetching > 0 && fetching * 2 >= used;
  // Someone else’s live lock (this machine’s own isn’t news).
  const editor = remote?.holder && !remote.here ? remote.holder : null;
  // The cloud is only worth a word when something’s off.
  const cloudNews = inCloud && (editor !== null || status?.sync === "conflict" || status?.dirty === true || status?.sync === "offline");

  const rename = async (name: string) => {
    setRenaming(false);
    if (!name || name === project.name) return;
    try {
      const live = await api.project(project.id);
      await api.saveProject(project.id, live.rev, { ...live.project, name }, clientId);
      onChanged();
    } catch (error) {
      toast(`Couldn’t rename: ${(error as Error).message}`, "error");
    }
  };
  const remove = async () => {
    setDeleting(false);
    try {
      await api.deleteProject(project.id);
    } catch (error) {
      toast(`Couldn’t delete “${project.name}”: ${(error as Error).message}`, "error");
    }
    onChanged();
  };
  const open = () => {
    if (renaming) return;
    if (project.problem) toast(`“${project.name}” can’t be opened: ${project.problem}`, "error");
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
          <h2 className="text-[18px] font-semibold tracking-[-0.3px]">Delete “{project.name}”?</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            {inCloud
              ? "It’s deleted from the cloud too, for everyone on the team. A copy is kept in this Mac’s Edit data folder; footage files stay where they are."
              : "The project and its edit are removed (a copy is kept in Edit’s data folder). Your footage files stay where they are."}
          </p>
          <div className="mt-[22px] flex justify-end gap-2">
            <Button variant="subtle" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void remove()}>
              {inCloud ? "Delete everywhere" : "Delete project"}
            </Button>
          </div>
        </div>
      </Modal>
      <MoveToCloud project={project} open={moving} onClose={() => setMoving(false)} onMoved={onChanged} />
    </>
  );
  // What’s worth a word on the card, as a chip beside "On Drive".
  const notice: NoticeProps | null = project.problem
    ? { tone: "bad", text: "Can’t be opened", title: project.problem }
    : missing > 0
      ? {
          tone: "warn",
          text: mostlyMissing ? "Footage missing" : `${missing} ${missing === 1 ? "file" : "files"} missing`,
          title: `${missing} of ${used} footage files the edit plays aren’t on this Mac (deleted, or on a drive that isn’t plugged in)`,
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

/** Chips for a project’s review notes waiting and a finished edit not exported as it is now. */
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
        className="flex h-[22px] shrink-0 items-center gap-1.5 rounded-full bg-raised px-2 text-[12px] font-medium text-muted"
      >
        <Archive size={12} />
        {state.archived.restoring ? "Restoring…" : "Archived"}
        {!state.archived.restoring && (
          <button onClick={restore} className="text-info hover:text-info">
            Restore
          </button>
        )}
      </span>
    );
  }
  return (
    <>
      {state.approved !== null && (
        <span title={`Version ${state.approved} was approved on its review`} className="flex h-[22px] shrink-0 items-center gap-1 rounded-full bg-raised px-2 text-[12px] font-medium text-success">
          <Check size={12} />
          Approved v{state.approved}
        </span>
      )}
      {state.approved === null && state.feedback > 0 && (
        <span
          title={`${state.feedback} open note${state.feedback === 1 ? "" : "s"} on its Repack review`}
          className="flex h-[22px] shrink-0 items-center gap-1 rounded-full bg-raised px-2 text-[12px] font-medium text-info"
        >
          <MessageSquare size={12} />
          {state.feedback} {state.feedback === 1 ? "note" : "notes"}
        </span>
      )}
      {state.complete && !state.exported && (
        <span title="The edit is finished, but what it is now hasn’t been exported" className="flex h-[22px] shrink-0 items-center gap-1 rounded-full bg-raised px-2 text-[12px] font-medium text-warning">
          <FileVideo size={12} />
          Not exported
        </span>
      )}
    </>
  );
}

/** When a project last changed, as Writer heads its list: today needs no heading. */
function changedLabel(ms: number) {
  const day = (time: number) => new Date(time).setHours(0, 0, 0, 0);
  const days = Math.round((day(Date.now()) - day(ms)) / 86_400_000);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? "This week" : days < 31 ? "This month" : "Older";
}

/** Name, status, length, when it last changed and its ⋯: the columns every row lines up on. */
const COLUMNS = "grid grid-cols-[minmax(0,2.6fr)_minmax(0,1.3fr)_64px_92px_30px] items-center gap-4";

/** Home's projects as Writer lists scripts: one table, grouped by when they last changed. */
function ProjectTable({
  rows,
  cardProps,
  onChanged,
  subtitled,
}: {
  rows: Listed[];
  cardProps: (project: ProjectSummary) => CardProps;
  onChanged: () => void;
  subtitled: boolean;
}) {
  return (
    <div role="table" aria-label="Projects" className="mt-6 overflow-hidden rounded-xl border border-line">
      <div role="row" className={cx(COLUMNS, "h-10 bg-panel px-4 text-[12px] font-medium text-muted")}>
        <span role="columnheader">Name</span>
        <span role="columnheader">Status</span>
        <span role="columnheader" className="text-right">
          Length
        </span>
        <span role="columnheader" className="text-right">
          Updated
        </span>
        <span role="columnheader" className="sr-only">
          Actions
        </span>
      </div>
      {rows.map((row, index) => {
        const label = changedLabel(row.at);
        const heading = label !== "Today" && (index === 0 || changedLabel(rows[index - 1]!.at) !== label);
        return (
          <Fragment key={row.local?.id ?? row.cloud!.id}>
            {heading && <div className="border-t border-line px-4 pt-3.5 pb-1.5 text-[11.5px] font-medium text-faint">{label}</div>}
            {row.local !== null ? <TableRow {...cardProps(row.local)} subtitled={subtitled} /> : <CloudTableRow project={row.cloud} onChanged={onChanged} />}
          </Fragment>
        );
      })}
    </div>
  );
}

/** A project on this Mac: its name, what's worth a word about it, and its ⋯. */
function TableRow({ subtitled, ...props }: CardProps & { subtitled: boolean }) {
  const { project, onChanged, remote, state } = props;
  const card = useProject(project, onChanged, props.cloudOn, props.status, remote);
  return (
    <>
      <div role="row" onClick={card.open} className={cx(COLUMNS, "group min-h-14 cursor-pointer border-t border-line px-4 py-2.5 transition-colors hover:bg-panel")}>
        <div role="cell" className="flex min-w-0 items-center gap-2.5">
          <span className="size-1.5 shrink-0 rounded-full" style={{ background: STYLE_COLOURS[project.style] ?? STYLE_COLOURS.bodycam }} title={STYLES.find((option) => option.value === project.style)?.label} />
          {card.nameInput ?? (
            <span className="truncate text-[14px] text-fg group-hover:underline group-hover:underline-offset-[3px]" title={project.problem ?? project.name}>
              {project.name}
            </span>
          )}
          <StartedBy by={remote?.created_by ?? project.created_by} projectId={project.id} size={24} className="ml-auto shrink-0" />
        </div>
        <div role="cell" className="flex min-w-0 flex-wrap items-center gap-1">
          {card.notice && <Notice {...card.notice} />}
          <StateChips state={state} projectId={project.id} onChanged={onChanged} />
          {card.cloudNews && <CloudBadge status={card.status} editor={card.editor} />}
          {card.drive ? (
            <button onClick={card.driveMenu} title={`On Drive: ${card.drive.name}`} className="flex h-[22px] items-center rounded-full bg-raised px-2 text-[12px] font-medium text-success hover:bg-hover">
              On Drive ↗
            </button>
          ) : (
            subtitled && <span className="text-[12px] text-faint">Not uploaded</span>
          )}
          {card.mostlyRemote && <NotHere title="Its footage downloads when you open it" />}
        </div>
        <span role="cell" className="text-right text-[13px] text-secondary tabular">
          {project.problem ? "" : shortDuration(project.duration_frames / project.fps)}
        </span>
        <span role="cell" className="text-right text-[13px] text-secondary">
          {ago(project.modified_ms)}
        </span>
        <button
          title="More"
          onClick={card.menu}
          className="flex size-[30px] items-center justify-center rounded-md text-muted opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:bg-hover hover:text-fg"
        >
          <Ellipsis size={15} />
        </button>
      </div>
      {card.dialogs}
    </>
  );
}

/** A project only in the cloud: opening it downloads it to this Mac. */
function CloudTableRow({ project, onChanged }: { project: CloudProject; onChanged: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const toast = useEditor((state) => state.toast);
  const summary = project.summary ?? {};
  const style = (summary.style as Style | undefined) ?? "bodycam";
  const seconds = summary.durationFrames && summary.fps ? summary.durationFrames / summary.fps : null;
  const remove = async () => {
    setDeleting(false);
    try {
      await api.deleteProject(project.id);
    } catch (error) {
      toast(`Couldn’t delete “${project.name}”: ${(error as Error).message}`, "error");
    }
    onChanged();
  };
  return (
    <>
      <div role="row" onClick={() => navigate(`/p/${project.id}`)} className={cx(COLUMNS, "group min-h-14 cursor-pointer border-t border-line px-4 py-2.5 transition-colors hover:bg-panel")}>
        <div role="cell" className="flex min-w-0 items-center gap-2.5">
          <span className="size-1.5 shrink-0 rounded-full" style={{ background: STYLE_COLOURS[style] ?? STYLE_COLOURS.bodycam }} />
          <span className="truncate text-[14px] text-fg group-hover:underline group-hover:underline-offset-[3px]" title={project.name}>
            {project.name}
          </span>
          <StartedBy by={project.created_by} projectId={project.id} size={24} className="ml-auto shrink-0" />
        </div>
        <div role="cell" className="flex min-w-0 flex-wrap items-center gap-1">
          {project.holder && <CloudBadge editor={project.holder} />}
          <span className="flex items-center gap-1 text-[12px] text-faint" title="Not on this Mac yet: opening it downloads it">
            <CloudDownload size={13} /> Not on this Mac
          </span>
        </div>
        <span role="cell" className="text-right text-[13px] text-secondary tabular">
          {seconds !== null ? shortDuration(seconds) : ""}
        </span>
        <span role="cell" className="text-right text-[13px] text-secondary" title={`by ${project.updated_by}`}>
          {ago(project.updated_ms)}
        </span>
        <button
          title="More"
          onClick={(event) => {
            event.stopPropagation();
            toggleMenu(event.currentTarget, [{ label: "Delete…", icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(true) }], { width: 160 });
          }}
          className="flex size-[30px] items-center justify-center rounded-md text-muted opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:bg-hover hover:text-fg"
        >
          <Ellipsis size={15} />
        </button>
      </div>
      <Modal open={deleting} onClose={() => setDeleting(false)} width={380}>
        <div className="p-6">
          <h2 className="text-[18px] font-semibold tracking-[-0.3px]">Delete “{project.name}”?</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">It’s deleted from the cloud, for everyone on the team. It isn’t on this Mac, so no copy is kept here.</p>
          <div className="mt-[22px] flex justify-end gap-2">
            <Button variant="subtle" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void remove()}>
              Delete everywhere
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/** A cloud project’s badge: who’s editing it, else whether it’s in sync. */
function CloudBadge({ status, editor }: { status?: CloudStatus; editor: string | null }) {
  const [Icon, text, title] = editor
    ? [Lock, `${editor} is editing`, `${editor} is editing it now: it opens read-only until they close it.`]
    : status?.sync === "conflict"
      ? [CloudAlert, "Conflict", status.message ?? "A conflict: this Mac’s changes were kept as a copy."]
      : status?.dirty || status?.sync === "offline"
        ? [CloudOff, "Not synced", "Changes saved on this Mac haven’t reached the cloud yet."]
        : [CloudCheck, "Cloud", "In the team’s cloud"];
  return (
    <div title={title} className="flex h-[22px] items-center gap-1 rounded-full bg-raised px-2 text-[12px] font-medium text-fg">
      <Icon size={13} className={editor ? "text-warning" : undefined} />
      {text}
    </div>
  );
}

/** "Move to cloud": a project from before cloud, uploaded so teammates can open it. Its footage isn’t moved. */
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
      toast(`Couldn’t move it to the cloud: ${(error as Error).message}`, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} width={400}>
      <div className="p-6">
        <h2 className="text-[18px] font-semibold tracking-[-0.3px]">Move “{project.name}” to the cloud?</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">The edit is uploaded so a teammate can open it on their Mac and carry on. One machine edits it at a time.</p>
        {localMedia !== null && localMedia > 0 && (
          <p className="mt-2 text-[13px] leading-relaxed text-warning/90">
            Its footage ({localMedia} {localMedia === 1 ? "file" : "files"}) stays on this Mac: this doesn’t upload it, so on another Mac those clips show as missing.
          </p>
        )}
        <div className="mt-[22px] flex justify-end gap-2">
          <Button variant="subtle" onClick={onClose}>
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

type Preview = Awaited<ReturnType<typeof api.scriptPreview>>;

const DOC = /docs\.google\.com\/document\/d\//;

/** One field (a name for a blank project, or a Google Doc link to start from its script) and the kind of video. */
/** `only`: the kind of video Home is filtered to: its Writer scripts are the ones listed, and a new project is that kind. */
function NewProject({ open, onClose, only = null }: { open: boolean; onClose: () => void; only?: Style | null }) {
  const [text, setText] = useState("");
  const [style, setStyle] = useState<Style>("bodycam");
  // Only the styles this account makes full edits in (none: subtitled videos only, which start as a plain project).
  const allowed = editStyles(useAccount((state) => state.account));
  const styles = STYLES.filter((option) => allowed === null || allowed.has(option.value));
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ url: string; result?: Preview; error?: string } | null>(null);
  const toast = useEditor((state) => state.toast);
  const [scripts, setScripts] = useState<WriterScriptRow[] | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const url = text.trim();
  const script = DOC.test(url);

  // A fresh dialog each time, with Writer’s scripts as they are now.
  useEffect(() => {
    if (!open) return;
    setText("");
    setPreview(null);
    if (only !== null && (allowed === null || allowed.has(only))) setStyle(only);
    else if (styles.length > 0 && !styles.some((option) => option.value === style)) setStyle(styles[0]!.value);
    let alive = true;
    api
      .writerScripts()
      .then(({ scripts }) => alive && setScripts(scripts))
      .catch(() => alive && setScripts([]));
    return () => {
      alive = false;
    };
  }, [open]);

  // Writer’s scripts, newest first, narrowed by what’s typed.
  const words = script ? "" : url.toLowerCase();
  const fromWriter = (scripts ?? [])
    .filter((one) => one.built && (words === "" || one.title.toLowerCase().includes(words)))
    // Home filtered to a kind of video: that kind’s scripts (and any Writer hasn’t said).
    .filter((one) => only === null || one.style === null || one.style === only)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const startScript = async (one: WriterScriptRow) => {
    if (one.project !== null) {
      onClose();
      navigate(`/p/${one.project}`);
      return;
    }
    setStarting(one.id);
    try {
      const { project } = await api.importWriter(one.id);
      useEditor.getState().setMediaTab("downloads");
      onClose();
      navigate(`/p/${project}`);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setStarting(null);
    }
  };

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
    // A script makes a full edit: not for an account of subtitled videos only (the server refuses it too).
    if (script && allowed !== null && !allowed.has(style)) {
      toast("Your account can’t make full edits: an admin can give you an Edit style at accounts.spheceo.com.", "error");
      return;
    }
    setBusy(true);
    try {
      const name = script ? preview?.result?.title || "Untitled" : url || "Untitled";
      const { project } = await api.createProject({ name, style, ...FORMAT });
      if (script) {
        await api.attachScript(project.id, url);
        useEditor.getState().setMediaTab("downloads");
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
    <Modal open={open} onClose={onClose} width={520}>
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
          placeholder="Name a project, paste a Google Doc, or find a Writer script"
          onChange={(event) => setText(event.target.value)}
          className="h-11 w-full rounded-lg bg-transparent px-3 text-[14px] outline-none placeholder:text-faint"
        />
        {script && (
          <div className="truncate px-3 pb-2 text-[12px] text-muted">
            {preview?.error ? (
              <span className="text-danger">{preview.error}</span>
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
        {!script && fromWriter.length > 0 && (
          <div className="border-t border-line px-1 pt-2 pb-1">
            <div className="px-2 pb-1 text-[13px] font-medium text-muted">From Writer</div>
            <div className="max-h-[264px] overflow-y-auto">
              {fromWriter.map((one) => (
                <button
                  type="button"
                  key={one.id}
                  disabled={starting !== null}
                  onClick={() => void startScript(one)}
                  className="group flex h-11 w-full items-center gap-3 rounded-lg px-2 text-left transition-colors hover:bg-hover disabled:opacity-60"
                >
                  <img src="/writer-mark.svg" alt="" className="size-[18px] shrink-0" />
                  {one.style !== null && <span title={STYLES.find((option) => option.value === one.style)?.label} className="size-1.5 shrink-0 rounded-full" style={{ background: STYLE_COLOURS[one.style] }} />}
                  <span className="min-w-0 flex-1 truncate text-[13px]">{one.title}</span>
                  <span className="shrink-0 text-[12px] text-faint tabular group-hover:hidden">
                    {one.durationMs > 0 ? `${shortDuration(one.durationMs / 1000)} · ` : ""}
                    {ago(one.updatedAt)}
                  </span>
                  <span className="hidden shrink-0 text-[12px] font-medium text-fg group-hover:inline">
                    {starting === one.id ? "Starting…" : one.project !== null ? "Open" : "Edit it"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 border-t border-line px-1 pt-2 pb-0.5">
          <div className={cx("mr-auto flex rounded-lg bg-black p-0.5 ring-1 ring-line", styles.length === 0 && "invisible")}>
            {styles.map((option) => (
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
