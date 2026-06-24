import { Router } from 'express';
import { db } from '../db';
import { charities } from '../db/schema';
import { asc } from 'drizzle-orm';
import { requireAuth } from '../middleware/requireAuth';

export const charitiesRouter = Router();

// GET /api/charities → Charity[]
charitiesRouter.get('/', requireAuth, async (_req, res, next) => {
  try {
    const rows = await db
      .select({
        id: charities.id,
        name: charities.name,
        blurb: charities.blurb,
        category: charities.category,
        walletAddress: charities.walletAddress,
        accentColor: charities.accentColor,
      })
      .from(charities)
      .orderBy(asc(charities.name));

    res.json(rows);
  } catch (err) {
    next(err);
  }
});
