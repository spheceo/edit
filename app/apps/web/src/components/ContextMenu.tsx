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
    }
  | { separator: true }
  | { heading: string }
  /** Who’s signed in, at the top of the account menu: their photo, name and email. */
  | { person: { name: string; email: string; picture: string | null } }
  | { swatches: true; value?: ClipColor; onSelect: (color: ClipColor) => void };

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
      if (event.type === "pointerdown" && target?.closest?.("[data-menu]")) return;
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
  return (
    <AnimatePresence>
      {menu && <Panel key={menu.key} x={menu.x} y={menu.y} items={menu.items} width={menu.width} root />}
    </AnimatePresence>
  );
}

function Panel({ x, y, items, root, onLeave, width }: { x: number; y: number; items: MenuItem[]; root?: boolean; onLeave?: () => void; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y, origin: "top left" });
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState<{ index: number; x: number; y: number } | null>(null);
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
      left: Math.max(8, flipX ? x - box.width : x),
      top: Math.max(8, flipY ? y - box.height : y),
      origin: `${flipY ? "bottom" : "top"} ${flipX ? "right" : "left"}`,
    });
  }, [x, y]);

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
      onPointerLeave={onLeave}
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
        const highlighted = active === index || open?.index === index;
        return (
          <button
            key={index}
            role="menuitem"
            disabled={item.disabled}
            onPointerEnter={(event) => {
              setActive(index);
              if (item.submenu) {
                const box = event.currentTarget.getBoundingClientRect();
                setOpen({ index, x: box.right + 2, y: box.top - 5 });
              } else setOpen(null);
            }}
            onClick={() => {
              if (item.submenu || !item.onSelect) return;
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
            <Panel key={open.index} x={open.x} y={open.y} items={(items[open.index] as { submenu: MenuItem[] }).submenu} />
          )}
        </AnimatePresence>,
        document.body,
      )}
    </motion.div>
  );
}
