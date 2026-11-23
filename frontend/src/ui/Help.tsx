import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';

const GAP = 6;
const EDGE = 8;

/**
 * Help (0.8.3): every explanation sits behind the same "?" symbol instead of standing in the interface. The popup opens on
 * hover and on a click or tap (touch has no hover), or with Enter; Escape, a tap elsewhere or leaving closes it. Keyboard
 * focus alone does not open it (RESP-20): Tab passes by without a popup, and Escape stays free for the dialog or drawer. It floats fixed
 * above everything (never clipped by a scrolling table) and stays inside the viewport, below the symbol or above when there is
 * no room. The text is the button's accessible description, so screen readers hear it without opening anything.
 * `label` names the button ("Hilfe zu Gebühren"); children are inline content, a `<span>` per paragraph.
 * `trigger` (1.0.1) replaces the "?" by other content (a tag such as the Prüftempo), so a value can carry its explanation with
 * the same popup, also on touch.
 */
export function Help({ label = 'Hilfe', children, className = '', trigger }: { label?: string; children: ReactNode; className?: string; trigger?: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !button.current || !pop.current) {
      setAt(null);
      return;
    }
    const place = () => {
      const anchor = button.current!.getBoundingClientRect();
      const box = pop.current!.getBoundingClientRect();
      const width = window.innerWidth;
      const height = window.innerHeight;
      const left = Math.min(Math.max(EDGE, anchor.left + anchor.width / 2 - box.width / 2), Math.max(EDGE, width - box.width - EDGE));
      const below = anchor.bottom + GAP;
      const top = below + box.height > height - EDGE && anchor.top - GAP - box.height >= EDGE ? anchor.top - GAP - box.height : below;
      setAt({ left, top });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);
  useEffect(() => {
    if (!pinned) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        setPinned(false);
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [pinned]);
  const close = () => {
    setPinned(false);
    setOpen(false);
  };
  return (
    <span
      ref={root}
      className={`help ${className}`.trim()}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!pinned) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        className={trigger ? 'help-btn help-tag' : 'help-btn'}
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onBlur={close}
        onClick={() => {
          const next = !pinned;
          setPinned(next);
          setOpen(next);
        }}
        onKeyDown={event => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation();
            close();
          }
        }}
      >
        {trigger ?? <Icon name="help" size={15} />}
      </button>
      <span ref={pop} id={id} role="tooltip" className="help-pop" hidden={!open} style={at ? { left: at.left, top: at.top } : { left: -9999, top: 0 }}>
        {children}
      </span>
    </span>
  );
}
