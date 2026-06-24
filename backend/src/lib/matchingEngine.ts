import { and, or, eq, gt, sql, isNull, desc } from 'drizzle-orm';
import { db } from '../db';
import { pledges } from '../db/schema';
import type { Donation } from '../db/schema';
import { createDonation } from './donationEngine';

// ─────────────────────────────────────────────────────────────────────────────
// matchingEngine — on a win, find a sponsor and donate the winnings-over-wager.
//
// A win on a wager is worth `matchAmount` of sponsor money to the player's chosen
// charity. We find an ACTIVE pledge that backs that charity (or backs "any"
// charity) with pool left, atomically reserve the amount against its pool (so two
// concurrent wins can't overspend it), then create the SPONSOR_MATCH donation
// from the sponsor's pre-approved pledge grant. If nothing covers it, the win is
// honestly recorded as unmatched — the player's wager was still donated.
// ─────────────────────────────────────────────────────────────────────────────

export interface MatchResult {
  matched:   boolean;
  amount:    number;            // sponsor money actually committed (0 if unmatched)
  partial:   boolean;           // true if pool covered only part of the win
  pledgeId:  string | null;
  donation:  Donation | null;
  reason?:   string;            // why nothing was matched, for the receipt
}

const UNMATCHED = (reason: string): MatchResult =>
  ({ matched: false, amount: 0, partial: false, pledgeId: null, donation: null, reason });

// Take a pledge out of future matching. Used when its sponsor grant is exhausted
// or expired so a dead pledge can't be picked again — the player simply keeps
// playing UNMATCHED (their wager still funds the charity).
async function retirePledge(pledgeId: string): Promise<void> {
  await db.update(pledges).set({ status: 'DEPLETED', updatedAt: new Date() }).where(eq(pledges.id, pledgeId));
}

// Always resolves — never throws. A sponsor-match failure must NEVER block the
// player's round (especially Pachinko cash-out, which awaits this). On any
// failure it returns an UNMATCHED result and the play proceeds with no match.
export async function settleMatch(
  matchAmount: number,
  charity:     { id: string; walletAddress: string },
  links:       { sessionId?: string; roundId?: string; userId?: string },
): Promise<MatchResult> {
  try {
    if (matchAmount <= 0) return UNMATCHED('No sponsor needed');

    // Eligible: ACTIVE, backs this charity (or any), with pool remaining. Pick the
    // one with the most room so we're most likely to cover the win in full.
    const [pledge] = await db
      .select()
      .from(pledges)
      .where(and(
        eq(pledges.status, 'ACTIVE'),
        or(eq(pledges.charityId, charity.id), isNull(pledges.charityId)),
        gt(sql`${pledges.poolLimit} - ${pledges.poolSpent}`, 0),
      ))
      .orderBy(desc(sql`${pledges.poolLimit} - ${pledges.poolSpent}`))
      .limit(1);

    if (!pledge) return UNMATCHED('No sponsor is matching this charity right now');

    // A pledge that's ACTIVE but has no usable grant token can't pay — retire it.
    if (!pledge.grantAccessToken) {
      await retirePledge(pledge.id);
      return UNMATCHED('Sponsor pool is no longer available');
    }

    const remaining = pledge.poolLimit - pledge.poolSpent;
    const payAmount = Math.min(matchAmount, remaining);
    const partial   = payAmount < matchAmount;

    // Atomically reserve against the pool — only succeeds if the room is still there.
    const reserved = await db
      .update(pledges)
      .set({ poolSpent: sql`${pledges.poolSpent} + ${payAmount}`, updatedAt: new Date() })
      .where(and(
        eq(pledges.id, pledge.id),
        eq(pledges.status, 'ACTIVE'),
        sql`${pledges.poolLimit} - ${pledges.poolSpent} >= ${payAmount}`,
      ));
    if (reserved.rowsAffected === 0) return UNMATCHED('Sponsor pool was claimed by another win — try again');

    console.log(
      `[match] charity=${charity.id} → pledge=${pledge.id} (sponsor=${pledge.sponsorId}): ` +
      `paying ${payAmount} ${pledge.assetCode} (scale ${pledge.assetScale}) ` +
      `from pool ${pledge.poolSpent}/${pledge.poolLimit}; wanted matchAmount=${matchAmount}${partial ? ' [PARTIAL]' : ''}`,
    );

    const result = await createDonation({
      accessToken:      pledge.grantAccessToken,
      senderWalletUrl:  pledge.walletAddress,
      charityWalletUrl: charity.walletAddress,
      amount:           payAmount,
      kind:             'SPONSOR_MATCH',
      links: {
        pledgeId:  pledge.id,
        sessionId: links.sessionId,
        roundId:   links.roundId,
        userId:    links.userId,
        charityId: charity.id,
      },
      // If the pledge token has gone inactive, rotate it and retry — a pledge can
      // sit idle for a long time before a player wins on its charity.
      manageUrl:      pledge.grantManageUrl,
      onTokenRotated: async (accessToken, manageUrl) => {
        await db
          .update(pledges)
          .set({ grantAccessToken: accessToken, grantManageUrl: manageUrl, updatedAt: new Date() })
          .where(eq(pledges.id, pledge.id));
      },
    });

    if (!result.ok) {
      // The sponsor's grant most likely ran out or expired. Release the reservation
      // AND retire the pledge so it's never retried — every later win on this
      // charity cleanly resolves as unmatched instead of failing again.
      console.error(
        `[match] SPONSOR MATCH FAILED → retiring pledge ${pledge.id} (DEPLETED). ` +
        `sponsor=${pledge.sponsorId} wallet=${pledge.walletAddress} ` +
        `pool=${pledge.poolSpent}/${pledge.poolLimit} ${pledge.assetCode} (scale ${pledge.assetScale}) charity=${charity.id}. ` +
        `Most likely an expired or exhausted pool grant — see the [donation] block above for the exact OP error.`,
      );
      await db
        .update(pledges)
        .set({ poolSpent: sql`${pledges.poolSpent} - ${payAmount}`, updatedAt: new Date() })
        .where(eq(pledges.id, pledge.id));
      await retirePledge(pledge.id);
      return { matched: false, amount: 0, partial: false, pledgeId: pledge.id, donation: result.donation, reason: 'Sponsor grant unavailable — playing unmatched' };
    }

    // Mark the pool depleted once it's exhausted, so it drops out of future matches.
    if (remaining - payAmount <= 0) await retirePledge(pledge.id);

    return { matched: true, amount: payAmount, partial, pledgeId: pledge.id, donation: result.donation };
  } catch (err) {
    console.error('[match] settleMatch failed (playing unmatched):', err instanceof Error ? err.message : err);
    return UNMATCHED('Sponsor match unavailable');
  }
}
