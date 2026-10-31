// Home as everyone has it (until Oct 31 2026, b217d6be): one list of every
// project with its tabs (Needs you, All, Subtitled, Ideas), the imports at the
// top. The sidebar Home (Home.tsx) is a beta, on for a Mac in Settings → Beta
// (the user, Oct 31: "put the new Home … behind a beta option in Settings that
// can easily be toggled on and off"); off, this. What both have alike (New
// project, Move to cloud, a stopped import's dialogs) is Home.tsx's.

import { Archive, Check, CloudDownload, CloudUpload, Copy, Ellipsis, ExternalLink, Captions, FileText, Film, FileVideo, Lock, MessageSquare, Pencil, PenLine, Plus, RotateCw, Search, Share2, Trash2, TriangleAlert } from "lucide-react";
import { motion } from "motion/react";
import { Fragment, useEffect, useRef, useState } from "react";

import { useAccount, writesScripts } from "../lib/account";
import { api, type ProjectStatus, type WriterScriptRow } from "../lib/api";
import { cloudApi, type CloudList, type CloudProject, type CloudStatus } from "../lib/cloud";
import { copyDriveLink, openDrive, useDriveLink } from "../lib/drive";
import { navigate } from "../lib/route";
import { clientId, connectEvents, useEditor } from "../lib/store";
import { ago, shortDuration } from "../lib/time";
import { STYLES, type Creator, type ProjectSummary, type Style } from "../lib/types";
import { AppMenu } from "./AppMenu";
import { IdeasTab } from "../ideas/home-classic";
import { NewIdea, useIdeasHome } from "../ideas/home";
import { makesIdeas } from "../lib/ideas";
import { creeping } from "../writer/import-steps";
import { prefetchScript } from "../writer/opened";
import { useKept } from "../lib/kept";
import {  } from "./ProblemView";
import { toggleMenu, type MenuItem } from "./ContextMenu";
import { Logo, Tile } from "./Logo";
import { SetupCard } from "./SetupCard";
import { StartedBy } from "./StartedBy";
import { UpdateButton } from "./UpdateButton";
import { Button, cx, IconButton, Modal, Spinner, spring } from "./ui";
import { DevBadge, DevControl, promoteItem, useDevTools, testItem, useShowDev } from "./DevProjects";
import { DoneContext, doneAt, rowKey, useDoneItems } from "./HomeDone";
import { laterKey, useLater } from "../lib/later";
import { type CardProps, ImportDialog, type Importing, importShare, importStuck, type Listed, MoveToCloud, NewProject, type NewProjectStart, Notice, type NoticeProps, Place, type ScriptIssueRow, type Stage, stageName, stageOf, stageWords, useIssueDialogs, VIEW, type Writing } from "./Home";

/** How long a project someone started stays in their Needs you before it goes to review. */
const NEW_FOR_MS = 3 * 24 * 3600_000;

