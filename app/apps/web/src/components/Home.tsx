import { Archive, Check, ChevronDown, ChevronRight, ListFilter, CloudAlert, CloudDownload, CloudOff, CloudUpload, Copy, ExternalLink, FileText, Film, FileVideo, Lock, MessageSquare, Pencil, PenLine, Plus, Replace, RotateCw, Search, Share2, SkipForward, Tag, Trash2, TriangleAlert, X } from "lucide-react";
import { motion } from "motion/react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { editStyles, makesVideos, useAccount, writesScripts } from "../lib/account";
import { api, type ProjectStatus, type WriterScriptRow } from "../lib/api";
import { shareChip } from "../lib/export-face";
import { hasImportLinks, importPaste } from "../lib/import-input";
import { cloudApi, type CloudList, type CloudProject, type CloudStatus } from "../lib/cloud";
import { copyDriveLink, openDrive, useDriveLink } from "../lib/drive";
import { asleep, laterKey, useLater, type LaterKey } from "../lib/later";
import { navigate } from "../lib/route";
import { clientId, connectEvents, useEditor } from "../lib/store";
import { ago, shortDuration } from "../lib/time";
import { NARRATION, STYLES, type Creator, type ProjectSummary, type Style } from "../lib/types";
import { CardTableRow, IdeaTableRow, ideaStage, NewIdea, NoIdeas, useIdeasHome } from "../ideas/home";
import { makesIdeas } from "../lib/ideas";
import { creeping, elapsed, STEPS, stepOf } from "../writer/import-steps";
import { prefetchScript } from "../writer/opened";
import { CAN, useGrants } from "../writer/can";
import type { Kind } from "../writer/types";
import { useKept } from "../lib/kept";
import { askExportFolder } from "./ExportFolder";
import { ProblemView } from "./ProblemView";
import { toggleMenu, type MenuItem } from "./ContextMenu";
import { AsideStatus, BackMark, BY, Category, CATEGORY, CHIP, COLUMNS, contextMenu, CreatorCell, KindMark, LaterContext, LENGTH, LengthCell, layoutFor, NAME, PILL, ROW, RowButtons, StatusCell, TableShape, Updated, useAside, withAside } from "./HomeTable";
import { HomeSidebar, nameOf, OpenSidebar, placeOf, placeOfSection, PLACES, useSidebarOpen, type Place as Spot, type Section, type Where } from "./HomeSidebar";
import { ThumbnailGrid, useMakeThumbnail } from "../thumbnails/list";
import { Loader, Tile } from "./Logo";
import { SetupCard } from "./SetupCard";
import { StartedBy } from "./StartedBy";
import { MemoryChip } from "./MemoryChip";
import { UpdateButton } from "./UpdateButton";
import { Button, ConfirmDialog, cx, Modal, Pulse, spring } from "./ui";
import { DevBadge, DevControl, promoteItem, useDevTools, useShowDev } from "./DevProjects";

// Every project is 1080p at 30 fps.
const FORMAT = { width: 1920, height: 1080, fps: 30 };
/** A YouTube Short's frame: 9:16. */
const SHORTS_FORMAT = { width: 1080, height: 1920, fps: 30 };

/** How long a project someone started stays in their Needs you before it goes to review. */
const NEW_FOR_MS = 3 * 24 * 3600_000;

/** Done shows its most recent this many until asked for all. */
const DONE_SHOWN = 40;

/**
 * One thing on Home: an edit, a subtitled video, a script, a stopped import,
 * an idea or a board card, where it is (its section and stage, "done" when
 * approved), and its row.
 */
interface Item {
  id: string;
  /** Its name in Later (null: it can't be set aside). */
  key: LaterKey | null;
  section: Section;
  stage: string;
  at: number;
  title: string;
  /** Started by the signed-in person (a board card is everyone's). */
  mine: boolean;
  /** Started by the signed-in person in the last three days and not done: first in its Scripts or Edits, under New. */
  fresh?: boolean;
  /** Its kind of video (an idea's workspace), for the filter; none for a board card or a stopped import. */
  kind?: Style | null;
  row: () => ReactNode;
}

/**
 * Home (Oct 31 2026, a beta until Nov 3, when it became everyone's: Sphe,
 * "moving forward, we want to use the new home"): a sidebar of ideas, thumbnails,
 * scripts and edits by stage, Later and Done, and one short list at a time
 * beside it, the study portal's look (the user, Oct 31: "We have ideas,
 * scripts, and edits ... complaints from the teams about having to scroll
 * through a long, tedious" list, "and we also need to be able to have ways to
 * put projects aside"; then, of this design, "i think this is way more
 * organised"). Your own work by default (Mine), the team's a click away
 * (Everyone); a search looks through everything.
 */
