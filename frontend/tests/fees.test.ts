import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeePercent, formatFeePercent } from '../src/fees.ts';

test('German decimal input preserves hundredths as integer basis points', () => {
  for (const [input, expected] of [['2,50', 250], ['1.01', 101], ['0', 0], ['100,00', 10000], [' 3,2 ', 320]] as const) {
    assert.equal(parseFeePercent(input), expected);
  }
});
test('invalid, negative and excessive precision never silently round into a fee', () => {
  for (const input of ['', '-1', '1,001', '100.01', 'Infinity', '1e2', '2,5.0', 'NaN']) assert.equal(parseFeePercent(input), null);
});
test('saved fee can be edited again without changing its value', () => {
  assert.equal(formatFeePercent(101), '1,01');
  assert.equal(parseFeePercent(formatFeePercent(101)), 101);
});
