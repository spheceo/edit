import { describe, expect, it } from "vitest";

import { creditCopies } from "./copies";

describe("creditCopies", () => {
  it("makes a conflicted copy its original's, script or edit, and leaves the rest", () => {
    const items = [
      { title: "CORRUPT Jail Guard Caught", section: "edits", mine: false },
      { title: "CORRUPT Jail Guard Caught (conflicted copy)", section: "scripts", mine: true, fresh: true },
      { title: "CORRUPT Jail Guard Caught (conflicted copy) (conflicted copy)", section: "scripts", mine: true, fresh: true },
      { title: "Officer Tases an Inmate", section: "scripts", mine: true },
      { title: "Officer Tases an Inmate (conflicted copy)", section: "scripts", mine: false },
      // Its original gone: as the cloud says.
      { title: "Mass Killer Smiles (conflicted copy)", section: "scripts", mine: true, fresh: true },
    ];
    creditCopies(items);
    expect(items.map((item) => [item.mine, "fresh" in item ? item.fresh : undefined])).toEqual([
      [false, undefined],
      [false, false],
      [false, false],
      [true, undefined],
      [true, undefined],
      [true, true],
    ]);
  });
});
