// A voice-over project: the script as lines, each spoken by the chosen
// ElevenLabs voice into takes; play them, pick one, regenerate, download.

import { Check, ChevronLeft, Download, Pause, Play, Plus, Send, Sparkles, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { copyText } from "../lib/diagnostics";
import { navigate } from "../lib/route";
import { useEditor } from "../lib/store";
import { MODELS, seconds, takeUrl, voiceApi, type Voice, type VoiceLine, type VoiceProject, type VoiceSettings } from "../lib/voice";
import { AppMenu } from "./AppMenu";
import { Mark } from "./Logo";
import { Button, cx, IconButton, Modal, Select, Spinner, Switch } from "./ui";

let newLines = 0;

/** Grows a textarea to its text. */
function fit(area: HTMLTextAreaElement | null) {
  if (!area) return;
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight}px`;
}

export function VoiceEditor({ id }: { id: string }) {
  const toast = useEditor((state) => state.toast);
  const [project, setProject] = useState<VoiceProject | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [sending, setSending] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const latest = useRef<VoiceProject | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saving = useRef<Promise<void>>(Promise.resolve());
  /** New lines' ids once the server has given them theirs. */
  const renamed = useRef(new Map<string, string>());

  useEffect(() => {
    voiceApi
      .get(id)
      .then(({ project }) => {
        latest.current = project;
        setProject(project);
      })
      .catch((error) => setMissing((error as Error).message));
    voiceApi
      .voices()
      .then(({ voices }) => setVoices(voices))
      .catch((error) => setVoicesError((error as Error).message));
    return () => {
      clearTimeout(saveTimer.current);
      audio.current?.pause();
    };
  }, [id]);

  /** Takes and chosen takes from the server; the words typed here win. */
  const adopt = useCallback((fresh: VoiceProject) => {
    const current = latest.current;
    const merged: VoiceProject = current
      ? {
          ...current,
          lines: current.lines.map((line) => {
            const theirs = fresh.lines.find((candidate) => candidate.id === line.id);
            return theirs ? { ...line, takes: theirs.takes, chosen: theirs.chosen } : line;
          }),
        }
      : fresh;
    latest.current = merged;
    setProject(merged);
  }, []);

  const save = useCallback(() => {
    clearTimeout(saveTimer.current);
    saving.current = saving.current.then(async () => {
      const sent = latest.current;
      if (!sent) return;
      try {
        const { project: saved } = await voiceApi.save(sent);
        // New lines get their ids (by position, as sent).
        const ids = new Map(sent.lines.map((line, index) => [line.id, saved.lines[index]?.id ?? line.id]));
        for (const [from, to] of ids) if (from.startsWith("new-")) renamed.current.set(from, to);
        const current = latest.current;
        if (!current) return;
        const next = { ...current, lines: current.lines.map((line) => (line.id.startsWith("new-") ? { ...line, id: ids.get(line.id) ?? line.id } : line)) };
        latest.current = next;
        setProject(next);
      } catch (error) {
        toast(`Couldn't save: ${(error as Error).message}`, "error");
      }
    });
    return saving.current;
  }, [toast]);

  const change = (recipe: (draft: VoiceProject) => VoiceProject) => {
    if (!latest.current) return;
    const next = recipe(latest.current);
    latest.current = next;
    setProject(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(), 500);
  };

  const setLine = (lineId: string, patch: Partial<VoiceLine>) =>
    change((draft) => ({ ...draft, lines: draft.lines.map((line) => (line.id === lineId ? { ...line, ...patch } : line)) }));

  const setVoice = (patch: Partial<VoiceSettings>) => change((draft) => ({ ...draft, voice: { ...draft.voice, ...patch } }));

  const play = (url: string, key: string) => {
    if (playing === key) {
      audio.current?.pause();
      setPlaying(null);
      return;
    }
    audio.current?.pause();
    const element = new Audio(url);
    audio.current = element;
    element.onended = () => setPlaying((current) => (current === key ? null : current));
    void element.play().catch((error) => toast(`Couldn't play it: ${error}`, "error"));
    setPlaying(key);
  };

  const generate = async (lineId: string) => {
    await save();
    const target = renamed.current.get(lineId) ?? lineId;
    if (target.startsWith("new-") || !latest.current?.lines.some((line) => line.id === target)) return;
    setSpeaking((set) => new Set(set).add(target));
    try {
      const { project: fresh } = await voiceApi.generate(id, target);
      adopt(fresh);
      const line = fresh.lines.find((candidate) => candidate.id === target);
      if (line?.chosen) play(takeUrl(id, target, line.chosen), `${target}/${line.chosen}`);
    } catch (error) {
      toast((error as Error).message, "error");
      throw error;
    } finally {
      setSpeaking((set) => {
        const next = new Set(set);
        next.delete(target);
        return next;
      });
    }
  };

  const generateMissing = async () => {
    const todo = (latest.current?.lines ?? []).filter((line) => line.text.trim() && line.takes.length === 0).map((line) => line.id);
    for (const line of todo) {
      try {
        await generate(line);
      } catch {
        return; // The toast says why; don't spend more on a failing run.
      }
    }
  };

  const deleteTake = async (lineId: string, take: string) => {
    try {
      adopt((await voiceApi.deleteTake(id, lineId, take)).project);
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };

  if (missing) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
        <p>{missing}</p>
        <Button onClick={() => navigate("/")}>All projects</Button>
      </div>
    );
  }
  if (!project) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const spoken = project.lines.filter((line) => line.chosen).length;
  const characters = project.lines.reduce((sum, line) => sum + line.text.trim().length, 0);
  const total = project.lines.reduce((sum, line) => sum + (line.takes.find((take) => take.id === line.chosen)?.duration ?? 0), 0);
  const waiting = project.lines.filter((line) => line.text.trim() && line.takes.length === 0).length;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 px-3">
        <IconButton label="All projects" onClick={() => navigate("/")}>
          <ChevronLeft size={17} />
        </IconButton>
        <Mark size={20} />
        <input
          value={project.name}
          onChange={(event) => change((draft) => ({ ...draft, name: event.target.value }))}
          className="h-7 min-w-0 max-w-[420px] flex-1 rounded-md bg-transparent px-1.5 text-[14px] font-medium outline-none hover:bg-hover focus:bg-hover"
        />
        <span className="rounded-md bg-agent/15 px-1.5 py-0.5 text-[11px] font-medium text-agent">Voice-over</span>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="mr-2 text-[12px] text-muted tabular">
            {spoken}/{project.lines.length} lines · {seconds(total)} · {characters.toLocaleString()} characters
          </span>
          <AppMenu />
          {project.source && (
            <Button
              disabled={!spoken || sending}
              title="Put the chosen takes on that project's cut-ins"
              onClick={() => {
                setSending(true);
                void voiceApi
                  .send(id, project.source!)
                  .then(({ media }) => {
                    toast(`Placed ${media.length} takes on the project's cut-ins`);
                    navigate(`/p/${project.source}`);
                  })
                  .catch((error) => toast((error as Error).message, "error"))
                  .finally(() => setSending(false));
              }}
            >
              {sending ? <Spinner /> : <Send size={14} />} Use in the project
            </Button>
          )}
          <Button disabled={!spoken} onClick={() => play(`/api/voice/${id}/full.mp3?at=${Date.now()}`, "full")}>
            {playing === "full" ? <Pause size={14} /> : <Play size={14} />} Play all
          </Button>
          <a
            href={spoken ? `/api/voice/${id}/full.mp3` : undefined}
            download={`${project.name}.mp3`}
            className={cx("inline-flex h-8 items-center gap-1.5 rounded-lg bg-white px-3 text-[13px] font-medium text-black", !spoken && "pointer-events-none opacity-40")}
          >
            <Download size={14} /> Download
          </a>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
        <main className="min-w-0 flex-1 overflow-y-auto rounded-xl border border-line bg-panel">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <span className="text-[13px] font-medium">Script</span>
            <span className="text-[12px] text-faint">Each line is spoken separately; the lines around it guide its delivery.</span>
            <div className="ml-auto flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setPasting(true)}>
                Paste script…
              </Button>
              <Button size="sm" variant="primary" disabled={!waiting || !project.voice.voice_id || speaking.size > 0} onClick={() => void generateMissing()}>
                <Sparkles size={13} /> Speak {waiting || ""} new
              </Button>
            </div>
          </div>
          {project.lines.map((line, index) => (
            <LineRow
              key={line.id}
              project={project}
              line={line}
              index={index}
              speaking={speaking.has(line.id)}
              playing={playing}
              canSpeak={Boolean(project.voice.voice_id)}
              onText={(text) => setLine(line.id, { text })}
              onChoose={(take) => setLine(line.id, { chosen: take })}
              onPlay={(take) => play(takeUrl(id, line.id, take), `${line.id}/${take}`)}
              onGenerate={() => void generate(line.id).catch(() => {})}
              onDeleteTake={(take) => void deleteTake(line.id, take)}
              onDelete={() => change((draft) => ({ ...draft, lines: draft.lines.filter((candidate) => candidate.id !== line.id) }))}
            />
          ))}
          <button
            className="flex w-full items-center gap-2 px-4 py-3 text-[13px] text-muted hover:bg-hover hover:text-fg"
            onClick={() => change((draft) => ({ ...draft, lines: [...draft.lines, { id: `new-${++newLines}`, text: "", takes: [], chosen: null }] }))}
          >
            <Plus size={14} /> Add a line
          </button>
        </main>

        <VoicePanel settings={project.voice} voices={voices} error={voicesError} playing={playing} onChange={setVoice} onPreview={(voice) => voice.preview_url && play(voice.preview_url, `preview/${voice.voice_id}`)} />
      </div>

      <PasteScript
        open={pasting}
        onClose={() => setPasting(false)}
        onPaste={(lines) =>
          change((draft) => {
            const kept = draft.lines.filter((line) => line.text.trim() || line.takes.length);
            return { ...draft, lines: [...kept, ...lines.map((text) => ({ id: `new-${++newLines}`, text, takes: [], chosen: null }))] };
          })
        }
      />
    </div>
  );
}

