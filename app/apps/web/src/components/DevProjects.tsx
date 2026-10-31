// Dev projects on Home (Oct 31 2026): a project started on a dev build (the
// dev server, the trial server) is marked Dev, can be hidden, promoted to a
// real project from its ⋯, and all of them deleted at once (Sphe, Oct 31:
// "the project list gets huge"). The server marks them (`dev_projects.ts`).

import { BadgeCheck, ChevronDown, Eye, EyeOff, FlaskConical, Trash2 } from "lucide-react";
import { useState } from "react";
import { create } from "zustand";

import { useEditor } from "../lib/store";
import type { ProjectSummary } from "../lib/types";
import { toggleMenu, type MenuItem } from "./ContextMenu";
import { Button, cx, Modal } from "./ui";

/**
 * Whether this is a dev build, where test projects and their controls show: the
 * server says so with Home's list (`dev_build`). Off until it does, and always
 * off on a released build: test projects are the dev team's, never the team's
 * (Sphe, Oct 31: "it's only something for us internally").
 */
export const useDevTools = create<{ on: boolean }>(() => ({ on: false }));

/** Whether Home shows dev projects (remembered on this browser). */
const SHOW_DEV = "edit.home.dev";

export function useShowDev(): [boolean, (show: boolean) => void] {
  // Hidden unless shown (Sphe, Oct 31: test projects aren't to be seen beside real ones).
  const [show, setShow] = useState(() => localStorage.getItem(SHOW_DEV) === "1");
  const tools = useDevTools((state) => state.on);
  return [
    tools && show,
    (value: boolean) => {
      localStorage.setItem(SHOW_DEV, value ? "1" : "0");
      setShow(value);
    },
  ];
}

/** The small mark beside a dev project's name. */
export function DevBadge() {
  const tools = useDevTools((state) => state.on);
  if (!tools) return null;
  return (
    <span title="A test project (made on a dev build, or marked by hand). Promote it from its ⋯ if it’s real work." className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] border border-warning/40 bg-warning-soft px-1.5 text-[11px] leading-none font-semibold tracking-[0.02em] text-warning">
      Test
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
  if (project.dev !== true || !useDevTools.getState().on) return [];
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

/** A real-looking project's ⋯ item: marked a test project (a throwaway made before the mark), hidden with the rest. */
export function testItem(project: ProjectSummary, onChanged: () => void): MenuItem[] {
  if (project.dev === true || project.problem || !useDevTools.getState().on) return [];
  const mark = async () => {
    try {
      await post(`/api/projects/${project.id}/test`, {});
      useEditor.getState().toast(`“${project.name}” is a test project now: hidden with the others`, "info", {
        label: "Undo",
        run: () => void post(`/api/projects/${project.id}/promote`, {}).then(onChanged, (error: unknown) => useEditor.getState().toastError(error, `bring “${project.name}” back`)),
      });
    } catch (error) {
      useEditor.getState().toastError(error, `mark “${project.name}” a test project`);
    }
    onChanged();
  };
  return [{ label: "Mark as test project", icon: <FlaskConical size={14} />, onSelect: () => void mark() }];
}

/** Home's Dev control: show or hide dev projects, and delete them all (confirmed with the count). */
export function DevControl({ count, cloudOnly = 0, show, onShow, onChanged }: { count: number; cloudOnly?: number; show: boolean; onShow: (show: boolean) => void; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const tools = useDevTools((state) => state.on);
  // Shown and hidden count every test project; deleting takes this Mac's (the cloud-only ones are another Mac's to delete).
  const shown = count + cloudOnly;
  if (!tools || shown === 0) return null;
  const items: MenuItem[] = [
    show ? { label: "Hide test projects", icon: <EyeOff size={14} />, onSelect: () => onShow(false) } : { label: "Show test projects", icon: <Eye size={14} />, onSelect: () => onShow(true) },
    ...(count > 0 ? ([{ separator: true }, { label: `Delete all test projects (${count})…`, icon: <Trash2 size={14} />, danger: true, onSelect: () => setConfirming(true) }] satisfies MenuItem[]) : []),
  ];
  const removeAll = async () => {
    setBusy(true);
    try {
      const done = await post("/api/dev-projects/delete", { count });
      const deleted = Array.isArray(done.deleted) ? done.deleted.length : 0;
      const failed = Array.isArray(done.failed) ? (done.failed as { error: string }[]) : [];
      if (failed.length > 0) useEditor.getState().toastError(`${failed.length} weren’t deleted: ${failed[0]!.error}`, "delete every test project");
      else useEditor.getState().toast(`Deleted ${deleted} test ${deleted === 1 ? "project" : "projects"}`, "info");
      setConfirming(false);
    } catch (error) {
      useEditor.getState().toastError(error, "delete the test projects");
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return (
    <>
      <button
        onClick={(event) => toggleMenu(event.currentTarget, items, { width: 230 })}
        title={show ? `${shown} test projects shown` : `${shown} test projects hidden`}
        className={cx("flex h-[34px] shrink-0 items-center gap-1.5 rounded-[9px] border border-line bg-bg px-2.5 text-[13px] font-medium transition-colors hover:text-fg", show ? "text-muted" : "text-faint")}
      >
        <FlaskConical size={14} />
        Test <span className="tabular text-faint">{show ? shown : `${shown} hidden`}</span>
        <ChevronDown size={13} className="text-faint" />
      </button>
      <Modal open={confirming} onClose={() => !busy && setConfirming(false)} width={400}>
        <div className="p-6">
          <h2 className="text-[18px] font-semibold tracking-[-0.3px]">
            Delete {count} test {count === 1 ? "project" : "projects"}?
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            Every project marked Test on this Mac goes, from the cloud too where it’s there. Projects without the mark aren’t touched. A copy of each is kept in Edit’s data folder; footage files stay where they are.
          </p>
          <div className="mt-[22px] flex justify-end gap-2">
            <Button variant="subtle" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void removeAll()}>
              {busy ? "Deleting…" : `Delete ${count} test ${count === 1 ? "project" : "projects"}`}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
