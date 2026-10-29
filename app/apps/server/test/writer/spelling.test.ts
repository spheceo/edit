import { expect, test } from "bun:test";

import { acceptable, candidates, keyterms, replaceWords } from "../../src/writer/spelling.ts";

test("finds names and replaces whole words only", () => {
  const text = "[27:33] >> And then this guy named Solomon Ari, a YouTuber.\n[27:34] >> Yeah, Solomon Ari.\n[27:40] he met Adin Ross in Miami and Solomon Aristotle laughed";
  const found = candidates([text]);
  expect(found.some(([name, count]) => name === "Solomon Ari" && count === 2)).toBe(true);
  expect(found.some(([name]) => name === "Adin Ross")).toBe(true);
  const [fixed, count] = replaceWords(text, "Solomon Ari", "Solluminati");
  expect(count).toBe(2);
  expect(acceptable("Solomon Ari", "Solluminati") && acceptable("Aiden", "Adin") && acceptable("Aiden Ross", "Adin Ross")).toBe(true);
  expect(acceptable("Ross", "Adin Ross") || acceptable("Ally I'm", "Ally") || acceptable("N3ON", "N3on") || acceptable("Neil", "N3on")).toBe(false);
  expect(acceptable("Sneo", "Sneako") && acceptable("Yay", "Ye") && acceptable("Vitali", "Vitaly")).toBe(true);
  expect(fixed).toContain("named Solluminati, a YouTuber");
  expect(fixed).toContain("Solomon Aristotle");
  expect(keyterms([{ name: "Solluminati", who: "", heardAs: [{ form: "Solomon Ari", write: "Solluminati" }] }, { name: "x", who: "", heardAs: [] }])).toEqual(["Solluminati"]);
});
