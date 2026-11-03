// The team's own notes on the open edit (the server's edit_notes.ts): left on
// the player at the playhead (Q, or the note button), queued in a row above
// the chat's composer, sent to the agent when someone tells it to implement
// the feedback, then done or left. Here: the open project's list, kept fresh
// by the server's "notes" event and a slow look (another Mac's notes), and
// the note being written on the player.

import { create } from "zustand";

import { api, type AppNote, type NoteBox } from "./api";
import { playhead, preview } from "./playback";
import { useEditor } from "./store";

/** How often the list is looked at anyway (notes left on another Mac). */
const REFRESH_MS = 30_000;

interface Draft {
  /** The frame it's at (the playhead when it began). */
  frame: number;
  box: NoteBox | null;
  /** Drawing the box on the picture. */
  drawing: boolean;
}

interface NotesState {
  project: string | null;
  notes: AppNote[];
  /** The note being written on the player, or null. */
  draft: Draft | null;
}

export const useNotes = create<NotesState>(() => ({ project: null, notes: [], draft: null }));

let timer: ReturnType<typeof setInterval> | null = null;
if (typeof window !== "undefined") window.addEventListener("edit:notes", () => void loadNotes());
let asked = 0;

/** Loads the open project's notes (again). */
export async function loadNotes(project: string | null = useNotes.getState().project): Promise<void> {
  if (project === null) return;
  const mine = ++asked;
  try {
    const notes = await api.notes(project);
    if (mine === asked && useNotes.getState().project === project) useNotes.setState({ notes });
  } catch {
    // Signed out or offline: the row stays as it was.
  }
}

/** Follows `project`'s notes (null: none open). */
export function followNotes(project: string | null): void {
  if (useNotes.getState().project === project) return;
  useNotes.setState({ project, notes: [], draft: null });
  if (timer !== null) clearInterval(timer);
  timer = null;
  if (project === null) return;
  void loadNotes(project);
  timer = setInterval(() => void loadNotes(), REFRESH_MS);
}

/** A note begins at the playhead: playback pauses so the moment holds. */
export function startNote(): void {
  if (useEditor.getState().project === null) return;
  preview.pause();
  useNotes.setState({ draft: { frame: Math.floor(playhead.frame), box: null, drawing: false } });
}

export function cancelNote(): void {
  useNotes.setState({ draft: null });
}

/** The note button: opens a note, or closes the one open (Sphe, Nov 3: no reaching for Escape). */
export function toggleNote(): void {
  if (useNotes.getState().draft === null) startNote();
  else cancelNote();
}

export function setDraftBox(box: NoteBox | null, drawing = false): void {
  const draft = useNotes.getState().draft;
  if (draft !== null) useNotes.setState({ draft: { ...draft, box, drawing } });
}

/** Queues the note being written; the error's words if it couldn't. */
export async function queueNote(text: string): Promise<string | null> {
  const { draft, project } = useNotes.getState();
  if (draft === null || project === null || text.trim() === "") return null;
  try {
    const note = await api.addNote(project, { text: text.trim(), frame: draft.frame, box: draft.box });
    useNotes.setState((state) => ({ draft: null, notes: [...state.notes.filter((one) => one.id !== note.id), note] }));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function removeNote(id: string): Promise<void> {
  const project = useNotes.getState().project;
  if (project === null) return;
  useNotes.setState((state) => ({ notes: state.notes.filter((note) => note.id !== id) }));
  try {
    await api.removeNote(project, id);
  } catch (error) {
    useEditor.getState().toast(`The note wasn't removed: ${error instanceof Error ? error.message : String(error)}`, "error");
    void loadNotes(project);
  }
}

export { boxFrom, pictureRect, queued } from "./note-shapes";
