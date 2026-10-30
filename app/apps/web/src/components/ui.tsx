import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

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

export function ColorField({ value, onChange, label }: { value: Rgba; onChange: (value: Rgba) => void; label?: string }) {
  return (
    <label className="relative flex h-6 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 hover:bg-hover">
      <span className="size-4 shrink-0 rounded-[5px] ring-1 ring-white/15" style={{ background: rgbaToHex(value) }} />
      <span className="font-mono text-[12px] text-muted uppercase">{label ?? rgbaToHex(value).slice(1)}</span>
      <input
        type="color"
        className="absolute inset-0 opacity-0"
        value={rgbaToHex(value)}
        onChange={(event) => onChange(hexToRgba(event.target.value, value[3]))}
      />
    </label>
  );
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  /** Overrides the look (by default a compact right-aligned value, as in the Inspector). */
  className?: string;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <button
      type="button"
      onClick={(event) =>
        toggleMenu(
          event.currentTarget,
          options.map((option) => ({ label: option.label, checked: option.value === value, onSelect: () => onChange(option.value) })),
          { width: 150 },
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
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);
  return (
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
    </AnimatePresence>
  );
}

export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
  id,
}: {
  value: T;
  tabs: { value: T; label: string }[];
  onChange: (value: T) => void;
  id: string;
}) {
  return (
    <div className="flex gap-1">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          onClick={() => onChange(tab.value)}
          className={cx(
            "relative h-7 rounded-md px-2.5 text-[12px] font-medium transition-colors",
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

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("animate-spin", className)} viewBox="0 0 24 24" fill="none" width="14" height="14">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
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
