const whole = new Intl.NumberFormat('de-DE');
const parts = (cents: number) => [whole.format(Math.trunc(cents / 100)), String(Math.abs(cents) % 100).padStart(2, '0')] as const;

/** "23,92 €" (German separators, euro cents as an integer). */
export function formatPrice(cents: number): string {
  const [int, frac] = parts(cents);
  return `${int},${frac} €`;
}

type Missing = { missing?: string; className?: string };
const valid = (cents: number | null | undefined): cents is number => cents !== null && cents !== undefined && Number.isFinite(cents);
/** A missing price is never drawn as a price: it shows the status text in `missing` instead. */
const MissingPrice = ({ missing = 'noch nicht abgefragt', className = '' }: Missing) => <span className={`price-missing ${className}`.trim()}>{missing}</span>;

/**
 * Inline price for lists and tables (`.price`: JetBrains Mono 14 px, tabular numerals).
 * tone: world (the cheapest region, warm white), hot (orange: best offer, your target), stale (muted). `struck` crosses it out.
 */
export function Price({
  cents,
  tone = 'default',
  struck = false,
  missing,
  className = '',
}: Missing & {
  cents: number | null | undefined;
  tone?: 'default' | 'world' | 'hot' | 'stale';
  struck?: boolean;
}) {
  if (!valid(cents)) return <MissingPrice missing={missing} className={className} />;
  return <span className={`price${tone === 'default' ? '' : ` ${tone}`}${struck ? ' struck' : ''} ${className}`.trim()}>{formatPrice(cents)}</span>;
}

/** Large price (`.big-price`, 34 px) with the cents and the euro sign set smaller: "23<small>,92 €</small>". `world` colours it as the worldwide price. */
export function BigPrice({ cents, world = false, missing, className = '' }: Missing & { cents: number | null | undefined; world?: boolean }) {
  if (!valid(cents)) return <MissingPrice missing={missing} className={className} />;
  const [int, frac] = parts(cents);
  return (
    <span className={`big-price${world ? ' world' : ''} ${className}`.trim()}>
      <span aria-hidden="true">
        {int}
        <small>,{frac} €</small>
      </span>
      <span className="sr-only">
        {int},{frac} €
      </span>
    </span>
  );
}
