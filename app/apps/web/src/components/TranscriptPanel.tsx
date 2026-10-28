import { AudioLines, ChevronRight, RotateCcw, Search } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api";
import { isSoundEffect } from "../lib/edit";
import { playhead, preview } from "../lib/playback";
import { useEditor } from "../lib/store";
import type { Project, Transcript } from "../lib/types";
import { toggleMenu } from "./ContextMenu";
import { displayNames } from "./MediaPanel";
import { ProblemView } from "./ProblemView";
import { Button, cx, Spinner } from "./ui";
import { rate } from "../lib/types";

/** Transcripts by `${project}/${media}`, loaded once each. */
const loaded = new Map<string, Transcript>();

interface TimelineWord {
  /** Timeline frame where the word starts. */
  frame: number;
  text: string;
  speaker?: string;
  /** The speaker’s colour in the editors' code, once voices are named. */
  color?: string;
  /** Scribe’s voice number and the media it’s from, to change who it is. */
  voice?: string;
  media: string;
}

type Word = Transcript["words"][number];
/** Each transcript’s words in order of their start, for binary search. */
const ordered = new WeakMap<Transcript, Word[]>();
function wordsOf(transcript: Transcript) {
  let words = ordered.get(transcript);
  if (!words) {
    const sorted = transcript.words.every((word, index) => !index || transcript.words[index - 1].start <= word.start);
    words = sorted ? transcript.words : [...transcript.words].sort((a, b) => a.start - b.start);
    ordered.set(transcript, words);
  }
  return words;
}

