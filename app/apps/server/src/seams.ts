// The seams between the server's packages: every symbol one package uses from
// another's, as a TS signature, filled by the module that owns it (typed by
// the interface, so the compiler holds the module to what its callers were
// promised). Services `App` carries that a test doesn't provide are stubs that
// throw "not available".
//
// Callers always go through these objects (`seams.subtitles.footageSound(…)`),
// never import another package's module directly, which keeps import cycles
// out. A failure is a thrown Error; a project passed in is changed in place.
//
// The foundation (store, media, relay, diag, layout, import, project helpers,
// `isSubtitled`, `isLocalCopy`, `scrub`, `cloudEnabled`, CAPTION_PREFIX) isn't
// here: call it directly.

import type { App } from "./app.ts";
import type { Router } from "./http/router.ts";
import * as appModule from "./app_seam.ts";
import * as brollModule from "./broll.ts";
import * as captionsModule from "./captions.ts";
import * as cloudModule from "./cloud.ts";
import * as cloudMediaModule from "./cloud_media.ts";
import * as cloudExportsModule from "./cloud_exports.ts";
import * as modalExportsModule from "./modal_exports.ts";
import type { StartExtra } from "./exports.ts";
import * as cloudProjectsModule from "./cloud_projects.ts";
import * as driveModule from "./drive.ts";
import * as editReviewModule from "./edit_review.ts";
import * as footageSearchModule from "./footage_search.ts";
import * as facesModule from "./faces.ts";
import * as peopleModule from "./people.ts";
import * as serverModule from "./server_seam.ts";
import * as speakersModule from "./speakers.ts";
import * as subtitlesModule from "./subtitles.ts";
import * as voiceModule from "./voice.ts";
import * as voiceoverModule from "./voiceover.ts";
import * as watchModule from "./watch.ts";
import type {
  Clip,
  DriveFile,
  ExportOptions,
  Marker,
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
import * as libraryModule from "./library.ts";
import * as markersModule from "./markers.ts";
import type { Box } from "./native/index.ts";
import * as researchModule from "./research.ts";
import * as scriptModule from "./script_tools.ts";
import * as sfxModule from "./sfx.ts";
import type { Store } from "./store.ts";
import * as stylesModule from "./styles.ts";
import type { Transcript, Word } from "./transcribe.ts";

/** What a seam does until its package lands. */
export function unavailable(what: string): never {
  throw new Error(`${what} is not available`);
}

/**
 * A stub object whose every function throws "not available" naming it; its
 * constants (`known`) are there already.
 */
function stub<T extends object>(module: string, known: Partial<T> = {}): T {
  return new Proxy(known as T, {
    get(target, name) {
      if (typeof name !== "string" || name === "then") return undefined;
      if (name in target) return (target as Record<string, unknown>)[name];
      return (..._args: unknown[]) => unavailable(`${module}.${name}`);
    },
  });
}

type Json = unknown;

/** A package's REST routes, registered on the router. */
export type Routes = (router: Router<App>) => void;

/** Whether `error` is a seam's "not available" (callers with a sensible fallback use it meanwhile). */
export function isUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message.endsWith(" is not available");
}

// ---------------------------------------------------------------------------
// Shell, server core, shipping

/** One export at a time; what was exported since the server started (exports.ts). */
export interface Exports {
  /** Starts exporting `project` to `path` (or its default); returns where it goes. */
  start(store: Store, library: Library, project: Project, options: ExportOptions, path: string | null, extra?: StartExtra): Promise<string>;
  /** Cancels project `id`'s export; whether one was running. */
  cancel(id: string): boolean;
  /** Whether any export is running (an update waits for it). */
  running(): boolean;
  /** Local hardware contention only: cloud renders leave imports/analysis running. */
  localRunning?(): boolean;
  /** Whether `path` is a file exported since the server started (only those are handed out). */
  exported(path: string): boolean;
}

