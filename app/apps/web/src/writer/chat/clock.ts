// Repack's parseClock (apps/web/src/domain/transcript.ts), for the chat's footage times.

/** "1:23" or "1:02:03" as seconds; null when it isn't a clock. */
export function parseClock(value: string) {
  if (!/^\d{1,3}(?::\d{2}){1,2}$/.test(value)) return null;
  if (
    value
      .split(":")
      .slice(1)
      .some((part) => Number(part) >= 60)
  )
    return null;
  return value
    .split(":")
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0);
}
