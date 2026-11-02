// Home's sidebar (Oct 31 2026; Nov 2, prototype C): what needs you, then
// Ideas, Videos and Thumbnails, then Later and Done at its foot; one short
// list at a time beside it, a place's stages as steps over its list. The study portal's sidebar (the user, Oct 31: "i think this is
// way more organised"), after the team's "having to scroll through a long,
// tedious" list of ideas, scripts and edits together.

import { Check, Clock, Image as ImageIcon, Inbox, Lightbulb, PanelLeftClose, PanelLeftOpen, Video, type LucideIcon } from "lucide-react";
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

/** Where an item comes from: an idea (or a board card), a script, an edit. */
export type Section = "ideas" | "scripts" | "edits";

/**
 * A place in the sidebar with stages (Sphe, Nov 2, picking prototype C):
 * Ideas, and Videos, a video's whole way from its import to its review in one
 * list (scripts and edits were two places for one handoff: Ready to edit and
 * Editing).
 */
export type Place = "ideas" | "videos";

/** Where Home is: what needs you, a place or one of its stages, the thumbnails, Later or Done. */
export type Where = "needs" | "later" | "done" | "thumbnails" | Place | `${Place}:${string}`;

export const PLACES: { key: Place; label: string; icon: LucideIcon; stages: { key: string; label: string }[] }[] = [
  { key: "ideas", label: "Ideas", icon: Lightbulb, stages: [{ key: "drafts", label: "Drafts" }, { key: "board", label: "On the board" }] },
  {
    key: "videos",
    label: "Videos",
    icon: Video,
    // A video's way, in order: the script's (the user, Oct 30: "know which projects are ready to script"), then the edit's.
    stages: [
      { key: "importing", label: "Importing" },
      { key: "toscript", label: "Ready to script" },
      { key: "scripting", label: "Scripting" },
      { key: "ready", label: "Ready to edit" },
      { key: "editing", label: "Editing" },
      { key: "review", label: "In review" },
      { key: "subtitled", label: "Subtitled" },
    ],
  },
];

/** The place an item is listed in: ideas in Ideas, scripts and edits in Videos. */
export const placeOfSection = (section: Section): Place => (section === "ideas" ? "ideas" : "videos");

/** The place `where` is in (none for Needs you, Thumbnails, Later and Done) and its stage. */
export function placeOf(where: Where): { place: Place | null; stage: string | null } {
  const [place, stage] = where.split(":") as [string, string | undefined];
  return PLACES.some((one) => one.key === place) ? { place: place as Place, stage: stage ?? null } : { place: null, stage: null };
}

/** What `where` is called: "Needs you", "Videos", "Videos / In review". */
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
        <AppMenu row />
        <nav className="mt-4 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pb-2">
          {item("needs", "Needs you", Inbox)}
          {/* Only the places, no stages (Sphe, Nov 2: "the sidebar on the left is MESSY"): Ideas, Videos, Thumbnails. */}
          <div className="mt-2.5 flex flex-col gap-0.5">
            {PLACES.filter((place) => places.includes(place.key)).map((place) => item(place.key, place.label, place.icon))}
            {thumbnails && item("thumbnails", "Thumbnails", ImageIcon)}
          </div>
          <div className="flex-1" />
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
