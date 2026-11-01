// Which copy of a script wins a pull (writer/cloud.ts decidePull), checked over every case
// the generator can think of: the promises that five fixes in three days were each one of.

import { expect, test } from "bun:test";

import { Arbitrary, Effect, Schema } from "effect";

import { decidePull, type PullSeen } from "../../src/writer/cloud.ts";

const Here = Schema.Struct({ same: Schema.Boolean, changed: Schema.Boolean, built: Schema.Boolean, unfinished: Schema.Boolean });
const Rev = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 9 })));
const Seen = Schema.Struct({
  deleted: Schema.Boolean,
  knownRev: Schema.NullOr(Rev),
  rev: Rev,
  here: Schema.NullOr(Here),
  theirs: Schema.UndefinedOr(Schema.NullOr(Schema.Struct({ built: Schema.Boolean }))),
  copiedRev: Schema.NullOr(Rev),
});

/** Holds for every generated pull; a counterexample, shrunk, says which. */
async function always(name: string, holds: (seen: PullSeen) => boolean): Promise<void> {
  const result = await Effect.runPromise(Arbitrary.checkEffect(Arbitrary.schema(Seen), (seen) => holds(seen as PullSeen), { runs: 2000 }));
  if (result._tag === "Falsified") throw new Error(`${name}: ${JSON.stringify(result.shrunkInput)}`);
  expect(result._tag).not.toBe("Falsified");
}

const conflict = (seen: PullSeen) => !seen.deleted && seen.here !== null && !seen.here.same && seen.here.changed;

test("work changed here is never lost: taking theirs over it keeps a copy, unless it's an unfinished import or a copy for that rev is kept", () =>
  always("lost work", (seen) => {
    const decision = decidePull(seen);
    if (!conflict(seen) || decision.do !== "take") return true;
    return decision.keepCopy || seen.here!.unfinished || seen.copiedRev === seen.rev;
  }));

test("a built script is never replaced by an unbuilt one", () =>
  always("built replaced", (seen) => !(conflict(seen) && seen.here!.built && seen.theirs != null && !seen.theirs.built && decidePull(seen).do === "take")));

test("at most one conflicted copy is kept per revision", () =>
  always("second copy", (seen) => {
    const decision = decidePull(seen);
    return !(decision.do === "take" && decision.keepCopy && seen.copiedRev === seen.rev);
  }));

test("an older or equal revision is never taken, and nothing is fetched for one", () =>
  always("old rev taken", (seen) => {
    if (seen.deleted || seen.knownRev === null || seen.knownRev < seen.rev) return true;
    return decidePull(seen).do === "skip";
  }));

test("a script deleted elsewhere after it changed here is kept as a restored copy", () =>
  always("deleted work", (seen) => {
    if (!seen.deleted) return true;
    const decision = decidePull(seen);
    return decision.do === "delete" && decision.keepCopy === (seen.here !== null && seen.here.changed);
  }));

test("a body missing from the cloud never replaces this Mac's, and with none here it's said", () =>
  always("missing body", (seen) => {
    if (seen.deleted || (seen.knownRev !== null && seen.knownRev >= seen.rev) || seen.theirs !== null) return true;
    return decidePull(seen).do === (seen.here !== null ? "keep-ours" : "fail");
  }));
