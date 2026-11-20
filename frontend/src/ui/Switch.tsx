import type { ReactNode } from 'react';

/**
 * Switch (on/off setting that takes effect at once). The whole row is the 44 px hit area; the label is the accessible name.
 * Controlled: `checked` and `onChange(next)`. For a choice that needs "Speichern" use a checkbox instead.
 */
export function Switch({ checked, onChange, children, disabled = false, id, className = '' }: {
  checked: boolean; onChange: (checked: boolean) => void; children: ReactNode; disabled?: boolean; id?: string; className?: string;
}) {
  return <button type="button" role="switch" id={id} aria-checked={checked} disabled={disabled} className={`ui-switch ${className}`.trim()} onClick={() => onChange(!checked)}>
    <span className="ui-switch-track" aria-hidden="true"><span className="ui-switch-thumb" /></span>
    <span className="ui-switch-label">{children}</span>
  </button>;
}
