// What a person sees when something goes wrong: a short title, what they can
// do about it, and a button when there's one thing to press. Never "try
// again" for what Edit already tries again by itself, or what trying again
// can't fix (the team: "not give users a lot of retry options"): Try again
// is offered only after something the person does (shares the file, signs in
// to YouTube, frees space). The original
// words are kept for Report and the log, never shown first. The agent still
// gets the original words (it needs the detail to fix its own work); this is
// for people (the team: "an error so long it goes out of the dialog box, and
// my team member sends it to me asking what this is").
//
// Known cases are matched below, from the messages the team actually saw (the
// logs, Oct 28). A message already written for people (short, no paths, codes
// or tool names) is shown as it is; anything else gets the plain fallback.

/** The one thing to press, when there is one. */
export type ProblemAction = "retry" | "sign-in" | "claude-sign-in";

export interface Problem {
  /** What went wrong, in a few plain words. */
  title: string;
  /** What to do about it, in a sentence or two (empty when there's nothing to do). */
  fix: string;
  action?: ProblemAction;
  /** The original words, for Report (never shown first). */
  details: string;
  /** Whether a known case was matched (false: the message as it was, or the fallback). */
  known: boolean;
}

/**
 * The local time of the next midnight in `zone`, when a daily allowance
 * resets ("2:00"): UTC for the team's own (the relay's), California for
 * Gemini's free quota.
 */
export function resetTime(zone = "UTC", now: Date = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(now)
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  const into = ((parts.hour ?? 0) * 3600 + (parts.minute ?? 0) * 60 + (parts.second ?? 0)) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() + 86_400_000 - into).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

type Said = Omit<Problem, "details" | "known">;
type Rule = [RegExp, (match: RegExpExecArray, doing: string) => Said];

const tryAgainLater = "It's usually free again within a minute.";
const daily = (what: string, zone = "UTC"): Said => ({
  title: `Today's ${what} allowance is used up`,
  fix: `It resets at ${resetTime(zone)} your time. Everything else in the edit works as normal meanwhile.`,
});

