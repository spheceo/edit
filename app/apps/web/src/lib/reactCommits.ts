// What React drew lately: the components each recent commit rendered, so the
// watchdog's "the page was stuck" line can say which part of the page was
// drawing (Nov 8: 730 of Sphe's 732 stalls said only "no store changing").
// React tells a devtools hook about every commit, in production too; this is
// that hook, kept tiny, and it hands on to the real devtools when they're there.
// Imported before React (main.tsx's first import), as React looks for the
// hook once, when it loads.

export interface Commit {
  at: number;
  /** Components that rendered, the most often first, each with how many of it. */
  names: string[];
  /** How many components rendered. */
  count: number;
}

interface Fiber {
  type: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
  flags: number;
  subtreeFlags: number;
}

/** React's flag for a fiber that rendered in this commit (ReactFiberFlags PerformedWork). */
const PERFORMED_WORK = 1;
/** A commit's walk stops here: a stall report needs names, not a census. */
const MOST = 5_000;
const KEEP = 20;

const recent: Commit[] = [];

function nameOf(type: unknown): string | null {
  if (typeof type === "function") return (type as { displayName?: string }).displayName || type.name || null;
  if (type !== null && typeof type === "object") {
    const inner = type as { displayName?: string; type?: unknown; render?: unknown };
    return inner.displayName ?? nameOf(inner.type) ?? nameOf(inner.render);
  }
  return null;
}

/** The components a commit rendered, read from its tree: only where something below rendered is walked. */
export function rendered(root: Fiber): Omit<Commit, "at"> {
  const counts = new Map<string, number>();
  let count = 0;
  let seen = 0;
  const stack: Fiber[] = [];
  if (root.subtreeFlags & PERFORMED_WORK && root.child) stack.push(root.child);
  while (stack.length > 0 && seen < MOST) {
    let fiber: Fiber | null = stack.pop()!;
    // Siblings in a row, children on the stack.
    while (fiber !== null && seen++ < MOST) {
      if (fiber.flags & PERFORMED_WORK) {
        const name = nameOf(fiber.type);
        if (name !== null) {
          count++;
          counts.set(name, (counts.get(name) ?? 0) + 1);
        }
      }
      if (fiber.subtreeFlags & PERFORMED_WORK && fiber.child) stack.push(fiber.child);
      fiber = fiber.sibling;
    }
  }
  const names = [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, times]) => (times > 1 ? `${name} ×${times}` : name));
  return { names, count };
}

function noteCommit(root: { current?: Fiber } | undefined) {
  if (!root?.current) return;
  const commit = rendered(root.current);
  if (commit.count === 0) return;
  recent.push({ at: performance.now(), ...commit });
  if (recent.length > KEEP) recent.shift();
}

/** The last commits, oldest first. */
export const lastCommits = (): readonly Commit[] => recent;

type Hook = { onCommitFiberRoot?: (id: unknown, root: { current?: Fiber }, ...rest: unknown[]) => unknown; [key: string]: unknown };
const scope = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: Hook };
const existing = scope.__REACT_DEVTOOLS_GLOBAL_HOOK__;
if (existing) {
  const theirs = existing.onCommitFiberRoot;
  existing.onCommitFiberRoot = function (this: unknown, id, root, ...rest) {
    noteCommit(root);
    return theirs?.call(this, id, root, ...rest);
  };
} else {
  scope.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    onCommitFiberRoot: (_id, root) => noteCommit(root),
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    checkDCE: () => {},
  };
}
