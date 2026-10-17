import { describe, expect, it } from "vitest";
import { TranscriptionBudget, type Env } from "../../../relay/src/index";

describe("relay atomic spend reservations", () => {
  it("counts concurrent in-flight requests before permitting more spend", async () => {
    const values = new Map<string, number>();
    let chain = Promise.resolve();
    type Storage = ConstructorParameters<typeof TranscriptionBudget>[0]["storage"];
    const storage: Storage = {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: number) => { values.set(key, value); },
      transaction: <T>(callback: (store: Storage) => Promise<T>): Promise<T> => {
        const result = chain.then(() => callback(storage));
        chain = result.then(() => {}); return result;
      },
      setAlarm: async () => {}, deleteAll: async () => { values.clear(); },
    };
    const budget = new TranscriptionBudget({ storage }, { DAILY_BYTES_PER_IP: "100", DAILY_BYTES_TOTAL: "120", MAX_UPLOAD_BYTES: "100" } as Env);
    const reserve = (client: string, size: number) => budget.fetch(new Request("https://budget/reserve", { method: "POST", body: JSON.stringify({ client: client.repeat(64), size }) }));
    const responses = await Promise.all([reserve("a", 70), reserve("a", 70), reserve("b", 70)]);
    expect(responses.map(response => response.status)).toEqual([200, 429, 429]);
    expect(values.get("all")).toBe(70);
    expect((await reserve("b", 50)).status).toBe(200);
    expect(values.get("all")).toBe(120);
    await budget.alarm(); expect(values.size).toBe(0);
  });
});
