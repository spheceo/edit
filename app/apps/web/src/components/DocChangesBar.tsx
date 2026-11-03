// The editor's word on a script Doc that changed after the edit was made from
// it (Oct 31, the team: start and end words added to CORRUPT Cops' Doc by
// hand; "detect changes to the project and be able to refresh and pull those
// changes and have whatever needs to be done be done"). Pull changes cuts the
// changed ranges again in code; narration rewritten and blocks added or taken
// out go to the agent.

import { FileText } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { sendToAgent } from "../lib/agent";
import { api, type ScriptChanges } from "../lib/api";
import { readOnly } from "../lib/cloud";
import { useEditor } from "../lib/store";
import { Button } from "./ui";

const CHECK_EVERY_MS = 2 * 60_000;
const plain = (label: string) => label.replaceAll("‑", "-").replace(/\s+/g, "");
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What changed, in a few words ("7 ranges have new start and end words, 3 have new times"). */
export function changesSaid(changes: ScriptChanges): string {
  const timed = changes.ranges.filter((range) => plain(range.was) !== plain(range.now)).length;
  const worded = changes.ranges.length - timed;
  return [
    worded > 0 && `${count(worded, "range")} ${worded === 1 ? "has" : "have"} new start and end words`,
    timed > 0 && `${count(timed, "range")} ${timed === 1 ? "has" : "have"} new times`,
    changes.narration.length > 0 && `${count(changes.narration.length, "paragraph")} rewritten`,
    changes.added.length > 0 && `${changes.added.length} added`,
    changes.removed.length > 0 && `${changes.removed.length} taken out`,
  ]
    .filter(Boolean)
    .join(", ");
}

/** What's left for the agent once the ranges are cut again. */
function agentWork(changes: ScriptChanges): string | null {
  const lines = [
    ...changes.narration.map((one) => `- Narration rewritten${one.clip ? ` (cut-in ${one.clip})` : ""}: "${one.now}"`),
    ...changes.added.map((one) => `- Added ${one.block}${one.after ? `, after ${one.after}` : " at the start"}`),
    ...changes.removed.map((one) => `- Taken out: ${one.block}${one.clip ? ` (clip ${one.clip})` : ""}`),
  ];
  if (lines.length === 0) return null;
  return `The script Doc changed and I pulled it: its changed ranges are cut again. Carry out the rest (pull_script without apply reports it), then tell me what you did:\n${lines.join("\n")}`;
}

const signature = (changes: ScriptChanges) => JSON.stringify([changes.ranges, changes.narration, changes.added, changes.removed]);

/** A normal button beside Share (was a full-width banner under the top bar, Nov 3: it took a whole row to say one thing). */
export function DocChangesButton() {
  const id = useEditor((state) => state.project?.id ?? "");
  const fromDoc = useEditor((state) => Boolean(state.project?.script?.source?.includes("docs.google.com")));
  const cloud = useEditor((state) => state.cloud);
  const toast = useEditor((state) => state.toast);
  const [changes, setChanges] = useState<ScriptChanges | null>(null);
  const [handled, setHandled] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(() => {
    if (id === "" || !fromDoc) return;
    api
      .scriptChanges(id)
      .then(setChanges)
      .catch(() => setChanges(null));
  }, [id, fromDoc]);

  useEffect(() => {
    setChanges(null);
    setHandled(null);
    check();
    const timer = window.setInterval(check, CHECK_EVERY_MS);
    const onFocus = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [check]);

  if (changes === null) return null;
  const said = changesSaid(changes);
  if (said === "" || handled === signature(changes)) return null;
  const beyond = changes.ranges.filter((range) => range.beyond).map((range) => `${range.now}: ${range.beyond}`);
  const locked = readOnly(cloud);

  const pull = async () => {
    setBusy(true);
    try {
      const done = await api.pullScript(id);
      const recut = done.recut?.length ?? 0;
      const rest = agentWork(done);
      setHandled(signature({ ...done, ranges: [] }));
      setChanges({ ...done, ranges: [] });
      if (rest !== null) void sendToAgent(rest);
      toast(`Pulled the Doc: ${count(recut, "clip")} cut again${rest !== null ? ", and Claude is doing the rest" : ""}.`);
    } catch (error) {
      useEditor.getState().toastError(error, "pull the Doc");
    } finally {
      setBusy(false);
    }
  };

  const detail = `The script Doc changed: ${said}${beyond.length > 0 ? `; ${count(beyond.length, "range")} ${beyond.length === 1 ? "runs" : "run"} past the footage downloaded` : ""}. Pull it to cut the changed ranges again.`;
  return (
    <Button
      variant="light"
      disabled={busy || locked}
      title={locked ? "Someone else is editing this: it can be pulled once it opens for editing here." : detail}
      onClick={() => void pull()}
    >
      <FileText size={14} />
      {busy ? "Pulling…" : "Pull Doc changes"}
    </Button>
  );
}

/** The old banner's name, kept for anything still importing it. */
export const DocChangesBar = DocChangesButton;
