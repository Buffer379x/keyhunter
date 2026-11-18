export function parseFeePercent(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return bps <= 10000 ? bps : null;
}
export function formatFeePercent(bps: number): string {
  return (bps / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
