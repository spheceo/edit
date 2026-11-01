// The lessons inbox (Nov 1 2026): a lasting preference or correction someone
// on the team gave the agent, noted so it reaches the next teaching round
// instead of ending with the session. It isn't memory the agent reads back:
// the skills, code and audits stay what teaches it (tested, versioned), and
// a round takes the open lessons, teaches each (or drops a one-off), then
// closes it with where it landed. Closed lessons stay, so one that comes back
// after it was taught shows the teaching didn't hold. The user, Nov 1: "we
// pull from that inbox and once the teaching is in we remove it". Kept in
// mamagi (`edit:listLessons`, `noteLesson`, `closeLesson`) through the relay,
// which names who noted or closed it from their token.
//
//   GET  /api/lessons[?all=1]                           {lessons}: the open ones, oldest first (all: closed too, newest first)
//   POST /api/lessons {lesson, quote, part, scope, from?, project?}   noted: {id}
//   POST /api/lessons/{id} {status, outcome?}           taught (where), dropped (why) or open again

import type { InboxLesson, LessonScope } from "@edit/types/lessons";

import type { App } from "./app.ts";
import * as cloud from "./cloud.ts";
import * as diag from "./diag.ts";
import { ApiError, bad, json } from "./http/errors.ts";
import type { RouteContext, Router } from "./http/router.ts";
import { readJson } from "./http/router.ts";
import { registerTool, text, type ToolCall } from "./mcp/registry.ts";
import { isSubtitled } from "./store.ts";

const PART = /^[a-z][a-z0-9-]{0,40}$/;
const SCOPES: readonly LessonScope[] = ["house", "style", "person"];

export interface Note {
  lesson: string;
  quote: string;
  part: string;
  scope: LessonScope;
  from?: string;
  style?: string;
  source?: { kind: "edit" | "script" | "idea"; id: string; name: string };
}

/** `body` as a note, or why not. */
export function noteFrom(body: Record<string, unknown>): Note | string {
  const lesson = typeof body.lesson === "string" ? body.lesson.trim() : "";
  const quote = typeof body.quote === "string" ? body.quote.trim() : "";
  if (lesson === "" || lesson.length > 2000) return "lesson: the lesson in general terms, 1 to 2000 characters.";
  if (quote === "" || quote.length > 4000) return "quote: the team's own words, verbatim, 1 to 4000 characters.";
  if (typeof body.part !== "string" || !PART.test(body.part)) return "part: a skill's name (intro, music-and-sound…), script, ideas or other.";
  if (typeof body.scope !== "string" || !SCOPES.includes(body.scope as LessonScope)) return "scope: house (every video), style (this kind of video) or person (one person's or channel's taste).";
  const from = typeof body.from === "string" && body.from.trim() !== "" ? body.from.trim().slice(0, 200) : undefined;
  return { lesson, quote, part: body.part, scope: body.scope as LessonScope, ...(from ? { from } : {}) };
}

/** Where a note was said, from the project it was said on: its name and its kind of video. */
function placed(app: App, note: Note, projectId: string | null): Note {
  const live = projectId === null ? null : app.store.get(projectId);
  if (live === null) return note;
  const project = live.project;
  return { ...note, style: isSubtitled(project) ? "subtitles" : project.style, source: { kind: "edit", id: projectId!, name: project.name } };
}

function needsCloud(): void {
  if (!cloud.enabled()) throw new ApiError(409, "The lessons inbox is the team's, kept in the cloud: sign in to Edit first.");
}

/** Notes a lesson, open. */
export async function note(lesson: Note): Promise<string> {
  needsCloud();
  const answer = (await cloud.mutation("edit:noteLesson", lesson)) as { id?: unknown } | null;
  if (typeof answer?.id !== "string") throw new Error("the inbox didn't say which lesson it noted");
  return answer.id;
}

/** The open lessons, oldest first; with `all`, closed ones too, newest first. */
export async function list(all = false): Promise<InboxLesson[]> {
  if (!cloud.enabled()) return [];
  const rows = await cloud.query("edit:listLessons", all ? { all: true } : {});
  return Array.isArray(rows) ? (rows as InboxLesson[]) : [];
}

/** Closes a lesson: taught (`outcome`: where it landed), dropped (`outcome`: why), or opens it again. */
export async function close(id: string, status: "taught" | "dropped" | "open", outcome?: string): Promise<void> {
  needsCloud();
  await cloud.mutation("edit:closeLesson", { id, status, ...(outcome !== undefined && status !== "open" ? { outcome } : {}) });
}

registerTool("note_lesson", async ({ app, args, projectId }: ToolCall) => {
  const given = noteFrom(args);
  if (typeof given === "string") throw new Error(given);
  if (!cloud.enabled()) throw new Error("not noted: Edit isn't signed in, so the team's lessons inbox can't be reached. Tell the user, so they can pass the lesson on.");
  const id = await note(placed(app, given, projectId));
  diag.info("lessons", `noted ${id} (${given.part}, ${given.scope})`);
  return text(`noted in the lessons inbox (${id}): the next teaching round teaches it to every later edit. Carry on: fix it in this project as usual.`);
});

export function routes(router: Router<App>): void {
  router
    .get("/api/lessons", async ({ query }: RouteContext<App>) => {
      try {
        return json({ lessons: await list(query.get("all") === "1") });
      } catch (error) {
        diag.warn("lessons", `lessons: list: ${diag.messageOf(error)}`);
        throw new ApiError(502, `The lessons inbox didn't load: ${diag.messageOf(error)}`);
      }
    })
    .post("/api/lessons", async (context: RouteContext<App>) => {
      needsCloud();
      const body = await readJson<Record<string, unknown>>(context);
      const given = noteFrom(body);
      if (typeof given === "string") throw bad(given);
      const projectId = typeof body.project === "string" ? body.project : null;
      try {
        return json({ id: await note(placed(context.app, given, projectId)) });
      } catch (error) {
        throw new ApiError(502, `The lessons inbox didn't take it: ${diag.messageOf(error)}`);
      }
    })
    .post("/api/lessons/{id}", async (context: RouteContext<App>) => {
      needsCloud();
      const body = await readJson<{ status?: unknown; outcome?: unknown }>(context);
      const status = body.status;
      if (status !== "taught" && status !== "dropped" && status !== "open") throw bad("status: taught, dropped or open.");
      const outcome = typeof body.outcome === "string" ? body.outcome.trim() : "";
      if (status !== "open" && outcome === "") throw bad(status === "taught" ? "outcome: where it landed (the skill, the commit, the audit)." : "outcome: why it was dropped.");
      try {
        await close(context.params.id!, status, status === "open" ? undefined : outcome);
      } catch (error) {
        throw new ApiError(502, `The lessons inbox didn't take it: ${diag.messageOf(error)}`);
      }
      return json({ id: context.params.id, status });
    });
}