/** Self-update. */
export interface Updater {
  status(): Promise<Json>;
  install(): Promise<Json>;
  /** "nightly" or "stable". */
  setChannel(channel: string): Promise<Json>;
}

export interface ServerSeam {
  /** `<exports folder>/<name>.mp4`: the media drive's `Exports` when one is set, else ~/Movies/Edit. */
  defaultExportPath(store: Store, project: Project): string;
  /** Sets a found image's status; kept the first time, it goes into the media bin, named after its caption (research.reviewFound's). */
  reviewFound(app: App, id: string, item: string, status: string, origin: string): Promise<ResearchItem>;
}

export interface AppSeam {
  /** The binary that was started (process.execPath in the compiled `edit`). */
  originalExe(): string;
}

// server_seam.ts and app_seam.ts.
export const server: ServerSeam = serverModule;
export const app: AppSeam = appModule;

// ---------------------------------------------------------------------------
// Cloud

/** A file Edit adds as media, and where it is on R2 when it's a cloud media. */
export interface Made {
  path: string;
  name: string;
  probe: Probe;
  cloud: NonNullable<Media["cloud"]> | null;
}

/** A Drive file put on R2. */
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
  /** Media id → a local copy of its sound, mixed instead of the original (cloud_media `soundCopy`). */
  sounds?: Record<string, string>;
}

export interface CloudMediaSeam {
  /** Starts a backfill of cloud project `id` in the background. */
  backfillSoon(app: App, id: string): void;
  /** The media a script plays from Drive file `original`: an excerpt per span the `ranges` need. */
  driveExcerpts(cache: string, original: Original, ranges: [number, number][], input?: string | null, onCut?: (done: number, total: number) => void): Promise<Excerpt[]>;
  /** Puts YouTube video `file` (`youtube:<id>`) on R2 unless the registry has it; the download it was cut from here, for the caller to remove. */
  youtubeOriginal(
    home: string,
    file: string,
    scratch: string,
    progress: (bytes: number, total: number | null, name: string) => void,
  ): Promise<[Original, string | null]>;
  /** Puts Drive file `file` on R2, streamed from Drive into the upload, unless the registry has it. */
  driveOriginal(file: string, scratch: string, progress: (bytes: number, total: number | null, name: string) => void): Promise<Original>;
  /** `project` as an export of frames start..end reads it: cloud media pointing at their originals (presigned URLs). */
  forExport(project: Project, start: number, end: number, cache: string): Promise<[Project, Originals]>;
  forWorker(project: Project, start: number, end: number): Promise<{ project: Project; assets: import("@edit/types/worker").WorkerAsset[] }>;
  /** Puts a file from this machine in the cloud (deduplicated by content) and returns the media to add; footage's uploads finish in the background. */
  importLocal(cache: string, path: string, probe: Probe, name: string): Promise<Made>;
  /** Resolves once the background uploads importing `file` are done: whether they all went up. */
  uploaded(file: string): Promise<boolean>;
  /** Removes Edit's own copy of a browser upload once it's in the cloud (kept while it isn't). */
  removeWhenUploaded(file: string): void;
  /** Starts again an import's upload a restart cut short (its job's args). */
  resumeUpload(home: string, args: Record<string, unknown>): void;
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
  /**
   * The server's cloud projects: attaches the store's hook and starts the push loop.
   */
  start(app: App): void;
  /** `edit cloud …` outside a server: the relay token saved on this Mac, else the built-in one, unless the env sets one. */
  useSavedToken(home: string): void;
}

export interface CloudSeam {
  /**
   * `edit cloud [url | put | get | head | ls | rm | convex] …` prints what the relay answered; a failure is thrown with the
   * text `edit: <text>` shows (exit 2).
   */
  runCli(args: string[]): Promise<void>;
  /**
   * `edit cloud backfill <id> [--port N]`: asks the
   * running Edit to backfill a cloud project and prints its answer; the exit
   * code (1 when Edit refused); a failure to reach it is thrown (exit 2).
   */
  backfillCli(id: string | undefined, port: number): Promise<number>;
}

