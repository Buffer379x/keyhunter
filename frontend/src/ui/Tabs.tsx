import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';

interface TabItem {
  id: string;
  label: string;
  count?: number | null;
  icon?: IconName;
  disabled?: boolean;
}

function useArrowKeys(ids: string[], disabled: Set<string>, current: string, select: (id: string) => void) {
  const refs = useRef(new Map<string, HTMLElement>());
  const onKeyDown = (event: KeyboardEvent) => {
    const enabled = ids.filter(id => !disabled.has(id));
    const at = enabled.indexOf(current);
    let target: string | undefined;
    if (event.key === 'ArrowRight') target = enabled[(at + 1) % enabled.length];
    else if (event.key === 'ArrowLeft') target = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (event.key === 'Home') target = enabled[0];
    else if (event.key === 'End') target = enabled[enabled.length - 1];
    if (target === undefined) return;
    event.preventDefault();
    select(target);
    refs.current.get(target)?.focus();
  };
  const ref = (id: string) => (node: HTMLElement | null) => {
    if (node) refs.current.set(id, node);
    else refs.current.delete(id);
  };
  return { onKeyDown, ref, refs };
}

/** Room kept between the active tab and the edge of a scrolling tab bar, so the fade does not cover it. */
const EDGE = 28;

/**
 * Tab bar that is wider than its box (phone, 1.0): which ends hide tabs, and the active tab scrolled into view. Only the bar
 * scrolls, never the page (no scrollIntoView, which would also move the page vertically).
 */
function useOverflow(list: RefObject<HTMLDivElement | null>, tabs: RefObject<Map<string, HTMLElement>>, value: string, layout: string) {
  const [more, setMore] = useState({ start: false, end: false });
  const active = useRef(value);
  /** The scroll position this hook set last; any other position is the user's own and stays. */
  const placed = useRef<number | null>(null);
  const update = useCallback(() => {
    const node = list.current;
    if (!node) return;
    const next = { start: node.scrollLeft > 1, end: node.scrollLeft + node.clientWidth < node.scrollWidth - 1 };
    setMore(prev => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, [list]);
  /** The active tab into view with the least scrolling, then the ends. `again`: the tabs changed size (web font, counts), so
   *  a position this hook set is worked out once more from the start and does not depend on the earlier widths. */
  const reveal = useCallback(
    (again: boolean) => {
      const node = list.current,
        tab = tabs.current.get(active.current);
      if (!node) return;
      if (tab && node.scrollWidth > node.clientWidth) {
        if (again && placed.current === node.scrollLeft) node.scrollLeft = 0;
        const box = node.getBoundingClientRect(),
          at = tab.getBoundingClientRect();
        if (at.left < box.left + EDGE) node.scrollLeft += at.left - box.left - EDGE;
        else if (at.right > box.right - EDGE) node.scrollLeft += at.right - box.right + EDGE;
        placed.current = node.scrollLeft;
      }
      update();
    },
    [list, tabs, update],
  );
  useEffect(() => {
    const node = list.current;
    if (!node) return;
    node.addEventListener('scroll', update, { passive: true });
    // The bar and every tab: a narrower window, a loaded web font or a count that arrives later.
    const observer = new ResizeObserver(() => reveal(true));
    for (const child of [node, ...node.children]) observer.observe(child);
    return () => {
      node.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [list, update, reveal, layout]);
  // A new active tab (click, keys or the URL).
  useLayoutEffect(() => {
    active.current = value;
    reveal(false);
  }, [value, reveal]);
  return more;
}

/**
 * Tabs (`.tabs`: 38 px, 2 px orange underline, mono count): ARIA tablist with roving tabindex and Left/Right/Home/End
 * (selection follows focus). Controlled: `value` is the active tab id, `onChange(id)` runs on click and keys; bind it to the URL in the caller.
 * label: accessible name of the tablist. id: base for element ids; pair each panel with <TabPanel id={id} tab="…">.
 * When the tabs do not fit (phone), the bar scrolls sideways: the active tab is scrolled into view, and a fade with a chevron
 * marks the side with more tabs; the chevron scrolls one step (mouse users without a sideways wheel). `className` goes on the
 * outer box.
 */
export function Tabs({
  items,
  value,
  onChange,
  label,
  id,
  className = '',
}: {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  id?: string;
  className?: string;
}) {
  const auto = useId();
  const base = id ?? auto;
  const { onKeyDown, ref, refs } = useArrowKeys(
    items.map(i => i.id),
    new Set(items.filter(i => i.disabled).map(i => i.id)),
    value,
    onChange,
  );
  const list = useRef<HTMLDivElement>(null);
  const more = useOverflow(list, refs, value, items.map(item => `${item.label}${item.count ?? ''}`).join('|'));
  const step = (dir: 1 | -1) => list.current?.scrollBy({ left: dir * list.current.clientWidth * 0.7, behavior: 'smooth' });
  return (
    <div className={`tabs-box${more.start ? ' more-start' : ''}${more.end ? ' more-end' : ''} ${className}`.trim()}>
      <div role="tablist" aria-label={label} className="tabs" ref={list} onKeyDown={onKeyDown}>
        {items.map(item => {
          const selected = item.id === value;
          return (
            <button
              key={item.id}
              ref={ref(item.id)}
              type="button"
              role="tab"
              id={`${base}-tab-${item.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => onChange(item.id)}
            >
              {item.icon && <Icon name={item.icon} size={15} />}
              {item.label}
              {item.count !== undefined && item.count !== null && <span className="mono">{item.count}</span>}
            </button>
          );
        })}
      </div>
      {more.start && (
        <button type="button" className="tabs-more start" tabIndex={-1} aria-hidden="true" onClick={() => step(-1)}>
          <Icon name="chev" size={14} />
        </button>
      )}
      {more.end && (
        <button type="button" className="tabs-more end" tabIndex={-1} aria-hidden="true" onClick={() => step(1)}>
          <Icon name="chev" size={14} />
        </button>
      )}
    </div>
  );
}

/** Panel of a tab. All panels exist in the DOM (so aria-controls resolves) but only the active one renders its children. `id` must equal the id given to <Tabs>. */
export function TabPanel({ id, tab, value, children }: { id: string; tab: string; value: string; children: ReactNode }) {
  const active = tab === value;
  return (
    <div role="tabpanel" id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`} tabIndex={0} hidden={!active}>
      {active ? children : null}
    </div>
  );
}

/**
 * Segmented control (`.seg`, pill group): choose exactly one option, e.g. "30 T | 90 T | 180 T".
 * Radio group semantics with arrow keys. Not for switching between panels, use Tabs for that.
 */
export function Seg<T extends string>({
  options,
  value,
  onChange,
  label,
  className = '',
}: {
  options: { value: T; label: string; disabled?: boolean }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  const { onKeyDown, ref } = useArrowKeys(
    options.map(o => o.value),
    new Set(options.filter(o => o.disabled).map(o => o.value)),
    value,
    id => onChange(id as T),
  );
  return (
    <div role="radiogroup" aria-label={label} className={`seg ${className}`.trim()} onKeyDown={onKeyDown}>
      {options.map(option => (
        <button
          key={option.value}
          ref={ref(option.value)}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
