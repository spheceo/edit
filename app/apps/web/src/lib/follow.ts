// Pure timeline view maths with no live singletons, so it can be tested
// without the preview engine or a window.

/** The scroll that puts `midY` (a content-space y) in the middle of a viewport `viewport` tall. */
export function centredScrollY(midY: number, viewport: number, content: number) {
  return Math.min(Math.max(0, content - viewport), Math.max(0, midY - viewport / 2));
}

/**
 * Whether the lanes follow the playhead, and whether to page to it now.
 * Following pages only when the playhead runs off the right (or is far off
 * the left). A person scrolling away while it plays is left alone (`free`)
 * until the playhead walks back into their view, or they pause and play
 * again, which picks the follow back up at the playhead.
 */
export function nextFollow(input: { playing: boolean; justStarted: boolean; following: boolean; x: number; width: number }): { following: boolean; page: boolean } {
  if (!input.playing) return { following: input.following, page: false };
  const inView = input.x >= 0 && input.x <= input.width;
  if (input.justStarted && !inView) return { following: true, page: true };
  if (!input.following) return inView ? { following: true, page: false } : { following: false, page: false };
  return { following: true, page: input.x > input.width - 40 || input.x < -40 };
}
