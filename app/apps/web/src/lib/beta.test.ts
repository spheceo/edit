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
  useBeta.setState({ home: false });
});

test("a GET asked for before a switch doesn't switch it back", async () => {
  const loading = loadBeta();
  const switching = setBeta("home", true);
  expect(useBeta.getState().home).toBe(true);
  expect(JSON.parse(saved.get("edit.beta")!)).toEqual({ home: true });
  answers[0]!.resolve({ home: false });
  await loading;
  expect(useBeta.getState().home).toBe(true);
  answers[1]!.resolve({ home: true });
  await switching;
  expect(useBeta.getState().home).toBe(true);
  // Asked for after: it's the server's word.
  const again = loadBeta();
  answers[2]!.resolve({ home: false });
  await again;
  expect(useBeta.getState().home).toBe(false);
});

test("a refused switch goes back, unless switched again since", async () => {
  const refused = setBeta("home", true);
  answers[0]!.reject(new Error("offline"));
  await expect(refused).rejects.toThrow("offline");
  expect(useBeta.getState().home).toBe(false);
  const first = setBeta("home", true);
  const second = setBeta("home", false);
  answers[1]!.reject(new Error("slow"));
  await expect(first).rejects.toThrow("slow");
  expect(useBeta.getState().home).toBe(false);
  answers[2]!.resolve({ home: false });
  await second;
  expect(useBeta.getState().home).toBe(false);
});
