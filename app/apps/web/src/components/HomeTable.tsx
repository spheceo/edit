// Home's table, shared by its rows (Home.tsx: edits and scripts; ideas/home.tsx:
// ideas and board cards), in the study portal's look (the user, Oct 31: "take
// a look at the ststudyportal ui and see if you can build it around that"):
// faint column names, rounded rows with no lines between them, outlined
// status pills, the row's buttons on hover, a right click for its menu. And
// Later: a clock on every row sets it aside (Tomorrow, Monday, a week, until
// it's brought back), the Later list's rows bring it back sooner, and on its
// day a row is marked Back until someone opens it.

import { AlarmClock, Captions, Check, Clock, Ellipsis, FileText, Film, Lightbulb, Undo2 } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

import { asideChoices, asleep, backLabel, type Later, type LaterEntry, type LaterKey } from "../lib/later";
import { ago } from "../lib/time";
import { STYLES, type Creator, type Style } from "../lib/types";
import { openMenu, toggleMenu, type MenuItem } from "./ContextMenu";
import { StartedBy } from "./StartedBy";
import { cx } from "./ui";

/** A row takes up the table's columns (subgrid), so they line up row to row. */
export const COLUMNS = "col-span-full grid grid-cols-subgrid items-center";

/** A row: rounded, the hover its only edge (the portal's rows). */
export const ROW = "group min-h-11 cursor-pointer rounded-xl px-3 py-1.5 transition-colors hover:bg-white/[0.035]";

/** A row's name. */
export const NAME = "truncate text-[13.5px] font-medium text-fg/90 group-hover:text-fg";

/** Every status looks alike: an outlined pill in the colour of how much it matters (the portal's). */
export const PILL = "inline-flex h-[22px] min-w-0 shrink-0 items-center gap-1.5 rounded-full border border-current/25 px-2.5 text-[11.5px] leading-none whitespace-nowrap";
export const CHIP = `${PILL} font-medium`;

/** How the table is laid out now: `solo` (Mine: every row is yours, so no By column), `cross` (rows of every kind: each says what it is). */
export const TableShape = createContext<{ solo: boolean; cross: boolean }>({ solo: false, cross: false });

/** Later, as Home has it, for every row. */
export const LaterContext = createContext<Later | null>(null);

/** The table's columns: name, category, status, by (unless solo), length, updated, the row's buttons. */
export function tableColumns(solo: boolean): string {
  return ["minmax(0,1fr)", "minmax(0,8.5rem)", "minmax(0,13rem)", ...(solo ? [] : ["7.5rem"]), "4rem", "5rem", "4.25rem"].join(" ");
}

/** What a row is, before its name where the list mixes kinds (Needs you, Later, Done, a search). */
export function KindMark({ kind }: { kind: "edit" | "subtitles" | "script" | "idea" }) {
  const { cross } = useContext(TableShape);
  if (!cross) return null;
  const [Icon, label] = kind === "script" ? [FileText, "Script"] : kind === "idea" ? [Lightbulb, "Idea"] : kind === "subtitles" ? [Captions, "Subtitled video"] : [Film, "Edit"];
  return (
    <span title={label} className="shrink-0 text-faint">
      <Icon size={14} />
    </span>
  );
}

/** A row's category: its kind of video, "Compilation" after it when it's over several videos ("Bodycam Compilation"); an idea's niche. */
export function Category({ style, compilation = false, text: given }: { style?: Style | null; compilation?: boolean; text?: string }) {
  const label = STYLES.find((option) => option.value === style)?.label ?? "";
  const text = given ?? (compilation ? `${label} Compilation`.trim() : label);
  return (
    <span role="cell" className="truncate text-[13px] text-muted" title={text || undefined}>
      {text}
    </span>
  );
}

/** Who started it: their picture and first name ("Siphesihle Mbuyisa" → Siphesihle); none in Mine, where it's always you. */
export function CreatorCell({ by, projectId }: { by: Creator | null | undefined; projectId?: string }) {
  const { solo } = useContext(TableShape);
  if (solo) return null;
  const name = by?.name.trim() ?? "";
  // An account named by its email shows the part before the @.
  const first = (name.includes("@") && !name.includes(" ") ? name.split("@")[0]! : name).split(/\s+/u)[0] ?? "";
  return (
    <span role="cell" className="flex min-w-0 items-center gap-2 text-[13px] text-muted">
      <StartedBy by={by} projectId={projectId} size={20} placeholder />
      <span className="truncate">{first}</span>
    </span>
  );
}

/** When it was last changed. */
export function Updated({ at, title }: { at: number; title?: string }) {
  return (
    <span role="cell" className="text-[13px] text-muted tabular" title={title}>
      {ago(at)}
    </span>
  );
}

/** In Later: when it comes back, and who set it aside when. */
export function AsideStatus({ entry }: { entry: LaterEntry }) {
  const who = entry.by?.name.split(/\s+/u)[0] ?? "Someone";
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
    <span className={cx(CHIP, "border-info/40 bg-info-soft text-info")} title={`${who} set it aside on ${day(entry.at)}; it's been back since ${day(entry.until!)}. Opening it clears this.`}>
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
  const entry = found !== null && asleep(found) ? found : null;
  const woke = found !== null && entry === null ? found : null;
  const usable = key !== null && later !== null && later.on;
  const choices = (): MenuItem[] => asideChoices().map((choice) => ({ label: choice.label, ...(choice.day ? { detail: choice.day } : {}), onSelect: () => later!.set(key!, choice.until, title) }));
  const items: MenuItem[] = !usable
    ? []
    : entry !== null
      ? [{ label: "Bring back now", icon: <Undo2 size={14} />, onSelect: () => later.back(key, title) }]
      : [
          { label: woke !== null ? "Set aside again" : "Set aside", icon: <Clock size={14} />, submenu: choices() },
          ...(woke !== null ? [{ label: "Clear the Back mark", icon: <Check size={14} />, onSelect: () => later.seen(key) }] : []),
        ];
  const button = !usable ? null : entry !== null ? (
    <button
      onClick={(event) => {
        event.stopPropagation();
        later.back(key, title);
      }}
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-white/[0.09] px-2 text-[12px] font-medium text-secondary opacity-0 transition-[opacity,color,border-color] group-hover:opacity-100 hover:border-white/[0.16] hover:text-fg"
    >
      <Undo2 size={13} /> Bring back
    </button>
  ) : (
    <button
      title="Set aside"
      aria-label={`Set “${title}” aside`}
      onClick={(event) => {
        event.stopPropagation();
        toggleMenu(event.currentTarget, [{ heading: "Set aside until" }, ...choices()], { width: 230 });
      }}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:bg-hover hover:text-fg"
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
    openMenu(event, items, { width });
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
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:bg-hover hover:text-fg"
      >
        <Ellipsis size={15} />
      </button>
    </div>
  );
}
