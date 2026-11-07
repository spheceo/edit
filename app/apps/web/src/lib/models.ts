// The person's pick in the chats' model menu (`@edit/types/models`): the
// revisions' model and every chat's thinking level, one for every chat on this
// computer, kept by the server (`/api/models`). The last answer is remembered
// on the browser so the composer shows it from the first paint.

import { create } from "zustand";

import { modelFor, readChoice, type ClaudeModel, type ModelChoice } from "@edit/types/models";

import { request } from "./api";
import { readSetting, writeSetting } from "./storage";

const KEY = "edit.models";

function remembered(): ModelChoice {
  try {
    return readChoice(JSON.parse(readSetting(KEY) ?? "null"));
  } catch {
    return readChoice(null);
  }
}

export const useModelChoice = create<ModelChoice>(() => remembered());

function keep(choice: ModelChoice) {
  writeSetting(KEY, JSON.stringify(choice));
  useModelChoice.setState(choice, true);
}

let loading: Promise<void> | null = null;

/** Asks the server for the pick once per page. */
export function loadModelChoice(): Promise<void> {
  loading ??= request<unknown>("GET", "/api/models").then(
    (given) => keep(readChoice(given)),
    () => {
      loading = null;
    },
  );
  return loading;
}

/** Saves a change to the pick (shown at once, put back if the server refuses it). */
export async function pickModel(change: Partial<ModelChoice>): Promise<void> {
  const before = useModelChoice.getState();
  keep({ ...before, ...change });
  try {
    keep(readChoice(await request<unknown>("PUT", "/api/models", change)));
  } catch {
    keep(before);
  }
}

/** Who answers a chat next: Opus while it's being built, the pick once it's built. */
export function useModelFor(built: boolean): ClaudeModel {
  return modelFor(built, useModelChoice());
}