/** Most specific first: the first match wins. */
const RULES: Rule[] = [
  // Trello cards are read through Writer's relay; when it refuses Edit, it says "Sign in to Writer".
  [/Sign in to Writer|Trello import refused/i, () => ({
    title: "Edit can't read Trello cards right now",
    fix: "That's on our side, not your sign-in. For now, paste the card's script Doc link (or its case links) instead of the card.",
  })],
  // Signed out.
  [/Sign in to Edit|signed-in people only|Your sign-in ended|invalid_grant/i, () => ({
    title: "You're signed out of Edit",
    fix: "Sign in again (the account menu, top right). Your work is kept.",
    action: "sign-in",
  })],
  [/This Edit is out of date/i, () => ({
    title: "This copy of Edit is too old",
    fix: "Update Edit (the Update button at the top), then sign in again.",
  })],
  [/Claude (Code )?(needs to sign in|isn't signed in|sign-in)|Sign in to Claude|claude auth login|\/login/i, () => ({
    title: "Claude needs you to sign in again",
    fix: "Press Sign in to Claude and follow the steps in your browser. Then send your message again if the agent doesn't carry on by itself.",
    action: "claude-sign-in",
  })],
  [/(Claude|Codex|Anthropic|OpenAI)[^.]*(usage limit|rate.?limit|overloaded)|overloaded_error|usage limit reached|5-hour limit|weekly limit/i, () => ({
    title: "Claude is busy or at its usage limit",
    fix: "Wait a little, then send your message again. If it keeps happening, the account's limit is used up until it resets (Claude says when).",
  })],

  // The team's daily allowances (the relay's limits).
  [/hearing footage again with the case's names is used up/i, () => ({
    title: "Today's allowance for re-hearing footage is used up",
    fix: `New footage is still transcribed. Names can be checked again after ${resetTime()} your time; nothing else waits.`,
  })],
  [/transcription (allowance|budget)[^.]*used up/i, () => daily("transcription")],
  [/voice (allowance|budget)[^.]*used up/i, () => daily("voice-over")],
  [/map (allowance|budget|lookups)[^.]*used up/i, () => daily("map")],
  [/no Gemini model left today/i, () => daily("AI", "America/Los_Angeles")],
  [/AI (allowance|budget)[^.]*used up/i, () => daily("AI")],
  [/positive credit balance is required/i, () => ({
    title: "The team's AI credit has run out",
    fix: "An admin needs to top up the AI Gateway credit. The edit carries on without the AI checks until then.",
  })],
  [/Cloud export daily compute reservation limit/i, () => ({
    title: "Today's cloud exports are used up",
    fix: "Try again tomorrow, or ask whoever looks after Edit to export it on their Mac.",
  })],
  [/Too many (transcriptions|lines|lookups|maps|model calls|requests) at once|transcription busy/i, () => ({
    title: "Lots of people are using this at once",
    fix: tryAgainLater,
  })],

  // This Mac.
  [/ENOSPC|No space left on device|disk is full|not enough (disk )?space/i, () => ({
    title: "Your Mac's disk is full",
    fix: "Free some space (empty the Bin, move old footage or exports to another drive), then try again.",
    action: "retry",
  })],
  [/EACCES|EPERM|Permission denied|Operation not permitted/i, () => ({
    title: "Edit isn't allowed to use that file or folder",
    fix: "Use a folder in your home folder, or allow Edit in System Settings → Privacy & Security → Files and Folders.",
  })],
  [/ENOENT|No such file or directory/i, () => ({
    title: "A file Edit needs is missing",
    fix: "If it was on an external drive, plug the drive in. Otherwise import the file again.",
  })],

  // Edit's own server and the internet.
  [/Can't reach Edit's server|Couldn.t reach Edit|Failed to fetch|NetworkError when attempting/i, () => ({
    title: "Edit isn't responding",
    fix: "It may be restarting after an update (a few seconds). If it doesn't come back, quit Edit and open it again.",
  })],
  [/could not reach Edit's relay|could not reach the transcription relay|could not reach R2|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|The connection was closed|getaddrinfo|network (is )?(down|unreachable)/i, () => ({
    title: "Edit couldn't reach the internet",
    fix: "Check your Wi-Fi or connection.",
  })],

  // Google Drive and Docs.
  [/Couldn't read the reused script (\S+?):\s/i, (match) => ({
    title: "A script linked in this one can't be read",
    fix: `Share ${match[1]} so anyone with the link can view (any Google Doc linked in a script is read as a script to reuse), or take its link out of the script.`,
    action: "retry",
  })],
  [/Google Drive's download limit|Too many users/i, () => ({
    title: "Google Drive won't share that file again today",
    fix: "Make a copy in Drive (right-click → Make a copy) and use the copy's link.",
  })],
  [/isn't shared|Share it so anyone with the link|anyone with the link can view/i, () => ({
    title: "That Google file isn't shared",
    fix: "In Google Drive, open Share and set it to \"Anyone with the link\", then try again.",
    action: "retry",
  })],
  [/Google Drive can't find|deleted, or in the trash|isn't there, or this account can't see it/i, () => ({
    title: "That Google Drive file is gone",
    fix: "It was deleted or moved to the trash. Restore it in Drive, or use another link.",
  })],
  [/there's no video in that Drive folder/i, () => ({
    title: "That Drive folder has no videos",
    fix: "Check it's the right folder, or paste the video's own link.",
  })],
  [/Google Drive (answered|sent a page)|Google Drive \d{3}/i, () => ({
    title: "Google Drive is having trouble",
    fix: "Edit tried again and Google still had trouble. It usually passes within the hour.",
  })],

  // YouTube.
  [/Private video|This video is private/i, () => ({
    title: "That YouTube video is private",
    fix: "Ask its owner for access, or use another copy (a Drive link works).",
  })],
  [/confirm your age|age.restricted|inappropriate for some users/i, () => ({
    title: "That YouTube video is age-restricted",
    fix: "Edit uses your YouTube sign-in from Chrome for these. Set it up in Settings → YouTube (it says how), then try again.",
    action: "retry",
  })],
  [/members.only|Join this channel/i, () => ({
    title: "That YouTube video is for channel members only",
    fix: "Sign in to YouTube in Chrome with an account that's a member and check Settings → YouTube, then try again; or use another copy.",
    action: "retry",
  })],
  [/not available in your country|blocked it in your country|geo.?restrict/i, () => ({
    title: "That YouTube video is blocked in this country",
    fix: "Use another copy of it (a Drive link works).",
  })],
  [/Video unavailable|has been removed|account associated with this video has been terminated|This video is no longer available/i, () => ({
    title: "That YouTube video is no longer available",
    fix: "It was taken down. Use another copy of it, or a different video.",
  })],
  [/live event will begin|Premieres in|is (currently )?live|This live stream/i, () => ({
    title: "That YouTube video is still live",
    fix: "Wait until the stream has ended and YouTube has processed it, then try again.",
  })],
  [/not a bot|Sign in to confirm you|page needs to be reloaded|HTTP Error 403|HTTP Error 429/i, () => ({
    title: "YouTube is blocking downloads for now",
    fix: "Set up the YouTube sign-in in Settings → YouTube (Edit uses Chrome's), then try again. It usually passes within the hour anyway.",
    action: "retry",
  })],
  [/requested format is not available|only images are available|did not produce a video|YouTube video \S+ couldn't be downloaded/i, () => ({
    title: "YouTube didn't send the video",
    fix: "Edit tried every way it has. Use another copy of it (a Drive link works).",
  })],

  // Footage files.
  [/No suitable graphics adapter|wgpu error|rendering a frame crashed/i, () => ({
    title: "Edit couldn't draw this frame",
    fix: "Quit Edit and open it again. If it keeps happening, press Report.",
  })],
  [/Preview (decoding )?failed|Preview failed to start|Still waiting for frame/i, () => ({
    title: "The preview couldn't show this frame",
    fix: "Move the playhead or press play to try again. If it stays, quit Edit and open it again.",
  })],
  [/\bNo (native )?video track/i, () => ({
    title: "That file has no picture",
    fix: "It's sound only. Use it as audio, or choose the video file instead.",
  })],
  [/Invalid data found|moov atom not found|could not find codec parameters|couldn't read the footage|Couldn't cut an excerpt|EncodingError|Decoder error|failed to fill whole buffer|could not decode/i, () => ({
    title: "Edit can't read that video",
    fix: "The file may be damaged or only partly downloaded. Download it again from where it came from, then import it again.",
  })],
  [/The download ended early|Download stopped|stood still|stalled/i, () => ({
    title: "The download was cut off",
    fix: "Edit tried again several times. Check your connection.",
  })],

  // Exports and editing.
  [/export is already running|already has an export running/i, () => ({
    title: "Another export is running",
    fix: "Wait for it to finish, or cancel it in Exports (top bar), then export again.",
  })],
  [/would overwrite source footage/i, () => ({
    title: "That would replace your footage",
    fix: "Choose a different name for the export.",
  })],
  [/map view is still rendering|still only its first frame/i, () => ({
    title: "A map is still being made",
    fix: "Export again once it's done (a minute or so).",
  })],
  [/cloud export (stopped|failed)|Cloud export \S+ is still queued|Invalid cloud export|export can't render in the cloud/i, () => ({
    title: "The cloud export didn't finish",
    fix: "Press Report so we can see what went wrong.",
  })],
  [/isn't in the cloud/i, () => ({
    title: "That file isn't in the cloud yet",
    fix: "It's still uploading from the Mac that added it: give it a few minutes.",
  })],
  [/revision conflict|saved elsewhere since rev/i, () => ({
    title: "This edit changed at the same moment",
    fix: "Someone (or the agent) changed it just then. Make your change again.",
  })],
  [/being edited on another|another (Mac|computer) is (editing|working on)/i, () => ({
    title: "Someone else is working on this edit",
    fix: "Wait for them to finish, or take it over from the banner at the top.",
  })],
  [/update when it's done/i, () => ({
    title: "Edit will update when the work running now finishes",
    fix: "Your export, upload or import keeps going; press Update again once it's done.",
  })],
];

