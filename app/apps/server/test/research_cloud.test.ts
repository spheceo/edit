import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import * as research from "../src/research.ts";
import * as researchCloud from "../src/research_cloud.ts";
import { fixtureHome } from "./helpers/home.ts";
import { MockServer } from "./mocks/server.ts";

let mock: MockServer;
let restore: () => void;

beforeAll(() => {
  mock = MockServer.start();
  restore = mock.useEnv({ EDIT_RELAY_TOKEN: "cloud-token" });
});

afterAll(() => {
  restore();
  mock.stop();
});

test("research done on one Mac reaches the project opened on another: its lists at once, an image when it's shown", async () => {
  const one = fixtureHome("research-one");
  const two = fixtureHome("research-two");
  try {
    const folder = research.dir(one.app.store.home, "p1");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(join(folder, "0123456789abcdef.jpg"), "picture");
    fs.writeFileSync(join(folder, "index.json"), JSON.stringify([{ id: "i1", file: join(folder, "0123456789abcdef.jpg"), width: 10, height: 10, title: "t", page: "p", image: "u", query: "q", status: "new" }]));
    fs.writeFileSync(join(folder, "articles.json"), "[]");
    expect(await researchCloud.push(one.app, "p1")).toBe(3);
    // Nothing new: nothing sent again.
    expect(await researchCloud.push(one.app, "p1")).toBe(0);
    expect(mock.objects.has("edit/research/images/0123456789abcdef.jpg")).toBe(true);

    expect(await researchCloud.pull(two.app, "p1")).toBe(true);
    const items = research.items(two.app.store.home, "p1");
    expect(items[0]!.file).toBe(join(research.dir(two.app.store.home, "p1"), "0123456789abcdef.jpg"));
    expect(fs.existsSync(items[0]!.file)).toBe(false);
    expect(fs.readFileSync(await researchCloud.image(items[0]!.file), "utf8")).toBe("picture");
    // Research here already: nothing taken over it.
    expect(await researchCloud.pull(two.app, "p1")).toBe(false);
    // Left two weeks: the image goes from the Mac that found it (it's in the cloud).
    expect(researchCloud.free(one.app, "p1", Date.now())).toBe(0);
    expect(researchCloud.free(one.app, "p1", Date.now() - 15 * 86_400_000)).toBe(7);
    expect(fs.existsSync(join(folder, "0123456789abcdef.jpg"))).toBe(false);
  } finally {
    one.cleanup();
    two.cleanup();
  }
});
