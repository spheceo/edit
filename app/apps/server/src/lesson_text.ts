// The lessons inbox as text (`edit lessons`): grouped by the part of the
// work, oldest first, so a teaching round reads the same note given several
// times as one pattern.

import type { InboxLesson } from "@edit/types/lessons";

const day = (at: number): string => new Date(at).toISOString().slice(0, 10);

export function lessonsText(lessons: InboxLesson[]): string {
  if (lessons.length === 0) return "The lessons inbox is empty.";
  const parts = new Map<string, InboxLesson[]>();
  for (const lesson of lessons) parts.set(lesson.part, [...(parts.get(lesson.part) ?? []), lesson]);
  const out: string[] = [];
  for (const [part, group] of [...parts].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`## ${part} (${group.length})`);
    for (const lesson of group) {
      const who = lesson.from ?? lesson.by?.name ?? "someone";
      const where = [lesson.source?.name, lesson.style, lesson.scope].filter(Boolean).join(", ");
      out.push(`- [${lesson.id}] ${lesson.lesson}`);
      out.push(`  "${lesson.quote}" (${who}, ${day(lesson.at)}; ${where})`);
      if (lesson.status !== "open") out.push(`  ${lesson.status}${lesson.closedAt === null ? "" : ` ${day(lesson.closedAt)}`}: ${lesson.outcome ?? ""}`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}
