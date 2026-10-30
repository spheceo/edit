import { Archive, Check, CloudAlert, CloudCheck, CloudDownload, CloudOff, CloudUpload, Copy, Ellipsis, ExternalLink, FileText, FileVideo, LoaderCircle, Lock, MessageSquare, Pencil, Plus, Replace, RotateCw, Search, Share2, SkipForward, Trash2, TriangleAlert, X } from "lucide-react";
import { motion } from "motion/react";
import { Fragment, useEffect, useRef, useState } from "react";

import { editStyles, useAccount, writesScripts } from "../lib/account";
import { api, type ProjectStatus, type WriterScriptRow } from "../lib/api";
import { hasImportLinks, importPaste } from "../lib/import-input";
import { cloudApi, type CloudList, type CloudProject, type CloudStatus } from "../lib/cloud";
import { copyDriveLink, openDrive, useDriveLink } from "../lib/drive";
import { navigate } from "../lib/route";
import { clientId, connectEvents, useEditor } from "../lib/store";
import { ago, shortDuration } from "../lib/time";
import { STYLES, type Creator, type ProjectSummary, type Style } from "../lib/types";
import { AppMenu } from "./AppMenu";
import { elapsed, STEPS, stepOf } from "../writer/import-steps";
import { prefetchScript } from "../writer/opened";
import { useKept } from "../lib/kept";
import { ProblemView } from "./ProblemView";
import { toggleMenu, type MenuItem } from "./ContextMenu";
import { Logo, Tile } from "./Logo";
import { SetupCard } from "./SetupCard";
import { StartedBy } from "./StartedBy";
import { UpdateButton } from "./UpdateButton";
import { Button, cx, IconButton, Modal, spring } from "./ui";

// Every project is 1080p at 30 fps.
const FORMAT = { width: 1920, height: 1080, fps: 30 };
/** A YouTube Short's frame: 9:16. */
const SHORTS_FORMAT = { width: 1080, height: 1920, fps: 30 };

export function Home() {
  // What Home showed last, at once; the fresh answers take its place as they come.
  const [projects, setProjects] = useKept<ProjectSummary[] | null>("home.projects", null);
  const [cloud, setCloud] = useKept<CloudList | null>("home.cloud", null);
  const [statuses, setStatuses] = useKept<Record<string, ProjectStatus>>("home.statuses", {});
  const [creating, setCreating] = useState(false);
  // Script mode's scripts: one list with the edits (the user, Oct 30: "merge the two applications as much as possible").
  const [scripts, setScripts] = useKept<WriterScriptRow[]>("home.scripts", []);
  // Scripts being written from videos, as Script mode's imports say.
  const [writing, setWriting] = useKept<Writing[]>("home.writing", []);
  useEffect(() => {
    const look = () =>
      void fetch("/api/writer/progress")
        .then((answer) => (answer.ok ? answer.json() : []))
        .then((rows: unknown) => setWriting(Array.isArray(rows) ? (rows as Writing[]) : []), () => {});
    // Script imports stopped on any Mac (a failed video, a cut connection): open issues, answered here.
    const stopped = () =>
      void fetch("/api/writer/scripts")
        .then((answer) => (answer.ok ? answer.json() : []))
        .then((rows: unknown) => setLocalScripts(Array.isArray(rows) ? (rows as ScriptIssueRow[]) : []), () => {});
    look();
    stopped();
    const timer = setInterval(() => {
      if (document.hidden) return;
      look();
      stopped();
    }, 4_000);
    return () => clearInterval(timer);
  }, []);
  // Script mode's scripts as this Mac has them: what stopped (any Mac's), and who started each.
  const [localScripts, setLocalScripts] = useKept<ScriptIssueRow[]>("home.localScripts", []);
  // A script import opened over Home (from the strip or its row).
  const [watching, setWatching] = useState<string | null>(null);
  const issues = localScripts.filter((row) => (row.status === "needs_choice" || row.status === "error") && !row.dismissedAt);
  const [query, setQuery] = useState("");
  // One stage at a time (or the subtitled videos), remembered on this browser.
  const [view, setView] = useState<View>(() => {
    const saved = localStorage.getItem(VIEW);
    return saved === "all" || saved === "subtitled" ? saved : "needs";
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
    // Not reached this time: the last list stays (its error says so).
    void cloudApi
      .projects()
      .then(setCloud)
      .catch((error: unknown) => setCloud((last) => (last === null ? null : { ...last, error: (error as Error).message, offline: true })));
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
  // A script still importing (running, stopped or waiting on a choice) isn't
  // a script yet: it's in Importing, with how far it got (the user, Oct 30:
  // "until the first prompt is kicked off the project isn't a Script project
  // it's still in the importing phase").
  const importingNow = new Map<string, Importing>();
  for (const one of localScripts) {
    if (one.status === "processing") importingNow.set(one.id, { word: `Importing ${Math.round(one.progress ?? 0)}%`, stopped: false });
    else if (one.status === "error" || one.status === "needs_choice") importingNow.set(one.id, { word: one.status === "needs_choice" ? "Waiting on a choice" : "Stopped", stopped: true });
    // In, but its first prompt not started yet: still importing until the workflow is under way.
    else if (one.firstBuild) importingNow.set(one.id, { word: "Starting the workflow", stopped: false });
  }
  for (const one of writing) importingNow.set(one.id, { word: `Importing ${Math.round(one.percent)}%`, stopped: false });
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
    ...scriptOnly.filter((one) => kept(one.title, one.style ?? undefined)).map((one): Listed => ({ at: one.updatedAt, local: null, cloud: null, script: one, importing: importingNow.get(one.id) })),
  ].sort((a, b) => b.at - a.at);
  const subtitledRows: Listed[] = [
    ...subtitled.map((project): Listed => ({ at: project.modified_ms, local: project, cloud: null, script: null })),
    ...cloudSubtitled.map((project): Listed => ({ at: project.updated_ms, local: null, cloud: project, script: null })),
  ].sort((a, b) => b.at - a.at);
  // What needs someone: edits on a review link not approved yet, and edits
  // whose import stopped; scripts whose import stopped are the box above the
  // list, with their answers. Ordinary scripts and the edits being worked on
  // wait in All projects (the user, Oct 30: "we shouldn't show just normal
  // scripts in the main view").
  const needsYou = projectRows.filter((row) => {
    if (row.local === null && row.cloud === null) return false;
    const state = statuses[row.local?.id ?? row.cloud?.id ?? ""];
    return stageOf(row, state) === "review" || Boolean(state?.importing?.error);
  });
  const stoppedScripts = issues.filter((issue) => !writing.some((one) => one.id === issue.id)).length;
  // A search looks through every project; otherwise the tab's.
  const searching = words !== "";
  const rows = !showEdits ? subtitledRows : searching || view === "all" ? projectRows : needsYou;
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
                    // What needs someone first; the rest a tab away (the user, Oct 30: "you mainly see projects that need you").
                    ["needs", "Needs you", needsYou.length + stoppedScripts] as [View, string, number],
                    ["all", "All projects", projectRows.length] as [View, string, number],
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
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <Imports projects={projects ?? []} statuses={statuses} writing={writing} issues={issues} scripts={localScripts} onOpen={setWatching} />
            <ImportDialog id={watching} writing={writing} issues={issues} onClose={() => setWatching(null)} />
            {rows.length > 0 ? (
              // Edits grouped by stage, script to finished video.
              <ProjectTable rows={rows} cardProps={cardProps} onChanged={refresh} subtitled={!showEdits} grouped={showEdits} statuses={statuses} onImport={setWatching} />
            ) : searching ? (
              <p className="mt-16 text-center text-muted">Nothing matches “{query.trim()}”.</p>
            ) : view === "needs" && stoppedScripts === 0 ? (
              <div className="mt-6 rounded-xl border border-line px-4 py-10 text-center">
                <div className="text-[14px] font-medium">Nothing needs you</div>
                <p className="mt-1 text-[12px] text-muted">Stopped imports and edits waiting on review show up here.</p>
              </div>
            ) : view === "needs" ? null : (
              <p className="mt-16 text-center text-muted">Nothing here.</p>
            )}
          </>
        )}
      </div>
      <NewProject open={creating} onClose={() => setCreating(false)} only={style} />
    </div>
  );
}

