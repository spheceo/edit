// subtitles.ts's tests.

import { expect, test } from "bun:test";

import type { AudioClip, Clip, Project, TextClip } from "../src/model.ts";
import { newProject } from "../src/project.ts";
import { BACKGROUND } from "../src/speakers.ts";
import {
  boxSize,
  fillSegments,
  hiddenRole,
  isFormOf,
  longestMs,
  LEAD_MS,
  MIN_SHOWN_MS,
  narratorsInFootage,
  parseTerm,
  samePerson,
  samePersonSameColour,
  segment,
  shown,
  silentRole,
  star,
  starOnScreen,
  starSubtitles,
  starText,
  beginRun,
  latestRun,
  suggestions,
  tokens,
  uncram,
  underFace,
  writeMutes,
  type ClipMutes,
  type Cue,
  type Found,
  type Line,
  type TimedWord,
  type Voice,
} from "../src/subtitles.ts";

test("lines_sit_under_faces_the_repack_way", () => {
  // A face upper left: under it, narrowed near the edge.
  const [x, y, textWidth, , h] = underFace({ x: 25.0, y: 30.0, h: 10.0 }, "Yes, sir.", 1920, 1080, 1.0)!;
  expect(Math.abs(x - (480.0 - 960.0))).toBeLessThan(1.0);
  expect(Math.abs(y - (324.0 + 97.2 + h / 2.0 - 540.0))).toBeLessThan(1.0);
  expect(Math.abs(textWidth - (1920.0 * 0.4 - 24.0))).toBeLessThan(0.5);
  // A face low down: beside it, towards the middle.
  const [beside] = underFace({ x: 40.0, y: 70.0, h: 30.0 }, "Okay.", 1920, 1080, 1.0)!;
  expect(beside).toBeGreaterThan(768.0 - 960.0);
  // A face in a bottom corner: bottom middle instead.
  expect(underFace({ x: 10.0, y: 80.0, h: 10.0 }, "Okay.", 1920, 1080, 1.0)).toBeNull();
});

test("overlapping_lines_stay_up_long_enough_to_read", () => {
  const make = (start_ms: number, end_ms: number, speaker: string): Line => ({ start_ms, end_ms, text: "Okay.", speaker });
  const lines = [make(0.0, 100.0, "a"), make(120.0, 1_000.0, "b"), make(1_300.0, 1_400.0, "a")];
  const out = shown(lines, 1_000.0, 0.0, 10_000.0, true, () => false, () => false);
  expect(out.every((cue) => cue.end_ms - cue.start_ms >= MIN_SHOWN_MS - 1e-6)).toBe(true);
});

test("a_narrator_in_the_footage_is_someone_in_the_room", () => {
  const project = newProject("p", "t", { width: 1920, height: 1080, fps: 30 });
  project.segments = [
    { start: 0, end: 300, kind: "narration" },
    { start: 300, end: 900, kind: "footage" },
  ];
  const voice = (name: string, role: string): Voice => ({ name, role, color: "#ffffff" });
  const voices = new Map<string, Voice>([
    ["m/0", voice("JT Palmer (Narrator)", "narrator")],
    ["m/2", voice("Palmer (Undersheriff)", "leader")],
  ]);
  const make = (start_ms: number): Line => ({ start_ms, end_ms: start_ms + 500.0, text: "so", speaker: "m/0" });
  // One in the narration (stays the narrator's), one in the footage.
  const lines = [make(2_000.0), make(20_000.0)];
  narratorsInFootage(project, voices, lines);
  expect(lines[0]!.speaker).toBe("m/0");
  expect(lines[1]!.speaker).toBe("m/2");
  // A narration line starting in the footage's last frame is still narration.
  const edge: Line = { start_ms: 29_990.0, end_ms: 32_000.0, text: "so", speaker: "m/0" };
  project.segments.push({ start: 900, end: 1200, kind: "narration" });
  narratorsInFootage(project, voices, [edge]);
  expect(edge.speaker).toBe("m/0");
});

