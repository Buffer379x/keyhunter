import { Icon, Inset, Label, Panel, PanelHead, Pill } from '../components';
import { MIN_DAYS, OUTLOOK_DAYS, days, outlookText } from './price-outlook';
import type { Outlook, OutlookResult } from './price-outlook';
import type { TrendArrows } from './WishlistRow';

/** The arrow of the outlook, in the look of the wishlist arrows: green for falling, red for rising, grey for stable. */
function OutlookArrow({ outlook, arrows }: { outlook: Outlook; arrows: TrendArrows }) {
  const tone = outlook.direction === 'falling' ? 'better' : outlook.direction === 'rising' ? 'worse' : 'same';
  const direction = tone === 'same' ? 'right' : (tone === 'better') === (arrows === 'rating') ? 'up' : 'down';
  return (
    <span className={`price-change big ${tone} ${direction}`} aria-hidden="true">
      <Icon name="arrow" size={14} />
    </span>
  );
}

/** The last 90 days of daily prices, the usual price, the discounts and the expected direction (no number for the future). */
function OutlookChart({ outlook }: { outlook: Outlook }) {
  const W = 300,
    H = 84,
    AHEAD = 22,
    PAD = 6;
  const values = outlook.daily.filter((cents): cents is number => cents !== null);
  const lo = Math.min(...values, outlook.usual) * 0.96,
    hi = Math.max(...values, outlook.usual) * 1.03;
  const step = (W - AHEAD) / (OUTLOOK_DAYS - 1);
  const x = (index: number) => index * step;
  const y = (cents: number) => PAD + (1 - (cents - lo) / (hi - lo || 1)) * (H - 2 * PAD);
  const segments: string[] = [];
  let open = '';
  outlook.daily.forEach((cents, index) => {
    if (cents === null) {
      if (open) segments.push(open);
      open = '';
      return;
    }
    open += `${open ? 'L' : 'M'}${x(index).toFixed(1)} ${y(cents).toFixed(1)}`;
  });
  if (open) segments.push(open);
  const lastIndex = outlook.daily.length - 1;
  const lastX = x(lastIndex),
    lastY = y(outlook.now);
  const drift = outlook.direction === 'falling' ? 12 : outlook.direction === 'rising' ? -12 : 0;
  const end = [lastX + AHEAD - 6, lastY + drift] as const;
  const angle = Math.atan2(drift, AHEAD - 6);
  const head = (turn: number) => `${(end[0] - 6 * Math.cos(angle + turn)).toFixed(1)} ${(end[1] - 6 * Math.sin(angle + turn)).toFixed(1)}`;
  return (
    <svg
      className={`outlook-chart ${outlook.direction}`}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Preisverlauf der letzten 90 Tage mit üblichem Preis und Rabatten"
    >
      {outlook.discounts.map(run => (
        <rect key={run.from} className="discount" x={x(lastIndex - run.from) - step / 2} y={0} width={(run.from - run.to + 1) * step} height={H} />
      ))}
      <line className="usual" x1={0} x2={W - AHEAD} y1={y(outlook.usual)} y2={y(outlook.usual)} />
      {segments.map((d, index) => (
        <path key={index} className="price" d={d} />
      ))}
      <circle className="now" cx={lastX} cy={lastY} r={3} />
      <path className="ahead" d={`M${lastX.toFixed(1)} ${lastY.toFixed(1)}L${end[0].toFixed(1)} ${end[1].toFixed(1)}`} />
      <path className="ahead-head" d={`M${head(-0.5)}L${end[0].toFixed(1)} ${end[1].toFixed(1)}L${head(0.5)}`} />
    </svg>
  );
}

/** The price outlook (1.1.3): a box of its own below "Warum dieser Preis zählt" with the verdict, its reason, a small chart and the figures. */
export function OutlookPanel({
  result,
  money,
  land,
  arrows = 'price',
}: {
  result: OutlookResult | null;
  money: (cents: number) => string;
  land: string;
  arrows?: TrendArrows;
}) {
  if (!result) return null;
  return (
    <Panel aria-labelledby="outlook-title">
      <PanelHead>
        <Label id="outlook-title">Preistendenz</Label>
        <span className="spacer" />
        {result.kind === 'outlook' && <Pill tone={result.outlook.confidence === 'hoch' ? 'ok' : undefined}>Sicherheit {result.outlook.confidence}</Pill>}
      </PanelHead>
      <Inset className="outlook">
        {result.kind === 'too_little' ? (
          <p className="muted">
            Für eine Tendenz braucht KeyHunter mindestens {MIN_DAYS} Tage Preisverlauf in {land}, bisher {days(result.days)}.
          </p>
        ) : (
          <>
            <div className="outlook-verdict">
              <OutlookArrow outlook={result.outlook} arrows={arrows} />
              <div>
                <b>{outlookText(result.outlook, money).lead}</b>
                <p>{outlookText(result.outlook, money).reason}</p>
              </div>
            </div>
            <OutlookChart outlook={result.outlook} />
            <div className="gauge-legend">
              <div>
                <Label>Trend 3 W</Label>
                <b>
                  {result.outlook.perWeek === null
                    ? '–'
                    : `${result.outlook.perWeek < 0 ? '−' : result.outlook.perWeek > 0 ? '+' : '±'}${Math.abs(Math.round(result.outlook.perWeek * 1000) / 10).toLocaleString('de-DE')} %/W`}
                </b>
              </div>
              <div>
                <Label>Üblich</Label>
                <b>{money(result.outlook.usual)}</b>
              </div>
              <div>
                <Label>Rabatte 90 T</Label>
                <b>{result.outlook.discounts.length}</b>
              </div>
              <div>
                <Label>Rhythmus</Label>
                <b>{result.outlook.meanGap !== null ? `≈ ${Math.round(result.outlook.meanGap)} T` : '–'}</b>
              </div>
            </div>
            <p className="outlook-note muted">
              Schätzung aus dem Preisverlauf in {land} ({days(result.outlook.days)} mit Preis): Trend der letzten drei Wochen, Abstand zum üblichen Preis und
              Rhythmus früherer Rabatte. Keine Garantie.
            </p>
          </>
        )}
      </Inset>
    </Panel>
  );
}
