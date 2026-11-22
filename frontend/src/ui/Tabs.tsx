import { useId, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
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
  return { onKeyDown, ref };
}

/**
 * Tabs (`.tabs`: 38 px, 2 px orange underline, mono count): ARIA tablist with roving tabindex and Left/Right/Home/End
 * (selection follows focus). Controlled: `value` is the active tab id, `onChange(id)` runs on click and keys; bind it to the URL in the caller.
 * label: accessible name of the tablist. id: base for element ids; pair each panel with <TabPanel id={id} tab="…">.
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
  const { onKeyDown, ref } = useArrowKeys(
    items.map(i => i.id),
    new Set(items.filter(i => i.disabled).map(i => i.id)),
    value,
    onChange,
  );
  return (
    <div role="tablist" aria-label={label} className={`tabs ${className}`.trim()} onKeyDown={onKeyDown}>
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
