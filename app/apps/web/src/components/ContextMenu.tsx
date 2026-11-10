import { Check, ChevronRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";

import { CLIP_HEX } from "../lib/colors";
import { CLIP_COLORS, type ClipColor } from "../lib/types";
import { StartedBy } from "./StartedBy";
import { cx } from "./ui";

export type MenuItem =
  | {
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect?: () => void;
      submenu?: MenuItem[];
      /** A tick on the right: the current choice in a picker. */
      checked?: boolean;
      /** Muted text after the label (e.g. "Default"). */
      hint?: string;
      /** Muted text at the item's right end (a date). */
      detail?: string;
    }
  | { separator: true }
  | { heading: string }
  /** Who’s signed in, at the top of the account menu: their photo, name and email. */
  | { person: { name: string; email: string; picture: string | null } }
  | { swatches: true; value?: ClipColor; onSelect: (color: ClipColor) => void }
  /**
   * A level set by dragging, in the menu itself (`slider` is its name: a
   * clip's volume). The menu stays open, so it can be heard and set again;
   * `onStart` and `onEnd` are the drag's ends, one undo step between them.
   */
  | {
      slider: string;
      icon?: ReactNode;
      value: number;
      min: number;
      max: number;
      step: number;
      format: (value: number) => string;
      onStart: () => void;
      onChange: (value: number) => void;
      onEnd: () => void;
    };

interface MenuState {
  menu: { x: number; y: number; items: MenuItem[]; key: number; width?: number; owner?: Element } | null;
}

const useMenu = create<MenuState>(() => ({ menu: null }));
let key = 0;

/** Opens a context menu at the pointer. Call from an onContextMenu handler. */
export function openMenu(
  event: { clientX: number; clientY: number; preventDefault(): void },
  items: MenuItem[],
  options: { width?: number; owner?: Element } = {},
) {
  event.preventDefault();
  useMenu.setState({ menu: { x: event.clientX, y: event.clientY, items, key: ++key, width: options.width, owner: options.owner } });
}

/** The button whose menu a press just closed: its click should not reopen it. */
let closedFrom: Element | null = null;

/** Opens a dropdown under `button` (or at `at`), or closes it if this button’s menu is open. */
export function toggleMenu(button: Element, items: MenuItem[], options: { width?: number; at?: { x: number; y: number } } = {}) {
  if (closedFrom === button) {
    closedFrom = null;
    return;
  }
  const box = button.getBoundingClientRect();
  const width = options.at ? (options.width ?? box.width) : Math.max(options.width ?? 0, box.width);
  // By default right-aligned with the button, which sits at the end of its row.
  const at = options.at ?? { x: box.right - width, y: box.bottom + 4 };
  openMenu({ clientX: at.x, clientY: at.y, preventDefault: () => {} }, items, { width, owner: button });
}

const closeMenu = () => useMenu.setState({ menu: null });

const isAction = (item: MenuItem): item is Extract<MenuItem, { label: string }> => "label" in item;

/** Mount once near the root. */
export function ContextMenuHost() {
  const menu = useMenu((state) => state.menu);
  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      const target = event.target as Element | null;
      // A press or a scroll in the menu is the menu's.
      if ((event.type === "pointerdown" || event.type === "wheel") && target?.closest?.("[data-menu]")) return;
      closedFrom = event.type === "pointerdown" && menu.owner && target && menu.owner.contains(target) ? menu.owner : null;
      closeMenu();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("wheel", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);
  // What opened the menu says so while it's open (data-menu-open), so a button
  // shown on hover stays, with its row, while the pointer is in its menu.
  useEffect(() => {
    const owner = menu?.owner;
    if (!owner) return;
    owner.setAttribute("data-menu-open", "");
    return () => owner.removeAttribute("data-menu-open");
  }, [menu]);
  return (
    <AnimatePresence>
      {menu && <Panel key={menu.key} x={menu.x} y={menu.y} items={menu.items} width={menu.width} root />}
    </AnimatePresence>
  );
}

/** How near its knob (px) a press takes hold of it where it is; further off, the knob comes to the press. */
const KNOB_REACH = 9;

/** A menu row with a level to drag: its name, the track, what it's at. */
function SliderRow({ item, iconColumn, onPointerEnter }: { item: Extract<MenuItem, { slider: string }>; iconColumn: boolean; onPointerEnter: () => void }) {
  const { min, max, step } = item;
  const [value, setValue] = useState(item.value);
  const track = useRef<HTMLDivElement>(null);
  /** The drag under way: how far from the knob's centre it took hold. */
  const drag = useRef<number | null>(null);
  const at = (level: number) => Math.min(1, Math.max(0, (level - min) / (max - min)));
  const end = () => {
    if (drag.current === null) return;
    drag.current = null;
    item.onEnd();
  };
  // The menu closed under a drag (the window lost focus, Escape): the drag ends there.
  const ending = useRef(end);
  ending.current = end;
  useEffect(() => () => ending.current(), []);
  const move = (clientX: number) => {
    const box = track.current?.getBoundingClientRect();
    if (drag.current === null || !box || box.width <= 0) return;
    const level = min + at(min + ((clientX - drag.current - box.left) / box.width) * (max - min)) * (max - min);
    const next = Math.round(level / step) * step;
    setValue(next);
    item.onChange(next);
  };
  return (
    <div className="flex h-8 items-center gap-2.5 px-2 text-[13px] text-fg" onPointerEnter={onPointerEnter}>
      {iconColumn && <span className="flex size-4 shrink-0 items-center justify-center text-muted">{item.icon}</span>}
      <span className="whitespace-nowrap">{item.slider}</span>
      <div
        role="slider"
        aria-label={item.slider}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={item.format(value)}
        className="group flex h-8 min-w-[120px] flex-1 cursor-pointer touch-none items-center px-1.5"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const box = track.current!.getBoundingClientRect();
          const knob = box.left + at(value) * box.width;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = Math.abs(event.clientX - knob) <= KNOB_REACH ? event.clientX - knob : 0;
          item.onStart();
          if (drag.current === 0) move(event.clientX);
        }}
        onPointerMove={(event) => move(event.clientX)}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
      >
        <div ref={track} className="relative h-1 w-full rounded-full bg-white/15">
          <div className="absolute inset-y-0 left-0 rounded-full bg-white/70" style={{ width: `${at(value) * 100}%` }} />
          <div
            className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_3px_#0008] transition-transform duration-150 group-hover:scale-110 group-active:scale-125"
            style={{ left: `${at(value) * 100}%` }}
          />
        </div>
      </div>
      <span className="w-[58px] shrink-0 text-right text-[12px] text-muted tabular">{item.format(value)}</span>
    </div>
  );
}

