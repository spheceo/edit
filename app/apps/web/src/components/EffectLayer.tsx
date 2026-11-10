import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { effectAddress, effectsAt, showings, useEffects } from "../lib/effects";
import { pictureRect } from "../lib/note-shapes";
import { playhead } from "../lib/playback";
import { useEditor } from "../lib/store";
import { rate } from "../lib/types";

/**
 * Coded effects played live over the picture (Edit V2; lib/effects.ts). Each
 * effect near the playhead is its page in a frame of the video's own size,
 * scaled to the picture, shut in (no origin of its own: the server sends the
 * rest of its walls) and told the playhead's moment whenever it moves; the one
 * the playhead is on is shown once it has said it's ready, over the still the
 * engine draws for it. Nothing is rendered, so a page the agent has just saved
 * plays at once, and a scrub is as quick as the page draws. A page saved again
 * is loaded beside the one showing, which stays up until the new one is ready.
 */
export function EffectLayer({ wrap }: { wrap: HTMLDivElement | null }) {
  const project = useEditor((state) => state.project);
  const effects = useEffects((state) => state.effects);
  const shown = useMemo(() => (project ? showings(project) : []), [project]);
  const fps = project ? rate(project.settings) : 30;
  /** The frames by `name:changed`, and the pages that have said they're ready. */
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const ready = useRef(new WeakSet<Window>());
  /** Each effect's page last seen ready, kept up while a newer one loads. */
  const [last, setLast] = useState<Record<string, number>>({});
  const [size, setSize] = useState({ width: 0, height: 0 });
  // Which pages to have loaded and which to show: these change at a clip's edge, not every frame.
  const key = useSyncExternalStore(playhead.subscribe, () => {
    if (shown.length === 0) return "|";
    const { playing, near } = effectsAt(shown, fps, playhead.frame);
    return `${playing?.name ?? ""}|${near.join(",")}`;
  });
  useEffect(() => {
    if (wrap === null) return;
    const observer = new ResizeObserver(() => setSize({ width: wrap.clientWidth, height: wrap.clientHeight }));
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [wrap]);

  // The playhead's moment to the page it's on, once a frame at most; and to a page the moment it's ready.
  useEffect(() => {
    if (shown.length === 0) return;
    let queued = 0;
    const tell = () => {
      queued = 0;
      const { playing } = effectsAt(shown, fps, playhead.frame);
      // The newest of its pages that's ready.
      let best: { frame: HTMLIFrameElement; changed: number } | null = null;
      for (const [id, frame] of frames.current) {
        const [name, changed] = [id.slice(0, id.lastIndexOf(":")), Number(id.slice(id.lastIndexOf(":") + 1))];
        const page = frame.contentWindow;
        if (playing?.name !== name || page === null || !ready.current.has(page)) continue;
        if (best === null || changed > best.changed) best = { frame, changed };
      }
      for (const frame of frames.current.values()) frame.style.visibility = frame === best?.frame ? "visible" : "hidden";
      if (best !== null && playing !== null) best.frame.contentWindow?.postMessage({ edit: { seek: playing.seconds } }, "*");
    };
    const soon = () => {
      if (queued === 0) queued = requestAnimationFrame(tell);
    };
    const heard = (event: MessageEvent) => {
      const said = (event.data as { edit?: { ready?: boolean } } | null)?.edit;
      if (said?.ready !== true || event.source === null) return;
      for (const [id, frame] of frames.current) {
        const page = frame.contentWindow;
        if (page === null || page !== event.source) continue;
        ready.current.add(page);
        const [name, changed] = [id.slice(0, id.lastIndexOf(":")), Number(id.slice(id.lastIndexOf(":") + 1))];
        setLast((before) => ((before[name] ?? 0) >= changed ? before : { ...before, [name]: changed }));
        soon();
      }
    };
    window.addEventListener("message", heard);
    const stop = playhead.subscribe(soon);
    soon();
    return () => {
      window.removeEventListener("message", heard);
      stop();
      if (queued !== 0) cancelAnimationFrame(queued);
    };
  }, [shown, fps, effects, key, last]);

  if (!project || size.width === 0 || key === "|") return null;
  const near = key.slice(key.indexOf("|") + 1).split(",");
  const rect = pictureRect(size.width, size.height, project.settings.width, project.settings.height);
  const pages: { name: string; changed: number; page: string }[] = [];
  for (const effect of effects) {
    if (!near.includes(effect.name)) continue;
    const before = last[effect.name];
    if (before !== undefined && before < effect.changed) pages.push({ ...effect, changed: before });
    pages.push(effect);
  }
  return (
    <>
      {pages.map((page) => {
        const id = `${page.name}:${page.changed}`;
        return (
          <iframe
            key={id}
            ref={(element) => {
              if (element === null) {
                frames.current.delete(id);
              } else if (frames.current.get(id) !== element) {
                // Hidden until it's ready and the playhead is on it (set by hand from there on: a render never hides one that's showing).
                if (element.dataset.placed === undefined) element.style.visibility = "hidden";
                element.dataset.placed = "";
                frames.current.set(id, element);
              }
            }}
            title={page.name}
            src={effectAddress(page)}
            sandbox="allow-scripts"
            className="pointer-events-none absolute origin-top-left border-0"
            style={{ left: rect.left, top: rect.top, width: project.settings.width, height: project.settings.height, transform: `scale(${rect.width / project.settings.width})` }}
          />
        );
      })}
    </>
  );
}
