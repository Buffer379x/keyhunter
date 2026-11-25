// Price outlook of the game page (1.1.3): a cautious estimate from the saved price history only, no outside data and no
// invented numbers. Three signals of the daily lowest target-country price over the last 90 days:
//  - trend: the robust slope (Theil–Sen, the median of all pairwise slopes) of the last 21 days, in % of the usual price per
//    week; single outliers do not move it.
//  - usual price: the median of the daily prices; a day 10 % or more below it is a discount day, consecutive ones that start
//    with a sudden drop (5 % of the usual price from one day to the next) a discount.
//  - discounts: how many, how long on average and how far apart their starts were.
// Rules, in this order: a discount running now will most likely end ("eher steigend"), a clear trend continues, a discount
// that is due by the past rhythm makes a fall likely, otherwise the price stays. The confidence grows with the days of history
// and with the number of past discounts a rule relies on.

export const OUTLOOK_DAYS = 90;
/** Days of history before any outlook. */
export const MIN_DAYS = 14;
/** Days of the trend window. */
const TREND_DAYS = 21;
/** Change of the usual price per week from which the trend counts as rising or falling. */
const TREND_SHARE = 0.015;
/** Share below the usual price from which a day counts as a discount day. */
const DISCOUNT_SHARE = 0.1;
/** Drop from one priced day to the next, as a share of the usual price, that starts a discount. */
const DROP_SHARE = 0.05;

type Confidence = 'gering' | 'mittel' | 'hoch';
type Direction = 'falling' | 'rising' | 'stable';
interface Discount {
  /** Days back of the first and the last discount day (0 = today). */
  from: number;
  to: number;
  low: number;
}
export interface Outlook {
  direction: Direction;
  confidence: Confidence;
  /** The rule that decided it, for the sentence below the verdict. */
  rule: 'discount_now' | 'trend' | 'discount_due' | 'steady';
  /** Daily lowest price, oldest first (index 0 = `OUTLOOK_DAYS - 1` days back), null for a day without a valid price. */
  daily: (number | null)[];
  /** Days with a price. */
  days: number;
  usual: number;
  low: number;
  now: number;
  /** Trend of the last 21 days: change per week as a share of the usual price (negative = falling); null with too few days. */
  perWeek: number | null;
  discounts: Discount[];
  /** Mean length of the finished discounts and mean distance between discount starts, in days; null without enough of them. */
  meanLength: number | null;
  meanGap: number | null;
}
export type OutlookResult = { kind: 'outlook'; outlook: Outlook } | { kind: 'too_little'; days: number };

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

/** Theil–Sen slope in cents per day of the points (day index, cents). */
function slope(points: [number, number][]): number | null {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) slopes.push((points[j][1] - points[i][1]) / (points[j][0] - points[i][0]));
  return slopes.length ? median(slopes) : null;
}

/**
 * Discounts: runs of discount days that start with a drop. A discount starts from one priced day to the next by at least
 * `DROP_SHARE` of the usual price; a price that slides down slowly is a trend, not a discount, and its low days start
 * nothing. A day without a price ends nothing, it is skipped.
 */
function discountRuns(daily: (number | null)[], usual: number): Discount[] {
  const runs: Discount[] = [];
  let open: Discount | null = null;
  let low = false;
  let before: number | null = null;
  daily.forEach((cents, index) => {
    if (cents === null) return;
    const back = daily.length - 1 - index;
    if (cents <= usual * (1 - DISCOUNT_SHARE)) {
      if (open) {
        open.to = back;
        open.low = Math.min(open.low, cents);
      } else if (!low && before !== null && before - cents >= usual * DROP_SHARE) open = { from: back, to: back, low: cents };
      low = true;
    } else {
      if (open) runs.push(open);
      open = null;
      low = false;
    }
    before = cents;
  });
  if (open) runs.push(open);
  return runs;
}

const lower = (confidence: Confidence): Confidence => (confidence === 'hoch' ? 'mittel' : 'gering');

/**
 * The outlook from the daily lowest target-country price of the last `OUTLOOK_DAYS` days (oldest first, today last; the price
 * tab takes them from `history-model.columns`) and the current best price; null without a current price.
 */