// cloud.ts, cloud_projects.ts and cloud_media.ts.
export const cloudMedia: CloudMediaSeam = cloudMediaModule;
export const cloudExports = cloudExportsModule;
export const modalExports = modalExportsModule;
export const cloudProjects: CloudProjectsSeam = {
  delete: (app, id) => cloudProjectsModule.remove(app, id),
  routes: (router) => cloudProjectsModule.routes(router),
  shutdown: () => cloudProjectsModule.shutdown(),
  start: (app) => {
    cloudProjectsModule.start(app);
  },
  useSavedToken: (home) => cloudProjectsModule.useSavedToken(home),
};
export const cloud: CloudSeam = {
  runCli: (args) => cloudModule.runCli(args),
  backfillCli: (id, port) => cloudModule.backfillCli(id, port),
};

// ---------------------------------------------------------------------------
// Script, voice, research (script.ts, voice.ts, voiceover.ts, research.ts;
// their routes are `script.routes`, their tools register as script_tools.ts
// loads, which this file does)

/** A stretch of a Drive file a script plays, as a file here. */
export interface Excerpt {
  /** The file (in cloud mode, the local proxy). */
  path: string;
  /** Seconds of the Drive file it covers: `from` is a keyframe. */
  from: number;
  to: number;
  /** In cloud mode: `path` is the local proxy, and this is the media to make. */
  cloud: Made | null;
}

/** A script Doc read into blocks. */
export interface Parsed {
  title: string;
  blocks: ScriptBlock[];
  /** A compilation's other case scripts (`script.joinCases` reads them in): each Doc goes after block `after`. */
  cases?: { after: number; doc: string }[];
}

/** What Drive serves for a file: the last response's headers after redirects. */
export interface DriveHead {
  /** HTTP status (0: no answer). */
  status: number;
  /** Drive sent a page (text/html) instead of the file. */
  html: boolean;
  /** Its name (content-disposition). */
  name: string | null;
  /** Its size in bytes, when Drive says. */
  total: number | null;
}

/** Script imports in progress, per project. */
export interface ScriptJobs {
  get(project: string): ScriptJob | null;
  /** Starts a job for `project` unless one is running; whether it did (says so as a `script` event). */
  claim(app: App, project: string, job: ScriptJob): boolean;
  /** Changes `project`'s job and says so (a `script` event). */
  set(app: App, project: string, edit: (job: ScriptJob) => void): void;
}

export interface ScriptSeam {
  attach(project: Project, source: string, parsed: Parsed): void;
  /** "1h02m03s": a time in an excerpt's name (seconds rounded, half away from zero). */
  clock(seconds: number): string;
  excerptExtension(ext: string): string;
  /** FFmpeg cut of `source` (a file or a presigned URL) from `start` to `to` into `out` (picture copied, sound AAC 192k). */
  cut(source: string, start: number, to: number, out: string): Promise<void>;
  docId(url: string): string | null;
  /** Seconds of a file (or a presigned URL's object): "couldn't read …" when ffprobe can't. */
  durationOf(path: string): Promise<number>;
  fetchDoc(id: string): Promise<[html: string, title: string]>;
  /** The keyframe at or before `time` (seconds); 0 when none is found. */
  keyframeBefore(path: string, time: number): Promise<number>;
  parse(html: string): Parsed;
  realign(app: App, id: string): Promise<Json[]>;
  /** Where to cut a range from its first and last words (transcript seconds; null where a word isn't found). */
  align(words: Word[], peaks: Uint8Array | null, cue: [string, string], start: number, end: number): [number | null, number | null];
  /** The URL that downloads Drive file `file` (past the virus-scan page) and its headers; `scratch` may be written and is removed. */
  resolve(file: string, scratch: string): Promise<[url: string, head: DriveHead]>;
  /** A file name safe on every disk: no separators or leading dots ("footage.mp4" when nothing's left). */
  safeName(name: string): string;
  /** The spans of a file that `ranges` need (10 s handles, joined under 120 s apart, inside the file). */
  spans(ranges: [number, number][], duration: number): [number, number][];
  /** Downloads the script's footage and lays it out in the background; the work, or null when one runs already. */
  start(app: App, projectId: string, recut: boolean): Promise<void> | null;
  summary(parsed: Parsed): Json;
  unfinished(project: Project): boolean;
  /** `/api/scripts/preview`, `/api/projects/{id}/script`, `/api/projects/{id}/script/job`. */
  routes: Routes;
}

