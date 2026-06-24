import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { playSessions, gameRounds, charities } from '../db/schema';
import type { PlaySession, GameRound, Charity } from '../db/schema';
import { createDonation } from './donationEngine';
import { settleMatch } from './matchingEngine';
import type { MatchResult } from './matchingEngine';

// ─────────────────────────────────────────────────────────────────────────────
// playEngine — the ledger orchestrator. Owns ALL bankroll accounting so routes
// never touch the money math directly.
//
//   remaining playable = bankrollLimit − bankrollSpent − bankrollReserved
//
//   • reserveWager   — atomically parks a wager against the bankroll (or refuses
//                       if the budget is gone). Done synchronously at play time.
//   • settleImmediate — Rocket/Plane: donate the wager now, plus the sponsor match
//                       on a win. Reserved → Spent on success; released on failure.
//   • settlePachinko  — Pachinko cash-out: ONE aggregated wager donation for all
//                       parked drops + a sponsor match per winning drop
//                       ("outgoing only on game end").
//   • endSession      — flush any parked Pachinko drops, then mark the run ENDED.
//
// Settlement does real network I/O (Open Payments), so routes call it in the
// background (fire-and-forget) and the client polls the round/session for the
// receipt. Reservation, which guards the budget, is always synchronous.
// ─────────────────────────────────────────────────────────────────────────────

export function remainingPlayable(s: Pick<PlaySession, 'bankrollLimit' | 'bankrollSpent' | 'bankrollReserved'>): number {
  return s.bankrollLimit - s.bankrollSpent - s.bankrollReserved;
}

/** Atomically park `wager` against the bankroll. Returns false if the budget can't cover it. */
export async function reserveWager(sessionId: string, wager: number): Promise<boolean> {
  const res = await db
    .update(playSessions)
    .set({ bankrollReserved: sql`${playSessions.bankrollReserved} + ${wager}`, updatedAt: new Date() })
    .where(and(
      eq(playSessions.id, sessionId),
      eq(playSessions.status, 'ACTIVE'),
      sql`${playSessions.bankrollLimit} - ${playSessions.bankrollSpent} - ${playSessions.bankrollReserved} >= ${wager}`,
    ));
  return res.rowsAffected === 1;
}

async function commitReservedToSpent(sessionId: string, amount: number): Promise<void> {
  await db
    .update(playSessions)
    .set({
      bankrollReserved: sql`${playSessions.bankrollReserved} - ${amount}`,
      bankrollSpent:    sql`${playSessions.bankrollSpent} + ${amount}`,
      updatedAt:        new Date(),
    })
    .where(eq(playSessions.id, sessionId));
}

async function releaseReservation(sessionId: string, amount: number): Promise<void> {
  await db
    .update(playSessions)
    .set({ bankrollReserved: sql`${playSessions.bankrollReserved} - ${amount}`, updatedAt: new Date() })
    .where(eq(playSessions.id, sessionId));
}

async function loadCharity(charityId: string): Promise<Charity | undefined> {
  const [c] = await db.select().from(charities).where(eq(charities.id, charityId));
  return c;
}

// Donate one round's wager from the session's pre-approved bankroll grant.
// Persist a rotated pool token back onto the session row, so subsequent rounds
// reuse the fresh token instead of rotating again.
function sessionTokenRotated(sessionId: string) {
  return async (accessToken: string, manageUrl: string): Promise<void> => {
    await db
      .update(playSessions)
      .set({ grantAccessToken: accessToken, grantManageUrl: manageUrl, updatedAt: new Date() })
      .where(eq(playSessions.id, sessionId));
  };
}

async function settleWager(session: PlaySession, charity: Charity, round: GameRound): Promise<void> {
  const result = await createDonation({
    accessToken:      session.grantAccessToken!,
    senderWalletUrl:  session.walletAddress,
    charityWalletUrl: charity.walletAddress,
    amount:           round.wager,
    kind:             'USER_WAGER',
    links: { sessionId: session.id, roundId: round.id, userId: session.userId, charityId: charity.id },
    manageUrl:        session.grantManageUrl,
    onTokenRotated:   sessionTokenRotated(session.id),
  });

  if (result.ok) await commitReservedToSpent(session.id, round.wager);
  else           await releaseReservation(session.id, round.wager);

  await db.update(gameRounds).set({ settled: true, updatedAt: new Date() }).where(eq(gameRounds.id, round.id));
}

