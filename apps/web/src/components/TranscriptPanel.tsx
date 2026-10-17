import { AudioLines, CircleAlert, RotateCcw } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api";
import { isSoundEffect, trackOf } from "../lib/edit";
import { playhead, preview } from "../lib/playback";
import { useEditor } from "../lib/store";
import type { Project, Transcript } from "../lib/types";
import { toggleMenu } from "./ContextMenu";
import { Button, cx, Spinner } from "./ui";

/** Transcripts by `${project}/${media}`, loaded once each. */
const loaded = new Map<string, Transcript>();

interface TimelineWord {
  /** Timeline frame where the word starts. */
  frame: number;
  text: string;
  speaker?: string;
  /** The speaker's colour in the editors' code, once voices are named. */
  color?: string;
  /** Scribe's voice number and the media it's from, to change who it is. */
  voice?: string;
  media: string;
}

/** Words heard on the timeline: audio clips on unmuted tracks, mapped through trims and speed. */
function timelineWords(project: Project, transcripts: Map<string, Transcript>): TimelineWord[] {
  const fps = project.settings.fps;
  const words: TimelineWord[] = [];
  for (const clip of project.clips) {
    if (clip.type !== "audio" || trackOf(project, clip.track)?.muted) continue;
    const transcript = transcripts.get(clip.media);
    if (!transcript) continue;
    const to = clip.source_in + (clip.duration / fps) * clip.speed;
    for (const word of transcript.words) {
      if (word.start < clip.source_in || word.start >= to) continue;
      words.push({
        frame: clip.start + ((word.start - clip.source_in) / clip.speed) * fps,
        text: word.text,
        speaker: speakerName(transcript, word.speaker),
        color: word.speaker ? transcript.colors?.[word.speaker] : undefined,
        voice: word.speaker,
        media: clip.media,
      });
    }
  }
  return words.sort((a, b) => a.frame - b.frame);
}

/** Repack's roles, each with its own colour (the first of its shades). */
const ROLES: [string, string, string][] = [
  ["officer", "Officer", "#00e5c7"],
  ["leader", "Sergeant / Detective", "#0090e5"],
  ["suspect", "Suspect", "#ffff00"],
  ["victim", "Victim", "#e57e00"],
  ["witness", "Witness", "#e57e00"],
  ["medic", "Paramedic / DCF", "#f33bff"],
  ["bystander", "Bystander", "#ffffff"],
  ["narrator", "Narrator", "#ffffff"],
  ["dispatch", "Dispatch / radio", "#b9c7d4"],
  // Set by the watcher on a second conversation behind the one followed: hidden like the narrator.
  ["background", "Background talk", "#ffffff"],
  ["other", "Other", "#3ddc84"],
];

/** "Officer" once the voices are named, else "Speaker 1" for Scribe's speaker_0. */
function speakerName(transcript: Transcript, voice?: string) {
  if (!voice) return undefined;
  const named = transcript.speakers?.[voice];
  if (named) return named;
  const number = /^speaker_(\d+)$/.exec(voice)?.[1];
  return number === undefined ? voice : `Speaker ${Number(number) + 1}`;
}

/** Phrases break on a pause or a change of voice. */
function phrases(words: TimelineWord[], fps: number) {
  const out: { frame: number; speaker?: string; color?: string; voice?: string; media: string; words: { word: TimelineWord; index: number }[] }[] = [];
  words.forEach((word, index) => {
    const last = out.at(-1);
    const previous = words[index - 1];
    if (!last || !previous || (word.frame - previous.frame) / fps > 1.2 || word.speaker !== previous.speaker) {
      out.push({ frame: word.frame, speaker: word.speaker, color: word.color, voice: word.voice, media: word.media, words: [{ word, index }] });
    } else last.words.push({ word, index });
  });
  return out;
}