test("one_person_gets_one_colour", () => {
  expect(samePerson("Haven (Boy)", "haven (boy)")).toBe(true);
  expect(samePerson("Romania (Mother)", "Romania Hunter (Mother)")).toBe(true);
  expect(samePerson("Deputy 2", "Deputy 3")).toBe(false);
  expect(samePerson("Deputy", "Deputy 2")).toBe(false);
  expect(samePerson("Romania (Mother)", "Romania (Neighbor)")).toBe(false);
  const voice = (name: string, color: string): Voice => ({ name, role: "other", color });
  const voices = new Map<string, Voice>([
    ["m/a", voice("Haven (Boy)", "#111111")],
    ["m/b", voice("Haven (Boy)", "#222222")],
    ["m/c", voice("Romania (Mother)", "#333333")],
    ["m/d", voice("Romania Hunter (Mother)", "#444444")],
    ["m/e", voice("Deputy 2", "#555555")],
  ]);
  const lines: Line[] = ["m/a", "m/b", "m/b", "m/c", "m/c", "m/d", "m/e"].map((speaker) => ({
    start_ms: 0.0,
    end_ms: 1.0,
    text: "",
    speaker,
  }));
  samePersonSameColour(voices, lines);
  expect(voices.size).toBe(3);
  // Haven keeps the colour of the voice with more lines (b).
  expect(voices.get("m/b")?.color).toBe("#222222");
  expect(voices.get("m/c")?.name).toBe("Romania Hunter (Mother)");
  expect(lines.every((line) => voices.has(line.speaker))).toBe(true);
});

function word(text: string, start_ms: number, end_ms: number, speaker: string): TimedWord {
  return { text, start_ms, end_ms, speaker };
}

function texts(cues: Cue[]): string[] {
  return cues.map((cue) => cue.text);
}

test("segments_at_speakers_pauses_length_and_sentences", () => {
  // A change of speaker.
  expect(texts(segment([word("Hi", 0.0, 200.0, "a"), word("there", 250.0, 400.0, "b")]))).toEqual(["Hi", "there"]);
  // A pause of 750 ms joins; over it splits.
  expect(
    texts(segment([word("one", 0.0, 100.0, "a"), word("two", 850.0, 900.0, "a"), word("three", 1651.0, 1700.0, "a")])),
  ).toEqual(["one two", "three"]);
  // Past 3.5 s from the first word's start.
  expect(
    texts(segment([word("one", 0.0, 100.0, "a"), word("two", 700.0, 3500.0, "a"), word("three", 3600.0, 3501.0 + 100.0, "a")])),
  ).toEqual(["one two", "three"]);
  // Past 52 characters with the word.
  const long = Array.from({ length: 12 }, (_, i) => word("abcd", i * 100.0, i * 100.0 + 50.0, "a"));
  // Ten words are 49 characters, eleven 54.
  expect(segment(long).map((cue) => cue.words[1] - cue.words[0])).toEqual([10, 2]);
  // After a sentence ends.
  const cues = segment([
    word("Stop.", 0.0, 100.0, "a"),
    word("Now!", 150.0, 200.0, "a"),
    word("Why?", 250.0, 300.0, "a"),
    word("ok", 350.0, 400.0, "a"),
  ]);
  expect(texts(cues)).toEqual(["Stop.", "Now!", "Why?", "ok"]);
  expect([cues[1]!.start_ms, cues[1]!.end_ms]).toEqual([150.0, 200.0]);
});

function line(start_ms: number, end_ms: number, speaker: string): Line {
  return { start_ms, end_ms, text: speaker, speaker };
}

function times(lines: Line[]): [number, number, string][] {
  return lines.map((one) => [one.start_ms, one.end_ms, one.speaker]);
}

test("a_line_squeezed_by_a_quick_answer_comes_up_early_and_never_delays_the_answer", () => {
  const none = () => false;
  // "No." said 40 ms before someone else's line: up LEAD_MS early, and the
  // answer still starts on its first word.
  let out = shown([line(0.0, 500.0, "c"), line(2000.0, 2030.0, "a"), line(2040.0, 3500.0, "b")], 1000.0, 0.0, 9000.0, false, none, none);
  expect(times(out)).toEqual([
    [0.0, 1500.0, "c"],
    [2000.0 - LEAD_MS, 2040.0, "a"],
    [2040.0, 4500.0, "b"],
  ]);
  // No time before it: shorter than MIN_SHOWN_MS rather than the answer late.
  out = shown([line(0.0, 30.0, "a"), line(40.0, 1500.0, "b")], 1000.0, 0.0, 9000.0, false, none, none);
  expect(times(out)).toEqual([
    [0.0, 40.0, "a"],
    [40.0, 2500.0, "b"],
  ]);
});

