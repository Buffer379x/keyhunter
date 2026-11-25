import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_DAYS, OUTLOOK_DAYS, outlookText, priceOutlook } from '../src/features/price-outlook.ts';

const money = (cents: number) => `${(cents / 100).toFixed(2).replace('.', ',')} €`;
/** 90 daily prices, oldest first, from `price(back)` (back = days before today). */
const daily = (price: (back: number) => number | null) => Array.from({ length: OUTLOOK_DAYS }, (_, i) => price(OUTLOOK_DAYS - 1 - i));
const inRun = (back: number, runs: [number, number][]) => runs.some(([from, to]) => back <= from && back >= to);
const outlook = (price: (back: number) => number | null, current: number) => {
  const result = priceOutlook(daily(price), current);
  assert.equal(result?.kind, 'outlook');
  return result.kind === 'outlook' ? result.outlook : (undefined as never);
};

test('price outlook: none without a current price, too little before 14 days with a price', () => {
  assert.equal(
    priceOutlook(
      daily(() => 3499),
      null,
    ),
    null,
  );
  assert.deepEqual(
    priceOutlook(
      daily(back => (back < MIN_DAYS - 1 ? 3499 : null)),
      3499,
    ),
    { kind: 'too_little', days: MIN_DAYS - 1 },
  );
});

test('price outlook: a discount running now will most likely end', () => {
  const o = outlook(
    back =>
      inRun(back, [
        [75, 71],
        [45, 41],
        [2, 0],
      ])
        ? 2599
        : 3499,
    2599,
  );
  assert.deepEqual([o.direction, o.rule, o.confidence, o.usual, o.discounts.length, o.meanLength], ['rising', 'discount_now', 'hoch', 3499, 3, 5]);
  assert.equal(
    outlookText(o, money).reason,
    'Gerade Rabatt: 26 % unter dem üblichen Preis von 34,99 €. Frühere Rabatte hielten im Schnitt 5 Tage, dieser läuft seit 3 Tagen.',
  );
  // The first discount of the history: less sure.
  const first = outlook(back => (back <= 2 ? 2599 : 3499), 2599);
  assert.deepEqual([first.rule, first.confidence], ['discount_now', 'mittel']);
  assert.match(outlookText(first, money).reason, /Es ist der erste Rabatt im Verlauf\.$/);
});

test('price outlook: a clear trend continues, a slow slide is no discount', () => {
  const falling = outlook(back => (back > 20 ? 3999 : Math.round(3299 + (700 * back) / 20)), 3299);
  assert.deepEqual([falling.direction, falling.rule, falling.confidence, falling.discounts.length], ['falling', 'trend', 'hoch', 0]);
  assert.ok(falling.perWeek! < -0.05 && falling.perWeek! > -0.07);
  assert.equal(outlookText(falling, money).reason, 'Der Preis sinkt seit drei Wochen um etwa 6 % pro Woche.');
  const rising = outlook(back => (back > 20 ? 2999 : Math.round(3599 - (600 * back) / 20)), 3599);
  assert.deepEqual([rising.direction, rising.rule], ['rising', 'trend']);
});

test('price outlook: a discount due by the past rhythm, otherwise stable', () => {
  const due = outlook(
    back =>
      inRun(back, [
        [86, 82],
        [56, 52],
        [26, 22],
      ])
        ? 2799
        : 3499,
    3499,
  );
  assert.deepEqual([due.direction, due.rule, due.confidence, due.meanGap], ['falling', 'discount_due', 'mittel', 30]);
  assert.equal(outlookText(due, money).reason, 'Rabatte kamen bisher etwa alle 30 Tage, zuletzt vor 22 Tagen. Der nächste wäre bald fällig.');
  // Right after a discount nothing is due yet.
  const after = outlook(
    back =>
      inRun(back, [
        [66, 62],
        [36, 32],
        [8, 4],
      ])
        ? 2799
        : 3499,
    3499,
  );
  assert.deepEqual([after.direction, after.rule], ['stable', 'steady']);
  // Single outliers do not make a trend; 40 days of history is "mittel".
  const steady = outlook(back => (back > 39 ? null : back === 5 ? 4999 : 3499), 3499);
  assert.deepEqual([steady.direction, steady.confidence, steady.perWeek], ['stable', 'mittel', 0]);
  assert.equal(outlookText(steady, money).reason, 'Der Preis bewegt sich seit drei Wochen kaum (unter 1,5 % pro Woche).');
});