export function HomeClassic() {
  // What Home showed last, at once; the fresh answers take its place as they come.
  const [projects, setProjects] = useKept<ProjectSummary[] | null>("home.projects", null);
  const account = useAccount((state) => state.account);
  const [cloud, setCloud] = useKept<CloudList | null>("home.cloud", null);
  const [statuses, setStatuses] = useKept<Record<string, ProjectStatus>>("home.statuses", {});
  const [creating, setCreating] = useState(false);
  // Script mode's scripts: one list with the edits (the user, Oct 30: "merge the two applications as much as possible").
  const [scripts, setScripts] = useKept<WriterScriptRow[]>("home.scripts", []);
  // Scripts being written from videos, as Script mode's imports say.
  const [writing, setWriting] = useKept<Writing[]>("home.writing", []);
  useEffect(() => {
    // One ask of each at a time: on a busy Mac an answer can take longer than the 4 s between looks.
    const out = { progress: false, scripts: false };
    const look = () => {
      if (out.progress) return;
      out.progress = true;
      void fetch("/api/writer/progress")
        .then((answer) => (answer.ok ? answer.json() : []))
        .then((rows: unknown) => setWriting(Array.isArray(rows) ? (rows as Writing[]) : []), () => {})
        .finally(() => (out.progress = false));
    };
    // Script imports stopped on any Mac (a failed video, a cut connection): open issues, answered here.
    const stopped = () => {
      if (out.scripts) return;
      out.scripts = true;
      void fetch("/api/writer/scripts")
        .then((answer) => (answer.ok ? answer.json() : []))
        .then((rows: unknown) => setLocalScripts(Array.isArray(rows) ? (rows as ScriptIssueRow[]) : []), () => {})
        .finally(() => (out.scripts = false));
    };
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
    // /ideas is Home on its Ideas tab (the idea page's way back).
    if (window.location.pathname === "/ideas") return "ideas";
    const saved = localStorage.getItem(VIEW);
    return saved === "all" || saved === "subtitled" || saved === "ideas" || saved === "done" ? saved : "needs";
  });
  // Ideas (Oct 31): the team's repackaging, a tab of Home's for those who work on them.
  const ideasAllowed = makesIdeas(account);
  const [ideasHome, refreshIdeas, ideasError] = useIdeasHome(ideasAllowed);
  const [ideaOpen, setIdeaOpen] = useState(false);
  const ideasShown = ideasAllowed && view === "ideas";
  // As the other tabs count their lists: every idea, and the cards waiting on changes.
  const ideasCount = (ideasHome?.changes.length ?? 0) + (ideasHome?.ideas.length ?? 0);
  // An approved idea's "Write the script": New project opened with its title and links.
  const [start, setStart] = useState<NewProjectStart | null>(null);
  useEffect(() => {
    const given = sessionStorage.getItem("edit.newProject");
    if (given === null) return;
    sessionStorage.removeItem("edit.newProject");
    try {
      setStart(JSON.parse(given) as NewProjectStart);
      setCreating(true);
    } catch {
      // Not ours.
    }
  }, []);
  const [style, setStyle] = useState<Style | null>(null);
  // Projects made on a dev build: shown or hidden (DevProjects.tsx).
  const [showDev, setShowDev] = useShowDev();
  // Marked done (HomeDone.tsx): out of the lists, in the Done tab.
  const later = useLater();

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
      .then(({ projects, dev_build }) => {
        // Test projects and their controls are a dev build's only (DevProjects.tsx).
        useDevTools.setState({ on: dev_build === true });
        setProjects(projects);
      })
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
  // Whether a script is a compilation: the cloud's list says, else this Mac's copy.
  const withKind = (one: WriterScriptRow): WriterScriptRow => {
    const here = localScripts.find((local) => local.id === one.id);
    return { ...one, compilation: one.compilation ?? here?.compilation, runFailed: one.runFailed ?? here?.runFailed ?? null };
  };
  const scriptOf = new Map(scripts.flatMap((one) => {
    const edit = editOf(one);
    return edit !== null ? [[edit, withKind(one)] as const] : [];
  }));
  const scriptOnly = scripts.filter((one) => editOf(one) === null);
  // A script still importing (running, stopped or waiting on a choice) isn't
  // a script yet: it's in Importing, with how far it got (the user, Oct 30:
  // "until the first prompt is kicked off the project isn't a Script project
  // it's still in the importing phase").
  const importingNow = new Map<string, Importing>();
  for (const one of localScripts) {
    if (one.status === "processing") importingNow.set(one.id, { word: `Importing ${Math.floor(creeping(one.id, one.progress ?? 0))}%`, stopped: false, percent: creeping(one.id, one.progress ?? 0) });
    else if (one.status === "error" || one.status === "needs_choice") importingNow.set(one.id, { word: one.status === "needs_choice" ? "Waiting on a choice" : "Stopped", stopped: true });
    // In, but its first prompt not started yet: still importing until the workflow is under way.
    else if (one.firstBuild) importingNow.set(one.id, { word: "Starting the workflow", stopped: false });
  }
  for (const one of writing) importingNow.set(one.id, { word: `Importing ${Math.floor(creeping(one.id, one.percent))}%`, stopped: false, percent: creeping(one.id, one.percent), step: one.detail || one.stage });
  const count = (projects?.length ?? 0) + cloudOnly.length + scriptOnly.length;

  // What the search and filters keep.
  const words = query.trim().toLowerCase();
  const kept = (name: string, own: Style | undefined) => (words === "" || name.toLowerCase().includes(words)) && (style === null || own === style);
  const all = projects ?? [];
  const edits = all.filter((project) => !project.subtitles && (showDev || project.dev !== true) && kept(project.name, project.style));
  const subtitled = all.filter((project) => project.subtitles && (showDev || project.dev !== true) && kept(project.name, project.style));
  const cloudKept = cloudOnly.filter((project) => (showDev || project.summary?.dev !== true) && kept(project.name, project.summary?.style as Style | undefined));
  const cloudSubtitled = cloudKept.filter((project) => project.summary?.subtitles === true);
  const cloudEdits = cloudKept.filter((project) => project.summary?.subtitles !== true);
  const showEdits = view !== "subtitled";
  // Newest change first, local and cloud-only projects and scripts together.
  const everyProjectRow: Listed[] = [
    ...edits.map((project): Listed => ({ at: project.modified_ms, local: project, cloud: null, script: scriptOf.get(project.id) ?? null })),
    ...cloudEdits.map((project): Listed => ({ at: project.updated_ms, local: null, cloud: project, script: scriptOf.get(project.id) ?? null })),
    ...scriptOnly.filter((one) => kept(one.title, one.style ?? undefined) && !issues.some((issue) => issue.id === one.id && !writing.some((going) => going.id === one.id))).map((one): Listed => ({ at: one.updatedAt, local: null, cloud: null, script: withKind(one), importing: importingNow.get(one.id), writing: localScripts.some((local) => local.id === one.id && local.building === true), here: localScripts.some((local) => local.id === one.id) })),
  ].sort((a, b) => b.at - a.at);
  const everySubtitledRow: Listed[] = [
    ...subtitled.map((project): Listed => ({ at: project.modified_ms, local: project, cloud: null, script: null })),
    ...cloudSubtitled.map((project): Listed => ({ at: project.updated_ms, local: null, cloud: project, script: null })),
  ].sort((a, b) => b.at - a.at);
  const isDone = (row: Listed) => doneAt(later, rowKey(row)) !== null;
  const projectRows = everyProjectRow.filter((row) => !isDone(row));
  const subtitledRows = everySubtitledRow.filter((row) => !isDone(row));
  // The latest marked done first.
  const doneRows = [...everyProjectRow, ...everySubtitledRow].filter(isDone).sort((a, b) => (doneAt(later, rowKey(b)) ?? 0) - (doneAt(later, rowKey(a)) ?? 0));
  // What needs someone: edits on a review link not approved yet, and edits
  // whose import stopped; scripts whose import stopped are the box above the
  // list, with their answers. Ordinary scripts and the edits being worked on
  // wait in All projects (the user, Oct 30: "we shouldn't show just normal
  // scripts in the main view").
  // A project the signed-in person started in the last three days is in front
  // of them until it goes to review (the user, Oct 30: "it's confusing to add a
  // new project and not have it right in front of you"): importing, being
  // drafted, or the first draft waiting for a look.
  const me = account?.person?.name.trim().toLowerCase() ?? null;
  const startedMs = (row: Listed): number => {
    const id = row.local?.id ?? row.cloud?.id ?? null;
    const at = id === null ? NaN : Number(/^p(\d{12,})-/u.exec(id)?.[1] ?? NaN);
    return Number.isFinite(at) ? at : (localScripts.find((one) => one.id === row.script?.id)?.createdAt ?? row.script?.updatedAt ?? 0);
  };
  const starter = (row: Listed) => (row.local !== null ? (remote.get(row.local.id)?.created_by ?? row.local.created_by) : row.cloud !== null ? row.cloud.created_by : row.script.createdBy);
  const justStarted = (row: Listed) => me !== null && starter(row)?.name.trim().toLowerCase() === me && Date.now() - startedMs(row) < NEW_FOR_MS;
  const needsYou = projectRows.filter((row) => {
    // A script whose Claude run failed (the user, Oct 30: "projects that have failed like this deserve a needs you").
    if (row.local === null && row.cloud === null) return (Boolean(row.script.runFailed) && !row.writing && !row.importing) || justStarted(row);
    const state = statuses[row.local?.id ?? row.cloud?.id ?? ""];
    const stage = stageOf(row, state);
    return stage === "review" || Boolean(state?.importing?.error) || (justStarted(row) && stage !== "done");
  });
  const stoppedScripts = issues.filter((issue) => !writing.some((one) => one.id === issue.id)).length;
  // A search looks through every project; otherwise the tab's.
  const searching = words !== "" && !ideasShown;
  const rows = view === "done" && !searching ? doneRows : !showEdits ? subtitledRows : searching || view === "all" ? projectRows : needsYou;
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
    if (value === "ideas") navigate("/ideas", true);
    else if (window.location.pathname === "/ideas") navigate("/", true);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1120px] px-8 pt-8 pb-16">
        <header className="flex items-center gap-4">
          <Logo size={22} />
          {projects && (count > 0 || ideasShown) && (
            <label className="ml-4 flex h-[34px] max-w-[420px] flex-1 items-center gap-2 rounded-lg border border-line-strong bg-bg px-2.5 text-muted focus-within:border-muted">
              <Search size={14} />
              <input
                value={query}
                placeholder={ideasShown ? "Search ideas" : "Search projects"}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => event.key === "Escape" && setQuery("")}
                className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
              />
            </label>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <UpdateButton />
            {/* One main action a screen, in white (the user, Oct 30): on an empty Home, the empty state's button is it. */}
            {ideasShown ? (
              <Button variant="light" onClick={() => setIdeaOpen(true)}>
                <Plus size={15} strokeWidth={2.2} /> New idea
              </Button>
            ) : (
              <Button variant={projects && count === 0 ? "subtle" : "light"} onClick={() => setCreating(true)}>
                <Plus size={15} strokeWidth={2.2} /> New project
              </Button>
            )}
            <AppMenu />
          </div>
        </header>

        <SetupCard />

        {projects && count === 0 && !ideasShown && (
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
              <Button variant="light" onClick={() => setCreating(true)}>
                <Plus size={15} strokeWidth={2.2} /> New project
              </Button>
              {ideasAllowed && (
                <Button variant="subtle" onClick={() => choose("ideas")}>
                  Ideas
                </Button>
              )}
            </div>
          </motion.div>
        )}

        {projects && (count > 0 || ideasShown) && (
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
                    // Marked done by hand (the user, Oct 31: "so we dont have to see them").
                    ...(doneRows.length > 0 || view === "done" ? [["done", "Done", doneRows.length] as [View, string, number]] : []),
                    ...(ideasAllowed ? [["ideas", "Ideas", ideasCount] as [View, string, number]] : []),
                  ] as [View, string, number][]
                ).map(([value, label, total]) => (
                  <button
                    key={value}
                    onClick={() => choose(value)}
                    className={cx(
                      "flex items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors",
                      view === value && (!searching || value === "ideas") ? "bg-active text-fg" : "text-muted hover:text-fg",
                    )}
                  >
                    {label} <span className="font-normal text-faint tabular">{total}</span>
                  </button>
                ))}
              </div>
              <DevControl count={all.filter((project) => project.dev === true).length} cloudOnly={cloudOnly.filter((project) => project.summary?.dev === true).length} show={showDev} onShow={setShowDev} onChanged={refresh} />
              {cloud?.on && cloud.error && (
                <span className="text-[12px] text-warning/80" title={cloud.error}>
                  {cloud.offline ? "Can’t reach the cloud: showing what’s on this Mac." : "The cloud’s list didn’t load."}
                </span>
              )}
              <div className={cx("ml-auto flex gap-1.5", ideasShown && "hidden")}>
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

            {ideasShown ? (
              <IdeasTab home={ideasHome} error={ideasError} query={query} onNew={() => setIdeaOpen(true)} />
            ) : (
            <>
            {view !== "done" && <Imports writing={writing} issues={issues} onOpen={setWatching} />}
            <ImportDialog id={watching} writing={writing} issues={issues} onClose={() => setWatching(null)} />
            {rows.length > 0 ? (
              // Edits grouped by stage, script to finished video.
              <DoneContext.Provider value={later}>
                <ProjectTable rows={rows} cardProps={cardProps} onChanged={refresh} subtitled={!showEdits} grouped={showEdits && view !== "done"} statuses={statuses} onImport={setWatching} />
              </DoneContext.Provider>
            ) : searching ? (
              <p className="mt-16 text-center text-muted">Nothing matches “{query.trim()}”.</p>
            ) : view === "needs" && stoppedScripts === 0 ? (
              <div className="mt-6 rounded-xl border border-line px-4 py-10 text-center">
                <div className="text-[14px] font-medium">Nothing needs you</div>
                <p className="mt-1 text-[12px] text-muted">Stopped imports and edits waiting on review show up here.</p>
              </div>
            ) : view === "needs" ? null : view === "done" ? (
              <p className="mt-16 text-center text-muted">Nothing marked done. A project’s ⋯ has Mark as done.</p>
            ) : (
              <p className="mt-16 text-center text-muted">Nothing here.</p>
            )}
            </>
            )}
          </>
        )}
      </div>
      <NewProject open={creating} onClose={() => { setCreating(false); setStart(null); }} only={style} start={start} />
      {ideasAllowed && <NewIdea open={ideaOpen} onClose={() => setIdeaOpen(false)} onMade={refreshIdeas} />}
    </div>
  );
}

