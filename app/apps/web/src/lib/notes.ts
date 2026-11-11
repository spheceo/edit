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
  /** Bodycam HQ: the comment tool is up (the cursor pins a comment where it's clicked, while paused). */
  commenting: boolean;
  /** Bodycam HQ: the comment open on the picture (its card showing), or null. */
  opened: string | null;
  /** The playhead is being dragged along the progress bar: no comment is left meanwhile. */
  scrubbing: boolean;
}

export const useNotes = create<NotesState>(() => ({ project: null, notes: [], draft: null, commenting: false, opened: null, scrubbing: false }));

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
  useNotes.setState({ project, notes: [], draft: null, commenting: false, opened: null });
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

/** The note button: opens a note, or closes the one open (Sphe, Nov 3: no reaching for Escape). In Bodycam HQ, the comment tool. */
export function toggleNote(): void {
  if (useEditor.getState().project?.hq === true) setCommenting(!useNotes.getState().commenting);
  else if (useNotes.getState().draft === null) startNote();
  else cancelNote();
}

// ---------------------------------------------------------------- Bodycam HQ's comments
//
// The team's notes as the thumbnail page's comments, on the player (Sphe,
// Nov 11): pinned where they click on the picture (a spot, or an area
// dragged) at the paused frame, numbered, on the progress bar, and taken by
// the agent with the next message as asks it settles.

/** The comment tool up or down; up, playback pauses so the moment holds (comments are left on a paused frame). */
export function setCommenting(on: boolean): void {
  if (on) preview.pause();
  useNotes.setState({ commenting: on });
}

/** Each note's number, by when it was left (as the server numbers them for the agent: edit_notes.ts `numbered`). */
export function numbers(notes: AppNote[]): Map<string, number> {
  return new Map([...notes].sort((a, b) => a.at - b.at).map((note, index) => [note.id, index + 1]));
}

/** The open ones: waiting for the agent, or with it. */
export function openComments(notes: AppNote[]): AppNote[] {
  return notes.filter((note) => note.status === "queued" || note.status === "sent");
}

/** A share of the frame under which a box is a spot pinned, not an area drawn (the server's `SPOT`). */
export const SPOT = 0.005;

/**
 * A comment left at `frame`, at once (as the thumbnail page's: the page shows
 * it before the server answers); `box` the area dragged, or a spot. The
 * error's words if it couldn't be left.
 */
export async function addComment(frame: number, box: NoteBox, text: string): Promise<string | null> {
  const { project } = useNotes.getState();
  if (project === null || text.trim() === "") return null;
  const local: AppNote = { id: `local-${Math.random().toString(36).slice(2, 10)}`, text: text.trim(), frame, endFrame: null, now: frame, nowEnd: null, box, source: null, status: "queued", fix: null, reason: null, at: Date.now(), by: null };
  useNotes.setState((state) => ({ notes: [...state.notes, local] }));
  try {
    const note = await api.addNote(project, { text: text.trim(), frame, box });
    useNotes.setState((state) => ({ notes: [...state.notes.filter((one) => one.id !== local.id && one.id !== note.id), note] }));
    return null;
  } catch (error) {
    useNotes.setState((state) => ({ notes: state.notes.filter((one) => one.id !== local.id) }));
    const said = error instanceof Error ? error.message : String(error);
    useEditor.getState().toast(`The comment wasn't left: ${said}`, "error");
    return said;
  }
}

/** A comment's words changed, shown at once. */
export async function editComment(id: string, text: string): Promise<void> {
  const project = useNotes.getState().project;
  const was = useNotes.getState().notes.find((note) => note.id === id);
  if (project === null || was === undefined || text.trim() === "") return;
  useNotes.setState((state) => ({ notes: state.notes.map((note) => (note.id === id ? { ...note, text: text.trim() } : note)) }));
  try {
    await api.editNote(project, id, text.trim());
  } catch (error) {
    useNotes.setState((state) => ({ notes: state.notes.map((note) => (note.id === id ? was : note)) }));
    useEditor.getState().toast(`The comment wasn't changed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

/** A comment opened from the progress bar: the playhead goes to its moment and its card shows. */
export function openComment(id: string): void {
  const note = useNotes.getState().notes.find((one) => one.id === id);
  if (note === undefined) return;
  preview.pause();
  preview.seek(note.now);
  useNotes.setState({ opened: id });
}

export function setScrubbing(on: boolean): void {
  if (useNotes.getState().scrubbing !== on) useNotes.setState({ scrubbing: on });
}

export function setOpened(id: string | null): void {
  useNotes.setState({ opened: id });
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
