// effect/service.ts: what can go wrong with an outside call, and the one rule for what's asked again.

import { afterAll, beforeAll, expect, test } from "bun:test";

import { Effect } from "effect";

import { runtime } from "../src/effect/runtime.ts";
import { AnswerInvalid, decodeJson, kindOf, kindOfStatus, ok, request, ServiceRefused, ServiceTimedOut, ServiceUnreachable, temporaryRetries } from "../src/effect/service.ts";
import { Schema } from "effect";

let calls = 0;
let script: (n: number) => Response | Promise<Response> = () => new Response("ok");
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: () => script(++calls) });
});
afterAll(() => void server.stop(true));

const url = () => `http://127.0.0.1:${server.port}/x`;
const asked = (answers: ((n: number) => Response | Promise<Response>)) => {
  calls = 0;
  script = answers;
};
const once = (timeoutMs = 2000) => request("the fake", url(), { method: "GET" }, timeoutMs).pipe(Effect.flatMap((answer) => ok("the fake", answer)));

test("statuses: busy and down are temporary, a sign-in or quota is a person's, the rest permanent", () => {
  for (const status of [408, 429, 500, 502, 503, 504, 524]) expect([status, kindOfStatus(status)]).toEqual([status, "temporary"]);
  for (const status of [401, 402, 403]) expect([status, kindOfStatus(status)]).toEqual([status, "later"]);
  for (const status of [400, 404, 409, 413, 422]) expect([status, kindOfStatus(status)]).toEqual([status, "permanent"]);
  expect(kindOf(new ServiceUnreachable({ service: "R2", message: "" }))).toBe("temporary");
  expect(kindOf(new ServiceTimedOut({ service: "R2", afterMs: 1, message: "" }))).toBe("temporary");
  expect(kindOf(new AnswerInvalid({ service: "R2", message: "" }))).toBe("permanent");
  // Nobody knows a plain Error won't change: not looped on, but Try again stays.
  expect(kindOf(new Error("odd"))).toBe("later");
});

test("a 503 and a 429 are asked again (its Retry-After waited); a 413 and a 400 are not", async () => {
  asked((n) => (n === 1 ? new Response("down", { status: 503 }) : n === 2 ? new Response("busy", { status: 429, headers: { "retry-after": "0" } }) : new Response("ok")));
  const answer = await runtime.runPromise(once().pipe(Effect.retry(temporaryRetries("the fake", { base: 1 }))));
  expect(answer.text()).toBe("ok");
  expect(calls).toBe(3);

  for (const status of [413, 400]) {
    asked(() => new Response("no", { status }));
    const failed = await runtime.runPromise(once().pipe(Effect.retry(temporaryRetries("the fake", { base: 1 })), Effect.flip));
    expect(failed).toBeInstanceOf(ServiceRefused);
    expect((failed as ServiceRefused).status).toBe(status);
    expect(calls).toBe(1);
  }
});

test("a service that's slow is abandoned at its time and asked again; one always slow ends as timed out", async () => {
  asked(async (n) => (n === 1 ? (await Bun.sleep(800), new Response("late")) : new Response("ok")));
  expect((await runtime.runPromise(once(200).pipe(Effect.retry(temporaryRetries("the fake", { base: 1 }))))).text()).toBe("ok");
  expect(calls).toBe(2);

  asked(async () => (await Bun.sleep(800), new Response("late")));
  const failed = await runtime.runPromise(once(100).pipe(Effect.retry(temporaryRetries("the fake", { base: 1, times: 2 })), Effect.flip));
  expect(failed).toBeInstanceOf(ServiceTimedOut);
  expect(calls).toBe(3);
});

test("an answer is checked against what the service sends", async () => {
  const Thing = Schema.Struct({ id: Schema.String, size: Schema.Number });
  expect(await runtime.runPromise(decodeJson("the fake", Thing, '{"id":"a","size":3,"extra":true}'))).toEqual({ id: "a", size: 3 });
  const failed = await runtime.runPromise(decodeJson("the fake", Thing, '{"id":"a","size":"3"}').pipe(Effect.flip));
  expect(failed).toBeInstanceOf(AnswerInvalid);
  expect(failed.message).toContain("size");
});
