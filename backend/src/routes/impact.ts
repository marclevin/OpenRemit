import { Router } from 'express';
import { db } from '../db';
import { donations, gameRounds, charities } from '../db/schema';
import { eq, and, sql, count, countDistinct, desc } from 'drizzle-orm';
import { requireAuth } from '../middleware/requireAuth';

// How many trailing days the giving timeline covers (one point per day).
const TIMELINE_DAYS = 14;

export const impactRouter = Router();

// GET /api/impact → { global, personal }
impactRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;

    // ── global ────────────────────────────────────────────────────────────────
    const [gDonated] = await db
      .select({ total: sql<number>`coalesce(sum(${donations.amount}),0)` })
      .from(donations)
      .where(and(eq(donations.status, 'COMPLETED'), eq(donations.kind, 'USER_WAGER')));

    const [gMatched] = await db
      .select({ total: sql<number>`coalesce(sum(${donations.amount}),0)` })
      .from(donations)
      .where(and(eq(donations.status, 'COMPLETED'), eq(donations.kind, 'SPONSOR_MATCH')));

    const [gCharities] = await db
      .select({ total: countDistinct(donations.charityId) })
      .from(donations)
      .where(eq(donations.status, 'COMPLETED'));

    const [gPlays] = await db.select({ total: count() }).from(gameRounds);

    // ── personal ────────────────────────────────────────────────────────────────
    const [pDonated] = await db
      .select({ total: sql<number>`coalesce(sum(${donations.amount}),0)` })
      .from(donations)
      .where(
        and(
          eq(donations.status, 'COMPLETED'),
          eq(donations.kind, 'USER_WAGER'),
          eq(donations.userId, userId)
        )
      );

    const [pMatched] = await db
      .select({ total: sql<number>`coalesce(sum(${donations.amount}),0)` })
      .from(donations)
      .where(
        and(
          eq(donations.status, 'COMPLETED'),
          eq(donations.kind, 'SPONSOR_MATCH'),
          eq(donations.userId, userId)
        )
      );

    const [pPlays] = await db
      .select({ total: count() })
      .from(gameRounds)
      .where(eq(gameRounds.userId, userId));

    const [pWins] = await db
      .select({ total: count() })
      .from(gameRounds)
      .where(and(eq(gameRounds.userId, userId), eq(gameRounds.outcome, 'WIN')));

    // ── charts ────────────────────────────────────────────────────────────────
    // Top charities by total real money raised (wager + match), with the pixel
    // accent colour so the frontend can paint each bar in the charity's hue.
    const topCharityRows = await db
      .select({
        name: charities.name,
        accentColor: charities.accentColor,
        total: sql<number>`coalesce(sum(${donations.amount}),0)`,
      })
      .from(donations)
      .innerJoin(charities, eq(donations.charityId, charities.id))
      .where(eq(donations.status, 'COMPLETED'))
      .groupBy(charities.id)
      .orderBy(desc(sql`coalesce(sum(${donations.amount}),0)`))
      .limit(6);

    // Plays (and wins) per game cabinet.
    const byGameRows = await db
      .select({
        game: gameRounds.game,
        plays: count(),
        wins: sql<number>`coalesce(sum(case when ${gameRounds.outcome} = 'WIN' then 1 else 0 end),0)`,
      })
      .from(gameRounds)
      .groupBy(gameRounds.game)
      .orderBy(desc(count()));

    // Daily completed giving, then densified into a continuous trailing window so
    // the area chart has one point per day even on days with no donations.
    const dailyRows = await db
      .select({
        day: sql<string>`strftime('%Y-%m-%d', ${donations.createdAt}, 'unixepoch')`,
        total: sql<number>`coalesce(sum(${donations.amount}),0)`,
      })
      .from(donations)
      .where(eq(donations.status, 'COMPLETED'))
      .groupBy(sql`strftime('%Y-%m-%d', ${donations.createdAt}, 'unixepoch')`);

    const byDay = new Map(dailyRows.map((r) => [r.day, Number(r.total)]));
    const now = new Date();
    const timeline: { day: string; total: number }[] = [];
    for (let i = TIMELINE_DAYS - 1; i >= 0; i--) {
      const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
      const key = dt.toISOString().slice(0, 10);
      timeline.push({ day: key, total: byDay.get(key) ?? 0 });
    }

    res.json({
      global: {
        totalDonated: Number(gDonated?.total ?? 0),
        totalMatched: Number(gMatched?.total ?? 0),
        charitiesHelped: Number(gCharities?.total ?? 0),
        plays: Number(gPlays?.total ?? 0),
      },
      personal: {
        totalDonated: Number(pDonated?.total ?? 0),
        totalMatched: Number(pMatched?.total ?? 0),
        plays: Number(pPlays?.total ?? 0),
        wins: Number(pWins?.total ?? 0),
      },
      topCharities: topCharityRows.map((r) => ({
        name: r.name,
        accentColor: r.accentColor,
        total: Number(r.total),
      })),
      byGame: byGameRows.map((r) => ({
        game: r.game,
        plays: Number(r.plays),
        wins: Number(r.wins),
      })),
      timeline,
    });
  } catch (err) {
    next(err);
  }
});
