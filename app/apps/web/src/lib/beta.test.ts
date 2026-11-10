// Settings → Beta (beta.ts): a switch shows at once, a slow answer asked for
// before it never switches it back, and a refused switch goes back.

import { beforeEach, expect, test, vi } from "vitest";

const answers: { method: string; body: unknown; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
const request = vi.fn((method: string, _url: string, body?: unknown) => new Promise((resolve, reject) => answers.push({ method, body, resolve, reject })));
vi.mock("./api", () => ({ request }));

const saved = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) });

const { loadBeta, setBeta, useBeta } = await import("./beta");

beforeEach(() => {
  answers.length = 0;
  useBeta.setState({ v2: false });
});

test("a GET asked for before a switch doesn't switch it back", async () => {
  const loading = loadBeta();
  const switching = setBeta("v2", true);
  expect(useBeta.getState().v2).toBe(true);
  expect(JSON.parse(saved.get("edit.beta")!)).toEqual({ v2: true });
  expect(answers[1]).toMatchObject({ method: "PUT", body: { v2: true } });
  answers[0]!.resolve({ v2: false });
  await loading;
  expect(useBeta.getState().v2).toBe(true);
  answers[1]!.resolve({ v2: true });
  await switching;
  expect(useBeta.getState().v2).toBe(true);
  // Asked for after: it's the server's word.
  const again = loadBeta();
  answers[2]!.resolve({ v2: false });
  await again;
  expect(useBeta.getState().v2).toBe(false);
});

test("a refused switch goes back, unless switched again since", async () => {
  const refused = setBeta("v2", true);
  answers[0]!.reject(new Error("offline"));
  await expect(refused).rejects.toThrow("offline");
  expect(useBeta.getState().v2).toBe(false);
  const first = setBeta("v2", true);
  const second = setBeta("v2", false);
  answers[1]!.reject(new Error("slow"));
  await expect(first).rejects.toThrow("slow");
  expect(useBeta.getState().v2).toBe(false);
  answers[2]!.resolve({ v2: false });
  await second;
  expect(useBeta.getState().v2).toBe(false);
});
