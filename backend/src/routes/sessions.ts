import { Router } from 'express';
import crypto from 'node:crypto';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db';
import { playSessions, gameRounds, donations, charities, users } from '../db/schema';
import type { PlaySession, GameRound, Donation, Charity } from '../db/schema';
import { getClient, normaliseWalletAddress } from '../lib/openPayments';
import { requestPoolGrant } from '../lib/grantFlow';
import { endSession, remainingPlayable } from '../lib/playEngine';
import { config } from '../config';
import { requireAuth } from '../middleware/requireAuth';

export const sessionsRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// View shapers — serialise DB rows into the API shapes from the contract.
// ─────────────────────────────────────────────────────────────────────────────

function charityView(c: Charity) {
  return {
    id: c.id,
    name: c.name,
    blurb: c.blurb,
    category: c.category,
    walletAddress: c.walletAddress,
    accentColor: c.accentColor,
  };
}

function sessionView(s: PlaySession, charity: Charity) {
  return {
    id: s.id,
    charityId: s.charityId,
    walletAddress: s.walletAddress,
    status: s.status,
    bankrollLimit: s.bankrollLimit,
    bankrollSpent: s.bankrollSpent,
    bankrollReserved: s.bankrollReserved,
    remaining: remainingPlayable(s),
    assetCode: s.assetCode,
    assetScale: s.assetScale,
    createdAt: s.createdAt,
    charity: charityView(charity),
  };
}

function roundView(r: GameRound) {
  // serverSeed is secret while a Rocket round is live (PENDING); reveal once resolved.
  return {
    id: r.id,
    sessionId: r.sessionId,
    game: r.game,
    wager: r.wager,
    multiplier: r.multiplier,
    matchAmount: r.matchAmount,
    outcome: r.outcome,
    settled: r.settled,
    createdAt: r.createdAt,
    serverSeedHash: r.serverSeedHash,
    clientSeed: r.clientSeed,
    nonce: r.nonce,
    ...(r.outcome !== 'PENDING' ? { serverSeed: r.serverSeed } : {}),
  };
}

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
    pledgeId: d.pledgeId,
    outgoingPaymentUrl: d.outgoingPaymentUrl,
    errorMessage: d.errorMessage,
    createdAt: d.createdAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sessions — open a funded run + request the bankroll grant.
// ─────────────────────────────────────────────────────────────────────────────
sessionsRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    // `bankroll` is in MAJOR units (e.g. 20 = 20.00 of the wallet's currency).
    // We convert to the smallest unit once we've resolved the wallet's assetScale
    // below — so the bankroll is correct for any currency, not just 2-dp ones.
    const { charityId, bankroll } = req.body as { charityId?: string; bankroll?: number };

    if (typeof bankroll !== 'number' || !Number.isFinite(bankroll) || bankroll < 1) {
      res.status(400).json({ error: 'bankroll must be a number >= 1' });
      return;
    }
    if (!charityId?.trim()) {
      res.status(400).json({ error: 'charityId is required' });
      return;
    }

    const user = await db.select().from(users).where(eq(users.id, req.user!.id)).get();
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (!user.walletAddress) {
      res.status(400).json({ error: 'Add a wallet address to your profile before starting a run' });
      return;
    }

    const charity = await db.select().from(charities).where(eq(charities.id, charityId)).get();
    if (!charity) {
      res.status(400).json({ error: 'Unknown charity' });
      return;
    }

    // Resolve the player's wallet to learn its asset code/scale.
    const client = await getClient();
    const w = await client.walletAddress.get({ url: normaliseWalletAddress(user.walletAddress) });

    // Major → smallest unit, now that we know the wallet's scale.
    const bankrollLimit = Math.round(bankroll * 10 ** w.assetScale);

    const id = crypto.randomUUID();
    const now = new Date();

    await db.insert(playSessions).values({
      id,
      userId: user.id,
      charityId: charity.id,
      walletAddress: user.walletAddress,
      bankrollLimit,
      assetCode: w.assetCode,
      assetScale: w.assetScale,
      status: 'AWAITING_GRANT',
      createdAt: now,
      updatedAt: now,
    });

    const nonce = crypto.randomUUID();
    const callbackUrl = `${config.backendUrl}/api/callback?grantType=session&id=${id}`;
    const grant = await requestPoolGrant(w, bankrollLimit, callbackUrl, nonce);

    await db
      .update(playSessions)
      .set({
        grantContinueUri: grant.continueUri,
        grantContinueToken: grant.continueToken,
        grantInteractNonce: nonce,
        updatedAt: new Date(),
      })
      .where(eq(playSessions.id, id));

    res.status(201).json({ sessionId: id, interactUrl: grant.interactUrl });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sessions/active — the caller's newest live run (ACTIVE|AWAITING_GRANT).
// ─────────────────────────────────────────────────────────────────────────────
sessionsRouter.get('/active', requireAuth, async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(playSessions)
      .where(eq(playSessions.userId, req.user!.id))
      .orderBy(desc(playSessions.createdAt));

    const session = rows.find((s) => s.status === 'ACTIVE' || s.status === 'AWAITING_GRANT');
    if (!session) {
      res.json(null);
      return;
    }

    const charity = await db.select().from(charities).where(eq(charities.id, session.charityId)).get();
    if (!charity) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.json(sessionView(session, charity));
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sessions/:id — a run with its rounds & donations (must own).
// ─────────────────────────────────────────────────────────────────────────────
sessionsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const session = await db.select().from(playSessions).where(eq(playSessions.id, req.params.id)).get();
    if (!session || session.userId !== req.user!.id) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const charity = await db.select().from(charities).where(eq(charities.id, session.charityId)).get();
    if (!charity) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const rounds = await db
      .select()
      .from(gameRounds)
      .where(eq(gameRounds.sessionId, session.id))
      .orderBy(desc(gameRounds.createdAt));

    const sessionDonations = await db
      .select()
      .from(donations)
      .where(eq(donations.sessionId, session.id))
      .orderBy(desc(donations.createdAt));

    res.json({
      session: sessionView(session, charity),
      rounds: rounds.map(roundView),
      donations: sessionDonations.map(donationView),
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sessions/:id/end — flush parked drops & mark ENDED (must own, ACTIVE).
// ─────────────────────────────────────────────────────────────────────────────
sessionsRouter.post('/:id/end', requireAuth, async (req, res, next) => {
  try {
    const session = await db.select().from(playSessions).where(eq(playSessions.id, req.params.id)).get();
    if (!session || session.userId !== req.user!.id) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.status !== 'ACTIVE') {
      res.status(409).json({ error: 'Session is not active' });
      return;
    }

    await endSession(session.id);
    res.json({ status: 'ENDED' });
  } catch (err) {
    next(err);
  }
});
