import crypto from 'node:crypto';
import { Router } from 'express';
import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { groups, fireEvents, claims, transactions } from '../db/schema';
import { requireAuth } from '../middleware/requireAuth';
import { isPendingGrant } from '@interledger/open-payments';
import { getClientForSource, normaliseWalletAddress } from '../lib/openPayments';
import { createQuoteTransaction } from '../lib/quoteFlow';
import { config } from '../config';

export const claimsRouter = Router();

// ─── GET /api/claims/groups ───────────────────────────────────────────────────
// List all mutual groups (for frontend group selection).
claimsRouter.get('/groups', requireAuth, async (_req, res) => {
  const all = await db.select().from(groups);
  res.json(all);
});

// ─── POST /api/claims ─────────────────────────────────────────────────────────
// File a new claim. Creates or associates with an existing fire event.
// Body: { groupId, location, occurredAt (ISO), claimantWallet }
claimsRouter.post('/', requireAuth, async (req, res) => {
  const { groupId, location, occurredAt, claimantWallet } = req.body as {
    groupId:       string;
    location:      string;
    occurredAt:    string; // ISO date string
    claimantWallet: string;
  };

  if (!groupId || !location || !occurredAt || !claimantWallet) {
    return res.status(400).json({ error: 'groupId, location, occurredAt, and claimantWallet are required.' });
  }

  const [group] = await db.select().from(groups).where(eq(groups.id, groupId));
  if (!group) return res.status(404).json({ error: 'Group not found.' });

  const occurredDate = new Date(occurredAt);
  if (isNaN(occurredDate.getTime())) {
    return res.status(400).json({ error: 'occurredAt must be a valid ISO date.' });
  }

  // 48-hour reporting window: claim must be filed within 48h of fire
  const hoursSinceFire = (Date.now() - occurredDate.getTime()) / (1000 * 60 * 60);
  if (hoursSinceFire > 48) {
    return res.status(400).json({ error: '48-hour reporting window has closed for this event.' });
  }

  const normalizedWallet = normaliseWalletAddress(claimantWallet);

  // Find or create the fire event for this location + approximate time.
  // "Same event" = same group + location + occurred within 6 hours of each other.
  const existingEvents = await db.select().from(fireEvents).where(
    and(eq(fireEvents.groupId, groupId), eq(fireEvents.location, location))
  );
  const sixHours = 6 * 60 * 60 * 1000;
  let event = existingEvents.find(
    (e) => Math.abs(e.occurredAt.getTime() - occurredDate.getTime()) < sixHours
  );

  const now = new Date();

  if (!event) {
    const eventId = crypto.randomUUID();
    const [inserted] = await db
      .insert(fireEvents)
      .values({
        id:             eventId,
        groupId,
        location,
        occurredAt:     occurredDate,
        reportedAt:     now,
        classification: 'SINGLE',
        claimCount:     0,
        createdAt:      now,
        updatedAt:      now,
      })
      .returning();
    event = inserted;
  }

  // Increment claim count and reclassify
  const newCount = event.claimCount + 1;
  const classification = newCount >= group.covariateThreshold ? 'COVARIATE' : 'SINGLE';
  await db
    .update(fireEvents)
    .set({ claimCount: newCount, classification, updatedAt: now })
    .where(eq(fireEvents.id, event.id));

  const claimId = crypto.randomUUID();
  const [claim] = await db
    .insert(claims)
    .values({
      id:             claimId,
      groupId,
      eventId:        event.id,
      claimantWallet: normalizedWallet,
      filedByUserId:  req.user!.id,
      status:         'PENDING',
      createdAt:      now,
      updatedAt:      now,
    })
    .returning();

  res.status(201).json({
    ...claim,
    event: { ...event, claimCount: newCount, classification },
  });
});