export function Home() {
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
  // A script import opened over Home (from its row).
  const [watching, setWatching] = useState<string | null>(null);
  const issues = localScripts.filter((row) => (row.status === "needs_choice" || row.status === "error") && !row.dismissedAt);
  const [query, setQuery] = useState("");
  // Ideas (Oct 31): the team's repackaging, a section of Home's for those who work on them.
  const ideasAllowed = makesIdeas(account);
  const [ideasHome, refreshIdeas, ideasError] = useIdeasHome(ideasAllowed);
  const [ideaOpen, setIdeaOpen] = useState(false);
  // The places this person works in, and only those (Sphe, Nov 6: "almost a tunnel vision"): Ideas (and Thumbnails)
  // with the permission, Scripts when they write them, Edits when they make videos (or have edits they may open).
  const makes = makesVideos(account);
  const hasEdits = (projects?.length ?? 0) > 0 || (cloud?.projects?.length ?? 0) > 0;
  const edits = makes || hasEdits || (!ideasAllowed && !writesScripts(account) && scripts.length === 0);
  const places: Spot[] = [...(ideasAllowed ? (["ideas"] as const) : []), ...(writesScripts(account) || scripts.length > 0 ? (["scripts"] as const) : []), ...(edits ? (["edits"] as const) : [])];
  // New project: only for someone who writes scripts or makes videos.
  const mayCreate = makes || writesScripts(account);
  // One place at a time, remembered on this browser; /ideas is Home on its Ideas (the idea page's way back).
  // /thumbnails is Home on its Thumbnails (a thumbnail's way back), as /ideas is on its Ideas.
  const [where, setWhere] = useState<Where>(() => (window.location.pathname === "/ideas" ? "ideas" : window.location.pathname === "/thumbnails" ? "thumbnails" : savedWhere()));
  const shownWhere: Where = (placeOf(where).place !== null && !places.includes(placeOf(where).place!)) || (where === "thumbnails" && !ideasAllowed) ? (places[0] ?? "edits") : where;
  const thumbnail = useMakeThumbnail();
  // Yours, or everyone's (remembered on this browser); nobody signed in has nothing of their own.
  const [mineOnly, setMineOnly] = useState(() => localStorage.getItem(MINE) !== "0");
  const mine = mineOnly && account?.person != null;
  // One kind of video only (Sphe, Nov 2: Mine/Everyone "turned into like a dropdown with filters like category"), remembered on this browser.
  const [kind, setKind] = useState<Style | null>(() => (STYLES.some((one) => one.value === localStorage.getItem(KIND)) ? (localStorage.getItem(KIND) as Style) : null));
  const later = useLater();
  const [allDone, setAllDone] = useState(false);
  // Projects made on a dev build: shown or hidden (DevProjects.tsx).
  const [showDev, setShowDev] = useShowDev();
  const [sidebarOpen, setSidebarOpen] = useSidebarOpen();
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
  // An import running (or stopped) on this Mac isn't in the cloud's list until
  // it's in: listed from here meanwhile, so it shows in Importing at once (JJ,
  // Nov 2: "It's just confusing when you import and it doesn't get into the
  // importing while it's in progress").
  const cloudIds = new Set(scripts.map((one) => one.id));
  const pending: WriterScriptRow[] = [
    ...localScripts.filter((one) => !cloudIds.has(one.id) && (one.status === "processing" || one.status === "error" || one.status === "needs_choice" || one.firstBuild === true)),
    ...writing.filter((one) => !cloudIds.has(one.id) && !localScripts.some((local) => local.id === one.id)).map((one) => ({ id: one.id, title: one.title, createdAt: one.startedAt })),
  ].map((one): WriterScriptRow => ({
    id: one.id,
    title: one.title,
    rev: 0,
    updatedAt: ("createdAt" in one ? one.createdAt : undefined) ?? Date.now(),
    updatedBy: null,
    createdBy: "createdBy" in one ? (one.createdBy ?? null) : null,
    project: null,
    handoff: null,
    clips: 0,
    durationMs: 0,
    built: false,
    style: null,
    ...("compilation" in one && one.compilation !== undefined ? { compilation: one.compilation } : {}),
  }));
  const listedScripts = [...scripts, ...pending];
  const scriptOf = new Map(listedScripts.flatMap((one) => {
    const edit = editOf(one);
    return edit !== null ? [[edit, withKind(one)] as const] : [];
  }));
  const scriptOnly = listedScripts.filter((one) => editOf(one) === null);
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

  const all = projects ?? [];
  // Newest change first, local and cloud-only projects and scripts together.
  const projectRows: Listed[] = [
    ...all.filter((project) => !project.subtitles).map((project): Listed => ({ at: project.modified_ms, local: project, cloud: null, script: scriptOf.get(project.id) ?? null })),
    ...cloudOnly.filter((project) => project.summary?.subtitles !== true).map((project): Listed => ({ at: project.updated_ms, local: null, cloud: project, script: scriptOf.get(project.id) ?? null })),
    ...scriptOnly.filter((one) => !issues.some((issue) => issue.id === one.id && !writing.some((going) => going.id === one.id))).map((one): Listed => ({ at: one.updatedAt, local: null, cloud: null, script: withKind(one), importing: importingNow.get(one.id), writing: localScripts.some((local) => local.id === one.id && local.building === true), sharing: localScripts.some((local) => local.id === one.id && local.sharing !== undefined), here: localScripts.some((local) => local.id === one.id) })),
  ].sort((a, b) => b.at - a.at);
  const subtitledRows: Listed[] = [
    ...all.filter((project) => project.subtitles).map((project): Listed => ({ at: project.modified_ms, local: project, cloud: null, script: null })),
    ...cloudOnly.filter((project) => project.summary?.subtitles === true).map((project): Listed => ({ at: project.updated_ms, local: null, cloud: project, script: null })),
  ].sort((a, b) => b.at - a.at);
  // A project the signed-in person started in the last three days is first
  // in its list, under New (the user, Oct 30: "it's confusing to add a new
  // project and not have it right in front of you").
  const me = account?.person?.name.trim().toLowerCase() ?? null;
  const meSub = account?.person?.sub ?? "";
  const startedMs = (row: Listed): number => {
    const id = row.local?.id ?? row.cloud?.id ?? null;
    const at = id === null ? NaN : Number(/^p(\d{12,})-/u.exec(id)?.[1] ?? NaN);
    return Number.isFinite(at) ? at : (localScripts.find((one) => one.id === row.script?.id)?.createdAt ?? row.script?.updatedAt ?? 0);
  };
  const starter = (row: Listed) => (row.local !== null ? (remote.get(row.local.id)?.created_by ?? row.local.created_by) : row.cloud !== null ? row.cloud.created_by : row.script.createdBy);
  // Whose it is: the same sign-in, else (older records) the same name.
  const isMe = (by: { sub?: string; name: string } | null | undefined) => by != null && (meSub !== "" && by.sub ? by.sub === meSub : me !== null && by.name.trim().toLowerCase() === me);
  const justStarted = (row: Listed) => isMe(starter(row)) && Date.now() - startedMs(row) < NEW_FOR_MS;
  const fresh = (row: Listed) => justStarted(row) && stageOf(row, row.local === null && row.cloud === null ? undefined : statuses[row.local?.id ?? row.cloud?.id ?? ""]) !== "done";
  const cardProps = (project: ProjectSummary) => ({
    project,
    onChanged: refresh,
    cloudOn: Boolean(cloud?.on),
    status: cloud?.statuses?.[project.id],
    remote: remote.get(project.id),
    state: statuses[project.id],
  });

  // Everything Home lists, each where it is.
  const items: Item[] = [];
  for (const row of [...projectRows, ...subtitledRows]) {
    const subtitled = row.local?.subtitles === true || row.cloud?.summary?.subtitles === true;
    const id = row.local?.id ?? row.cloud?.id ?? null;
    if (row.local === null && row.cloud === null) {
      const script = row.script;
      items.push({
        id: `script-${script.id}`,
        key: laterKey("script", script.id),
        section: "scripts",
        stage: stageOf(row, undefined),
        at: row.at,
        title: script.title,
        mine: isMe(script.createdBy),
        fresh: fresh(row),
        kind: script.style,
        row: () => <ScriptTableRow script={script} importing={row.importing} writing={row.writing === true} sharing={row.sharing === true} here={row.here === true} onChanged={refresh} onImport={row.importing ? () => setWatching(script.id) : undefined} />,
      });
      continue;
    }
    const stage = stageOf(row, statuses[id!]);
    if (!showDev && row.local?.dev === true) continue;
    items.push({
      id: id!,
      key: laterKey("edit", id!),
      section: "edits",
      stage: stage === "done" ? "done" : subtitled ? "subtitled" : stage === "review" ? "review" : "editing",
      at: row.at,
      title: row.local?.name ?? row.cloud?.name ?? "",
      mine: isMe(starter(row)),
      fresh: fresh(row),
      kind: row.local?.style ?? row.cloud?.summary?.style ?? row.script?.style ?? null,
      row: () => (row.local !== null ? <TableRow {...cardProps(row.local)} subtitled={subtitled} script={row.script} /> : <CloudTableRow project={row.cloud!} script={row.script} onChanged={refresh} />),
    });
  }
  // Script imports that stopped: each waits on someone's answer, under Importing.
  for (const issue of issues.filter((one) => !writing.some((going) => going.id === one.id))) {
    items.push({ id: `issue-${issue.id}`, key: laterKey("script", issue.id), section: "scripts", stage: "importing", at: issue.createdAt ?? 0, title: issue.title, mine: isMe(issue.createdBy), row: () => <ScriptIssue issue={issue} onOpen={setWatching} /> });
  }
  if (ideasAllowed && ideasHome !== null) {
    for (const row of ideasHome.ideas) {
      items.push({ id: `idea-${row.id}`, key: laterKey("idea", row.id), section: "ideas", stage: ideaStage(row), at: row.updatedAt, title: row.summary.title, mine: isMe(row.createdBy), kind: row.workspace ?? "interrogation", row: () => <IdeaTableRow row={row} /> });
    }
    // A card waiting on changes with no idea yet is the ideas team's, on the board.
    for (const card of ideasHome.changes) {
      items.push({ id: `card-${card.id}`, key: laterKey("card", card.id), section: "ideas", stage: "board", at: Number.MAX_SAFE_INTEGER, title: card.name, mine: true, row: () => <CardTableRow card={card} onOpened={refreshIdeas} /> });
    }
  }

  // Set aside still (in Later), or back on its day and not opened yet (marked Back, first in its list).
  const entryOf = (item: Item) => (item.key === null ? undefined : later.entries.get(item.key));
  const aside = (item: Item) => {
    const entry = entryOf(item);
    return entry !== undefined && asleep(entry);
  };
  const backAt = (item: Item) => {
    const entry = entryOf(item);
    return entry !== undefined && entry.done !== true && !asleep(entry) ? entry.until! : null;
  };
  // Marked done by hand: in Done, wherever it was.
  const markedDone = (item: Item) => entryOf(item)?.done === true;
  const isIn = (item: Item, place: Where): boolean => {
    if (place === "later") return aside(item);
    if (aside(item)) return false;
    if (markedDone(item)) return place === "done";
    if (place === "done") return item.stage === "done";
    const { place: at, stage } = placeOf(place);
    return at !== null && placeOfSection(item.section) === at && (stage === null ? item.stage !== "done" : item.stage === stage);
  };
  const ours = items.filter((item) => (!mine || item.mine) && (kind === null || item.kind === kind));
  const countOf = (place: Where) => ours.filter((item) => isIn(item, place)).length;
  // The foot's Later: how many are set aside, and the next to come back.
  const setAside = ours.filter((item) => isIn(item, "later"));
  const nextBack = setAside
    .map((item) => ({ title: item.title, until: entryOf(item)?.until }))
    .filter((one): one is { title: string; until: number } => typeof one.until === "number")
    .sort((a, b) => a.until - b.until)[0];
  const laterSummary = { count: setAside.length, next: nextBack ?? null };
  // A search looks through everything, everyone's, wherever it is.
  const words = query.trim().toLowerCase();
  const searching = words !== "";
  const newest = (a: Item, b: Item) => b.at - a.at;
  let groups: { key: string; label: string | null; items: Item[] }[];
  if (searching) {
    const found = items.filter((item) => item.title.toLowerCase().includes(words)).sort(newest);
    const placeName = (item: Item) => (aside(item) ? "later" : item.stage === "done" || markedDone(item) ? "done" : placeOfSection(item.section));
    groups = [...PLACES.map((place) => place.key), "later", "done"].map((key) => ({ key, label: key === "later" ? "Later" : key === "done" ? "Done" : PLACES.find((one) => one.key === key)!.label, items: found.filter((item) => placeName(item) === key) })).filter((group) => group.items.length > 0);
  } else {
    const here = ours.filter((item) => isIn(item, shownWhere));
    const { place, stage } = placeOf(shownWhere);
    if (place !== null && stage === null) {
      // What you just started first, under New (the user, Oct 30: "it's confusing to add a new project and not have it right in front of you"), then by stage.
      const stages = PLACES.find((one) => one.key === place)!.stages;
      // And above that what's back from Later, the latest back on top: Needs you's one job left (Sphe, Nov 2: "let's remove needs you").
      const isBack = (item: Item) => backAt(item) !== null;
      const isFresh = (item: Item) => !isBack(item) && item.fresh === true && item.mine;
      groups = [
        { key: "back", label: "Back from Later", items: here.filter(isBack).sort((a, b) => backAt(b)! - backAt(a)!) },
        { key: "new", label: "New", items: here.filter(isFresh).sort(newest) },
        ...stages.map((one) => ({ key: one.key, label: one.label, items: here.filter((item) => !isBack(item) && !isFresh(item) && item.stage === one.key).sort(newest) })),
      ].filter((group) => group.items.length > 0);
    } else if (shownWhere === "later") {
      const until = (item: Item) => later.entries.get(item.key!)?.until ?? Number.MAX_SAFE_INTEGER;
      groups = [{ key: "later", label: null, items: here.sort((a, b) => until(a) - until(b)) }];
    } else if (shownWhere === "done") {
      // The latest done first: marked by hand when it was marked, else when it last changed.
      const doneAt = (item: Item) => (markedDone(item) ? entryOf(item)!.at : item.at);
      const sorted = here.sort((a, b) => doneAt(b) - doneAt(a));
      groups = [{ key: "done", label: null, items: allDone ? sorted : sorted.slice(0, DONE_SHOWN) }];
    } else {
      groups = [{ key: shownWhere, label: null, items: here.sort(newest) }];
    }
  }
  const listed = groups.reduce((total, group) => total + group.items.length, 0);
  const total = searching ? listed : countOf(shownWhere);
  const cross = searching || shownWhere === "later" || shownWhere === "done";
  const solo = mine && !searching;
  const title = searching ? { parent: null, name: "Search" } : nameOf(shownWhere);
  const inIdeas = !searching && placeOf(shownWhere).place === "ideas";
  const inThumbnails = !searching && shownWhere === "thumbnails";
  // The open place's stages, steps over its list (empty ones greyed, so the order still reads).
  const shownPlace = searching ? null : placeOf(shownWhere).place;
  const steps = shownPlace === null ? [] : PLACES.find((one) => one.key === shownPlace)!.stages.map((one) => ({ ...one, count: countOf(`${shownPlace}:${one.key}`) }));
  const nothingAtAll = projects !== null && items.length === 0 && !ideasAllowed;
  const loading = projects === null;
  const choose = (place: Where) => {
    localStorage.setItem(VIEW, place);
    setWhere(place);
    setQuery("");
    setAllDone(false);
    if (placeOf(place).place === "ideas") navigate("/ideas", true);
    else if (place === "thumbnails") navigate("/thumbnails", true);
    else if (window.location.pathname === "/ideas" || window.location.pathname === "/thumbnails") navigate("/", true);
  };
  const chooseMine = (value: boolean) => {
    localStorage.setItem(MINE, value ? "1" : "0");
    setMineOnly(value);
  };
  const chooseKind = (value: Style | null) => {
    if (value === null) localStorage.removeItem(KIND);
    else localStorage.setItem(KIND, value);
    setKind(value);
  };
  // The kinds in the list on screen (in Mine, yours), with how many of each: the filter's menu.
  const kinds = STYLES.map((one) => ({ ...one, count: items.filter((item) => item.kind === one.value && (!mine || item.mine) && isIn(item, shownWhere)).length })).filter((one) => one.count > 0 || one.value === kind);
  // Nothing in this list: why, and where to look.
  const others = items.filter((item) => !item.mine && (kind === null || item.kind === kind) && isIn(item, shownWhere)).length;
  const otherKinds = kind === null ? 0 : items.filter((item) => item.kind !== kind && (!mine || item.mine) && isIn(item, shownWhere)).length;
  const empty = searching
    ? { title: "Nothing matches", text: `Nothing anywhere is called “${query.trim()}”.` }
    : shownWhere === "later"
        ? { title: "Nothing set aside", text: "Press the clock on any row to set it aside until a day, or until you bring it back. On its day it’s back, at the top of its list." }
        : kind !== null && otherKinds > 0
          ? { title: `No ${STYLES.find((one) => one.value === kind)!.label.toLowerCase()} here`, text: `${otherKinds} of other kinds: the filter shows them all again.` }
          : mine && others > 0
          ? { title: "Nothing of yours here", text: `Everyone shows the team’s ${others}.` }
          : { title: "Nothing here", text: shownWhere === "done" ? "Approved edits and ideas move here by themselves, and anything marked done from its ⋯ menu." : "Nothing is at this stage now." };

  return (
    <LaterContext.Provider value={later}>
      <div className="flex h-full bg-black p-2">
        <HomeSidebar places={places} thumbnails={ideasAllowed} later={laterSummary} done={countOf("done")} where={searching ? ("" as Where) : shownWhere} onChoose={choose} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-panel">
          <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-5">
            {!sidebarOpen && <OpenSidebar onOpen={() => setSidebarOpen(true)} />}
            <h1 className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold tracking-[-0.01em] whitespace-nowrap">
              {title.parent !== null && (
                <>
                  <span className="font-medium text-muted">{title.parent}</span>
                  <span className="font-normal text-faint">/</span>
                </>
              )}
              <span className="truncate">{title.name}</span>
              {!loading && !inThumbnails && <span className="ml-1 text-[13px] font-normal text-faint tabular">{total}</span>}
            </h1>
            <div className="ml-auto flex items-center gap-1.5">
              <MemoryChip />
              <UpdateButton />
              {/* One main action a screen, in white (the user, Oct 30). */}
              {inIdeas ? (
                <Button variant="light" onClick={() => setIdeaOpen(true)}>
                  <Plus size={15} strokeWidth={2.2} /> New idea
                </Button>
              ) : inThumbnails ? (
                <Button variant="light" busy={thumbnail.making} onClick={thumbnail.make}>
                  <Plus size={15} strokeWidth={2.2} /> New thumbnail
                </Button>
              ) : mayCreate ? (
                <Button variant="light" onClick={() => setCreating(true)}>
                  <Plus size={15} strokeWidth={2.2} /> New project
                </Button>
              ) : null}
            </div>
          </header>
          <div className={cx("flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-3 pb-6")}>
            <SetupCard />
            {/* Thumbnails in the panel (Sphe, Nov 2: they "should sort of happen on that right hand side"), not a page of their own. */}
            {inThumbnails ? (
              <div className="-mx-4 -mt-3">
                <ThumbnailGrid making={thumbnail.making} onMake={thumbnail.make} />
              </div>
            ) : (
            <>
            <div className="mb-3 flex items-center gap-2">
              {/* Inset in black on the grey panel, as the chat's box is; an edge only in focus. */}
              <label className="flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-lg border border-transparent bg-black px-2.5 text-muted focus-within:border-line-strong">
                <Search size={14} className="shrink-0" />
                <input
                  value={query}
                  placeholder="Search everything by name…"
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => event.key === "Escape" && setQuery("")}
                  className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
                />
                {searching && (
                  <button onClick={() => setQuery("")} title="Clear" className="shrink-0 text-faint hover:text-fg">
                    <X size={13} />
                  </button>
                )}
              </label>
              <FilterButton
                who={account?.person != null ? (mineOnly ? "mine" : "everyone") : null}
                kind={kind}
                kinds={kinds}
                disabled={searching}
                onWho={(value) => chooseMine(value === "mine")}
                onKind={chooseKind}
              />
              <DevControl count={all.filter((project) => project.dev === true).length} show={showDev} onShow={setShowDev} onChanged={refresh} />
            </div>
            {steps.length > 0 && (
              <StageSteps place={shownPlace!} steps={steps} stage={placeOf(shownWhere).stage} onChoose={choose} />
            )}
            {cloud?.on && cloud.error && (
              <p className="mb-2 px-3 text-[12px] text-warning" title={cloud.error}>
                {cloud.offline ? "Can’t reach the cloud: showing what’s on this Mac." : "The cloud’s list didn’t load."}
              </p>
            )}
            {inIdeas && (ideasHome?.boardError ?? ideasError) && (
              <p className="mb-2 px-3 text-[12px] text-warning/80" title={ideasHome?.boardError ?? ideasError ?? ""}>
                {ideasHome === null ? `The ideas didn’t load: ${ideasError}` : "The board couldn’t be read just now: where cards are may be out of date."}
              </p>
            )}
            {loading || (inIdeas && ideasHome === null && ideasError === null) ? (
              <div className="mt-20 flex justify-center">
                <Loader size={32} />
              </div>
            ) : nothingAtAll ? (
              <FirstEdit cloudOn={Boolean(cloud?.on)} onNew={mayCreate ? () => setCreating(true) : null} />
            ) : listed > 0 ? (
              <>
                <HomeList groups={groups} solo={solo} cross={cross} lengthLabel={inIdeas ? "Views" : "Length"} />
                {!searching && shownWhere === "done" && !allDone && total > DONE_SHOWN && (
                  <Button variant="subtle" className="mt-3 self-start" onClick={() => setAllDone(true)}>
                    Show all {total}
                  </Button>
                )}
              </>
            ) : inIdeas && (ideasHome?.ideas.length ?? 0) === 0 && (ideasHome?.changes.length ?? 0) === 0 ? (
              <NoIdeas onNew={() => setIdeaOpen(true)} />
            ) : (
              <div className="mt-16 text-center">
                <div className="text-[14px] font-medium">{empty.title}</div>
                <p className="mt-1.5 text-[13px] text-muted">{empty.text}</p>
              </div>
            )}
            </>
            )}
          </div>
        </main>
      </div>
      <ImportDialog id={watching} writing={writing} issues={issues} onClose={() => setWatching(null)} />
      <NewProject open={creating} onClose={() => { setCreating(false); setStart(null); }} only={null} start={start} />
      {ideasAllowed && <NewIdea open={ideaOpen} onClose={() => setIdeaOpen(false)} onMade={refreshIdeas} />}
    </LaterContext.Provider>
  );
}

