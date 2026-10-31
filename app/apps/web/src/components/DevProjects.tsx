// Dev projects on Home (Oct 31 2026): a project started on a dev build (the
// dev server, the trial server) is marked Dev, can be hidden, promoted to a
// real project from its ⋯, and all of them deleted at once (Sphe, Oct 31:
// "the project list gets huge"). The server marks them (`dev_projects.ts`).

import { BadgeCheck, ChevronDown, Eye, EyeOff, FlaskConical, Trash2 } from "lucide-react";
import { useState } from "react";

import { useEditor } from "../lib/store";
import type { ProjectSummary } from "../lib/types";
import { toggleMenu, type MenuItem } from "./ContextMenu";
import { Button, cx, Modal } from "./ui";

/** Whether Home shows dev projects (remembered on this browser). */
const SHOW_DEV = "edit.home.dev";

export function useShowDev(): [boolean, (show: boolean) => void] {
  const [show, setShow] = useState(() => localStorage.getItem(SHOW_DEV) !== "0");
  return [
    show,
    (value: boolean) => {
      localStorage.setItem(SHOW_DEV, value ? "1" : "0");
      setShow(value);
    },
  ];
}

/** The small mark beside a dev project's name. */
export function DevBadge() {
  return (
    <span title="Made on a dev build. Promote it from its ⋯ if it’s real work." className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] border border-warning/40 bg-warning-soft px-1.5 text-[11px] leading-none font-semibold tracking-[0.02em] text-warning">
      Dev
    </span>
  );
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const answer = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const given = (await answer.json().catch(() => ({}))) as Record<string, unknown>;
  if (!answer.ok) throw new Error(typeof given.error === "string" ? given.error : `${answer.status}`);
  return given;
}

/** A dev project's ⋯ item: promoted to an ordinary project, its mark gone. */
export function promoteItem(project: ProjectSummary, onChanged: () => void): MenuItem[] {
  if (project.dev !== true) return [];
  const promote = async () => {
    try {
      await post(`/api/projects/${project.id}/promote`, {});
      useEditor.getState().toast(`“${project.name}” is a real project now`, "info");
    } catch (error) {
      useEditor.getState().toastError(error, `promote “${project.name}”`);
    }
    onChanged();
  };
  return [{ label: "Promote to real project", icon: <BadgeCheck size={14} />, onSelect: () => void promote() }];
}

/** Home's Dev control: show or hide dev projects, and delete them all (confirmed with the count). */
export function DevControl({ count, show, onShow, onChanged }: { count: number; show: boolean; onShow: (show: boolean) => void; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (count === 0) return null;
  const items: MenuItem[] = [
    show ? { label: "Hide dev projects", icon: <EyeOff size={14} />, onSelect: () => onShow(false) } : { label: "Show dev projects", icon: <Eye size={14} />, onSelect: () => onShow(true) },
    { separator: true },
    { label: `Delete all dev projects (${count})…`, icon: <Trash2 size={14} />, danger: true, onSelect: () => setConfirming(true) },
  ];
  const removeAll = async () => {
    setBusy(true);
    try {
      const done = await post("/api/dev-projects/delete", { count });
      const deleted = Array.isArray(done.deleted) ? done.deleted.length : 0;
      const failed = Array.isArray(done.failed) ? (done.failed as { error: string }[]) : [];
      if (failed.length > 0) useEditor.getState().toastError(`${failed.length} weren’t deleted: ${failed[0]!.error}`, "delete every dev project");
      else useEditor.getState().toast(`Deleted ${deleted} dev ${deleted === 1 ? "project" : "projects"}`, "info");
      setConfirming(false);
    } catch (error) {
      useEditor.getState().toastError(error, "delete the dev projects");
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return (
    <>
      <button
        onClick={(event) => toggleMenu(event.currentTarget, items, { width: 230 })}
        title={show ? `${count} dev projects shown` : `${count} dev projects hidden`}
        className={cx("flex h-[34px] shrink-0 items-center gap-1.5 rounded-[9px] border border-line bg-bg px-2.5 text-[13px] font-medium transition-colors hover:text-fg", show ? "text-muted" : "text-faint")}
      >
        <FlaskConical size={14} />
        Dev <span className="tabular text-faint">{show ? count : `${count} hidden`}</span>
        <ChevronDown size={13} className="text-faint" />
      </button>
      <Modal open={confirming} onClose={() => !busy && setConfirming(false)} width={400}>
        <div className="p-6">
          <h2 className="text-[18px] font-semibold tracking-[-0.3px]">
            Delete {count} dev {count === 1 ? "project" : "projects"}?
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            Every project marked Dev on this Mac goes, from the cloud too where it’s there. Projects without the mark aren’t touched. A copy of each is kept in Edit’s data folder; footage files stay where they are.
          </p>
          <div className="mt-[22px] flex justify-end gap-2">
            <Button variant="subtle" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void removeAll()}>
              {busy ? "Deleting…" : `Delete ${count} dev ${count === 1 ? "project" : "projects"}`}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
