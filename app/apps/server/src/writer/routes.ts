// Script mode's HTTP API, under /api/writer/: the routes Writer's own server
// answered (its UI came over with them), each checked against what the
// signed-in person may do (can.ts).

import type { Adding, BuildStatus, Choice, Clip, Draft, Focus, Kind, LearnStep, Pacing, Role, Script } from "@edit/types/writer";

import type { App } from "../app.ts";
import * as diag from "../diag.ts";
import { ApiError, bad, json, notFound } from "../http/errors.ts";
import { serveFile } from "../http/files.ts";
import { readJson, type RouteContext, type Router } from "../http/router.ts";
import { isFile, join } from "../paths.ts";
import { creator } from "../accounts.ts";
import * as build from "./build.ts";
import * as can from "./can.ts";
import * as chat from "./chat.ts";
import * as cloud from "./cloud.ts";
import * as commentary from "./commentary.ts";
import { blocksOf } from "./blocks.ts";
import * as activity from "./activity.ts";
import * as archive from "./archive.ts";
import * as brief from "./brief.ts";
import * as docs from "./docs.ts";
import * as edits from "./edits.ts";
import * as feedback from "./feedback.ts";
import { lessons } from "./lessons.ts";
import * as fixing from "./fixing.ts";
import * as handoff from "./handoff.ts";
import { projectFor } from "../writer_handoff.ts";
import * as footage from "./footage.ts";
import * as imports from "./imports.ts";
import * as jobs from "./jobs.ts";
import * as reuse from "./reuse.ts";
import * as reviews from "./reviews.ts";
import * as scout from "./scout.ts";
import { pageCount } from "./pages.ts";
import { audit } from "./plan.ts";
import * as scripting from "./scripting.ts";
import { readText } from "./sources.ts";
import * as store from "./store.ts";
import * as trello from "./trello.ts";
import * as versions from "./versions.ts";
import * as watch from "./watch.ts";

type Context = RouteContext<App>;

export const dataOf = (app: App): string => store.dataDir(app.store.home);

/** A script as the page reads it: the body, where its preview is, and this Mac's state of it. */
export function detail(data: string, script: Script): Script {
  const dir = store.scriptDir(data, script.id);
  const out: Script = { ...script, proxyPath: isFile(store.proxyPath(dir)) ? store.proxyPath(dir) : null };
  // What the watcher left unfinished, for Retry unfinished speaker checks.
  const check = watch.status(dir);
  if (check !== null) out.speakerCheck = check;
  // Archived on Repack's page: its footage freed, read-only until restored.
  const archived = archive.state(data, script.id);
  if (archived !== null) out.archive = archived;
  return out;
}

/** The script `id` read for the signed-in person: refused when its kind isn't theirs. */
export function readFor(data: string, id: string): Script {
  if (!store.idOk(id)) throw notFound("Unknown script.");
  const script = store.read(store.scriptDir(data, id));
  can.requireScript(script);
  return script;
}

/** Refuses while an import or a job runs on the script. */
export function idle(id: string, what = "This import is still running."): void {
  if (imports.importing(id)) throw bad(what);
}

/** A route's work, its plain errors answered as 400s. */
export async function answer<T>(work: () => T | Promise<T>): Promise<Response> {
  try {
    const value = await work();
    return json(value ?? null);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw bad(diag.messageOf(error));
  }
}

export async function body<T>(context: Context): Promise<T> {
  return (await readJson<T>(context)) ?? ({} as T);
}

const id = (context: Context): string => context.params.id ?? "";

/** The scripts already made, lowercased, so a Trello card with one is marked. */
const titles = (app: App): string[] => store.list(dataOf(app)).map((row) => row.title.trim().toLowerCase());

const NO_FOCUS: Focus = { selected: [], picked: null, playheadMs: null };

/** Refused while Claude works on the script: `what` says what waits. */
function notWhileWriting(scriptId: string, what = "Claude is still working on this script."): void {
  if (jobs.running(scriptId)) throw bad(what);
}

