import { ChevronDown, Minus, Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";

import { hexToRgba, rgbaToHex } from "../lib/colors";
import type { Rgba } from "../lib/types";
import { toggleMenu } from "./ContextMenu";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
export { cx };

// The kit's motion (design/kit: 180 ms, ease cubic-bezier(.2,0,0,1)): nothing bounces.
export const spring = { duration: 0.18, ease: [0.2, 0, 0, 1] } as const;

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** primary: the one main action (red); light: a main action in white (Home's New project); subtle: secondary (an edge); ghost: none; danger: destructive among others (tinted); destructive: a dialog’s final destructive answer (solid red). */
  variant?: "primary" | "light" | "ghost" | "subtle" | "danger" | "destructive";
  size?: "sm" | "md" | "lg";
};

// The spheceo kit’s buttons (design/kit/components.css .sp-btn).
export function Button({ variant = "subtle", size = "md", className, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 border font-medium whitespace-nowrap transition-[background,border-color,color,opacity] duration-[120ms] ease-[cubic-bezier(.2,0,0,1)] disabled:pointer-events-none disabled:opacity-45",
        size === "sm" ? "h-7 rounded-md px-2.5 text-[12px]" : size === "lg" ? "h-10 rounded-lg px-4 text-[14px]" : "h-[34px] rounded-lg px-3.5 text-[13px]",
        variant === "primary" && "border-primary bg-primary text-white hover:border-primary-hover hover:bg-primary-hover",
        variant === "light" && "border-fg bg-fg font-semibold text-bg hover:border-white hover:bg-white",
        variant === "subtle" && "border-line-strong bg-transparent text-fg hover:bg-hover",
        variant === "ghost" && "border-transparent text-secondary hover:bg-hover hover:text-fg",
        variant === "danger" && "border-[#ff003373] bg-danger-soft text-danger hover:bg-[#ff003338]",
        variant === "destructive" && "border-danger-solid bg-danger-solid text-white hover:border-primary-hover hover:bg-primary-hover",
        className,
      )}
    />
  );
}

export function IconButton({
  active,
  className,
  label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; label: string }) {
  return (
    <button
      {...props}
      title={label}
      aria-label={label}
      className={cx(
        "inline-flex size-7 items-center justify-center rounded-md transition-[background,color,transform] duration-150 active:scale-90 disabled:opacity-30",
        active ? "bg-active text-fg" : "text-muted hover:bg-hover hover:text-fg",
        className,
      )}
    />
  );
}

/** Number field you can drag horizontally to scrub, Premiere-style. Click to type. */
export function Scrub({
  value,
  onChange,
  onStart,
  onEnd,
  step = 1,
  min = -Infinity,
  max = Infinity,
  precision = 0,
  suffix,
  className,
}: {
  value: number;
  onChange: (value: number) => void;
  onStart?: () => void;
  onEnd?: () => void;
  step?: number;
  min?: number;
  max?: number;
  precision?: number;
  suffix?: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const drag = useRef<{ x: number; value: number; moved: boolean } | null>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const shown = Number.isFinite(value) ? value.toFixed(precision) : "–";

  if (editing) {
    return (
      <input
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          const parsed = Number.parseFloat(text);
          if (Number.isFinite(parsed)) {
            onStart?.();
            onChange(clamp(parsed));
            onEnd?.();
          }
          setEditing(false);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          if (event.key === "Escape") setEditing(false);
        }}
        className={cx("h-6 w-full rounded-md bg-active px-1.5 text-right font-mono text-[12px] text-fg outline-none tabular", className)}
      />
    );
  }
  return (
    <div
      role="spinbutton"
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={(event) => {
        (event.target as HTMLElement).setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, value, moved: false };
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        if (!state) return;
        const dx = event.clientX - state.x;
        if (!state.moved && Math.abs(dx) < 3) return;
        if (!state.moved) {
          state.moved = true;
          onStart?.();
        }
        const factor = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
        onChange(clamp(Number((state.value + dx * step * factor).toFixed(Math.max(precision, 3)))));
      }}
      onPointerUp={() => {
        const state = drag.current;
        drag.current = null;
        if (state?.moved) onEnd?.();
        else {
          setText(shown);
          setEditing(true);
        }
      }}
      onPointerCancel={() => {
        const state = drag.current;
        drag.current = null;
        if (state?.moved) onEnd?.();
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          event.stopPropagation();
          onStart?.();
          onChange(clamp(value + (event.key === "ArrowUp" ? 1 : -1) * step * (event.shiftKey ? 10 : 1)));
          onEnd?.();
        }
      }}
      className={cx(
        "flex h-6 w-full cursor-ew-resize items-center justify-end rounded-md px-1.5 font-mono text-[12px] text-fg tabular transition-colors hover:bg-hover",
        className,
      )}
    >
      {shown}
      {suffix && <span className="ml-0.5 text-faint">{suffix}</span>}
    </div>
  );
}

