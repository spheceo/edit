// Context menus for the timeline, tracks, media bin and viewer.

import {
  ArrowLeftToLine,
  AudioWaveform,
  Captions,
  Copy,
  Eye,
  EyeOff,
  Flag,
  Gauge,
  ImageDown,
  Link,
  Lock,
  LockOpen,
  Maximize2,
  Moon,
  MoveHorizontal,
  Plus,
  RectangleHorizontal,
  Scissors,
  Sparkles,
  Sun,
  Trash2,
  Type,
  Unlink,
  Vibrate,
  Volume2,
  VolumeX,
  Waves,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";

import type { MenuItem } from "../components/ContextMenu";
import { api } from "./api";
import {
  addElement,
  addMarker,
  addTrack,
  clearMarkers,
  clipEnd,
  deleteClips,
  duplicateClips,
  isLinked,
  isSoundEffect,
  linkClips,
  placeMedia,
  projectDuration,
  removeMedia,
  removeTrack,
  rippleDelete,
  setFades,
  setSpeed,
  splitAt,
  unlinkClips,
  withLinked,
  type Element,
} from "./edit";
import { playhead, preview } from "./playback";
import { useEditor } from "./store";
import { rate } from "./types";

const state = () => useEditor.getState();

const ELEMENT_ITEMS: { id: Element; label: string; icon: ReactNode }[] = [
  { id: "title", label: "Glow title", icon: <Sparkles size={14} /> },
  { id: "caption", label: "Caption", icon: <Type size={14} /> },
  { id: "subtitle", label: "Subtitle", icon: <Captions size={14} /> },
  { id: "cutin", label: "Cut-in", icon: <RectangleHorizontal size={14} /> },
  { id: "adjustment", label: "Adjustment layer", icon: <Sun size={14} /> },
  { id: "shake", label: "Shake", icon: <Vibrate size={14} /> },
  { id: "flash", label: "Flash", icon: <Zap size={14} /> },
  { id: "black", label: "Dip to black", icon: <Moon size={14} /> },
  { id: "waveform", label: "Glowing waveform", icon: <AudioWaveform size={14} /> },
];

function addAt(element: Element, frame: number, track?: string) {
  let id = "";
  state().edit((draft) => {
    id = addElement(draft, element, frame, track);
  });
  state().select([id]);
}

/** Right-click on a clip: acts on the selection, selecting the clip first if needed. */
export function clipMenu(clipId: string): MenuItem[] {
  const editor = state();
  const project = editor.project!;
  if (!editor.selection.includes(clipId)) editor.select([...withLinked(project, [clipId])]);
  const ids = state().selection;
  const clips = project.clips.filter((clip) => ids.includes(clip.id));
  const frame = Math.round(playhead.frame);
  const underPlayhead = clips.some((clip) => frame > clip.start && frame < clipEnd(clip));
  const timed = clips.some((clip) => clip.type === "video" || clip.type === "audio");
  const linked = isLinked(project, ids);
  const canLink = !linked && clips.some((clip) => clip.type === "video") && clips.some((clip) => clip.type === "audio");
  const fps = rate(project.settings);
  return [
    {
      label: "Split at playhead",
      icon: <Scissors size={14} />,
      shortcut: "S",
      disabled: !underPlayhead,
      onSelect: () => editor.edit((draft) => splitAt(draft, frame, ids)),
    },
    {
      label: clips.length > 1 ? "Duplicate clips" : "Duplicate",
      icon: <Copy size={14} />,
      shortcut: "⌘D",
      onSelect: () => {
        let created: string[] = [];
        editor.edit((draft) => {
          created = duplicateClips(draft, ids);
        });
        editor.select(created);
      },
    },
    {
      label: "Mark the source here",
      icon: <Flag size={14} />,
      shortcut: "M",
      disabled: !underPlayhead || !timed,
      onSelect: () => editor.edit((draft) => addMarker(draft, ids, frame)),
    },
    {
      label: "Clear markers",
      disabled: !clips.some((clip) => (clip.type === "video" || clip.type === "audio") && project.media.find((media) => media.id === clip.media)?.markers?.length),
      onSelect: () => editor.edit((draft) => clearMarkers(draft, ids)),
    },
    { separator: true },
    {
      label: "Speed",
      icon: <Gauge size={14} />,
      disabled: !timed,
      submenu: [0.25, 0.5, 1, 1.5, 2, 4].map((speed) => ({
        label: `${Math.round(speed * 100)}%${speed < 1 ? " · slow" : speed > 1 ? " · fast" : ""}`,
        onSelect: () => editor.edit((draft) => setSpeed(draft, ids, speed)),
      })),
    },
    {
      label: "Fade in and out",
      icon: <Waves size={14} />,
      submenu: [
        {
          label: "None",
          onSelect: () => editor.edit((draft) => setFades(draft, ids, 0)),
        },
        ...[0.25, 0.5, 1].map((seconds) => ({
          label: `${seconds}s`,
          onSelect: () => editor.edit((draft) => setFades(draft, ids, Math.round(seconds * fps))),
        })),
      ],
    },
    linked
      ? {
          label: "Unlink",
          icon: <Unlink size={14} />,
          onSelect: () => editor.edit((draft) => unlinkClips(draft, ids)),
        }
      : {
          label: "Link picture and sound",
          icon: <Link size={14} />,
          disabled: !canLink,
          onSelect: () => editor.edit((draft) => linkClips(draft, ids)),
        },
    { separator: true },
    {
      swatches: true,
      value: clips.length === 1 ? clips[0].color : undefined,
      onSelect: (color) =>
        editor.edit((draft) => {
          for (const clip of draft.clips) if (ids.includes(clip.id)) clip.color = color;
        }),
    },
    { separator: true },
    {
      label: "Ripple delete",
      icon: <ArrowLeftToLine size={14} />,
      shortcut: "⇧⌫",
      onSelect: () => {
        editor.edit((draft) => rippleDelete(draft, ids));
        editor.select([]);
      },
    },
    {
      label: "Delete",
      icon: <Trash2 size={14} />,
      shortcut: "⌫",
      danger: true,
      onSelect: () => {
        editor.edit((draft) => deleteClips(draft, ids));
        editor.select([]);
      },
    },
  ];
}

/** Right-click on empty timeline: add things exactly there. */
export function timelineMenu(frame: number, track: string | undefined, onFit: () => void): MenuItem[] {
  const editor = state();
  return [
    ...ELEMENT_ITEMS.map((item) => ({
      label: `Add ${item.label.toLowerCase()} here`,
      icon: item.icon,
      onSelect: () => addAt(item.id, frame, track),
    })),
    { separator: true },
    {
      label: "Move playhead here",
      icon: <MoveHorizontal size={14} />,
      onSelect: () => preview.seek(frame),
    },
    {
      label: "Zoom to fit",
      icon: <Maximize2 size={14} />,
      shortcut: "\\",
      onSelect: onFit,
    },
    { separator: true },
    {
      label: "Add video track",
      icon: <Plus size={14} />,
      onSelect: () => editor.edit((draft) => void addTrack(draft, "video")),
    },
    {
      label: "Add audio track",
      icon: <Plus size={14} />,
      onSelect: () => editor.edit((draft) => void addTrack(draft, "audio")),
    },
  ];
}

export function trackMenu(trackId: string): MenuItem[] {
  const editor = state();
  const project = editor.project!;
  const track = project.tracks.find((candidate) => candidate.id === trackId);
  if (!track) return [];
  const toggle = (key: "hidden" | "muted" | "locked") =>
    editor.edit((draft) => {
      const live = draft.tracks.find((candidate) => candidate.id === trackId);
      if (live) live[key] = !live[key];
    });
  const empty = !project.clips.some((clip) => clip.track === trackId);
  const lastOfKind = project.tracks.filter((other) => other.kind === track.kind).length <= 1;
  return [
    track.kind === "video"
      ? {
          label: track.hidden ? "Show track" : "Hide track",
          icon: track.hidden ? <Eye size={14} /> : <EyeOff size={14} />,
          onSelect: () => toggle("hidden"),
        }
      : {
          label: track.muted ? "Unmute track" : "Mute track",
          icon: track.muted ? <Volume2 size={14} /> : <VolumeX size={14} />,
          onSelect: () => toggle("muted"),
        },
    {
      label: track.locked ? "Unlock track" : "Lock track",
      icon: track.locked ? <LockOpen size={14} /> : <Lock size={14} />,
      onSelect: () => toggle("locked"),
    },
    {
      label: "Select all on track",
      onSelect: () => editor.select(project.clips.filter((clip) => clip.track === trackId).map((clip) => clip.id)),
    },
    { separator: true },
    {
      label: "Add video track",
      icon: <Plus size={14} />,
      onSelect: () => editor.edit((draft) => void addTrack(draft, "video")),
    },
    {
      label: "Add audio track",
      icon: <Plus size={14} />,
      onSelect: () => editor.edit((draft) => void addTrack(draft, "audio")),
    },
    {
      label: empty ? "Delete track" : "Delete track (not empty)",
      icon: <Trash2 size={14} />,
      danger: true,
      disabled: !empty || lastOfKind,
      onSelect: () => editor.edit((draft) => void removeTrack(draft, trackId)),
    },
  ];
}

export function mediaMenu(mediaId: string): MenuItem[] {
  const editor = state();
  const project = editor.project!;
  const uses = project.clips.filter((clip) => (clip.type === "video" || clip.type === "audio") && clip.media === mediaId).length;
  const place = (frame: number) => {
    let ids: string[] = [];
    editor.edit((draft) => {
      ids = placeMedia(draft, mediaId, frame);
    });
    editor.select(ids);
  };
  const media = project.media.find((candidate) => candidate.id === mediaId);
  const transcript = editor.media[mediaId]?.transcript ?? "pending";
  return [
    {
      label: "Add at playhead",
      icon: <Plus size={14} />,
      onSelect: () => place(Math.round(playhead.frame)),
    },
    {
      label: "Add to end of timeline",
      icon: <ArrowLeftToLine size={14} className="rotate-180" />,
      onSelect: () => place(projectDuration(project)),
    },
    { separator: true },
    {
      label: transcript === "ready" ? "Transcribed" : transcript === "working" ? "Transcribing…" : "Transcribe",
      icon: <Captions size={14} />,
      disabled: !media?.has_audio || isSoundEffect(media) || transcript === "ready" || transcript === "working",
      onSelect: () =>
        void api
          .transcribe(project.id, mediaId)
          .then(({ status }) =>
            useEditor.setState({
              media: { ...useEditor.getState().media, [mediaId]: status },
            }),
          )
          .catch((error) => editor.toastError(error, "start the transcript")),
    },
    { separator: true },
    {
      label: uses ? `Remove from project (and ${uses} clip${uses > 1 ? "s" : ""})` : "Remove from project",
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: () => editor.edit((draft) => removeMedia(draft, mediaId)),
    },
  ];
}

export function viewerMenu(): MenuItem[] {
  const project = state().project!;
  const frame = Math.floor(playhead.frame);
  return [
    {
      label: playhead.playing ? "Pause" : "Play",
      shortcut: "Space",
      onSelect: () => preview.toggle(),
    },
    { separator: true },
    ...ELEMENT_ITEMS.slice(0, 3).map((item) => ({
      label: `Add ${item.label.toLowerCase()} at playhead`,
      icon: item.icon,
      onSelect: () => addAt(item.id, frame),
    })),
    { separator: true },
    {
      label: "Save frame as PNG",
      icon: <ImageDown size={14} />,
      onSelect: () => {
        const link = document.createElement("a");
        link.href = `/api/projects/${project.id}/frame/${frame}.png`;
        link.download = `${project.name} – frame ${frame}.png`;
        link.click();
      },
    },
  ];
}
