import { ChevronRight, Captions, RectangleHorizontal, Moon, Sparkles, Sun, Type, Vibrate, Zap } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";

import { CLIP_HEX } from "../lib/colors";
import { addElement, type Element } from "../lib/edit";
import { playhead } from "../lib/playback";
import { useEditor } from "../lib/store";
import { ELEMENT_MIME } from "./MediaPanel";

interface Preset {
  id: Element;
  label: string;
  hint: string;
  icon: ReactNode;
  color: string;
}

const FOLDERS: { id: string; label: string; presets: Preset[] }[] = [
  {
    id: "text",
    label: "Text",
    presets: [
      {
        id: "subtitle",
        label: "Subtitle",
        hint: "Repack style: boxed, wraps",
        icon: <Captions size={14} />,
        color: CLIP_HEX.cyan,
      },
      {
        id: "cutin",
        label: "Cut-in",
        hint: "Black card with the narration",
        icon: <RectangleHorizontal size={14} />,
        color: CLIP_HEX.purple,
      },
      {
        id: "title",
        label: "Glow title",
        hint: "Big type, rises in",
        icon: <Sparkles size={14} />,
        color: CLIP_HEX.pink,
      },
      {
        id: "caption",
        label: "Caption",
        hint: "Lower third, pops in",
        icon: <Type size={14} />,
        color: CLIP_HEX.yellow,
      },
    ],
  },
  {
    id: "effects",
    label: "Effects",
    presets: [
      {
        id: "adjustment",
        label: "Adjustment layer",
        hint: "Grade everything below",
        icon: <Sun size={14} />,
        color: CLIP_HEX.purple,
      },
      {
        id: "shake",
        label: "Shake",
        hint: "Judders everything below",
        icon: <Vibrate size={14} />,
        color: CLIP_HEX.orange,
      },
      {
        id: "flash",
        label: "Flash",
        hint: "White hit, fades out",
        icon: <Zap size={14} />,
        color: "#ededed",
      },
      {
        id: "black",
        label: "Dip to black",
        hint: "Fades to black",
        icon: <Moon size={14} />,
        color: CLIP_HEX.red,
      },
    ],
  },
];

const STORAGE = "edit.presets.closed";

const closedFolders = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE) ?? "[]");
  } catch {
    return [];
  }
};

export function Presets() {
  const [closed, setClosed] = useState(closedFolders);
  const toggle = (id: string) => {
    const next = closed.includes(id) ? closed.filter((folder) => folder !== id) : [...closed, id];
    localStorage.setItem(STORAGE, JSON.stringify(next));
    setClosed(next);
  };
  return (
    <div className="flex flex-col gap-1">
      {FOLDERS.map((folder) => {
        const open = !closed.includes(folder.id);
        return (
          <div key={folder.id}>
            <button
              onClick={() => toggle(folder.id)}
              className="flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-[12px] font-medium text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <ChevronRight size={13} className={`shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
              <span>{folder.label}</span>
              <span className="ml-auto text-[11px] text-faint tabular-nums">{folder.presets.length}</span>
            </button>
            <AnimatePresence initial={false}>
              {open && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
                  className="overflow-hidden"
                >
                  <div className="flex flex-col gap-0.5 pt-0.5 pb-1.5 pl-3">
                    {folder.presets.map((preset) => (
                      <PresetRow key={preset.id} preset={preset} />
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}

function PresetRow({ preset }: { preset: Preset }) {
  const edit = useEditor((state) => state.edit);
  const select = useEditor((state) => state.select);
  const setSideTab = useEditor((state) => state.setSideTab);
  return (
    <button
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(ELEMENT_MIME, preset.id);
        // dataTransfer is unreadable during dragover; the timeline reads this to size its preview.
        (window as unknown as { __editDragElement?: Element }).__editDragElement = preset.id;
        event.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => {
        let id = "";
        edit((draft) => {
          id = addElement(draft, preset.id, Math.round(playhead.frame));
        });
        select([id]);
        setSideTab("info");
      }}
      className="group flex items-center gap-2.5 rounded-lg p-1 text-left transition-colors hover:bg-hover"
    >
      <span
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-raised ring-1 ring-line transition-colors group-hover:bg-active"
        style={{ color: preset.color }}
      >
        {preset.icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium">{preset.label}</span>
        <span className="block truncate text-[11px] text-muted">{preset.hint}</span>
      </span>
    </button>
  );
}
