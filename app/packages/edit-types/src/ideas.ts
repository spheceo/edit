// Ideas (Oct 31 2026): a case repackaged into titles and a thumbnail guide,
// then sent to the Interrogation board, as Sphe Research and Repack's threads
// did it. The team's, so it lives in mamagi (`ideas` module) whole: the
// server keeps nothing of it on the Mac. One shape for the server and the UI.

/**
 * The kinds of idea, each with its own craft (agent/ideas/<workspace>.md), board
 * and capability (`ideas.<workspace>`): Interrogation (Repack's teachings,
 * the Interrogation board), and bodycam (Nov 1: the same teachings adapted,
 * the Raw Channels board).
 */
export const WORKSPACES = ["interrogation", "bodycam"] as const;
export type Workspace = (typeof WORKSPACES)[number];
export const WORKSPACE_NAMES: Record<Workspace, string> = { interrogation: "Interrogation", bodycam: "Bodycam" };

/** The title niches the craft sorts a case into (Sphe Research's). */
export const NICHES = ["murder", "child-related", "karen", "other"] as const;
export type Niche = (typeof NICHES)[number];

/** What an idea is made from: a YouTube video, or an article. */
export type IdeaSource =
  | {
      kind: "youtube";
      url: string;
      videoId: string;
      title: string;
      channel: string;
      views: number | null;
      /** Views over the channel's usual long-form reach ("3.4x"), or "unknown". */
      outlier: string;
      publishedAt: string | null;
      durationSeconds: number | null;
      thumbnail: string | null;
    }
  | { kind: "article"; url: string; title: string; outlet: string };

export type IdeaTitle = {
  id: string;
  text: string;
  /** Who wrote it: "claude", or the person's name. */
  by: string;
  at: number;
};

/** A picture with the thumbnail guide: an idea's own (R2 `key`), or one already somewhere (`url`). */
export type IdeaImage = {
  id: string;
  name: string;
  /** Under `edit/ideas/<idea>/`. */
  key?: string;
  /** A YouTube thumbnail or a Trello attachment. */
  url?: string;
  /** Where it came from: the video's thumbnail, an upload, the card, an approved title's cover, a frame of the case's video. */
  from: "video" | "upload" | "card" | "base" | "frame";
  /** A frame's second in the video and what the guide takes from it: the scene (base), a person (subject, `who`), or both. */
  frame?: IdeaFrame;
};

/** What a frame of the case's video is for (Sphe, Nov 2: "we pick the base frame e.g outside the house… and we pick the subjects, e.g the father, the child"). */
export type IdeaFrame = { at: number; use: "base" | "subject" | "base_and_subject"; who?: string };

/**
 * A piece of the footage for the script, as New project takes it (Sphe, Nov 2:
 * "we can allow for many options added each item a footage link and we detect
 * youtube and drive. so we are able to mark a case as reuse etc. basically how
 * things we would expect for us to start a script"): a YouTube or Drive video
 * to write from, or a case the channel already covered, reused as it was (a
 * video, or its script's Doc).
 */
export type IdeaFootage = {
  id: string;
  url: string;
  kind: FootageKind;
  reuse: boolean;
  /** As Script mode reads it: the video's title, the Drive folder's name (named by the server once it's added). */
  title?: string;
  /** Why Script mode couldn't import it ("That Drive link has no recordings."), when it was checked and can't. */
  problem?: string;
};
export type FootageKind = "youtube" | "drive" | "doc";