test("a_short_line_joins_the_same_persons_next_instead_of_delaying_it", () => {
  const none = () => false;
  const said = (start_ms: number, end_ms: number, text: string, speaker: string): Line => ({ start_ms, end_ms, text, speaker });
  for (const together of [false, true]) {
    const out = shown([said(0.0, 200.0, "No.", "a"), said(250.0, 900.0, "I didn't.", "a")], 1000.0, 0.0, 9000.0, together, none, none);
    expect(out.map((one) => [one.start_ms, one.end_ms, one.text])).toEqual([[0.0, 1900.0, "No. I didn't."]]);
  }
  // Two people are never joined.
  const out = shown([said(0.0, 200.0, "No.", "a"), said(250.0, 900.0, "Yes.", "b")], 1000.0, 0.0, 9000.0, true, none, none);
  expect(out.map((one) => one.text)).toEqual(["No.", "Yes."]);
  expect(out[1]!.start_ms).toBe(250.0);
});

test("holds_a_second_one_at_a_time", () => {
  const none = () => false;
  // Held 1 s, unless the next starts first.
  let out = shown([line(0.0, 500.0, "a"), line(1000.0, 1500.0, "b"), line(5000.0, 5500.0, "a")], 1000.0, 0.0, 6000.0, false, none, none);
  expect(times(out)).toEqual([
    [0.0, 1000.0, "a"],
    [1000.0, 2500.0, "b"],
    [5000.0, 6000.0, "a"],
  ]);
  // Two that start together: shown one after the other.
  out = shown([line(0.0, 500.0, "a"), line(0.0, 800.0, "b")], 1000.0, 0.0, 9000.0, false, none, none);
  expect(times(out)).toEqual([
    [0.0, 500.0, "a"],
    [500.0, 1800.0, "b"],
  ]);
  // The narrator is hidden but still ends the line before; radio cuts nothing.
  out = shown(
    [line(0.0, 500.0, "a"), line(700.0, 900.0, "narrator"), line(800.0, 900.0, "radio")],
    1000.0,
    0.0,
    9000.0,
    false,
    (speaker) => speaker === "radio",
    (speaker) => speaker === "radio" || speaker === "narrator",
  );
  expect(times(out)).toEqual([[0.0, 700.0, "a"]]);
  // Background talk is hidden and, like radio, cuts nothing short;
  // only the narrator does.
  const role = (speaker: string) => (speaker === "narrator" ? "narrator" : speaker === "behind" ? BACKGROUND : "officer");
  out = shown(
    [line(0.0, 500.0, "a"), line(600.0, 1200.0, "behind"), line(2000.0, 2300.0, "b"), line(2500.0, 2600.0, "narrator")],
    1000.0,
    0.0,
    9000.0,
    false,
    (speaker) => silentRole(role(speaker)),
    (speaker) => hiddenRole(role(speaker)),
  );
  expect(times(out)).toEqual([
    [0.0, 1500.0, "a"],
    [2000.0, 2500.0, "b"],
  ]);
  expect(hiddenRole("dispatch") && silentRole("dispatch")).toBe(true);
  expect(hiddenRole("narrator") && !silentRole("narrator")).toBe(true);
  expect(!hiddenRole("officer") && !silentRole("officer")).toBe(true);
});

test("shows_people_talking_over_each_other_together", () => {
  const none = () => false;
  // b starts while a is still talking: both up; a's held until b's
  // next line that starts after a is said, b's own next line cuts b.
  const out = shown(
    [line(0.0, 2000.0, "a"), line(1000.0, 1500.0, "b"), line(1800.0, 2600.0, "b"), line(4000.0, 4500.0, "a")],
    1000.0,
    0.0,
    9000.0,
    true,
    none,
    none,
  );
  expect(times(out)).toEqual([
    [0.0, 3000.0, "a"],
    [1000.0, 1800.0, "b"],
    [1800.0, 3600.0, "b"],
    [4000.0, 5500.0, "a"],
  ]);
});