/**
 * Whose and which kind (Sphe, Nov 2: "probably would help if we turned this
 * into like a dropdown with filters like category"): one button saying what's
 * shown ("Mine", "Everyone · Bodycam"), its menu Mine or Everyone, then every
 * kind there is with how many. A search looks through everything, as before.
 */
function FilterButton({ who, kind, kinds, disabled, onWho, onKind }: { who: "mine" | "everyone" | null; kind: Style | null; kinds: { value: Style; label: string; count: number }[]; disabled: boolean; onWho: (value: "mine" | "everyone") => void; onKind: (value: Style | null) => void }) {
  const kindLabel = kinds.find((one) => one.value === kind)?.label ?? STYLES.find((one) => one.value === kind)?.label ?? null;
  const label = [who === "mine" ? "Mine" : who === "everyone" ? "Everyone" : null, kindLabel].filter(Boolean).join(" · ") || "All";
  const filtered = kind !== null;
  const open = (event: React.MouseEvent<HTMLButtonElement>) =>
    toggleMenu(
      event.currentTarget,
      [
        ...(who !== null
          ? ([
              { label: "Mine", hint: "what you started", checked: who === "mine", onSelect: () => onWho("mine") },
              { label: "Everyone", hint: "the team’s", checked: who === "everyone", onSelect: () => onWho("everyone") },
              { separator: true },
            ] satisfies MenuItem[])
          : []),
        { label: "Every kind", checked: kind === null, onSelect: () => onKind(null) },
        ...kinds.map((one): MenuItem => ({ label: one.label, detail: String(one.count), checked: kind === one.value, onSelect: () => onKind(one.value) })),
      ],
      { width: 220 },
    );
  return (
    <button
      type="button"
      onClick={open}
      disabled={disabled}
      title={disabled ? "A search looks through everything" : "Whose and which kind"}
      className={cx(
        "flex h-[34px] shrink-0 items-center gap-1.5 rounded-[9px] bg-black px-2.5 text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-45",
        filtered ? "text-fg" : "text-secondary hover:text-fg",
      )}
    >
      <ListFilter size={14} className={filtered ? "text-fg" : "text-muted"} />
      <span className="max-w-[180px] truncate">{label}</span>
      <ChevronDown size={13} className="text-faint" />
    </button>
  );
}

