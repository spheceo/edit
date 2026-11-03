import { describe, expect, it } from "vitest";

import { quietInput } from "./quietInputs";

describe("quiet inputs", () => {
  it("tells a field no autocorrect, capitalising or autocomplete", () => {
    const set: Record<string, string> = {};
    quietInput({ setAttribute: (name, value) => (set[name] = value) });
    expect(set).toEqual({ autocorrect: "off", autocapitalize: "off", autocomplete: "off" });
  });
});