test("segments_fill_gaps_with_footage_and_join_neighbours", () => {
  const out = fillSegments(
    [
      { start: 0, end: 100, kind: "captioned" },
      { start: 100, end: 150, kind: "captioned" },
      { start: 140, end: 200, kind: "narration" },
      { start: 300, end: 900, kind: "narration" },
    ],
    500,
  );
  expect(out.map((s) => [s.start, s.end, s.kind])).toEqual([
    [0, 150, "captioned"],
    [150, 200, "narration"],
    [200, 300, "footage"],
    [300, 500, "narration"],
  ]);
});

test("crammed_lines_get_time_to_be_read", () => {
  const make = (start_ms: number, end_ms: number, text: string): Line => ({ start_ms, end_ms, text, speaker: "a" });
  // 24 characters said in 0.4 s after a word stretched over the gap: the
  // words were said in the gap, so it starts there.
  let lines = [
    make(234_750.0, 236_000.0, "All right."),
    { ...make(244_380.0, 244_790.0, "Anything in your pocket?"), doubtful: true },
    make(244_790.0, 246_000.0, "Hair is ..."),
  ];
  uncram(lines);
  expect(lines[1]!.end_ms).toBe(244_790.0);
  expect(Math.abs(lines[1]!.start_ms - (244_790.0 - 21.0 * 60.0))).toBeLessThan(1e-6);
  // The same words timed with nothing stretched before them: up at most
  // LEAD_MS early, held longer instead.
  lines = [make(234_750.0, 236_000.0, "All right."), make(244_380.0, 244_790.0, "Anything in your pocket?")];
  uncram(lines);
  expect(lines[1]!.start_ms).toBe(244_380.0 - LEAD_MS);
  expect(Math.abs(lines[1]!.end_ms - (244_380.0 - LEAD_MS + 21.0 * 60.0))).toBeLessThan(1e-6);
  // Quick talk timed right ("Now, you stay right here." in 0.74 s) isn't crammed.
  lines = [make(65_060.0, 65_800.0, "Now, you stay right here.")];
  uncram(lines);
  expect([lines[0]!.start_ms, lines[0]!.end_ms]).toEqual([65_060.0, 65_800.0]);
  // No gap before it: it runs on (`shown` never starts the next late for it).
  lines = [make(0.0, 1000.0, "One two three."), make(1000.0, 1300.0, "Four five six seven.")];
  uncram(lines);
  expect(lines[1]!.start_ms).toBe(1000.0);
  expect(Math.abs(lines[1]!.end_ms - (1000.0 + 17.0 * 60.0))).toBeLessThan(1e-6);
  // Quick short answers are left alone.
  lines = [make(0.0, 200.0, "Yes."), make(200.0, 500.0, "No.")];
  uncram(lines);
  expect(lines[0]!.end_ms).toBe(200.0);
  expect(lines[1]!.start_ms).toBe(200.0);
});

test("stretched_words_end_when_they_could_be_said", () => {
  // "right." stretched over 9.4 s of silence ends within ~1.2 s.
  expect(Math.abs(longestMs("right.") - 1100.0)).toBeLessThan(1e-9);
  expect(longestMs("too.")).toBe(1000.0);
  expect(longestMs("$8,320")).toBe(Number.POSITIVE_INFINITY);
  expect(longestMs("methamphetamine")).toBeGreaterThan(2000.0);
});

test("box_heights_grow_with_wrapped_lines", () => {
  const [, one] = boxSize("Short line", 1920.0 * 0.8 - 24.0, 1.0);
  const [, two] = boxSize("word ".repeat(20), 1920.0 * 0.8 - 24.0, 1.0);
  expect(Math.abs(one - (48.0 * 1.15 + 16.0))).toBeLessThan(0.01);
  expect(two).toBeGreaterThan(one * 1.5);
});