/**
 * Settle a Rocket/Plane round: donate the wager, then (on a win) draw the sponsor
 * match. Safe to call in the background; idempotent-ish via the `settled` flag.
 */
export async function settleImmediate(roundId: string): Promise<MatchResult | null> {
  const [round] = await db.select().from(gameRounds).where(eq(gameRounds.id, roundId));
  if (!round || round.settled) return null;
  const [session] = await db.select().from(playSessions).where(eq(playSessions.id, round.sessionId));
  if (!session) return null;
  const charity = await loadCharity(session.charityId);
  if (!charity) return null;

  await settleWager(session, charity, round);

  // Rocket matches are ALWAYS settled at cash-out (see routes/games.ts), never
  // here — the immediate settler only ever donates a Rocket round's wager. This
  // guard makes a double-match impossible even if this runs after a fast cash-out.
  if (round.game !== 'ROCKET' && round.outcome === 'WIN' && round.matchAmount > 0) {
    return settleMatch(round.matchAmount, { id: charity.id, walletAddress: charity.walletAddress }, {
      sessionId: session.id, roundId: round.id, userId: session.userId,
    });
  }
  return null;
}

export interface PachinkoSettlement {
  totalWager:   number;
  drops:        number;
  matches:      MatchResult[];
  totalMatched: number;
}

/**
 * Pachinko cash-out: ONE wager donation covering every parked drop, plus a
 * sponsor match per winning drop. This is the "outgoing only on game end" rule.
 */
export async function settlePachinko(sessionId: string): Promise<PachinkoSettlement> {
  const [session] = await db.select().from(playSessions).where(eq(playSessions.id, sessionId));
  if (!session) return { totalWager: 0, drops: 0, matches: [], totalMatched: 0 };
  const charity = await loadCharity(session.charityId);
  if (!charity) return { totalWager: 0, drops: 0, matches: [], totalMatched: 0 };

  const parked = await db
    .select()
    .from(gameRounds)
    .where(and(
      eq(gameRounds.sessionId, sessionId),
      eq(gameRounds.game, 'PACHINKO'),
      eq(gameRounds.settled, false),
    ));

  if (parked.length === 0) return { totalWager: 0, drops: 0, matches: [], totalMatched: 0 };

  const totalWager = parked.reduce((sum, r) => sum + r.wager, 0);

  // One aggregated wager donation for the whole batch.
  const userResult = await createDonation({
    accessToken:      session.grantAccessToken!,
    senderWalletUrl:  session.walletAddress,
    charityWalletUrl: charity.walletAddress,
    amount:           totalWager,
    kind:             'USER_WAGER',
    links: { sessionId: session.id, userId: session.userId, charityId: charity.id },
    manageUrl:        session.grantManageUrl,
    onTokenRotated:   sessionTokenRotated(session.id),
  });
  if (userResult.ok) await commitReservedToSpent(session.id, totalWager);
  else               await releaseReservation(session.id, totalWager);

  // Mark every parked drop settled.
  for (const r of parked) {
    await db.update(gameRounds).set({ settled: true, updatedAt: new Date() }).where(eq(gameRounds.id, r.id));
  }

  // A sponsor match per winning drop.
  const matches: MatchResult[] = [];
  for (const r of parked) {
    if (r.outcome === 'WIN' && r.matchAmount > 0) {
      matches.push(await settleMatch(r.matchAmount, { id: charity.id, walletAddress: charity.walletAddress }, {
        sessionId: session.id, roundId: r.id, userId: session.userId,
      }));
    }
  }

  const totalMatched = matches.reduce((sum, m) => sum + m.amount, 0);
  return { totalWager, drops: parked.length, matches, totalMatched };
}

/** Flush any parked Pachinko drops, then end the run. */
export async function endSession(sessionId: string): Promise<void> {
  await settlePachinko(sessionId);
  await db
    .update(playSessions)
    .set({ status: 'ENDED', updatedAt: new Date() })
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.status, 'ACTIVE')));
}
