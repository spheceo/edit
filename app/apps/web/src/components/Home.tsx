import { Archive, Check, CloudAlert, CloudCheck, CloudDownload, CloudOff, CloudUpload, Copy, Ellipsis, ExternalLink, FileText, FileVideo, LoaderCircle, Lock, MessageSquare, Pencil, Plus, Search, Share2, Trash2, TriangleAlert } from "lucide-react";
import { motion } from "motion/react";
import { Fragment, useEffect, useRef, useState } from "react";

import { editStyles, makesVideos, useAccount, writesScripts } from "../lib/account";
import { api, type ProjectStatus, type WriterScriptRow } from "../lib/api";
import { hasImportLinks, importPaste } from "../lib/import-input";
import { cloudApi, type CloudList, type CloudProject, type CloudStatus } from "../lib/cloud";
import { copyDriveLink, openDrive, useDriveLink } from "../lib/drive";
import { navigate } from "../lib/route";
import { clientId, connectEvents, useEditor } from "../lib/store";
import { ago, shortDuration } from "../lib/time";
import { NARRATION, STYLES, type ProjectSummary, type Style } from "../lib/types";
import { AppMenu } from "./AppMenu";
import { ProblemView } from "./ProblemView";
import { toggleMenu } from "./ContextMenu";
import { Logo, Tile } from "./Logo";
import { SetupCard } from "./SetupCard";
import { StartedBy } from "./StartedBy";
import { UpdateButton } from "./UpdateButton";
import { Button, cx, Modal, spring } from "./ui";

// Every project is 1080p at 30 fps.
const FORMAT = { width: 1920, height: 1080, fps: 30 };
/** A YouTube Short's frame: 9:16. */
const SHORTS_FORMAT = { width: 1080, height: 1920, fps: 30 };

