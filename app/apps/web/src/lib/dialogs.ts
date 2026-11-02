// App-wide dialogs (settings), openable from menus and keys.

import { create } from "zustand";

export type Dialog = "settings" | "logs";

export const useDialogs = create<{ open: Dialog | null }>(() => ({ open: null }));

export const openDialog = (open: Dialog) => useDialogs.setState({ open });
export const closeDialog = () => useDialogs.setState({ open: null });