/** A colour swatch and its hex, opening the system picker. Takes an Rgba (the timeline's) or a "#rrggbb" string (a thumbnail's) and answers in the same shape. */
export function ColorField<T extends Rgba | string>({ value, onChange, label }: { value: T; onChange: (value: T) => void; label?: string }) {
  const hex = typeof value === "string" ? (/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000") : rgbaToHex(value);
  return (
    <label className="relative flex h-6 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 hover:bg-hover">
      <span className="size-4 shrink-0 rounded-[5px] ring-1 ring-white/15" style={{ background: hex }} />
      <span className="font-mono text-[12px] text-muted uppercase">{label ?? hex.slice(1)}</span>
      <input
        type="color"
        className="absolute inset-0 opacity-0"
        value={hex}
        onChange={(event) => onChange((typeof value === "string" ? event.target.value : hexToRgba(event.target.value, value[3])) as T)}
      />
    </label>
  );
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  className,
  menuWidth,
}: {
  value: T;
  /** `disabled`: shown, not pickable; `hint`: muted words after its label ("Soon"). */
  options: { value: T; label: string; disabled?: boolean; hint?: string }[];
  onChange: (value: T) => void;
  /** Overrides the look (by default a compact right-aligned value, as in the Inspector). */
  className?: string;
  /** The menu's width. Long labels (a font's name) need more than the default. */
  menuWidth?: number;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <button
      type="button"
      onClick={(event) =>
        toggleMenu(
          event.currentTarget,
          options.map((option) => ({ label: option.label, checked: option.value === value, ...(option.disabled ? { disabled: true } : {}), ...(option.hint ? { hint: option.hint } : {}), onSelect: () => onChange(option.value) })),
          { width: menuWidth ?? 150 },
        )
      }
      className={cx(
        "flex min-w-0 items-center gap-1 rounded-md text-fg transition-colors",
        className ?? "h-6 w-full justify-end px-1.5 text-[12px] hover:bg-hover",
      )}
    >
      <span className="truncate">{current?.label ?? String(value)}</span>
      <ChevronDown size={12} className="shrink-0 text-faint" />
    </button>
  );
}

export function Switch({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      // The kit's switch (.sp-switch): on is white with a dark thumb.
      className={cx("relative h-[18px] w-[30px] rounded-full border transition-colors duration-[120ms]", checked ? "border-fg bg-fg" : "border-line-strong bg-active")}
    >
      <motion.span
        layout
        transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
        className={cx("absolute top-[2px] size-3 rounded-full", checked ? "right-[2px] bg-bg" : "left-[2px] bg-muted")}
      />
    </button>
  );
}

/** Open dialogs, oldest first. Escape closes the latest one, so a picker over Share doesn't close Share. */
const openModals: { close: () => void }[] = [];

function onEscape(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  const top = openModals[openModals.length - 1];
  if (!top) return;
  event.stopPropagation();
  top.close();
}

