// The home screen's voice-overs: their own projects, for now.

import { AudioLines, Ellipsis, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";

import { navigate } from "../lib/route";
import { useEditor } from "../lib/store";
import { ago } from "../lib/time";
import type { ProjectSummary } from "../lib/types";
import { voiceApi, type VoiceSummary } from "../lib/voice";
import { toggleMenu } from "./ContextMenu";
import { Button, Modal, Select, spring } from "./ui";

export function VoiceOvers({ projects, creating, onCloseCreate }: { projects: ProjectSummary[]; creating: boolean; onCloseCreate: () => void }) {
  const [list, setList] = useState<VoiceSummary[] | null>(null);
  const toast = useEditor((state) => state.toast);
  const refresh = () =>
    voiceApi
      .list()
      .then(({ projects }) => setList(projects))
      .catch(() => setList([]));
  useEffect(() => {
    void refresh();
  }, []);

  return (
    <>
      {list && list.length > 0 && (
        <>
          <h2 className="mt-12 mb-4 text-[12px] font-medium tracking-wide text-muted uppercase">Voice-overs</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4">
            {list.map((voice, index) => (
              <motion.div
                key={voice.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...spring, delay: Math.min(index, 12) * 0.03 }}
                onClick={() => navigate(`/v/${voice.id}`)}
                className="group relative cursor-pointer rounded-xl border border-line bg-panel p-4 transition-[border-color] hover:border-line-strong"
              >
                <AudioLines size={18} className="text-agent" />
                <div className="mt-3 truncate font-medium">{voice.name}</div>
                <div className="mt-0.5 text-[12px] text-muted tabular">
                  {voice.done}/{voice.lines} lines · {voice.voice_name ?? "no voice yet"} · {ago(voice.modified_ms)}
                </div>
                <button
                  title="More"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleMenu(
                      event.currentTarget,
                      [
                        {
                          label: "Delete",
                          icon: <Trash2 size={14} />,
                          danger: true,
                          onSelect: () =>
                            void voiceApi
                              .remove(voice.id)
                              .then(refresh)
                              .catch((error) => toast((error as Error).message, "error")),
                        },
                      ],
                      { width: 150 },
                    );
                  }}
                  className="absolute top-3 right-3 flex size-7 items-center justify-center rounded-md text-muted opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-fg"
                >
                  <Ellipsis size={15} />
                </button>
              </motion.div>
            ))}
          </div>
        </>
      )}
      <NewVoiceOver open={creating} onClose={onCloseCreate} projects={projects} />
    </>
  );
}

function NewVoiceOver({ open, onClose, projects }: { open: boolean; onClose: () => void; projects: ProjectSummary[] }) {
  const [name, setName] = useState("");
  const [from, setFrom] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const toast = useEditor((state) => state.toast);
  useEffect(() => {
    if (!open) return;
    setName("");
    setFrom("");
  }, [open]);
  const create = async () => {
    setBusy(true);
    try {
      const { project } = await voiceApi.create({ name: name.trim(), from_project: from || undefined });
      onClose();
      navigate(`/v/${project.id}`);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} width={440}>
      <form
        className="flex flex-col gap-4 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <h2 className="text-[16px] font-semibold tracking-[-0.01em]">New voice-over</h2>
        <label className="flex flex-col gap-1.5 text-[12px] text-muted">
          Name
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={from ? "The project's name" : "Untitled voice-over"}
            className="h-8 rounded-lg border border-line bg-black/30 px-2.5 text-[13px] text-fg outline-none placeholder:text-faint focus:border-line-strong"
          />
        </label>
        <div className="flex items-center justify-between gap-3 text-[12px] text-muted">
          <span>Start from</span>
          <Select
            value={from}
            options={[{ value: "", label: "A blank script" }, ...projects.map((project) => ({ value: project.id, label: `${project.name}'s cut-ins` }))]}
            onChange={setFrom}
            className="h-8 max-w-[280px] justify-end px-2 hover:bg-hover"
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}
