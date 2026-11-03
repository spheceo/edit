// Home's sidebar (Oct 31 2026; Nov 2, prototype C): the account and the
// hide button, then Ideas, Thumbnails, Scripts and Edits (Needs you went on
// Nov 2), then Later and Done in a card at its foot; one short list at a
// time beside it, a place's stages as steps over its list. The study portal's sidebar (the user, Oct 31: "i think this is
// way more organised"), after the team's "having to scroll through a long,
// tedious" list of ideas, scripts and edits together.

import { Check, Clock, FileText, Film, Image as ImageIcon, Lightbulb, type LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";

import { AppMenu } from "./AppMenu";
import { ExportActivity } from "./ExportActivity";
import { LayoutLeftIcon } from "./HugeIcons";
import { whenBack } from "../lib/time";
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
      <LayoutLeftIcon />
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

/** Where Home is: a place or one of its stages, the thumbnails, Later or Done. */
export type Where = "later" | "done" | "thumbnails" | Place | `${Place}:${string}`;

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

/** The place `where` is in (none for Thumbnails, Later and Done) and its stage. */
export function placeOf(where: Where): { place: Place | null; stage: string | null } {
  const [place, stage] = where.split(":") as [string, string | undefined];
  return PLACES.some((one) => one.key === place) ? { place: place as Place, stage: stage ?? null } : { place: null, stage: null };
}

/** What `where` is called: "Edits", "Edits / In review", "Later". */
export function nameOf(where: Where): { parent: string | null; name: string } {
  const { place, stage } = placeOf(where);
  if (place === null) return { parent: null, name: where === "thumbnails" ? "Thumbnails" : where === "later" ? "Later" : "Done" };
  const found = PLACES.find((one) => one.key === place)!;
  return stage === null ? { parent: null, name: found.label } : { parent: found.label, name: found.stages.find((one) => one.key === stage)?.label ?? stage };
}

/** What's set aside: how many, and the next to come back (its name, and when; none when it waits to be brought back). */
export interface LaterSummary {
  count: number;
  next: { title: string; until: number } | null;
}

export function HomeSidebar({ places, thumbnails, later, done, where, onChoose, open, onClose }: { places: Place[]; thumbnails: boolean; later: LaterSummary; done: number; where: Where; onChoose: (where: Where) => void; open: boolean; onClose: () => void }) {
  // No spring on the first frame: a sidebar remembered closed doesn't open and close as Home appears.
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMoving(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  // A place stays lit on any of its stages (they're steps over its list now).
  const item = (to: Where, label: string, Icon: LucideIcon | null, extra?: string) => {
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
            <LayoutLeftIcon />
          </IconButton>
        </div>
        <nav className="mt-4 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pb-2">
          {/* Only the places, no stages (Sphe, Nov 2: "the sidebar on the left is MESSY"): Ideas, Thumbnails, Scripts, Edits ("ideas first then thumbnails, scripts edits"); Needs you went ("let's remove needs you"). */}
          <div className="flex flex-col gap-0.5">
            {places.includes("ideas") && item("ideas", "Ideas", Lightbulb)}
            {thumbnails && item("thumbnails", "Thumbnails", ImageIcon)}
            {PLACES.filter((place) => place.key !== "ideas" && places.includes(place.key)).map((place) => item(place.key, place.label, place.icon))}
          </div>
        </nav>
        {/*
          The export queue, then what's set aside and finished (Sphe, Nov 2, option 2 of four: "they're important but let's
          think more about them"): Later says how many and when the next comes back, Done how many; each opens its list.
          The queue sits above that card, in the same chrome, and only while something is exporting or still undismissed.
        */}
        <ExportActivity />
        <div className="mb-1 flex flex-col gap-0.5 rounded-xl border border-line bg-panel p-1">
          <button
            onClick={() => onChoose("later")}
            className={cx("flex w-full min-w-0 flex-col rounded-lg px-2 py-1.5 text-left transition-colors", where === "later" ? "bg-active" : "hover:bg-hover")}
          >
            <span className="flex w-full items-center gap-2 text-[13px] font-medium">
              <Clock size={15} className={cx("shrink-0", where === "later" ? "text-fg" : "text-muted")} />
              <span className={cx("min-w-0 flex-1 truncate", where === "later" ? "text-fg" : "text-secondary")}>Later</span>
              {later.count > 0 && <span className="text-[12px] text-faint tabular">{later.count}</span>}
            </span>
            {/* The day, then the name, a line each: on one line the name was cut to "R2: …". */}
            <span className="mt-0.5 block truncate pl-[23px] text-[11.5px] text-faint">
              {later.count === 0 ? "Nothing set aside" : later.next ? `Next back ${whenBack(later.next.until)}` : "None with a date"}
            </span>
            {later.next && (
              <span className="block truncate pl-[23px] text-[11.5px] text-muted" title={later.next.title}>
                {later.next.title}
              </span>
            )}
          </button>
          <button
            onClick={() => onChoose("done")}
            className={cx("flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[13px] font-medium transition-colors", where === "done" ? "bg-active text-fg" : "text-secondary hover:bg-hover hover:text-fg")}
          >
            <Check size={15} className={cx("shrink-0", where === "done" ? "text-fg" : "text-muted")} />
            <span className="min-w-0 flex-1 truncate">Done</span>
            {done > 0 && <span className="text-[12px] text-faint tabular">{done}</span>}
          </button>
        </div>
      </div>
    </motion.aside>
  );
}
