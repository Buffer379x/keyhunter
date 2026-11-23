import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

/** Distance the panel keeps from the window edge. */
const EDGE = 8;

/**
 * Button with a floating panel (edition picker, "⋯" menu). Closes on Escape (focus returns to the button), on a click outside
 * and when `children` calls close(). With `menu` the panel is a role="menu" whose role="menuitem" buttons take the arrow keys.
 * The panel opens at the `align` side of the button; when that side has no room it takes the other alignment, and it never
 * leaves the window (1.0: on a phone "Pausieren" wraps to the left edge, and the right-aligned menu ran out of the screen).
 */
export default function Popover({
  trigger,
  triggerLabel,
  triggerClassName = '',
  panelClassName = '',
  menu = false,
  align = 'start',
  children,
}: {
  trigger: ReactNode;
  triggerLabel?: string;
  triggerClassName?: string;
  panelClassName?: string;
  menu?: boolean;
  align?: 'start' | 'end';
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useLayoutEffect(() => {
    const node = panel.current;
    if (!open || !node) return;
    node.style.translate = '';
    const box = node.getBoundingClientRect(),
      anchor = button.current!.getBoundingClientRect(),
      width = document.documentElement.clientWidth;
    const least = EDGE - box.left,
      most = width - EDGE - box.right;
    // Out on one side: first try the other alignment (panel edge on the other edge of the button), then the window edge.
    const shift =
      box.left < EDGE
        ? Math.max(least, Math.min(anchor.left - box.left, most))
        : box.right > width - EDGE
          ? Math.min(most, Math.max(anchor.right - box.right, least))
          : 0;
    if (shift) node.style.translate = `${Math.round(shift)}px 0`;
  }, [open]);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    if (menu) root.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, menu]);
  function keys(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      close();
      return;
    }
    if (!menu || !open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }
  return (
    <span className="popover" ref={root} onKeyDown={keys}>
      <button
        ref={button}
        type="button"
        className={triggerClassName}
        aria-label={triggerLabel}
        aria-haspopup={menu ? 'menu' : 'true'}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(value => !value)}
      >
        {trigger}
      </button>
      {open && (
        <div ref={panel} id={panelId} className={`popover-panel ${align} ${panelClassName}`.trim()} role={menu ? 'menu' : 'group'} aria-label={triggerLabel}>
          {children(close)}
        </div>
      )}
    </span>
  );
}
