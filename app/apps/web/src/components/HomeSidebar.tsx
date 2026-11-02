// Home's sidebar (Oct 31 2026; Nov 2, prototype C): the account and the
// hide button, what needs you, then Ideas, Thumbnails, Scripts and Edits,
// then Later and Done; one short list at a time beside it, a place's stages
// as steps over its list. The study portal's sidebar (the user, Oct 31: "i think this is
// way more organised"), after the team's "having to scroll through a long,
// tedious" list of ideas, scripts and edits together.

import { Check, Clock, FileText, Film, Image as ImageIcon, Inbox, Lightbulb, PanelLeftClose, PanelLeftOpen, type LucideIcon } from "lucide-react";
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

/** Closed: the way back, first in the panel's header (it sat alone at the bottom left: "it looks bad down there", Nov 2). */
export function OpenSidebar({ onOpen }: { onOpen: () => void }) {
  return (
    <IconButton label="Show the sidebar" onClick={onOpen} className="-ml-2 size-8 shrink-0">
      <PanelLeftOpen size={17} />
    </IconButton>
  );
}

/** Where an item comes from: an idea (or a board card), a script, an edit. */
export type Section = "ideas" | "scripts" | "edits";

/**
 * A place in the sidebar with stages (Sphe, Nov 2, picking prototype C, then
 * "with videos i do want to split scripting and editing, this is important"):
 * Ideas, Scripts and Edits, each with its stages as steps over its list.
 */
export type Place = Section;

/** Where Home is: what needs you, a place or one of its stages, the thumbnails, Later or Done. */
export type Where = "needs" | "later" | "done" | "thumbnails" | Place | `${Place}:${string}`;

export const PLACES: { key: Place; label: string; icon: LucideIcon; stages: { key: string; label: string }[] }[] = [
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

/** The place an item is listed in: its own. */
export const placeOfSection = (section: Section): Place => section;

/** The place `where` is in (none for Needs you, Thumbnails, Later and Done) and its stage. */
export function placeOf(where: Where): { place: Place | null; stage: string | null } {
  const [place, stage] = where.split(":") as [string, string | undefined];
  return PLACES.some((one) => one.key === place) ? { place: place as Place, stage: stage ?? null } : { place: null, stage: null };
}

/** What `where` is called: "Needs you", "Edits", "Edits / In review". */
export function nameOf(where: Where): { parent: string | null; name: string } {
  const { place, stage } = placeOf(where);
  if (place === null) return { parent: null, name: where === "needs" ? "Needs you" : where === "thumbnails" ? "Thumbnails" : where === "later" ? "Later" : "Done" };
  const found = PLACES.find((one) => one.key === place)!;
  return stage === null ? { parent: null, name: found.label } : { parent: found.label, name: found.stages.find((one) => one.key === stage)?.label ?? stage };
}

export function HomeSidebar({ places, thumbnails, needs, where, onChoose, open, onClose }: { places: Place[]; thumbnails: boolean; needs: number; where: Where; onChoose: (where: Where) => void; open: boolean; onClose: () => void }) {
  // No spring on the first frame: a sidebar remembered closed doesn't open and close as Home appears.
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMoving(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  // A place stays lit on any of its stages (they're steps over its list now).
  const item = (to: Where, label: string, Icon: LucideIcon | null, extra?: string) => {
    const count = to === "needs" ? needs : 0;
    const on = where === to || (placeOf(where).place !== null && placeOf(where).place === to);
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
        {/* The account, and hiding the sidebar beside it at the top (Sphe, Nov 2: Later, Done and the toggle at the bottom left "looks bad"). */}
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <AppMenu row />
          </div>
          <IconButton label="Hide the sidebar" onClick={onClose} className="size-8 shrink-0">
            <PanelLeftClose size={16} />
          </IconButton>
        </div>
        <nav className="mt-4 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pb-2">
          {item("needs", "Needs you", Inbox)}
          {/* Only the places, no stages (Sphe, Nov 2: "the sidebar on the left is MESSY"): Ideas, Thumbnails, Scripts, Edits ("ideas first then thumbnails, scripts edits"). */}
          <div className="mt-2.5 flex flex-col gap-0.5">
            {places.includes("ideas") && item("ideas", "Ideas", Lightbulb)}
            {thumbnails && item("thumbnails", "Thumbnails", ImageIcon)}
            {PLACES.filter((place) => place.key !== "ideas" && places.includes(place.key)).map((place) => item(place.key, place.label, place.icon))}
          </div>
          {/* Set aside and finished: a group of their own just under the places, not pinned to the bottom. */}
          <div className="mt-2.5 flex flex-col gap-0.5">
            {item("later", "Later", Clock)}
            {item("done", "Done", Check)}
          </div>
        </nav>
      </div>
    </motion.aside>
  );
}
