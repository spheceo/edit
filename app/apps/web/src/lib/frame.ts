// Many changes, one store update a frame: the events socket can bring
// hundreds of media statuses or streamed words in a moment, and a store
// update for each made React render (and commit) once per message (Nov 8:
// "503 store changes in a quarter of a second" and React's #185 as a turn
// ended, on Marc's Mac).

/**
 * `flush` once on the next animation frame however often `schedule` is
 * called meanwhile; within `latest` ms when frames stop (a hidden tab), so
 * the page is up to date when it's looked at again.
 */
export function perFrame(flush: () => void, latest = 100): { schedule: () => void; flush: () => void } {
  let asked = false;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    if (!asked) return;
    asked = false;
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(timer);
    frame = 0;
    flush();
  };
  return {
    schedule: () => {
      if (asked) return;
      asked = true;
      if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(run);
      timer = setTimeout(run, latest);
    },
    flush: run,
  };
}
