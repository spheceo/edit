// Who answers, across Edit (Sphe, Nov 4): Opus builds a script, an edit or an
// idea's first package; once it's built, its revisions are Sonnet 5.5's, half
// Opus's price on the person's Claude plan. Thumbnails stay on Opus. The chats
// show the name of whichever answers next.

export interface ClaudeModel {
  /** What Claude Code is asked for. */
  id: string;
  /** What the chat shows. */
  name: string;
}

export const BUILD_MODEL: ClaudeModel = { id: "claude-opus-5-5", name: "Opus 5.5" };
export const REVISION_MODEL: ClaudeModel = { id: "claude-sonnet-5-5", name: "Sonnet 5.5" };

/** Opus to build it, Sonnet once it's built. */
export const modelFor = (built: boolean): ClaudeModel => (built ? REVISION_MODEL : BUILD_MODEL);

/** An idea is built once it has its titles. */
export const ideaModel = (idea: { titles: readonly unknown[] }): ClaudeModel => modelFor(idea.titles.length > 0);

/** A script is built once it has its cut-ins (the server refuses a revision before then). */
export const scriptModel = (script: { clips: readonly { kind?: string }[] } | null): ClaudeModel => modelFor(script !== null && script.clips.some((clip) => clip.kind === "cut-in"));
