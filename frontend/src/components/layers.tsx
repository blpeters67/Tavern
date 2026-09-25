/* Floating UI: tooltips, popouts, context menus and modals. */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { closeContextMenu, closeModal } from '../store/actions';
import { useStore } from '../store/store';
import { Icon, mdiCheck, mdiChevronRight, mdiClose } from './icons';

// ---------------------------------------------------------------------------
// Tooltips
// ---------------------------------------------------------------------------

type Side = 'top' | 'bottom' | 'left' | 'right';

interface TipState {
  text: ReactNode;
  rect: DOMRect;
  side: Side;
  color?: 'black' | 'green' | 'red' | 'brand';
  el: HTMLElement;
}

const useTip = create<{ tip: TipState | null }>(() => ({ tip: null }));

/** Spread onto any element to give it a Discord-style tooltip. */
export function tip(text: ReactNode, side: Side = 'top', color?: TipState['color']) {
  const show = (e: MouseEvent | FocusEvent) => {
    if (!text) return;
    const el = e.currentTarget as HTMLElement;
    useTip.setState({ tip: { text, rect: el.getBoundingClientRect(), side, color, el } });
  };
  const hide = () => useTip.setState({ tip: null });
  // Focus from a click shouldn't bring the tooltip back; keyboard focus should.
  const focus = (e: FocusEvent) => {
    if ((e.currentTarget as HTMLElement).matches(':focus-visible')) show(e);
  };
  return { onMouseEnter: show, onMouseLeave: hide, onFocus: focus, onBlur: hide, onMouseDown: hide };
}

export const hideTooltip = () => useTip.setState({ tip: null });

function TooltipHost() {
  const tipState = useTip((s) => s.tip);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!tipState || !ref.current) {
      setPos(null);
      return;
    }
    const tipEl = ref.current;
    const place = () => {
      const { rect, side } = tipState;
      const el = tipEl.getBoundingClientRect();
      const gap = 8;
      let left = 0;
      let top = 0;
      if (side === 'top') {
        left = rect.left + rect.width / 2 - el.width / 2;
        top = rect.top - el.height - gap;
      } else if (side === 'bottom') {
        left = rect.left + rect.width / 2 - el.width / 2;
        top = rect.bottom + gap;
      } else if (side === 'right') {
        left = rect.right + gap + 4;
        top = rect.top + rect.height / 2 - el.height / 2;
      } else {
        left = rect.left - el.width - gap - 4;
        top = rect.top + rect.height / 2 - el.height / 2;
      }
      left = Math.max(8, Math.min(left, window.innerWidth - el.width - 8));
      top = Math.max(8, Math.min(top, window.innerHeight - el.height - 8));
      setPos({ left, top });
    };
    place();
    // Live tooltips (like voice latency) change size as their numbers come in.
    const ro = new ResizeObserver(place);
    ro.observe(tipEl);
    return () => ro.disconnect();
  }, [tipState]);

  useEffect(() => {
    if (!tipState) return;
    const hide = () => useTip.setState({ tip: null });
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    // If the element disappears under the cursor (navigation, hover toolbars),
    // mouseleave never fires, so check for it.
    const watch = window.setInterval(() => {
      if (!tipState.el.isConnected || !tipState.el.matches(':hover, :focus-visible')) hide();
    }, 250);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
      window.clearInterval(watch);
    };
  }, [tipState]);

  if (!tipState) return null;
  return createPortal(
    <div
      ref={ref}
      className={`tooltip tooltip-${tipState.side} ${tipState.color ? `tooltip-${tipState.color}` : ''}`}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
      role="tooltip"
    >
      <div className="tooltip-pointer" />
      {tipState.text}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Popouts
// ---------------------------------------------------------------------------

export type PopoutSide = 'right' | 'left' | 'top' | 'bottom' | 'top-start' | 'bottom-start' | 'top-end' | 'bottom-end';

export interface PopoutProps {
  anchor: DOMRect;
  side?: PopoutSide;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  gap?: number;
  /** Elements (like the button that opened it) that shouldn't count as "outside". */
  ignore?: (HTMLElement | null)[];
}

export function Popout({ anchor, side = 'right', onClose, children, className, gap = 8, ignore }: PopoutProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ left: -9999, top: -9999, visibility: 'hidden' });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = 0;
      let top = 0;
      switch (side) {
        case 'right':
          left = anchor.right + gap;
          top = anchor.top;
          if (left + r.width > vw - 8) left = anchor.left - r.width - gap;
          break;
        case 'left':
          left = anchor.left - r.width - gap;
          top = anchor.top;
          if (left < 8) left = anchor.right + gap;
          break;
        case 'top':
          left = anchor.left + anchor.width / 2 - r.width / 2;
          top = anchor.top - r.height - gap;
          break;
        case 'top-start':
          left = anchor.left;
          top = anchor.top - r.height - gap;
          break;
        case 'top-end':
          left = anchor.right - r.width;
          top = anchor.top - r.height - gap;
          break;
        case 'bottom':
          left = anchor.left + anchor.width / 2 - r.width / 2;
          top = anchor.bottom + gap;
          break;
        case 'bottom-start':
          left = anchor.left;
          top = anchor.bottom + gap;
          break;
        case 'bottom-end':
          left = anchor.right - r.width;
          top = anchor.bottom + gap;
          break;
      }
      if (side.startsWith('top') && top < 8) top = anchor.bottom + gap;
      if (side.startsWith('bottom') && top + r.height > vh - 8) top = anchor.top - r.height - gap;
      left = Math.max(8, Math.min(left, vw - r.width - 8));
      top = Math.max(8, Math.min(top, vh - r.height - 8));
      setStyle({ left, top });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchor, side, gap]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (ignore?.some((el) => el?.contains(target))) return;
      // Clicks inside a modal/menu that sits above us don't close us.
      if ((target as HTMLElement).closest?.('.context-menu, .modal-root, .tooltip')) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      }
    };
    const t = window.setTimeout(() => {
      document.addEventListener('pointerdown', onDown, true);
    }, 0);
    document.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [ignore]);

  return createPortal(
    <div ref={ref} className={`popout ${className ?? ''}`} style={style}>
      {children}
    </div>,
    document.body,
  );
}