/** Voice-over projects, `<home>/voice/<id>/`. */
export interface Voices {
  list(): Json[];
  get(id: string): VoiceProject;
  create(name: string, source: string | null, lines: [string, string | null][]): VoiceProject;
  forProject(name: string, source: string, lines: [string, string | null][]): VoiceProject;
  save(project: VoiceProject): void;
  /** The UI's changes (`Changes`, as JSON; refused in serde's words). */
  update(id: string, changes: Json): VoiceProject;
  delete(id: string): void;
  deleteTake(id: string, line: string, take: string): VoiceProject;
  generate(id: string, line: string): Promise<VoiceProject>;
  takePath(id: string, take: string): string;
  chosenTakes(id: string): [number, string | null, string][];
  voices(refresh: boolean): Promise<Json>;
  full(id: string): Promise<string>;
}

export type VoiceProject = import("./voice.ts").VoiceProject;

export interface VoiceSeam {
  /** The lines of a video project's script narration (its cut-ins), in order, with their labels. */
  narrationLines(project: Project): [string, string | null][];
  /** `/api/voice/*`. */
  routes: Routes;
}

export interface VoiceoverSeam {
  /** Whether any cut-in already plays a voice-over. */
  anyPlaced(project: Project): boolean;
  /** Speaks the script's cut-ins with the house voice and lays the takes on them. */
  generate(app: App, id: string): Promise<Json>;
  isVoiceover(project: Project, clip: Clip): boolean;
  place(app: App, id: string, media: string[] | null): Promise<Json>;
  send(app: App, voiceId: string, id: string): Promise<Json>;
  /** Plays the voice-overs between `from` and `to` `speed` times faster (changes `project`); (sped start, sped end, frames saved). */
  speedUp(project: Project, from: number, to: number, speed: number): [number, number, number];
  tighten(app: App, id: string, span: [number, number], maxPause: number, keep: number, dryRun: boolean): Promise<Json>;
  /** The voice-overs heard in frames [from, to). */
  voiceoverSound(project: Project, from: number, to: number): Clip[];
}

/** A found image awaiting review. */
export interface ResearchItem {
  /** The first 16 hex digits of the file's SHA-256. */
  id: string;
  file: string;
  width: number;
  height: number;
  title: string;
  page: string;
  image: string;
  query: string;
  /** new | kept | rejected. */
  status: string;
  /** The media it became once kept. */
  media?: string;
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
  /** The case's names for the transcriber (names.ts), listed again when its articles or script changed. */
  caseNames(app: App, project: Project): Promise<string[]>;
  /** The names last listed for the case, none asked for. */
  knownNames(app: App, project: Project): string[];
  clear(home: string, project: string, status: string): number;
  collect(home: string, project: string, queries: string[], perQuery: number): Promise<[added: number, had: number, failed: number]>;
  collecting(project: string): boolean;
  items(home: string, project: string): ResearchItem[];
  readPage(url: string, limit: number): Promise<string>;
  reject(home: string, project: string, ids: string[]): number;
  /** Sets a found image's status; kept the first time, it goes into the media bin, named after its caption. */
  reviewFound(app: App, id: string, item: string, status: string, origin: string): Promise<ResearchItem>;
  searchWeb(query: string): Promise<WebResult[]>;
  /** A found image shrunk into a 320×240 cell (letterboxed) as RGBA, for contact sheets. */
  thumbnail(path: string): Promise<import("./native/index.ts").RawImage | null>;
  update(home: string, project: string, id: string, change: (item: ResearchItem) => void): ResearchItem;
  /** `/api/projects/{id}/research/*`. */
  routes: Routes;
}

