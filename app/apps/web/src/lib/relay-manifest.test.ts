// Edit's manifest for accounts.spheceo.com (apps/relay/src/manifest.ts), against the
// rules of accounts' contract v2 (code/accounts/docs/plan.md, "Contract v2").

import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

import relay, { type Env } from "../../../relay/src/index";
import { CAPABILITIES, ICON_SVG, manifest } from "../../../relay/src/manifest";

const ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

describe("Edit's manifest", () => {
  it("keeps the contract's rules", () => {
    const m = manifest();
    expect([m.app, m.version, m.name]).toEqual(["edit", 1, "Edit"]);
    expect(m.capabilities.length).toBeGreaterThan(0);
    expect(m.capabilities.length).toBeLessThanOrEqual(100);
    for (const one of m.capabilities) {
      expect(one.id).toMatch(ID);
      expect(one.id.length).toBeLessThanOrEqual(64);
      expect(one.label.length).toBeLessThanOrEqual(60);
      expect(one.description.length).toBeLessThanOrEqual(200);
    }
    expect(new Set(m.capabilities.map((one) => one.id)).size).toBe(m.capabilities.length);
    const ids = new Set(m.capabilities.map((one) => one.id));
    for (const preset of m.presets) for (const id of preset.capabilities) expect(ids.has(id)).toBe(true);
    expect(m.presets.find((one) => one.id === "full")?.capabilities.sort()).toEqual([...ids].sort());
    expect(m.icon.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(m.icon.length).toBeLessThanOrEqual(16 * 1024);
  });

  it("keeps its ids (they're forever) and the brand's icon", () => {
    expect(Object.values(CAPABILITIES).sort()).toEqual(["edit.bodycam", "edit.commentary", "edit.courtroom", "edit.interrogation", "edit.shorts", "video.subtitles"]);
    expect(manifest().presets.map((one) => [one.id, one.capabilities.length])).toEqual([["subtitles", 1], ["editor", 6], ["full", 6]]);
    expect(ICON_SVG).toBe(fs.readFileSync(new URL("../../../../assets/brand/edit-icon.svg", import.meta.url), "utf8"));
  });

  it("is served publicly at /.well-known/spheceo-app.json, cached up to an hour", async () => {
    const answer = await relay.fetch(new Request("https://relay.test/.well-known/spheceo-app.json"), {} as Env);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("access-control-allow-origin")).toBe("*");
    expect(answer.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await answer.json()).toEqual(manifest());
  });
});
