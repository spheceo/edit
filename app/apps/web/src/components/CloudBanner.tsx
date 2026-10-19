// The editor's word on a cloud project someone else is editing: read-only
// here, with their latest version, until they close it or you take over.

import { Lock } from "lucide-react";
import { useState } from "react";

import { cloudApi, readOnly } from "../lib/cloud";
import { useEditor } from "../lib/store";
import { Button, Modal } from "./ui";

export function CloudBanner() {
  const cloud = useEditor((state) => state.cloud);
  const id = useEditor((state) => state.project?.id ?? "");
  const toast = useEditor((state) => state.toast);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!readOnly(cloud)) return null;
  const holder = cloud?.holder ?? "Someone";

  const takeOver = async () => {
    setBusy(true);
    try {
      const status = await cloudApi.takeOver(id);
      useEditor.setState({ cloud: status });
      setAsking(false);
      toast("You're editing it now.");
    } catch (error) {
      toast(`Couldn't take over: ${(error as Error).message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mx-2 mb-2 flex h-9 shrink-0 items-center gap-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.07] px-3 text-[12px]">
        <Lock size={13} className="text-amber-300" />
        <span className="text-fg">{holder} is editing</span>
        <span className="truncate text-muted">You're seeing their latest saved version, read-only. It opens for editing here when they close it.</span>
        <Button size="sm" className="ml-auto shrink-0" onClick={() => setAsking(true)}>
          Take over
        </Button>
      </div>
      <Modal open={asking} onClose={() => setAsking(false)} width={400}>
        <div className="p-6">
          <h2 className="text-[15px] font-semibold">Take over from {holder}?</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">
            You'll edit it here and {holder}'s editor turns read-only. Anything they changed that hasn't reached the cloud yet is kept on their Mac as a copy, not lost.
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void takeOver()}>
              {busy ? "Taking over…" : "Take over"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