/**
 * A place's stages as steps over its list (prototype C, Nov 2): All, then each
 * stage in order with what's in it; an empty one greyed, not hidden, so the
 * order still reads. The open step again goes back to All.
 */
function StageSteps({ place, steps, stage, onChoose }: { place: Spot; steps: { key: string; label: string; count: number }[]; stage: string | null; onChoose: (where: Where) => void }) {
  const step = (key: string | null, label: string, count: number | null) => {
    const on = stage === key;
    const empty = count === 0 && !on;
    return (
      <button
        key={key ?? "all"}
        disabled={empty}
        onClick={() => onChoose(key === null || on ? place : `${place}:${key}`)}
        className={cx("flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium whitespace-nowrap transition-colors", on ? "bg-active text-fg" : empty ? "text-faint" : "text-muted hover:bg-hover hover:text-fg")}
      >
        {label}
        {count !== null && count > 0 && <span className={cx("tabular", on ? "text-secondary" : "text-faint")}>{count}</span>}
      </button>
    );
  };
  return (
    <div className="mb-3 flex shrink-0 flex-wrap items-center gap-0.5">
      {step(null, "All", null)}
      <span className="mx-1 h-4 w-px shrink-0 bg-line" />
      {steps.map((one, index) => (
        <Fragment key={one.key}>
          {/* The arrows go first when it's narrow (960 px: Subtitled ran off the panel). */}
          {index > 0 && <ChevronRight size={12} className="shrink-0 text-faint/60 max-[1100px]:hidden" />}
          {step(one.key, one.label, one.count)}
        </Fragment>
      ))}
    </div>
  );
}

/** Which place Home shows (remembered on this browser), from before too ("subtitled" and "ideas" were tabs). */
function savedWhere(): Where {
  const saved = localStorage.getItem(VIEW) ?? "";
  if (saved === "subtitled") return "edits:subtitled";
  // Needs you went on Nov 2 ("let's remove needs you"): Home opens on Edits.
  if (saved === "later" || saved === "done" || saved === "thumbnails") return saved;
  // Videos (Scripts and Edits together) for an evening on Nov 2: its stage says which it was.
  const [first, stage] = saved.split(":") as [string, string | undefined];
  const fromVideos: Spot = stage !== undefined && PLACES.find((one) => one.key === "scripts")!.stages.some((one) => one.key === stage) ? "scripts" : "edits";
  const place: Spot | null = first === "ideas" || first === "scripts" || first === "edits" ? first : first === "videos" ? fromVideos : null;
  if (place === null) return "edits";
  return stage !== undefined && PLACES.find((one) => one.key === place)!.stages.some((one) => one.key === stage) ? `${place}:${stage}` : place;
}