const clock = (frame: number, fps: number) => {
  const seconds = Math.floor(frame / fps);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export function TranscriptPanel() {
  const project = useEditor((state) => state.project)!;
  const statuses = useEditor((state) => state.media);
  const toast = useEditor((state) => state.toast);
  const [, setVersion] = useState(0);
  const [active, setActive] = useState(-1);
  const list = useRef<HTMLDivElement>(null);
  const fps = project.settings.fps;

  // Media heard on the timeline, in order of first use.
  const heard = useMemo(() => {
    const ids: string[] = [];
    for (const clip of [...project.clips].sort((a, b) => a.start - b.start)) {
      if (clip.type === "audio" && !ids.includes(clip.media)) ids.push(clip.media);
    }
    // Sound effects (the shutter on the cuts) have nothing said in them.
    return ids.map((id) => project.media.find((media) => media.id === id)!).filter((media) => media && !isSoundEffect(media));
  }, [project]);

  // Voices get named after a transcript arrives: reload it when that lands.
  const [named, setNamed] = useState(0);
  useEffect(() => {
    const reload = (event: Event) => {
      const path = (event as CustomEvent<string>).detail;
      for (const media of project.media) if (media.path === path) loaded.delete(`${project.id}/${media.id}`);
      setNamed((count) => count + 1);
    };
    window.addEventListener("edit:transcript", reload);
    return () => window.removeEventListener("edit:transcript", reload);
  }, [project]);

  // Load every finished transcript once.
  useEffect(() => {
    for (const media of heard) {
      const key = `${project.id}/${media.id}`;
      if (statuses[media.id]?.transcript !== "ready" || loaded.has(key)) continue;
      void api.transcript(project.id, media.id).then((transcript) => {
        loaded.set(key, transcript);
        setVersion((version) => version + 1);
      });
    }
  }, [heard, statuses, project.id, named]);

  const transcripts = new Map<string, Transcript>();
  for (const media of heard) {
    const transcript = loaded.get(`${project.id}/${media.id}`);
    if (transcript) transcripts.set(media.id, transcript);
  }
  const words = timelineWords(project, transcripts);
  const grouped = phrases(words, fps);

  // Highlight the word under the playhead without re-rendering per frame.
  const wordsRef = useRef(words);
  wordsRef.current = words;
  useEffect(() => {
    let current = -1;
    const update = () => {
      const all = wordsRef.current;
      let low = 0;
      let high = all.length - 1;
      let found = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        // Half a frame of slack: a word starting mid-frame is "on" that frame.
        if (all[mid].frame <= playhead.frame + 0.5) {
          found = mid;
          low = mid + 1;
        } else high = mid - 1;
      }
      if (found !== current) {
        current = found;
        setActive(found);
      }
    };
    update();
    const unsubscribe = playhead.subscribe(update);
    return () => void unsubscribe();
  }, []);

  // Keep the spoken word in view while playing.
  useEffect(() => {
    if (!playhead.playing || active < 0) return;
    list.current?.querySelector(`[data-word="${active}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  const start = (mediaId: string) =>
    api
      .transcribe(project.id, mediaId)
      .then(({ status }) => useEditor.setState({ media: { ...useEditor.getState().media, [mediaId]: status } }))
      .catch((error) => toast((error as Error).message, "error"));

  // Audio files in the bin (voice-overs) can be transcribed before they're on the timeline.
  const unplaced = project.media.filter((media) => media.kind === "audio" && !isSoundEffect(media) && !heard.includes(media));
  if (!heard.length && !unplaced.length) {
    return (
      <div className="flex min-h-[220px] flex-1 flex-col items-center justify-center px-6 text-center">
        <span className="flex size-10 items-center justify-center rounded-xl bg-raised text-muted ring-1 ring-line">
          <AudioLines size={17} />
        </span>
        <div className="mt-3 text-[13px] font-medium">No sound on the timeline</div>
        <p className="mt-1 max-w-[220px] text-[12px] leading-relaxed text-muted">Put footage with sound on the timeline to transcribe what's said.</p>
      </div>
    );
  }

  const pending = [...heard, ...unplaced].filter((media) => statuses[media.id]?.transcript !== "ready");
  const waiting = pending.filter((media) => (statuses[media.id]?.transcript ?? "pending") === "pending");
  const error = pending.map((media) => statuses[media.id]?.transcript_error).find(Boolean);
  return (
    <div className="flex flex-col gap-4">
      {pending.length > 0 && (
        <div className="rounded-xl bg-black p-1 ring-1 ring-line">
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-[12px] text-muted">
              {pending.length} {pending.length === 1 ? "clip" : "clips"} not transcribed
            </span>
            {waiting.length > 1 && (
              <Button size="sm" variant="primary" onClick={() => waiting.forEach((media) => void start(media.id))}>
                Transcribe all
              </Button>
            )}
          </div>
          {pending.map((media) => {
            const stage = statuses[media.id]?.transcript ?? "pending";
            return (
              <div key={media.id} className="flex h-9 items-center gap-2 rounded-lg px-2 hover:bg-hover">
                <AudioLines size={13} className={cx("shrink-0", stage === "failed" ? "text-red-400" : "text-faint")} />
                <span className="min-w-0 flex-1 truncate text-[12px]" title={media.name}>
                  {media.name}
                </span>
                {stage === "working" ? (
                  <span className="flex items-center gap-1.5 text-[11px] text-muted">
                    <Spinner /> Transcribing
                  </span>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => void start(media.id)}>
                    {stage === "failed" ? <RotateCcw size={12} /> : null}
                    {stage === "failed" ? "Retry" : "Transcribe"}
                  </Button>
                )}
              </div>
            );
          })}
          {error && (
            <p className="flex items-start gap-1.5 px-2 pt-1 pb-1.5 text-[11px] leading-relaxed text-red-300/90">
              <CircleAlert size={11} className="mt-0.5 shrink-0" />
              {error}
            </p>
          )}
        </div>
      )}
      <div ref={list} className="flex flex-col gap-4 px-1 pb-4">
        {grouped.map((phrase, number) => {
          const newVoice = phrase.speaker && phrase.speaker !== grouped[number - 1]?.speaker;
          return (
            <div key={phrase.words[0].index} className="group">
              <div className="mb-0.5 flex items-center gap-2">
                <button
                  onClick={() => preview.seek(Math.ceil(phrase.frame - 0.5))}
                  className="font-mono text-[10px] text-faint tabular transition-colors hover:text-fg"
                >
                  {clock(phrase.frame, fps)}
                </button>
                {newVoice && (
                  <button
                    title="Who is this? (decides their colour)"
                    onClick={(event) => {
                      const { voice, media } = phrase;
                      const role = voice ? loaded.get(`${project.id}/${media}`)?.roles?.[voice] : undefined;
                      if (!voice) return;
                      toggleMenu(
                        event.currentTarget,
                        [
                          { heading: "Role" },
                          ...ROLES.map(([value, label, color]) => ({
                            label,
                            checked: value === role,
                            icon: <span className="size-2 rounded-full" style={{ background: color }} />,
                            onSelect: () =>
                              void api
                                .setSpeaker(project.id, media, voice, value)
                                .then((transcript) => {
                                  loaded.set(`${project.id}/${media}`, transcript);
                                  setNamed((count) => count + 1);
                                })
                                .catch((error) => toast((error as Error).message, "error")),
                          })),
                        ],
                        { width: 200 },
                      );
                    }}
                    className="rounded px-0.5 text-[10px] font-semibold tracking-wide uppercase transition-opacity hover:opacity-75"
                    style={{ color: phrase.color ?? "var(--color-muted)" }}
                  >
                    {phrase.speaker}
                  </button>
                )}
              </div>
              <p className="text-[13px] leading-[1.7]">
                {phrase.words.map(({ word, index }) => (
                  <Fragment key={index}>
                    <span
                      data-word={index}
                      onClick={() => {
                        preview.pause();
                        preview.seek(Math.ceil(word.frame - 0.5));
                      }}
                      // White words, the one being said highlighted yellow; still to come is dimmed.
                      className={cx(
                        "cursor-pointer rounded-[4px] px-[1px] transition-[color,background,opacity] duration-100",
                        index === active ? "bg-[#ffff00] text-black" : "text-white hover:bg-hover",
                        index > active && "opacity-55",
                      )}
                    >
                      {word.text}
                    </span>{" "}
                  </Fragment>
                ))}
              </p>
            </div>
          );
        })}
        {!grouped.length && !pending.length && <p className="text-[12px] text-muted">No speech was found in the clips on the timeline.</p>}
      </div>
    </div>
  );
}
