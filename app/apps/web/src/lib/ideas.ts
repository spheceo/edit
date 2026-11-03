// Ideas (Oct 31 2026): the server's /api/ideas, for Home's Ideas section and the
// idea page. An idea is the team's (mamagi, through the relay); this Mac's
// server runs Claude on it and answers what it's doing as it goes.

import type { Idea, IdeaImage, IdeaPlace, IdeasHome, Niche, Workspace } from "@edit/types/ideas";

import type { Account } from "./account";

export type * from "@edit/types/ideas";

/** Whether the person works on ideas: an `ideas.*` capability (an admin, or nobody signed in, has everything). */
export const makesIdeas = (account: Account | null): boolean => account === null || account.person === null || account.admin || account.perms.some((perm) => perm.startsWith("ideas."));

/** Each niche's name and dot (Sphe Research's). */
export const NICHE: Record<Niche, { label: string; dot: string }> = {
  murder: { label: "Murder", dot: "bg-red-400/80" },
  "child-related": { label: "Child-related", dot: "bg-amber-300/80" },
  karen: { label: "Karen", dot: "bg-fuchsia-300/80" },
  other: { label: "Other", dot: "bg-white/30" },
};

export type LengthStyle = { typicalWords: [number, number]; maxWords: number; maxCharacters: number } | null;

/** An idea as its page shows it: where its card is, and what's wrong with each title by the channel's rules. */
export type IdeaPage = { idea: Idea; rev: number; place: IdeaPlace | null; problems: Record<string, string>; guideProblem: string | null; style: LengthStyle };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const said = parsed !== null && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string" ? (parsed as { error: string }).error : text || `${response.status}`;
    throw new Error(said);
  }
  return parsed as T;
}

/** What a person can change on an idea (only the fields given). */
export type IdeaChange = {
  titles?: { id?: string; text: string }[];
  main?: string | null;
  thumbnailGuide?: string;
  summary?: string;
  footage?: { id?: string; url: string; reuse?: boolean; title?: string }[];
  notes?: string;
  steer?: string;
  wantsSummary?: boolean;
  status?: "draft" | "ready";
  images?: string[];
  base?: null;
};

export const ideasApi = {
  home: () => call<IdeasHome>("GET", "/api/ideas"),
  /** The kinds of idea this person works on. */
  workspaces: () => call<{ workspaces: Workspace[] }>("GET", "/api/ideas/workspaces"),
  create: (links: string, steer: string, summary: boolean, footage: string, workspace: Workspace) => call<{ ideas: { id: string; link: string }[]; refused: { link: string; why: string; id?: string }[] }>("POST", "/api/ideas", { links, steer, summary, footage, workspace }),
  fromCard: (card: string, workspace: Workspace) => call<{ id: string }>("POST", "/api/ideas/from-card", { card, workspace }),
  get: (id: string) => call<IdeaPage>("GET", `/api/ideas/${encodeURIComponent(id)}`),
  change: (id: string, change: IdeaChange) => call<{ idea: Idea; rev: number }>("PUT", `/api/ideas/${encodeURIComponent(id)}`, change),
  remove: (id: string) => call<void>("DELETE", `/api/ideas/${encodeURIComponent(id)}`),
  repackage: (id: string, options: { improve?: boolean; changes?: boolean; steer?: string } = {}) => call<{ ok: true }>("POST", `/api/ideas/${encodeURIComponent(id)}/repackage`, options),
  chat: (id: string, text: string, images: IdeaImage[] = []) => call<{ ok: true }>("POST", `/api/ideas/${encodeURIComponent(id)}/chat`, { text, images }),
  stop: (id: string) => call<{ stopped: boolean }>("POST", `/api/ideas/${encodeURIComponent(id)}/stop`, {}),
  comments: (id: string) => call<{ changes: Idea["changes"] }>("POST", `/api/ideas/${encodeURIComponent(id)}/comments`, {}),
  send: (id: string, lane: string, anyway = false) => call<{ idea: Idea }>("POST", `/api/ideas/${encodeURIComponent(id)}/send`, { lane, anyway }),
  updateCard: (id: string) => call<{ idea: Idea; labelled: boolean }>("POST", `/api/ideas/${encodeURIComponent(id)}/update-card`, {}),
  upload: async (id: string, file: File) => {
    const response = await fetch(`/api/ideas/${encodeURIComponent(id)}/images?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "content-type": file.type }, body: file });
    const parsed = (await response.json().catch(() => null)) as { idea?: Idea; error?: string } | null;
    if (!response.ok || parsed?.idea === undefined) throw new Error(parsed?.error ?? `${response.status}`);
    return parsed.idea;
  },
};

/** A picture attached to a chat message. */
export const chatImageUrl = (id: string, image: string) => `/api/ideas/${encodeURIComponent(id)}/chat-images/${encodeURIComponent(image)}`;

/** A picture's address on this server. */
export const imageUrl = (id: string, image: string) => `/api/ideas/${encodeURIComponent(id)}/images/${encodeURIComponent(image)}`;

/** Views as the board writes them: 155K views. */
export function viewsLabel(views: number | null): string {
  if (views === null) return "";
  if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(1).replace(/\.0$/, "")}M views`;
  if (views >= 1000) return `${Math.round(views / 1000)}K views`;
  return `${views} views`;
}

/** Whether Claude is on the idea now. */
export const working = (idea: Pick<Idea, "run">): boolean => idea.run !== null && (idea.run.state === "running" || idea.run.state === "queued");
