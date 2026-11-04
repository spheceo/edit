// What the page makes for the person to keep (a thumbnail, a frame), and where
// it ends up. In Edit's window, or a browser on the Mac running Edit, the
// server writes it into Downloads and the page says so, with Show in Finder:
// a browser download there is a copy dropped somewhere unseen (Sphe, Nov 4).
// From another device it's that device's own download.

import { api } from "./api";
import { useEditor } from "./store";

/** Whether this page runs on the Mac that holds Edit's files (its window, or a browser there). */
export const onThisMac = (): boolean => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname);

/** Shows a file Edit made on this Mac in Finder, saying so when it can't. */
export function showInFinder(path: string): void {
  void api.reveal(path).catch((error: unknown) => useEditor.getState().toastError(error, "show it in Finder"));
}

/** Keeps `blob` as `name`: in this Mac's Downloads (said, with Show in Finder), or as this device's download. */
export async function saveFile(name: string, blob: Blob): Promise<void> {
  if (!onThisMac()) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    return;
  }
  try {
    const response = await fetch(`/api/files/save?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": blob.type || "application/octet-stream" }, body: blob });
    const answer = (await response.json()) as { path?: string; error?: string };
    if (!response.ok || answer.path === undefined) throw new Error(answer.error ?? `${response.status}`);
    const path = answer.path;
    useEditor.getState().toast(`Saved to Downloads as ${path.split("/").pop()}`, "info", { label: "Show in Finder", run: () => showInFinder(path) });
  } catch (error) {
    useEditor.getState().toastError(error, `save ${name}`);
  }
}
