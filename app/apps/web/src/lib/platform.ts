// The words that name the machine Edit runs on, and its shortcut keys: a
// Mac's ("this Mac", Finder, ⌘) on a Mac, a Linux desktop's elsewhere ("this
// computer", Files, Ctrl+). From the platform this page runs on, which is the
// machine running Edit in its window (another device's browser is the rare case).

const MAC = typeof navigator === "undefined" || /Mac|iPhone|iPad/.test(navigator.platform);

export const THIS_MACHINE = MAC ? "this Mac" : "this computer";
export const THE_MACHINE = MAC ? "the Mac" : "the computer";
export const ANOTHER_MACHINE = MAC ? "another Mac" : "another computer";
export const THEIR_MACHINE = MAC ? "their Mac" : "their computer";
export const FILE_MANAGER = MAC ? "Finder" : "Files";
/** A shortcut's modifier as labels show it: "⌘Z" on a Mac, "Ctrl+Z" elsewhere. */
export const MOD = MAC ? "⌘" : "Ctrl+";
/** With Shift: "⇧⌘Z", "Ctrl+Shift+Z". */
export const SHIFT_MOD = MAC ? "⇧⌘" : "Ctrl+Shift+";
/** The modifier as a key of its own (the shortcuts sheet): "⌘", "Ctrl". */
export const MOD_KEY = MAC ? "⌘" : "Ctrl";
