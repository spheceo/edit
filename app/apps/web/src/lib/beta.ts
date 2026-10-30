import { create } from "zustand";

// Features being tried out, each a switch in Settings → Beta, remembered on
// this browser. The user, Oct 30: the board "a beta thing ... on by default,
// but you can turn it off if you don't want it. If we're not a huge fan of
// it, we'll probably delete it".

const BOARD = "edit.beta.board";

interface Beta {
  /** Home's board: every edit in four columns, Script, Edit, Review and Done (on unless turned off). */
  board: boolean;
  setBoard: (on: boolean) => void;
}

export const useBeta = create<Beta>((set) => ({
  board: localStorage.getItem(BOARD) !== "0",
  setBoard: (on) => {
    localStorage.setItem(BOARD, on ? "1" : "0");
    set({ board: on });
  },
}));