// Filled. Their modules import this file too; a namespace is there (if not
// yet filled) whichever loads first, and nothing reads it before the first call.
export const script: ScriptSeam = scriptModule;
export const voice: VoiceSeam = voiceModule;
export const voiceover: VoiceoverSeam = voiceoverModule;
export const research: ResearchSeam = researchModule;

// ---------------------------------------------------------------------------
// Subtitles, speakers, people, seats, faces

/** A transcript word in ms of its clip's source. */
export interface TimedWord {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker: string | null;
  /** Its end was cut back to when it could have been said (`longestMs`): the transcriber stretched it over a silence. */
  stretched?: true;
}

/** A subtitle: words [from, to) of the clip's list. */
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
  /**
   * Its words' times are doubtful: the word before it was stretched over the
   * silence where these were most likely said (`uncram` may move it back).
   */
  doubtful?: boolean;
}

/** A house word to mute (and maybe star). */
export interface Suggestion {
  term: string;
  starred: boolean;
  display: string | null;
  word: number;
  at_ms: number;
  start_ms: number;
  end_ms: number;
}

/** A house word found in the footage's sound. */
export interface Found {
  clip: string;
  suggestion: Suggestion;
  timeline_ms: [number, number];
}

/** Per audio clip: the stretch looked at (source seconds) and its mutes there. */
export type ClipMutes = Map<string, [from: number, to: number, mutes: Mute[]]>;

export interface HouseWords {
  mutes: ClipMutes;
  found: Found[];
  listed: Json[];
  /** Words left unmuted on purpose ("not muted" media markers): the term and when it's said (timeline ms). */
  kept: Kept[];
}

/** A house word said where it isn't what the list is for ("it hit her" as realising): never muted or starred there. */
export interface Kept {
  term: string;
  /** When the word starts (timeline ms). */
  at_ms: number;
  timeline_ms: [number, number];
}

export interface SubtitleOptions {
  from: number;
  to: number;
  neglect: boolean;
  hold_ms: number;
  overlap: boolean;
  faces: boolean;
  /**
   * Faces found frame by frame (moving_seats.ts) rather than per camera
   * angle: questioning on a moving camera (bodycam at a cruiser).
   */
  moving?: boolean;
}

export interface SubtitlesSeam {
  readonly DEFAULT_HOLD_MS: number;
  /** How far before its first word a line may come up to be read (ms). */
  readonly LEAD_MS: number;
  /** A subtitle's rough box (project pixels) for `text` wrapped at `textWidth` (character counts, no font metrics). */
  boxSize(text: string, textWidth: number, k: number): [number, number];
  fillSegments(given: Segment[], duration: number): Segment[];
  /** The footage's own sound in the span: audio clips of video files on tracks that are heard. */
  footageSound(project: Project, from: number, to: number): Clip[];
  lockSubtitles(project: Project, from?: number, to?: number): number;
  movedSubtitles(project: Project, from?: number, to?: number): string[];
  /** Starts a subtitle run of project `id` (`latestRun` says whether a newer one has started since). */
  beginRun(id: string): number;
  latestRun(id: string, run: number): boolean;
  SUPERSEDED: Json;
  hiddenRole(role: string): boolean;
  houseStyle(width: number, height: number, color: Rgba): TextStyle;
  houseWords(app: App, project: Project, from: number, to: number, neglect: boolean, extra?: readonly string[]): Promise<HouseWords>;
  longestMs(word: string): number;
  muteHouseWords(app: App, projectId: string, from: number, to: number, neglect: boolean, extra?: readonly string[], keep?: readonly number[]): Promise<Json>;
  repackSubtitles(app: App, projectId: string, options: SubtitleOptions): Promise<Json>;
  roleOf(role: string | null, name: string): string;
  segment(words: TimedWord[]): Cue[];
  silentRole(role: string): boolean;
  star(text: string, found: Suggestion[]): string;
  starOnScreen(project: Project, from: number, to: number, neglect: boolean, extra?: readonly string[], kept?: readonly Kept[]): number;
  suggestions(words: TimedWord[], neglect: boolean, fromMs: number, toMs: number, extra?: readonly string[]): Suggestion[];
  timedWords(words: Word[], from: number, to: number): TimedWord[];
  /** Repack's tokeniser: /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu on lowercase text. */
  tokens(text: string): string[];
  uncram(lines: Line[]): void;
  writeMutes(project: Project, mutes: ClipMutes): void;
  /**
   * The subtitles package's routes (`/api/projects/{id}/repack-subtitles`,
   * `/api/projects/{id}/media/{media}/speakers`), registered on the router.
   * Its MCP tools register when the package loads (any use of this file).
   */
  routes(router: import("./http/router.ts").Router<App>): void;
}

