// The lessons inbox (apps/server/src/lesson_inbox.ts), from the account menu:
// what the agents noted from the team to teach every later edit, open until
// a teaching round takes it, then where it landed (or why it was dropped).
// Read-only: the agents note lessons, a teaching round closes them.

import { useEffect, useState } from "react";

import type { InboxLesson } from "@edit/types/lessons";

import { StartedBy } from "./StartedBy";
import { cx, Tabs } from "./ui";

type View = "open" | "closed";

const SCOPE: Record<InboxLesson["scope"], string> = { house: "Every video", style: "This kind of video", person: "One person’s taste" };

const day = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function LessonsView() {
  const [lessons, setLessons] = useState<InboxLesson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("open");
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await fetch("/api/lessons?all=1");
        const answer = (await response.json().catch(() => ({}))) as { lessons?: InboxLesson[]; error?: string };
        if (!response.ok) throw new Error(answer.error ?? `HTTP ${response.status}`);
        if (alive) setLessons(answer.lessons ?? []);
      } catch (failed) {
        if (alive) setError(failed instanceof Error ? failed.message : String(failed));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  const open = (lessons ?? []).filter((lesson) => lesson.status === "open").reverse();
  const closed = (lessons ?? []).filter((lesson) => lesson.status !== "open");
  const shown = view === "open" ? open : closed;
  return (
    <div className="flex flex-col gap-3 px-6 pb-6">
      <p className="text-[13px] leading-[1.5] text-muted">
        What the agents noted from the team’s feedback to teach every later edit. Each waits here for the next teaching round, which puts it in the house style and closes it.
      </p>
      <Tabs<View>
        id="lessons-view"
        value={view}
        onChange={setView}
        tabs={[
          { value: "open", label: lessons === null ? "Waiting" : `Waiting · ${open.length}` },
          { value: "closed", label: lessons === null ? "Taught" : `Taught or dropped · ${closed.length}` },
        ]}
      />
      <div className="flex h-[440px] flex-col gap-2 overflow-y-auto">
        {error !== null ? (
          <div className="px-1 py-2 text-[13px] text-danger">{error}</div>
        ) : lessons === null ? (
          <div className="px-1 py-2 text-[13px] text-faint">Reading the inbox…</div>
        ) : shown.length === 0 ? (
          <div className="px-1 py-2 text-[13px] text-faint">{view === "open" ? "Nothing waiting: every lesson noted so far has been taught." : "Nothing taught from the inbox yet."}</div>
        ) : (
          shown.map((lesson) => <LessonCard key={lesson.id} lesson={lesson} />)
        )}
      </div>
    </div>
  );
}

function LessonCard({ lesson }: { lesson: InboxLesson }) {
  const who = lesson.from ?? lesson.by?.name ?? "Someone";
  return (
    <article className="flex shrink-0 flex-col gap-1.5 rounded-[10px] border border-line bg-panel px-3.5 py-3">
      <p className="text-[13px] leading-[1.5] font-medium break-words">{lesson.lesson}</p>
      <blockquote className="border-l-2 border-line pl-2.5 text-[12px] leading-[1.5] break-words text-muted">“{lesson.quote}”</blockquote>
      <div className="flex min-w-0 items-center gap-2 text-[12px] whitespace-nowrap text-faint">
        <span className="flex min-w-0 shrink items-center gap-1.5">
          {lesson.from === null && lesson.by !== null && <StartedBy by={{ sub: lesson.by.sub, name: lesson.by.name, ...(lesson.by.picture === null ? {} : { picture: lesson.by.picture }) }} size={20} />}
          <span className="max-w-[200px] truncate">{who}</span>
        </span>
        <span>·</span>
        <span className="shrink-0">{day(lesson.at)}</span>
        {lesson.source !== null && lesson.source.name !== "" && (
          <>
            <span>·</span>
            <span className="min-w-0 truncate">{lesson.source.name}</span>
          </>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2 text-[12px] whitespace-nowrap text-faint">
        <span className="min-w-0 truncate">{lesson.part}</span>
        <span>·</span>
        <span className="shrink-0">{SCOPE[lesson.scope]}</span>
      </div>
      {lesson.status !== "open" && (
        <div className={cx("text-[12px] leading-[1.5] break-words", lesson.status === "taught" ? "text-fg/85" : "text-muted")}>
          <span className="font-medium">{lesson.status === "taught" ? "Taught" : "Dropped"}</span>
          {lesson.closedAt !== null && ` ${day(lesson.closedAt)}`}: {lesson.outcome}
        </div>
      )}
    </article>
  );
}
