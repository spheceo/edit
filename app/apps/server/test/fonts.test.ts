import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";

import * as fonts from "../src/fonts.ts";
import { fixtureHome, type Fixture } from "./helpers/home.ts";

const real = { ...fonts.net };
let fixture: Fixture | null = null;
afterEach(() => {
  Object.assign(fonts.net, real);
  fixture?.cleanup();
  fixture = null;
});

/** Google Fonts as a plain request sees it: a stylesheet of TTF files, 400 for a family or weight it hasn't. */
function google(families: Record<string, number[]>) {
  const asked: string[] = [];
  fonts.net.fetch = async (url: string) => {
    asked.push(url);
    if (url.startsWith("https://fonts.gstatic.com/")) return new Response(new Uint8Array([0, 1, 0, 0, 7]));
    const query = new URL(url).searchParams.get("family")!;
    const [name, spec] = query.split(":");
    const has = families[name!];
    if (has === undefined) return new Response("", { status: 400 });
    const wanted = spec === undefined ? [has[0]!] : spec.slice("wght@".length).split(";").map(Number);
    if (wanted.some((weight) => !has.includes(weight))) return new Response("", { status: 400 });
    const slug = name!.toLowerCase().replace(/ /g, "");
    return new Response(wanted.map((weight) => `@font-face {\n  font-family: '${name}';\n  font-style: normal;\n  font-weight: ${weight};\n  src: url(https://fonts.gstatic.com/s/${slug}/v1/w${weight}.ttf) format('truetype');\n}`).join("\n"));
  };
  return asked;
}

test("a Google Fonts family comes into the project's fonts, for its effects by name; a weight it hasn't falls back to its own", async () => {
  // Sphe, Nov 12: "have the agent research, pull fonts… and be able to save the font to our v2 cloud".
  fixture = fixtureHome("fonts");
  const id = fixture.store.create("f", { width: 1920, height: 1080, fps: 30 }).project.id;
  google({ Caveat: [400, 700], "Reenie Beanie": [400] });
  const caveat = await fonts.fetchGoogle(fixture.store, id, "Caveat", [400, 700]);
  expect(caveat).toMatchObject({ slug: "caveat", family: "Caveat", faces: [{ weight: 400, file: "Caveat-400.ttf" }, { weight: 700, file: "Caveat-700.ttf" }] });
  expect(fs.existsSync(`${caveat.dir}/Caveat-700.ttf`)).toBe(true);
  const reenie = await fonts.fetchGoogle(fixture.store, id, "Reenie Beanie", [700]);
  expect(reenie.faces.map((face) => face.weight)).toEqual([400]);
  await expect(fonts.fetchGoogle(fixture.store, id, "No Such Hand")).rejects.toThrow('Google Fonts has no family "No Such Hand"');
  await expect(fonts.fetchGoogle(fixture.store, id, "<script>")).rejects.toThrow("isn't a Google Fonts family name");

  const mine = fonts.fontsFor(fixture.store, id);
  expect(mine.map((font) => font.slug).sort()).toEqual(["caveat", "reenie-beanie"]);
  expect(fonts.facesOf(mine)).toContain('@font-face { font-family: "Caveat"; font-weight: 700; font-style: normal; src: url(edit-fonts/caveat/Caveat-700.ttf); }');
  expect(fonts.fileOf(fixture.store, id, "caveat", "Caveat-700.ttf")).toBe(`${caveat.dir}/Caveat-700.ttf`);
  expect(fonts.fileOf(fixture.store, id, "caveat", "../../secret")).toBeNull();
  // A render's key counts only the fonts its page names.
  expect(fonts.usedBy(mine, 'ctx.font = "80px Caveat"')).toContain("Caveat:");
  expect(fonts.usedBy(mine, 'ctx.font = "80px Geist"')).toBe("");
});