/** Words that say a message was written for us, not for a person. */
const TECHNICAL =
  /\/[\w.-]+\/|https?:\/\/|\b(?:stderr|stdout|exit (?:code )?\d|ffmpeg|ffprobe|curl|yt-dlp|R2|relay|convex|JSON|undefined|null|NaN|ETag|EDIT_\w+|\w+Error\b|errno|stack|\(\d{3}\)|\d{3} for|at \w+ \()/i;

/** A message already fit for a person: short, one or two sentences, nothing technical. */
function plain(message: string): boolean {
  return message.length <= 160 && !TECHNICAL.test(message) && !message.includes("\n");
}

function sentence(text: string): string {
  const trimmed = text.trim().replace(/^Error:\s*/i, "");
  if (trimmed === "") return trimmed;
  const capital = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  return /[.!?…)"”]$/.test(capital) ? capital : `${capital}.`;
}

/** The words of an error, a string or anything else thrown. */
export function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
}

/**
 * What to tell a person about `error`, while `doing` something ("export the
 * video", said as "Couldn't export the video" when nothing better is known).
 */
export function explain(error: unknown, doing = ""): Problem {
  const details = messageOf(error).trim();
  for (const [pattern, say] of RULES) {
    const match = pattern.exec(details);
    if (match !== null) return { ...say(match, doing), details, known: true };
  }
  const title = doing === "" ? "Something went wrong" : `Couldn't ${doing}`;
  if (details !== "" && plain(details)) {
    // Already written for a person: say it, under what was being done.
    return doing === "" ? { title: sentence(details), fix: "", details, known: false } : { title, fix: sentence(details), details, known: false };
  }
  return {
    title,
    fix: "Press Report so we can see what happened.",
    details,
    known: false,
  };
}