// ─── GET /api/claims ──────────────────────────────────────────────────────────
// List claims. Optional ?groupId= filter.
claimsRouter.get('/', requireAuth, async (req, res) => {
  const { groupId } = req.query as { groupId?: string };

  const rows = groupId
    ? await db.select().from(claims).where(eq(claims.groupId, groupId))
    : await db.select().from(claims);

  // Attach event info for each claim
  const eventIds = rows.map((c) => c.eventId).filter((id, i, arr) => arr.indexOf(id) === i);
  const eventsMap: Record<string, typeof fireEvents.$inferSelect> = {};
  for (const eid of eventIds) {
    const [ev] = await db.select().from(fireEvents).where(eq(fireEvents.id, eid));
    if (ev) eventsMap[eid] = ev;
  }

  res.json(rows.map((c) => ({ ...c, event: eventsMap[c.eventId] ?? null })));
});

// ─── GET /api/claims/:id ──────────────────────────────────────────────────────
claimsRouter.get('/:id', requireAuth, async (req, res) => {
  const [claim] = await db.select().from(claims).where(eq(claims.id, req.params.id));
  if (!claim) return res.status(404).json({ error: 'Claim not found.' });

  const [event] = await db.select().from(fireEvents).where(eq(fireEvents.id, claim.eventId));
  res.json({ ...claim, event: event ?? null });
});

// ─── PATCH /api/claims/:id/verify ─────────────────────────────────────────────
// Simulated attestation gate — marks a PENDING claim as VERIFIED.
// In a real system this would require M-of-N community signatures.
claimsRouter.patch('/:id/verify', requireAuth, async (req, res) => {
  const [claim] = await db.select().from(claims).where(eq(claims.id, req.params.id));
  if (!claim) return res.status(404).json({ error: 'Claim not found.' });
  if (claim.status !== 'PENDING') {
    return res.status(400).json({ error: `Claim is ${claim.status} — only PENDING claims can be verified.` });
  }
  if (claim.filedByUserId && claim.filedByUserId === req.user!.id) {
    return res.status(403).json({ error: 'You cannot verify a claim you filed.' });
  }

  const [updated] = await db
    .update(claims)
    .set({ status: 'VERIFIED', updatedAt: new Date() })
    .where(eq(claims.id, req.params.id))
    .returning();

  res.json(updated);
});

// ─── PATCH /api/claims/:id/reject ─────────────────────────────────────────────
claimsRouter.patch('/:id/reject', requireAuth, async (req, res) => {
  if (req.user!.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only admins can reject claims.' });
  }
  const [claim] = await db.select().from(claims).where(eq(claims.id, req.params.id));
  if (!claim) return res.status(404).json({ error: 'Claim not found.' });
  if (claim.status === 'PAID') {
    return res.status(400).json({ error: 'Cannot reject a claim that has already been paid.' });
  }

  const [updated] = await db
    .update(claims)
    .set({ status: 'REJECTED', updatedAt: new Date() })
    .where(eq(claims.id, req.params.id))
    .returning();

  res.json(updated);
});