/** One person on screen across the whole video, for `distinct`. */
export interface Person {
  role: string;
  lines: number;
  color: string;
  /** Their label or name ("Female Sergeant"): a woman officer may be pink. */
  name?: string;
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
  /** Names the voices of every transcript that comes in, from now on (the server starts it); returns a way to stop. */
  watch(app: App): () => void;
}

export interface PeopleSeam {
  /** Gives every person one colour across the video; each person with their colour and how many clips changed. */
  oneColourPerPerson(project: Project): Json;
  /** Each person's line count, colour and transcript names, for get_edit_context. */
  summary(project: Project): Record<string, string>;
}

/**
 * Where a face is: [x0, y0, x1, y1], corners as shares of the picture from
 * its top left (the engine's faces.rs), or, once `inFrame` has placed it,
 * project pixels from the frame's centre.
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
  picturesOnFaces(project: Project): Json[];
  punchInsOffFace(project: Project, teasers: [number, number][]): Json[];
}

// subtitles.ts, speakers.ts, people.ts and faces.ts (seats.ts is behind
// subtitles). They import this file too; a module namespace is
// there (if not yet filled) whichever of the two loads first, and nothing
// reads it before the first call.
export const subtitles: SubtitlesSeam = subtitlesModule;
export const speakers: SpeakersSeam = speakersModule;
export const people: PeopleSeam = peopleModule;
export const faces: FacesSeam = facesModule;

// ---------------------------------------------------------------------------
// Captions, watching, review

/** Where place_captions puts a caption. */
export type Under = { kind: "auto" } | { kind: "bottom" } | { kind: "at"; x: number; y: number };

export interface CaptionsSeam {
  /** The house caption look (bodycam's speaker captions): Montserrat with a glow in its colour, a see-through box with a wide soft shadow. */
  captionStyle(width: number, height: number): TextStyle;
  /** A caption's rough size (project pixels): wrapped at the style's width. */
  captionSize(text: string, style: TextStyle): [number, number];
  captionSpeakers(app: App, projectId: string, from: number, to: number): Promise<Json>;
  /**
   * Tracks `region` (project pixels from the top-left at timeline `time`) and keys clip `follow` to move with it
   * (track_region): `more` are sightings at other moments (timeline seconds, box); `what` the param keyed
   * (position, vignette, leader, blur); `place` on, above or below. What it did, in words.
   */
  followRegion(
    app: App,
    projectId: string,
    time: number,
    region: [number, number, number, number],
    more: [number, [number, number, number, number]][],
    follow: string,
    place: string,
    what: string,
    offset: [number, number],
  ): Promise<string>;
  /** "#00e5c7" → a colour. */
  hex(text: string): Rgba | null;
  /** The intro (frames), when the project follows a script. */
  intro(project: Project): [number, number] | null;
  placeCaptions(app: App, projectId: string, from: number, to: number, under: Map<string, Under>): Promise<Json>;
  /** A known speaker's first name; a short role when no name is known. */
  subtitleName(name: string): string;
  subtitles(app: App, projectId: string, from: number, to: number, neglect: boolean): Promise<Json>;
  /** A media's transcript, transcribing it first if needed. */
  /** A media's transcript; given the project, heard with the case's names (names.ts). */
  transcriptOf(app: App, media: Media, project?: Project): Promise<Transcript>;
  /**
   * The captions package's routes (`/api/projects/{id}/captions`, `/api/projects/{id}/watch`,
   * `/api/projects/{id}/media/{media}/transcribe`), registered on the router. Its MCP tools
   * register when the package loads (any use of this file).
   */
  routes(router: import("./http/router.ts").Router<App>): void;
}

