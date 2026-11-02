// Home's table, shared by its rows (Home.tsx: edits and scripts; ideas/home.tsx:
// ideas and board cards): the study portal's layout (the user, Oct 31: "take a
// look at the ststudyportal ui and see if you can build it around that"), in
// Edit's own kit, as the rest of the app (then: "make the theming and colors
// of home and font sizes match the rest of the app"): the kit's list rows (56
// px, a hairline between them), 14 px names and 13 px details, its filled
// status pills, the row's buttons on hover, a right click for its menu. And
// Later: a clock on every row sets it aside (Tomorrow, Monday, a week, until
// it's brought back), the Later list's rows bring it back sooner, and on its
// day a row is marked Back until someone opens it.

import { AlarmClock, Captions, Check, CircleCheck, Clock, Ellipsis, FileText, Film, Lightbulb, Undo2 } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

import { asideChoices, asleep, backLabel, type Later, type LaterEntry, type LaterKey } from "../lib/later";
export { layoutFor } from "../lib/home-layout";
import { ago } from "../lib/time";
import { STYLES, type Creator, type Style } from "../lib/types";
import { openMenu, toggleMenu, type MenuItem } from "./ContextMenu";
import { StartedBy } from "./StartedBy";
import { cx } from "./ui";

/** A row takes up the table's columns (subgrid), so they line up row to row. */
export const COLUMNS = "col-span-full grid grid-cols-subgrid items-center";

/** A row: the kit's list row (56 px, no hairlines: the hover a grey step, rounded); lit too while its menu is open. */
export const ROW = "group min-h-14 cursor-pointer rounded-lg px-3 py-2 transition-colors hover:bg-hover data-[menu-open]:bg-hover has-[[data-menu-open]]:bg-hover";

/** A row's hover button: shown on hover, and kept while its row's menu is open (the user, Oct 31: "when i click on thrree dots then a dropdown the three dots dissaper"). */
const HOVER_BUTTON = "opacity-0 group-hover:opacity-100 group-data-[menu-open]:opacity-100 group-has-[[data-menu-open]]:opacity-100 data-[menu-open]:bg-active data-[menu-open]:text-fg";

/** A row's name: the body size. */
export const NAME = "truncate text-[14px] text-fg";

/** Every status looks alike: the kit's 22 px status pill, filled a grey step up, its words in the colour of how much it matters. */
export const PILL = "inline-flex h-[22px] min-w-0 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] leading-none whitespace-nowrap";
const CHIP_SHAPE = `${PILL} max-w-full overflow-hidden font-medium`;
export const CHIP = `${CHIP_SHAPE} bg-active`;

/** How the table is laid out now: `cross` (rows of every kind: each says what it is). */
export const TableShape = createContext<{ cross: boolean }>({ cross: false });

/** Later, as Home has it, for every row. */
export const LaterContext = createContext<Later | null>(null);

/**
 * Columns the table can do without, hidden (out of the grid) by the table's
 * own switches, which its columns follow too, so a row never has a cell more
 * than the table has columns (one did, its buttons wrapping under its name):
 * By in Mine (data-solo: every row is yours); when the table is narrow,
 * Length (data-compact), then Category (data-slim), then By's names (only
 * the faces, data-faces), then a narrower Status, so a name always has room
 * (the user, Oct 31: "ensure on this new dashboard we have zero ui issues
 * like this"; Edit's window is 960 px wide at the least).
 */
export const BY = "group-data-[solo]/table:hidden";
export const LENGTH = "group-data-[compact]/table:hidden";
export const CATEGORY = "group-data-[slim]/table:hidden";
const BY_NAME = "group-data-[faces]/table:hidden";

/** A row's status: its pills, onto a second line rather than into the next column. */
export function StatusCell({ children }: { children: ReactNode }) {
  return (
    <div role="cell" className="flex min-w-0 flex-wrap items-center gap-1.5 py-0.5">
      {children}
    </div>
  );
}

/** A row's length (an idea's views). */
export function LengthCell({ children, title }: { children?: ReactNode; title?: string }) {
  return (
    <span role="cell" className={cx("flex min-w-0 items-center gap-1.5 truncate text-[13px] text-secondary tabular", LENGTH)} title={title}>
      {children}
    </span>
  );
}

