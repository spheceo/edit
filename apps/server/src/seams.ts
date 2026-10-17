// The seams between work packages (docs/rewrite-plan.md §3): every symbol one
// package's Rust module uses from another package's, as a TS signature, taken
// from the cross-module trace of crates/edit/src (tests excluded). Until the
// owning package lands, each is a stub that throws "not ported".
//
// How a package fills its seam: write the module (e.g. `src/subtitles.ts`),
// then replace the stub object here with it, typed by the same interface, so
// the compiler holds the module to what its callers were promised:
//
//     import * as real from "./subtitles.ts";
//     export const subtitles: SubtitlesSeam = real;
//
// Callers always go through these objects (`seams.subtitles.footageSound(…)`),
// never import another package's module directly, so packages can land in any
// order. Names are the Rust names in camelCase; `Result<T, String>` is a
// thrown Error with the same text; `async fn` is a Promise; Rust `&mut Project`
// arguments are changed in place, as there.
//
// What WP1 owns itself (store, media, relay, diag, layout, import, project
// helpers, `isSubtitled`, `isLocalCopy`, `scrub`, `cloudEnabled`, CAPTION_PREFIX)
// isn't here: call it directly.

import type { App } from "./app.ts";
import * as captionsCore from "./captions_core.ts";
import * as facesModule from "./faces.ts";
import * as peopleModule from "./people.ts";
import * as speakersModule from "./speakers.ts";
import * as subtitlesModule from "./subtitles.ts";
import type {
  Clip,
  DriveFile,
  ExportOptions,
  Media,
  Mute,
  Plan,
  Probe,
  Project,
  Rgba,
  ScriptBlock,
  ScriptJob,
  Segment,
  Style,
  TextStyle,
  Transform,
} from "./model.ts";
import type { Box } from "./native/index.ts";
import type { Store } from "./store.ts";
import type { Transcript, Word } from "./transcribe.ts";

/** What a seam does until its package lands. */
export function notPorted(what: string): never {
  throw new Error(`${what} is not ported yet`);
}

/**
 * A stub object whose every function throws "not ported" naming it; its
 * constants (`known`, copied from the Rust) are there already.
 */
function stub<T extends object>(module: string, known: Partial<T> = {}): T {
  return new Proxy(known as T, {
    get(target, name) {
      if (typeof name !== "string" || name === "then") return undefined;
      if (name in target) return (target as Record<string, unknown>)[name];
      return (..._args: unknown[]) => notPorted(`${module}.${name}`);
    },
  });
}

type Json = unknown;

// ---------------------------------------------------------------------------
// WP2: shell, server core, shipping

/** One export at a time; what was exported since the server started (render.rs Exports). */
export interface Exports {
  /** Starts exporting `project` to `path` (or its default); returns where it goes. */
  start(store: Store, library: Library, project: Project, options: ExportOptions, path: string | null): Promise<string>;
  /** Cancels project `id`'s export; whether one was running. */
  cancel(id: string): boolean;
  /** Whether any export is running (an update waits for it). */
  running(): boolean;
  /** Whether `path` is a file exported since the server started (only those are handed out). */
  exported(path: string): boolean;
}

/** Self-update (update.rs Updater). */
export interface Updater {
  status(): Promise<Json>;
  install(): Promise<Json>;
}

export interface ServerSeam {
  /** `<exports folder>/<name>.mp4`: the media drive's `Exports` when one is set, else ~/Movies/Edit. */
  defaultExportPath(store: Store, project: Project): string;
  /** Sets a found image's status; kept the first time, it goes into the media bin, named after its caption. */
  reviewFound(app: App, id: string, item: string, status: string, origin: string): Promise<ResearchItem>;
}

export interface AppSeam {
  /** The binary that was started (process.execPath in the compiled `edit`). */
  originalExe(): string;
}

export const server: ServerSeam = stub<ServerSeam>("server");
export const app: AppSeam = stub<AppSeam>("app");

// ---------------------------------------------------------------------------
// WP3: cloud

