import type { CSSProperties, InputHTMLAttributes, ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';

/**
 * Field box (`.field`, 32 px): an optional icon plus the control(s) passed as children, e.g.
 * <Field icon="search"><input aria-label="Liste filtern" /></Field> or <Field><span className="muted">Sortieren</span><select …/></Field>.
 * The wrapper is a <label>, so a click anywhere focuses the control. Give the control its own accessible name.
 */
export function Field({ icon, className = '', style, children }: { icon?: IconName; className?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <label className={`field ${className}`.trim()} style={style}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </label>
  );
}

/** Form row (`.form-row`): small label text above a control, optional hint below. */
export function FormRow({ label, hint, children, className = '' }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`form-row ${className}`.trim()}>
      <span>{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

/**
 * Switch (`.switch`): a checkbox with role="switch" and the text as its label; for settings that take effect at once.
 * Controlled: `checked` and `onChange(next)`.
 */
export function Switch({
  checked,
  onChange,
  children,
  disabled = false,
  id,
  className = '',
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'type' | 'role' | 'checked'> & {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className={`switch ${className}`.trim()}>
      <input type="checkbox" role="switch" id={id} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} {...props} />
      <span>{children}</span>
    </label>
  );
}