export function Modal({
  open,
  onClose,
  children,
  width = 440,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const entry = { close: () => onCloseRef.current() };
    openModals.push(entry);
    if (openModals.length === 1) window.addEventListener("keydown", onEscape, true);
    return () => {
      const at = openModals.indexOf(entry);
      if (at !== -1) openModals.splice(at, 1);
      if (openModals.length === 0) window.removeEventListener("keydown", onEscape, true);
    };
  }, [open]);
  // On the page's body, so nothing it's written inside (a hidden, inert sidebar; a clipped row) can hide it or stop its clicks.
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-[4px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
          onPointerDown={(event) => event.target === event.currentTarget && onClose()}
        >
          {/* The kit’s dialog: 14 px corners, a fade and a 4 px rise, nothing bouncing. */}
          <motion.div
            role="dialog"
            className="overflow-hidden rounded-[14px] border border-line-strong bg-panel text-[14px] shadow-[0_24px_64px_#000a]"
            style={{ width }}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/**
 * One of a few, the chosen one's highlight sliding to it. `framed` draws it as
 * the kit's segmented control (.sp-seg): a bordered track, for a choice inside
 * a form; bare, it's a panel's tabs.
 */
export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
  id,
  framed,
  label,
}: {
  value: T;
  tabs: { value: T; label: string }[];
  onChange: (value: T) => void;
  id: string;
  framed?: boolean;
  /** What the choice is, read out. */
  label?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cx("flex", framed ? "h-[30px] gap-0.5 rounded-[9px] border border-line bg-panel p-0.5" : "gap-1")}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="radio"
          aria-checked={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={cx(
            "relative rounded-md px-2.5 text-[12px] font-medium transition-colors",
            framed ? "h-full" : "h-7",
            value === tab.value ? "text-fg" : "text-muted hover:text-fg",
          )}
        >
          {value === tab.value && (
            <motion.span layoutId={`tab-${id}`} transition={spring} className="absolute inset-0 rounded-md bg-active" />
          )}
          <span className="relative">{tab.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Something on its way, in a line or a button: Edit's loader at a small size (the user, Oct 30: "i like the spinner we have lets use that more"). */
export function Spinner({ className, size = 14 }: { className?: string; size?: number }) {
  return (
    <svg className={cx("edit-loader shrink-0 overflow-visible", className)} viewBox="0 0 64 64" width={size} height={size} aria-hidden>
      <rect className="loader-clip" x="8" y="16" width="46" height="9.5" rx="3" fill="#5b8cff" />
      <rect className="loader-clip loader-clip-2" x="8" y="29" width="30" height="9.5" rx="3" fill="#ff4f9a" />
      <rect className="loader-clip loader-clip-3" x="8" y="42" width="46" height="9.5" rx="3" fill="#ffc23d" />
      <g className="loader-head">
        <path d="M41.5 8h7a.5.5 0 0 1 .5.5v3.4a1 1 0 0 1-.3.7L46 15.4V55a1 1 0 0 1-2 0V15.4l-2.7-2.8a1 1 0 0 1-.3-.7V8.5a.5.5 0 0 1 .5-.5z" fill="#fff" />
      </g>
    </svg>
  );
}

export function ProgressRing({ value, size = 16 }: { value: number; size?: number }) {
  const r = size / 2 - 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} stroke="white" strokeOpacity="0.15" strokeWidth="2" fill="none" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke="white"
        strokeWidth="2"
        fill="none"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(1, Math.max(0, value)))}
        strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 250ms ease-out" }}
      />
    </svg>
  );
}

// ---------------------------------------------------------------- fields and sections

/**
 * A setting's row: its label and its control. `stacked` puts the label over a
 * wide control (a dialog's name or note); `wide` gives the control the rest of
 * a roomy panel (a dialog's sliders); otherwise the control sits right in a
 * fixed column, with a keyframe slot beside it when `keyframe` is given (the
 * Inspector).
 */
export function Field({ label, children, keyframe, wide, stacked, className }: { label: ReactNode; children: ReactNode; keyframe?: ReactNode; wide?: boolean; stacked?: boolean; className?: string }) {
  if (stacked)
    return (
      <label className={cx("flex flex-col gap-1.5 text-[12px] text-muted", className)}>
        {label}
        {children}
      </label>
    );
  if (wide)
    return (
      <div className={cx("grid min-h-8 grid-cols-[88px_minmax(0,1fr)] items-center gap-3 text-[12px]", className)}>
        <span className="truncate text-muted">{label}</span>
        <div className="flex min-w-0 items-center">{children}</div>
      </div>
    );
  return (
    <div className={cx("grid h-7 grid-cols-[1fr_16px_112px] items-center gap-1.5", className)}>
      <span className="truncate text-muted">{label}</span>
      <span className="flex justify-center">{keyframe}</span>
      <div className="flex justify-end">{children}</div>
    </div>
  );
}