export function priceOutlook(daily: (number | null)[], current: number | null): OutlookResult | null {
  if (current === null) return null;
  const priced = daily.filter((cents): cents is number => cents !== null);
  if (priced.length < MIN_DAYS) return { kind: 'too_little', days: priced.length };
  const usual = median(priced);
  const low = Math.min(...priced);
  const recent: [number, number][] = daily.flatMap((cents, index) => (cents !== null && index >= daily.length - TREND_DAYS ? [[index, cents]] : []));
  const perDay = recent.length >= 7 ? slope(recent) : null;
  const perWeek = perDay === null ? null : (perDay * 7) / usual;
  const discounts = discountRuns(daily, usual);
  const running = discounts.length > 0 && discounts[discounts.length - 1].to === 0 && current <= usual * (1 - DISCOUNT_SHARE);
  const past = running ? discounts.slice(0, -1) : discounts;
  const meanLength = mean(past.map(run => run.from - run.to + 1));
  const starts = discounts.map(run => run.from);
  const meanGap = starts.length >= 2 ? mean(starts.slice(1).map((start, i) => starts[i] - start)) : null;
  const base: Confidence = priced.length >= 60 ? 'hoch' : priced.length >= 30 ? 'mittel' : 'gering';
  const shape = { daily, days: priced.length, usual, low, now: current, perWeek, discounts, meanLength, meanGap };

  let decided: Pick<Outlook, 'direction' | 'confidence' | 'rule'>;
  if (running) decided = { direction: 'rising', rule: 'discount_now', confidence: past.length >= 2 ? base : lower(base) };
  else if (perWeek !== null && Math.abs(perWeek) >= TREND_SHARE)
    decided = { direction: perWeek < 0 ? 'falling' : 'rising', rule: 'trend', confidence: recent.length >= 14 ? base : lower(base) };
  else if (meanGap !== null && past.length >= 2 && past[past.length - 1].to >= meanGap * 0.8 - (meanLength ?? 0))
    decided = { direction: 'falling', rule: 'discount_due', confidence: past.length >= 3 ? lower(base) : 'gering' };
  else decided = { direction: 'stable', rule: 'steady', confidence: base };
  return { kind: 'outlook', outlook: { ...shape, ...decided } };
}

/** Whole days, "1 Tag" / "5 Tage". */
export const days = (count: number) => `${Math.round(count)} ${Math.round(count) === 1 ? 'Tag' : 'Tage'}`;
/** After "seit" and "vor": "1 Tag" / "5 Tagen". */
const daysAgo = (count: number) => `${Math.round(count)} ${Math.round(count) === 1 ? 'Tag' : 'Tagen'}`;
const percent = (share: number) => `${Math.round(Math.abs(share) * 100)} %`;

/** Verdict and the sentence that explains it. */
export function outlookText(outlook: Outlook, money: (cents: number) => string): { lead: string; reason: string } {
  const lead = outlook.direction === 'falling' ? 'Eher fallend' : outlook.direction === 'rising' ? 'Eher steigend' : 'Eher stabil';
  const lastDiscount = outlook.discounts[outlook.discounts.length - 1];
  switch (outlook.rule) {
    case 'discount_now':
      return {
        lead,
        reason:
          `Gerade Rabatt: ${percent((outlook.usual - outlook.now) / outlook.usual)} unter dem üblichen Preis von ${money(outlook.usual)}.` +
          (outlook.meanLength !== null
            ? ` Frühere Rabatte hielten im Schnitt ${days(outlook.meanLength)}, dieser läuft seit ${daysAgo(lastDiscount.from + 1)}.`
            : ' Es ist der erste Rabatt im Verlauf.'),
      };
    case 'trend':
      return { lead, reason: `Der Preis ${outlook.perWeek! < 0 ? 'sinkt' : 'steigt'} seit drei Wochen um etwa ${percent(outlook.perWeek!)} pro Woche.` };
    case 'discount_due':
      return {
        lead,
        reason: `Rabatte kamen bisher etwa alle ${days(outlook.meanGap!)}, zuletzt vor ${daysAgo(lastDiscount.to)}. Der nächste wäre bald fällig.`,
      };
    case 'steady':
      return {
        lead,
        reason:
          outlook.perWeek !== null
            ? `Der Preis bewegt sich seit drei Wochen kaum (unter ${(TREND_SHARE * 100).toLocaleString('de-DE')} % pro Woche).`
            : 'Zu wenige Preise der letzten drei Wochen für einen Trend.',
      };
  }
}