/** Open/close state for a popout anchored to the element that was clicked. */
export function usePopout() {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const toggle = (e: MouseEvent | { currentTarget: EventTarget }) => {
    const el = e.currentTarget as HTMLElement;
    setAnchor((cur) => (cur ? null : el.getBoundingClientRect()));
  };
  const open = (rect: DOMRect) => setAnchor(rect);
  const close = () => setAnchor(null);
  return { anchor, toggle, open, close, isOpen: anchor !== null };
}

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------

function ContextMenuHost() {
  const menu = useStore((s) => s.contextMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      setPos(null);
      return;
    }
    const r = ref.current.getBoundingClientRect();
    let left = menu.x;
    let top = menu.y;
    if (left + r.width > window.innerWidth - 8) left = Math.max(8, menu.x - r.width);
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - r.height - 8);
    setPos({ left, top });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeContextMenu();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeContextMenu();
    const onScroll = () => closeContextMenu();
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScroll);
    };
  }, [menu]);

  if (!menu) return null;
  return createPortal(
    <div
      ref={ref}
      className="context-menu menu"
      style={{ left: pos?.left ?? menu.x, top: pos?.top ?? menu.y, visibility: pos ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
      role="menu"
    >
      {menu.render(closeContextMenu)}
    </div>,
    document.body,
  );
}

export function MenuItem({
  label,
  onClick,
  danger,
  brand,
  icon,
  hint,
  disabled,
  checked,
  submenu,
}: {
  label: ReactNode;
  /** Gets the click, so handlers can check modifier keys (Shift to skip a confirmation). */
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  danger?: boolean;
  brand?: boolean;
  icon?: string | ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  checked?: boolean;
  submenu?: ReactNode;
}) {
  // Submenus are fixed-position so the menu's own scrolling can't clip them.
  // They stay a DOM child of the item, so hovering them keeps the item "hovered".
  const [sub, setSub] = useState<{ left: number; top: number } | null>(null);
  const itemRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const openSub = () => {
    cancelClose();
    if (!submenu || sub || !itemRef.current) return;
    const r = itemRef.current.getBoundingClientRect();
    setSub({ left: r.right + 2, top: r.top - 6 });
  };
  const closeSubSoon = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setSub(null), 250);
  };
  useLayoutEffect(() => {
    if (!sub || !subRef.current || !itemRef.current) return;
    const item = itemRef.current.getBoundingClientRect();
    const box = subRef.current.getBoundingClientRect();
    let left = item.right + 2;
    if (left + box.width > window.innerWidth - 8) left = Math.max(8, item.left - box.width - 2);
    let top = item.top - 6;
    if (top + box.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - box.height - 8);
    if (left !== sub.left || top !== sub.top) setSub({ left, top });
  }, [sub]);
  useEffect(() => cancelClose, []);
  return (
    <div
      ref={itemRef}
      className={`menu-item ${danger ? 'danger' : ''} ${brand ? 'brand' : ''} ${disabled ? 'disabled' : ''} ${sub ? 'sub-open' : ''}`}
      role="menuitem"
      tabIndex={-1}
      aria-disabled={disabled}
      aria-haspopup={submenu ? 'menu' : undefined}
      aria-expanded={submenu ? !!sub : undefined}
      onClick={(e) => {
        if (disabled) return;
        if (submenu) {
          // Tapping opens it too (no hover on touch screens).
          if (!subRef.current?.contains(e.target as Node)) openSub();
          return;
        }
        onClick?.(e);
        closeContextMenu();
      }}
      onMouseEnter={submenu ? openSub : undefined}
      onMouseLeave={submenu ? closeSubSoon : undefined}
    >
      <span className="menu-label">{label}</span>
      {hint && <span className="menu-hint">{hint}</span>}
      {checked !== undefined && (
        <span className={`menu-check ${checked ? 'on' : ''}`}>{checked && <Icon path={mdiCheck} size={14} />}</span>
      )}
      {icon && (typeof icon === 'string' ? <Icon path={icon} size={18} className="menu-icon" /> : <span className="menu-icon">{icon}</span>)}
      {submenu && <Icon path={mdiChevronRight} size={18} className="menu-icon" />}
      {submenu && sub && (
        <div ref={subRef} className="menu submenu" role="menu" style={{ left: sub.left, top: sub.top }}>
          {submenu}
        </div>
      )}
    </div>
  );
}

