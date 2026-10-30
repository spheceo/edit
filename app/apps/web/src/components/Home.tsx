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
  const account = useAccount((state) => state.account);
  // Someone who writes scripts and makes no videos: Script mode is their home.
  useEffect(() => {
    if (!makesVideos(account) && writesScripts(account)) navigate("/scripts", true);
  }, [account]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind>(() => (localStorage.getItem(KIND) === "subtitled" ? "subtitled" : "edits"));
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
  const cloudEditsAll = cloudOnly.filter((project) => project.summary?.subtitles !== true).length;
  const showEdits = kind !== "subtitled";
  // One table, newest change first, local and cloud-only projects together.
  const rows: Listed[] = [
    ...(showEdits ? edits : subtitled).map((project): Listed => ({ at: project.modified_ms, local: project, cloud: null, script: scriptOf.get(project.id) ?? null })),
    ...(showEdits ? cloudEdits : cloudSubtitled).map((project): Listed => ({ at: project.updated_ms, local: null, cloud: project, script: scriptOf.get(project.id) ?? null })),
    ...(showEdits ? scriptOnly.filter((one) => kept(one.title, one.style ?? undefined)).map((one): Listed => ({ at: one.updatedAt, local: null, cloud: null, script: one })) : []),
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
                    ["edits", "Projects", all.filter((project) => !project.subtitles).length + cloudEditsAll + scriptOnly.length],
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

            <Imports projects={projects ?? []} statuses={statuses} />
            {rows.length > 0 ? (
              <ProjectTable rows={rows} cardProps={cardProps} onChanged={refresh} subtitled={!showEdits} statuses={statuses} />
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
const KIND = "edit.home.kind";

/** Each kind of video’s colour (its dot on cards and filters). */
const STYLE_COLOURS: Record<Style, string> = { bodycam: "#7aa2ff", interrogation: "#ff5f6d", courtroom: "#c4a7ff", commentary: "#e5be72", shorts: "#5fd38d" };

/** What each kind of video makes, under the style picker. */
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
function Imports({ projects, statuses }: { projects: ProjectSummary[]; statuses: Record<string, ProjectStatus> }) {
  const running = projects.flatMap((project) => {
    const importing = statuses[project.id]?.importing;
    return importing ? [{ project, importing }] : [];
  });
  if (running.length === 0) return null;
  return (
    <div className="mt-6 overflow-hidden rounded-xl border border-line">
      <div className="flex h-10 items-center bg-panel px-4 text-[12px] font-medium text-muted">
        Importing {running.length} {running.length === 1 ? "project" : "projects"}
      </div>
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
  statuses,
}: {
  rows: Listed[];
  cardProps: (project: ProjectSummary) => CardProps;
  onChanged: () => void;
  subtitled: boolean;
  statuses: Record<string, ProjectStatus>;
}) {
  // Done is folded away until asked for: the work still to do comes first.
  const [showDone, setShowDone] = useState(false);
  const idOf = (row: Listed) => row.local?.id ?? row.cloud?.id ?? `script-${row.script!.id}`;
  const rowOf = (row: Listed) =>
    row.local !== null ? (
      <TableRow {...cardProps(row.local)} subtitled={subtitled} script={row.script} />
    ) : row.cloud !== null ? (
      <CloudTableRow project={row.cloud} onChanged={onChanged} />
    ) : (
      <ScriptTableRow script={row.script} onChanged={onChanged} />
    );
  // Subtitled videos have no stages: newest first, by when they changed.
  const groups = subtitled
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
        : groups.map((group) => {
            const folded = group.value === "done" && !showDone;
            return (
              <Fragment key={group.value}>
                <div className="flex items-center gap-2 border-t border-line px-4 pt-3.5 pb-1.5 text-[11.5px] font-medium text-faint">
                  {group.label} <span className="tabular">{group.rows.length}</span>
                  {group.value === "done" && (
                    <button onClick={() => setShowDone(!showDone)} className="ml-1 text-muted hover:text-fg">
                      {folded ? "Show" : "Hide"}
                    </button>
                  )}
                </div>
                {!folded && group.rows.map((row) => <Fragment key={idOf(row)}>{rowOf(row)}</Fragment>)}
              </Fragment>
            );
          })}
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
  // The team's voice-over recording, for a kind of video narrated by one: a file, or a Drive link to it.
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [voiceLink, setVoiceLink] = useState("");
  const voicePicker = useRef<HTMLInputElement>(null);
  // The style the script's heading named ("COURT …"), until the person picks another.
  const [picked, setPicked] = useState(false);
  const [scripts, setScripts] = useState<WriterScriptRow[] | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  // The first message to its agent, sent when the import is done; the import then runs here on Home.
  const [prompt, setPrompt] = useState("");
  const url = text.trim();
  const script = hasImportLinks(url);

  // A fresh dialog each time, with Writer’s scripts as they are now.
  useEffect(() => {
    if (!open) return;
    setText("");
    setPrompt("");
    setPreview(null);
    setVoiceFile(null);
    setVoiceLink("");
    setPicked(false);
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
      // With a first message the import runs in the background, here on Home.
      if (prompt.trim() !== "") {
        await api.firstPrompt(project, prompt.trim());
        toast(`Importing “${one.title}”: your message goes to its agent when it’s in`, "info");
        return;
      }
      navigate(`/p/${project}`);
    } catch (error) {
      useEditor.getState().toastError(error, "start the edit from Writer");
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

  // The script says which kind of video it is: that's the style, unless the person chose one.
  const named = preview?.result?.style;
  useEffect(() => {
    if (named && !picked && (allowed === null || allowed.has(named))) setStyle(named);
  }, [named, picked]);
  const recording = script && NARRATION[style] === "recording";
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
      const { project } = await api.createProject({ name, style, ...(style === "shorts" ? SHORTS_FORMAT : FORMAT) });
      if (script) {
        // The recording first, so the import places it instead of voicing the cut-ins.
        if (recording && (voiceFile !== null || voiceLink.trim() !== "")) {
          try {
            if (voiceFile !== null) await api.uploadFile(project.id, voiceFile, `voiceover-${clientId}`);
            else await api.importDrive(project.id, voiceLink.trim(), false, clientId);
          } catch (error) {
            // The edit still starts, on a stand-in voice; the Script tab offers the recording again.
            useEditor.getState().toastError(error, "add the voice-over");
          }
        }
        await api.attachScript(project.id, url);
        useEditor.getState().setMediaTab("downloads");
      }
      // After the script, so it waits for the import the script started.
      if (prompt.trim() !== "") await api.firstPrompt(project.id, prompt.trim());
      onClose();
      // A script with a first message imports in the background: start the next one.
      if (script && prompt.trim() !== "") {
        toast(`Importing “${name}”: your message goes to its agent when it’s in`, "info");
        return;
      }
      navigate(`/p/${project.id}`);
    } catch (error) {
      useEditor.getState().toastError(error, "start the project");
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
        {/* A project starts as a video to edit or as a script to write (which becomes its video). */}
        {writesScripts(useAccount.getState().account) && (
          <div className="mx-1 mb-1 flex h-[30px] w-fit gap-0.5 rounded-lg border border-line bg-black p-0.5">
            <span className="flex items-center rounded-md bg-active px-2.5 text-[12px] font-medium text-fg">Edit a video</span>
            <button
              type="button"
              onClick={() => {
                onClose();
                navigate("/scripts?new=1");
              }}
              className="flex items-center rounded-md px-2.5 text-[12px] font-medium text-muted hover:text-fg"
            >
              Write a script
            </button>
          </div>
        )}
        <textarea
          autoFocus
          rows={3}
          value={text}
          placeholder="Name a project, find a Writer script, or paste case links (Docs, Drive, YouTube, Trello, a finished video’s review link)"
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            const plain = event.clipboardData.getData("text/plain");
            const pasted = importPaste(event.clipboardData.getData("text/html"), plain);
            if (pasted === plain) return;
            event.preventDefault();
            const node = event.currentTarget;
            setText(text.slice(0, node.selectionStart) + pasted + text.slice(node.selectionEnd));
          }}
          className="w-full resize-y rounded-lg bg-transparent px-3 py-2 text-[14px] outline-none placeholder:text-faint"
        />
        {(script || fromWriter.length > 0) && (
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="First message to its agent (optional): sent when the import is done, which then runs here"
            className="mx-3 mb-2 h-8 w-[calc(100%-24px)] rounded-md border border-line bg-black px-2 text-[13px] outline-none placeholder:text-faint focus:border-muted"
          />
        )}
        {script && (
          <div className="truncate px-3 pb-2 text-[12px] text-muted">
            {preview?.error ? (
              <ProblemView error={preview.error} doing="read the script" className="whitespace-normal py-1" />
            ) : preview?.result ? (
              <span className="tabular">
                <span className="text-fg">{preview.result.title || "Untitled script"}</span> · {preview.result.files} {preview.result.files === 1 ? "source" : "sources"} · {preview.result.narration} cut-ins · {preview.result.whole ? "duration after import" : shortDuration(preview.result.seconds)}
                {preview.result.cardScript && (
                  <span className="block truncate whitespace-normal text-faint">
                    Follows the card’s script “{preview.result.cardScript.title}”: it covers {preview.result.cardScript.covered} of the card’s{" "}
                    {preview.result.cardScript.cases} cases
                  </span>
                )}
                {preview.result.finished?.map((one) => (
                  <span key={one} className="block truncate whitespace-normal text-faint">
                    Puts in the finished video “{one}”, played as it is
                  </span>
                ))}
                {preview.result.reused?.map((one) => (
                  <span key={one.doc} className="block truncate whitespace-normal text-faint">
                    Reuses “{one.title || "a linked script"}” as written ({one.footage} {one.footage === 1 ? "range" : "ranges"})
                  </span>
                ))}
                {preview.result.skipped?.map((one) => (
                  <span key={one.doc} className="block whitespace-normal text-faint">
                    Left out “{one.title || `docs.google.com/…/${one.doc.slice(0, 8)}`}”: {one.why}
                  </span>
                ))}
              </span>
            ) : (
              <span className="shimmer">Reading the case links…</span>
            )}
          </div>
        )}
        {recording && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2 text-[12px]">
            <span className="font-medium">Voice-over</span>
            <Button type="button" size="sm" onClick={() => voicePicker.current?.click()}>
              {voiceFile ? voiceFile.name : "Choose the recording"}
            </Button>
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
            {voiceFile === null && (
              <input
                value={voiceLink}
                onChange={(event) => setVoiceLink(event.target.value)}
                placeholder="or a Google Drive link to it"
                className="h-7 min-w-[180px] flex-1 rounded-md border border-line bg-black px-2 outline-none placeholder:text-faint focus:border-muted"
              />
            )}
            <span className="basis-full text-faint">
              {STYLES.find((one) => one.value === style)?.label} videos are narrated by your recording. Optional now: until it’s added, a stand-in voice is used.
            </span>
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
        {styles.length > 0 && (
          <div className="flex items-center gap-2 border-t border-line px-3 py-2 text-[12px] text-faint">
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: STYLE_COLOURS[style] }} />
            {STYLE_NOTES[style]}
          </div>
        )}
        <div className="flex items-center gap-2 border-t border-line px-1 pt-2 pb-0.5">
          <div className={cx("mr-auto flex rounded-lg bg-black p-0.5 ring-1 ring-line", styles.length === 0 && "invisible")}>
            {styles.map((option) => (
              <button
                type="button"
                key={option.value}
                onClick={() => {
                  setStyle(option.value);
                  setPicked(true);
                }}
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
