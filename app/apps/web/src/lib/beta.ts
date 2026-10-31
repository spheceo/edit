// Settings → Beta (the server's beta.ts): what's being tried before everyone
// has it, on or off for this Mac. The last answer is kept on the browser too,
// so Home opens as it was left instead of switching once the server answers.

import { create } from "zustand";

import { request } from "./api";

export interface Beta {
  /** Home as a sidebar and one list at a time, with Later and Done (Home.tsx); off, the Home everyone has (HomeClassic.tsx). */
  home: boolean;
}

const KEPT = "edit.beta";

function kept(): Beta {
  try {
    const saved = JSON.parse(localStorage.getItem(KEPT) ?? "null") as Partial<Beta> | null;
    return { home: saved?.home === true };
  } catch {
    return { home: false };
  }
}

export const useBeta = create<Beta>(() => kept());

/** Switches made here: an answer asked for before the latest one is stale (a slow GET would switch it back). */
let switches = 0;

function take(beta: Beta): void {
  localStorage.setItem(KEPT, JSON.stringify(beta));
  useBeta.setState(beta);
}

/** This Mac's betas, asked again (another tab or window may have switched one). */
export async function loadBeta(): Promise<void> {
  const asked = switches;
  const beta = await request<Beta>("GET", "/api/beta");
  if (asked === switches) take(beta);
}

/** Switches a beta on or off for this Mac. */
export async function setBeta(name: keyof Beta, on: boolean): Promise<void> {
  const before = useBeta.getState();
  const mine = ++switches;
  take({ ...before, [name]: on });
  try {
    const beta = await request<Beta>("PUT", "/api/beta", { [name]: on });
    if (mine === switches) take(beta);
  } catch (error) {
    if (mine === switches) take(before);
    throw error;
  }
}