/** An empty Home: the way to the first edit. */
function FirstEdit({ cloudOn, onNew }: { cloudOn: boolean; onNew: (() => void) | null }) {
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="mt-[14vh] flex flex-col items-center text-center">
      <Tile size={64} />
      <h1 className="mt-6 text-[22px] font-semibold tracking-[-0.02em]">{onNew === null ? "Nothing here for your account yet" : "Make your first edit"}</h1>
      <p className="mt-2 max-w-[360px] text-muted">
        {onNew === null
          ? "An admin gives you the work you do at accounts.spheceo.com."
          : cloudOn
          ? "Projects are kept in the team’s cloud, so anyone can pick one up where you left off. Import footage, cut it, and let an agent build the polish."
          : "Projects live on this machine. Import footage, cut it, and let an agent build the polish."}
      </p>
      {onNew !== null && (
        <Button className="mt-6" variant="light" onClick={onNew}>
          <Plus size={15} strokeWidth={2.2} /> New project
        </Button>
      )}
    </motion.div>
  );
}

/**
 * Home's list: the column names, then each group (a stage, or a section in a
 * search) under its name, newest first. What came in since it was last shown
 * slides in, and a renamed row flashes once (state B laid over state A, not
 * the list built again).
 */
function HomeList({ groups, solo, cross, lengthLabel }: { groups: { key: string; label: string | null; items: Item[] }[]; solo: boolean; cross: boolean; lengthLabel: string }) {
  // As wide as the window lets it be: the columns a name can spare go first (Length, then Category).
  const table = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  useLayoutEffect(() => {
    const element = table.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const watch = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    watch.observe(element);
    return () => watch.disconnect();
  }, []);
  const layout = layoutFor(width, solo);
  const seen = useRef<Map<string, string> | null>(null);
  const [lately, setLately] = useState<{ added: Set<string>; renamed: Set<string> }>({ added: new Set(), renamed: new Set() });
  const rows = groups.flatMap((group) => group.items);
  const signature = rows.map((item) => `${item.id}=${item.title}`).join("\n");
  useEffect(() => {
    const now = new Map(rows.map((item) => [item.id, item.title]));
    const before = seen.current;
    seen.current = now;
    if (before === null) return;
    const added = new Set([...now.keys()].filter((id) => !before.has(id)));
    const renamed = new Set([...now.entries()].filter(([id, name]) => before.has(id) && before.get(id) !== name).map(([id]) => id));
    if (added.size === 0 && renamed.size === 0) return;
    setLately({ added, renamed });
    const timer = setTimeout(() => setLately({ added: new Set(), renamed: new Set() }), 1800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return (
    <TableShape.Provider value={{ cross }}>
      <div
        ref={table}
        role="table"
        aria-label="Projects"
        data-solo={solo || undefined}
        data-compact={layout.compact || undefined}
        data-slim={layout.slim || undefined}
        data-faces={layout.faces || undefined}
        className="group/table grid gap-x-4"
        style={{ gridTemplateColumns: layout.columns }}
      >
        <div role="row" className={cx(COLUMNS, "px-3 pb-2 text-[12px] font-medium text-muted")}>
          <span role="columnheader">Name</span>
          <span role="columnheader" className={CATEGORY}>
            Category
          </span>
          <span role="columnheader">Status</span>
          <span role="columnheader" className={BY}>
            By
          </span>
          <span role="columnheader" className={LENGTH}>
            {lengthLabel}
          </span>
          <span role="columnheader">Updated</span>
          <span role="columnheader" aria-label="Actions" />
        </div>
        {groups.map((group) => (
          <Fragment key={group.key}>
            {group.label !== null && (
              // The kit's section label: sentence case, 13/500, muted.
              <div className="col-span-full flex items-center gap-1.5 border-t border-line px-3 pt-5 pb-2 text-[13px] font-medium text-muted">
                {group.label} <span className="font-normal text-faint tabular">{group.items.length}</span>
              </div>
            )}
            {group.items.map((item) => (
              <div key={item.id} className={cx(COLUMNS, lately.added.has(item.id) && "row-new", lately.renamed.has(item.id) && "row-changed")}>
                {item.row()}
              </div>
            ))}
          </Fragment>
        ))}
      </div>
    </TableShape.Provider>
  );
}

/** New project opened with a title, its links and a kind (an approved idea's Write the script). */
export type NewProjectStart = { title: string; text: string; style: Style };

/** A row of Home's table: a project on this Mac, one only in the cloud, or a script with no edit yet; `script`: the script it's made from. */
export type Listed =
  | { at: number; local: ProjectSummary; cloud: null; script: WriterScriptRow | null }
  | { at: number; local: null; cloud: CloudProject; script: WriterScriptRow | null }
  | { at: number; local: null; cloud: null; script: WriterScriptRow; importing?: Importing; writing?: boolean; sharing?: boolean; here?: boolean };

/** A script's import while it isn't done: its word for it ("Importing 40%", "Stopped"). */
export type Importing = { word: string; stopped: boolean; percent?: number; step?: string };

/**
 * Where a project is on its way, script to finished video: Home lists them by
 * it (the user, Oct 30: "ready for scripting, these projects are ready for
 * editing, these projects are done editing … a natural progression of our
 * projects here instead of dumping the whole list").
 */
export type Stage = "toscript" | "scripting" | "ready" | "importing" | "editing" | "review" | "done";

export function stageOf(row: Listed, state: ProjectStatus | undefined): Stage {
  if (row.local === null && row.cloud === null) return row.importing ? "importing" : row.script.built ? "ready" : row.writing ? "scripting" : "toscript";
  if (state === undefined) return "editing";
  if (state.importing !== null) return "importing";
  if (state.approved !== null) return "done";
  if (state.feedback > 0 || (state.complete && state.exported)) return "review";
  return "editing";
}

/** Which place Home shows (remembered on this browser). */
export const VIEW = "edit.home.view";
/** The kind of video Home's lists are filtered to (remembered on this browser). */
const KIND = "edit.home.kind";
/** Mine or Everyone (remembered on this browser). */
const MINE = "edit.home.mine";

/** What each kind of video makes: the New project pills' tooltips. */
const STYLE_NOTES: Record<Style, string> = {
  bodycam: "16:9 · a narrated bodycam case or compilation, in the house voice",
  interrogation: "16:9 · an interrogation edit, narrated by your recording",
  courtroom: "16:9 · a courtroom edit, narrated by your recording",
  commentary: "16:9 · a narrated video essay with researched B-roll",
  horror: "16:9 · a narrated internet-mystery documentary in an analog horror look",
  shorts: "9:16 · a video’s highlights in 45–60 s, reframed on the subject, our subtitles, music",
};

export interface NoticeProps {
  tone: "warn" | "bad" | "info";
  text: string;
  title: string;
}

/** A small chip on a card saying what’s off: footage missing, footage still in the cloud. */
export function Notice({ tone, text, title }: NoticeProps) {
  const Icon = tone === "info" ? CloudDownload : TriangleAlert;
  return (
    <span
      title={title}
      className={cx(
        CHIP,
        tone === "info" ? "text-fg" : tone === "bad" ? "text-danger" : "text-warning",
      )}
    >
      <Icon size={12} />
      {text}
    </span>
  );
}

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

  // Its category (the kind of video its agent edits it as), among the styles this person edits; a Short's format is its own, so it stays one.
  const account = useAccount((state) => state.account);
  const allowed = editStyles(account);
  const styles = STYLES.filter((one) => one.value !== "shorts" && (allowed === null || allowed.has(one.value) || one.value === project.style));
  const recategorize = async (style: Style) => {
    if (style === project.style) return;
    try {
      const live = await api.project(project.id);
      await api.saveProject(project.id, live.rev, { ...live.project, style }, clientId);
      onChanged();
    } catch (error) {
      useEditor.getState().toastError(error, `change the category of “${project.name}”`);
    }
  };
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
      await askExportFolder();
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
  // Its ⋯ (and right click): Later's are added by the row.
  const items: MenuItem[] = [
    // Made from a script: that script, its other mode.
    ...(script !== null ? [{ label: "Open its script", icon: <FileText size={14} />, onSelect: () => navigate(`/scripts/${script}`) }] : []),
    { label: "Rename", icon: <Pencil size={14} />, onSelect: () => setRenaming(true) },
    ...(project.style !== "shorts" && !project.problem && styles.length > 1
      ? [{ label: "Category", icon: <Tag size={14} />, submenu: styles.map((one) => ({ label: one.label, checked: one.value === project.style, onSelect: () => void recategorize(one.value) })) }]
      : []),
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
    ...promoteItem(project, onChanged),
    { separator: true },
    { label: "Delete…", icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(true) },
  ];
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
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete “${project.name}”?`}
        detail={
          inCloud
            ? "It’s deleted from the cloud too, for everyone on the team. A copy is kept in this Mac’s Edit data folder; footage files stay where they are."
            : "The project and its edit are removed (a copy is kept in Edit’s data folder). Your footage files stay where they are."
        }
        confirm={inCloud ? "Delete everywhere" : "Delete project"}
        onConfirm={() => void remove()}
      />
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
  return { drive, missing, used, mostlyMissing, mostlyRemote, editor, cloudNews, status, notice, open, items, driveMenu, nameInput, dialogs };
}

export interface CardProps {
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
          {importStuck(state.importing) ? <TriangleAlert size={12} className="shrink-0" /> : <Pulse size={12} />}
          <span className="truncate">{importStuck(state.importing) ? "Import stuck" : `Importing ${importShare(state.importing)}`}</span>
        </span>
      ),
    state.working && (
        <span key="working" title="Its agent is working on it" className={cx(CHIP, "text-agent")}>
          <span className="size-1.5 animate-pulse rounded-full bg-agent" />
          Agent working
        </span>
      ),
    state.sharing !== null && (
        <span key="sharing" title={`Sharing: ${state.sharing}`} className={cx(CHIP, "max-w-[220px] text-info")}>
          <Share2 size={12} className="shrink-0" />
          <span className="min-w-0 truncate">{shareChip(state.sharing)}</span>
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

/** An import waiting on the person (a file it couldn't get) or failed. */
export const importStuck = (importing: NonNullable<ProjectStatus["importing"]>) => importing.state === "waiting" || importing.state === "failed";

/** How far an import is: its bytes while it downloads, then the step it's on. */
export function importShare(importing: NonNullable<ProjectStatus["importing"]>) {
  if (importing.state === "downloading") return importing.share !== null ? `${Math.round(importing.share * 100)}%` : `${importing.ready}/${importing.files}`;
  return { transcribing: "· hearing", placing: "· laying out", voicing: "· voicing" }[importing.state] ?? "";
}

/** A script being written from its videos (Script mode's import): what it's on and how far. */
/** `startedAt`: when the import began, as the server says. */
export type Writing = { id: string; title: string; stage: string; percent: number; detail: string; startedAt?: number };

/** When each import and each of its steps was first seen here, by script: kept while Home is open, so reopening its dialog doesn't start the clock again. */
const SEEN = new Map<string, Record<string, number>>();

/** A script import that stopped: what it asks (a decision) or why it failed. */
export type ScriptIssueRow = {
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
  /** Written over several videos. */
  compilation?: boolean;
  /** Its last Claude run ended without finishing: when, and what it said. */
  runFailed?: { at: number; error: string } | null;
  /** When it was started. */
  createdAt?: number;
  /** Being shared for review on this Mac (it runs on its own). */
  sharing?: { startedAt: number };
  /** Its script being written (a build running on this Mac). */
  building?: boolean;
  /** Stopped on a failure this build meets again however often it's retried (a 413): Retry isn't offered until an update. */
  retryHelps?: false;
};

/** What a stopped import that Retry can't help says instead of offering it. */
export const NEEDS_A_FIX = "Retrying stops here again: this needs a fix in Edit. Once Edit is updated, Retry carries on from what it kept.";

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
export function useIssueDialogs(issue: ScriptIssueRow) {
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
  const helps = issue.retryHelps !== false;
  const items: MenuItem[] = [
    { label: "View error", icon: <TriangleAlert size={14} />, onSelect: () => setOpen("error") },
    ...(helps ? [{ label: "Retry", icon: <RotateCw size={14} />, onSelect: retry }] : []),
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
          {!helps && <p className="mt-3 text-[13px] leading-relaxed text-muted">{NEEDS_A_FIX}</p>}
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
              <Button variant={helps ? "subtle" : "primary"} onClick={() => setOpen("replace")}>
                Replace…
              </Button>
              {helps && (
                <Button variant="primary" onClick={retry}>
                  Retry
                </Button>
              )}
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
      <ConfirmDialog
        open={open === "dismiss"}
        onClose={close}
        title={`Dismiss “${issue.title}”?`}
        detail="It comes off this list for everyone and stays stopped where it is. Its script keeps what was imported, and Retry there still carries it on."
        confirm="Dismiss"
        onConfirm={() => {
          close();
          void answerIssue(issue, { kind: "dismiss" });
        }}
      />
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
        <Button variant={issue.retryHelps === false ? "primary" : undefined} onClick={replace}>
          Replace…
        </Button>
      )}
      {/* A failure this build meets again isn't offered Retry: it would download it all again to stop in the same place (Nov 1, 13 retries of a 413). */}
      {issue.retryHelps !== false && (
        <Button variant="primary" onClick={retry}>
          Retry
        </Button>
      )}
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
  const { items: own, dialogs } = useIssueDialogs(issue);
  const aside = useAside(laterKey("script", issue.id), issue.title);
  const items = withAside(own, aside.items);
  return (
    <div
      role="row"
      onClick={() => {
        aside.seen();
        onOpen(issue.id);
      }}
      onContextMenu={contextMenu(items, 220)}
      className={cx(COLUMNS, ROW)}
    >
      <div role="cell" className="flex min-w-0 items-center gap-2.5">
        <KindMark kind="script" />
        {aside.woke && <BackMark entry={aside.woke} />}
        <TriangleAlert size={14} className="shrink-0 text-warning" />
        <span className={NAME} title={issue.title}>
          {issue.title}
        </span>
      </div>
      <Category text="" />
      <StatusCell>
        {aside.entry ? (
          <AsideStatus entry={aside.entry} />
        ) : (
          // Where it stopped, so it's plain what's being fixed.
          <span title={`Stopped ${stageWords(issue.stage)}: ${issue.decision?.summary ?? issue.error ?? "it stopped without saying why"}`} className={cx(CHIP, "text-warning")}>
            <TriangleAlert size={12} className="shrink-0" />
            <span className="truncate">Stopped · {stageName(issue.stage)}</span>
          </span>
        )}
      </StatusCell>
      <CreatorCell by={issue.createdBy} />
      <LengthCell />
      <Updated at={issue.createdAt ?? 0} />
      <RowButtons aside={aside.button} items={items} width={220} />
      {/* Its dialogs open over Home; clicks inside them aren't the row's. */}
      <div className="contents" onClick={(event) => event.stopPropagation()}>
        {dialogs}
      </div>
    </div>
  );
}

/** An import's stage as a chip's word ("Transcribing"). */
export function stageName(stage: string): string {
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
export function stageWords(stage: string): string {
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
export function ImportDialog({ id, writing, issues, onClose }: { id: string | null; writing: Writing[]; issues: ScriptIssueRow[]; onClose: () => void }) {
  const live = writing.find((one) => one.id === id) ?? null;
  // Stopped (and not running again): where it got to, why, and what can be done, here on Home.
  const stopped = live === null ? (issues.find((one) => one.id === id) ?? null) : null;
  const last = useRef<Writing | null>(null);
  if (live) last.current = live;
  const shown: Writing | null = live ?? (stopped ? { id: stopped.id, title: stopped.title, stage: stopped.stage, percent: stopped.progress ?? 0, detail: "" } : last.current);
  const [now, setNow] = useState(() => Date.now());
  const step = shown ? stepOf(shown) : "download";
  useEffect(() => {
    last.current = null;
  }, [id]);
  // The import's start as the server gives it, else when this page first saw it; each step's, when this page first saw it.
  const seen = shown ? (SEEN.get(shown.id) ?? {}) : {};
  if (shown) {
    seen.start = shown.startedAt ?? seen.start ?? Date.now();
    seen[step] ??= Date.now();
    SEEN.set(shown.id, seen);
  }
  const began = seen;
  useEffect(() => {
    if (id === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [id]);
  const done = id !== null && live === null && stopped === null && last.current !== null;
  const why = stopped ? (stopped.decision?.summary ?? stopped.error ?? "Stopped.") : null;
  const at = done ? STEPS.length : STEPS.findIndex((candidate) => candidate.key === step);
  const percent = done ? 100 : Math.floor(Math.max(0, Math.min(100, live ? creeping(live.id, live.percent, now) : (shown?.percent ?? 0))));
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
          <span className="mr-auto text-[12px] text-faint" title={stopped?.retryHelps === false ? NEEDS_A_FIX : undefined}>
            {began.start && !stopped && !done ? `Running for ${elapsed(now - began.start)}` : stopped?.retryHelps === false ? "Needs a fix in Edit before Retry." : ""}
          </span>
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

/** A project on this Mac: its name, what's worth a word about it, and its ⋯. */
function TableRow({ subtitled, script = null, ...props }: CardProps & { subtitled: boolean; script?: WriterScriptRow | null }) {
  const { project, onChanged, remote, state } = props;
  const card = useProject(project, onChanged, props.cloudOn, props.status, remote, script?.id ?? null);
  const aside = useAside(laterKey("edit", project.id), project.name);
  const items = withAside(card.items, aside.items);
  return (
    <>
      <div
        role="row"
        onClick={() => {
          aside.seen();
          card.open();
        }}
        onContextMenu={contextMenu(items, 190)}
        className={cx(COLUMNS, ROW)}
      >
        <div role="cell" className="flex min-w-0 items-center gap-2.5">
          <KindMark kind={project.subtitles ? "subtitles" : "edit"} />
          {aside.woke && <BackMark entry={aside.woke} />}
          {card.nameInput ?? (
            <span className={NAME} title={project.problem ?? project.name}>
              {project.name}
            </span>
          )}
          {project.dev === true && <DevBadge />}
        </div>
        <Category style={project.style} compilation={script?.compilation} />
        <StatusCell>
          {aside.entry ? (
            <AsideStatus entry={aside.entry} />
          ) : (
            <>
              {/* Where its files are when that's news, then its one status: what's wrong with it, else where it stands. */}
              <Place sync={card.cloudNews ? card.status : undefined} />
              {card.notice ? <Notice {...card.notice} /> : <StateChips state={state} projectId={project.id} onChanged={onChanged} editor={card.editor} />}
              {card.drive ? (
                <button onClick={card.driveMenu} title={`On Drive: ${card.drive.name}`} className={cx(CHIP, "text-success hover:bg-hover")}>
                  On Drive ↗
                </button>
              ) : (
                subtitled && <span className="shrink-0 text-[12px] text-faint">Not uploaded</span>
              )}
            </>
          )}
        </StatusCell>
        <CreatorCell by={remote?.created_by ?? project.created_by} projectId={project.id} />
        <LengthCell>{project.problem ? "" : shortDuration(project.duration_frames / project.fps)}</LengthCell>
        <Updated at={project.modified_ms} />
        <RowButtons aside={aside.button} items={items} width={190} />
      </div>
      {card.dialogs}
    </>
  );
}

/** A footage script's kinds as Home's Category names them. */
const KIND_LABEL: Record<Kind, string> = { interrogation: "Interrogation", foia: "Bodycam", courtroom: "Courtroom" };

/** The kind a script's Category stands for (as writer_handoff's styleOf, turned round); a commentary has none. */
const kindOfStyle = (style: Style | null): Kind | null => (style === "bodycam" ? "foia" : style === "interrogation" || style === "courtroom" ? style : null);

/** A script with no edit yet: opening it opens the script; once written, Start the edit makes its video project. */
function ScriptTableRow({ script, importing, writing, sharing, here, onChanged, onImport }: { script: WriterScriptRow; importing?: Importing; writing: boolean; sharing: boolean; here: boolean; onChanged: () => void; onImport?: () => void }) {
  const [starting, setStarting] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [why, setWhy] = useState(false);
  const failed = script.runFailed ?? null;
  // Its category, changed (JJ, Nov 5: a compilation started as Bodycam was Interrogation): the kinds this person writes, a commentary none.
  const grants = useGrants();
  const current = kindOfStyle(script.style);
  const kinds = script.compilation ? grants.compilationKinds : grants.singleKinds;
  const recategorize = async (kind: Kind) => {
    if (kind === current) return;
    try {
      const writer = await import("../writer/api");
      await writer.setScriptKind(script.id, kind);
      onChanged();
    } catch (error) {
      useEditor.getState().toastError(error, `change the category of “${script.title}”`);
    }
  };
  const categoryItem: MenuItem[] =
    current !== null && kinds.length > 1
      ? [{ label: "Category", icon: <Tag size={14} />, submenu: kinds.map((kind) => ({ label: KIND_LABEL[kind], checked: kind === current, onSelect: () => void recategorize(kind) })) }]
      : [];
  // Its ⋯ (and right click), as an edit's: open it, and (when this Mac has it) rename or delete it; Later's too.
  const aside = useAside(laterKey("script", script.id), script.title || "Untitled script");
  const items = withAside(
    [
      { label: "Open script", icon: <FileText size={14} />, onSelect: () => navigate(`/scripts/${script.id}`) },
      ...(failed !== null
        ? ([
            { label: "View error", icon: <TriangleAlert size={14} />, onSelect: () => setWhy(true) },
            { label: "Run again", icon: <RotateCw size={14} />, onSelect: () => void write() },
          ] satisfies MenuItem[])
        : []),
      ...(here
        ? ([
            { label: "Rename", icon: <Pencil size={14} />, onSelect: () => setRenaming(script.title) },
            ...categoryItem,
            { separator: true },
            { label: "Delete…", icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(true) },
          ] satisfies MenuItem[])
        : []),
    ],
    aside.items,
  );
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
    <div
      role="row"
      onMouseEnter={() => !onImport && prefetchScript(script.id)}
      onClick={() => {
        aside.seen();
        if (onImport) onImport();
        else navigate(`/scripts/${script.id}`);
      }}
      onContextMenu={contextMenu(items, 180)}
      className={cx(COLUMNS, ROW)}
    >
      <div role="cell" className="flex min-w-0 items-center gap-2.5">
        <KindMark kind="script" />
        {aside.woke && <BackMark entry={aside.woke} />}
        <span className={NAME} title={script.title}>
          {script.title || "Untitled script"}
        </span>
      </div>
      <Category style={script.style} compilation={script.compilation} />
      <StatusCell>
        {aside.entry ? (
          <AsideStatus entry={aside.entry} />
        ) : importing && !importing.stopped && importing.percent !== undefined ? (
          // Importing: how far (the step in its tooltip; its row opens the import).
          <span className={cx(CHIP, "w-32 text-info tabular")} title={importing.step}>
            <span className="h-1 min-w-10 flex-1 overflow-hidden rounded-full bg-line-strong">
              <span className="block h-full rounded-full bg-info transition-[width] duration-500" style={{ width: `${Math.round(Math.max(0, Math.min(100, importing.percent)))}%` }} />
            </span>
            {Math.floor(Math.max(0, Math.min(100, importing.percent)))}%
          </span>
        ) : importing ? (
          <span className={cx(CHIP, "tabular", importing.stopped ? "text-warning" : "text-info")}>
            {importing.stopped ? <TriangleAlert size={12} className="shrink-0" /> : <Pulse size={12} />}
            <span className="truncate">{importing.word}</span>
          </span>
        ) : writing ? (
          <span className={cx(CHIP, "text-info")}>
            <Pulse size={12} />
            Writing
          </span>
        ) : sharing ? (
          // Shared for review on its own, as an edit's share is (JJ, Nov 1): other scripts can be shared meanwhile.
          <span className={cx(CHIP, "text-info")} title="Its footage is going up to the review link">
            <Pulse size={12} />
            Sharing
          </span>
        ) : failed !== null ? (
          // Its last run failed: said in orange, and a click runs it again (what went wrong is in its tooltip and ⋯ View error).
          <button disabled={starting} title={`Claude's last run stopped: ${failed.error}\nClick to run it again.`} onClick={(event) => void write(event)} className={cx(CHIP, "cursor-pointer text-warning transition-colors hover:bg-hover disabled:opacity-60")}>
            <RotateCw size={12} />
            {starting ? "Starting…" : "Run failed"}
          </button>
        ) : (
          // Its next step: the pill's shape, filled, so it reads as the button it is (the user, Oct 30: "these are ctas").
          <button disabled={starting} onClick={(event) => void (script.built ? start(event) : write(event))} className={cx(PILL, "cursor-pointer border-transparent bg-fg font-semibold text-bg transition-colors hover:bg-white disabled:opacity-60")}>
            {script.built ? <Film size={12} /> : <PenLine size={12} />}
            {starting ? "Starting…" : script.built ? "Start edit" : "Write script"}
          </button>
        )}
      </StatusCell>
      <CreatorCell by={script.createdBy ?? undefined} />
      <LengthCell>{script.durationMs > 0 ? shortDuration(script.durationMs / 1000) : ""}</LengthCell>
      <Updated at={script.updatedAt} title={script.updatedBy ? `by ${script.updatedBy}` : undefined} />
      <RowButtons aside={aside.button} items={items} width={180} />
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
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete “${script.title}”?`}
        detail="The script, its transcript, preview and narration are deleted, for everyone on the team."
        confirm="Delete"
        onConfirm={() => void remove()}
      />
    </>
  );
}

/** A project only in the cloud: opening it downloads it to this Mac. */
function CloudTableRow({ project, script = null, onChanged }: { project: CloudProject; script?: WriterScriptRow | null; onChanged: () => void }) {
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
  const aside = useAside(laterKey("edit", project.id), project.name);
  const items = withAside(
    [
      ...(script !== null ? ([{ label: "Open its script", icon: <FileText size={14} />, onSelect: () => navigate(`/scripts/${script.id}`) }] satisfies MenuItem[]) : []),
      { separator: true },
      { label: "Delete…", icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(true) },
    ],
    aside.items,
  );
  return (
    <>
      <div
        role="row"
        onClick={() => {
          aside.seen();
          navigate(`/p/${project.id}`);
        }}
        onContextMenu={contextMenu(items, 180)}
        className={cx(COLUMNS, ROW)}
      >
        <div role="cell" className="flex min-w-0 items-center gap-2.5">
          <KindMark kind={summary.subtitles ? "subtitles" : "edit"} />
          {aside.woke && <BackMark entry={aside.woke} />}
          <span className={NAME} title={project.name}>
            {project.name}
          </span>
        </div>
        <Category style={summary.style} compilation={script?.compilation} />
        <StatusCell>
          {aside.entry ? (
            <AsideStatus entry={aside.entry} />
          ) : project.holder ? (
            <StateChips editor={project.holder} />
          ) : (
            <span title="Not on this Mac yet: opening it downloads it" className={cx(CHIP, "text-muted")}>
              <CloudDownload size={12} />
              Cloud only
            </span>
          )}
        </StatusCell>
        <CreatorCell by={project.created_by} projectId={project.id} />
        <LengthCell>{seconds !== null ? shortDuration(seconds) : ""}</LengthCell>
        <Updated at={project.updated_ms} title={`by ${project.updated_by}`} />
        <RowButtons aside={aside.button} items={items} width={180} />
      </div>
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete “${project.name}”?`}
        detail="It’s deleted from the cloud, for everyone on the team. It isn’t on this Mac, so no copy is kept here."
        confirm="Delete everywhere"
        onConfirm={() => void remove()}
      />
    </>
  );
}