// ─── POST /api/claims/:id/payout ─────────────────────────────────────────────
// Admin only — triggers the Open Payments outgoing grant flow.
// Trigger a payout for a VERIFIED claim.
//
// Decision logic (README2.md §9):
//   1. Classify the event: claimCount >= covariateThreshold → COVARIATE
//   2. Choose source:
//      SINGLE && pool − fixedPayoutAmount ≥ reserveFloor  → POOL
//      otherwise                                           → BACKSTOP
//   3. Run quoteFlow (pool/backstop → claimant wallet)
//   4. Request interactive outgoing grant from the chosen source wallet
//   5. Return { interactUrl, transactionId, claimId, payoutSource }
//
// The operator approves at the auth server; /api/callback then creates the
// outgoing payment and marks the claim PAID.
claimsRouter.post('/:id/payout', requireAuth, async (req, res) => {
  if (req.user!.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only admins can trigger payouts.' });
  }
  const [claim] = await db.select().from(claims).where(eq(claims.id, req.params.id));
  if (!claim) return res.status(404).json({ error: 'Claim not found.' });
  if (claim.status !== 'VERIFIED') {
    return res.status(400).json({ error: `Claim must be VERIFIED to trigger a payout (currently ${claim.status}).` });
  }

  const [group] = await db.select().from(groups).where(eq(groups.id, claim.groupId));
  if (!group) return res.status(500).json({ error: 'Group not found for this claim.' });

  const [event] = await db.select().from(fireEvents).where(eq(fireEvents.id, claim.eventId));
  if (!event) return res.status(500).json({ error: 'Fire event not found for this claim.' });

  // ── Step 1: Classify event ─────────────────────────────────────────────────
  const isCovariate = event.claimCount >= group.covariateThreshold;
  const classification = isCovariate ? 'COVARIATE' : 'SINGLE';

  // ── Step 2: Choose payout source ──────────────────────────────────────────
  const poolBal  = BigInt(group.poolBalance);
  const payout   = BigInt(group.fixedPayoutAmount);
  const floor    = BigInt(group.reserveFloor);
  const canUsePool = !isCovariate && (poolBal - payout >= floor);
  const payoutSource: 'POOL' | 'BACKSTOP' = canUsePool ? 'POOL' : 'BACKSTOP';

  const sourceWalletAddress = payoutSource === 'POOL'
    ? group.poolWalletAddress
    : group.backstopWalletAddress;

  console.log(
    `[claims] Payout for claim ${claim.id}: event=${classification}, source=${payoutSource}, pool=${group.poolBalance}, payout=${group.fixedPayoutAmount}, floor=${group.reserveFloor}`
  );

  // ── Step 3: QuoteFlow (source wallet → claimant wallet) ───────────────────
  const opClient = await getClientForSource(payoutSource);

  let quoteResult: Awaited<ReturnType<typeof createQuoteTransaction>>;
  try {
    quoteResult = await createQuoteTransaction({
      senderWalletAddress:   sourceWalletAddress,
      receiverWalletAddress: claim.claimantWallet,
      amount:                group.fixedPayoutAmount,
      paymentType:           'FIXED_SEND',
      userId:                req.user!.id,
      client:                opClient,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[claims] QuoteFlow failed — full error:', err);
    return res.status(502).json({ error: `Failed to create quote: ${msg}` });
  }

  // ── Step 4: Interactive outgoing grant (operator approves payout) ──────────
  const sourceWallet = await opClient.walletAddress.get({
    url: normaliseWalletAddress(sourceWalletAddress),
  });

  const nonce     = crypto.randomBytes(16).toString('hex');
  const callbackUrl = `${config.backendUrl}/api/callback?transactionId=${quoteResult.transactionId}`;

  const pendingGrant = await opClient.grant.request(
    { url: sourceWallet.authServer },
    {
      access_token: {
        access: [
          {
            type:       'outgoing-payment',
            actions:    ['create', 'read'],
            identifier: sourceWallet.id,
            limits: {
              debitAmount: {
                value:      quoteResult.quote.debitAmount.value,
                assetCode:  quoteResult.quote.debitAmount.assetCode,
                assetScale: quoteResult.quote.debitAmount.assetScale,
              },
            },
          },
        ],
      },
      interact: {
        start:  ['redirect'],
        finish: { method: 'redirect', uri: callbackUrl, nonce },
      },
    }
  );

  if (!isPendingGrant(pendingGrant) || !pendingGrant.interact?.redirect) {
    return res.status(500).json({ error: 'Expected an interactive outgoing-payment grant with a redirect URL. The source wallet may not support interactive grants.' });
  }

  // Store grant continuation details on the transaction (same pattern as /consent)
  await db
    .update(transactions)
    .set({
      status:             'AWAITING_GRANT',
      grantContinueUri:   pendingGrant.continue.uri,
      grantContinueToken: pendingGrant.continue.access_token.value,
      grantInteractNonce: nonce,
      updatedAt:          new Date(),
    })
    .where(eq(transactions.id, quoteResult.transactionId));

  // Link the transaction to the claim so /callback can mark it PAID
  await db
    .update(claims)
    .set({
      transactionId: quoteResult.transactionId,
      payoutAmount:  group.fixedPayoutAmount,
      payoutSource,
      updatedAt:     new Date(),
    })
    .where(eq(claims.id, claim.id));

  res.json({
    claimId:       claim.id,
    transactionId: quoteResult.transactionId,
    payoutSource,
    classification,
    interactUrl:   pendingGrant.interact.redirect,
    quote:         quoteResult.quote,
  });
});
