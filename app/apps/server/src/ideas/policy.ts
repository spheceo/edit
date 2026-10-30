// What an idea's titles, thumbnail guide and summary keep to, checked in code
// as well as asked for in the craft (agent/ideas/interrogation.md): the
// channel's banned word and punctuation, never a quoted spoken line, the
// length the team's approved titles run (Repack's titleLengthStyle), one title
// never twice. A tool refuses what breaks them and says why, so Claude fixes
// it in the same turn.

/** A title's words. */
export const wordsIn = (title: string): number => title.trim().split(/\s+/).filter(Boolean).length;

/** One title's identity: two titles differing only in case or punctuation are the same title. */
export const identity = (title: string): string => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export type LengthStyle = {
  sampleSize: number;
  typicalWords: [number, number];
  typicalCharacters: [number, number];
  maxWords: number;
  maxCharacters: number;
};

/** The usual and longest lengths of the approved titles, unusually long ones left out (Repack's titleLengthStyle). */
export function lengthStyle(examples: string[]): LengthStyle | null {
  const unique = new Map<string, string>();
  for (const value of examples) {
    const title = value.trim().replace(/\s+/g, " ");
    if (/\p{L}/u.test(title)) unique.set(title.toLowerCase(), title);
  }
  const titles = [...unique.values()];
  if (titles.length === 0) return null;
  const words = titles.map(wordsIn).sort((a, b) => a - b);
  const characters = titles.map((title) => title.length).sort((a, b) => a - b);
  const at = (values: number[], fraction: number) => values[Math.floor((values.length - 1) * fraction)]!;
  return {
    sampleSize: titles.length,
    typicalWords: [at(words, 0.25), at(words, 0.75)],
    typicalCharacters: [at(characters, 0.25), at(characters, 0.75)],
    maxWords: at(words, titles.length < 3 ? 1 : 0.9),
    maxCharacters: Math.min(120, at(characters, titles.length < 3 ? 1 : 0.9)),
  };
}

