/**
 * The per-offer fields the backend derives (offers.rs, pricing::data_state / Verdict), for mocked offers views so the
 * screens show what the real server produces. `data_state`: failed (last_error), stale, unknown (never observed or
 * availability unknown), else current. `current`: a current price of its region whatever the target country (no
 * freshness, stock, price or key reason; activation does not matter). `fits_target`: no activation or market reason.
 */
type Offer = { reasons?: string[]; stale?: boolean; last_error?: string | null; observed_at?: number | null };
const NOT_CURRENT = [
  'stale',
  'source_error',
  'availability_unknown',
  'sold_out',
  'no_price',
  'not_a_key',
  'not_confirmed',
  'mismatch',
  'not_observed',
  'rejected',
  'source_disabled',
];
const NOT_TARGET = ['activation_blocked', 'activation_unknown', 'purchase_context_mismatch', 'no_target_country'];

export function withState<T extends Offer>(offer: T) {
  const reasons = offer.reasons ?? [];
  const state =
    offer.last_error || reasons.includes('source_error')
      ? 'failed'
      : offer.stale || reasons.includes('stale')
        ? 'stale'
        : reasons.includes('availability_unknown') || !offer.observed_at
          ? 'unknown'
          : 'current';
  return {
    data_state: state,
    current: !reasons.some(reason => NOT_CURRENT.includes(reason)) && state === 'current',
    fits_target: !reasons.some(reason => NOT_TARGET.includes(reason)),
    ...offer,
  };
}
