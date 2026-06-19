// Shared money formatting. Open Payments amounts come in two shapes:
//   • smallest unit ("minor") — an integer string like "1234" plus an assetScale
//     (e.g. 2 for cents), which is how the API returns transaction amounts;
//   • major unit — a decimal string like "0.10" used for human-set news prices.
// Views import these instead of redefining a local `fmt`.

/** Format a smallest-unit amount as "12.34 USD". Returns "—" for null/empty. */
export function formatMoney(value: string | null, assetCode: string, assetScale: number): string {
  if (value == null || value === '') return '—';
  return `${(Number(value) / 10 ** assetScale).toFixed(assetScale)} ${assetCode}`;
}

/** Format an already-major-unit price (e.g. "0.10") as "0.10 USD". */
export function formatPrice(major: string, assetCode: string, assetScale: number): string {
  return `${Number(major).toFixed(assetScale)} ${assetCode}`;
}
