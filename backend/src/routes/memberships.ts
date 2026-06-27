import { Router } from 'express';
import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { memberships, groups, users } from '../db/schema';
import { requireAuth } from '../middleware/requireAuth';
import { createEnrollment, runDueDebits } from '../lib/debitOrder';

export const membershipsRouter = Router();

// Flat monthly premium for the mutual: R30 (at asset scale 2 → 3000 minor units).
const MONTHLY_PREMIUM_MINOR = '3000';

async function firstGroup() {
  const [group] = await db.select().from(groups).limit(1);
  return group ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/memberships/summary
// Member count, monthly inflow, and the caller's own membership state — drives
// the enrollment card and the "members × R30 / month" stat on the Relief Fund.
// ─────────────────────────────────────────────────────────────────────────────
membershipsRouter.get('/summary', requireAuth, async (req, res, next) => {
  try {
    const group = await firstGroup();
    if (!group) return res.json({ memberCount: 0, monthlyInflowMinor: '0', premiumMinor: MONTHLY_PREMIUM_MINOR, mine: null });

    const active = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.groupId, group.id), eq(memberships.status, 'ACTIVE')));

    const monthlyInflow = active.reduce((sum, m) => sum + BigInt(m.monthlyAmount), 0n);

    const [mine] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.groupId, group.id), eq(memberships.userId, req.user!.id)));

    res.json({
      memberCount:        active.length,
      monthlyInflowMinor: monthlyInflow.toString(),
      premiumMinor:       MONTHLY_PREMIUM_MINOR,
      assetScale:         group.assetScale,
      mine: mine
        ? {
            id:           mine.id,
            status:       mine.status,
            monthlyAmount: mine.monthlyAmount,
            chargesMade:  mine.chargesMade,
            nextChargeAt: mine.nextChargeAt,
            lastChargeAt: mine.lastChargeAt,
            lastError:    mine.lastError,
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/memberships/enroll
// Starts the recurring R30/month debit order: requests the interactive recurring
// grant from the member's wallet and returns the consent redirect URL.
// ─────────────────────────────────────────────────────────────────────────────
membershipsRouter.post('/enroll', requireAuth, async (req, res, next) => {
  try {
    const group = await firstGroup();
    if (!group) return res.status(400).json({ error: 'No relief group configured.' });

    const [me] = await db.select().from(users).where(eq(users.id, req.user!.id));
    if (!me?.walletAddress) {
      return res.status(400).json({ error: 'Add a wallet address in your Profile before enrolling.' });
    }

    // Already enrolled? Block duplicate active debit orders.
    const [existing] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.groupId, group.id), eq(memberships.userId, me.id), eq(memberships.status, 'ACTIVE')));
    if (existing) {
      return res.status(409).json({ error: 'You already have an active debit order for this fund.' });
    }

    const { membershipId, interactUrl } = await createEnrollment({
      group,
      userId:              me.id,
      memberWalletAddress: me.walletAddress,
      monthlyAmount:       MONTHLY_PREMIUM_MINOR,
    });

    res.json({ membershipId, interactUrl });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/memberships/run-debits  (admin)
// Charges every ACTIVE membership whose monthly premium is due — the cron
// entrypoint, exposed for the demo so an operator can run the cycle on demand.
// ─────────────────────────────────────────────────────────────────────────────
membershipsRouter.post('/run-debits', requireAuth, async (req, res, next) => {
  try {
    if (req.user!.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Only admins can run the debit cycle.' });
    }
    const group = await firstGroup();
    if (!group) return res.status(400).json({ error: 'No relief group configured.' });

    const summary = await runDueDebits({ groupId: group.id });

    // Return the refreshed pool balance so the UI can update the homes viz.
    const [refreshed] = await db.select().from(groups).where(eq(groups.id, group.id));
    res.json({ ...summary, poolBalance: refreshed?.poolBalance ?? group.poolBalance });
  } catch (err) {
    next(err);
  }
});