/** A file Edit adds as media, and where it is on R2 when it's a cloud media (cloud_media.rs Made). */
export interface Made {
  path: string;
  name: string;
  probe: Probe;
  cloud: NonNullable<Media["cloud"]> | null;
}

/** A Drive file put on R2 (cloud_media.rs Original). */
export interface Original {
  file: string;
  source: string;
  key: string;
  name: string;
  size: number;
}

/** The temporary originals an export reads (removed when the export is done). */
export interface Originals {
  release(): void;
}

export interface CloudMediaSeam {
  /** Starts a backfill of cloud project `id` in the background. */
  backfillSoon(app: App, id: string): void;
  /** The media a script plays from Drive file `original`: an excerpt per span the `ranges` need. */
  driveExcerpts(cache: string, original: Original, ranges: [number, number][]): Promise<Excerpt[]>;
  /** Puts Drive file `file` on R2, streamed from Drive into the upload, unless the registry has it. */
  driveOriginal(file: string, scratch: string, progress: (bytes: number, total: number | null, name: string) => void): Promise<Original>;
  /** `project` as an export of frames start..end reads it: cloud media pointing at their originals (presigned URLs). */
  forExport(project: Project, start: number, end: number, cache: string): Promise<[Project, Originals]>;
  /** Puts a file from this machine in the cloud (deduplicated by content) and returns the media to add. */
  importLocal(cache: string, path: string, probe: Probe, name: string): Promise<Made>;
  /** `<cache>/cloud/tmp`, for files on their way up (old leftovers removed). */
  scratchDir(cache: string): string;
}

export interface CloudProjectsSeam {
  /** Whether there was a project to delete in the cloud (its lock goes either way). */
  delete(app: App, id: string): Promise<boolean>;
  /** The cloud routes (`/api/projects/{id}/cloud/*`, `/api/cloud`), registered on the router. */
  routes(router: import("./http/router.ts").Router<App>): void;
  /** On the way out: pushes what's left and lets every lock go. */
  shutdown(): Promise<void>;
}

export const cloudMedia: CloudMediaSeam = stub<CloudMediaSeam>("cloud_media");
export const cloudProjects: CloudProjectsSeam = stub<CloudProjectsSeam>("cloud_projects");

// ---------------------------------------------------------------------------
// WP4: script, voice, research

/** A stretch of a Drive file a script plays, as a file here (script.rs Excerpt). */
export interface Excerpt {
  path: string;
  from: number;
  to: number;
  /** In cloud mode: `path` is the local proxy, and this is the media to make. */
  cloud: Made | null;
}

/** A script Doc read into blocks (script.rs Parsed). */
export interface Parsed {
  title: string;
  blocks: ScriptBlock[];
}

/** What Drive serves for a file (script.rs DriveHead). */
export interface DriveHead {
  name: string | null;
  size: number | null;
  html: boolean;
}

/** Script imports in progress, per project (script.rs Jobs). */
export interface ScriptJobs {
  get(project: string): ScriptJob | null;
}

export interface ScriptSeam {
  attach(project: Project, source: string, parsed: Parsed): void;
  /** "1h02m03s". */
  clock(seconds: number): string;
  /** FFmpeg cut of `source` from `start` to `to` into `out` (picture copied, sound AAC 192k). */
  cut(source: string, start: number, to: number, out: string): Promise<void>;
  docId(url: string): string | null;
  /** Seconds of a file (or a presigned URL's object). */
  durationOf(path: string): Promise<number>;
  fetchDoc(id: string): Promise<[html: string, title: string]>;
  /** The keyframe at or before `time` (seconds). */
  keyframeBefore(path: string, time: number): Promise<number>;
  parse(html: string): Parsed;
  realign(app: App, id: string): Promise<Json[]>;
  /** The URL that downloads Drive file `file` and its headers. */
  resolve(file: string, scratch: string): Promise<[url: string, head: DriveHead]>;
  /** A file name safe on every disk. */
  safeName(name: string): string;
  /** The spans of a file that `ranges` need (joined, padded, whole when mostly used). */
  spans(ranges: [number, number][], duration: number): [number, number][];
  start(app: App, projectId: string, recut: boolean): void;
  summary(parsed: Parsed): Json;
  unfinished(project: Project): boolean;
}