/** Words heard on the timeline: audio clips on unmuted tracks, mapped through trims and speed. */
function timelineWords(clips: Project["clips"], tracks: Project["tracks"], fps: number, transcripts: Map<string, Transcript>): TimelineWord[] {
  const muted = new Set(tracks.filter((track) => track.muted).map((track) => track.id));
  const words: TimelineWord[] = [];
  for (const clip of clips) {
    if (clip.type !== "audio" || muted.has(clip.track)) continue;
    const transcript = transcripts.get(clip.media);
    if (!transcript) continue;
    const to = clip.source_in + (clip.duration / fps) * clip.speed;
    const all = wordsOf(transcript);
    // The clip’s first word, by binary search: only its own words are visited.
    let low = 0;
    let high = all.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (all[mid].start < clip.source_in) low = mid + 1;
      else high = mid;
    }
    for (let index = low; index < all.length && all[index].start < to; index++) {
      const word = all[index];
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

/** Repack’s roles, each with its own colour (the first of its shades). */
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

/** "Officer" once the voices are named, else "Speaker 1" for Scribe’s speaker_0. */
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

/** White words, the one being said (`active`) highlighted yellow; still to come is dimmed. */
function markWord(span: HTMLElement, index: number, active: number) {
  const on = index === active;
  span.classList.toggle("bg-[#ffff00]", on);
  span.classList.toggle("text-black", on);
  span.classList.toggle("text-white", !on);
  span.classList.toggle("hover:bg-hover", !on);
  span.classList.toggle("opacity-55", index > active);
}

/** A search's words, lower case, punctuation off. */
function searchTerms(query: string) {
  return query.toLowerCase().split(/\s+/).map(normal).filter(Boolean);
}

const normal = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, "");

/** Whether `text` holds the search: every word of it, in order, for a phrase; any one for a single word (`word`). */
function matches(text: string, terms: string[], word = false) {
  const said = normal(text);
  if (word) return terms.some((term) => said.includes(term));
  return said.includes(terms.join(" "));
}

const clock = (frame: number, fps: number) => {
  const seconds = Math.floor(frame / fps);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export function TranscriptPanel() {
  const project = useEditor((state) => state.project)!;
  const statuses = useEditor((state) => state.media);
  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState("");
  // The clips still to transcribe, folded away until asked for.
  const [open, setOpen] = useState(false);
  const names = useMemo(() => displayNames(project), [project.media]);
  const list = useRef<HTMLDivElement>(null);
  const fps = rate(project.settings);
  const { clips, tracks } = project;

  // Media heard on the timeline, in order of first use.
  const heard = useMemo(() => {
    const ids: string[] = [];
    for (const clip of [...clips].sort((a, b) => a.start - b.start)) {
      if (clip.type === "audio" && !ids.includes(clip.media)) ids.push(clip.media);
    }
    // Sound effects (the shutter on the cuts) have nothing said in them.
    return ids.map((id) => project.media.find((media) => media.id === id)!).filter((media) => media && !isSoundEffect(media));
  }, [clips, project.media]);

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

  const transcripts = useMemo(() => {
    const transcripts = new Map<string, Transcript>();
    for (const media of heard) {
      const transcript = loaded.get(`${project.id}/${media.id}`);
      if (transcript) transcripts.set(media.id, transcript);
    }
    return transcripts;
    // `version` and `named` say a transcript was (re)loaded into `loaded`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heard, project.id, version, named]);
  const words = useMemo(() => timelineWords(clips, tracks, fps, transcripts), [clips, tracks, fps, transcripts]);
  const grouped = useMemo(() => phrases(words, fps), [words, fps]);

  // Highlight the word under the playhead on the words themselves (classes, not
  // state), so nothing re-renders as it moves: only the words it passed change.
  const highlight = useRef({ words, active: -1, update: () => {} });
  useLayoutEffect(() => {
    const spans: HTMLElement[] = [];
    for (const span of list.current?.querySelectorAll<HTMLElement>("[data-word]") ?? []) spans[Number(span.dataset.word)] = span;
    const update = () => {
      const all = highlight.current.words;
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
      const current = highlight.current.active;
      if (found === current) return;
      highlight.current.active = found;
      // The words between the old and new place change: the one said, and those now said or still to come.
      for (let index = Math.max(0, Math.min(found, current)); index <= Math.max(found, current); index++) {
        if (spans[index]) markWord(spans[index], index, found);
      }
      // Keep the spoken word in view while playing.
      if (playhead.playing && found >= 0) spans[found]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    // New words (or new spans for them): mark them all for where the playhead is.
    highlight.current.words = words;
    highlight.current.active = -1;
    spans.forEach((span, index) => markWord(span, index, -1));
    highlight.current.update = update;
    update();
  }, [grouped]);
  useEffect(() => {
    const unsubscribe = playhead.subscribe(() => highlight.current.update());
    return () => void unsubscribe();
  }, []);

  const start = (mediaId: string) =>
    api
      .transcribe(project.id, mediaId)
      .then(({ status }) => useEditor.setState({ media: { ...useEditor.getState().media, [mediaId]: status } }))
      .catch((error) => useEditor.getState().toastError(error, "start the transcript"));

  // Audio files in the bin (voice-overs) can be transcribed before they’re on the timeline.
  const unplaced = project.media.filter((media) => media.kind === "audio" && !isSoundEffect(media) && !heard.includes(media));
  if (!heard.length && !unplaced.length) {
    return (
      <div className="flex min-h-[220px] flex-1 flex-col items-center justify-center px-6 text-center">
        <span className="flex size-10 items-center justify-center rounded-xl bg-raised text-muted ring-1 ring-line">
          <AudioLines size={17} />
        </span>
        <div className="mt-3 text-[13px] font-medium">No sound on the timeline</div>
        <p className="mt-1 max-w-[220px] text-[12px] leading-relaxed text-muted">Put footage with sound on the timeline to transcribe what’s said.</p>
      </div>
    );
  }

  const pending = [...heard, ...unplaced].filter((media) => statuses[media.id]?.transcript !== "ready");
  const waiting = pending.filter((media) => (statuses[media.id]?.transcript ?? "pending") === "pending");
  const working = pending.filter((media) => statuses[media.id]?.transcript === "working").length;
  const error = pending.map((media) => statuses[media.id]?.transcript_error).find(Boolean);
  const terms = searchTerms(query);
  const shown = terms.length ? grouped.filter((phrase) => matches(phrase.words.map(({ word }) => word.text).join(" "), terms)) : grouped;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 p-2">
        <label className="flex h-8 items-center gap-2 rounded-lg border border-line bg-black px-2.5 text-[12px] focus-within:border-muted">
          <Search size={13} className="shrink-0 text-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") setQuery("");
            }}
            placeholder="Search what’s said"
            aria-label="Search the transcript"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint"
          />
          {terms.length > 0 && (
            <span className="shrink-0 font-mono text-[11px] text-faint tabular">
              {shown.length} {shown.length === 1 ? "match" : "matches"}
            </span>
          )}
        </label>
      </div>
      {pending.length > 0 && (
        <div className="mx-2 mb-2 shrink-0 rounded-xl bg-black p-1 ring-1 ring-line">
          <div className="flex items-center justify-between gap-2 pl-1">
            <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 items-center gap-1 py-1.5 text-[12px] text-muted hover:text-fg">
              <ChevronRight size={13} className={cx("shrink-0 transition-transform duration-150", open && "rotate-90")} />
              <span className="truncate">
                {pending.length} {pending.length === 1 ? "clip" : "clips"} not transcribed{working ? ` · ${working} going` : ""}
              </span>
            </button>
            {waiting.length > 1 && (
              <Button size="sm" variant="ghost" onClick={() => waiting.forEach((media) => void start(media.id))}>
                Transcribe all
              </Button>
            )}
          </div>
          {open &&
            pending.map((media) => {
              const stage = statuses[media.id]?.transcript ?? "pending";
              return (
                <div key={media.id} className="flex h-8 items-center gap-2 rounded-lg px-2 hover:bg-hover">
                  <AudioLines size={13} className={cx("shrink-0", stage === "failed" ? "text-danger" : "text-faint")} />
                  <span className="min-w-0 flex-1 truncate text-[12px]" title={media.name}>
                    {names.get(media.id) ?? media.name}
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
            <ProblemView error={error} doing="transcribe it" className="px-2 pt-1 pb-1.5" />
          )}
        </div>
      )}
      <div ref={list} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pt-1 pb-4">
        {shown.map((phrase) => {
          const number = grouped.indexOf(phrase);
          const newVoice = phrase.speaker && (terms.length > 0 || phrase.speaker !== grouped[number - 1]?.speaker);
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
                                .catch((error) => useEditor.getState().toastError(error, "name the speaker")),
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
                      // As if nothing’s said yet; markWord sets the highlight.
                      className={cx(
                        "cursor-pointer rounded-[4px] px-[1px] text-white opacity-55 transition-[color,background,opacity] duration-100 hover:bg-hover",
                        terms.length > 0 && matches(word.text, terms, true) && "underline decoration-[#ffff00] decoration-2 underline-offset-[3px]",
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
        {terms.length > 0 && !shown.length && <p className="px-1 text-[12px] text-muted">Nobody says “{query.trim()}” on the timeline.</p>}
        {!terms.length && !grouped.length && !pending.length && <p className="text-[12px] text-muted">No speech was found in the clips on the timeline.</p>}
      </div>
    </div>
  );
}
