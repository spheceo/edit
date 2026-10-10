import { Check, CircleAlert } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { projectDuration } from "../lib/edit";
import { useEditor } from "../lib/store";
import { shortDuration } from "../lib/time";
import { Button, Modal } from "./ui";

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useEditor((state) => state.project);
  const exportState = useEditor((state) => state.exportState);
  const toast = useEditor((state) => state.toast);
  const [path, setPath] = useState("");

  useEffect(() => {
    if (open && project && !path) {
      const safe = project.name.replace(/[^\w\- ]+/g, "_").trim() || "Edit";
      setPath(`~/Movies/Edit/${safe}.mp4`);
    }
  }, [open, project, path]);

  if (!project) return null;
  const seconds = projectDuration(project) / project.settings.fps;
  const running = exportState?.state === "running";

  const start = async () => {
    try {
      const { path: output } = await api.exportProject(project.id, path);
      useEditor.setState({ exportState: { state: "running", progress: 0, path: output } });
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };

  return (
    <Modal open={open} onClose={onClose} width={480}>
      <div className="p-6">
        <h2 className="text-[16px] font-semibold tracking-[-0.01em]">Export</h2>
        <p className="mt-1 text-[12px] text-muted tabular">
          H.264 + AAC · {project.settings.width}×{project.settings.height} · {project.settings.fps}fps · {shortDuration(seconds)}
        </p>
        <label className="mt-5 block text-[12px] text-muted">Save to</label>
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          disabled={running}
          spellCheck={false}
          className="mt-1.5 h-10 w-full rounded-lg border border-line bg-black px-3 font-mono text-[12px] outline-none focus:border-line-strong disabled:opacity-50"
        />
        <p className="mt-2 text-[11px] leading-relaxed text-faint">Rendered with the same GPU compositor as this preview, so titles, glows and grades match exactly.</p>

        {exportState && (
          <div className="mt-5">
            <div className="h-1.5 overflow-hidden rounded-full bg-active">
              <motion.div
                className={exportState.state === "failed" ? "h-full bg-red-400" : "h-full bg-white"}
                animate={{ width: `${(exportState.state === "done" ? 1 : exportState.progress) * 100}%` }}
                transition={{ ease: "easeOut", duration: 0.25 }}
              />
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-[12px]">
              {exportState.state === "running" && <span className="text-muted tabular">Rendering… {Math.round(exportState.progress * 100)}%</span>}
              {exportState.state === "done" && (
                <span className="flex items-center gap-1.5 text-green-300">
                  <Check size={13} /> Exported in {exportState.seconds?.toFixed(1)}s → <span className="font-mono text-fg/80">{exportState.path}</span>
                </span>
              )}
              {exportState.state === "failed" && (
                <span className="flex items-center gap-1.5 text-red-300">
                  <CircleAlert size={13} /> {exportState.error}
                </span>
              )}
              {exportState.state === "cancelled" && <span className="text-muted">Cancelled</span>}
            </div>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          {running ? (
            <Button variant="danger" onClick={() => void api.cancelExport(project.id)}>
              Cancel export
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" disabled={seconds <= 0} onClick={() => void start()}>
                {exportState?.state === "done" ? "Export again" : "Export"}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
