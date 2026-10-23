/** HH:MM:SS:FF at `fps`; an NTSC rate (23.976) counts at its whole rate (24), as non-drop-frame timecode does. */
export function timecode(frame: number, fps: number) {
  const f = Math.max(0, Math.floor(frame));
  const base = Math.max(1, Math.round(fps));
  const totalSeconds = Math.floor(f / base);
  const ff = f % base;
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(hh)}:${two(mm)}:${two(ss)}:${two(ff)}`;
}

/** Short human duration: 4.2s, 1:05, 1:02:03. */
export function shortDuration(seconds: number) {
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

export function ago(ms: number) {
  const seconds = (Date.now() - ms) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  // The kit's wording: "3d ago" within the week, then "Oct 21".
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