/** Voice-over projects (voice.rs Voices). */
export interface Voices {
  list(): Json;
}

export interface VoiceSeam {
  /** The lines of a video project's script narration (its cut-ins), in order, with their labels. */
  narrationLines(project: Project): [string, string | null][];
}

export interface VoiceoverSeam {
  isVoiceover(project: Project, clip: Clip): boolean;
  place(app: App, id: string, media: string[] | null): Promise<Json>;
  send(app: App, voiceId: string, id: string): Promise<Json>;
  /** Plays the voice-overs between `from` and `to` `speed` times faster; (sped start, sped end, frames saved). */
  speedUp(project: Project, from: number, to: number, speed: number): [number, number, number];
  tighten(app: App, id: string, span: [number, number], maxPause: number, keep: number, dryRun: boolean): Promise<Json>;
  /** The voice-overs heard in frames [from, to). */
  voiceoverSound(project: Project, from: number, to: number): Clip[];
}

/** A found image awaiting review (research.rs Item). */
export interface ResearchItem {
  id: string;
  file: string;
  width: number;
  height: number;
  title: string;
  page: string;
  image: string;
  query: string;
  status: string;
  [field: string]: unknown;
}

export interface Article {
  id: string;
  url: string;
  title: string;
  outlet: string;
  published?: string;
  summary: string;
  text: string;
}

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

export interface ResearchSeam {
  addArticle(home: string, project: string, url: string, summary: string): Promise<[Article, number]>;
  articles(home: string, project: string): Article[];
  clear(home: string, project: string, status: string): number;
  collect(home: string, project: string, queries: string[], perQuery: number): Promise<[added: number, had: number, failed: number]>;
  collecting(project: string): boolean;
  items(home: string, project: string): ResearchItem[];
  readPage(url: string, limit: number): Promise<string>;
  reject(home: string, project: string, ids: string[]): number;
  searchWeb(query: string): Promise<WebResult[]>;
  /** A found image shrunk into a 320×240 cell (letterboxed) as RGBA, for contact sheets. */
  thumbnail(path: string): Promise<import("./native/index.ts").RawImage | null>;
  update(home: string, project: string, id: string, change: (item: ResearchItem) => void): ResearchItem;
}

export const script: ScriptSeam = stub<ScriptSeam>("script");
export const voice: VoiceSeam = stub<VoiceSeam>("voice");
export const voiceover: VoiceoverSeam = stub<VoiceoverSeam>("voiceover");
export const research: ResearchSeam = stub<ResearchSeam>("research");

// ---------------------------------------------------------------------------
// WP5: subtitles, speakers, people, seats, faces

/** A transcript word in ms of its clip's source (subtitles.rs TimedWord). */
export interface TimedWord {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker: string | null;
}

/** A subtitle: words [from, to) of the clip's list (subtitles.rs Cue). */
export interface Cue {
  words: [number, number];
  start_ms: number;
  end_ms: number;
  text: string;
  speaker: string | null;
}

export interface Line {
  start_ms: number;
  end_ms: number;
  text: string;
  /** Who says it (a key into the speakers). */
  speaker: string;
}

/** A house word to mute (and maybe star) (subtitles.rs Suggestion). */
export interface Suggestion {
  term: string;
  starred: boolean;
  display: string | null;
  word: number;
  at_ms: number;
  start_ms: number;
  end_ms: number;
}

/** A house word found in the footage's sound (subtitles.rs Found). */
export interface Found {
  clip: string;
  suggestion: Suggestion;
  timeline_ms: [number, number];
}

/** Per audio clip: the stretch looked at (source seconds) and its mutes there (subtitles.rs ClipMutes). */
export type ClipMutes = Map<string, [from: number, to: number, mutes: Mute[]]>;

