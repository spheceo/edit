import { describe, expect, it } from "vitest";

import { layoutFor } from "./home-layout";
import { asideChoices, backLabel } from "./later-days";

// Home's table at every width Edit's window can be (960 px at the least: the
// table is then about 700 px), Mine and Everyone: a name always keeps its
// room, columns go in their order, and the columns are as many as a row draws.
describe("Home's table at every width", () => {
  const nameOf = (columns: string, width: number) => {
    const tracks = columns.split(" ").slice(1).map((one) => Number.parseFloat(one));
    return width - 24 - tracks.reduce((sum, px) => sum + px, 0) - tracks.length * 16;
  };
  for (const solo of [true, false]) {
    it(`a name keeps at least 260 px from a 960 px window up (${solo ? "Mine" : "Everyone"})`, () => {
      for (let width = 700; width <= 2000; width += 10) {
        const layout = layoutFor(width, solo);
        expect(nameOf(layout.columns, width), `at ${width}`).toBeGreaterThanOrEqual(260);
        // A row draws name, status, updated and its buttons always; category, by and length when shown.
        const cells = 4 + (layout.slim ? 0 : 1) + (solo ? 0 : 1) + (layout.compact ? 0 : 1);
        expect(layout.columns.split(" ").length, `at ${width}`).toBe(cells);
      }
    });
  }
  it("goes without Length first, then Category, then By's names", () => {
    expect(layoutFor(1400, false)).toMatchObject({ compact: false, slim: false, faces: false });
    expect(layoutFor(1040, false)).toMatchObject({ compact: true, slim: false, faces: false });
    expect(layoutFor(900, false)).toMatchObject({ compact: true, slim: true, faces: false });
    expect(layoutFor(780, false)).toMatchObject({ compact: true, slim: true, faces: true });
  });
});

describe("Later's days", () => {
  it("offers tomorrow, Monday unless that's tomorrow, a week, and no date", () => {
    const saturday = new Date(2026, 9, 31, 11, 0);
    expect(asideChoices(saturday).map((one) => one.label)).toEqual(["Tomorrow", "Monday", "In a week", "Until I bring it back"]);
    const sunday = new Date(2026, 10, 1, 11, 0);
    expect(asideChoices(sunday).map((one) => one.label)).toEqual(["Tomorrow", "In a week", "Until I bring it back"]);
    expect(asideChoices(saturday)[1]!.until).toBe(new Date(2026, 10, 2).getTime());
    expect(backLabel(null)).toBe("No date");
    expect(backLabel(new Date(2026, 10, 1).getTime(), saturday)).toBe("Tomorrow");
  });
});