/** What Home lists: what needs someone, every project, or the subtitled videos. */
type View = "needs" | "all" | "subtitled";

/** A row of Home's table: a project on this Mac, one only in the cloud, or a script with no edit yet; `script`: the script it's made from. */
type Listed =
  | { at: number; local: ProjectSummary; cloud: null; script: WriterScriptRow | null }
  | { at: number; local: null; cloud: CloudProject; script: WriterScriptRow | null }
  | { at: number; local: null; cloud: null; script: WriterScriptRow; importing?: Importing };

/** A script's import while it isn't done: its word for it ("Importing 40%", "Stopped"). */
type Importing = { word: string; stopped: boolean };

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
  if (row.local === null && row.cloud === null) return row.importing ? "importing" : row.script.built ? "ready" : "scripting";
  if (state === undefined) return "editing";
  if (state.importing !== null) return "importing";
  if (state.approved !== null) return "done";
  if (state.feedback > 0 || (state.complete && state.exported)) return "review";
  return "editing";
}

/** Which list Home shows (remembered on this browser). */
const VIEW = "edit.home.view";

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

/** A script import that stopped: what it asks (a decision) or why it failed. */
type ScriptIssueRow = {
  id: string;
  title: string;
  status: string;
  /** Where it got to: downloading, transcribing, … */
  stage: string;
  /** How far it got (0–100). */
  progress?: number;
  error: string | null;
  createdBy?: Creator;
  decision?: { kind: string; summary: string; failed?: { id: string; title: string; error: string }[] };
  /** Dismissed from "need you" (still stopped). */
  dismissedAt?: number;
  /** Its first prompt still to start. */
  firstBuild?: boolean;
};

/** Answers a stopped import; it carries on in the background and Home follows it. */
async function answerIssue(issue: ScriptIssueRow, choice: Record<string, unknown>) {
  const writer = await import("../writer/api");
  void writer.resumeImport(issue.id, choice as Parameters<typeof writer.resumeImport>[1]).catch((cause) => useEditor.getState().toastError(cause, `carry on “${issue.title}”`));
}