/**
 * A titled group of fields, divided from the next. `toggle` puts a switch in
 * its title for something that can be off (a drop shadow) and hides the
 * fields while it is; `roomy` is a dialog's padding.
 */
export function Section({ title, aside, toggle, roomy, children }: { title: string; aside?: ReactNode; toggle?: { on: boolean; onChange: (on: boolean) => void }; roomy?: boolean; children?: ReactNode }) {
  const open = toggle === undefined || toggle.on;
  return (
    <div className={cx("border-b border-line last:border-b-0", roomy ? "px-4 py-3" : "px-3 py-2.5")}>
      <div className={cx("flex items-center justify-between gap-2", roomy ? "h-6" : "h-5")}>
        <span className="text-[12px] font-medium text-muted">{title}</span>
        {toggle !== undefined ? <Switch checked={toggle.on} onChange={toggle.onChange} /> : aside}
      </div>
      {open && children !== undefined && children !== null && children !== false && <div className={cx("flex flex-col", roomy ? "mt-1.5 gap-1" : "mt-1.5 gap-0.5")}>{children}</div>}
    </div>
  );
}

/** A card with a small titled head: a side panel's group (a thumbnail's layers, its pictures). */
export function Panel({ title, icon, action, children, className }: { title: string; icon?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-xl border border-line bg-panel", className)}>
      <div className="flex h-9 items-center gap-1.5 pr-1.5 pl-2.5 text-[12px] font-medium text-secondary">
        {icon && <span className="text-faint">{icon}</span>}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {action}
      </div>
      <div className="px-1.5 pb-1.5">{children}</div>
    </section>
  );
}

const textBox = "w-full rounded-md border border-line bg-bg px-2 text-[13px] text-fg outline-none transition-colors placeholder:text-faint focus:border-line-strong";

export function TextField({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx("h-8", textBox, className)} />;
}

export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx("resize-none py-1.5 leading-normal", textBox, className)} />;
}

/** A small word beside something: its state ("Final"), where it's from ("OpenArt"). `over` is for one sitting on a picture. */
export function Badge({ tone = "neutral", children, title, className }: { tone?: "neutral" | "success" | "over"; children: ReactNode; title?: string; className?: string }) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex h-[18px] shrink-0 items-center rounded-full px-1.5 text-[10.5px] leading-none font-medium whitespace-nowrap",
        tone === "neutral" && "border border-line text-muted",
        tone === "success" && "bg-success-soft text-success",
        tone === "over" && "bg-black/70 text-white/85 backdrop-blur-[2px]",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** One of a row of rounded choices (a thumbnail's versions); `active` is the one shown. */
export function Chip({ active, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium transition-colors",
        active ? "border-line-strong bg-active text-fg" : "border-line text-muted hover:bg-hover hover:text-fg",
        className,
      )}
    />
  );
}

/**
 * A number on a bar that fills as it grows (Camera Raw's controls, the way the
 * team's other tools draw them; Sphe, Nov 3). A range through zero fills from
 * the middle. Drag along it to change it (Alt for fine steps), click to type,
 * double-click to put it back; `steppers` adds − and + at its sides.
 */
