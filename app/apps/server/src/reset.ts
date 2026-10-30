// "Reset the video" (Oct 24): the edit back to how the script import left it
// (the script's footage ranges and cut-in cards laid out, the voice-overs on
// them), so a project can be edited again from the start once the agent has
// learnt more. Media, transcripts, research, the script and the review link
// stay: only the editing goes. The agent's `reset_edit` never does it on its
// own say: the chat asks the user (Accept / Reject) and the tool waits.

import * as fs from "node:fs";

import type { App } from "./app.ts";
import * as diag from "./diag.ts";
import { nowMs, writeAtomic } from "./files.ts";
import { ApiError } from "./http/errors.ts";
import { readJson, type Router } from "./http/router.ts";
import { registerTool, text, type ToolCall } from "./mcp/registry.ts";
import type { Project } from "./model.ts";
import { join } from "./paths.ts";
import { newProject } from "./project.ts";
import { jsonForSerde } from "./rust.ts";
import { layOut } from "./script.ts";
import * as seams from "./seams.ts";

/** How long the tool waits for an answer before it gives up (tools give up at 15 minutes). */
const ANSWER_MS = 10 * 60_000;

interface Asked {
  at: number;
  answer: (accepted: boolean) => void;
}

/** The reset each project's chat is asking about, until it's answered. */
const asked = new Map<string, Asked>();

/** What the chat shows: a reset waiting on the user's answer, or nothing. */
export function pending(projectId: string): { asked_ms: number } | null {
  const one = asked.get(projectId);
  return one === undefined ? null : { asked_ms: one.at };
}

/** The user's answer (from the chat's card); false when nothing was asking. */
export function answer(projectId: string, accepted: boolean): boolean {
  const one = asked.get(projectId);
  if (one === undefined) return false;
  asked.delete(projectId);
  one.answer(accepted);
  return true;
}

/** Asks the user in the chat; resolves with their answer (false when nobody answers in time). */
function ask(projectId: string): Promise<boolean> {
  answer(projectId, false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (asked.get(projectId)?.answer === done) asked.delete(projectId);
      resolve(false);
    }, ANSWER_MS);
    const done = (accepted: boolean) => {
      clearTimeout(timer);
      resolve(accepted);
    };
    asked.set(projectId, { at: Date.now(), answer: done });
  });
}

/** The project with its editing gone and the script laid out again, as the import left it. */
export function cleared(project: Project): void {
  if (project.script === undefined || project.script === null) {
    throw new Error("this project wasn't started from a script, so there's no first layout to go back to");
  }
  const fresh = newProject(project.id, project.name, project.settings, project.style);
  project.tracks = fresh.tracks;
  project.clips = [];
  project.next_id = Math.max(project.next_id, fresh.next_id);
  delete project.mark_in;
  delete project.mark_out;
  delete project.markers;
  delete project.segments;
  delete project.people;
  for (const block of project.script.blocks) {
    delete block.clip;
    if (block.kind === "narration") delete block.voiceover;
  }
  layOut(project);
}

/** Resets `id`'s edit (one save), then puts the voice-overs back on the cut-ins (the takes already spoken). */
export async function reset(app: App, id: string): Promise<{ clips: number; voiceover: string }> {
  // The edit before, kept where every project's earlier saves are (projects/history/<id>/),
  // whatever the history's own pace: a reset is never the one save it skipped.
  const before = app.store.get(id);
  if (before === null) throw new Error("no such project");
  const dir = join(app.store.home, "projects", "history", id);
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, `${nowMs()}.json`), jsonForSerde(before.project));
  const [live] = await app.store.update(id, "agent", (project) => cleared(project));
  let voiceover = "on the cut-ins";
  try {
    await seams.voiceover.generate(app, id);
  } catch (error) {
    voiceover = `not placed: ${diag.messageOf(error)}`;
  }
  const clips = app.store.get(id)?.project.clips.length ?? live.project.clips.length;
  diag.info("reset", `${live.project.name}: reset to the script's first layout (${clips} clips; voice-over ${voiceover})`);
  return { clips, voiceover };
}

// "New chat" (Oct 30): the panel has no button for it any more; the user asks
// the agent, which calls this, says so, and its turn ends the conversation.
// The next message starts a fresh one; the edit itself is untouched.
registerTool("new_chat", ({ app, projectId }: ToolCall) => {
  const panel = seams.agentPanel(app);
  if (panel.resetAfterTurn === undefined) throw new Error("this agent can't start a new chat");
  panel.resetAfterTurn(projectId);
  return text("This conversation ends when your turn does; the user's next message starts a new one with none of it. Say so in one short line and stop.");
});

registerTool("reset_edit", async ({ app, projectId }: ToolCall) => {
  const live = app.store.get(projectId);
  if (live === null) throw new Error("no such project");
  if (live.project.script === undefined || live.project.script === null) {
    throw new Error("this project wasn't started from a script, so there's no first layout to go back to");
  }
  app.store.emit({ type: "reset", id: projectId, state: "asking" });
  const accepted = await ask(projectId);
  app.store.emit({ type: "reset", id: projectId, state: accepted ? "accepted" : "declined" });
  if (!accepted) return text("The user didn't accept the reset (rejected, or no answer in 10 minutes): the edit is as it was. Stop here.");
  const done = await reset(app, projectId);
  return text(
    `Reset: the edit is back to the script's first layout (${done.clips} clips: the footage ranges and cut-in cards; the voice-over ${done.voiceover}). Media, transcripts, research and the script are as they were. Stop here: the user starts the editing workflow when they want it.`,
  );
});

export function routes(router: Router<App>): void {
  router.get("/api/projects/{id}/reset", ({ params }) => Response.json({ pending: pending(params.id ?? "") }));
  // The chat's card: {accept: true | false}.
  router.post("/api/projects/{id}/reset", async (context) => {
    const given = (await readJson<unknown>(context).catch(() => ({}))) as Record<string, unknown>;
    if (typeof given.accept !== "boolean") throw new ApiError(400, "accept: true or false");
    if (!answer(context.params.id ?? "", given.accept)) throw new ApiError(409, "nothing is asking to reset this project");
    return Response.json({ answered: true });
  });
}