/**
 * What can be done about a stopped import, each in a dialog of its own: see
 * the whole error, try again, go on without what failed, give another link
 * for a video, or take it off the list. The user, Oct 30: "if something goes
 * wrong, it's blocked, it's frozen at that state, and then we can come in,
 * fix it, and unblock it"; and the answers in a ⋯ menu, "the exact error ...
 * in a dialog box", Replace a dialog, and Dismiss confirmed.
 */
function useIssueDialogs(issue: ScriptIssueRow) {
  const [open, setOpen] = useState<"error" | "replace" | "dismiss" | null>(null);
  const [url, setUrl] = useState("");
  const failed = issue.decision?.failed ?? [];
  const [which, setWhich] = useState(failed[0]?.id ?? "");
  const [copied, setCopied] = useState(false);
  const close = () => setOpen(null);
  const said = issue.decision?.summary ?? issue.error ?? "It stopped without saying why.";
  const full = [said, ...failed.map((one) => `${one.title}: ${one.error}`)].join("\n\n");
  const retry = () => {
    close();
    void answerIssue(issue, { kind: "retry" });
  };
  const items: MenuItem[] = [
    { label: "View error", icon: <TriangleAlert size={14} />, onSelect: () => setOpen("error") },
    { label: "Retry", icon: <RotateCw size={14} />, onSelect: retry },
    ...(issue.decision?.kind === "failed_recordings" ? [{ label: "Go on without them", icon: <SkipForward size={14} />, onSelect: () => void answerIssue(issue, { kind: "skip_failed" }) }] : []),
    { label: "Replace…", icon: <Replace size={14} />, onSelect: () => setOpen("replace") },
    { separator: true },
    { label: "Dismiss…", icon: <X size={14} />, danger: true, onSelect: () => setOpen("dismiss") },
  ];
  const dialogs = (
    <>
      <Modal open={open === "error"} onClose={close} width={520}>
        <div className="p-6">
          <h2 className="text-[18px] font-semibold tracking-[-0.3px]">Why “{issue.title}” stopped</h2>
          <p className="mt-1 text-[13px] text-muted">Stopped {stageWords(issue.stage)}{issue.progress ? `, ${Math.round(issue.progress)}% in` : ""}. It waits there until it’s answered.</p>
          <pre className="mt-4 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-black p-3 font-mono text-[12px] leading-relaxed text-secondary select-text">{full}</pre>
          <div className="mt-[22px] flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(full).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
            </Button>
            <div className="flex gap-2">
              <Button variant="subtle" onClick={() => setOpen("replace")}>
                Replace…
              </Button>
              <Button variant="primary" onClick={retry}>
                Retry
              </Button>
            </div>
          </div>
        </div>
      </Modal>
      <Modal open={open === "replace"} onClose={close} width={460}>
        <form
          className="p-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (url.trim() === "") return;
            close();
            void answerIssue(issue, { kind: "replace", url: url.trim(), ...(failed.length > 0 ? { id: which } : {}) });
            setUrl("");
          }}
        >
          <h2 className="text-[18px] font-semibold tracking-[-0.3px]">Replace a video</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">Give another link for {failed.length > 0 ? "a video that failed" : "this import’s video"}, such as a Google Drive copy of a YouTube video that won’t download. The import carries on from where it stopped.</p>
          {failed.length > 1 && (
            <select value={which} onChange={(event) => setWhich(event.target.value)} className="mt-4 h-9 w-full rounded-md border border-line bg-black px-2 text-[13px]">
              {failed.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.title}
                </option>
              ))}
            </select>
          )}
          <input autoFocus value={url} onChange={(event) => setUrl(event.target.value)} placeholder="A YouTube or Google Drive link" className="mt-4 h-9 w-full rounded-md border border-line bg-black px-3 text-[13px] outline-none placeholder:text-faint focus:border-muted" />
          <div className="mt-[22px] flex justify-end gap-2">
            <Button type="button" variant="subtle" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={url.trim() === ""}>
              Use this link
            </Button>
          </div>
        </form>
      </Modal>
      <Modal open={open === "dismiss"} onClose={close} width={380}>
        <div className="p-6">
          <h2 className="text-[18px] font-semibold tracking-[-0.3px]">Dismiss “{issue.title}”?</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">It comes off this list for everyone and stays stopped where it is. Its script keeps what was imported, and Retry there still carries it on.</p>
          <div className="mt-[22px] flex justify-end gap-2">
            <Button variant="subtle" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                close();
                void answerIssue(issue, { kind: "dismiss" });
              }}
            >
              Dismiss
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
  return { items, dialogs, said, retry, showError: () => setOpen("error"), replace: () => setOpen("replace") };
}

/**
 * A stopped import's answers at the foot of its import dialog: the one thing
 * to do (Retry), the other way out (another link, or going on without what
 * failed), nothing more; the error is already in the step above, and Dismiss
 * is on Home's list. The user, Oct 30: "too many options ... minimizing the
 * number of options and the amount of thinking that someone has to do".
 */
function IssueActions({ issue }: { issue: ScriptIssueRow }) {
  const { dialogs, retry, replace } = useIssueDialogs(issue);
  return (
    <>
      {issue.decision?.kind === "failed_recordings" ? (
        <Button onClick={() => void answerIssue(issue, { kind: "skip_failed" })}>Go on without them</Button>
      ) : (
        <Button onClick={replace}>Replace…</Button>
      )}
      <Button variant="primary" onClick={retry}>
        Retry
      </Button>
      {dialogs}
    </>
  );
}