export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  precision = 0,
  suffix,
  reset,
  steppers,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  precision?: number;
  suffix?: string;
  /** What a double-click puts back: zero for a range through it, else the least. */
  reset?: number;
  steppers?: boolean;
  /** Read out for the bar and its buttons. */
  label: string;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const drag = useRef<{ x: number; width: number; value: number; moved: boolean } | null>(null);
  // A click types only once it's clear it isn't the first of a double-click (which resets).
  const typeSoon = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(typeSoon.current ?? undefined), []);
  const origin = min < 0 && max > 0 ? 0 : min;
  const settle = (next: number) => Math.min(max, Math.max(min, Number((Math.round(next / step) * step).toFixed(precision))));
  const at = (v: number) => (max > min ? ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100 : 0);
  const shown = Number.isFinite(value) ? value.toFixed(precision) : "–";
  const nudge = step < 1 ? step * 5 : step;
  const from = Math.min(at(origin), at(value));
  const to = Math.max(at(origin), at(value));

  const bar = editing ? (
    <input
      autoFocus
      value={text}
      aria-label={label}
      onChange={(event) => setText(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => {
        const parsed = Number.parseFloat(text);
        if (Number.isFinite(parsed)) onChange(settle(parsed));
        setEditing(false);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") setEditing(false);
      }}
      className="h-7 min-w-0 flex-1 rounded-md bg-active px-2 text-center font-mono text-[12px] text-fg tabular outline-none"
    />
  ) : (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width: event.currentTarget.clientWidth, value, moved: false };
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        if (state === null) return;
        const dx = event.clientX - state.x;
        if (!state.moved && Math.abs(dx) < 3) return;
        state.moved = true;
        onChange(settle(state.value + (dx / state.width) * (max - min) * (event.altKey ? 0.1 : 1)));
      }}
      onPointerUp={() => {
        const state = drag.current;
        drag.current = null;
        if (state === null || state.moved) return;
        clearTimeout(typeSoon.current ?? undefined);
        typeSoon.current = setTimeout(() => {
          setText(shown);
          setEditing(true);
        }, 250);
      }}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={() => {
        clearTimeout(typeSoon.current ?? undefined);
        onChange(reset ?? origin);
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        event.stopPropagation();
        const up = event.key === "ArrowRight" || event.key === "ArrowUp";
        onChange(settle(value + (up ? 1 : -1) * nudge * (event.shiftKey ? 10 : 1)));
      }}
      className="relative h-7 min-w-0 flex-1 cursor-ew-resize overflow-hidden rounded-md bg-white/[0.05] transition-colors outline-none hover:bg-white/[0.07] focus-visible:ring-1 focus-visible:ring-line-strong"
    >
      <span className="absolute inset-y-0 bg-white/[0.11]" style={{ left: `${from}%`, width: `${to - from}%` }} />
      {origin !== min && (
        <>
          <span className="absolute top-0 h-1.5 w-px bg-white/25" style={{ left: `${at(origin)}%` }} />
          <span className="absolute bottom-0 h-1.5 w-px bg-white/25" style={{ left: `${at(origin)}%` }} />
        </>
      )}
      <span className="relative flex h-full items-center justify-center font-mono text-[12px] text-fg tabular">
        {shown}
        {suffix && <span className="ml-0.5 text-faint">{suffix}</span>}
      </span>
    </div>
  );
  if (!steppers) return bar;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      <IconButton label={`${label} down`} onClick={() => onChange(settle(value - nudge))} className="size-7 shrink-0">
        <Minus size={12} />
      </IconButton>
      {bar}
      <IconButton label={`${label} up`} onClick={() => onChange(settle(value + nudge))} className="size-7 shrink-0">
        <Plus size={12} />
      </IconButton>
    </div>
  );
}

// ---------------------------------------------------------------- dialogs' parts

/** A dialog's title and the line under it, as every dialog in Edit has them. */
export function DialogTitle({ title, detail }: { title: ReactNode; detail?: ReactNode }) {
  return (
    <>
      <h2 className="text-[18px] font-semibold tracking-[-0.3px]">{title}</h2>
      {detail && <div className="mt-1 text-[13px] leading-relaxed text-muted">{detail}</div>}
    </>
  );
}

/** A dialog's answers, right-aligned under what it says. */
export function DialogActions({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("mt-[22px] flex items-center justify-end gap-2", className)}>{children}</div>;
}

/** "Delete this?": a question, what it means, Cancel and the answer. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  detail,
  confirm,
  busy,
  tone = "destructive",
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  detail?: ReactNode;
  /** The answer's words ("Delete", "Dismiss"). */
  confirm: string;
  busy?: boolean;
  tone?: "destructive" | "primary" | "light";
  /** Anything between the words and the answers (a choice, a list). */
  children?: ReactNode;
}) {
  return (
    <Modal open={open} onClose={onClose} width={380}>
      <div className="p-6">
        <DialogTitle title={title} detail={detail} />
        {children}
        <DialogActions>
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={tone} disabled={busy} onClick={onConfirm}>
            {busy && <Spinner size={13} />}
            {confirm}
          </Button>
        </DialogActions>
      </div>
    </Modal>
  );
}
