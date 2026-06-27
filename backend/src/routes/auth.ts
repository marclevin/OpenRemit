import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../db';
import { users } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import { config } from '../config';
import { requireAuth } from '../middleware/requireAuth';
import { normaliseWalletAddress } from '../lib/openPayments';

export const authRouter = Router();

const MAX_AVATAR_BYTES = 200 * 1024; // 200 KB base64 limit

function signToken(user: { id: string; email: string; displayName: string; role: string }): string {
  return jwt.sign(
    { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
    config.jwtSecret,
    { expiresIn: '7d' }
  );
}

// POST /api/auth/signup
authRouter.post('/signup', async (req, res, next) => {
  try {
    const { displayName, email, password } = req.body as {
      displayName?: string;
      email?: string;
      password?: string;
    };

    if (!displayName?.trim() || !email?.trim() || !password) {
      res.status(400).json({ error: 'displayName, email and password are required' });
      return;
    }

    const existing = await db.select().from(users).where(eq(users.email, email.toLowerCase())).get();
    if (existing) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const id = crypto.randomUUID();
    const now = new Date();

    // First registered user becomes ADMIN; all subsequent users are MEMBER
    const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(users);
    const role = count === 0 ? 'ADMIN' : 'MEMBER';

    await db.insert(users).values({
      id,
      displayName: displayName.trim(),
      email: email.toLowerCase(),
      passwordHash,
      role,
      createdAt: now,
    });

    const user = { id, email: email.toLowerCase(), displayName: displayName.trim(), role };
    res.status(201).json({ token: signToken(user), user: { ...user, walletAddress: null, avatar: null } });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };

    if (!email?.trim() || !password) {
      res.status(400).json({ error: 'email and password are required' });
      return;
    }

    const row = await db.select().from(users).where(eq(users.email, email.toLowerCase())).get();
    if (!row) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const valid = await bcrypt.compare(password, row.passwordHash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const user = { id: row.id, email: row.email, displayName: row.displayName, role: row.role ?? 'MEMBER' };
    res.json({ token: signToken(user), user: { ...user, walletAddress: row.walletAddress, avatar: row.avatar } });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const row = await db.select().from(users).where(eq(users.id, req.user!.id)).get();
    if (!row) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const { passwordHash: _, ...safe } = row;
    res.json(safe);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/auth/me
authRouter.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const { displayName, email, password, walletAddress, avatar } = req.body as {
      displayName?: string;
      email?: string;
      password?: string;
      walletAddress?: string;
      avatar?: string;
    };

    if (avatar && avatar.length > MAX_AVATAR_BYTES * 1.4) {
      res.status(400).json({ error: 'Avatar image too large (max ~200 KB)' });
      return;
    }

    const updates: Partial<typeof users.$inferInsert> = {};
    if (displayName?.trim())  updates.displayName  = displayName.trim();
    if (email?.trim()) {
      const newEmail = email.trim().toLowerCase();
      const taken = await db.select({ id: users.id }).from(users).where(eq(users.email, newEmail)).get();
      if (taken && taken.id !== req.user!.id) {
        res.status(409).json({ error: 'Email already registered' });
        return;
      }
      updates.email = newEmail;
    }
    if (walletAddress !== undefined) {
      const trimmed = walletAddress.trim();
      updates.walletAddress = trimmed ? normaliseWalletAddress(trimmed) : null;
    }
    if (avatar !== undefined) updates.avatar = avatar || null;
    if (password)             updates.passwordHash = await bcrypt.hash(password, 10);

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    await db.update(users).set(updates).where(eq(users.id, req.user!.id));

    const row = await db.select().from(users).where(eq(users.id, req.user!.id)).get();
    const { passwordHash: _, ...safe } = row!;
    res.json(safe);
  } catch (err) {
    next(err);
  }
});