/** What Home lists: what needs someone, every project, the subtitled videos, or the ideas. */
type View = "needs" | "all" | "subtitled" | "ideas" | "done";

const STAGES: { value: Stage; label: string }[] = [
  // The footage and its words in, the script not written yet (the user, Oct 30: "know which projects are ready to script").
  { value: "importing", label: "Importing" },
  { value: "toscript", label: "Ready to script" },
  { value: "scripting", label: "Scripting" },
  { value: "ready", label: "Ready to edit" },
  { value: "editing", label: "Editing" },
  { value: "review", label: "In review" },
  { value: "done", label: "Done" },
];

/** Every status in Home's table looks alike: one pill, its icon, a word or two of about the same length (Write script, Not exported, 7 comments, Cloud only), its colour saying how much it matters; each as wide as the column (the widest of them) with its words centred, so they line up as one even column. */
const PILL = "flex h-[22px] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full px-2.5 text-[12px] leading-none whitespace-nowrap";

const CHIP = `${PILL} bg-raised font-medium`;

/** What a project’s card says about it, and what can be done to it (rename, delete, move to cloud). */
function useProject(project: ProjectSummary, onChanged: () => void, cloudOn: boolean, status?: CloudStatus, remote?: CloudProject, script: string | null = null) {
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
  const doneItems = useDoneItems(laterKey("edit", project.id), project.name);
  const menu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    toggleMenu(
      event.currentTarget,
      [
        // Made from a script: that script, its other mode.
        ...(script !== null ? [{ label: "Open its script", icon: <FileText size={14} />, onSelect: () => navigate(`/scripts/${script}`) }] : []),
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
        ...doneItems,
        ...promoteItem(project, onChanged),
        ...testItem(project, onChanged),
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

/** Chips for a project’s review notes waiting and a finished edit not exported as it is now. */
function StateChips({ state, projectId, onChanged, editor = null }: { state?: ProjectStatus; projectId?: string; onChanged?: () => void; editor?: string | null }) {
  const toast = useEditor((store) => store.toast);
  // Someone else has it open: that comes first (it opens read-only).
  if (editor !== null)
    return (
      <span title={`${editor} is editing it now: it opens read-only until they close it.`} className={cx(CHIP, "text-warning")}>
        <Lock size={12} className="shrink-0" />
        <span className="truncate">Being edited</span>
      </span>
    );
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
        className={cx(CHIP, "text-muted")}
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
  // One status a row, the one that matters most (the user, Oct 30: a row of chips was "a mess").
  const first = [
    state.importing !== null && (
        <span key="importing"
          title={state.importing.error ?? `Importing: ${state.importing.state}`}
          className={cx(CHIP, "tabular", importStuck(state.importing) ? "text-warning" : "text-info")}
        >
          {importStuck(state.importing) ? <TriangleAlert size={12} /> : <Spinner size={12} />}
          {importStuck(state.importing) ? "Import stuck" : `Importing ${importShare(state.importing)}`}
        </span>
      ),
    state.working && (
        <span key="working" title="Its agent is working on it" className={cx(CHIP, "text-agent")}>
          <span className="size-1.5 animate-pulse rounded-full bg-agent" />
          Agent working
        </span>
      ),
    state.sharing !== null && (
        <span key="sharing" title={`Sharing: ${state.sharing}`} className={cx(CHIP, "text-info")}>
          <Share2 size={12} />
          Sharing
        </span>
      ),
    state.approved !== null && (
        <span key="approved" title={`Version ${state.approved} was approved on its review`} className={cx(CHIP, "text-success")}>
          <Check size={12} />
          Approved v{state.approved}
        </span>
      ),
    state.approved === null && state.feedback > 0 && (
        <span key="notes"
          title={`${state.feedback} open comment${state.feedback === 1 ? "" : "s"} on its review`}
          className={cx(CHIP, "text-info")}
        >
          <MessageSquare size={12} />
          {state.feedback} {state.feedback === 1 ? "comment" : "comments"}
        </span>
      ),
    state.complete && !state.exported && (
        <span key="export" title="The edit is finished, but what it is now hasn’t been exported" className={cx(CHIP, "text-warning")}>
          <FileVideo size={12} />
          Not exported
        </span>
      ),
    // Nothing pressing: still where it stands, so no row's status is blank (the user, Oct 30: "7 comments. or No comments").
    state.complete && state.exported ? (
      <span key="quiet" title="Exported and on its review, with no open comments" className={cx(CHIP, "text-muted")}>
        <MessageSquare size={12} />
        No comments
      </span>
    ) : (
      <span key="quiet" title="Still being edited" className={cx(CHIP, "text-muted")}>
        <Pencil size={12} />
        In progress
      </span>
    ),
  ].find(Boolean);
  return first || null;
}

/**
 * A stopped import on Home's "need you" list, in the table's columns below it
 * (the name with who started it at its end, then where it stopped and why),
 * so the avatars line up between the two; the error's first words (the whole
 * of it a click away), and the answers in the ⋯ menu at the far right. Its
 * title opens it over Home.
 */
function ScriptIssue({ issue, onOpen }: { issue: ScriptIssueRow; onOpen: (id: string) => void }) {
  const { items, dialogs } = useIssueDialogs(issue);
  return (
    <div className={cx(COLUMNS, "min-h-14 border-t border-line px-4 py-2.5 text-[13px]")}>
      <div className="flex min-w-0 items-center gap-2.5">
        <TriangleAlert size={14} className="shrink-0 text-warning" />
        <button onClick={() => onOpen(issue.id)} className="truncate text-left text-[14px] text-fg hover:underline hover:underline-offset-[3px]" title={issue.title}>
          {issue.title}
        </button>
      </div>
      <span />
      <Type kind="script" />
      <CreatorCell by={issue.createdBy} />
      <div className="col-span-3 flex min-w-0 items-center gap-2">
        {/* Where it stopped, so it's plain what's being fixed (the list already says it stopped). */}
        <span title={`Stopped ${stageWords(issue.stage)}`} className={cx(CHIP, "text-warning")}>
          {stageName(issue.stage)}
        </span>
      </div>
      <IconButton label={`What to do about “${issue.title}”`} onClick={(event) => toggleMenu(event.currentTarget, items, { width: 220 })}>
        <Ellipsis size={16} />
      </IconButton>
      {dialogs}
    </div>
  );
}

/**
 * Imports that stopped, at the top of Home: each one's answers in its ⋯ menu
 * (View error, Retry, Replace…, Dismiss…). Answered, it leaves for the table's
 * Importing, with its bar; nothing stopped, nothing shown. The user, Oct 30:
 * "the needs you be at the top and once you retry it moves to importing at
 * the bottom with the progress bar and percentage".
 */
function Imports({ writing, issues, onOpen }: { writing: Writing[]; issues: ScriptIssueRow[]; onOpen: (id: string) => void }) {
  // A script both stopped and running again (being answered) is running.
  const open = issues.filter((issue) => !writing.some((one) => one.id === issue.id));
  if (open.length === 0) return null;
  return (
    <div className={cx(TABLE, "mt-6 overflow-hidden rounded-xl border border-line")}>
      <div className="col-span-full flex h-10 items-center bg-panel px-4 text-[12px] font-medium text-warning">{open.length} stopped</div>
      {open.map((issue) => (
        <ScriptIssue key={issue.id} issue={issue} onOpen={onOpen} />
      ))}
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
/**
 * Home's table: name, category, type, creator, status, length, updated, ⋯.
 * The name takes what's left; every other column is as wide as its widest
 * entry, with the same space between each (the user, Oct 30: no wide gap after
 * a short category). The table sets the columns and each row takes them up
 * (subgrid), so they line up row to row.
 */
const TABLE = "grid grid-cols-[minmax(0,1fr)_repeat(7,auto)] gap-x-5";

const COLUMNS = "col-span-full grid grid-cols-subgrid items-center";

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
  const rowOf = (row: Listed) => <div className={cx(COLUMNS, lately.added.has(idOf(row)) && "row-new", lately.renamed.has(idOf(row)) && "row-changed")}>{rowBody(row)}</div>;
  const rowBody = (row: Listed) =>
    row.local !== null ? (
      <TableRow {...cardProps(row.local)} subtitled={subtitled} script={row.script} />
    ) : row.cloud !== null ? (
      <CloudTableRow project={row.cloud} script={row.script} onChanged={onChanged} />
    ) : (
      <ScriptTableRow script={row.script} importing={row.importing} writing={row.writing === true} here={row.here === true} onChanged={onChanged} onImport={row.importing ? () => onImport(row.script.id) : undefined} />
    );
  // One stage (or the subtitled videos): newest first, by when they changed.
  const groups = !grouped
    ? null
    : STAGES.map((stage) => ({ ...stage, rows: rows.filter((row) => stageOf(row, statuses[row.local?.id ?? row.cloud?.id ?? ""]) === stage.value) })).filter((group) => group.rows.length > 0);
  return (
    <div role="table" aria-label="Projects" className={cx(TABLE, "mt-6 overflow-hidden rounded-xl border border-line")}>
      <div role="row" className={cx(COLUMNS, "h-10 bg-panel px-4 text-[12px] font-medium text-muted")}>
        <span role="columnheader">Name</span>
        <span role="columnheader">Category</span>
        <span role="columnheader">Type</span>
        <span role="columnheader">Creator</span>
        <span role="columnheader">Status</span>
        <span role="columnheader">
          Length
        </span>
        <span role="columnheader">
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
                {heading && <div className="col-span-full border-t border-line px-4 pt-3.5 pb-1.5 text-[11.5px] font-medium text-faint">{label}</div>}
                {rowOf(row)}
              </Fragment>
            );
          })
        : groups.map((group) => (
            <Fragment key={group.value}>
              <div className="col-span-full flex items-center gap-2 border-t border-line px-4 pt-3.5 pb-1.5 text-[11.5px] font-medium text-faint">
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
  const card = useProject(project, onChanged, props.cloudOn, props.status, remote, script?.id ?? null);
  return (
    <>
      <div role="row" onClick={card.open} className={cx(COLUMNS, "group min-h-14 cursor-pointer border-t border-line px-4 py-2.5 transition-colors hover:bg-panel")}>
        <div role="cell" className="flex min-w-0 items-center gap-2.5">
          {card.nameInput ?? (
            <span className="truncate text-[14px] text-fg group-hover:underline group-hover:underline-offset-[3px]" title={project.problem ?? project.name}>
              {project.name}
            </span>
          )}
          {project.dev === true && <DevBadge />}
        </div>
        <Category style={project.style} compilation={script?.compilation} />
        <Type kind={project.subtitles ? "subtitles" : "edit"} />
        <CreatorCell by={remote?.created_by ?? project.created_by} projectId={project.id} />
        <div role="cell" className="flex min-w-0 items-center gap-1.5">
          {/* Where its files are, in a slot of its own so the statuses line up, then its one status: what's wrong with it, else where it stands. */}
          <Place sync={card.cloudNews ? card.status : undefined} />
          {card.notice ? (
            <Notice {...card.notice} />
          ) : (
            <StateChips state={state} projectId={project.id} onChanged={onChanged} editor={card.editor} />
          )}
          {card.drive ? (
            <button onClick={card.driveMenu} title={`On Drive: ${card.drive.name}`} className={cx(CHIP, "text-success hover:bg-hover")}>
              On Drive ↗
            </button>
          ) : (
            subtitled && <span className="shrink-0 text-[12px] text-faint">Not uploaded</span>
          )}
        </div>
        <span role="cell" className="text-[13px] text-secondary tabular">
          {project.problem ? "" : shortDuration(project.duration_frames / project.fps)}
        </span>
        <span role="cell" className="text-[13px] text-secondary">
          {ago(project.modified_ms)}
        </span>
        <button
          title="More"
          onClick={card.menu}
          className="flex size-7 items-center justify-center rounded-md text-muted opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:bg-hover hover:text-fg"
        >
          <Ellipsis size={15} />
        </button>
      </div>
      {card.dialogs}
    </>
  );
}

/** A project's category: its kind of video, one label with "Compilation" when it's over several videos ("Bodycam Compilation"). */
function Category({ style, compilation = false }: { style?: Style | null; compilation?: boolean }) {
  const label = STYLES.find((option) => option.value === style)?.label ?? "";
  const text = compilation ? `${label} Compilation`.trim() : label;
  return (
    <span role="cell" className="truncate text-[13px] text-secondary" title={text || undefined}>
      {text}
    </span>
  );
}

/** Who started it: their picture and first name ("Siphesihle Mbuyisa" → Siphesihle); an empty circle when no one's recorded. */
function CreatorCell({ by, projectId }: { by: Creator | null | undefined; projectId?: string }) {
  const name = by?.name.trim() ?? "";
  // An account named by its email shows the part before the @.
  const first = (name.includes("@") && !name.includes(" ") ? name.split("@")[0]! : name).split(/\s+/u)[0] ?? "";
  return (
    <span role="cell" className="flex min-w-0 items-center gap-2 text-[13px] text-secondary">
      <StartedBy by={by} projectId={projectId} size={20} placeholder />
      <span className="truncate">{first}</span>
    </span>
  );
}

/** What a row is: a script, an edit, or a subtitled video. */
function Type({ kind }: { kind: "script" | "edit" | "subtitles" }) {
  const [Icon, label] = kind === "script" ? [FileText, "Script"] : kind === "edit" ? [Film, "Edit"] : [Captions, "Subtitles"];
  return (
    <span role="cell" className="flex min-w-0 items-center gap-1.5 text-[13px] text-secondary">
      <Icon size={13} className="shrink-0" />
      {label}
    </span>
  );
}

/** A script with no edit yet: opening it opens the script; once written, Start the edit makes its video project. */
function ScriptTableRow({ script, importing, writing, here, onChanged, onImport }: { script: WriterScriptRow; importing?: Importing; writing: boolean; here: boolean; onChanged: () => void; onImport?: () => void }) {
  const [starting, setStarting] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [why, setWhy] = useState(false);
  const failed = script.runFailed ?? null;
  const doneItems = useDoneItems(laterKey("script", script.id), script.title || "Untitled script");
  // Its ⋯, as an edit's: open it, and (when this Mac has it) rename or delete it.
  const menu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    toggleMenu(
      event.currentTarget,
      [
        { label: "Open script", icon: <FileText size={14} />, onSelect: () => navigate(`/scripts/${script.id}`) },
        ...doneItems,
        ...(failed !== null
          ? ([
              { label: "View error", icon: <TriangleAlert size={14} />, onSelect: () => setWhy(true) },
              { label: "Run again", icon: <RotateCw size={14} />, onSelect: () => void write() },
            ] satisfies MenuItem[])
          : []),
        ...(here
          ? ([
              { label: "Rename", icon: <Pencil size={14} />, onSelect: () => setRenaming(script.title) },
              { separator: true },
              { label: "Delete…", icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(true) },
            ] satisfies MenuItem[])
          : []),
      ],
      { width: 180 },
    );
  };
  const rename = async () => {
    const title = renaming?.trim() ?? "";
    setRenaming(null);
    if (title === "" || title === script.title) return;
    try {
      const writer = await import("../writer/api");
      await writer.renameScript(script.id, title);
      onChanged();
    } catch (error) {
      useEditor.getState().toastError(error, `rename “${script.title}”`);
    }
  };
  const remove = async () => {
    setDeleting(false);
    try {
      const writer = await import("../writer/api");
      await writer.deleteScript(script.id);
      onChanged();
    } catch (error) {
      useEditor.getState().toastError(error, `delete “${script.title}”`);
    }
  };
  // Ready to script: Claude writes it (as the script page's Build the script does), followed on its page.
  const write = async (event?: React.MouseEvent) => {
    event?.stopPropagation();
    setStarting(true);
    try {
      const writer = await import("../writer/api");
      await writer.startBuild(script.id, "");
      navigate(`/scripts/${script.id}`);
    } catch (error) {
      useEditor.getState().toastError(error, `write “${script.title}”`);
    } finally {
      setStarting(false);
    }
  };
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
    <>
    <div role="row" onMouseEnter={() => !onImport && prefetchScript(script.id)} onClick={() => (onImport ? onImport() : navigate(`/scripts/${script.id}`))} className={cx(COLUMNS, "group min-h-14 cursor-pointer border-t border-line px-4 py-2.5 transition-colors hover:bg-panel")}>
      <div role="cell" className="flex min-w-0 items-center gap-2.5">
        <span className="truncate text-[14px] text-fg group-hover:underline group-hover:underline-offset-[3px]" title={script.title}>
          {script.title || "Untitled script"}
        </span>
      </div>
      <Category style={script.style} compilation={script.compilation} />
      <Type kind="script" />
      <CreatorCell by={script.createdBy ?? undefined} />
      <div role="cell" className="flex min-w-0 items-center gap-1.5">
        {importing && !importing.stopped && importing.percent !== undefined ? (
          // Importing: how far (the step in its tooltip; its row opens the import).
          <span className={cx(CHIP, "text-info tabular")} title={importing.step}>
            <span className="h-1 min-w-10 flex-1 overflow-hidden rounded-full bg-line">
              <span className="block h-full rounded-full bg-info transition-[width] duration-500" style={{ width: `${Math.round(Math.max(0, Math.min(100, importing.percent)))}%` }} />
            </span>
            {Math.floor(Math.max(0, Math.min(100, importing.percent)))}%
          </span>
        ) : importing ? (
          <span className={cx(CHIP, "tabular", importing.stopped ? "text-warning" : "text-info")}>
            {importing.stopped ? <TriangleAlert size={12} /> : <Spinner size={12} />}
            {importing.word}
          </span>
        ) : writing ? (
          <span className={cx(CHIP, "text-info")}>
            <Spinner size={12} />
            Writing
          </span>
        ) : failed !== null ? (
          // Its last run failed: said in orange, and a click runs it again (what went wrong is in its tooltip and ⋯ View error).
          <button disabled={starting} title={`Claude's last run stopped: ${failed.error}\nClick to run it again.`} onClick={(event) => void write(event)} className={cx(CHIP, "cursor-pointer text-warning transition-colors hover:bg-hover disabled:opacity-60")}>
            <RotateCw size={12} />
            {starting ? "Starting…" : "Run failed"}
          </button>
        ) : (
          // Its next step: the pill's shape, filled, so it reads as the button it is (the user, Oct 30: "these are ctas").
          <button disabled={starting} onClick={(event) => void (script.built ? start(event) : write(event))} className={cx(PILL, "cursor-pointer bg-fg font-semibold text-bg transition-colors hover:bg-white disabled:opacity-60")}>
            {script.built ? <Film size={12} /> : <PenLine size={12} />}
            {starting ? "Starting…" : script.built ? "Start edit" : "Write script"}
          </button>
        )}
      </div>
      <span role="cell" className="text-[13px] text-secondary tabular">
        {script.durationMs > 0 ? shortDuration(script.durationMs / 1000) : ""}
      </span>
      <span role="cell" className="text-[13px] text-secondary" title={script.updatedBy ? `by ${script.updatedBy}` : undefined}>
        {ago(script.updatedAt)}
      </span>
      <button
        title="More"
        onClick={menu}
        className="flex size-7 items-center justify-center rounded-md text-muted opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:bg-hover hover:text-fg"
      >
        <Ellipsis size={15} />
      </button>
    </div>
      <Modal open={renaming !== null} onClose={() => setRenaming(null)} width={420}>
        <form
          className="p-6"
          onSubmit={(event) => {
            event.preventDefault();
            void rename();
          }}
        >
          <h2 className="text-[18px] font-semibold tracking-[-0.3px]">Rename script</h2>
          <input autoFocus value={renaming ?? ""} maxLength={180} onChange={(event) => setRenaming(event.target.value)} className="mt-4 h-9 w-full rounded-md border border-line bg-panel px-3 text-[14px] text-fg outline-none focus:border-line-strong" />
          <div className="mt-[22px] flex justify-end gap-2">
            <Button variant="subtle" type="button" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!renaming?.trim() || renaming.trim() === script.title}>
              Rename
            </Button>
          </div>
        </form>
      </Modal>
      <Modal open={why} onClose={() => setWhy(false)} width={460}>
        <div className="p-6">
          <h2 className="text-[18px] font-semibold tracking-[-0.3px]">Claude's last run stopped</h2>
          <p className="mt-1 text-[13px] text-muted">{failed ? ago(failed.at) : ""}</p>
          <pre className="mt-3 max-h-60 overflow-auto rounded-md bg-raised p-3 text-[12px] leading-relaxed whitespace-pre-wrap text-secondary">{failed?.error}</pre>
          <div className="mt-[22px] flex justify-end gap-2">
            <Button variant="subtle" onClick={() => setWhy(false)}>
              Close
            </Button>
            <Button
              variant="light"
              onClick={() => {
                setWhy(false);
                void write();
              }}
            >
              Run again
            </Button>
          </div>
        </div>
      </Modal>
      <Modal open={deleting} onClose={() => setDeleting(false)} width={380}>
        <div className="p-6">
          <h2 className="text-[18px] font-semibold tracking-[-0.3px]">Delete “{script.title}”?</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">The script, its transcript, preview and narration are deleted, for everyone on the team.</p>
          <div className="mt-[22px] flex justify-end gap-2">
            <Button variant="subtle" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void remove()}>
              Delete
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/** A project only in the cloud: opening it downloads it to this Mac. */
function CloudTableRow({ project, script = null, onChanged }: { project: CloudProject; script?: WriterScriptRow | null; onChanged: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const summary = project.summary ?? {};
  const seconds = summary.durationFrames && summary.fps ? summary.durationFrames / summary.fps : null;
  const doneItems = useDoneItems(laterKey("edit", project.id), project.name);
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
        </div>
        <Category style={summary.style} compilation={script?.compilation} />
        <Type kind={summary.subtitles ? "subtitles" : "edit"} />
        <CreatorCell by={project.created_by} projectId={project.id} />
        <div role="cell" className="flex min-w-0 items-center gap-1.5">
          {project.holder ? (
            <StateChips editor={project.holder} />
          ) : (
            <span title="Not on this Mac yet: opening it downloads it" className={cx(CHIP, "text-muted")}>
              <CloudDownload size={12} />
              Cloud only
            </span>
          )}
        </div>
        <span role="cell" className="text-[13px] text-secondary tabular">
          {seconds !== null ? shortDuration(seconds) : ""}
        </span>
        <span role="cell" className="text-[13px] text-secondary" title={`by ${project.updated_by}`}>
          {ago(project.updated_ms)}
        </span>
        <button
          title="More"
          onClick={(event) => {
            event.stopPropagation();
            toggleMenu(
              event.currentTarget,
              [
                ...(script !== null ? ([{ label: "Open its script", icon: <FileText size={14} />, onSelect: () => navigate(`/scripts/${script.id}`) }] satisfies MenuItem[]) : []),
                ...doneItems,
                { separator: true },
                { label: "Delete…", icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(true) },
              ],
              { width: 180 },
            );
          }}
          className="flex size-7 items-center justify-center rounded-md text-muted opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:bg-hover hover:text-fg"
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