test("listed_words_count_in_their_other_forms", () => {
  for (const [token, term] of [
    ["hits", "hit"],
    ["hitting", "hit"],
    ["punched", "punch"],
    ["punching", "punch"],
    ["punches", "punch"],
    ["kicked", "kick"],
    ["kickin", "kick"],
    ["slapped", "slap"],
    ["beaten", "beat"],
    ["beating", "beat"],
    ["choked", "choke"],
    ["choking", "choke"],
    ["abused", "abuse"],
    ["abusive", "abuse"],
    ["abuser", "abuse"],
    ["stabbed", "stab"],
    ["strangled", "strangle"],
    ["whooping", "whoop"],
    ["fucker", "fuck"],
    ["bitches", "bitch"],
    ["drugs", "drug"],
  ] as const) {
    expect(isFormOf(token, term), `${token} is a form of ${term}`).toBe(true);
  }
  for (const [token, term] of [
    ["hitch", "hit"],
    ["butter", "butt"],
    ["cracked", "crack"],
    ["assault", "ass"],
    ["cocky", "cock"],
    ["shots", "shoot"],
  ] as const) {
    expect(isFormOf(token, term), `${token} is not a form of ${term}`).toBe(false);
  }
});

test("other_forms_are_muted_and_starred_as_said", () => {
  // "punched" at 9:29 of a neglect case wasn't muted.
  const words = [
    word("He", 0.0, 200.0, "a"),
    word("punched", 250.0, 600.0, "a"),
    word("her", 650.0, 800.0, "a"),
    word("and", 850.0, 900.0, "a"),
    word("kept", 950.0, 1100.0, "a"),
    word("hitting", 1150.0, 1500.0, "a"),
    word("fucking", 1550.0, 1900.0, "a"),
    word("shooting", 1950.0, 2300.0, "a"),
  ];
  let found = suggestions(words, true, 0.0, 10_000.0);
  expect(found.map((s) => [s.term, s.starred])).toEqual([
    ["punched", true],
    ["hitting", true],
    ["fucking", true],
    ["shooting", false],
  ]);
  expect([found[0]!.start_ms, found[0]!.end_ms]).toEqual([220.0, 625.0]);
  expect(star("He punched her and kept hitting, fucking", found)).toBe("He p****** her and kept h******, f******");
  // Outside a neglect case only the house words count.
  found = suggestions(words, false, 0.0, 10_000.0);
  expect(found.every((s) => s.term !== "punched")).toBe(true);
});

/** A project of one bodycam file, its tracks, and `clips` with serde's defaults filled. */
function projectWith(clips: Record<string, unknown>[]): Project {
  const project = newProject("p", "t", { width: 1920, height: 1080, fps: 30 });
  project.media = [
    { id: "m", name: "bodycam", path: "/tmp/bodycam.mp4", kind: "video", duration: 600.0, width: 0, height: 0, fps: 0, has_audio: true },
  ];
  project.tracks = [
    { id: "v1", kind: "video", hidden: false, muted: false, locked: false },
    { id: "v2", kind: "video", hidden: false, muted: false, locked: false, subtitles: true },
    { id: "a1", kind: "audio", hidden: false, muted: false, locked: false },
  ];
  project.clips = clips.map((given) => {
    const clip = { color: "blue", fade_in: 0, fade_out: 0, ...given } as Record<string, unknown>;
    if (clip.type === "text") {
      clip.transform ??= { x: 0, y: 0, scale: 1, rotation: 0 };
      clip.style ??= { font: "Geist", weight: 700, size: 96, color: [1, 1, 1, 1], tracking: 0, line_height: 1.15, glow: { enabled: true, color: null, radius: 46, strength: 0.5 } };
      clip.animation ??= { preset: "none", duration: 12, stagger: 1.5 };
      clip.opacity ??= 1;
    }
    if (clip.type === "audio") {
      clip.speed ??= 1;
      clip.volume_db ??= 0;
      clip.source_in ??= 0;
    }
    return clip as unknown as Clip;
  });
  return project;
}

function textOf(project: Project, id: string): string {
  const clip = project.clips.find((one) => one.id === id) as TextClip | undefined;
  return clip?.text ?? "";
}

