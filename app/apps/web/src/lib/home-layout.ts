// Home's table at a width (components/HomeTable.tsx): which columns it shows
// and how wide, so a name always has room; apart from the table so it's
// checked on its own (home-layout.test.ts).

/** The table's columns at a width, and which it does without. */
export interface Layout {
  columns: string;
  compact: boolean;
  slim: boolean;
  faces: boolean;
}

/** A name gets at least this much before a column goes. */
const NAME_ROOM = 260;
const GAP = 16;
/** A row's padding, which its first and last columns hold. */
const PAD = 24;

/** The most the table can show at `width` (px) and still leave a name its room: name, category, status, by, length, updated, the row's buttons. */
export function layoutFor(width: number, solo: boolean): Layout {
  const steps = [
    // Status as wide as two pills side by side ("Footage missing" and "On Drive ↗"), then narrower, its pills wrapping.
    { compact: false, slim: false, faces: false, status: 236 },
    { compact: true, slim: false, faces: false, status: 236 },
    { compact: true, slim: true, faces: false, status: 236 },
    { compact: true, slim: true, faces: true, status: 236 },
    { compact: true, slim: true, faces: true, status: 180 },
    { compact: true, slim: true, faces: true, status: 148 },
  ];
  const tracksOf = (step: (typeof steps)[number]) => [...(step.slim ? [] : [136]), step.status, ...(solo ? [] : [step.faces ? 36 : 120]), ...(step.compact ? [] : [64]), 76, 76];
  const step = steps.find((one) => {
    const tracks = tracksOf(one);
    return width - PAD - tracks.reduce((sum, track) => sum + track, 0) - tracks.length * GAP >= NAME_ROOM;
  }) ?? steps.at(-1)!;
  return { columns: ["minmax(0,1fr)", ...tracksOf(step).map((px) => `${px}px`)].join(" "), compact: step.compact, slim: step.slim, faces: step.faces };
}
