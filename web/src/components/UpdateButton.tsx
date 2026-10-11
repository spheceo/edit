import { CircleArrowUp } from "lucide-react";
import { useEffect } from "react";

import { installUpdate, useUpdate, watchUpdates } from "../lib/update";
import { Button } from "./ui";

/** "Update to v0.2.0" when a release is out; shows progress, then Edit restarts into it. */
export function UpdateButton() {
  const status = useUpdate((state) => state.status);
  const busy = useUpdate((state) => state.from !== null);
  useEffect(watchUpdates, []);
  if (!status?.enabled || !status.latest) return null;

  const label =
    status.phase === "downloading" ? (
      <span className="tabular">Updating… {Math.round(status.progress * 100)}%</span>
    ) : busy || status.phase === "restarting" ? (
      "Restarting…"
    ) : (
      `Update to ${status.latest}`
    );
  return (
    <Button
      variant="subtle"
      onClick={() => void installUpdate()}
      title={`Edit ${status.current} → ${status.latest}. Edit restarts itself; your work is saved.`}
    >
      <CircleArrowUp size={14} strokeWidth={2.2} />
      {label}
    </Button>
  );
}