/** A title as written: no bullet or number before it, no quotes or backticks around it, one space between words. */
export function cleanTitle(title: string): string {
  return title
    .trim()
    .replace(/^(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/^[`"“”]+|[`"“”]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** What's wrong with a title, or null. */
export function titleProblem(title: string, style: LengthStyle | null): string | null {
  const text = title.trim();
  if (text === "") return "is empty";
  if (/^(?:case|titles?|niche|thumbnail(?: guide)?|summary)\s*:/i.test(text)) return "is a label, not a title";
  if (/s\W*u\W*i\W*c\W*i\W*d/i.test(text)) return "uses the word suicide, which a title never does (write from the people, the scene, the discovery or the consequence)";
  // Compound hyphens (18-Year-Old, Ex-Girlfriend) are fine; a dash splitting the title never is.
  if (/[–—]/.test(text) || /\s-|-\s/.test(text)) return "is split with a dash";
  for (const quoted of text.matchAll(/["“”]([^"“”]+)["“”]|(?:^|\s)['‘]([^'’]+)['’](?=[\s,.!?]|$)/g)) {
    if (wordsIn(quoted[1] ?? quoted[2] ?? "") > 3) return "quotes a spoken line (drop the quote and keep the rest of the sentence)";
  }
  const maxCharacters = style?.maxCharacters ?? 120;
  if (text.length > maxCharacters) return `is ${text.length} characters; the team's approved titles run to ${maxCharacters}`;
  if (style !== null && wordsIn(text) > style.maxWords) return `is ${wordsIn(text)} words; the team's approved titles run to ${style.maxWords}`;
  return null;
}

/** A thumbnail guide as the board writes it: the note's first letter lowercase. */
export function cleanGuide(guide: string): string {
  const text = guide.trim().replace(/\s+/g, " ");
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** What's wrong with a thumbnail guide, or null. */
export function guideProblem(guide: string): string | null {
  const text = guide.trim();
  if (text === "") return "is empty";
  if (text.length > 600) return "is over 600 characters: write the note, not a brief";
  if (text.split(/(?<=[.!?])\s+(?=\S)/).filter((one) => one.trim() !== "").length > 2) return "is more than a sentence or two";
  // Acronyms (POV, CCTV, GPS) are fine; a capitalized word is a name or a sentence's start.
  const named = text.match(/\b[A-Z][a-z]+\b/g);
  if (named !== null) return `has ${named.slice(0, 3).join(", ")} in capitals: write it in lowercase, and name people by role, age or "the suspect", never by name`;
  return null;
}

/** What's wrong with a summary, or null. */
export function summaryProblem(summary: string): string | null {
  const text = summary.trim();
  if (text === "") return "is empty";
  if (wordsIn(text) > 30) return `is ${wordsIn(text)} words; a summary is one sentence of 30 words or fewer`;
  if (text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).filter((one) => one.trim() !== "").length > 1) return "is more than one sentence";
  return null;
}

// ---------------------------------------------------------------- closest titles

const STOP = new Set([
  "the", "a", "an", "and", "or", "to", "in", "on", "at", "by", "for", "from", "with", "of", "his", "her", "their", "she", "he", "they",
  "this", "that", "after", "before", "while", "then", "was", "were", "is", "are", "it", "as", "into", "out", "not", "just", "how",
  "police", "interrogation", "interview", "full", "video", "footage", "bodycam",
]);

/** A word's stem as Sphe Research's title references grouped them. */
function normal(word: string): string {
  if (/^(steal|stole|stolen|shoplift|thief|theft)/.test(word)) return "theft";
  if (/^(beat|beaten)/.test(word)) return "beat";
  if (/^(attack|assault|abuse|abus)/.test(word)) return "assault";
  if (/^tortur/.test(word)) return "torture";
  if (/^stab/.test(word)) return "stab";
  if (/^(kill|murder)/.test(word)) return "kill";
  if (/^(abandon|neglect)/.test(word)) return "neglect";
  if (/^(kidnap|abduct)/.test(word)) return "kidnap";
  if (/^(kid|child|children|toddler|baby|babies|newborn|infant)/.test(word)) return "child";
  if (/^(mom|mother|mum)/.test(word)) return "mother";
  if (/^(dad|father)/.test(word)) return "father";
  if (/^(wife|husband|spouse)/.test(word)) return "spouse";
  if (/^(girlfriend|boyfriend|fianc)/.test(word)) return "partner";
  if (/^(cop|cops|officer|deputy|detective|sheriff)/.test(word)) return "officer";
  if (/^(teen|teenager|year)/.test(word)) return word.startsWith("teen") ? "teen" : word;
  return word.replace(/(?:ing|ed|s)$/, "");
}

function terms(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !STOP.has(word))
      .map(normal),
  );
}

const ACTIONS = new Set(["theft", "beat", "assault", "torture", "stab", "kill", "neglect", "kidnap", "shoot", "drown", "poison", "crash"]);
const ROLES = new Set(["mother", "father", "spouse", "partner", "child", "teen", "officer"]);

/**
 * The approved titles closest to a case (its source's title and the start of
 * its description), most alike first: rare shared words count more, the act
 * most, and a family relationship the case doesn't name never pulls a title
 * in (Sphe Research's closestTitleReferences, on the board's approved titles).
 */
export function closest(titles: string[], sourceTitle: string, description = "", limit = 12): string[] {
  const indexed = titles.map((title) => ({ title, words: terms(title) }));
  const frequency = new Map<string, number>();
  for (const { words } of indexed) for (const word of words) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const fromTitle = terms(sourceTitle);
  const query = new Set([...fromTitle, ...terms(description.slice(0, 280))]);
  const acts = [...fromTitle].filter((word) => ACTIONS.has(word));
  return indexed
    .map(({ title, words }) => {
      let score = 0;
      for (const word of query) {
        if (!words.has(word)) continue;
        const weight = Math.log((indexed.length + 1) / ((frequency.get(word) ?? 0) + 1)) + 1;
        score += weight * (ROLES.has(word) ? 1.3 : 1) * (fromTitle.has(word) ? 2 : 0.35);
      }
      for (const act of acts) if (words.has(act)) score += 8;
      const borrowed = ["mother", "father"].some((relationship) => words.has(relationship) && !query.has(relationship));
      return { title, score: borrowed ? score / 3 : score };
    })
    .filter((one) => one.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((one) => one.title);
}
