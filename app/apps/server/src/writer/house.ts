// What Writer's house rules (agent/writer/house.md) ask of a script's
// narration that a reading can find: outros short and final, cut-ins in their
// length, no addresses, care with harm and children, no narrated flashbacks,
// varied transitions, dated case openings, and people introduced by full name
// before an outro. One line each, said as the team's notes say it. The
// footage checks (intro clips) are with the team's in build.ts `teamFlags`.

import type { Clip, Script } from "@edit/types/writer";

import { isAlphanumeric, splitWhitespace } from "../rust.ts";
import { isCutIn } from "./blocks.ts";

/** An outro's most words: one or two sentences. */
export const OUTRO_WORDS = 45;
/** A FOIA cut-in's most words, and a case opening's. */
export const CUT_IN_WORDS = 65;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const STREETS = ["street", "avenue", "ave", "lane", "ln", "road", "rd", "drive", "boulevard", "blvd", "parkway"];
const BUSINESSES = ["inn", "motel", "hotel", "school", "elementary"];
const NUMBERED = ["room", "apartment", "apt", "unit", "suite"];
const CARE = ["pornography", "porn", "abuse", "abused", "abusing", "rape", "raped", "raping", "sexual", "sexually", "molestation", "molested", "exploitation"];
const YOUNG = ["child", "children", "minor", "minors"];
const BLOWS = ["punched", "punching", "punch", "slapped", "slapping", "slap", "kicked", "kicking", "choked", "choking", "strangled", "strangling", "beaten", "stomped"];
const TELLING = ["to understand how", "to understand why", "it helps to go back", "let's go back", "let us go back", "let's rewind", "rewind to"];
/** A pair of capitalised words ending in one of these is a place or body, not a person. */
const NOT_PEOPLE = [
  "county", "city", "jail", "court", "police", "department", "office", "state", "prison", "school", "hospital", "university", "inn", "sheriff", "sheriff's",
  "township", "district", "center", "centre", "unit", "division", "attorney",
];
const ROLES = ["deputy", "officer", "detective", "sergeant", "investigator", "trooper", "lieutenant", "dispatcher", "speaker", "narrator", "unknown"];
const NAME_OPENERS = ["In", "The", "On", "By", "After", "A", "An", "Both", "His", "Her"];

/** The words of a text, bare of punctuation at their ends (apostrophes kept). */
export function wordsOf(text: string): string[] {
  return splitWhitespace(text)
    .map((word) => {
      const chars = [...word];
      const keep = (c: string) => isAlphanumeric(c) || c === "'";
      let start = 0;
      let end = chars.length;
      while (start < end && !keep(chars[start]!)) start++;
      while (end > start && !keep(chars[end - 1]!)) end--;
      return chars.slice(start, end).join("");
    })
    .filter((word) => word !== "");
}

const lower = (words: string[]): string[] => words.map((word) => word.toLowerCase());

function capital(word: string): boolean {
  const first = [...word][0];
  return first !== undefined && first !== first.toLowerCase() && first === first.toUpperCase();
}

function quote(text: string): string {
  const chars = [...text];
  return chars.length > 60 ? `"${chars.slice(0, 60).join("")}…"` : `"${text}"`;
}

/** An address, a room or a named school, hotel or business in a cut-in. */
export function places(text: string): string[] {
  const said = wordsOf(text);
  const low = lower(said);
  const found: string[] = [];
  for (let index = 1; index < said.length; index++) {
    const word = low[index]!.replace(/\.+$/, "");
    const before = said[index - 1]!;
    if (STREETS.includes(word) && capital(before) && capital(said[index]!)) {
      const start = index >= 2 && capital(said[index - 2]!) ? index - 2 : index - 1;
      found.push(said.slice(start, index + 1).join(" "));
    }
    if (BUSINESSES.includes(word) && capital(said[index]!) && capital(before) && !NOT_PEOPLE.includes(low[index - 1]!)) {
      const start = index >= 2 && capital(said[index - 2]!) && low[index - 2] !== "the" ? index - 2 : index - 1;
      found.push(said.slice(start, index + 1).join(" "));
    }
    if (NUMBERED.includes(low[index - 1]!) && /^[0-9A-Z]+$/.test(said[index]!) && /\d/.test(said[index]!)) found.push(`${said[index - 1]} ${said[index]}`);
  }
  return found;
}

/** "child pornography", "abuse of a child": a care word within two words of a child. */
export function childPairs(text: string): string[] {
  const low = lower(wordsOf(text));
  const found: string[] = [];
  for (const [index, word] of low.entries()) {
    if (!YOUNG.includes(word)) continue;
    const near = low.slice(Math.max(index - 3, 0), Math.min(index + 3, low.length));
    if (near.some((one) => CARE.includes(one))) found.push(near.join(" "));
  }
  return found;
}

