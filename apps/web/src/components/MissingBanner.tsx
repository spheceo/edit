// The editor's word on footage that's gone: the timeline plays files that
// aren't on this machine (deleted, or on a drive that isn't plugged in) and
// the cloud can't bring back, so those clips are black and silent.

import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { useEditor } from "../lib/store";

export function MissingBanner() {
  const id = useEditor((state) => state.project?.id ?? "");
  // Asked again when the media change (an import, a relink).
  const mediaCount = useEditor((state) => state.project?.media.length ?? 0);
  const [found, setFound] = useState<{ used: number; missing: { id: string; name: string; path: string }[] } | null>(null);
  useEffect(() => {
    if (id === "") return;
    let live = true;
    api
      .missingFootage(id)
      .then((answer) => live && setFound(answer))
      .catch(() => live && setFound(null));
    return () => {
      live = false;
    };
  }, [id, mediaCount]);
  const missing = found?.missing ?? [];
  if (missing.length === 0) return null;
  const names = missing.map((media) => media.name);
  const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
  return (
    <div
      className="mx-2 mb-2 flex h-9 shrink-0 items-center gap-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.07] px-3 text-[12px]"
      title={missing.map((media) => media.path).join("\n")}
    >
      <TriangleAlert size={13} className="shrink-0 text-amber-300" />
      <span className="shrink-0 text-fg">
        Footage missing: {missing.length} of {found?.used ?? missing.length} files
      </span>
      <span className="truncate text-muted">
        aren't on this Mac, so their clips play black and silent ({shown}).
      </span>
    </div>
  );
}
