// A quoted payment can only complete while its quote is still valid — the
// outgoing payment created at /api/callback needs a live quote. So once the
// quote has expired, a transaction still sitting in PENDING or AWAITING_GRANT
// (i.e. the user never authorised, or abandoned the wallet consent) can never
// complete, even though the backend never observed an explicit failure.
//
// We surface that as a *derived* "Expired" state rather than a stored status:
// nothing actually failed, the quote just timed out, so the DB stays honest and
// no background job is needed to flip rows.

const LIVE_STATES = new Set(['PENDING', 'AWAITING_GRANT']);

export function isQuoteExpired(tx: { status: string; quoteExpiresAt: string | null }): boolean {
  if (!LIVE_STATES.has(tx.status)) return false;     // terminal already (COMPLETED/FAILED)
  if (!tx.quoteExpiresAt) return false;              // no expiry recorded — leave as-is
  return new Date(tx.quoteExpiresAt).getTime() < Date.now();
}