/** What a footage link is: a YouTube or Drive video, a Google Doc (a script, reused), or null. */
export function footageKind(url: string): FootageKind | null {
  const text = url.trim();
  if (!/^https?:\/\//i.test(text)) return null;
  if (/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i.test(text)) return "youtube";
  if (/^https?:\/\/docs\.google\.com\/document\//i.test(text)) return "doc";
  if (/^https?:\/\/(?:drive|docs)\.google\.com\//i.test(text)) return "drive";
  return null;
}

/**
 * Footage as pasted: each link on its own, a reuse when its line says so
 * ("REUSE <link>", "reused: <link>", Script mode's way), a Doc always a reuse.
 * Links that are neither YouTube nor Drive are given back apart.
 */
export function footageIn(text: string, newId: () => string): { footage: IdeaFootage[]; refused: string[] } {
  const footage: IdeaFootage[] = [];
  const refused: string[] = [];
  for (const line of text.split(/\n+/)) {
    for (const found of line.matchAll(/https?:\/\/[^\s)\]"'<>]+/g)) {
      const url = found[0].replace(/[.,;]+$/, "");
      const kind = footageKind(url);
      if (kind === null) {
        refused.push(url);
        continue;
      }
      if (footage.some((one) => one.url === url)) continue;
      footage.push({ id: newId(), url, kind, reuse: kind === "doc" || /\breuse/i.test(line.replace(url, "")) });
    }
  }
  return { footage, refused };
}

/** A footage line as Script mode reads it (writer/trello.ts `line`): "REUSE <link>" for a reuse. */
export const footageLine = (one: Pick<IdeaFootage, "url" | "reuse">): string => (one.reuse ? `REUSE ${one.url}` : one.url);

/** A thumbnail that already worked (an approved card's cover), the guide's starting point. */
export type IdeaBase = { title: string; cardUrl: string; image: string };

export type IdeaTool = { name: string; state: "running" | "done" | "error"; detail?: string };

export type IdeaTurn = {
  role: "you" | "claude";
  text: string;
  at: number;
  /** Who asked (a person's name), on their turns. */
  by?: string;
  tools?: IdeaTool[];
  workedMs?: number;
  failed?: boolean;
};

/** Claude's work on an idea: a repackaging or a chat turn, run on one Mac. */
export type IdeaRun = {
  what: "repackage" | "chat";
  state: "queued" | "running" | "done" | "failed" | "stopped";
  /** The Mac it runs on (cloud_projects' holder). */
  holder: string;
  by: string;
  startedAt: number;
  endedAt?: number;
  /** What it's doing now, or why it stopped. */
  step?: string;
  error?: string;
  tools?: IdeaTool[];
  /** What Claude said on the way, while it runs. */
  said?: string;
};

/** Where the idea's card is on the board, as last looked. */
export type IdeaPlace = { list: string; closed: boolean; approved: boolean; changes: boolean; missing: boolean };

export type IdeaCard = {
  cardId: string;
  url: string;
  lane: string;
  list: string;
  sentAt: number;
  sentBy: string;
  /** The last time it was written (sent again, or its changes made). */
  updatedAt?: number;
};

export type IdeaComment = { id: string; text: string; author: string; at: string };

export type Idea = {
  id: string;
  workspace: Workspace;
  sources: IdeaSource[];
  /** The angle the person asked for, if any. */
  steer: string;
  wantsSummary: boolean;
  niche: Niche | null;
  /** In order; `main` names the card. */
  titles: IdeaTitle[];
  main: string | null;
  thumbnailGuide: string;
  /** Who wrote the guide: "claude", or the person's name (a guide written by hand outranks Claude's on a fresh run). */
  guideBy: string;
  base: IdeaBase | null;
  images: IdeaImage[];
  summary: string;
  /** What the script is written from (a Drive folder until Nov 2, now a list): videos, and cases reused as they were. */
  footage: IdeaFootage[];
  notes: string;
  status: "draft" | "ready" | "sent";
  /** Why Claude didn't repackage it (no transcript, a link it couldn't read). */
  skipped: string | null;
  /** The card that already has this video, when it's on the board. */
  duplicate: { cardId: string; name: string; url: string; list: string } | null;
  card: IdeaCard | null;
  /** The reviewers' comments, while the card waits on changes. */
  changes: { comments: IdeaComment[]; at: number } | null;
  run: IdeaRun | null;
  chat: IdeaTurn[];
  createdAt: number;
  createdBy: string;
  updatedAt: number;
};

/** An idea's row in a list (mamagi keeps it beside the body). */
export type IdeaSummary = {
  title: string;
  status: Idea["status"];
  run: IdeaRun["state"] | null;
  /** The run's step, or why it stopped. */
  step: string | null;
  sources: number;
  thumbnail: string | null;
  views: number | null;
  outlier: string | null;
  card: { cardId: string; url: string; list: string } | null;
  changes: number;
  skipped: string | null;
  duplicate: string | null;
  /** What it's made from, by key: a video's id, an article's link (so a second idea of the same case is caught). */
  keys?: string[];
  niche?: Niche | null;
  /** The first source's own title. */
  source?: string;
};

/** An idea as Home lists it. */
export type IdeaRow = {
  id: string;
  workspace: Workspace;
  rev: number;
  summary: IdeaSummary;
  updatedAt: number;
  updatedBy: string;
  createdBy: { sub: string; name: string; picture: string | null } | null;
  /** Where its card is now (the board, read a minute at a time). */
  place: IdeaPlace | null;
};

/** A card on a lane waiting on changes that no idea has yet. */
export type ChangeCard = {
  id: string;
  workspace: Workspace;
  name: string;
  url: string;
  list: string;
  comments: IdeaComment[];
  cover: string | null;
};

/** What Home's Ideas tab shows. */
export type IdeasHome = {
  ideas: IdeaRow[];
  changes: ChangeCard[];
  /** Each workspace's lanes (where a card is sent). */
  lanes: { key: string; name: string; workspace: Workspace }[];
  /** The workspaces this person may work on. */
  workspaces: Workspace[];
  /** Why the board couldn't be read just now. */
  boardError: string | null;
};
