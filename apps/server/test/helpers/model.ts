// Projects for the editing tools' tests, built as edit-core builds them
// (`Project::new`, `serde_json::from_value::<Clip>`), on a fresh native stub.

import { clipFrom } from "../../src/clips.ts";
import type { Clip, Media, Project } from "../../src/model.ts";
import { useNative, wrap } from "../../src/native/index.ts";
import { createStub } from "../../src/native/stub.ts";
import { clipOf, newProject } from "../../src/project.ts";

/** Puts a fresh stub addon in place (no home: nothing on disk). */
export function stubNative(): void {
  useNative(wrap(createStub()));
}

/** `Project::new("p", name, 1920×1080 at 30)`: three video tracks, two audio. */
export function project(name = "t", settings = { width: 1920, height: 1080, fps: 30 }): Project {
  return newProject("p", name, settings);
}

/** A media item from JSON, with serde's defaults. */
export function media(fields: Partial<Media> & Pick<Media, "id" | "name" | "path" | "kind" | "duration">): Media {
  return { width: 0, height: 0, fps: 0, has_audio: false, ...fields } as Media;
}

/** A clip from JSON, as serde reads it. */
export function clip(fields: Record<string, unknown>): Clip {
  return clipFrom(fields);
}

export function clipNamed(project: Project, name: string): Clip {
  const found = project.clips.find((own) => own.name === name);
  if (found === undefined) throw new Error(`no clip named ${name}`);
  return found;
}

export function clipById(project: Project, id: string): Clip {
  const found = clipOf(project, id);
  if (found === undefined) throw new Error(`no clip ${id}`);
  return found;
}

export function level(project: Project, track: string): number {
  return project.tracks.findIndex((own) => own.id === track);
}
