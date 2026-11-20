/** German relative time for a Unix timestamp in seconds: "gerade eben", "vor 5 Min.", "vor 2 Std.", "vor 3 T". */
export function relativeTime(seconds: number, nowMs: number = Date.now()): string {
  const diff = Math.max(0, Math.floor(nowMs / 1000 - seconds));
  if (diff < 60) return 'gerade eben';
  if (diff < 3600) return `vor ${Math.floor(diff / 60)} Min.`;
  if (diff < 86400) return `vor ${Math.floor(diff / 3600)} Std.`;
  return `vor ${Math.floor(diff / 86400)} T`;
}