/**
 * A stopped import on Home's "need you" list, in the table's columns below it
 * (the name with who started it at its end, then where it stopped and why),
 * so the avatars line up between the two; the error's first words (the whole
 * of it a click away), and the answers in the ⋯ menu at the far right. Its
 * title opens it over Home.
 */
function ScriptIssue({ issue, onOpen }: { issue: ScriptIssueRow; onOpen: (id: string) => void }) {
  const { items, dialogs, said, showError } = useIssueDialogs(issue);
  return (
    <div className={cx(COLUMNS, "min-h-14 border-t border-line px-4 py-2.5 text-[13px]")}>
      <div className="flex min-w-0 items-center gap-2.5">
        <TriangleAlert size={14} className="shrink-0 text-warning" />
        <button onClick={() => onOpen(issue.id)} className="truncate text-left text-[14px] text-fg hover:underline hover:underline-offset-[3px]" title={issue.title}>
          {issue.title}
        </button>
        <StartedBy by={issue.createdBy} size={24} className="ml-auto shrink-0" />
      </div>
      <div className="col-span-3 flex min-w-0 items-center gap-2">
        {/* Where it stopped, so it's plain what's being fixed (the list already says it stopped). */}
        <span title={`Stopped ${stageWords(issue.stage)}`} className="flex h-[22px] shrink-0 items-center rounded-full bg-raised px-2 text-[12px] font-medium text-warning">
          {stageName(issue.stage)}
        </span>
        <button onClick={showError} className="min-w-0 truncate text-left text-[12px] text-muted hover:text-fg" title="View the whole error">
          {said}
        </button>
      </div>
      <IconButton label={`What to do about “${issue.title}”`} onClick={(event) => toggleMenu(event.currentTarget, items, { width: 220 })}>
        <Ellipsis size={16} />
      </IconButton>
      {dialogs}
    </div>
  );
}

/** An import's stage as a chip's word ("Transcribing"). */
function stageName(stage: string): string {
  const names: Record<string, string> = {
    reading: "Reading",
    downloading: "Downloading",
    joining: "Joining",
    transcribing: "Transcribing",
    processing: "Finishing",
    researching: "Researching",
    speakers: "Naming speakers",
    ready: "After import",
  };
  return names[stage] ?? (stage ? stage[0]!.toUpperCase() + stage.slice(1) : "Stopped");
}

/** An import's stage in words ("while downloading"). */
function stageWords(stage: string): string {
  const words: Record<string, string> = {
    reading: "while reading the footage",
    downloading: "while downloading",
    joining: "while joining the videos",
    transcribing: "while transcribing",
    processing: "while finishing",
    researching: "while researching",
    speakers: "while naming the speakers",
    ready: "after the import",
  };
  return words[stage] ?? (stage ? `at ${stage}` : "");
}

/**
 * A script's import, open over Home: each step, how far it is, what it's on
 * and for how long (the user, Oct 30: clicking a project still importing
 * "should pop up on the home page and shouldn't redirect you to the script
 * page"). Once it's in, it says so and opens the script.
 */
