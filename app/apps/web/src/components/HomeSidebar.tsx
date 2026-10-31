// Home's sidebar (Oct 31 2026): what needs you, then ideas, scripts and edits
// each with their stages, then Later and Done; one short list at a time
// beside it. The study portal's sidebar (the user, Oct 31: "i think this is
// way more organised"), after the team's "having to scroll through a long,
// tedious" list of ideas, scripts and edits together.

import { Check, Clock, FileText, Film, Inbox, Lightbulb, PanelLeftClose, PanelLeftOpen, type LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";

import { AppMenu } from "./AppMenu";
import { cx, IconButton } from "./ui";

/** The sidebar's own width, and its shell's: the content plus the gap before the panel, so closed it takes nothing. */
const WIDTH = 204;
const SHELL = WIDTH + 8;

/** The study portal's one spring for the sidebar's width: it clips, never squashes. */
const SPRING = { type: "spring" as const, stiffness: 380, damping: 36, mass: 0.85 };

/** Whether the sidebar is open, remembered on this browser (the study portal keeps it in a cookie). */
const OPEN = "edit.home.sidebar";

export function useSidebarOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN) !== "closed");
  return [
    open,
    (next: boolean) => {
      localStorage.setItem(OPEN, next ? "open" : "closed");
      setOpen(next);
    },
  ];
}

/** Closed: the way back, at the panel's bottom left (the portal's). */
export function OpenSidebar({ onOpen }: { onOpen: () => void }) {
  return (
    <IconButton label="Show the sidebar" onClick={onOpen} className="absolute bottom-3 left-3 z-10 size-8">
      <PanelLeftOpen size={17} />
    </IconButton>
  );
}

export type Section = "ideas" | "scripts" | "edits";

/** Where Home is: what needs you, a section or one of its stages, Later or Done. */
export type Where = "needs" | "later" | "done" | Section | `${Section}:${string}`;

export const SECTIONS: { key: Section; label: string; icon: LucideIcon; stages: { key: string; label: string }[] }[] = [
  { key: "ideas", label: "Ideas", icon: Lightbulb, stages: [{ key: "drafts", label: "Drafts" }, { key: "board", label: "On the board" }] },
  {
    key: "scripts",
    label: "Scripts",
    icon: FileText,
    // The script's way to the edit (the user, Oct 30: "know which projects are ready to script").
    stages: [
      { key: "importing", label: "Importing" },
      { key: "toscript", label: "Ready to script" },
      { key: "scripting", label: "Scripting" },
      { key: "ready", label: "Ready to edit" },
    ],
  },
  { key: "edits", label: "Edits", icon: Film, stages: [{ key: "editing", label: "Editing" }, { key: "review", label: "In review" }, { key: "subtitled", label: "Subtitled" }] },
];

/** The section `where` is in (none for Needs you, Later and Done) and its stage. */
export function placeOf(where: Where): { section: Section | null; stage: string | null } {
  const [section, stage] = where.split(":") as [string, string | undefined];
  return SECTIONS.some((one) => one.key === section) ? { section: section as Section, stage: stage ?? null } : { section: null, stage: null };
}

/** What `where` is called: "Needs you", "Edits", "Edits / In review". */
export function nameOf(where: Where): { parent: string | null; name: string } {
  const { section, stage } = placeOf(where);
  if (section === null) return { parent: null, name: where === "needs" ? "Needs you" : where === "later" ? "Later" : "Done" };
  const found = SECTIONS.find((one) => one.key === section)!;
  return stage === null ? { parent: null, name: found.label } : { parent: found.label, name: found.stages.find((one) => one.key === stage)?.label ?? stage };
}

export function HomeSidebar({ sections, counts, where, onChoose, open, onClose }: { sections: Section[]; counts: (where: Where) => number; where: Where; onChoose: (where: Where) => void; open: boolean; onClose: () => void }) {
  // No spring on the first frame: a sidebar remembered closed doesn't open and close as Home appears.
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMoving(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const item = (to: Where, label: string, Icon: LucideIcon | null, extra?: string) => {
    const count = counts(to);
    const on = where === to;
    return (
      <button
        key={to}
        onClick={() => onChoose(to)}
        className={cx(
          "flex w-full min-w-0 items-center gap-2 text-left transition-colors",
          // The kit's: 13 px, selected a grey step (active), hover the step below it.
          Icon ? "h-8 rounded-lg px-2 text-[13px] font-medium" : "h-[30px] rounded-lg pr-2 pl-[34px] text-[13px]",
          on ? "bg-active text-fg" : Icon ? "text-secondary hover:bg-hover hover:text-fg" : "text-muted hover:bg-hover hover:text-fg",
          extra,
        )}
      >
        {Icon && <Icon size={15} className={cx("shrink-0", on ? "text-fg" : "text-muted")} />}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {to === "needs" && count > 0 ? (
          <span className="rounded-full bg-danger-soft px-1.5 text-[12px] leading-[18px] font-medium text-danger tabular">{count}</span>
        ) : (
          count > 0 && <span className={cx("text-[12px] tabular", on ? "text-secondary" : "text-faint")}>{count}</span>
        )}
      </button>
    );
  };
  return (
    <motion.aside
      initial={false}
      animate={{ width: open ? SHELL : 0 }}
      transition={moving ? SPRING : { duration: 0 }}
      aria-hidden={!open}
      inert={!open}
      className="shrink-0 overflow-hidden"
    >
      <div className="flex h-full flex-col py-1.5 pr-1" style={{ width: WIDTH }}>
        <AppMenu row />
        <nav className="mt-4 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pb-2">
          {item("needs", "Needs you", Inbox)}
          {SECTIONS.filter((section) => sections.includes(section.key)).map((section) => (
            <div key={section.key} className="mt-2.5 flex flex-col gap-0.5">
              {item(section.key, section.label, section.icon)}
              {section.stages.map((stage) => item(`${section.key}:${stage.key}`, stage.label, null))}
            </div>
          ))}
          <div className="mx-2 my-2.5 border-t border-line" />
          {item("later", "Later", Clock)}
          {item("done", "Done", Check)}
        </nav>
        <div className="px-1.5 pt-2">
          <IconButton label="Hide the sidebar" onClick={onClose} className="size-8">
            <PanelLeftClose size={17} />
          </IconButton>
        </div>
      </div>
    </motion.aside>
  );
}
