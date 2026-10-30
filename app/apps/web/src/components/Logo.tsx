/** The Edit mark: three timeline clips forming an E, cut by a playhead (the bare glyph). */
export function Mark({ size = 20, cut = "#000" }: { size?: number; cut?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect x="8" y="16" width="46" height="9.5" rx="3" fill="#5b8cff" />
      <rect x="8" y="29" width="30" height="9.5" rx="3" fill="#ff4f9a" />
      <rect x="8" y="42" width="46" height="9.5" rx="3" fill="#ffc23d" />
      <path
        d="M40.5 6.5h9a1.5 1.5 0 0 1 1.5 1.5v4.2a2 2 0 0 1-.6 1.4L47.2 17v39.5h-4.4V17l-3.2-3.4a2 2 0 0 1-.6-1.4V8a1.5 1.5 0 0 1 1.5-1.5z"
        fill={cut}
      />
      <path
        d="M41.5 8h7a.5.5 0 0 1 .5.5v3.4a1 1 0 0 1-.3.7L46 15.4V55a1 1 0 0 1-2 0V15.4l-2.7-2.8a1 1 0 0 1-.3-.7V8.5a.5.5 0 0 1 .5-.5z"
        fill="#fff"
      />
    </svg>
  );
}

/** The mark on its tile, as every spheceo app shows its own (design/kit/icons/edit/mark.svg): 22 px in a header, 56 on the sign-in, 64 in an empty state. */
export function Tile({ size = 22 }: { size?: number }) {
  return <img src="/edit-mark.svg" width={size} height={size} alt="" aria-hidden className="block shrink-0" />;
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Tile size={size} />
      <span className="text-[15px] font-semibold tracking-[-0.01em] text-fg">Edit</span>
    </span>
  );
}

/**
 * Edit's loader: the mark at work, its three clips stretching and settling in
 * turn while the playhead sweeps across them (the user, Oct 30: "a much nicer
 * themed animating spinner"). With what's loading said under it, for a page
 * that's opening.
 */
export function Loader({ size = 40, label }: { size?: number; label?: string }) {
  return (
    <span role="status" className="inline-flex flex-col items-center gap-3">
      <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className="edit-loader overflow-visible">
        <rect className="loader-clip" x="8" y="16" width="46" height="9.5" rx="3" fill="#5b8cff" />
        <rect className="loader-clip loader-clip-2" x="8" y="29" width="30" height="9.5" rx="3" fill="#ff4f9a" />
        <rect className="loader-clip loader-clip-3" x="8" y="42" width="46" height="9.5" rx="3" fill="#ffc23d" />
        <g className="loader-head">
          <path d="M41.5 8h7a.5.5 0 0 1 .5.5v3.4a1 1 0 0 1-.3.7L46 15.4V55a1 1 0 0 1-2 0V15.4l-2.7-2.8a1 1 0 0 1-.3-.7V8.5a.5.5 0 0 1 .5-.5z" fill="#fff" />
        </g>
      </svg>
      {label && <span className="text-[13px] text-muted">{label}</span>}
    </span>
  );
}
