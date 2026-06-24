import { Router } from 'express';
import { db } from '../db';
import { users } from '../db/schema';
import { like, ne, and, eq } from 'drizzle-orm';
import { requireAuth } from '../middleware/requireAuth';

export const usersRouter = Router();

// GET /api/users/search?q=<string>
usersRouter.get('/search', requireAuth, async (req, res, next) => {
  try {
    const q = ((req.query.q as string) ?? '').trim();
    if (!q) {
      res.json([]);
      return;
    }

    const results = await db
      .select({ id: users.id, displayName: users.displayName, walletAddress: users.walletAddress, avatar: users.avatar })
      .from(users)
      .where(and(like(users.displayName, `%${q}%`), ne(users.id, req.user!.id)))
      .limit(10)
      .all();

    res.json(results);
  } catch (err) {
    next(err);
  }
});

// GET /api/users/:id — public profile
usersRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const [profile] = await db
      .select({
        id:            users.id,
        displayName:   users.displayName,
        walletAddress: users.walletAddress,
        avatar:        users.avatar,
        role:          users.role,
      })
      .from(users)
      .where(eq(users.id, req.params.id));

    if (!profile) return res.status(404).json({ error: 'User not found' });

    res.json({ user: profile });
  } catch (err) {
    next(err);
  }
});
