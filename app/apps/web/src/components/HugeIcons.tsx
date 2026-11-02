// Icons from Hugeicons' free stroke-rounded set (MIT, @hugeicons/core-free-icons
// 4.4.0): their shapes on the 24 px grid, in the current colour, drawn at the
// size and stroke of the Lucide icons beside them (15 px, a 2-unit stroke, so
// 1.25 px on screen). As shipped (1.5 units) at 18 px it looked "HUGE compared
// to the others" and "dithered" (Sphe, Nov 2): a 1.1 px line among 1.25 px ones.
// Only those Edit uses, copied in, rather than the whole package. The sidebar's
// toggle is the first (Sphe, Nov 2, of eight Hugeicons options: "i like 4. for
// the sidebar").

/** Hugeicons' layout-left: a panel with its left pane, to hide and show Home's sidebar. */
export function LayoutLeftIcon({ size = 15, strokeWidth = 2, className }: { size?: number; strokeWidth?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12C2.5 7.52166 2.5 5.28248 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
      />
      <path d="M9 21.5L9 2.5" stroke="currentColor" strokeLinecap="round" strokeWidth={strokeWidth} />
    </svg>
  );
}