export function routes(router: Router<App>): void {
  router
    .get("/api/writer/scripts", ({ app }) =>
      answer(() => {
        const data = dataOf(app);
        return store
          .list(data)
          .filter((row) => can.sees(row))
          .map((row) => {
            const refusal = cloud.refused(row.id);
            const archived = archive.state(data, row.id);
            return Object.assign(row, { building: jobs.running(row.id) }, refusal === null ? {} : { cloudRefused: refusal }, archived === null ? {} : { archive: archived });
          });
      }),
    )
    .get("/api/writer/library", () => json({ version: store.libraryVersion() }))
    .get("/api/writer/scripts/{id}", (context) => answer(() => detail(dataOf(context.app), readFor(dataOf(context.app), id(context)))))
    .delete("/api/writer/scripts/{id}", (context) =>
      answer(() => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        idle(id(context));
        if (jobs.running(id(context))) throw new Error("Claude is still writing this script.");
        // The cloud's delete is recorded first: a crash between the two can't bring the script back.
        cloud.deleted(data, id(context));
        store.remove(data, id(context));
        store.libraryChanged();
        return { ok: true };
      }),
    )
    .put("/api/writer/scripts/{id}/title", async (context) => {
      const { title } = await body<{ title: string }>(context);
      return answer(() => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        return detail(data, edits.rename(data, id(context), String(title ?? "")));
      });
    })
    .put("/api/writer/scripts/{id}/clips", async (context) => {
      const given = await body<{ revision: number; clips: Clip[] }>(context);
      return answer(() => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        idle(id(context));
        return detail(data, edits.saveClips(data, id(context), Number(given.revision), Array.isArray(given.clips) ? given.clips : []));
      });
    })
    .put("/api/writer/scripts/{id}/corrections", async (context) => {
      const given = await body<{ revision: number; word: string; text: string }>(context);
      return answer(() => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        return detail(data, edits.correctWord(data, id(context), Number(given.revision), String(given.word ?? ""), String(given.text ?? "")));
      });
    })
    .put("/api/writer/scripts/{id}/heading", async (context) => {
      const given = await body<{ revision: number; heading: string }>(context);
      return answer(() => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        return detail(data, edits.setHeading(data, id(context), Number(given.revision), String(given.heading ?? "")));
      });
    })
    .get("/api/writer/scripts/{id}/versions", (context) =>
      answer(() => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        return versions.list(store.scriptDir(data, id(context)));
      }),
    )
    .get("/api/writer/scripts/{id}/versions/{version}", (context) =>
      answer(() => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        return versions.read(store.scriptDir(data, id(context)), context.params.version ?? "");
      }),
    )
    .post("/api/writer/scripts/{id}/versions/{version}/restore", async (context) => {
      const given = await body<{ revision: number }>(context);
      return answer(() => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        if (jobs.running(id(context))) throw new Error("Claude is still working on this script.");
        return detail(data, edits.restoreVersion(data, id(context), Number(given.revision), context.params.version ?? ""));
      });
    })
    .post("/api/writer/scripts/{id}/proposals", async (context) => {
      const given = await body<{ revision: number; proposals: string[]; accept: boolean }>(context);
      return answer(() => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        if (jobs.running(id(context)) || imports.importing(id(context))) throw new Error("Wait for the current work to finish before reviewing changes.");
        return detail(data, edits.resolveProposals(data, id(context), Number(given.revision), Array.isArray(given.proposals) ? given.proposals.map(String) : [], given.accept === true));
      });
    })
    .get("/api/writer/scripts/{id}/chat", (context) =>
      answer(() => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        return chat.read(store.scriptDir(data, id(context)));
      }),
    )
    .delete("/api/writer/scripts/{id}/chat", (context) =>
      answer(() => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        if (jobs.running(id(context))) throw new Error("Claude is still working on this script.");
        chat.clear(store.scriptDir(data, id(context)));
        return { ok: true };
      }),
    )
    .post("/api/writer/scripts/{id}/reset", async (context) => {
      const given = await body<{ accept: boolean }>(context);
      return answer(() => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        if (jobs.running(id(context))) throw new Error("Claude is still working on this script.");
        return detail(data, edits.resetScript(data, id(context), given.accept === true));
      });
    })
    .get("/api/writer/scripts/{id}/build", (context) =>
      answer(() => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        return jobs.status(data, id(context));
      }),
    )
    .post("/api/writer/scripts/{id}/build/stop", (context) =>
      answer(() => {
        readFor(dataOf(context.app), id(context));
        jobs.stop(id(context));
        return { ok: true };
      }),
    )
    // Imports: each request holds until its import finishes or pauses for a choice; the page follows it in /api/writer/progress meanwhile.
    .post("/api/writer/scripts/file", async (context) => {
      const given = await body<{ path?: string; article?: string; title?: string; kind?: Kind }>(context);
      return answer(async () => detail(dataOf(context.app), await imports.fromFile(context.app, dataOf(context.app), String(given.path ?? ""), given.article ?? null, given.title ?? null, given.kind ?? null)));
    })
    .post("/api/writer/scripts/youtube", async (context) => {
      const given = await body<{ url?: string; article?: string; title?: string; kind?: Kind; build?: string }>(context);
      return answer(async () => detail(dataOf(context.app), await imports.fromYoutube(context.app, dataOf(context.app), String(given.url ?? ""), given.article ?? null, given.title ?? null, given.kind ?? null, firstBuild(given.build))));
    })
    .post("/api/writer/scripts/drive", async (context) => {
      const given = await body<{ url?: string; article?: string; title?: string; kind?: Kind; build?: string }>(context);
      return answer(async () => detail(dataOf(context.app), await imports.fromDrive(context.app, dataOf(context.app), String(given.url ?? ""), given.article ?? null, given.title ?? null, given.kind ?? null, firstBuild(given.build))));
    })
    .post("/api/writer/scripts/compilation", async (context) => {
      const given = await body<{ title?: string; urls?: string[]; case?: boolean; kind?: Kind; build?: string }>(context);
      return answer(async () => detail(dataOf(context.app), await imports.fromCompilation(context.app, dataOf(context.app), String(given.title ?? ""), Array.isArray(given.urls) ? given.urls.map(String) : [], given.case === true, given.kind ?? null, firstBuild(given.build))));
    })
    .post("/api/writer/scripts/brief", async (context) => {
      const given = await body<{ text?: string; kind?: Kind }>(context);
      return answer(async () => detail(dataOf(context.app), await imports.fromBrief(context.app, dataOf(context.app), String(given.text ?? ""), given.kind ?? null)));
    })
    .post("/api/writer/scripts/{id}/resume", async (context) => {
      const choice = await body<Choice>(context);
      return answer(async () => {
        readFor(dataOf(context.app), id(context));
        return detail(dataOf(context.app), await imports.resume(context.app, dataOf(context.app), id(context), choice));
      });
    })
    .post("/api/writer/scripts/{id}/complete-transcription", (context) =>
      answer(() => startJob(context.app, id(context), { kind: "transcribe" }, (job) => imports.complete(context.app, dataOf(context.app), id(context), job))),
    )
    .post("/api/writer/scripts/{id}/speakers/retry", (context) =>
      answer(() => startJob(context.app, id(context), { kind: "speakers" }, (job) => imports.retrySpeakers(context.app, dataOf(context.app), id(context), job))),
    )
    // A compilation's reused cases' videos, brought in for its opening's intro clips.
    .post("/api/writer/scripts/{id}/reuses", async (context) => {
      const given = await body<{ urls?: string[] }>(context);
      return answer(() => {
        const script = readFor(dataOf(context.app), id(context));
        const urls = Array.isArray(given.urls) && given.urls.length > 0 ? given.urls.map(String) : reuse.missing(script);
        if (urls.length === 0) throw new Error("Every reused case is already imported.");
        return startJob(context.app, id(context), { kind: "reuse", urls }, (job) => reuse.importReused(context.app, dataOf(context.app), id(context), urls, job));
      });
    })
    // Sharing for review on feedback.spheceo.com, and the notes reviewers leave there.
    .post("/api/writer/scripts/{id}/share", (context) =>
      answer(async () => {
        can.require(can.SHARE);
        readFor(dataOf(context.app), id(context));
        return detail(dataOf(context.app), await reviews.share(context.app, dataOf(context.app), id(context)));
      }),
    )
    .post("/api/writer/scripts/{id}/review/compress", (context) =>
      answer(async () => {
        can.require(can.SHARE);
        readFor(dataOf(context.app), id(context));
        return detail(dataOf(context.app), await reviews.compress(context.app, dataOf(context.app), id(context)));
      }),
    )
    .post("/api/writer/scripts/{id}/review/replace", (context) =>
      answer(async () => {
        can.require(can.SHARE);
        readFor(dataOf(context.app), id(context));
        notWhileWriting(id(context));
        return detail(dataOf(context.app), await reviews.replaceLatest(context.app, dataOf(context.app), id(context)));
      }),
    )
    .get("/api/writer/reviews", ({ app }) => json(reviews.counts(dataOf(app))))
    .get("/api/writer/scripts/{id}/review", (context) => answer(() => reviewState(dataOf(context.app), id(context))))
    .put("/api/writer/scripts/{id}/review/approval", async (context) => {
      const given = await body<{ approve?: boolean }>(context);
      return answer(async () => {
        can.require(can.SHARE);
        const data = dataOf(context.app);
        readFor(data, id(context));
        if (given.approve === false) await reviews.unapprove(data, id(context));
        else await reviews.approve(data, id(context));
        return reviewState(data, id(context));
      });
    })
    // Fixes a script's open notes now, by hand: on any computer, not only the fixing one.
    .post("/api/writer/scripts/{id}/review/fix", (context) =>
      answer(() => {
        can.require(can.SHARE);
        const data = dataOf(context.app);
        readFor(data, id(context));
        const approved = reviews.approval(data, id(context));
        if (approved !== null) throw new Error(`v${approved.version} is approved, so its notes aren't fixed. Take the approval back to fix them.`);
        const notes = reviews.openNotes(data, id(context));
        if (notes.length === 0) throw new Error("No notes are open.");
        reviews.markTried(data, notes);
        return startJob(context.app, id(context), { kind: "review", notes, ready: null }, (job) => fixing.run(context.app, data, id(context), notes, null, job));
      }),
    )
    .get("/api/writer/scripts/{id}/review/fix", (context) =>
      answer(() => {
        readFor(dataOf(context.app), id(context));
        return reviews.fixState(id(context));
      }),
    )
    .post("/api/writer/scripts/{id}/review/notes", async (context) => {
      const given = await body<{ text?: string; details?: reviews.NoteDetails }>(context);
      return answer(async () => {
        can.require(can.SHARE);
        readFor(dataOf(context.app), id(context));
        await reviews.addNote(dataOf(context.app), id(context), String(given.text ?? ""), given.details ?? {});
        return { ok: true };
      });
    })
    .post("/api/writer/scripts/{id}/review/notes/{note}/replies", async (context) => {
      const given = await body<{ text?: string }>(context);
      return answer(async () => {
        readFor(dataOf(context.app), id(context));
        await reviews.reply(dataOf(context.app), context.params.note ?? "", String(given.text ?? ""));
        return { ok: true };
      });
    })
    .post("/api/writer/scripts/{id}/review/notes/{note}/check", async (context) => {
      const given = await body<{ verdict?: string; text?: string }>(context);
      return answer(async () => {
        can.require(can.SHARE);
        readFor(dataOf(context.app), id(context));
        await reviews.check(dataOf(context.app), context.params.note ?? "", String(given.verdict ?? ""), given.text ?? null);
        return { ok: true };
      });
    })
    .delete("/api/writer/scripts/{id}/review/notes/{note}", (context) =>
      answer(async () => {
        can.require(can.SHARE);
        readFor(dataOf(context.app), id(context));
        await reviews.deleteNote(dataOf(context.app), context.params.note ?? "");
        return { ok: true };
      }),
    )
    // Google Docs: the script laid out by the page as a Word file, made into a Doc in the team's "Writer scripts" folder.
    .post("/api/writer/scripts/{id}/docs", async (context) => {
      const given = await body<{ draft?: boolean; docx?: string }>(context);
      return answer(() => {
        can.require(can.SHARE);
        readFor(dataOf(context.app), id(context));
        return docs.exportDoc(dataOf(context.app), id(context), given.draft === true, String(given.docx ?? ""));
      });
    })
    .get("/api/writer/scripts/{id}/docs", (context) =>
      answer(() => {
        readFor(dataOf(context.app), id(context));
        return docs.listDocs(id(context));
      }),
    )
    .get("/api/writer/scripts/{id}/docs/comments", (context) =>
      answer(() => {
        readFor(dataOf(context.app), id(context));
        return docs.docComments(dataOf(context.app), id(context), null);
      }),
    )
    .get("/api/writer/scripts/{id}/docs/{doc}/comments", (context) =>
      answer(() => {
        readFor(dataOf(context.app), id(context));
        return docs.docComments(dataOf(context.app), id(context), context.params.doc ?? "");
      }),
    )
    // Finding a commentary's clips on YouTube from its brief.
    .post("/api/writer/scripts/{id}/finds", (context) =>
      answer(() => {
        const script = readFor(dataOf(context.app), id(context));
        if (!script.commentary) throw new Error("Clips are found for a commentary script.");
        if (!script.commentary.sources.some((source) => source.role === "brief")) throw new Error("Add the producer's brief first: the search starts from it.");
        return startJob(context.app, id(context), { kind: "find" }, (job) => scout.find(context.app, dataOf(context.app), id(context), job));
      }),
    )
    .get("/api/writer/scripts/{id}/finds", (context) =>
      answer(() => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        return scout.load(store.scriptDir(data, id(context)));
      }),
    )
    .get("/api/writer/scripts/{id}/finds/frames/{name}", (context) => {
      const data = dataOf(context.app);
      readFor(data, id(context));
      const name = context.params.name ?? "";
      if (!/^frames-\d+\.jpg$/.test(name)) throw notFound("No such frames.");
      const path = join(store.scriptDir(data, id(context)), "finds", "frames", name);
      if (!isFile(path)) throw notFound("No such frames.");
      return serveFile(context.request, path);
    })
    // Teaching commentary builds from a review's notes: pull them, test a lesson in rounds, keep it.
    .post("/api/writer/scripts/{id}/feedback", (context) =>
      answer(async () => {
        can.require(can.LESSONS);
        readFor(dataOf(context.app), id(context));
        notWhileWriting(id(context));
        return feedback.pull(dataOf(context.app), id(context));
      }),
    )
    .get("/api/writer/scripts/{id}/feedback", (context) =>
      answer(() => {
        can.require(can.LESSONS);
        const data = dataOf(context.app);
        readFor(data, id(context));
        return feedback.load(store.scriptDir(data, id(context)));
      }),
    )
    .put("/api/writer/scripts/{id}/feedback/items/{item}", async (context) => {
      const given = await body<{ skip?: boolean; note?: string }>(context);
      return answer(() => {
        can.require(can.LESSONS);
        const data = dataOf(context.app);
        readFor(data, id(context));
        notWhileWriting(id(context));
        return feedback.setItem(store.scriptDir(data, id(context)), context.params.item ?? "", given.skip ?? null, given.note ?? null);
      });
    })
    .put("/api/writer/scripts/{id}/feedback/lesson", async (context) => {
      const given = await body<{ lesson?: string }>(context);
      return answer(() => {
        can.require(can.LESSONS);
        const data = dataOf(context.app);
        readFor(data, id(context));
        notWhileWriting(id(context));
        const [saved, leaks] = feedback.setLesson(store.scriptDir(data, id(context)), String(given.lesson ?? ""));
        return { feedback: saved, leaks };
      });
    })
    .post("/api/writer/scripts/{id}/feedback/steps", async (context) => {
      const step = await body<LearnStep>(context);
      return answer(() => {
        can.require(can.LESSONS);
        const data = dataOf(context.app);
        readFor(data, id(context));
        feedback.ready(store.scriptDir(data, id(context)), step);
        return startJob(context.app, id(context), { kind: "learn", step }, (job) => feedback.run(data, id(context), step, job));
      });
    })
    .post("/api/writer/scripts/{id}/feedback/keep", (context) =>
      answer(() => {
        can.require(can.LESSONS);
        readFor(dataOf(context.app), id(context));
        notWhileWriting(id(context));
        return feedback.keep(dataOf(context.app), id(context));
      }),
    )
    .get("/api/writer/lessons", ({ app }) =>
      answer(() => {
        can.require(can.LESSONS);
        return lessons(dataOf(app));
      }),
    )
    .delete("/api/writer/lessons/{lesson}", (context) =>
      answer(() => {
        can.require(can.LESSONS);
        return feedback.forget(dataOf(context.app), context.params.lesson ?? "");
      }),
    )
    // A commentary's clip footage, as Split plays it.
    .get("/api/writer/scripts/{id}/footage", (context) =>
      answer(() => {
        readFor(dataOf(context.app), id(context));
        return footage.now(context.app, dataOf(context.app), id(context));
      }),
    )
    .get("/api/writer/scripts/{id}/footage/{name}", (context) => {
      const data = dataOf(context.app);
      readFor(data, id(context));
      const path = footage.file(store.scriptDir(data, id(context)), context.params.name ?? "");
      if (path === null) throw notFound("No such clip.");
      return serveFile(context.request, path);
    })
    .get("/api/writer/progress", () => json(imports.progress()))
    .get("/api/writer/cloud", () => json(cloud.statusNow()))
    .get("/api/writer/activity", () => json(activity.list()))
    // Brings an archived script's footage back; followed as a build.
    .post("/api/writer/scripts/{id}/restore", (context) =>
      answer(() => {
        readFor(dataOf(context.app), id(context));
        return archive.startRestore(context.app, dataOf(context.app), id(context));
      }),
    )
    // The Edit project this script became, if it has one: Edit mode's side of the same project.
    .get("/api/writer/scripts/{id}/edit", (context) =>
      answer(() => {
        readFor(dataOf(context.app), id(context));
        return { project: projectFor(context.app, id(context)) };
      }),
    )
    // The script's footage and words put where Edit mode finds them.
    .post("/api/writer/scripts/{id}/edit-share", (context) =>
      answer(() => {
        readFor(dataOf(context.app), id(context));
        return handoff.share(dataOf(context.app), id(context));
      }),
    )
    .get("/api/writer/claude", () => answer(() => activity.claudeStatus()))
    .post("/api/writer/videos/check", async (context) => {
      const given = await body<{ lines?: string[] }>(context);
      return answer(() => imports.checkVideos(context.app, Array.isArray(given.lines) ? given.lines.map(String) : []));
    })
    .post("/api/writer/briefs/read", async (context) => {
      const given = await body<{ text?: string }>(context);
      return answer(() => brief.parse(String(given.text ?? "")));
    })
    .post("/api/writer/trello/card", async (context) => {
      const given = await body<{ link?: string }>(context);
      return answer(() => trello.card(String(given.link ?? ""), titles(context.app)));
    })
    .get("/api/writer/trello/{list}", (context) => answer(() => trello.cards(context.params.list ?? "", titles(context.app))))
    .post("/api/writer/scripts/{id}/build", async (context) => {
      const given = await body<{ note?: string; kind?: Kind }>(context);
      return answer(() => {
        const script = readFor(dataOf(context.app), id(context));
        if (given.kind !== undefined) can.requireKind(script, given.kind);
        const note = String(given.note ?? "");
        return startJob(context.app, id(context), { kind: "build", note, ...(given.kind ? { format: given.kind } : {}) }, (job) => scripting.buildOnce(context.app, dataOf(context.app), id(context), note, given.kind, job));
      });
    })
    .post("/api/writer/scripts/{id}/revise", async (context) => {
      const given = await body<{ request?: string; focus?: Focus }>(context);
      return answer(() => {
        const request = String(given.request ?? "").trim();
        if (request === "") throw new Error("Say what to change.");
        if ([...request].length > 8_000) throw new Error("Keep the request under 8,000 characters.");
        const focus = given.focus ?? NO_FOCUS;
        return startJob(context.app, id(context), { kind: "revise", request, focus }, (job) => scripting.reviseWith(dataOf(context.app), id(context), request, request, focus, false, job));
      });
    })
    .post("/api/writer/scripts/{id}/exact", (context) =>
      answer(() => startJob(context.app, id(context), { kind: "exact" }, (job) => scripting.exactOnce(context.app, dataOf(context.app), id(context), job))),
    )
    .get("/api/writer/scripts/{id}/research", (context) =>
      answer(() => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        return scripting.researchShown(store.scriptDir(data, id(context)));
      }),
    )
    .post("/api/writer/scripts/{id}/research", (context) =>
      answer(() => {
        readFor(dataOf(context.app), id(context));
        return scripting.researchAgain(dataOf(context.app), id(context), context.request.signal);
      }),
    )
    // What a reviewer would flag on the script as it is, with the counts behind it: shown before sharing.
    .get("/api/writer/scripts/{id}/audit", (context) =>
      answer(() => {
        const data = dataOf(context.app);
        const script = readFor(data, id(context));
        if (script.commentary) {
          const [measures, flags] = commentary.checks(store.scriptDir(data, id(context)), script);
          return { measures, flags };
        }
        // A footage script's Letter pages, as its Doc lays them out (a compilation runs 6 to 7).
        return { measures: null, pages: pageCount(script, script.clips), flags: audit(script) };
      }),
    )
    // Commentary projects: the sources a script is written from, its pacing and its written draft.
    .post("/api/writer/scripts/commentary", async (context) => {
      const given = await body<{ title?: string; links?: string[] }>(context);
      return answer(async () => {
        can.require(can.COMMENTARY);
        const data = dataOf(context.app);
        return detail(data, await commentary.create(data, String(given.title ?? ""), Array.isArray(given.links) ? given.links.map(String) : [], creator() ?? undefined));
      });
    })
    .post("/api/writer/scripts/{id}/sources", async (context) => {
      const given = await body<{ adding: Adding; role: Role }>(context);
      return answer(async () => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        notWhileWriting(id(context), "Claude is writing this script. Add sources once it's done.");
        return detail(data, await commentary.add(data, id(context), given.adding, given.role));
      });
    })
    .get("/api/writer/scripts/{id}/sources/{source}", (context) =>
      answer(() => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        return readText(store.scriptDir(data, id(context)), context.params.source ?? "");
      }),
    )
    .put("/api/writer/scripts/{id}/sources/{source}", async (context) => {
      const given = await body<{ role?: Role; title?: string }>(context);
      return answer(() => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        return detail(data, commentary.updateSource(data, id(context), context.params.source ?? "", given.role ?? null, given.title ?? null));
      });
    })
    .delete("/api/writer/scripts/{id}/sources/{source}", (context) =>
      answer(() => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        notWhileWriting(id(context), "Claude is writing this script. Remove sources once it's done.");
        return detail(data, commentary.removeSource(data, id(context), context.params.source ?? ""));
      }),
    )
    .put("/api/writer/scripts/{id}/pacing", async (context) => {
      const given = await body<{ pacing: Pacing }>(context);
      return answer(() => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        notWhileWriting(id(context));
        if (given.pacing !== "channel" && given.pacing !== "documentary") throw new Error("Pace it as the channel or as a documentary.");
        return detail(data, commentary.setPacing(data, id(context), given.pacing));
      });
    })
    .put("/api/writer/scripts/{id}/draft", async (context) => {
      const given = await body<{ revision: number; draft: Draft }>(context);
      return answer(() => {
        const data = dataOf(context.app);
        readFor(data, id(context));
        notWhileWriting(id(context), "Claude is writing this script.");
        return detail(data, commentary.saveDraft(data, id(context), Number(given.revision), given.draft));
      });
    })
    // The preview: the file on this Mac, a range at a time (cloud.ts streams one that's only in the cloud).
    .get("/api/writer/scripts/{id}/proxy", async (context) => {
      const data = dataOf(context.app);
      readFor(data, id(context));
      const path = store.proxyPath(store.scriptDir(data, id(context)));
      if (isFile(path)) return serveFile(context.request, path);
      // Made on another Mac: played from the cloud.
      const streamed = await cloud.stream(context.request, data, id(context));
      if (streamed === null) throw notFound("No preview here.");
      return streamed;
    })
    .get("/api/writer/scripts/{id}/files/{name}", (context) => {
      // A file the page shows beside the script (a found clip's frames, a commentary's footage): only plain names in its folder.
      const data = dataOf(context.app);
      readFor(data, id(context));
      const name = context.params.name ?? "";
      if (!/^[\w .()-]+$/u.test(name) || name.startsWith(".")) throw bad("Unknown file.");
      const path = join(store.scriptDir(data, id(context)), name);
      if (!isFile(path)) throw notFound("No such file.");
      return serveFile(context.request, path);
    });
  // Claude's tools while it builds a script in steps (build.ts), on this server.
  build.routes(router);
}

