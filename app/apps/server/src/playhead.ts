// Where the playhead is when someone writes to the agent, read to it with the
// message so it starts there (the user, Oct 30: "when we tell the agents to
// make some changes, it first looks at our current playhead … If our change
// isn't at all related to the current context, it then will … look at other
// areas … changes are made there, right there and then … we just keep going
// back and forth"). The chat shows only what was typed.

import type { Clip, Project } from "./model.ts";
import { native } from "./native/index.ts";
import { clipEnd, fps as fpsOf, mediaOf } from "./project.ts";
import { jsonForSerde } from "./rust.ts";
import type { Transcript } from "./transcribe.ts";

/** Seconds either side of the playhead whose clips are listed. */
const AROUND = 15;
/** Seconds either side of it whose words are given. */
const SAID = 4;

const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;

/** One clip in a line: id, track, kind and name, where it is and what it plays. */
function line(project: Project, clip: Clip, fps: number): string {
  const track = project.tracks.findIndex((one) => one.id === clip.track);
  const kind = project.tracks[track]?.kind === "audio" ? "a" : "v";
  const what: string[] = [`${clip.id} ${kind}${project.tracks.filter((one, index) => index <= track && one.kind === project.tracks[track]?.kind).length} ${clip.type}`];
  if (clip.name) what.push(`"${clip.name}"`);
  if (clip.type === "text") what.push(`"${clip.text.slice(0, 80)}"`);
  if ((clip.type === "video" || clip.type === "audio") && clip.media) {
    const media = mediaOf(project, clip.media);
    if (media !== undefined) what.push(`(${media.name} @ ${clip.source_in.toFixed(1)} s${clip.speed !== 1 ? `, ${clip.speed}×` : ""})`);
  }
  what.push(`frames ${clip.start}–${clipEnd(clip)} (${clock(clip.start / fps)}–${clock(clipEnd(clip) / fps)})`);
  return what.join(" ");
}

/** What the agent reads after a message sent with the playhead at `frame`. */
export function playheadContext(project: Project, frame: number, heard: Map<string, Transcript>): string {
  const fps = fpsOf(project);
  const at = Math.max(0, Math.round(frame));
  let section = "";
  try {
    const part = native().sections({ json: jsonForSerde(project) }).parts.find((one) => one.start <= at && at < one.end);
    if (part !== undefined) section = `, in ${part.label}`;
  } catch {
    // An edit without sections (no script): just the time.
  }
  const under = project.clips.filter((clip) => clip.start <= at && at < clipEnd(clip));
  const [from, to] = [at - AROUND * fps, at + AROUND * fps];
  const near = project.clips.filter((clip) => !under.includes(clip) && clip.start < to && clipEnd(clip) > from).sort((a, b) => a.start - b.start);
  // The words heard within a few seconds of it: the footage's sound and the narration.
  const words: { at: number; text: string }[] = [];
  for (const clip of project.clips) {
    if (clip.type !== "audio" || clip.start > at + SAID * fps || clipEnd(clip) < at - SAID * fps) continue;
    const transcript = heard.get(clip.media);
    if (transcript === undefined) continue;
    const end = clip.source_in + (clip.duration / fps) * clip.speed;
    for (const word of transcript.words) {
      if (word.start < clip.source_in || word.end > end) continue;
      const placed = clip.start + ((word.start - clip.source_in) / clip.speed) * fps;
      if (Math.abs(placed - at) <= SAID * fps) words.push({ at: placed, text: word.text });
    }
  }
  words.sort((a, b) => a.at - b.at);
  const lines = [
    "",
    "",
    `(Edit, automatically) The playhead is at ${clock(at / fps)} (frame ${at})${section}. Unless my message is about another moment or the whole video, the change is HERE: make it at this spot, check this spot, and answer in a line or two (no whole-edit review).`,
    `Under the playhead: ${under.length === 0 ? "nothing" : ""}`,
    ...under.slice(0, 12).map((clip) => `- ${line(project, clip, fps)}`),
  ];
  if (words.length > 0) lines.push(`Said around it: "${words.slice(0, 60).map((word) => word.text).join(" ")}"`);
  if (near.length > 0) lines.push(`Within ${AROUND} s: ${near.length > 30 ? `(the first 30 of ${near.length})` : ""}`, ...near.slice(0, 30).map((clip) => `- ${line(project, clip, fps)}`));
  return lines.join("\n");
}
