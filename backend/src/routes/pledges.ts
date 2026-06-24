import { Router } from 'express';
import crypto from 'node:crypto';
import { eq, and, desc, inArray, sql, count, countDistinct } from 'drizzle-orm';
import { db } from '../db';
import { pledges, charities, donations, users } from '../db/schema';
import type { Pledge, Donation } from '../db/schema';
import { getClient, normaliseWalletAddress } from '../lib/openPayments';
import { requestPoolGrant } from '../lib/grantFlow';
import { config } from '../config';
import { requireAuth } from '../middleware/requireAuth';

export const pledgesRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// View shapers — serialise DB rows into the API shapes from the contract.
// A pledge is the sponsor analogue of a play_session: one pre-approved grant
// whose debitAmount limit IS the matching pool. SPONSOR_MATCH donations draw it
// down whenever a player wins.
// ─────────────────────────────────────────────────────────────────────────────

function donationView(d: Donation) {
  return {
    id: d.id,
    kind: d.kind,
    amount: d.amount,
    assetCode: d.assetCode,
    assetScale: d.assetScale,
    status: d.status,
    charityId: d.charityId,
    roundId: d.roundId,
    outgoingPaymentUrl: d.outgoingPaymentUrl,
    createdAt: d.createdAt,
  };
}

function pledgeView(p: Pledge, charityName: string, recentMatches: Donation[]) {
  return {
    id: p.id,
    charityId: p.charityId,
    charityName,
    poolLimit: p.poolLimit,
    poolSpent: p.poolSpent,
    remaining: p.poolLimit - p.poolSpent,
    status: p.status,
    createdAt: p.createdAt,
    recentMatches: recentMatches.map(donationView),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pledges — open a matching pool + request the sponsor's grant.
// ─────────────────────────────────────────────────────────────────────────────
pledgesRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    // `pool` is in MAJOR units (e.g. 100 = 100.00 of the wallet's currency); we
    // convert to the smallest unit after resolving the wallet's assetScale below.
    const { charityId, pool } = req.body as { charityId?: string | null; pool?: number };

    if (typeof pool !== 'number' || !Number.isFinite(pool) || pool < 1) {
      res.status(400).json({ error: 'pool must be a number >= 1' });
      return;
    }

    const user = await db.select().from(users).where(eq(users.id, req.user!.id)).get();
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (!user.walletAddress) {
      res.status(400).json({ error: 'Add a wallet address to your profile before opening a pledge' });
      return;
    }

    // charityId is optional: null/omitted = "match any charity". When supplied,
    // it must reference a real charity.
    let resolvedCharityId: string | null = null;
    if (charityId !== undefined && charityId !== null) {
      const charity = await db.select().from(charities).where(eq(charities.id, charityId)).get();
      if (!charity) {
        res.status(400).json({ error: 'Unknown charity' });
        return;
      }
      resolvedCharityId = charity.id;
    }

    // Resolve the sponsor's wallet to learn its asset code/scale.
    const client = await getClient();
    const w = await client.walletAddress.get({ url: normaliseWalletAddress(user.walletAddress) });

    // Major → smallest unit, now that we know the wallet's scale.
    const poolLimit = Math.round(pool * 10 ** w.assetScale);

    const id = crypto.randomUUID();
    const now = new Date();

    await db.insert(pledges).values({
      id,
      sponsorId: req.user!.id,
      walletAddress: w.id,
      charityId: resolvedCharityId,
      poolLimit,
      poolSpent: 0,
      assetCode: w.assetCode,
      assetScale: w.assetScale,
      status: 'AWAITING_GRANT',
      createdAt: now,
      updatedAt: now,
    });

    const nonce = crypto.randomUUID();
    const callbackUrl = `${config.backendUrl}/api/callback?grantType=pledge&id=${id}`;
    const grant = await requestPoolGrant(w, poolLimit, callbackUrl, nonce);

    await db
      .update(pledges)
      .set({
        grantContinueUri: grant.continueUri,
        grantContinueToken: grant.continueToken,
        grantInteractNonce: nonce,
        updatedAt: new Date(),
      })
      .where(eq(pledges.id, id));

    res.status(201).json({ pledgeId: id, interactUrl: grant.interactUrl });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pledges — the sponsor's pledges + lifetime matching stats.
// ─────────────────────────────────────────────────────────────────────────────
pledgesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const myPledges = await db
      .select()
      .from(pledges)
      .where(eq(pledges.sponsorId, req.user!.id))
      .orderBy(desc(pledges.createdAt));

    // Resolve charity names once (only for pledges that target a specific charity).
    const charityIds = [
      ...new Set(myPledges.map((p) => p.charityId).filter((c): c is string => c != null)),
    ];
    const charityRows = charityIds.length
      ? await db.select().from(charities).where(inArray(charities.id, charityIds))
      : [];
    const charityNameById = new Map(charityRows.map((c) => [c.id, c.name]));

    // Build each PledgeView with its 5 newest SPONSOR_MATCH donations.
    const views = [];
    for (const p of myPledges) {
      const recentMatches = await db
        .select()
        .from(donations)
        .where(and(eq(donations.pledgeId, p.id), eq(donations.kind, 'SPONSOR_MATCH')))
        .orderBy(desc(donations.createdAt))
        .limit(5);

      const charityName = p.charityId != null
        ? charityNameById.get(p.charityId) ?? 'Any charity'
        : 'Any charity';

      views.push(pledgeView(p, charityName, recentMatches));
    }

    // Lifetime stats over this sponsor's COMPLETED matches.
    const pledgeIds = myPledges.map((p) => p.id);
    let totalMatched = 0;
    let matchesCount = 0;
    let charitiesHelped = 0;
    if (pledgeIds.length) {
      const statRow = await db
        .select({
          totalMatched: sql<number>`sum(${donations.amount})`,
          matchesCount: count(),
          charitiesHelped: countDistinct(donations.charityId),
        })
        .from(donations)
        .where(
          and(
            inArray(donations.pledgeId, pledgeIds),
            eq(donations.kind, 'SPONSOR_MATCH'),
            eq(donations.status, 'COMPLETED'),
          ),
        )
        .get();

      totalMatched = Number(statRow?.totalMatched ?? 0);
      matchesCount = Number(statRow?.matchesCount ?? 0);
      charitiesHelped = Number(statRow?.charitiesHelped ?? 0);
    }

    res.json({
      pledges: views,
      stats: { totalMatched, matchesCount, charitiesHelped },
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pledges/:id/end — close a pool (must own; ACTIVE or DEPLETED).
// Conditional UPDATE guarded by ownership + status, then check rowsAffected.
// ─────────────────────────────────────────────────────────────────────────────
pledgesRouter.post('/:id/end', requireAuth, async (req, res, next) => {
  try {
    const result = await db
      .update(pledges)
      .set({ status: 'ENDED', updatedAt: new Date() })
      .where(
        and(
          eq(pledges.id, req.params.id),
          eq(pledges.sponsorId, req.user!.id),
          inArray(pledges.status, ['ACTIVE', 'DEPLETED']),
        ),
      );

    if (result.rowsAffected === 0) {
      res.status(409).json({ error: 'Pledge not found' });
      return;
    }

    res.json({ status: 'ENDED' });
  } catch (err) {
    next(err);
  }
});