export interface HouseWords {
  mutes: ClipMutes;
  found: Found[];
  listed: Json[];
}

export interface SubtitleOptions {
  from: number;
  to: number;
  neglect: boolean;
  hold_ms: number;
  overlap: boolean;
  faces: boolean;
}

export interface SubtitlesSeam {
  readonly DEFAULT_HOLD_MS: number;
  /** A subtitle's rough box (project pixels) for `text` wrapped at `textWidth` (character counts, no font metrics). */
  boxSize(text: string, textWidth: number, k: number): [number, number];
  fillSegments(given: Segment[], duration: number): Segment[];
  /** The footage's own sound in the span: audio clips of video files on tracks that are heard. */
  footageSound(project: Project, from: number, to: number): Clip[];
  hiddenRole(role: string): boolean;
  houseStyle(width: number, height: number, color: Rgba): TextStyle;
  houseWords(app: App, project: Project, from: number, to: number, neglect: boolean): Promise<HouseWords>;
  longestMs(word: string): number;
  muteHouseWords(app: App, projectId: string, from: number, to: number, neglect: boolean): Promise<Json>;
  repackSubtitles(app: App, projectId: string, options: SubtitleOptions): Promise<Json>;
  roleOf(role: string | null, name: string): string;
  segment(words: TimedWord[]): Cue[];
  silentRole(role: string): boolean;
  star(text: string, found: Suggestion[]): string;
  starOnScreen(project: Project, from: number, to: number, neglect: boolean): number;
  suggestions(words: TimedWord[], neglect: boolean, fromMs: number, toMs: number): Suggestion[];
  timedWords(words: Word[], from: number, to: number): TimedWord[];
  /** Repack's tokeniser: /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu on lowercase text. */
  tokens(text: string): string[];
  uncram(lines: Line[]): void;
  writeMutes(project: Project, mutes: ClipMutes): void;
}

/** One person on screen across the whole video, for `distinct` (speakers.rs Person). */
export interface Person {
  role: string;
  lines: number;
  color: string;
}

export interface SpeakersSeam {
  readonly BACKGROUND: string;
  readonly ROLES: readonly string[];
  distinct(people: Person[]): string[];
  /** Changes a file's transcript with `edit` (re-read under the lock), recolours it and saves it. */
  editTranscript(app: App, source: string, edit: (transcript: Transcript) => void): Promise<Transcript>;
  /** Names a file's voices in the background if its transcript has no names yet. */
  ensure(app: App, source: string): void;
  roleTitle(role: string): string;
  setRole(app: App, source: string, voice: string, role: string, label: string | null): Promise<Transcript>;
}

export interface PeopleSeam {
  /** Gives every person one colour across the video; each person with their colour and how many clips changed. */
  oneColourPerPerson(project: Project): Json;
  /** Each person's line count, colour and transcript names, for get_edit_context. */
  summary(project: Project): Record<string, string>;
}

/**
 * Where a face is: [x0, y0, x1, y1], corners as shares of the picture from
 * its top left (faces.rs), or, once `inFrame` has placed it, project pixels
 * from the frame's centre.
 */
export type Face = Box;

export interface FacesSeam {
  /** Frames looked at per second of source. */
  readonly RATE: number;
  clearlyVisible(track: [number, Face][], samples: number): boolean;
  detect(source: string, size: [number, number], indexes: number[]): Promise<Map<number, Face[]>>;
  follow(found: Map<number, Face[]>, indexes: number[], at: number, start: Face): [number, Face][];
  grown(face: Face): Face;
  inFrame(media: [number, number], transform: Transform, frame: [number, number], face: Face): Face;
  indexesBetween(a: number, b: number): number[];
  overlap(a: Face, b: Face): number;
  pick(faces: Face[], target: Face): Face | null;
  pictureAt(project: Project, at: number): Clip | null;
  placeFrom(size: [number, number], frame: [number, number], label: number, faces: Face[], bottom: number): [number, number];
  placeSubtitles(app: App, projectId: string, from: number, to: number): Promise<Json>;
  placedByEdit(text: string, style: TextStyle, transform: Transform, frame: [number, number]): boolean;
  smooth(points: [number, number][]): [number, number][];
  /** Subtitles and intro captions on someone's face (the audit), from the cache only. */
  textOnFaces(project: Project): Json[];
}