test("every_text_on_screen_gets_house_words_starred", () => {
  expect(starText("Charges:\nChild Abuse\nAggravated child abuse", false)).toBe("Charges:\nChild A****\nAggravated child a****");
  expect(starText('"He choked me"', false)).toBe('"He c***** me"');
  // A video's own words ("Blur this" in its script) are starred like the house's.
  expect(starText("The 1986 murder of a nurse", false)).toBe("The 1986 murder of a nurse");
  expect(starText("The 1986 murder of a nurse", false, ["murder = m****r"])).toBe("The 1986 m****r of a nurse");
  expect(starText("Murdered in 1986", false, ["murdered"])).toBe("M******* in 1986");
  expect(starText("Shit, he punched him", false)).toBe("S**t, he punched him");
  expect(starText("Shit, he punched him", true)).toBe("S**t, he p****** him");
  // Mute-only words stay readable; words are never removed.
  expect(starText("Shots fired, he's dead", false)).toBe("Shots fired, he's dead");
  const project = projectWith([
    { id: "caption", track: "v2", start: 0, duration: 30, name: "Caption · Officer", type: "text", text: "Stop fucking moving", word_times: [0.0, 5.0, 10.0] },
    { id: "callout", track: "v2", start: 60, duration: 30, name: "Callout", type: "text", text: "Suspected of child abuse" },
    { id: "later", track: "v2", start: 900, duration: 30, name: "Title", type: "text", text: "fuck" },
  ]);
  expect(starOnScreen(project, 0, 300, false)).toBe(2);
  expect(textOf(project, "caption")).toBe("Stop f****** moving");
  expect(textOf(project, "callout")).toBe("Suspected of child a****");
  expect(textOf(project, "later")).toBe("fuck");
  // Starred already: nothing changes on a second run.
  expect(starOnScreen(project, 0, 300, false)).toBe(0);
});

test("mutes_house_words_and_stars_them", () => {
  const words = [
    word("What", 0.0, 200.0, "a"),
    word("the", 250.0, 400.0, "a"),
    word("Fuck,", 450.0, 700.0, "a"),
    word("he's", 750.0, 900.0, "a"),
    word("dead.", 950.0, 1200.0, "a"),
    word("Motherfucker", 1300.0, 1800.0, "a"),
    word("neglect", 1900.0, 2300.0, "a"),
    word("hit", 2400.0, 2600.0, "a"),
  ];
  let found = suggestions(words, false, 0.0, 10_000.0);
  expect(found.map((s) => [s.term, s.starred])).toEqual([
    ["fuck", true],
    ["dead", false],
    ["motherfucker", true],
    ["neglect", true],
  ]);
  // 30 ms before, 25 ms after.
  expect([found[0]!.start_ms, found[0]!.end_ms]).toEqual([420.0, 725.0]);
  expect(star("What the Fuck, he's dead.", found)).toBe("What the F***, he's dead.");
  expect(star("Motherfucker neglect", found)).toBe("Motherf***** n******");
  // "fuck" inside another word is left alone.
  expect(star("fuckers", found)).toBe("fuckers");
  // The neglect list adds "hit", starred.
  found = suggestions(words, true, 0.0, 10_000.0);
  expect(found.find((s) => s.term === "hit")?.starred).toBe(true);
  // "kill" is mute-only in the house list but starred in a neglect case.
  const kill = [word("kill", 0.0, 300.0, "a")];
  expect(suggestions(kill, false, 0.0, 1000.0)[0]!.starred).toBe(false);
  expect(suggestions(kill, true, 0.0, 1000.0)[0]!.starred).toBe(true);
});