function LineRow({
  project,
  line,
  index,
  speaking,
  playing,
  canSpeak,
  onText,
  onChoose,
  onPlay,
  onGenerate,
  onDeleteTake,
  onDelete,
}: {
  project: VoiceProject;
  line: VoiceLine;
  index: number;
  speaking: boolean;
  playing: string | null;
  canSpeak: boolean;
  onText: (text: string) => void;
  onChoose: (take: string) => void;
  onPlay: (take: string) => void;
  onGenerate: () => void;
  onDeleteTake: (take: string) => void;
  onDelete: () => void;
}) {
  const chosen = line.takes.find((take) => take.id === line.chosen);
  // Words changed since the chosen take was spoken: it no longer says them.
  const stale = chosen && chosen.text.trim() !== line.text.trim();
  return (
    <div className="group border-b border-line px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="w-7 shrink-0 pt-1.5 text-right text-[12px] text-faint tabular">{index + 1}</div>
        <div className="min-w-0 flex-1">
          {line.label && <div className="mb-1 text-[11px] font-medium tracking-wide text-agent uppercase">{line.label}</div>}
          <textarea
            ref={fit}
            value={line.text}
            onChange={(event) => {
              onText(event.target.value);
              fit(event.currentTarget);
            }}
            placeholder="What the voice says…"
            rows={1}
            className="w-full resize-none rounded-md bg-transparent px-2 py-1 text-[14px] leading-relaxed outline-none placeholder:text-faint hover:bg-hover focus:bg-hover"
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 px-1">
            {line.takes.map((take, number) => {
              const key = `${line.id}/${take.id}`;
              const isChosen = take.id === line.chosen;
              return (
                <div
                  key={take.id}
                  className={cx(
                    "group/take flex h-7 items-center rounded-md border text-[12px]",
                    isChosen ? "border-white/40 bg-white/10 text-fg" : "border-line text-muted",
                  )}
                  title={`${take.settings.voice_name ?? "voice"} · ${take.settings.model_id} · stability ${take.settings.stability} · speed ${take.settings.speed}`}
                >
                  <button className="flex h-full items-center gap-1.5 pl-2 pr-1.5 hover:text-fg" onClick={() => onPlay(take.id)}>
                    {playing === key ? <Pause size={12} /> : <Play size={12} />}
                    Take {number + 1}
                    <span className="text-faint tabular">{seconds(take.duration)}</span>
                  </button>
                  <button
                    title={isChosen ? "The take in use" : "Use this take"}
                    onClick={() => onChoose(take.id)}
                    className={cx("flex h-full items-center px-1.5", isChosen ? "text-green-400" : "text-faint hover:text-fg")}
                  >
                    <Check size={12} />
                  </button>
                  <button title="Delete this take" onClick={() => onDeleteTake(take.id)} className="hidden h-full items-center pr-1.5 text-faint group-hover/take:flex hover:text-red-300">
                    <X size={12} />
                  </button>
                </div>
              );
            })}
            {stale && <span className="text-[11px] text-amber-300/80">The words changed since this take</span>}
            <Button size="sm" variant={line.takes.length ? "ghost" : "subtle"} disabled={!canSpeak || !line.text.trim() || speaking} onClick={onGenerate}>
              {speaking ? <Spinner /> : <Sparkles size={12} />}
              {speaking ? "Speaking…" : line.takes.length ? "Another take" : "Speak"}
            </Button>
            <span className="ml-auto text-[11px] text-faint tabular">{line.text.trim().length} characters</span>
            {project.lines.length > 1 && (
              <IconButton label="Delete this line" className="opacity-0 group-hover:opacity-100" onClick={onDelete}>
                <Trash2 size={13} />
              </IconButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange, hint }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; hint?: string }) {
  return (
    <label className="block">
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-muted">{label}</span>
        <span className="text-fg tabular">{value.toFixed(2)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="mt-1 w-full accent-white" />
      {hint && <div className="text-[11px] text-faint">{hint}</div>}
    </label>
  );
}

function VoicePanel({
  settings,
  voices,
  error,
  playing,
  onChange,
  onPreview,
}: {
  settings: VoiceSettings;
  voices: Voice[] | null;
  error: string | null;
  playing: string | null;
  onChange: (patch: Partial<VoiceSettings>) => void;
  onPreview: (voice: Voice) => void;
}) {
  const [query, setQuery] = useState("");
  const shown = (voices ?? []).filter((voice) => `${voice.name} ${Object.values(voice.labels).join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <aside className="flex w-[320px] shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <div className="border-b border-line px-4 py-2.5 text-[13px] font-medium">Voice</div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div>
          <div className="mb-1.5 text-[12px] text-muted">
            Speaker:{" "}
            <span className="text-fg">
              {settings.voice_name ?? voices?.find((voice) => voice.voice_id === settings.voice_id)?.name ?? settings.voice_id ?? "choose one"}
            </span>
          </div>
          {error ? (
            <div className="flex flex-col gap-2 rounded-lg border border-red-500/30 bg-red-950/40 p-2.5 text-[12px] text-red-100">
              {error}
              <button className="self-start text-[11px] underline" onClick={() => void copyText(error)}>
                Copy
              </button>
            </div>
          ) : !voices ? (
            <Spinner />
          ) : (
            <>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${voices.length} voices`}
                className="mb-1.5 h-7 w-full rounded-md border border-line bg-black/30 px-2 text-[12px] outline-none placeholder:text-faint"
              />
              <div className="max-h-[220px] overflow-y-auto rounded-md border border-line">
                {shown.map((voice) => (
                  <div
                    key={voice.voice_id}
                    className={cx("flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[12px] hover:bg-hover", voice.voice_id === settings.voice_id && "bg-active")}
                    onClick={() => onChange({ voice_id: voice.voice_id, voice_name: voice.name })}
                  >
                    <button
                      title="Hear a sample"
                      onClick={(event) => {
                        event.stopPropagation();
                        onPreview(voice);
                      }}
                      className="text-muted hover:text-fg"
                    >
                      {playing === `preview/${voice.voice_id}` ? <Pause size={12} /> : <Play size={12} />}
                    </button>
                    <span className="truncate">{voice.name}</span>
                    <span className="ml-auto truncate text-[11px] text-faint">{[voice.labels.gender, voice.labels.accent, voice.labels.age].filter(Boolean).join(" · ")}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          Or a voice ID
          <input
            key={settings.voice_id ?? ""}
            defaultValue={settings.voice_id ?? ""}
            placeholder="e.g. from ElevenLabs' Voice Library"
            onBlur={(event) => {
              const id = event.currentTarget.value.trim();
              if (!id || id === settings.voice_id) return;
              onChange({ voice_id: id, voice_name: voices?.find((voice) => voice.voice_id === id)?.name ?? null });
            }}
            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
            className="h-7 rounded-md border border-line bg-black/30 px-2 font-mono text-[12px] text-fg outline-none placeholder:font-sans placeholder:text-faint"
          />
        </label>
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-muted">Model</span>
          <Select value={settings.model_id} options={MODELS} onChange={(model_id) => onChange({ model_id })} className="h-7 w-auto justify-end px-1.5 hover:bg-hover" />
        </div>
        <Slider label="Stability" value={settings.stability} min={0} max={1} step={0.01} onChange={(stability) => onChange({ stability })} hint="Lower is more expressive, higher more even." />
        <Slider label="Similarity" value={settings.similarity_boost} min={0} max={1} step={0.01} onChange={(similarity_boost) => onChange({ similarity_boost })} />
        <Slider label="Style" value={settings.style} min={0} max={1} step={0.01} onChange={(style) => onChange({ style })} hint="Exaggerates the voice's style; slower to make." />
        <Slider label="Speed" value={settings.speed} min={0.7} max={1.2} step={0.01} onChange={(speed) => onChange({ speed })} />
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-muted">Speaker boost</span>
          <Switch checked={settings.use_speaker_boost} onChange={(use_speaker_boost) => onChange({ use_speaker_boost })} />
        </div>
        <p className="text-[11px] leading-relaxed text-faint">Changes apply to new takes; existing takes keep the voice they were made with (hover a take to see it).</p>
      </div>
    </aside>
  );
}

function PasteScript({ open, onClose, onPaste }: { open: boolean; onClose: () => void; onPaste: (lines: string[]) => void }) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (open) setText("");
  }, [open]);
  const lines = text
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return (
    <Modal open={open} onClose={onClose} width={560}>
      <div className="flex flex-col gap-3 p-5">
        <h2 className="text-[15px] font-semibold">Paste a script</h2>
        <p className="text-[13px] text-muted">Each paragraph (separated by a blank line) becomes a line, added after the lines already here.</p>
        <textarea
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          className="h-[260px] resize-none rounded-lg border border-line bg-black/40 p-2.5 text-[13px] leading-relaxed outline-none"
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!lines.length}
            onClick={() => {
              onPaste(lines);
              onClose();
            }}
          >
            Add {lines.length || ""} line{lines.length === 1 ? "" : "s"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
