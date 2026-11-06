/**
 * Words that say work wasn't got to, not that it can't be done ("Not done:
 * zoom-out freeze not yet fixed", "not reached this turn"). Nov 6, JJ's four
 * reviews on Sphe's Mac: the agents fixed 41 of 110 notes and left the other
 * 69 with feedback_unfixed reasons like these.
 */
export function putOff(reason: string): boolean {
  return /^\W*not (done|changed|checked|fixed|reached|adjusted|built|touched|looked at)\b|this turn|\bnot (yet|reached)\b|wasn['’]?t reached|\bstill (needs?|to (do|be)|open)\b|didn['’]?t get to|ran out of|next turn|for later|\btimed? ?out\b|dropped out|needs? doing|\bweren['’]?t touched\b|\bisn['’]?t built\b/i.test(reason);
}

/**
 * The items a turn's last message lists as not got to: each line under a
 * heading that says so ("**Still open:**", "**Not done or not working**"), up
 * to the next heading, and any other item that says so itself. Nov 6, the
 * horror edit: a chat message with 22 of the team's notes, and two turns in a
 * row ended after 6–8 minutes with half of them under "Still open".
 */
export function leftOver(text: string): string[] {
  const left: string[] = [];
  // A line of prose that says so ("I only got part of the notes done…") counts only when no item does.
  const loose: string[] = [];
  let under = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const bullet = /^([-*•]|\d+[.)])\s+/.test(line);
    if (!bullet) {
      // A heading (its own line, bold or ending in a colon) starts a section: one that says "not done" collects its items.
      if (/^\*\*[^*]+\*\*:?$|^#+\s|:$/.test(line)) {
        under = putOff(line) || /^\W*(not done|still open|open|left|what['’]?s left|to do)\b/i.test(line);
        continue;
      }
      if (putOff(line)) loose.push(line);
      continue;
    }
    if (under || putOff(line)) left.push(line.replace(/^([-*•]|\d+[.)])\s+/, ""));
  }
  return left.length > 0 ? left : loose;
}