/** A script's review as the page shows it: its notes, its blocks as shared, its approval. */
function reviewState(data: string, scriptId: string): { notes: reviews.Note[]; blocks: ReturnType<typeof blocksOf>; approved: reviews.Approval | null } {
  const script = readFor(data, scriptId);
  return { notes: reviews.notesOf(data, scriptId), blocks: blocksOf(script), approved: reviews.approval(data, scriptId) };
}

/** Starts the work's job on a script the person may see; its first status. */
/** An import's first build (New project's first message): `build` given, even empty, builds when the import is ready. */
const firstBuild = (build: unknown): { note: string } | null => (typeof build === "string" ? { note: build.trim().slice(0, 4_000) } : null);

// A script made with a first build is built once its import is ready, as the Build button would.
imports.hooks.build = (app, id, note) => {
  startJob(app, id, { kind: "build", note }, (job) => scripting.buildOnce(app, dataOf(app), id, note, undefined, job));
};

export function startJob(app: App, scriptId: string, work: jobs.Work, run: (job: jobs.Job) => Promise<jobs.Outcome>, after?: () => void): BuildStatus {
  const data = dataOf(app);
  const script = readFor(data, scriptId);
  idle(scriptId);
  // A commentary's clips may have changed: their footage comes down after.
  const footageAfter = ["restore", "speakers", "transcribe"].includes(work.kind) ? undefined : () => void footage.now(app, data, scriptId);
  return jobs.start(data, scriptId, script.title, work, run, () => {
    footageAfter?.();
    after?.();
  });
}