/** What a row is, before its name where the list mixes kinds (Needs you, Later, Done, a search). */
export function KindMark({ kind }: { kind: "edit" | "subtitles" | "script" | "idea" }) {
  const { cross } = useContext(TableShape);
  if (!cross) return null;
  const [Icon, label] = kind === "script" ? [FileText, "Script"] : kind === "idea" ? [Lightbulb, "Idea"] : kind === "subtitles" ? [Captions, "Subtitled video"] : [Film, "Edit"];
  return (
    <span title={label} className="shrink-0 text-muted">
      <Icon size={14} />
    </span>
  );
}

/** A row's category: its kind of video, "Compilation" after it when it's over several videos ("Bodycam Compilation"); an idea's niche. */
export function Category({ style, compilation = false, text: given }: { style?: Style | null; compilation?: boolean; text?: string }) {
  const label = STYLES.find((option) => option.value === style)?.label ?? "";
  const text = given ?? (compilation ? `${label} Compilation`.trim() : label);
  return (
    <span role="cell" className={cx("truncate text-[13px] text-secondary", CATEGORY)} title={text || undefined}>
      {text}
    </span>
  );
}

/** Who started it: their picture and first name ("Siphesihle Mbuyisa" → Siphesihle); none in Mine, where it's always you. */
export function CreatorCell({ by, projectId }: { by: Creator | null | undefined; projectId?: string }) {
  const name = by?.name.trim() ?? "";
  // An account named by its email shows the part before the @.
  const first = (name.includes("@") && !name.includes(" ") ? name.split("@")[0]! : name).split(/\s+/u)[0] ?? "";
  return (
    <span role="cell" className={cx("flex min-w-0 items-center gap-2 text-[13px] text-secondary", BY)}>
      <StartedBy by={by} projectId={projectId} size={20} placeholder />
      <span className={cx("truncate", BY_NAME)}>{first}</span>
    </span>
  );
}

/** When it was last changed. */
export function Updated({ at, title }: { at: number; title?: string }) {
  return (
    <span role="cell" className="truncate text-[13px] text-secondary tabular" title={title}>
      {ago(at)}
    </span>
  );
}

/** In Later: when it comes back, and who set it aside when; in Done, who marked it done. */
export function AsideStatus({ entry }: { entry: LaterEntry }) {
  const who = entry.by?.name.split(/\s+/u)[0] ?? "Someone";
  if (entry.done === true)
    return (
      <span className={cx(CHIP_SHAPE, "bg-success-soft text-success")} title={`${who} marked it done ${ago(entry.at)}`}>
        <Check size={12} />
        Done
      </span>
    );
  return (
    <span className={cx(CHIP, "text-secondary")} title={`Set aside by ${who} ${ago(entry.at)}${entry.until === null ? ", until someone brings it back" : `, until ${backLabel(entry.until)}`}`}>
      <Clock size={12} />
      {entry.until === null ? "No date" : `Back ${backLabel(entry.until)}`}
    </span>
  );
}

/** Back from Later: before its name, until someone opens it (the user, Oct 31: "comes back clearly formatted showing like this was awoken"). */
export function BackMark({ entry }: { entry: LaterEntry }) {
  const who = entry.by?.name.split(/\s+/u)[0] ?? "Someone";
  const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const midnight = new Date().setHours(0, 0, 0, 0);
  const since = entry.until! >= midnight ? "today" : entry.until! >= midnight - 86_400_000 ? "yesterday" : `since ${new Date(entry.until!).toLocaleDateString(undefined, { weekday: "short" })}`;
  return (
    <span className={cx(CHIP_SHAPE, "bg-info-soft text-info")} title={`${who} set it aside on ${day(entry.at)}; it's been back since ${day(entry.until!)}. Opening it clears this.`}>
      <AlarmClock size={12} />
      Back {since}
    </span>
  );
}

