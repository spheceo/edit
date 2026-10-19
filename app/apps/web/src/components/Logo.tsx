/** The Edit mark: three timeline clips forming an E, cut by a playhead. */
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

export function Logo({ size = 20 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Mark size={size} />
      <span className="text-[15px] font-semibold tracking-[-0.02em] text-fg">Edit</span>
    </span>
  );
}
