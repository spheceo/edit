import type { Adding, Brief, BuildStatus, ChatTurn, DocComment, DocFile, Check, Choice, ClaudeStatus, Draft, Feedback, Finds, Focus, LearnStep, Lesson, Pacing, Kind, Research, ReviewApproval, ReviewBlock, ReviewCounts, ReviewNote, ImportProgress, Role, Script, Settings, Snapshot, StorageCleared, StorageReport, Summary, TrelloCards, TrelloList, Version, VideoCheck, Footage, TrelloCard } from "./types";

/** Writer's own replies are JSON. Anything else came from in between (Vite
 * while the app restarts, a dropped tailnet hop), and says so plainly. A
 * connection that drops outright still rejects with fetch's TypeError, which
 * callers treat as "still running on the Mac". */
async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(
      `Writer didn't answer (${response.status}). It may be restarting; try again in a moment.`,
    );
  }
  if (!response.ok) {
    const said = (body as { error?: string } | undefined)?.error;
    throw new Error(said || `Writer didn't answer (${response.status}). Try again in a moment.`);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const listScripts = () =>
  http<Summary[]>("/api/writer/scripts");

export const getScript = (id: string) =>
  http<Script>(`/api/writer/scripts/${id}`);

/** The footage, and an optional article about the case, read in place of research, as Repack takes it. */
/** A title given is kept in place of the file's name. */
export const importFile = (path: string, article?: string, title?: string, kind?: Kind) =>
  http<Script>("/api/writer/scripts/file", json({ path, article, title, kind }));

/** A title given is kept in place of the video's own. */
export const importYoutube = (url: string, article?: string, title?: string, kind?: Kind) =>
  http<Script>("/api/writer/scripts/youtube", json({ url, article, title, kind }));

/** A title given (typed, or a Trello card's) is kept in place of the folder's name. */
export const importDrive = (url: string, article?: string, title?: string, kind?: Kind) =>
  http<Script>("/api/writer/scripts/drive", json({ url, article, title, kind }));

/** The cards waiting on one of Repack's Trello lists, read through Writer's service. */
/** The card a pasted Trello link names, read for its videos (any board Repack's Trello reads). */
export const trelloCard = (link: string) =>
  http<TrelloCard>("/api/writer/trello/card", json({ link }));
export const trelloCards = (list: TrelloList) =>
  http<TrelloCards>(`/api/writer/trello/${list}`);

export const renameScript = (id: string, title: string) =>
  http<Script>(`/api/writer/scripts/${id}/title`, { ...json({ title }), method: "PUT" });

export const resumeImport = (id: string, choice: Choice) =>
  http<Script>(`/api/writer/scripts/${id}/resume`, json(choice));

export const doctor = () => (http<Check[]>("/api/doctor"));

export const checkDrive = () =>
  http<string>("/api/writer/drive/check", { method: "POST" });

export const retryTranscribe = (id: string) =>
  http<Script>(`/api/writer/scripts/${id}/transcribe`, { method: "POST" });

export const completeTranscription = (id: string) =>
  http<BuildStatus>(`/api/writer/scripts/${id}/complete-transcription`, { method: "POST" });

export const saveClips = (id: string, revision: number, clips: Script["clips"]) =>
  http<Script>(`/api/writer/scripts/${id}/clips`, { ...json({ revision, clips }), method: "PUT" });

export const deleteScript = (id: string) =>
  http<void>(`/api/writer/scripts/${id}`, { method: "DELETE" });

export const getSettings = () =>
  http<Settings>("/api/settings");

export const saveSettings = (settings: Settings) =>
  http<Settings>("/api/settings", { ...json(settings), method: "PUT" });

export const checkRelay = () =>
  http<RelayHealth>("/api/relay/check", { method: "POST" });

type RelayHealth = { ok: boolean; transcription: boolean; drive: boolean; proxy: boolean; message: string };

export const claudeStatus = () =>
  http<ClaudeStatus>("/api/writer/claude");

export const startBuild = (id: string, note: string, kind?: Kind) =>
  http<BuildStatus>(`/api/writer/scripts/${id}/build`, json({ note, kind }));

/** Opus revises a built script with targeted edits; followed as a build is. */
export const startRevision = (id: string, request: string, focus: Focus) =>
  http<BuildStatus>(`/api/writer/scripts/${id}/revise`, json({ request, focus }));

/** Brings a compilation's reused cases' videos into its footage for intro clips (all not yet in, by default); followed as a build is. */
export const importReuses = (id: string, urls: string[] = []) =>
  http<BuildStatus>(`/api/writer/scripts/${id}/reuses`, json({ urls }));

/** Searches YouTube for the clips a commentary brief needs; followed as a build is. */
export const findClips = (id: string) =>
  http<BuildStatus>(`/api/writer/scripts/${id}/finds`, json({}));

export const getFinds = (id: string) =>
  http<Finds | null>(`/api/writer/scripts/${id}/finds`);

/** Starts the feedback over from the notes on the script's review page. */
export const pullFeedback = (id: string) =>
  http<Feedback>(`/api/writer/scripts/${id}/feedback`, json({}));

/** What a note from Writer says beyond its text: the words it's on, its intent, a suggestion's new words. */
export type NoteDetails = { anchor?: { kind: "text"; blockId: string; start: number; end: number; quote: string }; intent?: string; replacement?: string };

export const resolveProposals = (id: string, revision: number, proposals: string[], accept: boolean) =>
  http<Script>(`/api/writer/scripts/${id}/proposals`, json({ revision, proposals, accept }));

export const retrySpeakers = (id: string) =>
  http<BuildStatus>(`/api/writer/scripts/${id}/speakers/retry`, json({}));

export const stopJob = (id: string) =>
  http<void>(`/api/writer/scripts/${id}/build/stop`, json({}));

/** Leaves a note on the script's review page from Writer: the same note a reviewer leaves there. */
export const addReviewNote = (id: string, text: string, details?: NoteDetails) =>
  http<void>(`/api/writer/scripts/${id}/review/notes`, json({ text, details }));

/** A reply under a note on the review page, signed with the signed-in person's name. */
export const replyReviewNote = (id: string, noteId: string, text: string) =>
  http<void>(`/api/writer/scripts/${id}/review/notes/${noteId}/replies`, json({ text }));

/** A person's word on a fix: confirmed, or sent back with what still isn't right (added as a reply). */
export const checkReviewNote = (id: string, noteId: string, verdict: "confirmed" | "notFixed", text?: string) =>
  http<void>(`/api/writer/scripts/${id}/review/notes/${noteId}/check`, json({ verdict, text }));

/** How Ready for changes is going on the script's review (the page's `fix`), and whether the fixing computer is on. */
export type ReviewFix = {
  state: "waiting" | "fixing" | "sharing" | "done" | "failed";
  by: string;
  requestedAt: number;
  version: number;
  stage: string | null;
  done: number | null;
  total: number | null;
  newVersion: number | null;
  error: string | null;
  stale: boolean;
  updatedAt: number;
};
/** What a reviewer would flag that a count can find (commentary::audit, claude::team_flags), shown before sharing. */
export const scriptAudit = (id: string) =>
  http<{ flags: string[] }>(`/api/writer/scripts/${id}/audit`);

export const reviewFix = (id: string) =>
  http<{ fix: ReviewFix | null; computer: "on" | "off" | "none" | null }>(`/api/writer/scripts/${id}/review/fix`);

/** Deletes a note left from Writer (never a reviewer's), with its replies. */
export const deleteReviewNote = (id: string, noteId: string) =>
  http<void>(`/api/writer/scripts/${id}/review/notes/${noteId}`, { method: "DELETE" });

export const getFeedback = (id: string) =>
  http<Feedback | null>(`/api/writer/scripts/${id}/feedback`);

export const setFeedbackItem = (id: string, item: string, change: { skip?: boolean; note?: string }) =>
  http<Feedback>(`/api/writer/scripts/${id}/feedback/items/${item}`, { ...json(change), method: "PUT" });

/** Saves the lesson, and says what in it still points at the script. */
export const setLesson = (id: string, lesson: string) =>
  http<{ feedback: Feedback; leaks: string[] }>(`/api/writer/scripts/${id}/feedback/lesson`, { ...json({ lesson }), method: "PUT" });

export const startLearning = (id: string, step: LearnStep) =>
  http<BuildStatus>(`/api/writer/scripts/${id}/feedback/steps`, json(step));

export const keepLesson = (id: string) =>
  http<Lesson[]>(`/api/writer/scripts/${id}/feedback/keep`, json({}));

export const getLessons = () => (http<Lesson[]>("/api/writer/lessons"));

export const forgetLesson = (lesson: string) =>
  http<Lesson[]>(`/api/writer/lessons/${lesson}`, { method: "DELETE" });

/** The frames the clip search looked at for one clip. */
export const framesUrl = (id: string, frames: string) =>
  `/api/writer/scripts/${id}/finds/frames/${frames.split("/").pop()}`;

/** The script's conversation with the editor. */
/** The producer's answer to Claude asking to start over: accepted, the built script goes (the transcript and research stay). */
export const resetScript = (id: string, accept: boolean) =>
  http<Script>(`/api/writer/scripts/${id}/reset`, json({ accept }));

export const getChat = (id: string) =>
  http<ChatTurn[]>(`/api/writer/scripts/${id}/chat`);

/** Starts the conversation again; the script's edits stay. */
export const clearChat = (id: string) =>
  http<void>(`/api/writer/scripts/${id}/chat`, { method: "DELETE" });

/** Declines a proposed rewrite; the saved narration stays. */
export const declineProposal = (id: string, proposal: string) =>
  http<Script>(`/api/writer/scripts/${id}/proposals/${proposal}`, { method: "DELETE" });

/** Respells a transcript word; an empty text puts it back. */
export const correctWord = (id: string, revision: number, word: string, text: string) =>
  http<Script>(`/api/writer/scripts/${id}/corrections`, { ...json({ revision, word, text }), method: "PUT" });

/** The producer's own heading; an empty one puts the generated heading back. */
export const setHeading = (id: string, revision: number, heading: string) =>
  http<Script>(`/api/writer/scripts/${id}/heading`, { ...json({ revision, heading }), method: "PUT" });

/** The script's versions, oldest first. */
export const listVersions = (id: string) =>
  http<Version[]>(`/api/writer/scripts/${id}/versions`);

export const getVersion = (id: string, version: string) =>
  http<Snapshot>(`/api/writer/scripts/${id}/versions/${version}`);

/** Makes an earlier version the script again. */
export const restoreVersion = (id: string, revision: number, version: string) =>
  http<Script>(`/api/writer/scripts/${id}/versions/${version}/restore`, json({ revision }));

export const getResearch = (id: string) =>
  http<Research | null>(`/api/writer/scripts/${id}/research`);

/** Looks for the news about the case again, replacing what was found. */
export const researchAgain = (id: string) =>
  http<Research>(`/api/writer/scripts/${id}/research`, { method: "POST" });

/** Videos joined in order: a compilation, one case each, or (`kase`) one Courtroom case across them. */
export const importCompilation = (title: string, urls: string[], kase = false, kind?: Kind) =>
  http<Script>("/api/writer/scripts/compilation", json({ title, urls, case: kase, kind }));

/** A pasted brief read into its title, notes and labelled links, before anything imports. */
export const readBrief = (text: string) => (http<Brief>("/api/writer/briefs/read", json({ text })));

/** A brief imported as one case: one video as itself, several as one Courtroom case, each keeping its label. */
export const importBrief = (text: string, kind?: Kind) =>
  http<Script>("/api/writer/scripts/brief", json({ text, kind }));

/** A compilation's lines checked before anything downloads, as Repack checks its videos. */
export const checkVideos = (lines: string[]) =>
  http<VideoCheck[]>("/api/writer/videos/check", json({ lines }));

export const buildStatus = (id: string) =>
  http<BuildStatus | null>(`/api/writer/scripts/${id}/build`);

/** A commentary project, its links read in as sources (the first is the brief). */
export const createCommentary = (title: string, links: string[]) =>
  http<Script>("/api/writer/scripts/commentary", json({ title, links }));

export const addSource = (id: string, adding: Adding, role: Role) =>
  http<Script>(`/api/writer/scripts/${id}/sources`, json({ adding, role }));

export const setPacing = (id: string, pacing: Pacing) =>
  http<Script>(`/api/writer/scripts/${id}/pacing`, { ...json({ pacing }), method: "PUT" });

export const updateSource = (id: string, source: string, change: { role?: Role; title?: string }) =>
  http<Script>(`/api/writer/scripts/${id}/sources/${source}`, { ...json(change), method: "PUT" });

export const removeSource = (id: string, source: string) =>
  http<Script>(`/api/writer/scripts/${id}/sources/${source}`, { method: "DELETE" });

export const sourceText = (id: string, source: string) =>
  http<string>(`/api/writer/scripts/${id}/sources/${source}`);

export const saveDraft = (id: string, revision: number, draft: Draft) =>
  http<Script>(`/api/writer/scripts/${id}/draft`, { ...json({ revision, draft }), method: "PUT" });

/** A new Google Doc from the script (a Word file in base64), as Repack exports. */
export const exportDoc = (id: string, draft: boolean, docx: string) =>
  http<DocFile>(`/api/writer/scripts/${id}/docs`, json({ draft, docx }));

/** Every Doc exported from the script, read from Drive each time. */
export const listDocs = (id: string) =>
  http<DocFile[]>(`/api/writer/scripts/${id}/docs`);

/** The comments on the script's latest Doc, or on the one named. */
export const docComments = (id: string, doc?: string) =>
  http<{ doc: string; comments: DocComment[] }>(doc ? `/api/writer/scripts/${id}/docs/${doc}/comments` : `/api/writer/scripts/${id}/docs/comments`);

/** Every import running now. */
export const getProgress = () =>
  http<ImportProgress[]>("/api/writer/progress");

export function message(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

export type CloudStatus = {
  enabled: boolean;
  state: "off" | "syncing" | "synced" | "offline" | "error" | "";
  pending: number;
  transfer: { script: string; name: string; up: boolean; done: number; total: number } | null;
  lastSync: number | null;
  error: string | null;
  scripts: number;
};

/** Where syncing to the cloud has got to. */
export const cloudStatus = () => (http<CloudStatus>("/api/writer/cloud"));

/** What Writer holds on this Mac, and how much the cloud holds too. */
export const storageReport = () =>
  http<StorageReport>("/api/writer/storage");

/** Clears local footage verified in the cloud; still-uploading footage stays. */
export const clearStorage = () =>
  http<StorageCleared>("/api/writer/storage/clear", { method: "POST" });

/**
 * Where a script's preview plays from: the file on this Mac when it's here,
 * otherwise the cloud's copy a range at a time (stream.rs), as Repack plays
 * its footage. `v` changes the address when the footage does.
 */
export const previewSrc = (id: string, v: number | string) =>
  `/api/writer/scripts/${id}/proxy?v=${v}`;

/** A cleared preview back from the cloud, so the script plays here again. */
export const restorePreview = (id: string) =>
  http<Script>(`/api/writer/scripts/${id}/preview`, { method: "POST" });

/** Shares the script on a Repack review link, or its next version on the same link. */
/** The script as it is now made its review's only version, v1, on the same link. */
export const compressReview = (id: string) =>
  http<Script>(`/api/writer/scripts/${id}/review/compress`, json({}));
export const shareScript = (id: string) =>
  http<Script>(`/api/writer/scripts/${id}/share`, json({}));

/** Open review notes per script, for the cards' badges, and whether Claude fixes new ones by itself. */
export const reviewCounts = () =>
  http<ReviewCounts>("/api/writer/reviews");

/** A script's review notes, and its blocks as they now read. */
export type ReviewState = { notes: ReviewNote[]; blocks: ReviewBlock[]; approved: ReviewApproval | null };

export const reviewNotes = (id: string) =>
  http<ReviewState>(`/api/writer/scripts/${id}/review`);

/** Approves the latest shared version (Repack deletes the other versions' files; the notes stay), or takes the approval back. */
export const approveReview = (id: string, approve: boolean) =>
  http<ReviewState>(`/api/writer/scripts/${id}/review/approval`, { ...json({ approve }), method: "PUT" });

/** Has Claude fix the script's open notes now; followed as a build. */
export const fixNotes = (id: string) =>
  http<BuildStatus>(`/api/writer/scripts/${id}/review/fix`, json({}));

export const setEngine = (engine: "cli" | "sdk") =>
  http<Settings>("/api/settings/engine", { ...json({ engine }), method: "PUT" });

/** Calls `then` whenever review notes change (in the app; the dev page asks every half minute). */
/** Scripts came, went or changed behind the page's back (the cloud, the local
 * API): Writer says so; a page in a browser asks every few seconds. */
export function onLibrary(then: () => void): () => void {
  let seen: number | null = null;
  const timer = window.setInterval(() => {
    if (document.hidden) return;
    void http<{ version: number }>("/api/writer/library")
      .then(({ version }) => {
        if (seen !== null && version !== seen) then();
        seen = version;
      })
      .catch(() => {});
  }, 3_000);
  return () => window.clearInterval(timer);
}

export function onReviews(then: () => void): () => void {
  const timer = window.setInterval(then, 30_000);
  return () => window.clearInterval(timer);
}


/** Brings an archived script's footage back from its links (or Edit's originals); followed as a build. */
export const restoreScript = (id: string) =>
  http<BuildStatus>(`/api/writer/scripts/${id}/restore`, json({}));

/** A line of Writer's log. */
export type LogLine = { at: number; time: string; level: "INFO" | "WARN" | "ERROR"; area: string; message: string };

/** The log's lines after `since` (ms), and where its file is. */
export const getLogs = (since: number) =>
  http<{ lines: LogLine[]; file: string | null }>(`/api/logs?since=${since}`);

/** Shows the log file in Finder. */
export const revealLogs = () => (http<void>("/api/logs/reveal", json({})));

/** Something long under way: what, on what, the step and how far. */
export type Activity = { key: string; script: string | null; what: string; title: string; step: string; done: number; total: number; unit: "count" | "bytes" | "percent"; started: number };

export const getActivity = () => (http<Activity[]>("/api/writer/activity"));

/** Which Writer this is: "Writer nightly-1", "Writer v0.0.0", or a dev build. */
export type About = { name: string; version: string; tag: string | null; release: boolean };
export const getAbout = () => (http<About>("/api/about"));

/** Who's signed in (account.rs), at accounts.spheceo.com. */
export type Person = { sub: string; email: string; name: string; image: string | null; perms: string[]; admin: boolean };
export type AccountStatus = {
  signedIn: boolean;
  person: Person | null;
  signingIn: boolean;
  /** While signing in: the page to open, if the browser didn't. */
  signInUrl: string | null;
  /** Signing in with a code on another device: what to type, and where. */
  code: { userCode: string; url: string; urlComplete: string | null } | null;
  error: string | null;
};
/** A script starter's photo, kept on this Mac: a src for <img>, or null (show initials). */
export const avatarSrc = async (_sub: string, picture: string): Promise<string | null> => `/api/avatar?url=${encodeURIComponent(picture)}`;
export const accountStatus = () => (http<AccountStatus>("/api/account"));
export const signIn = () => (http<AccountStatus>("/api/account/sign-in", json({})));
export const signInWithCode = () => (http<AccountStatus>("/api/account/sign-in-code", json({})));
/** Opens one of Writer's own pages (accounts.spheceo.com, Writer's issues) in the browser. */
export const openPage = (url: string) => (http<void>("/api/open", json({ url })));
export const cancelSignIn = () => (http<AccountStatus>("/api/account/cancel", json({})));
export const signOut = () => (http<AccountStatus>("/api/account/sign-out", json({})));

/** Self-update (update.rs): this build, the channel, and the build on offer. */
export type UpdateStatus = {
  name: string;
  channel: "nightly" | "stable";
  enabled: boolean;
  offer: { tag: string; size: number } | null;
  phase: "idle" | "downloading" | "installing" | "restarting";
  error: string | null;
  checkedAt: number | null;
  /** Why the last look for updates failed, until one works. */
  checkError: string | null;
};
export const updateStatus = () => (http<UpdateStatus>("/api/update"));
export const checkUpdate = () => (http<UpdateStatus>("/api/update/check", json({})));
export const installUpdate = () => (http<void>("/api/update/install", json({})));
export const setUpdateChannel = (channel: "nightly" | "stable") =>
  http<UpdateStatus>("/api/update/channel", { ...json({ channel }), method: "PUT" });

/** A commentary's downloaded footage; asking starts what's missing (footage.rs). */
export const getFootage = (id: string) => (http<Footage>(`/api/writer/scripts/${id}/footage`));

/** Where a downloaded stretch of a commentary's footage plays from. */
export const footageUrl = (id: string, file: string) => `/api/writer/scripts/${id}/footage/${encodeURIComponent(file)}`;

/** Whether downloads can fall back on the person's YouTube sign-in (a cookies file, read silently). */
export const youtubeSignIn = () =>
  http<{ saved: boolean; savedAt: number | null }>("/api/youtube/sign-in");
/** Copies the YouTube sign-in from the browser into that file, once (Chrome asks macOS for its key this one time). */
export const saveYoutubeSignIn = () => (http<{ browser: string }>("/api/youtube/sign-in", json({})).then((answer) => answer.browser));
