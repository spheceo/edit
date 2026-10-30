import { useEffect, useState } from "react";

/**
 * Whether `on` has been true for `ms`. A send button that turns into Stop in
 * the same place caught the second click of a double-click, or a click on a
 * send that seemed slow, and stopped the work just asked for (Oct 30: "Claude
 * stopped: Stopped by you", twice, on builds nobody stopped).
 */
export function useSettled(on: boolean, ms = 1500): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    if (!on) return;
    const timer = window.setTimeout(() => setSettled(true), ms);
    return () => window.clearTimeout(timer);
  }, [on, ms]);
  return on && settled;
}
