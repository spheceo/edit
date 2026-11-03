import { useLayoutEffect, useRef } from "react";

import { drawFilmstrip, type Strip } from "../lib/filmstrip";

/**
 * The frames under a clip's name. The edit timeline paints the same strip
 * itself, on its one canvas; a script clip is its own element, so it uses this.
 * No strip yet and it draws nothing, leaving the clip's own colour.
 */
export function ClipPreview({ strip, sourceIn, sourceOut, width }: { strip: Strip | null; sourceIn: number; sourceOut: number; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas || !strip || width < 8) return;
    const ratio = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w < 2 || h < 2) return;
    canvas.width = Math.floor(w * ratio);
    canvas.height = Math.floor(h * ratio);
    const pen = canvas.getContext("2d");
    if (!pen) return;
    pen.setTransform(ratio, 0, 0, ratio, 0, 0);
    const span = Math.max(0, sourceOut - sourceIn);
    drawFilmstrip(pen, strip, { x: 0, y: 0, w, h, header: 0 }, (px) => sourceIn + (px / w) * span, 0, w);
  }, [strip, strip?.rev, sourceIn, sourceOut, width]);
  if (!strip || width < 8) return null;
  return <canvas ref={ref} className="pointer-events-none absolute inset-x-0 top-[17px] bottom-0 block h-auto w-full" aria-hidden />;
}
