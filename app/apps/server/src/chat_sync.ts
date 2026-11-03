// An Edit project's chat, carried in the team's cloud so the conversation
// continues on any Mac (Sphe, Nov 3: "the chats must be saved so we can
// continue where we left off on any device"). The chat itself still lives in
// its file beside the project; this only mirrors it: a save uploads it
// (debounced), and bringing a project here takes the cloud's copy when it's
// newer than this Mac's. Ideas' and thumbnails' chats need none of this —
// they live in their cloud bodies already.

import * as fs from "node:fs";

import * as cloud from "./cloud.ts";
import { validId, type Store } from "./store.ts";

/** The chat's cloud key for a project (or a sub-agent's chat of it). */
export const chatKey = (project: string): string => `edit/chats/${project}.json`;

/** When a chat snapshot says it was saved (0 when it doesn't say). */
export function savedAtOf(text: string): number {
  try {
    const at = (JSON.parse(text) as { savedAt?: unknown }).savedAt;
    return typeof at === "number" ? at : 0;
  } catch {
    return 0;
  }
}

/** The cloud's chat is taken when it's newer than this Mac's. */
export const isNewer = (cloudSavedAt: number, localSavedAt: number): boolean => cloudSavedAt > localSavedAt;

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** A chat was saved here: upload it shortly, once the saves settle. */
export function schedulePush(store: Store, project: string): void {
  if (!cloud.enabled() || !validId(project.replace(/~.*$/, ""))) return;
  const waiting = pending.get(project);
  if (waiting !== undefined) clearTimeout(waiting);
  pending.set(
    project,
    setTimeout(() => {
      pending.delete(project);
      const path = store.chatPath(project);
      if (!fs.existsSync(path)) return;
      void cloud.uploadFile(path, chatKey(project)).catch(() => {
        // Offline or signed out: the next save tries again.
      });
    }, 1500),
  );
}

/**
 * Take the cloud's chat for a project when it's newer than this Mac's. Never
 * over a chat this server has loaded (it may be mid-turn) — the caller says.
 */
export async function pull(store: Store, project: string, loaded: boolean): Promise<boolean> {
  if (loaded || !cloud.enabled() || !validId(project)) return false;
  const dest = store.chatPath(project);
  const temp = `${dest}.cloud`;
  try {
    await cloud.download(chatKey(project), temp);
    const cloudText = fs.readFileSync(temp, "utf8");
    const localText = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : "";
    if (!isNewer(savedAtOf(cloudText), savedAtOf(localText))) return false;
    fs.renameSync(temp, dest);
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Nothing to tidy.
    }
  }
}