const careWords = (text: string): number => lower(wordsOf(text)).filter((word) => CARE.includes(word)).length;

/** Harm told by the blow: "hit in the head", "punched her". */
export function blows(text: string): string[] {
  const low = lower(wordsOf(text));
  const found: string[] = [];
  for (const [index, word] of low.entries()) {
    const next = low[index + 1] ?? "";
    // "beating her", never a heart "beating again".
    const hit = ["hit", "hitting", "struck", "beating", "beat"].includes(word) && ["in", "her", "him", "them", "the", "his", "their"].includes(next);
    if (hit || BLOWS.includes(word)) found.push(low.slice(index, Math.min(index + 3, low.length)).join(" "));
  }
  return found;
}

/** A month or a year: what a case opening's date needs. */
export function hasDate(text: string): boolean {
  return lower(wordsOf(text)).some((word) => MONTHS.includes(word) || /^(19|20)\d{2}$/.test(word));
}

/** The people the footage names, by full name: the transcript's speakers and named suspects. */
function people(script: Script): string[][] {
  const out: string[][] = [];
  for (const given of [...Object.values(script.speakers ?? {}), ...(script.suspects ?? [])]) {
    const name = (given.split("(")[0] ?? "").trim();
    const parts = splitWhitespace(name);
    if (parts.length < 2 || !parts.every(capital) || NOT_PEOPLE.includes(parts.at(-1)!.toLowerCase())) continue;
    if (ROLES.includes(parts[0]!.toLowerCase())) continue;
    if (!out.some((kept) => kept.join(" ") === parts.join(" "))) out.push(parts);
  }
  return out;
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** The flags, one line each. `purposes` is each cut-in's, in order (build.ts `purposes`). */
export function textFlags(script: Script, clips: Clip[], purposes: string[], compilation: boolean): string[] {
  const cutIns: [string, string][] = clips
    .filter(isCutIn)
    .slice(0, purposes.length)
    .map((clip, index) => [(clip.narration ?? "").trim(), purposes[index]!]);
  const outro = (purpose: string) => purpose === "outro" || purpose === "conclusion";
  const flags: string[] = [];

  // Outros are short and final.
  const longOutros = cutIns.filter(([text, purpose]) => outro(purpose) && wordsOf(text).length > OUTRO_WORDS).map(([text]) => `${wordsOf(text).length} words, ${quote(text)}`);
  if (longOutros.length > 0) {
    const n = longOutros.length;
    flags.push(
      `${n} outro${plural(n, "", "s")} run${plural(n, "s", "")} over ${OUTRO_WORDS} words (${longOutros.join("; ")}). An outro is the outcome in one or two sentences: who was arrested, charged, convicted or sentenced, without every date, count and the judge, and nothing that came after.`,
    );
  }
  if (compilation) {
    const bare = cutIns.filter(([text, purpose]) => outro(purpose) && text !== "" && !text.toLowerCase().includes("in the end")).map(([text]) => quote(text));
    if (bare.length > 0) flags.push(`Outros that don't open "In the end, …": ${bare.join("; ")}. Each case's outro gives its outcome, opening "In the end, …".`);
  }
  const judged = cutIns.filter(([text, purpose]) => outro(purpose) && (text.includes("concluded that") || text.includes("determined that"))).map(([text]) => quote(text));
  if (judged.length > 0) flags.push(`An outro states a conclusion of guilt (${judged.join("; ")}). Keep allegations, charges and outcomes distinct: "he was charged with…", "a jury found him guilty of…".`);

  // Cut-ins keep to their length.
  const exempt = ["intro", "hook", "title-line", "transition", "reuse-link", "intro-and-case-opening"];
  const long = cutIns
    .filter(([text, purpose], index) => !(outro(purpose) || exempt.includes(purpose) || (!compilation && index === 0)) && wordsOf(text).length > CUT_IN_WORDS)
    .map(([text, purpose]) => `a ${purpose.replaceAll("-", " ")} of ${wordsOf(text).length} words, ${quote(text)}`);
  if (long.length > 0) flags.push(`Cut-ins over ${CUT_IN_WORDS} words (${long.join("; ")}). A cut-in runs 50 to 65 words: what the viewer needs and the footage can't say, never a retelling of what it just showed.`);

  // Places that don't matter.
  const named = cutIns.flatMap(([text]) => places(text));
  if (named.length > 0) flags.push(`Addresses or named places the story doesn't turn on: ${named.join(", ")}. Give the city, state and agency; leave out streets, room numbers, schools and businesses unless the story turns on them.`);

  // Care with harm and children.
  const pairs = cutIns.flatMap(([text]) => childPairs(text));
  if (pairs.length > 0) flags.push(`A care word beside "child" (${pairs.map((pair) => `"${pair}"`).join(", ")}). Never pair them: write "images of a child" or name the charge once in plain terms.`);
  const heavy = cutIns.filter(([text]) => careWords(text) >= 3).map(([text]) => `${careWords(text)} in ${quote(text)}`);
  if (heavy.length > 0) flags.push(`Care words beyond what the story needs (${heavy.join("; ")}). Use sexual, rape, abuse and the like once to make the charge clear, never in a list of every count.`);
  const struck = cutIns.flatMap(([text]) => blows(text));
  if (struck.length > 0) flags.push(`Harm told by the blow (${struck.map((blow) => `"${blow}"`).join(", ")}). Say what it meant ("the baby had been hurt"), never the blow itself.`);

  // Tell the story forward.
  const telling = cutIns.filter(([text]) => TELLING.some((phrase) => text.toLowerCase().includes(phrase))).map(([text]) => quote(text));
  if (telling.length > 0) flags.push(`Narration about the telling (${telling.join("; ")}). Tell the story forward; when the footage jumps back, give the time and move on ("Earlier that afternoon, …").`);

  // Transitions open differently; case openings are dated.
  if (compilation) {
    const seen: string[] = [];
    const twice: string[] = [];
    for (const [text, purpose] of cutIns) {
      if (purpose !== "transition" || text === "") continue;
      const opening = lower(wordsOf(text)).slice(0, 4).join(" ");
      if (seen.includes(opening) && !twice.includes(opening)) twice.push(opening);
      seen.push(opening);
    }
    if (twice.length > 0) flags.push(`Transitions open the same way: ${twice.map((opening) => `"${opening}…"`).join(", ")}. Vary how each transition opens.`);
    const undated = cutIns.filter(([text, purpose]) => purpose === "case-opening" && !hasDate(text)).map(([text]) => quote(text));
    if (undated.length > 0) flags.push(`Case openings without a date (${undated.join("; ")}). Open on the verified date ("On May 29, 2024, …"); when no source gives one, say so in the report.`);
  }

  // People: by full name before an outro.
  const cases: [string, string][][] = [[]];
  for (const one of cutIns) {
    if (one[1] === "transition") cases.push([]);
    cases.at(-1)!.push(one);
  }
  const known = people(script);
  const shortNames: string[] = [];
  const lateNames: string[] = [];
  for (const own of cases) {
    for (const person of known) {
      const full = person.join(" ");
      const firstName = person[0]!;
      const surname = person.at(-1) ?? "";
      // By first name: relatives share a surname, and a transcript's spelling may differ from the reports'.
      const first = own.find(([text]) => wordsOf(text).some((word) => word === firstName || (word.endsWith("'s") && word.slice(0, -2) === firstName)));
      if (first === undefined) continue;
      const [text, purpose] = first;
      const said = wordsOf(text);
      const stem = [...surname].slice(0, 4).join("");
      // "Kenneth Bluew" introduces the speaker heard as "Ken Blue".
      const introduced =
        text.includes(full) ||
        said.some((word, at) => {
          const next = said[at + 1];
          return next !== undefined && capital(next) && (word.startsWith(firstName) || ([...surname].length >= 4 && next.startsWith(stem))) && capital(word);
        });
      if (outro(purpose)) lateNames.push(full);
      else if (!introduced) shortNames.push(full);
    }
    // A full name the outro brings in that the case never said.
    for (const [text] of own.filter(([, purpose]) => outro(purpose))) {
      const said = wordsOf(text);
      let at = 0;
      while (at < said.length) {
        let run = 0;
        while (at + run < said.length && capital(said[at + run]!) && !NOT_PEOPLE.includes(said[at + run]!.toLowerCase())) run++;
        if (run >= 2) {
          const name = said.slice(at, at + run);
          while (name.length > 0 && (MONTHS.includes(name[0]!.toLowerCase()) || NAME_OPENERS.includes(name[0]!))) name.shift();
          const earlier = own.filter(([, purpose]) => !outro(purpose)).some(([other]) => wordsOf(other).some((word) => name.some((part) => part.length > 2 && part === word)));
          const full = name.join(" ");
          if (name.length >= 2 && !earlier && !lateNames.includes(full)) lateNames.push(full);
        }
        at += Math.max(run, 1);
      }
    }
  }
  if (shortNames.length > 0) flags.push(`People first named without their full name: ${shortNames.join(", ")}. Introduce each person by full name, and age when the evidence gives it, the first time they matter.`);
  if (lateNames.length > 0) flags.push(`People first named in an outro: ${lateNames.join(", ")}. Introduce them where they first matter in the case; an outro only uses names the viewer knows.`);
  return flags;
}