export function Home() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [cloud, setCloud] = useState<CloudList | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ProjectStatus>>({});
  const [creating, setCreating] = useState(false);
  // Script mode's scripts: one list with the edits (the user, Oct 30: "merge the two applications as much as possible").
  const [scripts, setScripts] = useState<WriterScriptRow[]>([]);
  // Scripts being written from videos, as Script mode's imports say.
  const [writing, setWriting] = useState<Writing[]>([]);
  useEffect(() => {
    const look = () =>
      void fetch("/api/writer/progress")
        .then((answer) => (answer.ok ? answer.json() : []))
        .then((rows: unknown) => setWriting(Array.isArray(rows) ? (rows as Writing[]) : []), () => {});
    look();
    const timer = setInterval(() => !document.hidden && look(), 4_000);
    return () => clearInterval(timer);
  }, []);
  const account = useAccount((state) => state.account);
  // Someone who writes scripts and makes no videos: Script mode is their home.
  useEffect(() => {
    if (!makesVideos(account) && writesScripts(account)) navigate("/scripts", true);
  }, [account]);
  const [query, setQuery] = useState("");
  // One stage at a time (or the subtitled videos), remembered on this browser.
  const [view, setView] = useState<View>(() => {
    const saved = localStorage.getItem(VIEW);
    return saved === "subtitled" || STAGES.some((stage) => stage.value === saved) ? (saved as View) : "editing";
  });
  const [style, setStyle] = useState<Style | null>(null);

  // Imports, agents and shares under way are followed every few seconds (many projects at once).
  const busy = Object.values(statuses).some((one) => one.importing !== null || one.working || one.sharing !== null);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void api.projectStatus().then(setStatuses).catch(() => {}), 3_000);
    return () => clearInterval(timer);
  }, [busy]);

  const refresh = () => {
    // The cloud’s list is fetched beside this machine’s, never in its way.
    void cloudApi
      .projects()
      .then(setCloud)
      .catch(() => setCloud(null));
    if (writesScripts(useAccount.getState().account)) {
      void api
        .writerScripts()
        .then(({ scripts }) => setScripts(scripts))
        .catch(() => {});
    }
    // Feedback waiting, and finished edits not exported as they are now.
    void api
      .projectStatus()
      .then(setStatuses)
      .catch(() => {});
    return api
      .projects()
      .then(({ projects }) => setProjects(projects))
      .catch((error) => useEditor.getState().toastError(error, "reach Edit"));
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
  const listedIds = new Set([...(projects ?? []).map((project) => project.id), ...cloudOnly.map((project) => project.id)]);
  // A script's edit: the one made from it here, else (made on another Mac, or from its Doc) the project of the same name.
  const named = new Map([...(projects ?? []).map((project) => [project.name, project.id] as const), ...cloudOnly.map((project) => [project.name, project.id] as const)].map(([name, id]) => [name.trim().toLowerCase(), id]));
  const editOf = (one: WriterScriptRow) => (one.project !== null && listedIds.has(one.project) ? one.project : (named.get(one.title.trim().toLowerCase()) ?? null));
  const scriptOf = new Map(scripts.flatMap((one) => {
    const edit = editOf(one);
    return edit !== null ? [[edit, one] as const] : [];
  }));
  const scriptOnly = scripts.filter((one) => editOf(one) === null);
  const count = (projects?.length ?? 0) + cloudOnly.length + scriptOnly.length;

  // What the search and filters keep.
  const words = query.trim().toLowerCase();
  const kept = (name: string, own: Style | undefined) => (words === "" || name.toLowerCase().includes(words)) && (style === null || own === style);
  const all = projects ?? [];
  const edits = all.filter((project) => !project.subtitles && kept(project.name, project.style));
  const subtitled = all.filter((project) => project.subtitles && kept(project.name, project.style));
  const cloudKept = cloudOnly.filter((project) => kept(project.name, project.summary?.style as Style | undefined));
  const cloudSubtitled = cloudKept.filter((project) => project.summary?.subtitles === true);
  const cloudEdits = cloudKept.filter((project) => project.summary?.subtitles !== true);
  const showEdits = view !== "subtitled";
  // Newest change first, local and cloud-only projects and scripts together.
  const projectRows: Listed[] = [
    ...edits.map((project): Listed => ({ at: project.modified_ms, local: project, cloud: null, script: scriptOf.get(project.id) ?? null })),
    ...cloudEdits.map((project): Listed => ({ at: project.updated_ms, local: null, cloud: project, script: scriptOf.get(project.id) ?? null })),
    ...scriptOnly.filter((one) => kept(one.title, one.style ?? undefined)).map((one): Listed => ({ at: one.updatedAt, local: null, cloud: null, script: one })),
  ].sort((a, b) => b.at - a.at);
  const subtitledRows: Listed[] = [
    ...subtitled.map((project): Listed => ({ at: project.modified_ms, local: project, cloud: null, script: null })),
    ...cloudSubtitled.map((project): Listed => ({ at: project.updated_ms, local: null, cloud: project, script: null })),
  ].sort((a, b) => b.at - a.at);
  const stageCount = (stage: Stage) => projectRows.filter((row) => stageOf(row, statuses[row.local?.id ?? row.cloud?.id ?? ""]) === stage).length;
  // A search looks through every stage; otherwise the chosen stage alone.
  const searching = words !== "";
  const rows = !showEdits ? subtitledRows : searching ? projectRows : projectRows.filter((row) => stageOf(row, statuses[row.local?.id ?? row.cloud?.id ?? ""]) === view);
  const cardProps = (project: ProjectSummary) => ({
    project,
    onChanged: refresh,
    cloudOn: Boolean(cloud?.on),
    status: cloud?.statuses?.[project.id],
    remote: remote.get(project.id),
    state: statuses[project.id],
  });
  const choose = (value: View) => {
    localStorage.setItem(VIEW, value);
    setView(value);
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
            <div className="mt-6 flex gap-2">
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus size={15} strokeWidth={2.2} /> New project
              </Button>
            </div>
          </motion.div>
        )}

        {projects && count > 0 && (
          <>
            <div className="mt-8 flex flex-wrap items-center gap-2">
              {/* The kit's segmented control (.sp-seg). */}
              <div className="flex h-[34px] gap-0.5 rounded-[9px] border border-line bg-panel p-0.5">
                {(
                  [
                    // Where each project is, script to finished video (the user, Oct 30: "a natural progression of our projects").
                    ...STAGES.map((stage) => [stage.value, stage.label, stageCount(stage.value)] as [View, string, number]).filter(([value, , total]) => total > 0 || value === view || value === "editing"),
                    ["subtitled", "Subtitled", subtitledRows.length] as [View, string, number],
                  ] as [View, string, number][]
                ).map(([value, label, total]) => (
                  <button
                    key={value}
                    onClick={() => choose(value)}
                    className={cx(
                      "flex items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors",
                      view === value && !searching ? "bg-active text-fg" : "text-muted hover:text-fg",
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

            <Imports projects={projects ?? []} statuses={statuses} writing={writing} />
            {rows.length > 0 ? (
              <ProjectTable rows={rows} cardProps={cardProps} onChanged={refresh} subtitled={!showEdits} grouped={showEdits && searching} statuses={statuses} />
            ) : (
              <p className="mt-16 text-center text-muted">{searching ? `Nothing matches “${query.trim()}”.` : "Nothing here."}</p>
            )}
          </>
        )}
      </div>
      <NewProject open={creating} onClose={() => setCreating(false)} only={style} />
    </div>
  );
}

/** What Home lists: one stage of the projects, or the subtitled videos. */
type View = Stage | "subtitled";

/** A row of Home's table: a project on this Mac, one only in the cloud, or a script with no edit yet; `script`: the script it's made from. */
type Listed =
  | { at: number; local: ProjectSummary; cloud: null; script: WriterScriptRow | null }
  | { at: number; local: null; cloud: CloudProject; script: WriterScriptRow | null }
  | { at: number; local: null; cloud: null; script: WriterScriptRow };

/**
 * Where a project is on its way, script to finished video: Home lists them by
 * it (the user, Oct 30: "ready for scripting, these projects are ready for
 * editing, these projects are done editing … a natural progression of our
 * projects here instead of dumping the whole list").
 */
type Stage = "scripting" | "ready" | "importing" | "editing" | "review" | "done";

const STAGES: { value: Stage; label: string }[] = [
  { value: "scripting", label: "Scripting" },
  { value: "ready", label: "Ready to edit" },
  { value: "importing", label: "Importing" },
  { value: "editing", label: "Editing" },
  { value: "review", label: "In review" },
  { value: "done", label: "Done" },
];

function stageOf(row: Listed, state: ProjectStatus | undefined): Stage {
  if (row.local === null && row.cloud === null) return row.script.built ? "ready" : "scripting";
  if (state === undefined) return "editing";
  if (state.importing !== null) return "importing";
  if (state.approved !== null) return "done";
  if (state.feedback > 0 || (state.complete && state.exported)) return "review";
  return "editing";
}

/** Which list Home shows (remembered on this browser). */
const VIEW = "edit.home.view";

/** Each kind of video’s colour (its dot on cards and filters). */
const STYLE_COLOURS: Record<Style, string> = { bodycam: "#7aa2ff", interrogation: "#ff5f6d", courtroom: "#c4a7ff", commentary: "#e5be72", shorts: "#5fd38d" };

/** What each kind of video makes: the New project pills' tooltips. */
const STYLE_NOTES: Record<Style, string> = {
  bodycam: "16:9 · a narrated bodycam case or compilation, in the house voice",
  interrogation: "16:9 · an interrogation edit, narrated by your recording",
  courtroom: "16:9 · a courtroom edit, narrated by your recording",
  commentary: "16:9 · a narrated video essay with researched B-roll",
  shorts: "9:16 · a video’s highlights in 45–60 s, reframed on the subject, our subtitles, music",
};

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
      useEditor.getState().toastError(error, "rename it");
    }
  };
  const remove = async () => {
    setDeleting(false);
    try {
      await api.deleteProject(project.id);
    } catch (error) {
      useEditor.getState().toastError(error, `delete “${project.name}”`);
    }
    onChanged();
  };
  const share = async () => {
    try {
      await api.shareProject(project.id, null, false, true);
      toast(`Sharing “${project.name}”: exporting it now`, "info");
      onChanged();
    } catch (error) {
      useEditor.getState().toastError(error, `share “${project.name}”`);
    }
  };
  const open = () => {
    if (renaming) return;
    if (project.problem) useEditor.getState().toastError(project.problem, `open “${project.name}”`);
    else navigate(`/p/${project.id}`);
  };
  const menu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    toggleMenu(
      event.currentTarget,
      [
        { label: "Rename", icon: <Pencil size={14} />, onSelect: () => setRenaming(true) },
        // Shared from here, many projects at once (an export that would wait here goes to the cloud).
        ...(project.problem ? [] : [{ label: "Share for review", icon: <Share2 size={14} />, onSelect: () => void share() }]),
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
    : // The cloud refused it: the team can't open or fix it until it's up (Oct 29).
      status?.sync === "error"
      ? { tone: "bad", text: "Not in the cloud", title: `Edit keeps trying to save it to the cloud: ${status.message ?? "it was refused"}` }
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
        .catch((error) => useEditor.getState().toastError(error, "restore it"));
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
      {state.importing !== null && (
        <span
          title={state.importing.error ?? `Importing: ${state.importing.state}`}
          className={cx("flex h-[22px] shrink-0 items-center gap-1 rounded-full bg-raised px-2 text-[12px] font-medium tabular", importStuck(state.importing) ? "text-warning" : "text-info")}
        >
          {importStuck(state.importing) ? <TriangleAlert size={12} /> : <LoaderCircle size={12} className="animate-spin" />}
          {importStuck(state.importing) ? "Import needs you" : `Importing ${importShare(state.importing)}`}
        </span>
      )}
      {state.working && (
        <span title="Its agent is working on it" className="flex h-[22px] shrink-0 items-center gap-1.5 rounded-full bg-raised px-2 text-[12px] font-medium text-agent">
          <span className="size-1.5 animate-pulse rounded-full bg-agent" />
          Agent working
        </span>
      )}
      {state.sharing !== null && (
        <span title={`Sharing: ${state.sharing}`} className="flex h-[22px] shrink-0 items-center gap-1 rounded-full bg-raised px-2 text-[12px] font-medium text-info">
          <Share2 size={12} />
          Sharing
        </span>
      )}
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

/** An import waiting on the person (a file it couldn't get) or failed. */
const importStuck = (importing: NonNullable<ProjectStatus["importing"]>) => importing.state === "waiting" || importing.state === "failed";

/** How far an import is: its bytes while it downloads, then the step it's on. */
function importShare(importing: NonNullable<ProjectStatus["importing"]>) {
  if (importing.state === "downloading") return importing.share !== null ? `${Math.round(importing.share * 100)}%` : `${importing.ready}/${importing.files}`;
  return { transcribing: "· hearing", placing: "· laying out", voicing: "· voicing" }[importing.state] ?? "";
}

/**
 * Every import under way, at the top of Home: the projects started together
 * come in side by side, each with how far it is (the user, Oct 30: "five
 * projects all importing at the same time and once they're all done we check
 * them out").
 */
/** A script being written from its videos (Script mode's import): what it's on and how far. */
type Writing = { id: string; title: string; stage: string; percent: number; detail: string };

function Imports({ projects, statuses, writing }: { projects: ProjectSummary[]; statuses: Record<string, ProjectStatus>; writing: Writing[] }) {
  const running = projects.flatMap((project) => {
    const importing = statuses[project.id]?.importing;
    return importing ? [{ project, importing }] : [];
  });
  if (running.length === 0 && writing.length === 0) return null;
  const total = running.length + writing.length;
  return (
    <div className="mt-6 overflow-hidden rounded-xl border border-line">
      <div className="flex h-10 items-center bg-panel px-4 text-[12px] font-medium text-muted">
        Importing {total} {total === 1 ? "project" : "projects"}
      </div>
      {writing.map((one) => (
        <button
          key={one.id}
          onClick={() => navigate(`/scripts/${one.id}`)}
          title={one.detail || undefined}
          className="grid w-full grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-4 border-t border-line px-4 py-2.5 text-left transition-colors hover:bg-panel"
        >
          <span className="flex min-w-0 items-center gap-2 truncate text-[13px] text-fg">
            <FileText size={13} className="shrink-0 text-muted" />
            <span className="truncate">{one.title || "New script"}</span>
          </span>
          <span className="h-1 overflow-hidden rounded-full bg-raised">
            <span className="block h-full rounded-full bg-info transition-[width] duration-500" style={{ width: `${Math.round(Math.max(0, Math.min(1, one.percent / 100)) * 100)}%` }} />
          </span>
          <span className="max-w-[220px] truncate text-[12px] text-muted">{one.stage}</span>
        </button>
      ))}
      {running.map(({ project, importing }) => {
        const stuck = importStuck(importing);
        const share = importing.state === "downloading" ? (importing.share ?? importing.ready / Math.max(importing.files, 1)) : 1;
        return (
          <button
            key={project.id}
            onClick={() => navigate(`/p/${project.id}`)}
            title={importing.error ?? undefined}
            className="grid w-full grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-4 border-t border-line px-4 py-2.5 text-left transition-colors hover:bg-panel"
          >
            <span className="truncate text-[13px] text-fg">{project.name}</span>
            <span className="h-1 overflow-hidden rounded-full bg-raised">
              <span className={cx("block h-full rounded-full transition-[width] duration-500", stuck ? "bg-warning" : "bg-info")} style={{ width: `${Math.round(share * 100)}%` }} />
            </span>
            <span className={cx("text-[12px] tabular", stuck ? "text-warning" : "text-muted")}>
              {stuck
                ? importing.state === "failed" ? "Failed: open it" : "Needs you: open it"
                : importing.state === "downloading"
                  ? `${importing.ready} of ${importing.files} files`
                  : { transcribing: "Hearing the footage", placing: "Laying it out", voicing: "Voicing the cut-ins" }[importing.state] ?? importing.state}
            </span>
          </button>
        );
      })}
    </div>
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
  grouped,
  statuses,
}: {
  rows: Listed[];
  cardProps: (project: ProjectSummary) => CardProps;
  onChanged: () => void;
  subtitled: boolean;
  /** A search across stages: each stage's matches under its name. */
  grouped: boolean;
  statuses: Record<string, ProjectStatus>;
}) {
  const idOf = (row: Listed) => row.local?.id ?? row.cloud?.id ?? `script-${row.script!.id}`;
  const rowOf = (row: Listed) =>
    row.local !== null ? (
      <TableRow {...cardProps(row.local)} subtitled={subtitled} script={row.script} />
    ) : row.cloud !== null ? (
      <CloudTableRow project={row.cloud} onChanged={onChanged} />
    ) : (
      <ScriptTableRow script={row.script} onChanged={onChanged} />
    );
  // One stage (or the subtitled videos): newest first, by when they changed.
  const groups = !grouped
    ? null
    : STAGES.map((stage) => ({ ...stage, rows: rows.filter((row) => stageOf(row, statuses[row.local?.id ?? row.cloud?.id ?? ""]) === stage.value) })).filter((group) => group.rows.length > 0);
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
      {groups === null
        ? rows.map((row, index) => {
            const label = changedLabel(row.at);
            const heading = label !== "Today" && (index === 0 || changedLabel(rows[index - 1]!.at) !== label);
            return (
              <Fragment key={idOf(row)}>
                {heading && <div className="border-t border-line px-4 pt-3.5 pb-1.5 text-[11.5px] font-medium text-faint">{label}</div>}
                {rowOf(row)}
              </Fragment>
            );
          })
        : groups.map((group) => (
            <Fragment key={group.value}>
              <div className="flex items-center gap-2 border-t border-line px-4 pt-3.5 pb-1.5 text-[11.5px] font-medium text-faint">
                {group.label} <span className="tabular">{group.rows.length}</span>
              </div>
              {group.rows.map((row) => (
                <Fragment key={idOf(row)}>{rowOf(row)}</Fragment>
              ))}
            </Fragment>
          ))}
    </div>
  );
}

/** A project on this Mac: its name, what's worth a word about it, and its ⋯. */
function TableRow({ subtitled, script = null, ...props }: CardProps & { subtitled: boolean; script?: WriterScriptRow | null }) {
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
          {script !== null && <ScriptLink id={script.id} />}
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
          {card.mostlyRemote && <NotHere title="Its footage streams from the cloud" />}
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

/** The project's script, a click away: its other mode. */
function ScriptLink({ id }: { id: string }) {
  return (
    <button
      title="Open its script"
      onClick={(event) => {
        event.stopPropagation();
        navigate(`/scripts/${id}`);
      }}
      className="flex h-[22px] shrink-0 items-center gap-1 rounded-full bg-raised px-2 text-[12px] font-medium text-secondary hover:bg-hover hover:text-fg"
    >
      <FileText size={12} />
      Script
    </button>
  );
}

/** A script with no edit yet: opening it opens the script; once written, Start the edit makes its video project. */
function ScriptTableRow({ script, onChanged }: { script: WriterScriptRow; onChanged: () => void }) {
  const [starting, setStarting] = useState(false);
  const start = async (event: React.MouseEvent) => {
    event.stopPropagation();
    setStarting(true);
    try {
      const { project } = await api.importWriter(script.id);
      useEditor.getState().setMediaTab("downloads");
      onChanged();
      navigate(`/p/${project}`);
    } catch (error) {
      useEditor.getState().toastError(error, `start the edit of “${script.title}”`);
    } finally {
      setStarting(false);
    }
  };
  return (
    <div role="row" onClick={() => navigate(`/scripts/${script.id}`)} className={cx(COLUMNS, "group min-h-14 cursor-pointer border-t border-line px-4 py-2.5 transition-colors hover:bg-panel")}>
      <div role="cell" className="flex min-w-0 items-center gap-2.5">
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: STYLE_COLOURS[script.style ?? "bodycam"] ?? STYLE_COLOURS.bodycam }} />
        <span className="truncate text-[14px] text-fg group-hover:underline group-hover:underline-offset-[3px]" title={script.title}>
          {script.title || "Untitled script"}
        </span>
      </div>
      <div role="cell" className="flex min-w-0 flex-wrap items-center gap-1">
        <span className="flex h-[22px] shrink-0 items-center gap-1 rounded-full bg-raised px-2 text-[12px] font-medium text-secondary">
          <FileText size={12} />
          Script
        </span>
        {script.built && (
          <button onClick={(event) => void start(event)} disabled={starting} className="flex h-[22px] shrink-0 items-center rounded-full px-2 text-[12px] font-medium text-info hover:bg-hover disabled:opacity-60">
            {starting ? "Starting…" : "Start the edit"}
          </button>
        )}
      </div>
      <span role="cell" className="text-right text-[13px] text-secondary tabular">
        {script.durationMs > 0 ? shortDuration(script.durationMs / 1000) : ""}
      </span>
      <span role="cell" className="text-right text-[13px] text-secondary" title={script.updatedBy ? `by ${script.updatedBy}` : undefined}>
        {ago(script.updatedAt)}
      </span>
      <span />
    </div>
  );
}

/** A project only in the cloud: opening it downloads it to this Mac. */
function CloudTableRow({ project, onChanged }: { project: CloudProject; onChanged: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const summary = project.summary ?? {};
  const style = (summary.style as Style | undefined) ?? "bodycam";
  const seconds = summary.durationFrames && summary.fps ? summary.durationFrames / summary.fps : null;
  const remove = async () => {
    setDeleting(false);
    try {
      await api.deleteProject(project.id);
    } catch (error) {
      useEditor.getState().toastError(error, `delete “${project.name}”`);
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
      useEditor.getState().toastError(error, "move it to the cloud");
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

/** What a paste is: a script's Doc (an edit), videos (a script to write), or a name. */
const DOC = /docs\.google\.com\/document\//i;
const VIDEO = /(youtube\.com\/(watch|shorts|live)|youtu\.be\/|drive\.google\.com\/(file|drive\/folders|open))/i;
const LINK = /^https?:\/\//i;

/** Script mode's kinds for Edit's styles (bodycam is a FOIA script there); shorts and commentary have none. */
const WRITER_KIND: Partial<Record<Style, "foia" | "interrogation" | "courtroom">> = { bodycam: "foia", interrogation: "interrogation", courtroom: "courtroom" };

/**
 * New project, in one box: paste what you have (a script's Doc, videos, a
 * Trello card) or type a name, pick the kind of video, and go. A Doc starts
 * the edit; videos start a script that becomes the edit (the user, Oct 30:
 * "too many options in the dialog box … make it a lot cleaner and a lot
 * easier to use"). `only`: the kind Home is filtered to.
 */
function NewProject({ open, onClose, only = null }: { open: boolean; onClose: () => void; only?: Style | null }) {
  const account = useAccount((state) => state.account);
  const allowed = editStyles(account);
  const writes = writesScripts(account);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"edit" | "write">("edit");
  const [chosen, setChosen] = useState(false);
  const [style, setStyle] = useState<Style>("bodycam");
  const [picked, setPicked] = useState(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const voicePicker = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ url: string; result?: Preview; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useEditor((state) => state.toast);

  const input = text.trim();
  const lines = input.split(/\s*\n\s*/).filter((line) => line !== "");
  const links = lines.flatMap((line) => line.split(/\s+/)).filter((word) => LINK.test(word));
  const videos = links.filter((link) => VIDEO.test(link));
  const hasDoc = links.some((link) => DOC.test(link));
  const caseLinks = hasImportLinks(input);
  // Videos alone are a script to write; a Doc (or a Trello card, a review link) is an edit.
  const guessed: "edit" | "write" = writes && videos.length > 0 && !hasDoc && videos.length === links.length ? "write" : "edit";
  const shown = chosen ? mode : guessed;
  const styles = STYLES.filter((option) => (shown === "write" ? option.value === "commentary" || WRITER_KIND[option.value] !== undefined : allowed === null || allowed.has(option.value)));
  const kind = styles.some((option) => option.value === style) ? style : (styles[0]?.value ?? "bodycam");
  const commentary = kind === "commentary";
  const needsTitle = shown === "write" && (commentary || videos.length > 1);
  const recording = shown === "edit" && hasDoc && NARRATION[kind] === "recording";

  // A fresh dialog each time.
  useEffect(() => {
    if (!open) return;
    setText("");
    setTitle("");
    setPrompt("");
    setVoiceFile(null);
    setPreview(null);
    setError(null);
    setChosen(false);
    setPicked(false);
    if (only !== null) setStyle(only);
  }, [open]);

  // A script Doc is read as soon as it's pasted: its title names the project and its heading the kind.
  useEffect(() => {
    if (shown !== "edit" || !caseLinks) {
      setPreview(null);
      return;
    }
    let alive = true;
    setPreview({ url: input });
    const timer = setTimeout(() => {
      api
        .scriptPreview(input)
        .then((result) => alive && setPreview({ url: input, result }))
        .catch((cause) => alive && setPreview({ url: input, error: (cause as Error).message }));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [input, caseLinks, shown]);
  const named = preview?.result?.style;
  useEffect(() => {
    if (named && !picked && (allowed === null || allowed.has(named))) setStyle(named);
  }, [named, picked]);

  const ready = input !== "" && !(needsTitle && title.trim() === "") && !(shown === "edit" && caseLinks && !preview?.result);
  const what =
    shown === "write"
      ? commentary
        ? `A commentary from ${links.length} ${links.length === 1 ? "source" : "sources"}`
        : videos.length > 1
          ? `A compilation of ${videos.length} videos`
          : videos.length === 1
            ? "A script from this video"
            : ""
      : caseLinks
        ? preview?.error
          ? null
          : preview?.result
            ? `${preview.result.title || "Untitled script"} · ${preview.result.files} ${preview.result.files === 1 ? "source" : "sources"} · ${preview.result.narration} cut-ins${preview.result.whole ? "" : ` · ${shortDuration(preview.result.seconds)}`}`
            : "Reading the links…"
        : input !== ""
          ? "An empty project"
          : "";

  const create = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (shown === "write") {
        // The import runs on: Home shows it until the script is ready to open.
        const writer = await import("../writer/api");
        const started = commentary
          ? writer.createCommentary(title.trim(), links)
          : videos.length > 1
            ? writer.importCompilation(title.trim(), videos, false, WRITER_KIND[kind])
            : DRIVE.test(videos[0]!)
              ? writer.importDrive(videos[0]!, undefined, undefined, WRITER_KIND[kind])
              : writer.importYoutube(videos[0]!, undefined, undefined, WRITER_KIND[kind]);
        if (commentary) {
          const script = await started;
          onClose();
          navigate(`/scripts/${script.id}`);
          return;
        }
        started.catch((cause) => useEditor.getState().toastError(cause, "write the script"));
        onClose();
        toast("Writing the script: its footage is coming in", "info");
        return;
      }
      if (caseLinks && allowed !== null && !allowed.has(kind)) {
        setError("Your account can’t make full edits: an admin can give you an Edit style at accounts.spheceo.com.");
        return;
      }
      const name = caseLinks ? preview?.result?.title || "Untitled" : input;
      const { project } = await api.createProject({ name, style: kind, ...(kind === "shorts" ? SHORTS_FORMAT : FORMAT) });
      if (caseLinks) {
        // The recording first, so the import places it instead of voicing the cut-ins.
        if (recording && voiceFile !== null) {
          try {
            await api.uploadFile(project.id, voiceFile, `voiceover-${clientId}`);
          } catch (cause) {
            useEditor.getState().toastError(cause, "add the voice-over");
          }
        }
        await api.attachScript(project.id, input);
        useEditor.getState().setMediaTab("downloads");
      }
      if (prompt.trim() !== "") await api.firstPrompt(project.id, prompt.trim());
      onClose();
      // With a first message the import runs in the background: start the next one.
      if (caseLinks && prompt.trim() !== "") {
        toast(`Importing “${name}”: your message goes to its agent when it’s in`, "info");
        return;
      }
      navigate(`/p/${project.id}`);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = "h-9 w-full rounded-lg border border-line bg-black px-3 text-[13px] outline-none placeholder:text-faint focus:border-muted";
  return (
    <Modal open={open} onClose={onClose} width={560}>
      <form
        className="flex flex-col gap-4 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <h2 className="text-[17px] font-semibold tracking-[-0.2px]">New project</h2>
        <div>
          <textarea
            autoFocus
            rows={3}
            value={text}
            placeholder="Paste a script Doc, videos or a Trello card, or type a name"
            onChange={(event) => setText(event.target.value)}
            onPaste={(event) => {
              const plain = event.clipboardData.getData("text/plain");
              const pasted = importPaste(event.clipboardData.getData("text/html"), plain);
              if (pasted === plain) return;
              event.preventDefault();
              const node = event.currentTarget;
              setText(text.slice(0, node.selectionStart) + pasted + text.slice(node.selectionEnd));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void create();
            }}
            className="w-full resize-none rounded-lg border border-line bg-black px-3 py-2.5 text-[14px] outline-none placeholder:text-faint focus:border-muted"
          />
          <div className="mt-1.5 min-h-[18px] truncate text-[12px] text-muted">
            {preview?.error ? <ProblemView error={preview.error} doing="read the links" className="whitespace-normal" /> : what === "Reading the links…" ? <span className="shimmer">{what}</span> : what}
          </div>
        </div>

        {writes && input !== "" && (
          <div className="flex h-[30px] w-fit gap-0.5 rounded-lg border border-line bg-black p-0.5">
            {(
              [
                ["write", "Write a script"],
                ["edit", "Edit the video"],
              ] as const
            ).map(([value, label]) => (
              <button
                type="button"
                key={value}
                onClick={() => {
                  setMode(value);
                  setChosen(true);
                }}
                className={cx("rounded-md px-3 text-[12px] font-medium transition-colors", shown === value ? "bg-active text-fg" : "text-muted hover:text-fg")}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-1.5">
          {styles.map((option) => (
            <button
              type="button"
              key={option.value}
              title={STYLE_NOTES[option.value]}
              onClick={() => {
                setStyle(option.value);
                setPicked(true);
              }}
              className={cx(
                "flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition-colors",
                kind === option.value ? "border-line-strong bg-raised text-fg" : "border-line text-muted hover:text-fg",
              )}
            >
              <span className="size-1.5 rounded-full" style={{ background: STYLE_COLOURS[option.value] }} />
              {option.label}
            </button>
          ))}
        </div>

        {needsTitle && <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" className={field} />}
        {shown === "edit" && caseLinks && (
          <input value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="First message to its agent (optional), sent when the import is done" className={field} />
        )}
        {recording && (
          <button type="button" onClick={() => voicePicker.current?.click()} className="w-fit text-[12px] text-muted hover:text-fg">
            {voiceFile ? `Voice-over: ${voiceFile.name}` : "+ Add the voice-over recording (optional: a stand-in voice until then)"}
            <input
              ref={voicePicker}
              type="file"
              accept="audio/*,.mp3,.wav,.m4a,.aac"
              className="hidden"
              onChange={(event) => {
                setVoiceFile(event.currentTarget.files?.[0] ?? null);
                event.currentTarget.value = "";
              }}
            />
          </button>
        )}

        {error && <p className="text-[12px] text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !ready}>
            {busy ? "Starting…" : shown === "write" ? "Write the script" : caseLinks ? "Start the edit" : "Create"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const DRIVE = /drive\.google\.com/i;