/**
 * A row's Later: whether it's set aside (`entry`) or back and not opened yet
 * (`woke`), its menu items, its hover button, and `seen` for its click (once
 * back, opening it clears the Back mark).
 */
export function useAside(key: LaterKey | null, title: string) {
  const later = useContext(LaterContext);
  const found = key !== null && later !== null ? (later.entries.get(key) ?? null) : null;
  const done = found?.done === true;
  // Set aside, or marked done: its status says so.
  const entry = found !== null && (done || asleep(found)) ? found : null;
  const woke = found !== null && entry === null ? found : null;
  const usable = key !== null && later !== null && later.on;
  const choices = (): MenuItem[] => asideChoices().map((choice) => ({ label: choice.label, ...(choice.day ? { detail: choice.day } : {}), onSelect: () => later!.set(key!, choice.until, title) }));
  // Done by hand (the user, Oct 31: "how do i move content to done"): its menu marks it, Done's moves it back.
  const markDone: MenuItem[] = [{ label: "Mark as done", icon: <CircleCheck size={14} />, onSelect: () => later!.done(key!, title) }];
  const items: MenuItem[] = !usable
    ? []
    : done
      ? [{ label: "Move back", icon: <Undo2 size={14} />, onSelect: () => later.moveBack(key, title) }]
      : entry !== null
        ? [{ label: "Bring back now", icon: <Undo2 size={14} />, onSelect: () => later.back(key, title) }, ...markDone]
        : [
            { label: woke !== null ? "Set aside again" : "Set aside", icon: <Clock size={14} />, submenu: choices() },
            ...(woke !== null ? [{ label: "Clear the Back mark", icon: <Check size={14} />, onSelect: () => later.seen(key) }] : []),
            ...markDone,
          ];
  const button = !usable ? null : entry !== null ? (
    <button
      title={done ? "Move back" : "Bring back now"}
      aria-label={done ? `Move “${title}” back` : `Bring “${title}” back now`}
      onClick={(event) => {
        event.stopPropagation();
        if (done) later.moveBack(key, title);
        else later.back(key, title);
      }}
      className={cx("flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-[opacity,color] hover:bg-active hover:text-fg", HOVER_BUTTON)}
    >
      <Undo2 size={14} />
    </button>
  ) : (
    <button
      title="Set aside"
      aria-label={`Set “${title}” aside`}
      onClick={(event) => {
        event.stopPropagation();
        toggleMenu(event.currentTarget, [{ heading: "Set aside until" }, ...choices()], { width: 230 });
      }}
      className={cx("flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-[opacity,color] hover:bg-active hover:text-fg", HOVER_BUTTON)}
    >
      <Clock size={14} />
    </button>
  );
  const seen = () => {
    if (woke !== null && later !== null) later.seen(key!);
  };
  return { entry, woke, items, button, seen };
}

/** A row's own menu items with Later's before its last part (Delete, after its separator). */
export function withAside(own: MenuItem[], aside: MenuItem[]): MenuItem[] {
  if (aside.length === 0) return own;
  const cut = own.findLastIndex((item) => "separator" in item);
  return cut < 0 ? [...own, { separator: true }, ...aside] : [...own.slice(0, cut), { separator: true }, ...aside, ...own.slice(cut)];
}

/** The row's menu where it was right-clicked. */
export function contextMenu(items: MenuItem[], width = 200) {
  return (event: React.MouseEvent) => {
    if (items.length === 0) return;
    event.stopPropagation();
    openMenu(event, items, { width, owner: event.currentTarget });
  };
}

/** A row's buttons, shown on hover: Later's clock (or Bring back), then its ⋯. */
export function RowButtons({ aside, items, width = 200 }: { aside: ReactNode; items: MenuItem[]; width?: number }) {
  return (
    <div role="cell" className="flex items-center justify-end gap-0.5">
      {aside}
      <button
        title="More"
        onClick={(event) => {
          event.stopPropagation();
          toggleMenu(event.currentTarget, items, { width });
        }}
        className={cx("flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-[opacity,color] hover:bg-active hover:text-fg", HOVER_BUTTON)}
      >
        <Ellipsis size={15} />
      </button>
    </div>
  );
}
