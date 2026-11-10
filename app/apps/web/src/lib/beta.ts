// Settings → Beta (the server's beta.ts): what's being tried before everyone
// has it, on or off for this computer. The last answer is kept on the browser
// too, so what a beta adds is there at once instead of once the server answers.

import { create } from "zustand";

import { request } from "./api";

export interface Beta {
  /** Edit V2: Bodycam HQ in New project, its graphics written as code by the agent (Home.tsx). */
  v2: boolean;
}

const KEPT = "edit.beta";

function kept(): Beta {
  try {
    const saved = JSON.parse(localStorage.getItem(KEPT) ?? "null") as Partial<Beta> | null;
    return { v2: saved?.v2 === true };
  } catch {
    return { v2: false };
  }
}

export const useBeta = create<Beta>(() => kept());

/** Switches made here: an answer asked for before the latest one is stale (a slow GET would switch it back). */
let switches = 0;

function take(beta: Beta): void {
  try {
    localStorage.setItem(KEPT, JSON.stringify(beta));
  } catch {
    // Kept for this tab only, then.
  }
  useBeta.setState(beta);
}

/** This computer's betas, asked again (another tab or window may have switched one). */
export async function loadBeta(): Promise<void> {
  const asked = switches;
  const beta = await request<Beta>("GET", "/api/beta");
  if (asked === switches) take(beta);
}

/** Switches a beta on or off for this computer. */
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
