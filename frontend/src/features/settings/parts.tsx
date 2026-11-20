import type { ReactNode } from 'react';
import { Card } from '../../ui';
import { shopTitle } from './format';
import type { Tone } from './format';

/** Settings card: title, one-line explanation, optional status on the right. */
export function SectionCard({ title, titleId, sub, aside, children, className = '', ...rest }: {
  title: string; titleId?: string; sub?: ReactNode; aside?: ReactNode; children?: ReactNode; className?: string; 'aria-label'?: string; 'data-testid'?: string;
}) {
  return <Card className={`set-card ${className}`.trim()} aria-labelledby={titleId} {...rest}>
    <header className="set-card-head">
      <div><h2 id={titleId}>{title}</h2>{sub && <p>{sub}</p>}</div>
      {aside}
    </header>
    {children}
  </Card>;
}

/** Row card: text on the left, action or status on the right (export, "Weiteren Shop hinzufügen", Editionsinhalte). */
export function RowCard({ title, sub, children, headingId }: { title: string; sub?: ReactNode; children?: ReactNode; headingId?: string }) {
  return <Card className="set-row-card">
    <div><h2 id={headingId}>{title}</h2>{sub && <p>{sub}</p>}</div>
    {children}
  </Card>;
}

/** Status dot. Always sits next to a text. */
export function Dot({ tone }: { tone: Tone }) { return <span className={`set-dot ${tone}`} aria-hidden="true" />; }

export function ShopMark({ id }: { id: string }) { return <span className="set-shop-mark" aria-hidden="true">{shopTitle(id)[0]}</span>; }

/** "41 von 120" with a thin bar. The bar turns amber from 90 %. */
export function UsageBar({ used, limit, label }: { used: number; limit: number; label: string }) {
  const share = limit > 0 ? Math.min(1, used / limit) : 0;
  return <div className="set-usage">
    <span className="set-usage-text"><strong>{used}</strong> von {limit}</span>
    <progress className={share >= 0.9 ? 'high' : ''} aria-label={label} max={limit} value={Math.min(used, limit)} />
  </div>;
}

/** Definition list of label and value pairs. */
export function Facts({ items }: { items: { label: string; value: ReactNode }[] }) {
  return <dl className="set-facts">{items.map(item => <div key={item.label}><dt className="ui-mono">{item.label}</dt><dd>{item.value}</dd></div>)}</dl>;
}
