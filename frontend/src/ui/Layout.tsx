import type { ElementType, HTMLAttributes, ReactNode } from 'react';
import { Icon } from './Icon';

/** Four corner brackets from the logo reticle. Decoration only: use it on at most one element per view (the chosen game or the best price). */
export function TargetLock({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`ui-lock ${className}`.trim()}>{children}
    <i className="tl" aria-hidden="true" /><i className="tr" aria-hidden="true" /><i className="bl" aria-hidden="true" /><i className="br" aria-hidden="true" />
  </span>;
}

/**
 * Card on surface level 1. `as` picks the element (section by default; button or a for a clickable card).
 * interactive: hover and focus styling. selected: raised level with a ring. lock: add the target-lock corners.
 */
export function Card({ as, interactive = false, selected = false, lock = false, className = '', children, ...props }: HTMLAttributes<HTMLElement> & {
  as?: ElementType; interactive?: boolean; selected?: boolean; lock?: boolean; children?: ReactNode; href?: string; type?: string;
}) {
  const Tag: ElementType = as ?? 'section';
  const card = <Tag className={`ui-card${interactive ? ' interactive' : ''}${selected ? ' selected' : ''} ${className}`.trim()} aria-current={selected && Tag === 'a' ? 'true' : undefined} {...props}>{children}</Tag>;
  return lock ? <TargetLock>{card}</TargetLock> : card;
}

/** Short uppercase data label in JetBrains Mono ("BESTER GÜLTIGER PREIS · DE", "VOR 2 STD."). tone: muted (default), soft, accent. */
export function MonoLabel({ as: Tag = 'span', tone = 'muted', className = '', children, ...props }: HTMLAttributes<HTMLElement> & { as?: ElementType; tone?: 'muted' | 'soft' | 'accent'; children: ReactNode }) {
  return <Tag className={`ui-mono ${tone} ${className}`.trim()} {...props}>{children}</Tag>;
}

/** Empty or error-free "nothing here yet" block: icon, one headline, one sentence, optional action. headingLevel sets the h-tag (default 2). */
export function EmptyState({ icon = 'info', title, children, action, headingLevel = 2 }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode; headingLevel?: 2 | 3 }) {
  const Heading = `h${headingLevel}` as 'h2' | 'h3';
  return <div className="ui-empty"><span className="ui-empty-icon"><Icon name={icon} size={22} /></span><Heading>{title}</Heading>{children && <p>{children}</p>}{action}</div>;
}
