import type { ElementType, HTMLAttributes, ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';

type Box = HTMLAttributes<HTMLElement> & { as?: ElementType; children?: ReactNode; href?: string; type?: string };

/**
 * Panel (`.panel`): the card surface (panel colour, 1 px line, 12 px radius). `as` picks the element (section by default).
 * Structure: <Panel><PanelHead>…</PanelHead><Inset>…</Inset></Panel>. `padded` adds 16 px padding for simple content.
 */
export function Panel({ as, padded = false, className = '', children, ...props }: Box & { padded?: boolean }) {
  const Tag: ElementType = as ?? 'section';
  return (
    <Tag className={`panel${padded ? ' pad' : ''} ${className}`.trim()} {...props}>
      {children}
    </Tag>
  );
}

/** Panel header row (`.panel-head`, min 48 px): put a <Label> first, then <span className="spacer" /> and actions. */
export function PanelHead({ as, className = '', children, ...props }: Box) {
  const Tag: ElementType = as ?? 'div';
  return (
    <Tag className={`panel-head ${className}`.trim()} {...props}>
      {children}
    </Tag>
  );
}

/** Inner surface of a panel (`.inset`, one level lighter, 6 px from the panel edge). Tables and charts go in here. */
export function Inset({ as, className = '', children, ...props }: Box) {
  const Tag: ElementType = as ?? 'div';
  return (
    <Tag className={`inset ${className}`.trim()} {...props}>
      {children}
    </Tag>
  );
}

/** Uppercase mono label (`.label`, 11 px, .08em): "BESTER PREIS · DE". tone: muted (default), soft (text-2), accent. */
export function Label({
  as: Tag = 'span',
  tone = 'muted',
  className = '',
  children,
  ...props
}: HTMLAttributes<HTMLElement> & { as?: ElementType; tone?: 'muted' | 'soft' | 'accent'; children: ReactNode }) {
  return (
    <Tag className={`label${tone === 'muted' ? '' : ` ${tone}`} ${className}`.trim()} {...props}>
      {children}
    </Tag>
  );
}

/**
 * KPI tile (`.kpi`): label, big mono value with a unit, optional tick bars (the last one orange) and a footer row.
 * `ticks` are raw values; they are scaled to the 34 px track. `foot` is usually two <span>s (left and right).
 */
export function Kpi({
  label,
  value,
  unit,
  foot,
  ticks,
  className = '',
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  foot?: ReactNode;
  ticks?: number[];
  className?: string;
}) {
  return (
    <div className={`panel kpi ${className}`.trim()}>
      <div className="kpi-body">
        <div>
          <div className="label">{label}</div>
          <div className="kpi-val">
            <b>{value}</b>
            {unit !== undefined && <span>{unit}</span>}
          </div>
        </div>
        {ticks && ticks.length > 0 && <Ticks values={ticks} />}
      </div>
      {foot && <div className="kpi-foot">{foot}</div>}
    </div>
  );
}

/** Up to the last 9 values as 2 px bars, 34 px high; the newest is orange. Decorative. */
export function Ticks({ values, count = 9 }: { values: number[]; count?: number }) {
  const shown = values.slice(-count);
  const low = Math.min(...shown) * 0.9,
    high = Math.max(...shown);
  return (
    <span className="ticks" aria-hidden="true">
      {shown.map((value, index) => (
        <i
          key={index}
          className={index === shown.length - 1 ? 'on' : undefined}
          style={{ height: `${Math.max(6, ((value - low) / (high - low || 1)) * 34)}px` }}
        />
      ))}
    </span>
  );
}

/** "Nothing here yet" block (`.empty`): optional icon, one headline, one sentence, optional action. headingLevel sets the h-tag (default 2). */
export function EmptyState({
  icon,
  title,
  children,
  action,
  headingLevel = 2,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  headingLevel?: 2 | 3;
}) {
  const Heading = `h${headingLevel}` as 'h2' | 'h3';
  return (
    <div className="empty">
      {icon && <Icon name={icon} size={20} />}
      <Heading>{title}</Heading>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