export interface EditReviewSeam {
  calloutTiming(project: Project, transcripts: Map<string, Transcript>): Json[];
  textLate(project: Project, transcripts: Map<string, Transcript>): unknown[];
  cutMidWord(project: Project, transcripts: Map<string, Transcript>): Json[];
  deadAir(project: Project, transcripts: Map<string, Transcript>, spans: [number, number][]): Json[];
  spokenWords(project: Project, transcripts: Map<string, Transcript>): [number, string][];
  lineFrames(lines: string[], heard: [number, string][], from: number, to: number): (number | null)[];
  offScript(project: Project, transcripts: Map<string, Transcript>): Json[];
  textNotSaid(project: Project, transcripts: Map<string, Transcript>): Json[];
  unsubtitledSpeech(project: Project, transcripts: Map<string, Transcript>): Json[];
  subtitleCoverage(project: Project, transcripts: Map<string, Transcript>): Json;
}

export interface FootageSearchSeam {
  find(app: App, project: Project, phrases: string[], limit: number, context: number): Json;
}

/** A stretch of footage the watcher sends at once. */
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

// captions.ts (with captions_core.ts for `hex`,
// `transcriptOf`, `subtitleName` and `captionSize`), edit_review.ts,
// footage_search.ts and watch.ts; captions_tools.ts has their tools and routes.
export const captions: CaptionsSeam = captionsModule;
export const editReview: EditReviewSeam = editReviewModule;
export const footageSearch: FootageSearchSeam = footageSearchModule;
export const watch: WatchSeam = watchModule;

// ---------------------------------------------------------------------------
// Editing tools and plans

export interface StylesSeam {
  /** What the agent's instructions say about the project's style. */
  instructions(style: Style): string;
}

export interface SfxSeam {
  /** The marker a placed sound lines up on the cut. */
  readonly HIT: string;
  /** A sound effect's name saying it's one moment (a whoosh, a hit), not a bed. */
  readonly MOMENT: RegExp;
  /** A one-moment effect longer than this (seconds) plays only its hit. */
  readonly LONG_MOMENT: number;
  /** How long a hit plays (seconds) when not told. */
  readonly HIT_PLAY: number;
}

/** How a sound is placed. */
export interface PlacedSound {
  volume_db: number;
  /** Plays at most this long: for a sound with a hit, the stretch around it, `lead` seconds before it (default half). */
  seconds: number | null;
  lead: number | null;
  /** Seconds of fade at the end. */
  fade_out: number;
  color: Clip["color"];
}

/** The editing tools' helpers other packages' tools use (add_from_library places its sounds with them). */
export interface EditingSeam {
  /** Where a sound goes: its `times` (timeline seconds) and every place each of its `markers` (names) is. */
  soundTimes(store: Store, id: string, args: Record<string, unknown>): number[];
  /**
   * Places a sound already in the project's media at timeline times on a free
   * audio track (never A1), its "hit" marker (else its start) on each time; the
   * same sound within 0.5 s of a time gives way. `markers` go to the media if it
   * has none. Says what it placed ("placed … at 1.00s (replacing 0 …)").
   */
  placeSound(
    store: Store,
    id: string,
    mediaId: string,
    name: string,
    markers: Marker[],
    times: number[],
    sound: PlacedSound,
  ): Promise<string>;
  /** Timeline seconds for each marker name; an unknown name is an error listing the names there are. */
  markerTimes(project: Project, names: string[]): number[];
  /** Words heard on the timeline as phrases with timeline times (read_transcript's answer). */
  timelineTranscript(app: App, project: Project): string;
}

