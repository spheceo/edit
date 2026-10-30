// Trello, read only, for Script mode's imports: one card by its link, or the
// cards waiting on the two lists scripts come from. Moved here from Writer's
// relay (Oct 30: the Writer app is being discontinued). The Trello key and
// token are Repack's (`TRELLO_API_KEY`, `TRELLO_TOKEN`) and never leave the
// relay; nothing is ever written to Trello.

export interface TrelloEnv {
  TRELLO_API_KEY?: string;
  TRELLO_TOKEN?: string;
}

/** The Trello lists scripts come from, as Repack's workspaces name them. Only these are read. */
const TRELLO_LISTS: Record<string, { id: string; name: string }> = {
  // Raw Channels board: one case a card, footage in a Drive folder.
  raw: { id: "69eb256a4a7d292ca721520a", name: "Raw Channels · Script (Sphe)" },
  // Interrogation board: a compilation a card, its cases' links in the description.
  comp: { id: "6abfd240d4c0d819f06458e9", name: "Interrogation · Ready for script (comp)" },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Keep the attachment's label: it can carry its case number or reuse marker. */
export function attachmentLabels(items: { name?: string; url?: string }[]): string[] {
  return items.filter((item) => item.url?.startsWith("http")).map((item) => `${(item.name ?? "").replace(/[\r\n]/g, " ")} <${item.url}>`);
}

/** One card by its link's id (trello.com/c/<id>), with everything a script's links can be in: its description, attachments, checklist items and comments. */
export async function trelloCard(card: string, env: TrelloEnv): Promise<Response> {
  if (!env.TRELLO_API_KEY || !env.TRELLO_TOKEN) return json(503, { error: "Trello is not configured on the relay yet." });
  if (!/^[A-Za-z0-9]{6,32}$/.test(card)) return json(400, { error: "That isn't a Trello card link." });
  const query = new URLSearchParams({
    fields: "name,desc,url,dateLastActivity,labels,idBoard",
    attachments: "true",
    attachment_fields: "name,url",
    checklists: "all",
    checklist_fields: "name",
    actions: "commentCard",
    actions_limit: "100",
    key: env.TRELLO_API_KEY,
    token: env.TRELLO_TOKEN,
  });
  const answer = await fetch(`https://api.trello.com/1/cards/${card}?${query}`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!answer) return json(502, { error: "Trello did not answer." });
  if (answer.status === 404 || answer.status === 401) return json(404, { error: "That card isn't on a board the team's Trello can read." });
  if (!answer.ok) return json(502, { error: `Trello answered ${answer.status}.` });
  type Found = {
    id: string; name: string; desc?: string; url: string; dateLastActivity?: string;
    labels?: { name?: string }[]; attachments?: { name?: string; url?: string }[];
    checklists?: { checkItems?: { name?: string }[] }[];
    actions?: { data?: { text?: string } }[];
  };
  const found = (await answer.json()) as Found;
  return json(200, {
    id: found.id,
    name: found.name,
    desc: found.desc ?? "",
    url: found.url,
    activity: found.dateLastActivity ?? null,
    labels: (found.labels ?? []).map((label) => label.name ?? "").filter(Boolean),
    attachmentLabels: attachmentLabels(found.attachments ?? []),
    attachments: (found.attachments ?? []).map((item) => item.url ?? "").filter((link) => link.startsWith("http")),
    checklists: (found.checklists ?? []).flatMap((list) => (list.checkItems ?? []).map((item) => item.name ?? "")).filter(Boolean),
    comments: (found.actions ?? []).map((action) => action.data?.text ?? "").filter(Boolean),
  });
}

/** The cards waiting on one of the two lists (`raw` or `comp`). */
export async function trelloCards(list: string, env: TrelloEnv): Promise<Response> {
  if (!env.TRELLO_API_KEY || !env.TRELLO_TOKEN) return json(503, { error: "Trello is not configured on the relay yet." });
  const wanted = TRELLO_LISTS[list];
  if (!wanted) return json(400, { error: `Choose a list: ${Object.keys(TRELLO_LISTS).join(" or ")}.` });
  const query = new URLSearchParams({
    fields: "name,desc,url,dateLastActivity,labels",
    attachments: "true",
    attachment_fields: "name,url",
    key: env.TRELLO_API_KEY,
    token: env.TRELLO_TOKEN,
  });
  const answer = await fetch(`https://api.trello.com/1/lists/${wanted.id}/cards?${query}`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!answer) return json(502, { error: "Trello did not answer." });
  if (!answer.ok) return json(502, { error: `Trello answered ${answer.status}.` });
  type Card = { id: string; name: string; desc?: string; url: string; dateLastActivity?: string; labels?: { name?: string }[]; attachments?: { name?: string; url?: string }[] };
  const cards = (await answer.json()) as Card[];
  return json(200, {
    list: wanted.name,
    cards: cards.map((card) => ({
      id: card.id,
      name: card.name,
      desc: card.desc ?? "",
      url: card.url,
      activity: card.dateLastActivity ?? null,
      labels: (card.labels ?? []).map((label) => label.name ?? "").filter(Boolean),
      attachmentLabels: attachmentLabels(card.attachments ?? []),
      attachments: (card.attachments ?? []).map((item) => item.url ?? "").filter((link) => link.startsWith("http")),
    })),
  });
}