export const MenuSeparator = () => <div className="menu-separator" role="separator" />;

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function ModalHost() {
  const modals = useStore((s) => s.modals);
  useEffect(() => {
    if (!modals.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeModal(modals[modals.length - 1].id);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modals]);

  if (!modals.length) return null;
  return createPortal(
    <>
      {modals.map((m, i) => (
        <div key={m.id} className="modal-root" style={{ zIndex: 1000 + i * 2 }}>
          <div className="modal-backdrop" onMouseDown={() => closeModal(m.id)} />
          <div className="modal-layer">{m.render(() => closeModal(m.id))}</div>
        </div>
      ))}
    </>,
    document.body,
  );
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  className,
  centered,
  size = 'small',
  onKeyDown,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  centered?: boolean;
  size?: 'small' | 'medium' | 'large' | 'dynamic';
  onKeyDown?: (e: ReactKeyboardEvent) => void;
}) {
  return (
    <div className={`modal modal-${size} ${className ?? ''}`} role="dialog" aria-modal onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
      {(title || subtitle) && (
        <div className={`modal-header ${centered ? 'centered' : ''}`}>
          {title && <h2 className="modal-title">{title}</h2>}
          {subtitle && <div className="modal-subtitle">{subtitle}</div>}
        </div>
      )}
      <button className="modal-close" onClick={onClose} aria-label="Close">
        <Icon path={mdiClose} size={24} />
      </button>
      {children !== undefined && <div className="modal-body">{children}</div>}
      {footer && <div className="modal-footer">{footer}</div>}
    </div>
  );
}

/** Mount once near the root. */
export function LayerHosts() {
  return (
    <>
      <ModalHost />
      <ContextMenuHost />
      <TooltipHost />
    </>
  );
}