// WP5 has landed: subtitles.ts, speakers.ts, people.ts and faces.ts (seats.ts
// is behind subtitles). They import this file too; a module namespace is
// there (if not yet filled) whichever of the two loads first, and nothing
// reads it before the first call.
export const subtitles: SubtitlesSeam = subtitlesModule;
export const speakers: SpeakersSeam = speakersModule;
export const people: PeopleSeam = peopleModule;
export const faces: FacesSeam = facesModule;

// ---------------------------------------------------------------------------
// WP6: captions, watching, review

/** Where place_captions puts a caption (captions.rs Under). */
export type Under = { kind: "auto" } | { kind: "bottom" } | { kind: "at"; x: number; y: number };

export interface CaptionsSeam {
  /** A caption's rough size (project pixels): wrapped at the style's width. */
  captionSize(text: string, style: TextStyle): [number, number];
  captionSpeakers(app: App, projectId: string, from: number, to: number): Promise<Json>;
  followRegion(app: App, projectId: string, time: number, region: [number, number, number, number], args: Json): Promise<Json>;
  /** "#00e5c7" → a colour. */
  hex(text: string): Rgba | null;
  /** The intro (frames), when the project follows a script. */
  intro(project: Project): [number, number] | null;
  placeCaptions(app: App, projectId: string, from: number, to: number, under: Map<string, Under>): Promise<Json>;
  /** A known speaker's first name; a short role when no name is known. */
  subtitleName(name: string): string;
  subtitles(app: App, projectId: string, from: number, to: number, neglect: boolean): Promise<Json>;
  /** A media's transcript, transcribing it first if needed. */
  transcriptOf(app: App, media: Media): Promise<Transcript>;
}

export interface EditReviewSeam {
  calloutTiming(project: Project, transcripts: Map<string, Transcript>): Json[];
  subtitleCoverage(project: Project, transcripts: Map<string, Transcript>): Json;
}

export interface FootageSearchSeam {
  find(app: App, project: Project, phrases: string[], limit: number, context: number): Json;
}

/** A stretch of footage the watcher sends at once (watch.rs Window). */
export interface Window {
  lines: [number, number];
  start: number;
  end: number;
}

export interface WatchOptions {
  force: boolean;
  segments: boolean | null;
}

export interface WatchSeam {
  readonly MODEL: string;
  cut(source: string, cache: string, window: Window, out: string): Promise<void>;
  keyframesClose(source: string): Promise<boolean>;
  /** Posts `body` (a file) to the AI gateway. */
  post(body: string): Promise<Json>;
  /** The JSON in a model's answer, without Markdown fences. */
  unfence(text: string): string;
  watchFootage(app: App, projectId: string, options: WatchOptions): Promise<Json>;
  /** Starts watching `projectId`'s footage in the background. */
  watchInBackground(app: App, projectId: string): void;
}

// `hex`, `transcriptOf`, `subtitleName` and `captionSize` moved to WP5
// (captions_core.ts) to break the cycle; the rest is WP6's.
export const captions: CaptionsSeam = stub<CaptionsSeam>("captions", {
  hex: (text) => captionsCore.hex(text),
  transcriptOf: (app, media) => captionsCore.transcriptOf(app, media),
  subtitleName: (name) => captionsCore.subtitleName(name),
  captionSize: (text, style) => captionsCore.captionSize(text, style),
});
export const editReview: EditReviewSeam = stub<EditReviewSeam>("edit_review");
export const footageSearch: FootageSearchSeam = stub<FootageSearchSeam>("footage_search");
export const watch: WatchSeam = stub<WatchSeam>("watch", { MODEL: "google/gemini-3.8-flash" });

