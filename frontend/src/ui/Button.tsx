import type { ComponentProps, ReactNode } from 'react';

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';
type Native = ComponentProps<'button'>;
const variantClass = (variant: ButtonVariant) => (variant === 'default' ? '' : ` ${variant}`);

/**
 * Button (`.btn`, 32 px; `size="sm"` is 28 px).
 * - variant: default (neutral), primary (orange, the one main action of a view), ghost (no border, for quiet
 *   secondary actions), danger (destructive).
 * - loading: shows a spinner, sets aria-busy and blocks clicks. Keep the label, it still tells what happens.
 * Put an <Icon> before or after the text as a child. Everything else is passed to the <button>; type defaults to "button".
 */
export function Button({
  variant = 'default',
  size = 'md',
  loading = false,
  disabled,
  className = '',
  children,
  ...props
}: Native & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`btn${variantClass(variant)}${size === 'sm' ? ' sm' : ''} ${className}`.trim()}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

/**
 * Square icon-only button (`.icon-btn`, 32 px). `label` is required: it becomes the accessible name and the tooltip.
 * Pass the icon as children, e.g. <IconButton label="Suche schließen"><Icon name="x" /></IconButton>.
 */
export function IconButton({ label, variant = 'default', className = '', children, ...props }: Native & { label: string; variant?: ButtonVariant }) {
  return (
    <button type="button" className={`icon-btn${variantClass(variant)} ${className}`.trim()} aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}
