const whole = new Intl.NumberFormat('de-DE');

/** "23,92 €" (German separators, euro cents as an integer). */
export function formatPrice(cents: number): string {
  return `${whole.format(Math.floor(cents / 100))},${String(Math.abs(cents) % 100).padStart(2, '0')} €`;
}

/**
 * Price with split cents: big integer, small ",92 €" (xl and md); sm is one line size for lists and tables.
 * Tabular numerals, German formatting. Colour: tone "stale" (secondary), "target" (orange, only for the target price).
 * `struck` crosses it out (sold out). A missing price (`cents` null or undefined) is never drawn as a price:
 * it shows the status text in `missing` instead, e.g. "noch nicht abgefragt" or "wird gesucht …".
 */
export function Price({ cents, size = 'md', tone = 'default', struck = false, missing = 'noch nicht abgefragt', className = '' }: {
  cents: number | null | undefined; size?: 'xl' | 'md' | 'sm'; tone?: 'default' | 'stale' | 'target'; struck?: boolean; missing?: string; className?: string;
}) {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return <span className={`ui-price-missing ${className}`.trim()}>{missing}</span>;
  const int = whole.format(Math.floor(cents / 100));
  const frac = `,${String(Math.abs(cents) % 100).padStart(2, '0')} €`;
  return <span className={`ui-price ${size} ${tone}${struck ? ' struck' : ''} ${className}`.trim()}>
    <span aria-hidden="true"><span className="ui-price-int">{int}</span><span className="ui-price-frac">{frac}</span></span>
    <span className="sr-only">{int}{frac}</span>
  </span>;
}
