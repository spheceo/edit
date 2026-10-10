import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

import { hexToRgba, rgbaToHex } from "../lib/colors";
import type { Rgba } from "../lib/types";
import { toggleMenu } from "./ContextMenu";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
export { cx };

export const spring = { type: "spring", stiffness: 520, damping: 42, mass: 0.8 } as const;

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "subtle" | "danger";
  size?: "sm" | "md";
};

export function Button({ variant = "subtle", size = "md", className, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-[background,color,opacity,transform] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-8 px-3 text-[13px]",
        variant === "primary" && "bg-white text-black hover:bg-white/90",
        variant === "subtle" && "bg-raised text-fg hover:bg-hover",
        variant === "ghost" && "text-muted hover:bg-hover hover:text-fg",
        variant === "danger" && "bg-red-500/15 text-red-300 hover:bg-red-500/25",
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

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong px-1 font-mono text-[10px] text-muted">{children}</kbd>;
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
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
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
      className="flex h-6 w-full min-w-0 items-center justify-end gap-1 rounded-md px-1.5 text-[12px] text-fg transition-colors hover:bg-hover"
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
      className={cx("relative h-[18px] w-8 rounded-full transition-colors duration-200", checked ? "bg-white" : "bg-active")}
    >
      <motion.span
        layout
        transition={spring}
        className={cx("absolute top-[3px] size-3 rounded-full", checked ? "right-[3px] bg-black" : "left-[3px] bg-muted")}
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onPointerDown={(event) => event.target === event.currentTarget && onClose()}
        >
          <motion.div
            role="dialog"
            className="overflow-hidden rounded-2xl border border-line-strong bg-panel shadow-[0_24px_80px_rgba(0,0,0,0.8)]"
            style={{ width }}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 4 }}
            transition={spring}
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
