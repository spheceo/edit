// Script mode's part of the lessons inbox (../lesson_inbox.ts, Nov 1 2026):
// a revision answers once with no tools, so its structured answer carries an
// optional `lesson`, a lasting preference or correction the producer or a
// reviewer gave, and the server notes it with the script it was said on. The
// edit agent does the same with its note_lesson tool.

import type { Script } from "@edit/types/writer";

import * as diag from "../diag.ts";
import * as cloud from "../cloud.ts";
import { note, noteFrom } from "../lesson_inbox.ts";

/** The answer's optional `lesson` property (left out: nothing that should outlast this script). */
export const LESSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    lesson: { type: "string" },
    quote: { type: "string" },
    from: { type: "string" },
    scope: { type: "string", enum: ["house", "style", "person"] },
  },
  required: ["lesson", "quote", "scope"],
};

/** What the model is told about it. */
export const LESSON_RULE =
  "LESSONS: when the producer or a reviewer gives a preference or correction meant to hold for every later script, not just this one (\"we never…\", \"always…\", the same note again, a rule of the guide it shows wrong), also send lesson {lesson: the rule in general terms for any script, never naming this one's clips or times; quote: their words verbatim; from: who said it when it's a review note's author; scope: house (every script), style (this kind of script) or person (one person's or channel's taste)}, once, beside the edits that fix this script. It goes to the team's lessons inbox for the next teaching round. Otherwise leave lesson out. Never mention it in the reply: the app adds a line.";

/** The answer's lesson, if it carries one. */
export function lessonOf(plan: Record<string, unknown> | null): Record<string, unknown> | null {
  const lesson = plan?.lesson;
  return typeof lesson === "object" && lesson !== null ? (lesson as Record<string, unknown>) : null;
}

/** Notes `lesson` with the script it was said on; the line to add to the reply, or "" when there was none or it couldn't be noted (logged). */
export async function keep(script: Script, lesson: Record<string, unknown> | null): Promise<string> {
  if (lesson === null) return "";
  const given = noteFrom({ ...lesson, part: "script" });
  if (typeof given === "string") {
    diag.warn("lessons", `${script.title}: a lesson came back unusable (${given})`);
    return "";
  }
  if (!cloud.enabled()) return "\n\nThis sounds like a lesson for every script, but Edit isn't signed in, so it couldn't reach the team's lessons inbox: pass it on.";
  try {
    const id = await note({ ...given, style: script.commentary ? "commentary" : (script.kind ?? "interrogation"), source: { kind: "script", id: script.id, name: script.title } });
    diag.info("lessons", `${script.title}: noted ${id} (script, ${given.scope})`);
    return "\n\nNoted for the next teaching round, so later scripts get it too.";
  } catch (error) {
    diag.warn("lessons", `${script.title}: the lesson wasn't noted: ${diag.messageOf(error)}`);
    return "";
  }
}