test("a_word_timed_as_an_instant_reaches_back", () => {
  const words = [word("you", 1000.0, 1200.0, "a"), word("um", 1300.0, 1500.0, "b"), word("bitch", 2000.0, 2010.0, "a")];
  const found = suggestions(words, false, 0.0, 10_000.0);
  // Back to the end of the speaker's word before, less the lead.
  expect([found[0]!.start_ms, found[0]!.end_ms]).toEqual([1170.0, 2035.0]);
  // No word of theirs in reach: 1.5 s back.
  const alone = [word("bitch", 2000.0, 2010.0, "a")];
  expect(suggestions(alone, false, 0.0, 10_000.0)[0]!.start_ms).toBe(470.0);
  // Clamped to the range.
  expect(suggestions(alone, false, 1000.0, 2020.0)[0]!.start_ms).toBe(1000.0);
  expect(suggestions(alone, false, 1000.0, 2020.0)[0]!.end_ms).toBe(2020.0);
});

test("tokens_like_repack", () => {
  expect(tokens("He's DEAD, rock'n'roll 42!")).toEqual(["he's", "dead", "rock'n", "roll", "42"]);
  expect(parseTerm("shit = s**t")).toEqual(["shit", "s**t"]);
  expect(parseTerm("nigger")).toEqual(["nigger", null]);
});

test("mutes_go_on_their_clip_in_source_seconds", () => {
  // Two cuts of one file: the second plays its source from 120 s.
  const project = projectWith([
    { id: "a", track: "a1", start: 0, duration: 300, type: "audio", media: "m", source_in: 10.0, mutes: [{ from: 11.0, to: 11.5 }, { from: 50.0, to: 50.5 }] },
    { id: "b", track: "a1", start: 300, duration: 300, type: "audio", media: "m", source_in: 120.0, mutes: [{ from: 121.0, to: 121.2 }] },
  ]);
  const mutes: ClipMutes = new Map();
  // Clip a was looked at from 10 s to 20 s of its source.
  mutes.set("a", [10.0, 20.0, [{ from: 12.0, to: 12.4 }]]);
  writeMutes(project, mutes);
  const of = (id: string) => (project.clips.find((clip) => clip.id === id) as AudioClip).mutes ?? [];
  // The old one inside the span replaced, the one after kept; b untouched.
  expect(of("a")).toEqual([
    { from: 12.0, to: 12.4 },
    { from: 50.0, to: 50.5 },
  ]);
  expect(of("b")).toEqual([{ from: 121.0, to: 121.2 }]);
});

test("stars_subtitles_in_place_keeping_their_words", () => {
  const project = projectWith([
    {
      id: "s1",
      track: "v2",
      start: 30,
      duration: 60,
      color: "cyan",
      name: "Subtitle · Officer",
      type: "text",
      text: "What the fuck, man",
      transform: { x: 0, y: -300, scale: 1, rotation: 0 },
      word_times: [0, 5, 10, 20],
    },
    { id: "s2", track: "v2", start: 300, duration: 60, color: "cyan", name: "Subtitle · Officer", type: "text", text: "fuck off" },
    { id: "t", track: "v1", start: 30, duration: 60, color: "cyan", name: "Title", type: "text", text: "fuck" },
  ]);
  const found: Found[] = suggestions([word("fuck,", 1500.0, 1800.0, "a")], false, 0.0, 10_000.0).map((suggestion) => ({
    clip: "a",
    timeline_ms: [suggestion.at_ms, suggestion.end_ms],
    suggestion,
  }));
  expect(starSubtitles(project, found, 0, 900, 30.0)).toBe(1);
  const of = (id: string) => {
    const clip = project.clips.find((one) => one.id === id) as TextClip;
    return [clip.text, clip.transform.y, clip.word_times?.length ?? 0];
  };
  // Starred where it's said, kept where it was put, one word per time.
  expect(of("s1")).toEqual(["What the f***, man", -300.0, 4]);
  // Not up while it's said, or not a subtitle: left alone.
  expect(of("s2")[0]).toBe("fuck off");
  expect(of("t")[0]).toBe("fuck");
});

test("an_older_subtitle_run_never_saves_over_a_newer_one", () => {
  const first = beginRun("p1");
  expect(latestRun("p1", first)).toBe(true);
  // The agent gave up waiting and asked again: the first run's result is dropped.
  const second = beginRun("p1");
  expect(latestRun("p1", first)).toBe(false);
  expect(latestRun("p1", second)).toBe(true);
  // Other projects' runs are their own.
  beginRun("p2");
  expect(latestRun("p1", second)).toBe(true);
});
