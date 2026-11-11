// Read-only: calls the query edit:getProject for each project and downloads its body JSON.
import { ConvexHttpClient } from "/home/spheg/Documents/code/accounts/node_modules/convex/dist/esm/browser/index.js";
import { anyApi } from "/home/spheg/Documents/code/accounts/node_modules/convex/dist/esm/server/index.js";
const dir = process.argv[2];
const client = new ConvexHttpClient(process.env.CONVEX_URL!);
const token = process.env.CONVEX_SERVICE_TOKEN!;
const ids = (await Bun.file(`${dir}/cx/editProjects.jsonl`).text()).trim().split("\n").map((l) => JSON.parse(l).projectId);
for (const projectId of ids) {
  const p: any = await client.query(anyApi.edit.getProject, { token, projectId });
  if (!p?.bodyUrl) { console.error("no body", projectId); continue; }
  const r = await fetch(p.bodyUrl);
  await Bun.write(`${dir}/bodies/${projectId}.json`, await r.text());
}
console.error("done", ids.length);
