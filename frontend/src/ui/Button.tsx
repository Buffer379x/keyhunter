import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Native = ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * Button.
 * - variant: primary (orange, the one main action of a view), secondary (default for the rest), ghost (outline), danger (destructive).
 * - secondary: legacy shortcut for variant="secondary"; an explicit variant wins.
 * - size: 'md' (40 px, 44 px on touch) or 'sm' (32 px, 44 px on touch).
 * - loading: shows a spinner, sets aria-busy and blocks clicks. Keep the label, it still tells what happens.
 * Everything else is passed to the <button>; type defaults to "button".
 */
export function Button({ variant, secondary = false, size = 'md', loading = false, disabled, className = '', children, ...props }: Native & {
  variant?: ButtonVariant; secondary?: boolean; size?: 'sm' | 'md'; loading?: boolean; children?: ReactNode;
}) {
  const kind = variant ?? (secondary ? 'secondary' : 'primary');
  return <button type="button" className={`button ${kind}${size === 'sm' ? ' sm' : ''}${loading ? ' loading' : ''} ${className}`.trim()}
    disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
    {loading && <span className="ui-spinner" aria-hidden="true" />}{children}
  </button>;
}

/**
 * Icon-only button. `label` is required: it becomes the accessible name and the tooltip.
 * Pass the icon as children, e.g. <IconButton label="Suche schließen"><Icon name="close" /></IconButton>.
 */
export function IconButton({ label, variant = 'secondary', className = '', children, ...props }: Native & { label: string; variant?: ButtonVariant }) {
  return <button type="button" className={`icon-action ${variant} ${className}`.trim()} aria-label={label} title={label} {...props}>{children}</button>;
}
