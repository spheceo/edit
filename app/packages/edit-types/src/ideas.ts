// Ideas (Oct 31 2026): a case repackaged into titles and a thumbnail guide,
// then sent to the Interrogation board, as Sphe Research and Repack's threads
// did it. The team's, so it lives in mamagi (`ideas` module) whole: the
// server keeps nothing of it on the Mac. One shape for the server and the UI.

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
  /** Where it came from: the video's thumbnail, an upload, the card, an approved title's cover. */
  from: "video" | "upload" | "card" | "base";
};

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
  workspace: "interrogation";
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
  /** The footage's Drive folder, when someone has it. */
  footage: string;
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
};

/** An idea as Home lists it. */
export type IdeaRow = {
  id: string;
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
  lanes: { key: string; name: string }[];
  /** Why the board couldn't be read just now. */
  boardError: string | null;
};
