import { expect, test } from "vitest";
import { initials } from "../avatar";

test("initials from the name, else the email", () => {
  expect(initials({ sub: "1", name: "Siphesihle Mbuyisa", email: "s@x" })).toBe("SM");
  expect(initials({ sub: "1", name: "Cher", email: "c@x" })).toBe("C");
  expect(initials({ sub: "1", name: "  ", email: "dana@x" })).toBe("D");
});