export const styles: StylesSeam = stylesModule;
export const sfx: SfxSeam = sfxModule;
// Required when first called: edit_tools.ts reaches the other seams itself.
export const editing: EditingSeam = {
  soundTimes: (...args) => (require("./edit_tools.ts") as typeof import("./edit_tools.ts")).soundTimes(...args),
  placeSound: (...args) => (require("./edit_tools.ts") as typeof import("./edit_tools.ts")).placeSound(...args),
  markerTimes: (...args) => markersModule.times(...args),
  timelineTranscript: (...args) => (require("./edit_tools.ts") as typeof import("./edit_tools.ts")).timelineTranscript(...args),
};

// ---------------------------------------------------------------------------
// Media sources, sound, agent

/** The Codex bridge behind the agent panel. */
export interface Agents {
  status(): Promise<Json>;
  /**
   * One question to a model through the user's Codex: an
   * ephemeral read-only thread with `instructions` as its developer
   * instructions, `input` its user turn (Codex input items), the answer held
   * to `schema` when given; the answer's text, or a thrown Error after
   * `timeoutMs`. speakers.ts names voices with it.
   */
  ask(model: string, effort: string, instructions: string, input: Json[], schema: Json | null, timeoutMs: number): Promise<string>;
  /** Edit is quitting: running turns end and say so (and are noted to carry on), and the agents' processes are stopped. */
  shutdown?(): void;
  /** Edit is back: the turns its last quit cut short carry on, when that was a restart (minutes ago). */
  resumeInterrupted?(): void;
}

/**
 * The agent panel's side of the bridge, which `App.agents`
 * is in the server (agent.ts): `agentPanel(app)` for it. Tests' agents may
 * answer only `status` and `ask`.
 */
export interface AgentPanel extends Agents {
  /** The models the user's Codex offers (cached a day; `refresh` asks now). */
  models(refresh: boolean): Promise<Json>;
  /** A project's chat: its entries, whether a turn is running, its model and effort. */
  chat(project: string): Json;
  /** Sends the user's (or Edit's: the script's research) message to a project's chat, starting its turn. */
  send(project: string, text: string, model: string | null, effort: string | null): Promise<void>;
  /** Stops a project's running turn. */
  stop(project: string): Promise<void>;
  /** Forgets a project's chat (and its Codex thread). */
  reset(project: string): void;
  /** Where new turns run: "claude" (the user's Claude Code) or "codex". */
  setProvider(provider: "claude" | "codex"): void;
  /** Settings: each CLI's status (`claude`, `codex`) and the `provider` chosen. */
  clis?(): Promise<Json>;
}

/** The app's agents as the panel (and the script's research turn) use them. */
export function agentPanel(app: App): AgentPanel {
  return app.agents as AgentPanel;
}

/** The team's sound library on Drive. */
export interface Library {
  /** A Google access token for Drive calls (the library's sign-in, shared by drive.ts). */
  accessToken(): Promise<string>;
}

/** A library sound. */
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
  /** Starts again the moving map shot whose stand-in is `first`, from its frames; false when it can't. */
  resumeMap?(app: App, projectId: string, first: string): boolean;
  stopLeftoverMaps?(): number;
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

// broll.ts, drive.ts and library.ts (and agent.ts, which
// App carries as `agents`, with library.ts's Library as `library`).
export const broll: BrollSeam = brollModule;
export const drive: DriveSeam = driveModule;
export const library: LibrarySeam = libraryModule;

/** The services App carries that other packages make: stubs for a test to replace, but the script jobs and voices. */
export function stubServices(home: string): {
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
    scripts: new scriptModule.Jobs(),
    library: stub("library"),
    voices: new voiceModule.Voices(home),
  };
}
