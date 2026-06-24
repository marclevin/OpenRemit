// Shared money formatting. GoodWager amounts are integers in the smallest asset
// unit (e.g. cents) with an assetScale (e.g. 2). Views import these instead of
// redefining a local formatter.

/** Format a smallest-unit amount as "12.34 USD". Returns "—" for null/undefined. */
export function formatMoney(value: number | string | null | undefined, assetCode: string, assetScale: number): string {
  if (value == null || value === '') return '—';
  return `${(Number(value) / 10 ** assetScale).toFixed(assetScale)} ${assetCode}`;
}

/** Just the number, no currency code: "12.34". */
export function formatAmount(value: number | string | null | undefined, assetScale: number): string {
  if (value == null || value === '') return '—';
  return (Number(value) / 10 ** assetScale).toFixed(assetScale);
}

/** Parse a major-unit input string (e.g. "5" or "5.50") into smallest units (550). */
export function toMinor(major: string, assetScale: number): number {
  const n = Number(major);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 10 ** assetScale);
}