/** A project out of step with the cloud, said in its status: a conflict, or changes not synced yet; nothing when it's in sync (most projects, so no mark). */
export function Place({ sync }: { sync?: CloudStatus }) {
  const trouble = sync?.sync === "conflict" ? ([CloudAlert, "Conflict", sync.message ?? "A conflict: this Mac’s changes were kept as a copy."] as const) : sync?.dirty || sync?.sync === "offline" ? ([CloudOff, "Not synced", "Changes saved on this Mac haven’t reached the cloud yet."] as const) : null;
  if (trouble === null) return null;
  const [Icon, text, title] = trouble;
  return (
    <span title={title} className={cx(CHIP, "text-warning")}>
      <Icon size={12} />
      {text}
    </span>
  );
}

/** "Move to cloud": a project from before cloud, uploaded so teammates can open it. Its footage isn’t moved. */
export function MoveToCloud({ project, open, onClose, onMoved }: { project: ProjectSummary; open: boolean; onClose: () => void; onMoved: () => void }) {
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
type Source = { url: string; title: string; durationMs: number | null; reuse: boolean; earlier?: string; problem: string | null; warning?: string | null; again?: boolean };

/**
 * New project: a title, then what it's made from, then the kind and a first
 * word to its agent. Writing a script takes the footage (a Trello card opens
 * into its videos) and any reused cases, ticked when they're recognised; an
 * edit takes its script's Doc, and videos only as reuses (footage to cut goes
 * through a script). The import runs on Home, then the script workflow or the
 * edit workflow starts by itself (the user, Oct 30).
 */
export function NewProject({ open, onClose, only = null, start = null }: { open: boolean; onClose: () => void; only?: Style | null; start?: NewProjectStart | null }) {
  const account = useAccount((state) => state.account);
  const allowed = editStyles(account);
  const writes = writesScripts(account);
  // Edit from a script: only for someone who makes full edits (a style of theirs).
  const edits = allowed === null || allowed.size > 0;
  const grants = useGrants();
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
  // Only the kinds this person may write or edit, as the server allows them.
  const writable = (style: Style): boolean => {
    if (style === "commentary") return grants.has(CAN.commentary);
    const kind = WRITER_KIND[style];
    return kind !== undefined && (grants.singleKinds.includes(kind) || grants.compilationKinds.includes(kind));
  };
  const styles = STYLES.filter((option) => (writing ? writable(option.value) : allowed === null || allowed.has(option.value)));
  const kind = styles.some((option) => option.value === style) ? style : (styles[0]?.value ?? "bodycam");
  const commentary = writing && kind === "commentary";

  // A fresh dialog each time.
  useEffect(() => {
    if (!open) return;
    setTitle(start?.title ?? "");
    setText(start?.text ?? "");
    setPrompt("");
    setSources(null);
    setPreview(null);
    setError(null);
    setPicked(start !== null);
    setMode(writes ? "write" : "edit");
    if (start !== null) setStyle(start.style);
    else if (only !== null) setStyle(only);
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
        // A link YouTube didn't answer for (slow, or a sign-in asked) is checked once more on its own, behind the rest: Create
        // doesn't wait on it, and only if it fails again does its row say so (Nov 6, Marius: four of six links showed only their URL).
        const again = new Set(checked.filter((one) => one.title === "" && one.problem === null && one.warning !== null && /youtu/.test(one.url)).map((one) => one.url));
        if (!alive) return;
        setError(null);
        setSources(checked.map((one) => ({ url: one.url, title: one.title, durationMs: one.durationMs, reuse: one.reuse, ...(one.earlier ? { earlier: one.earlier } : {}), problem: one.problem, warning: one.warning, again: again.has(one.url) })));
        setReading(false);
        for (const url of again) {
          const [found] = await writer.checkVideos([url]).catch(() => []);
          if (!alive) return;
          setSources((all) => (all ?? []).map((one) => (one.url !== url ? one : found ? { ...one, title: found.title, durationMs: found.durationMs, problem: found.problem, warning: found.warning, again: false } : { ...one, again: false })));
        }
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
        // The server answers once the script exists, or refuses (a bad link, no access, three imports running);
        // the import then runs on Home. It used to answer only when the whole import ended, so this guessed with a
        // 1.5 s timer and a busy Mac's refusal after it was lost (JJ, Nov 1: a compilation started twice, no row and
        // no error). A refusal now stays in this dialog.
        await work;
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
      try {
        await api.attachScript(project.id, input);
      } catch (refused) {
        // A script refused leaves no empty project behind (each try had made one more).
        await api.deleteProject(project.id).catch(() => undefined);
        throw refused;
      }
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

        {writes && edits && (
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
                : NARRATION[kind] === "recording"
                  ? "Paste the script’s Google Doc, or all its text (copied from the Doc, links and all), and “Voice-over:” with the recording’s Drive link."
                  : "Paste the script’s Google Doc, or all its text (copied from the Doc, links and all). A finished video added under it goes in whole, as a reuse."
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
                      {(reading || one.again) && one.title === "" && one.problem === null && <span className="shimmer block text-faint">Checking…</span>}
                      {one.problem !== null && <span className="block truncate text-danger">{one.problem}</span>}
                      {one.problem === null && !one.again && one.warning && <span className="block truncate text-faint" title={one.warning}>{one.warning}</span>}
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
