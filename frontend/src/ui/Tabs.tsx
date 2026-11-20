import { useId, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Icon } from './Icon';

export interface TabItem { id: string; label: string; count?: number | null; icon?: string; disabled?: boolean }

function useArrowKeys(ids: string[], disabled: Set<string>, current: string, select: (id: string) => void, horizontal = true) {
  const refs = useRef(new Map<string, HTMLElement>());
  const onKeyDown = (event: KeyboardEvent) => {
    const enabled = ids.filter(id => !disabled.has(id));
    const at = enabled.indexOf(current);
    const prev = horizontal ? 'ArrowLeft' : 'ArrowUp', next = horizontal ? 'ArrowRight' : 'ArrowDown';
    let target: string | undefined;
    if (event.key === next) target = enabled[(at + 1) % enabled.length];
    else if (event.key === prev) target = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (event.key === 'Home') target = enabled[0];
    else if (event.key === 'End') target = enabled[enabled.length - 1];
    if (target === undefined) return;
    event.preventDefault();
    select(target);
    refs.current.get(target)?.focus();
  };
  const ref = (id: string) => (node: HTMLElement | null) => { if (node) refs.current.set(id, node); else refs.current.delete(id); };
  return { onKeyDown, ref };
}

/**
 * Tabs: ARIA tablist with roving tabindex, Left/Right/Home/End keys (selection follows focus).
 * Controlled: `value` is the active tab id, `onChange(id)` is called on click and keys. Bind `value` to the URL in the caller.
 * - variant: 'line' (underline, for page sections) or 'segment' (pill group, for compact switches).
 * - label: accessible name of the tablist. id: base for element ids; pair each panel with <TabPanel id={id} tab="…">.
 * - items: { id, label, count?, icon?, disabled? }. The tab name is the visible label (count is part of it).
 */
export function Tabs({ items, value, onChange, label, variant = 'line', id, className = '' }: {
  items: TabItem[]; value: string; onChange: (id: string) => void; label: string; variant?: 'line' | 'segment'; id?: string; className?: string;
}) {
  const auto = useId();
  const base = id ?? auto;
  const { onKeyDown, ref } = useArrowKeys(items.map(i => i.id), new Set(items.filter(i => i.disabled).map(i => i.id)), value, onChange);
  return <div role="tablist" aria-label={label} className={`ui-tabs ${variant} ${className}`.trim()} onKeyDown={onKeyDown}>
    {items.map(item => {
      const selected = item.id === value;
      return <button key={item.id} ref={ref(item.id)} type="button" role="tab" id={`${base}-tab-${item.id}`} aria-selected={selected} aria-controls={`${base}-panel-${item.id}`}
        tabIndex={selected ? 0 : -1} disabled={item.disabled} onClick={() => onChange(item.id)}>
        {item.icon && <Icon name={item.icon} size={16} />}{item.label}{item.count !== undefined && item.count !== null && <span className="ui-tab-count">{item.count}</span>}
      </button>;
    })}
  </div>;
}

/** Panel of a tab. All panels exist in the DOM (so aria-controls resolves) but only the active one is shown and renders its children. `id` must equal the id given to <Tabs>. */
export function TabPanel({ id, tab, value, children }: { id: string; tab: string; value: string; children: ReactNode }) {
  const active = tab === value;
  return <div role="tabpanel" id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`} tabIndex={0} hidden={!active}>{active ? children : null}</div>;
}

/**
 * SegmentedControl: choose exactly one option (radio group semantics, arrow keys), e.g. "Grundpreis | mit Gebühren".
 * Not for navigating between panels, use Tabs for that. options: { value, label }.
 */
export function SegmentedControl<T extends string>({ options, value, onChange, label, className = '' }: {
  options: { value: T; label: string; disabled?: boolean }[]; value: T; onChange: (value: T) => void; label: string; className?: string;
}) {
  const { onKeyDown, ref } = useArrowKeys(options.map(o => o.value), new Set(options.filter(o => o.disabled).map(o => o.value)), value, id => onChange(id as T));
  return <div role="radiogroup" aria-label={label} className={`ui-tabs segment ${className}`.trim()} onKeyDown={onKeyDown}>
    {options.map(option => <button key={option.value} ref={ref(option.value)} type="button" role="radio" aria-checked={option.value === value}
      tabIndex={option.value === value ? 0 : -1} disabled={option.disabled} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}
