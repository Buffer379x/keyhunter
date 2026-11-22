import type { ElementType, ReactNode } from 'react';
import { Inset, Label, Panel, PanelHead } from '../../ui';

/**
 * Settings panel in the prototype's language: `.panel` with a `.panel-head` (the mono label is the h2, then optional
 * status or actions on the right) and the content in an `.inset`. With `titleId` the panel is a region named by its title;
 * an article (Key-Shops) passes `as="article"` and an `aria-label` instead.
 */
export function SettingsPanel({
  title,
  titleId,
  aside,
  children,
  as,
  className = '',
  insetClassName = '',
  ...rest
}: {
  title: ReactNode;
  titleId?: string;
  aside?: ReactNode;
  children?: ReactNode;
  as?: ElementType;
  className?: string;
  insetClassName?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}) {
  return (
    <Panel as={as} className={className} aria-labelledby={rest['aria-label'] ? undefined : titleId} {...rest}>
      <PanelHead>
        <Label as="h2" tone="soft" id={titleId}>
          {title}
        </Label>
        {aside && (
          <>
            <span className="spacer" />
            {aside}
          </>
        )}
      </PanelHead>
      <Inset className={insetClassName}>{children}</Inset>
    </Panel>
  );
}

/** Label and value rows inside an inset (System: "Version", "Sicherung"). */
export function Facts({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="set-facts">
      {items.map(item => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