function ImportDialog({ id, writing, issues, onClose }: { id: string | null; writing: Writing[]; issues: ScriptIssueRow[]; onClose: () => void }) {
  const live = writing.find((one) => one.id === id) ?? null;
  // Stopped (and not running again): where it got to, why, and what can be done, here on Home.
  const stopped = live === null ? (issues.find((one) => one.id === id) ?? null) : null;
  const last = useRef<Writing | null>(null);
  if (live) last.current = live;
  const shown: Writing | null = live ?? (stopped ? { id: stopped.id, title: stopped.title, stage: stopped.stage, percent: stopped.progress ?? 0, detail: "" } : last.current);
  const [began, setBegan] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());
  const step = shown ? stepOf(shown) : "download";
  useEffect(() => {
    setBegan({});
    last.current = null;
  }, [id]);
  useEffect(() => {
    if (!shown) return;
    setBegan((times) => (times[step] ? times : { ...times, [step]: Date.now(), ...(times.start ? {} : { start: Date.now() }) }));
  }, [shown?.id, step]);
  useEffect(() => {
    if (id === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [id]);
  const done = id !== null && live === null && stopped === null && last.current !== null;
  const why = stopped ? (stopped.decision?.summary ?? stopped.error ?? "Stopped.") : null;
  const at = done ? STEPS.length : STEPS.findIndex((candidate) => candidate.key === step);
  const percent = done ? 100 : Math.round(Math.max(0, Math.min(100, shown?.percent ?? 0)));
  return (
    <Modal open={id !== null} onClose={onClose} width={560}>
      <div className="flex flex-col gap-5 p-6">
        <div>
          <h2 className="truncate text-[17px] font-semibold tracking-[-0.2px]">{shown?.title || "Importing"}</h2>
          <p className="mt-1 flex items-center gap-2 text-[13px] text-muted">
            {stopped ? (
              <>
                <StartedBy by={stopped.createdBy} size={20} className="shrink-0" />
                Stopped {stageWords(stopped.stage)}. It waits here until it's answered.
              </>
            ) : done ? (
              "The footage is in."
            ) : (
              "Getting the footage ready. It keeps going if you close this."
            )}
          </p>
        </div>
        <div>
          <div className="flex items-baseline gap-3">
            <span className="text-[28px] font-semibold tabular">{percent}%</span>
            <span className="truncate text-[13px] text-muted">{done ? "Ready" : stopped ? "Stopped" : shown?.detail || "Starting…"}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
            <div className={cx("h-full rounded-full transition-[width] duration-500", stopped ? "bg-warning" : "bg-info")} style={{ width: `${percent}%` }} />
          </div>
        </div>
        <ol className="flex flex-col gap-1">
          {STEPS.map((candidate, index) => {
            const state = index < at ? "done" : index === at ? "now" : "later";
            return (
              <li key={candidate.key} className={cx("flex items-start gap-3 rounded-lg px-3 py-2", state === "now" && "bg-raised")}>
                <span className={cx("mt-1.5 size-2 shrink-0 rounded-full", state === "done" ? "bg-success" : state === "now" ? (stopped ? "bg-warning" : "animate-pulse bg-info") : "border border-line-strong")} />
                <div className="min-w-0 flex-1">
                  <div className={cx("text-[13px] font-medium", state === "later" ? "text-muted" : "text-fg")}>{candidate.label}</div>
                  <div className={cx("text-[12px]", state === "now" && stopped ? "whitespace-normal text-warning" : "truncate text-muted")}>{state === "now" && why ? why : state === "now" && shown?.detail ? shown.detail : candidate.hint}</div>
                </div>
                <span className="shrink-0 text-[12px] text-faint tabular">{state === "now" && !stopped && began[candidate.key] ? elapsed(now - began[candidate.key]!) : state === "done" ? "Done" : ""}</span>
              </li>
            );
          })}
        </ol>
        {/* One row: Close, and only what fits where it is (stopped: Replace and Retry; in: Open the script). */}
        <div className="flex items-center gap-2">
          <span className="mr-auto text-[12px] text-faint">{began.start && !stopped && !done ? `Running for ${elapsed(now - began.start)}` : ""}</span>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {stopped ? (
            <IssueActions issue={stopped} />
          ) : (
            done &&
            id !== null && (
              <Button variant="primary" onClick={() => navigate(`/scripts/${id}`)}>
                Open the script
              </Button>
            )
          )}
        </div>
      </div>
    </Modal>
  );
}

function Imports({ projects, statuses, writing, issues, scripts, onOpen }: { projects: ProjectSummary[]; statuses: Record<string, ProjectStatus>; writing: Writing[]; issues: ScriptIssueRow[]; scripts: ScriptIssueRow[]; onOpen: (id: string) => void }) {
  const running = projects.flatMap((project) => {
    const importing = statuses[project.id]?.importing;
    return importing ? [{ project, importing }] : [];
  });
  // A script both stopped and running again (being answered) shows as running.
  const open = issues.filter((issue) => !writing.some((one) => one.id === issue.id));
  if (running.length === 0 && writing.length === 0 && open.length === 0) return null;
  const total = running.length + writing.length;
  return (
    <div className="mt-6 overflow-hidden rounded-xl border border-line">
      <div className="flex h-10 items-center gap-3 bg-panel px-4 text-[12px] font-medium text-muted">
        {total > 0 && `Importing ${total} ${total === 1 ? "project" : "projects"}`}
        {open.length > 0 && <span className="text-warning">{open.length} stopped</span>}
      </div>
      {open.map((issue) => (
        <ScriptIssue key={issue.id} issue={issue} onOpen={onOpen} />
      ))}
      {writing.map((one) => (
        <button
          key={one.id}
          onClick={() => onOpen(one.id)}
          title={one.detail || undefined}
          className="grid w-full grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-4 border-t border-line px-4 py-2.5 text-left transition-colors hover:bg-panel"
        >
          <span className="flex min-w-0 items-center gap-2 truncate text-[13px] text-fg">
            <FileText size={13} className="shrink-0 text-muted" />
            <span className="truncate">{one.title || "New script"}</span>
            <StartedBy by={scripts.find((row) => row.id === one.id)?.createdBy} size={20} className="shrink-0" />
          </span>
          <span className="h-1 overflow-hidden rounded-full bg-raised">
            <span className="block h-full rounded-full bg-info transition-[width] duration-500" style={{ width: `${Math.round(Math.max(0, Math.min(1, one.percent / 100)) * 100)}%` }} />
          </span>
          {/* A number, so it's plain the import is moving (the user, Oct 30: "progress helps us know if the software is working or not"). */}
          <span className="flex max-w-[320px] items-baseline gap-2 truncate text-[12px] text-muted" title={one.detail || one.stage}>
            <span className="text-fg tabular">{Math.round(Math.max(0, Math.min(100, one.percent)))}%</span>
            <span className="truncate">{one.detail || one.stage}</span>
          </span>
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
                  ? `${Math.round(share * 100)}% · ${importing.ready} of ${importing.files} files`
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
  onImport,
}: {
  rows: Listed[];
  cardProps: (project: ProjectSummary) => CardProps;
  onChanged: () => void;
  subtitled: boolean;
  /** A search across stages: each stage's matches under its name. */
  grouped: boolean;
  statuses: Record<string, ProjectStatus>;
  /** Opens a script's import over Home (a script still importing). */
  onImport: (id: string) => void;
}) {
  const idOf = (row: Listed) => row.local?.id ?? row.cloud?.id ?? `script-${row.script!.id}`;
  const nameOf = (row: Listed) => row.local?.name ?? row.cloud?.name ?? row.script?.title ?? "";
  // What came in since the list was last shown: new rows slide in, renamed ones flash once (state B
  // laid over state A, rather than the list built again).
  const seen = useRef<Map<string, string> | null>(null);
  const [lately, setLately] = useState<{ added: Set<string>; renamed: Set<string> }>({ added: new Set(), renamed: new Set() });
  const signature = rows.map((row) => `${idOf(row)}=${nameOf(row)}`).join("\n");
  useEffect(() => {
    const now = new Map(rows.map((row) => [idOf(row), nameOf(row)]));
    const before = seen.current;
    seen.current = now;
    if (before === null) return;
    const added = new Set([...now.keys()].filter((id) => !before.has(id)));
    const renamed = new Set([...now.entries()].filter(([id, name]) => before.has(id) && before.get(id) !== name).map(([id]) => id));
    if (added.size === 0 && renamed.size === 0) return;
    setLately({ added, renamed });
    const timer = setTimeout(() => setLately({ added: new Set(), renamed: new Set() }), 1800);
    return () => clearTimeout(timer);
  }, [signature]);
  const rowOf = (row: Listed) => <div className={cx(lately.added.has(idOf(row)) && "row-new", lately.renamed.has(idOf(row)) && "row-changed")}>{rowBody(row)}</div>;
  const rowBody = (row: Listed) =>
    row.local !== null ? (
      <TableRow {...cardProps(row.local)} subtitled={subtitled} script={row.script} />
    ) : row.cloud !== null ? (
      <CloudTableRow project={row.cloud} onChanged={onChanged} />
    ) : (
      <ScriptTableRow script={row.script} importing={row.importing} onChanged={onChanged} onImport={row.importing ? () => onImport(row.script.id) : undefined} />
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
      onMouseEnter={() => prefetchScript(id)}
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
function ScriptTableRow({ script, importing, onChanged, onImport }: { script: WriterScriptRow; importing?: Importing; onChanged: () => void; onImport?: () => void }) {
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
    <div role="row" onMouseEnter={() => !onImport && prefetchScript(script.id)} onClick={() => (onImport ? onImport() : navigate(`/scripts/${script.id}`))} className={cx(COLUMNS, "group min-h-14 cursor-pointer border-t border-line px-4 py-2.5 transition-colors hover:bg-panel")}>
      <div role="cell" className="flex min-w-0 items-center gap-2.5">
        <span className="truncate text-[14px] text-fg group-hover:underline group-hover:underline-offset-[3px]" title={script.title}>
          {script.title || "Untitled script"}
        </span>
        <StartedBy by={script.createdBy ?? undefined} size={24} className="ml-auto shrink-0" />
      </div>
      <div role="cell" className="flex min-w-0 flex-wrap items-center gap-1">
        {importing ? (
          // Still importing: how far, or that it stopped (its row opens the import).
          <span className={cx("flex h-[22px] shrink-0 items-center rounded-full bg-raised px-2 text-[12px] font-medium tabular", importing.stopped ? "text-warning" : "text-info")}>{importing.word}</span>
        ) : (
          <span className="flex h-[22px] shrink-0 items-center gap-1 rounded-full bg-raised px-2 text-[12px] font-medium text-secondary">
            <FileText size={12} />
            Script
          </span>
        )}
        {script.built && !importing && (
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

/** What a paste holds: script Docs, videos, Trello cards. */
const DOC = /docs\.google\.com\/document\//i;
const TRELLO = /trello\.com\/c\//i;
const DRIVE = /drive\.google\.com/i;
const LINK = /https?:\/\/\S+/gi;

/** Script mode's kinds for Edit's styles (bodycam is a FOIA script there); shorts have none, commentary is its own. */
const WRITER_KIND: Partial<Record<Style, "foia" | "interrogation" | "courtroom">> = { bodycam: "foia", interrogation: "interrogation", courtroom: "courtroom" };

/** One source of a script to write, as Script mode checked it: a video or a reused case. */
type Source = { url: string; title: string; durationMs: number | null; reuse: boolean; earlier?: string; problem: string | null };

/**
 * New project: a title, then what it's made from, then the kind and a first
 * word to its agent. Writing a script takes the footage (a Trello card opens
 * into its videos) and any reused cases, ticked when they're recognised; an
 * edit takes its script's Doc, and videos only as reuses (footage to cut goes
 * through a script). The import runs on Home, then the script workflow or the
 * edit workflow starts by itself (the user, Oct 30).
 */
function NewProject({ open, onClose, only = null }: { open: boolean; onClose: () => void; only?: Style | null }) {
  const account = useAccount((state) => state.account);
  const allowed = editStyles(account);
  const writes = writesScripts(account);
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"write" | "edit">(writes ? "write" : "edit");
  const [text, setText] = useState("");
  const [style, setStyle] = useState<Style>("bodycam");
  const [picked, setPicked] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sources, setSources] = useState<Source[] | null>(null);
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState<{ url: string; result?: Preview; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useEditor((state) => state.toast);

  const input = text.trim();
  const links = input.match(LINK) ?? [];
  const writing = mode === "write";
  const styles = STYLES.filter((option) => (writing ? option.value === "commentary" || WRITER_KIND[option.value] !== undefined : allowed === null || allowed.has(option.value)));
  const kind = styles.some((option) => option.value === style) ? style : (styles[0]?.value ?? "bodycam");
  const commentary = writing && kind === "commentary";

  // A fresh dialog each time.
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setText("");
    setPrompt("");
    setSources(null);
    setPreview(null);
    setError(null);
    setPicked(false);
    setMode(writes ? "write" : "edit");
    if (only !== null) setStyle(only);
  }, [open]);

  // Writing: the paste read into its sources (a Trello card into its videos), each checked, reuses ticked.
  useEffect(() => {
    if (!writing || commentary || links.length === 0) {
      setSources(null);
      return;
    }
    let alive = true;
    setReading(true);
    const timer = setTimeout(async () => {
      try {
        const writer = await import("../writer/api");
        const lines: string[] = [];
        for (const line of input.split(/\n+/).map((one) => one.trim()).filter(Boolean)) {
          if (TRELLO.test(line)) {
            const card = await writer.trelloCard(line.match(LINK)?.[0] ?? line);
            if (alive && title.trim() === "" && card.name) setTitle(card.name);
            lines.push(...card.lines);
          } else lines.push(line);
        }
        // The links at once; what each is (YouTube takes a few seconds a video) as it comes.
        if (alive) setSources(lines.flatMap((line) => line.match(LINK) ?? []).map((url) => ({ url, title: "", durationMs: null, reuse: /^REUSE\b/i.test(lines.find((one) => one.includes(url)) ?? ""), problem: null })));
        const checked = await writer.checkVideos(lines);
        if (alive) setSources(checked.map((one) => ({ url: one.url, title: one.title, durationMs: one.durationMs, reuse: one.reuse, ...(one.earlier ? { earlier: one.earlier } : {}), problem: one.problem })));
      } catch (cause) {
        if (alive) setError((cause as Error).message);
      } finally {
        if (alive) setReading(false);
      }
    }, 500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [input, writing, commentary]);

  // Editing: the script's Doc read at once, its title and kind taken when none were given.
  useEffect(() => {
    if (writing || !hasImportLinks(input)) {
      setPreview(null);
      return;
    }
    let alive = true;
    setPreview({ url: input });
    const timer = setTimeout(() => {
      api
        .scriptPreview(input)
        .then((result) => {
          if (!alive) return;
          setPreview({ url: input, result });
          if (title.trim() === "" && result.title) setTitle(result.title);
        })
        .catch((cause) => alive && setPreview({ url: input, error: (cause as Error).message }));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [input, writing]);
  const named = preview?.result?.style;
  useEffect(() => {
    if (named && !picked && (allowed === null || allowed.has(named))) setStyle(named);
  }, [named, picked]);

  const footage = (sources ?? []).filter((one) => !one.reuse);
  const blocked = (sources ?? []).some((one) => one.problem !== null && !one.reuse);
  const editDoc = !writing && links.some((link) => DOC.test(link));
  const ready =
    title.trim() !== "" &&
    (writing
      ? commentary
        ? links.length > 0
        : sources !== null && !reading && footage.length > 0 && !blocked
      : input === "" || (preview?.result !== undefined && (editDoc || links.length > 0)));

  const create = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const extra = prompt.trim();
    try {
      if (writing) {
        const writer = await import("../writer/api");
        // The script workflow starts once the footage is in: the first message is its note.
        const work = commentary
          ? writer.createCommentary(title.trim(), links)
          : footage.length === 1 && footage.length === sources!.length
            ? DRIVE.test(footage[0]!.url)
              ? writer.importDrive(footage[0]!.url, undefined, title.trim(), WRITER_KIND[kind], extra)
              : writer.importYoutube(footage[0]!.url, undefined, title.trim(), WRITER_KIND[kind], extra)
            : writer.importCompilation(title.trim(), sources!.map((one) => (one.reuse ? ["REUSE", one.url, one.earlier].filter(Boolean).join(" ") : one.url)), false, WRITER_KIND[kind], extra);
        // A refusal comes at once (a bad link, no access); after that the import runs on Home.
        const early = await Promise.race([work.then(() => null, (cause: unknown) => cause), new Promise((resolve) => setTimeout(() => resolve("running"), 1500))]);
        if (early !== null && early !== "running") throw early;
        work.catch(() => {});
        onClose();
        toast(`“${title.trim()}”: importing its footage, then writing the script`, "info");
        return;
      }
      if (input !== "" && allowed !== null && !allowed.has(kind)) throw new Error("Your account can’t make full edits: an admin can give you an Edit style at accounts.spheceo.com.");
      const { project } = await api.createProject({ name: title.trim(), style: kind, ...(kind === "shorts" ? SHORTS_FORMAT : FORMAT) });
      if (input === "") {
        onClose();
        navigate(`/p/${project.id}`);
        return;
      }
      await api.attachScript(project.id, input);
      // The edit workflow starts once the import is in, with what was added to it.
      await api.firstPrompt(project.id, `Start the editing workflow.${extra ? `\n\n${extra}` : ""}`);
      onClose();
      toast(`“${title.trim()}”: importing its footage, then editing`, "info");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const field = "h-9 w-full rounded-lg border border-line bg-black px-3 text-[13px] outline-none placeholder:text-faint focus:border-muted";
  const label = "mb-1.5 block text-[12px] font-medium text-muted";
  return (
    <Modal open={open} onClose={onClose} width={580}>
      <form
        className="flex flex-col gap-5 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <h2 className="text-[17px] font-semibold tracking-[-0.2px]">New project</h2>

        <label>
          <span className={label}>Title</span>
          <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What the video is called" className={field} />
        </label>

        {writes && (
          <div className="flex h-[30px] w-fit gap-0.5 rounded-lg border border-line bg-black p-0.5">
            {(
              [
                ["write", "Write a script"],
                ["edit", "Edit from a script"],
              ] as const
            ).map(([value, name]) => (
              <button
                type="button"
                key={value}
                onClick={() => setMode(value)}
                className={cx("rounded-md px-3 text-[12px] font-medium transition-colors", mode === value ? "bg-active text-fg" : "text-muted hover:text-fg")}
              >
                {name}
              </button>
            ))}
          </div>
        )}

        <div>
          <span className={label}>{writing ? (commentary ? "Sources" : "Footage") : "Script"}</span>
          <textarea
            rows={3}
            value={text}
            placeholder={
              writing
                ? commentary
                  ? "Paste the sources: videos, articles, posts. The first is the brief."
                  : "Paste the footage: YouTube or Drive videos, or a Trello card. A case the channel already covered goes in as a reuse."
                : "Paste the script’s Google Doc. A finished video added under it goes in whole, as a reuse."
            }
            onChange={(event) => setText(event.target.value)}
            onPaste={(event) => {
              const plain = event.clipboardData.getData("text/plain");
              const pasted = importPaste(event.clipboardData.getData("text/html"), plain);
              if (pasted === plain) return;
              event.preventDefault();
              const node = event.currentTarget;
              setText(text.slice(0, node.selectionStart) + pasted + text.slice(node.selectionEnd));
            }}
            className="w-full resize-none rounded-lg border border-line bg-black px-3 py-2.5 text-[13px] outline-none placeholder:text-faint focus:border-muted"
          />
          {writing && !commentary && (reading || sources !== null) && (
            <div className="mt-2 max-h-[220px] divide-y divide-line overflow-y-auto rounded-lg border border-line">
              {reading && (sources === null || sources.length === 0) ? (
                <div className="shimmer px-3 py-2 text-[12px] text-muted">Reading the footage…</div>
              ) : (
                (sources ?? []).map((one, index) => (
                  <div key={`${one.url}-${index}`} className="flex items-center gap-3 px-3 py-2 text-[12px]">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-fg" title={one.url}>
                        {one.title || one.url}
                      </span>
                      {reading && one.title === "" && one.problem === null && <span className="shimmer block text-faint">Checking…</span>}
                      {one.problem !== null && <span className="block truncate text-danger">{one.problem}</span>}
                    </span>
                    {one.durationMs !== null && <span className="shrink-0 text-faint tabular">{shortDuration(one.durationMs / 1000)}</span>}
                    <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-muted" title="A case the channel already covered: put in as it was, not written again">
                      <input
                        type="checkbox"
                        checked={one.reuse}
                        onChange={(event) => setSources((all) => (all ?? []).map((other, at) => (at === index ? { ...other, reuse: event.target.checked } : other)))}
                      />
                      Reuse
                    </label>
                  </div>
                ))
              )}
            </div>
          )}
          {!writing && preview && (
            <div className="mt-1.5 text-[12px] text-muted">
              {preview.error ? (
                <ProblemView error={preview.error} doing="read the script" className="whitespace-normal" />
              ) : preview.result ? (
                <>
                  <span className="tabular">
                    {preview.result.title || "Untitled script"} · {preview.result.files} {preview.result.files === 1 ? "source" : "sources"} · {preview.result.narration} cut-ins
                    {preview.result.whole ? "" : ` · ${shortDuration(preview.result.seconds)}`}
                  </span>
                  {preview.result.finished?.map((one) => (
                    <span key={one} className="block truncate text-faint">
                      Reuse, whole: {one}
                    </span>
                  ))}
                  {preview.result.reused?.map((one) => (
                    <span key={one.doc} className="block truncate text-faint">
                      Reuse, as written: {one.title || "a linked script"}
                    </span>
                  ))}
                </>
              ) : (
                <span className="shimmer">Reading the script…</span>
              )}
            </div>
          )}
        </div>

        <div>
          <span className={label}>Kind</span>
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
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <label>
          <span className={label}>First message (optional)</span>
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={writing ? "Added to “Start the script workflow” once the footage is in" : "Added to “Start the editing workflow” once the footage is in"}
            className={field}
          />
        </label>

        {error && <p className="text-[12px] text-danger">{error}</p>}
        {!error && blocked && !reading && <p className="text-[12px] text-muted">Take out the video that can’t be imported, or tick it as a reuse.</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !ready}>
            {busy ? "Starting…" : writing ? "Write the script" : input === "" ? "Create" : "Start the edit"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
