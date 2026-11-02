// What an idea's titles, thumbnail guide and summary keep to, checked in code
// as well as asked for in the craft (agent/ideas/<workspace>.md, Repack's): the
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

/**
 * A title as written: no bullet or number before it, no quotes or backticks
 * around the whole of it (a quoted word in it stays: "“Perfect” Mom Has No
 * Idea…"; Nov 1, `"Chill" 16-Year-Old…` lost its first quote), one space
 * between words.
 */
export function cleanTitle(title: string): string {
  let text = title.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, "").trim();
  for (;;) {
    const wrapped = /^([`"“”'])(.*)([`"“”'])$/su.exec(text);
    if (wrapped === null || /[`"“”]/u.test(wrapped[2]!)) break;
    text = wrapped[2]!.trim();
  }
  return text.replace(/\s+/g, " ").trim();
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

/** What's wrong with a thumbnail guide, or null: Repack's form, lowercase edits to the base and its caption in quotes. */
export function guideProblem(guide: string, frames = 0): string | null {
  const text = guide.trim();
  if (text === "") return "is empty";
  // A frame of the video taken is a line of its own ("use the frame at 1:05 as the base.", "take the father from the frame at 4:12.").
  const most = 600 + 120 * frames;
  if (text.length > most) return `is over ${most} characters: write the editor's instructions, not a brief`;
  // The caption ("change the current “CAUGHT” text to “HE KNEW”") is in quotes, its own capitals.
  const outside = text.replace(/[“"][^”"]*[”"]/g, "");
  if (outside.split(/(?<=[.!?])\s+(?=\S)/).filter((one) => one.trim() !== "").length > 4 + frames) return "is more than where the subject's picture comes from, the subject, the scene and the caption";
  // Acronyms (POV, CCTV, GPS) are fine; a capitalized word is a name or a sentence's start.
  const named = outside.match(/\b[A-Z][a-z]+\b/g);
  if (named !== null) return `has ${named.slice(0, 3).join(", ")} in capitals: write it in lowercase (only the caption, in quotes, keeps its own)`;
  // On an approved thumbnail's base, never; on a frame of the video, the bodycam's angle may need moving to show the
  // subject (Sphe, Nov 2: "move the camera angle up so that we can see the upper body of the mom and baby").
  if (frames === 0 && /\b(?:crop|close-?up|camera angle|lighting|lens|zoom)\b/i.test(outside)) return "gives camera, crop or lighting directions, which a guide never does";
  // "for thumbnails we shouldnt have faces blurred": a person is described as they should look.
  if (/\bblurr(?:ed|y|ing)\b/i.test(outside)) return "has someone blurred, and thumbnails never have blurred faces: describe them as they should look (“holding the baby”)";
  // Sphe, Nov 2: "we never want subjects looking into the camera, instead we have them "look into the eyes of the POV" or "look just above the camera"".
  if (/\b(?:look|looks|looking|stare|stares|staring|gaze|gazes|gazing)\s+(?:straight\s+|directly\s+|right\s+)?(?:in(?:to)?|at|down)\s+(?:the\s+)?(?:camera|lens|viewer)\b/i.test(outside))
    return "has the subject looking into the camera, which the team never wants: have them “look into the eyes of the POV” or “look just above the camera”";
  // "instead of mid-sentance we can say "with her mouth a bit open, almost like she is talking"": what the editor can make.
  if (/\bmid-?sentence\b/i.test(outside)) return "says mid-sentence: say what the editor can make (“with her mouth a bit open, almost like she is talking”)";
  // "no need to say, remove subtitles or remove overlays as we do this anyway".
  if (/\b(?:remove|delete|take out|hide|blur|clean up)\b[^.]*\b(?:subtitles?|captions?|overlays?|watermarks?|timestamps?|logos?)\b/i.test(outside))
    return "says to remove the video's subtitles or overlays: the editor always does, so leave it out";
  // "we rarely ever have all caps for our text and we rarely ever have text to begin with": a caption Claude adds is in its words' own case.
  for (const added of text.matchAll(/\b(?:add|to)\s+[“"]([^”"]+)[”"]/gi)) {
    const words = added[1]!;
    if (/[A-Z].*[A-Z]/.test(words) && words === words.toUpperCase()) return `adds “${words}” in capitals: the team rarely writes text in all caps (“${words.charAt(0) + words.slice(1).toLowerCase()}”), and most thumbnails have none`;
  }
  return null;
}

/**
 * Whether the guide says where the editor gets the subject's picture, as the
 * tool was told: "take the woman from the original thumbnail" or "find an
 * image of the woman" (the user, Nov 1).
 */
export function sourceProblem(guide: string, from: "case_thumbnail" | "find" | "video"): string | null {
  const text = guide.toLowerCase();
  if (from === "video") return /\b(?:first|second|third|fourth) frame\b/.test(text) ? null : "doesn't say which frame the subject comes from (“take the father from the second frame.”)";
  if (from === "case_thumbnail") return /\bfrom the original thumbnail\b/.test(text) ? null : "doesn't say to take the subject from the original thumbnail (“take the woman from the original thumbnail.”)";
  return /\bfind (?:an? )?(?:image|picture|photo) of\b/.test(text) ? null : "doesn't say to find an image of the subject (“find an image of the woman.”)";
}

/** How the card's frames are named, in the order they're shown. */
export const ORDINALS = ["first", "second", "third", "fourth"] as const;

/**
 * Whether the guide names each frame it takes by its place on the card ("the
 * first frame", "the second frame"), and only those (Sphe, Nov 2: "it should
 * rather say, "use the first frame here..." it should know the order in which
 * the frames will be shown"): never by its time.
 */
export function framesProblem(guide: string, count: number): string | null {
  const text = guide.toLowerCase();
  if (/\bframes? at \d/.test(text)) return "names a frame by its time: name it by its place on the card (“use the first frame as the base.”, “take the father from the second frame.”)";
  const names = ORDINALS.slice(0, count);
  const missing = names.filter((one) => !new RegExp(`\\b${one} frame\\b`).test(text));
  if (missing.length > 0) return `doesn't say what the ${missing[0]} frame is for (“use the first frame as the base.” or “take the father from the ${missing[0]} frame.”)`;
  const extra = ORDINALS.slice(count).find((one) => new RegExp(`\\b${one} frame\\b`).test(text));
  if (extra !== undefined) return `names the ${extra} frame, but the card has ${count === 1 ? "one frame" : `${count} frames`}`;
  return null;
}

/** What's wrong with a summary, or null (Repack's: one compact paragraph of 35–55 words, at most three sentences). */
export function summaryProblem(summary: string): string | null {
  const text = summary.trim();
  if (text === "") return "is empty";
  if (/\n\s*\n/.test(text)) return "is more than one paragraph";
  if (wordsIn(text) > 65) return `is ${wordsIn(text)} words; a summary is one compact paragraph of 35–55`;
  if (text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).filter((one) => one.trim() !== "").length > 3) return "is more than three sentences";
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
