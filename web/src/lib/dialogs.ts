// App-wide dialogs (shortcuts, settings), openable from menus and keys.

import { create } from "zustand";

export type Dialog = "shortcuts" | "settings";

export const useDialogs = create<{ open: Dialog | null }>(() => ({ open: null }));

export const openDialog = (open: Dialog) => useDialogs.setState({ open });
export const closeDialog = () => useDialogs.setState({ open: null });

export const SHORTCUTS: { group: string; keys: [string, string][] }[] = [
  {
    group: "Playback",
    keys: [
      ["Space", "Play / pause"],
      ["← →", "Step a frame (⇧ = 1s)"],
      ["↑ ↓", "Previous / next edit"],
    ],
  },
  {
    group: "Editing",
    keys: [
      ["S", "Split at playhead"],
      ["V / C", "Select / razor tool"],
      ["T", "Add a title"],
      ["N", "Toggle snapping"],
      ["M", "Mark the source at the playhead (selected clips)"],
      ["⌫ / ⇧⌫", "Delete / ripple delete"],
      ["⌘D", "Duplicate"],
      ["⌘Z / ⇧⌘Z", "Undo / redo (agent edits too)"],
      ["Drag", "Box-select clips or keyframes"],
      ["Right-click", "More actions"],
    ],
  },
  {
    group: "Timeline",
    keys: [
      ["G", "Graph editor (keyframe curves)"],
      ["F9", "Easy ease selected keyframes"],
      ["⌘ scroll", "Zoom (or drag the bar's ends)"],
      ["\\", "Zoom to fit"],
    ],
  },
  {
    group: "App",
    keys: [
      ["?", "Keyboard shortcuts"],
      ["⌘ ,", "Settings"],
    ],
  },
];
