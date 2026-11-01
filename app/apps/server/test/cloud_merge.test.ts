// What a failed project sync call leads to (cloud_projects.ts), checked over generated cases.

import { expect, test } from "bun:test";

import { Arbitrary, Effect, Schema } from "effect";

import { afterLost, decideFailure, isOwnSave } from "../src/cloud_projects.ts";

async function always<A>(name: string, schema: Schema.Codec<A>, holds: (value: A) => boolean): Promise<void> {
  const result = await Effect.runPromise(Arbitrary.checkEffect(Arbitrary.schema(schema), holds, { runs: 2000 }));
  if (result._tag === "Falsified") throw new Error(`${name}: ${JSON.stringify(result.shrunkInput)}`);
  expect(result._tag).not.toBe("Falsified");
}

const Failure = Schema.Struct({
  kind: Schema.Literals(["unreachable", "relay", "function"]),
  code: Schema.NullOr(Schema.Literals(["locked", "conflict", "invalid", "missing_body"])),
  heldBy: Schema.NullOr(Schema.Literals(["kenobi", "mathiass-macbook-pro"])),
  message: Schema.String,
  me: Schema.Literals(["kenobi", "mathiass-macbook-pro"]),
});

test("offline is only ever offline; this machine's own lock is never someone else's; another's always is", () =>
  always("failure", Failure, (seen) => {
    const decision = decideFailure(seen, seen.me);
    if (seen.kind === "unreachable") return decision.do === "offline";
    if (decision.do === "lost") return decision.holder !== seen.me && seen.code === "locked";
    if (seen.kind === "function" && seen.code === "locked" && seen.heldBy !== null && seen.heldBy !== seen.me) return false;
    return true;
  }));

const Rev = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 })));
const Saved = Schema.Struct({
  attempt: Schema.UndefinedOr(Schema.Struct({ base: Rev, hash: Schema.Literals(["a", "b"]) })),
  cloud: Schema.NullOr(Schema.Struct({ rev: Rev, bodyHash: Schema.NullOr(Schema.Literals(["a", "b"])) })),
});

test("a conflict is taken as this machine's own save only when the cloud's next rev is exactly what it sent", () =>
  always("own save", Saved, ({ attempt, cloud }) => {
    const own = isOwnSave(attempt, cloud);
    const exactly = attempt !== undefined && cloud !== null && cloud.rev === attempt.base + 1 && cloud.bodyHash === attempt.hash;
    return own === exactly;
  }));

test("losing the lock with changes here always keeps them as a copy, and pulls what the other machine has", () =>
  always("lost changes", Schema.Struct({ hadChanges: Schema.Boolean, newer: Schema.Boolean }), ({ hadChanges, newer }) => {
    const plan = afterLost(hadChanges, newer);
    return plan.keepCopy === hadChanges && plan.pull === (hadChanges || newer);
  }));
