import { api, SessionView, DonationView } from '../api';
import { renderBankroll } from './arcade';
import type { Ledger } from './arcade';

// Shared receipt plumbing for the games. The receipt shows the WHOLE session's
// donations — every wager and every sponsor match across every round — so it
// persists as you keep playing (and after navigating away and back). It also
// keeps the bankroll HUD in sync with the authoritative session.

/** Fetch the session, render its full donation list + bankroll. Returns the donations. */
export async function refreshSessionReceipt(
  session: SessionView,
  ledger: Ledger,
  hudEl: HTMLElement,
): Promise<DonationView[]> {
  const detail = await api.sessions.get(session.id);
  ledger.show(detail.donations, session.assetCode, session.assetScale);
  session.remaining        = detail.session.remaining;
  session.bankrollSpent    = detail.session.bankrollSpent;
  session.bankrollReserved = detail.session.bankrollReserved;
  renderBankroll(hudEl, session);
  return detail.donations;
}

/**
 * Poll the session receipt until the given round's wager — and, when a win is
 * expected, its SPONSOR_MATCH — have settled (or give up after ~22s). This is
 * what makes the sponsor donation appear: it's created in the background a beat
 * AFTER the wager completes, so a naive "stop once everything is COMPLETED" check
 * stops too early and never shows it. Returns a cancel() function.
 */
export function pollSessionReceipt(
  session: SessionView,
  ledger: Ledger,
  hudEl: HTMLElement,
  roundId: string,
  expectsMatch: boolean,
): () => void {
  const POLL_MS = 1500;
  const POLL_MAX = 15;
  let tries = 0;
  let timer = 0;

  const stop = (): void => { if (timer) { window.clearInterval(timer); timer = 0; } };

  const tick = async (): Promise<void> => {
    tries++;
    try {
      const donations = await refreshSessionReceipt(session, ledger, hudEl);
      const roundDons = donations.filter((d) => d.roundId === roundId);
      const wagerDone = roundDons.some((d) => d.kind === 'USER_WAGER' && d.status !== 'PENDING');
      const matchDone = roundDons.some((d) => d.kind === 'SPONSOR_MATCH' && d.status !== 'PENDING');
      if ((wagerDone && (!expectsMatch || matchDone)) || tries >= POLL_MAX) stop();
    } catch {
      if (tries >= POLL_MAX) stop();
    }
  };

  void tick();
  timer = window.setInterval(() => { void tick(); }, POLL_MS);
  return stop;
}