// ---------------------------------------------------------------------------
// WP7: editing tools and plans

export interface StylesSeam {
  /** What the agent's instructions say about the project's style. */
  instructions(style: Style): string;
}

export interface SfxSeam {
  /** The marker a placed sound lines up on the cut. */
  readonly HIT: string;
}

export const styles: StylesSeam = stub<StylesSeam>("styles");
export const sfx: SfxSeam = { HIT: "hit" };

// ---------------------------------------------------------------------------
// WP8: media sources, sound, agent

/** The Codex bridge behind the agent panel (agent.rs Agents). */
export interface Agents {
  status(): Promise<Json>;
  /**
   * One question to a model through the user's Codex (agent.rs `ask`): an
   * ephemeral read-only thread with `instructions` as its developer
   * instructions, `input` its user turn (Codex input items), the answer held
   * to `schema` when given; the answer's text, or a thrown Error after
   * `timeoutMs`. speakers.ts names voices with it.
   */
  ask(model: string, effort: string, instructions: string, input: Json[], schema: Json | null, timeoutMs: number): Promise<string>;
}

/** The team's sound library on Drive (library.rs Library). */
export interface Library {
  /** A Google access token for Drive calls (the library's sign-in, shared by drive.rs). */
  accessToken(): Promise<string>;
}

/** A library sound (library.rs Sound). */
export interface Sound {
  id: string;
  name: string;
  kind: "music" | "sfx";
  category: string;
  note?: string;
  bytes: number;
}

export interface BrollSeam {
  /** How long an export waits for map shots still rendering (ms). */
  readonly MAP_EXPORT_WAIT: number;
  /** Chrome on this machine, if any. */
  chrome(): string | null;
  isMapStandIn(path: string): boolean;
  mapView(app: App, projectId: string, args: Json): Promise<Json>;
  mediaTranscript(app: App, media: Media, from: number, to: number, words: boolean): Promise<string>;
  smoothInBackground(app: App, projectId: string, clipIds: string[]): string[];
  smoothSlowMotion(app: App, projectId: string, clipId: string): Promise<Json>;
  smoothingPending(projectId: string): string[];
  /** A still as 30 s of steady footage (off macOS, where pictures don't stay images). */
  stillVideo(image: string, dir: string): Promise<string>;
  waitForMaps(app: App, projectId: string, limitMs: number): Promise<void>;
  waitForSmoothing(projectId: string, limitMs: number): Promise<boolean>;
}

export interface DriveSeam {
  checked(store: Store, library: Library, id: string): Promise<DriveFile | null>;
  start(store: Store, library: Library, project: Project, path: string): void;
  uploading(): boolean;
  /** Whether an export is uploaded: a video file (MP4 or MOV) of all of it. */
  wanted(project: Project, options: ExportOptions, plan: Plan): boolean;
}

export interface LibrarySeam {
  /** URL-encodes a query value. */
  encode(value: string): string;
  footageLoudness(project: Project): Promise<number>;
  gainTo(project: Project, clip: Clip, target: number): Promise<number>;
  import(app: App, project: string, sound: string, origin: string): Promise<[string, Sound]>;
  loudness(path: string, from: number, seconds: number): Promise<number>;
}

export const broll: BrollSeam = stub<BrollSeam>("broll", { MAP_EXPORT_WAIT: 600_000 });
export const drive: DriveSeam = stub<DriveSeam>("drive");
export const library: LibrarySeam = stub<LibrarySeam>("library");

/** The services App carries that other packages make (stubs until they land). */
export function unportedServices(): {
  exports: Exports;
  updater: Updater;
  agents: Agents;
  scripts: ScriptJobs;
  library: Library;
  voices: Voices;
} {
  return {
    exports: stub("exports"),
    updater: stub("updater"),
    agents: stub("agents"),
    scripts: stub("scripts"),
    library: stub("library"),
    voices: stub("voices"),
  };
}