/**
 * `back`: where a submenu goes when there's no room on the right (its parent's
 * left edge), so it sits beside its parent, never over it. `onEnter`: the
 * pointer reached this submenu (its parent keeps it open).
 */
function Panel({ x, y, back, items, root, onEnter, width }: { x: number; y: number; back?: number; items: MenuItem[]; root?: boolean; onEnter?: () => void; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y, origin: "top left" });
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState<{ index: number; x: number; y: number; back: number } | null>(null);
  // A submenu stays open while the pointer crosses other items on its way there
  // (the user, Oct 31: "when i move away from them they close"): another item
  // takes over only once the pointer rests on it.
  const switching = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopSwitching = () => {
    if (switching.current !== null) clearTimeout(switching.current);
    switching.current = null;
  };
  useEffect(() => stopSwitching, []);
  const openAt = (index: number, button: Element) => {
    const box = button.getBoundingClientRect();
    setOpen({ index, x: box.right + 7, y: box.top - 5, back: box.left - 7 });
  };
  const actions = items.map((item, index) => (isAction(item) && !item.disabled ? index : -1)).filter((index) => index >= 0);
  // Keep labels aligned when only some items have icons.
  const iconColumn = items.some((item) => isAction(item) && item.icon !== undefined);

  // Keep the menu on screen, flipping toward the room there is.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const flipX = x + box.width > window.innerWidth - 8;
    const flipY = y + box.height > window.innerHeight - 8;
    setPosition({
      left: Math.max(8, flipX ? (back ?? x) - box.width : x),
      top: Math.max(8, flipY ? y - box.height : y),
      origin: `${flipY ? "bottom" : "top"} ${flipX ? "right" : "left"}`,
    });
  }, [x, y, back]);

  useEffect(() => {
    if (!root) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (open) setOpen(null);
        else closeMenu();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        const at = actions.indexOf(active);
        const next = event.key === "ArrowDown" ? (at + 1) % actions.length : (at - 1 + actions.length) % actions.length;
        setActive(actions[next] ?? -1);
      } else if (event.key === "Enter" && active >= 0) {
        event.preventDefault();
        event.stopPropagation();
        const item = items[active];
        if (isAction(item) && item.onSelect) {
          closeMenu();
          item.onSelect();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <motion.div
      ref={ref}
      data-menu
      role="menu"
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.08 } }}
      transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
      style={{ left: position.left, top: position.top, transformOrigin: position.origin, minWidth: width }}
      onPointerEnter={onEnter}
      onContextMenu={(event) => event.preventDefault()}
      className={cx(
        // The kit’s menu (design/kit/components.css .sp-menu).
        "fixed z-[70] rounded-[10px] border border-line-strong bg-raised p-[5px] shadow-[0_12px_32px_#0009]",
        !width && "min-w-[220px]",
      )}
    >
      {items.map((item, index) => {
        if ("separator" in item) return <div key={index} className="-mx-[5px] my-[5px] h-px bg-line" />;
        if ("person" in item)
          return (
            <div key={index} className="flex items-center gap-2.5 px-2 pt-2 pb-2.5">
              <StartedBy by={{ sub: "", name: item.person.name || item.person.email, ...(item.person.picture ? { picture: item.person.picture } : {}) }} size={32} title={null} />
              <div className="min-w-0">
                <div className="truncate leading-[1.3] font-medium">{item.person.name || item.person.email}</div>
                {item.person.name && <div className="truncate text-[12px] leading-[1.3] text-muted">{item.person.email}</div>}
              </div>
            </div>
          );
        if ("heading" in item)
          return (
            <div key={index} className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium text-faint">
              {item.heading}
            </div>
          );
        if ("swatches" in item) {
          return (
            <div key={index} className="flex gap-1.5 px-2.5 py-1.5">
              {CLIP_COLORS.map((color) => (
                <button
                  key={color}
                  title={color}
                  onClick={() => {
                    closeMenu();
                    item.onSelect(color);
                  }}
                  className={cx(
                    "size-4 rounded-full transition-transform hover:scale-125",
                    item.value === color && "ring-2 ring-white ring-offset-2 ring-offset-raised",
                  )}
                  style={{ background: CLIP_HEX[color] }}
                />
              ))}
            </div>
          );
        }
        if ("slider" in item)
          return (
            <SliderRow
              key={index}
              item={item}
              iconColumn={iconColumn}
              onPointerEnter={() => {
                // Not an item to rest on: nothing lit, and a submenu left open closes as it would for one.
                setActive(-1);
                stopSwitching();
                if (open !== null) switching.current = setTimeout(() => setOpen(null), 350);
              }}
            />
          );
        const highlighted = active === index || open?.index === index;
        return (
          <button
            key={index}
            role="menuitem"
            disabled={item.disabled}
            onPointerEnter={(event) => {
              setActive(index);
              stopSwitching();
              const button = event.currentTarget;
              const change = () => (item.submenu ? openAt(index, button) : setOpen(null));
              if (open === null || open.index === index) change();
              else switching.current = setTimeout(change, 350);
            }}
            onClick={(event) => {
              if (item.submenu) {
                stopSwitching();
                openAt(index, event.currentTarget);
                return;
              }
              if (!item.onSelect) return;
              closeMenu();
              item.onSelect();
            }}
            className={cx(
              "flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors disabled:opacity-45",
              highlighted && !item.disabled && "bg-menu-hover",
              item.danger ? "text-danger" : "text-fg",
            )}
          >
            {iconColumn && <span className={cx("flex size-4 shrink-0 items-center justify-center", item.danger ? "text-danger" : "text-muted")}>{item.icon}</span>}
            <span className="flex-1 whitespace-nowrap">
              {item.label}
              {item.hint && <span className="ml-2 text-[11px] text-faint">{item.hint}</span>}
            </span>
            {item.shortcut && <span className="ml-4 font-mono text-[11px] text-faint">{item.shortcut}</span>}
            {item.detail && <span className="ml-4 text-[12px] text-faint tabular">{item.detail}</span>}
            {item.checked !== undefined && (
              <span className="flex size-4 shrink-0 items-center justify-center text-fg">{item.checked && <Check size={13} strokeWidth={2.4} />}</span>
            )}
            {item.submenu && <ChevronRight size={13} className="text-faint" />}
          </button>
        );
      })}
      {/* Portalled: this panel’s scale animation would otherwise anchor the submenu’s fixed position to it. */}
      {createPortal(
        <AnimatePresence>
          {open && "submenu" in items[open.index] && (
            <Panel key={open.index} x={open.x} y={open.y} back={open.back} items={(items[open.index] as { submenu: MenuItem[] }).submenu} onEnter={stopSwitching} />
          )}
        </AnimatePresence>,
        document.body,
      )}
    </motion.div>
  );
}
