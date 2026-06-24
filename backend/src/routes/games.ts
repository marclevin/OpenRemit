import { Router } from 'express';
import crypto from 'node:crypto';
import { eq, and, desc, count } from 'drizzle-orm';
import { db } from '../db';
import { playSessions, gameRounds, donations, charities } from '../db/schema';
import type { PlaySession, GameRound, Donation } from '../db/schema';
import { requireAuth } from '../middleware/requireAuth';
import { reserveWager, settleImmediate, settlePachinko, remainingPlayable } from '../lib/playEngine';
import { settleMatch } from '../lib/matchingEngine';
import {
  randomSeed,
  hashSeed,
  startRocket,
  resolveRocket,
  playPlane,
  playPachinko,
  matchAmountFor,
  PACHINKO_MULTIPLIERS,
} from '../lib/gameEngine';

// ─────────────────────────────────────────────────────────────────────────────
// games — the arcade. Every play handler reserves the wager against the session's
// bankroll up front (synchronous, guards the budget), then settlement (the real
// Open Payments I/O) is fired in the BACKGROUND so the response is fast and the
// client polls GET /rounds/:id for the receipt. Rocket is the exception: its crash
// point is SECRET, so /rocket/play never reveals the crashPoint or serverSeed —
// only /rocket/:id/cashout does, once the round resolves.
// ─────────────────────────────────────────────────────────────────────────────

export const gamesRouter = Router();

const MIN_WAGER = 1;

// ── View shapers ──────────────────────────────────────────────────────────────

interface RoundView {
  id: string;
  sessionId: string;
  game: string;
  wager: number;
  multiplier: number;
  matchAmount: number;
  outcome: string;
  settled: boolean;
  createdAt: Date;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  serverSeed?: string;
}

function roundView(r: GameRound): RoundView {
  const view: RoundView = {
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
  };
  // The serverSeed is the fairness reveal — only expose it once the round resolved.
  if (r.outcome !== 'PENDING') view.serverSeed = r.serverSeed;
  return view;
}

function donationView(d: Donation) {
  return {
    id: d.id,
    kind: d.kind,
    amount: d.amount,
    assetCode: d.assetCode,
    assetScale: d.assetScale,
    status: d.status,
    charityId: d.charityId ?? undefined,
    roundId: d.roundId ?? undefined,
    pledgeId: d.pledgeId ?? undefined,
    outgoingPaymentUrl: d.outgoingPaymentUrl ?? undefined,
    errorMessage: d.errorMessage ?? undefined,
    createdAt: d.createdAt,
  };
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Load an ACTIVE session owned by the caller, or undefined. */
async function loadActiveSession(sessionId: string, userId: string): Promise<PlaySession | undefined> {
  const [session] = await db
    .select()
    .from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)));
  return session;
}

/** Number of rounds already in the session (drives the fairness nonce). */
async function roundCount(sessionId: string): Promise<number> {
  const [row] = await db
    .select({ c: count() })
    .from(gameRounds)
    .where(eq(gameRounds.sessionId, sessionId));
  return row ? Number(row.c) : 0;
}

/** Re-read the session and compute the live remaining-playable amount. */
async function remainingForSession(sessionId: string): Promise<number> {
  const [session] = await db.select().from(playSessions).where(eq(playSessions.id, sessionId));
  return session ? remainingPlayable(session) : 0;
}

function pickClientSeed(body: { clientSeed?: unknown }): string {
  return typeof body.clientSeed === 'string' && body.clientSeed.trim()
    ? body.clientSeed.trim().slice(0, 64)
    : randomSeed();
}

/**
 * The pre-amble every PLAY/DROP handler shares: validate session ownership +
 * ACTIVE status, validate the wager, and reserve it. Returns a discriminated
 * result so the caller can either respond with the error or proceed.
 */
type PreambleResult =
  | { ok: true; session: PlaySession; wager: number; serverSeed: string; clientSeed: string; nonce: number }
  | { ok: false; status: number; error: string };

async function playPreamble(
  body: { sessionId?: unknown; wager?: unknown; clientSeed?: unknown },
  userId: string,
): Promise<PreambleResult> {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId) return { ok: false, status: 400, error: 'sessionId is required' };

  const session = await loadActiveSession(sessionId, userId);
  if (!session) return { ok: false, status: 404, error: 'Session not found' };
  if (session.status !== 'ACTIVE') return { ok: false, status: 409, error: 'Session is not active' };

  const wager = body.wager;
  if (typeof wager !== 'number' || !Number.isInteger(wager) || wager < MIN_WAGER) {
    return { ok: false, status: 400, error: `wager must be an integer ≥ ${MIN_WAGER}` };
  }

  const ok = await reserveWager(session.id, wager);
  if (!ok) return { ok: false, status: 400, error: 'Bankroll exhausted — start a new run' };

  const serverSeed = randomSeed();
  const nonce = (await roundCount(session.id)) + 1;
  const clientSeed = pickClientSeed(body);

  return { ok: true, session, wager, serverSeed, clientSeed, nonce };
}

// ── POST /plane/play ──────────────────────────────────────────────────────────
// Outcome is known immediately; settlement (wager donation + match on a win)
// fires in the background.
gamesRouter.post('/plane/play', requireAuth, async (req, res, next) => {
  try {
    const pre = await playPreamble(req.body ?? {}, req.user!.id);
    if (!pre.ok) {
      res.status(pre.status).json({ error: pre.error });
      return;
    }
    const { session, wager, serverSeed, clientSeed, nonce } = pre;

    const o = playPlane(serverSeed, clientSeed, nonce);
    const multiplier = o.outcome === 'WIN' ? o.multiplier : 0;
    const matchAmount = matchAmountFor(wager, multiplier);

    const id = crypto.randomUUID();
    const now = new Date();
    const animation = {
      result: (o.outcome === 'WIN' ? 'LAND' : 'CRASH') as 'LAND' | 'CRASH',
      finalMultiplier: o.multiplier,
      steps: o.steps,
    };
    const details = JSON.stringify(animation);

    await db.insert(gameRounds).values({
      id,
      sessionId: session.id,
      userId: session.userId,
      game: 'PLANE',
      wager,
      multiplier,
      matchAmount,
      outcome: o.outcome,
      serverSeed,
      serverSeedHash: hashSeed(serverSeed),
      clientSeed,
      nonce,
      details,
      settled: false,
      createdAt: now,
      updatedAt: now,
    });

    // Donate the wager (and match on a win) in the background.
    settleImmediate(id).catch((err) => console.error('[settle]', err));

    const [round] = await db.select().from(gameRounds).where(eq(gameRounds.id, id));
    const remaining = await remainingForSession(session.id);

    res.json({ round: roundView(round!), animation, remaining });
  } catch (err) {
    next(err);
  }
});

// ── POST /rocket/play ─────────────────────────────────────────────────────────
// crashPoint is SECRET. The wager is donated NOW (in the background); the round
// stays PENDING until cash-out. Never returns crashPoint or serverSeed.
gamesRouter.post('/rocket/play', requireAuth, async (req, res, next) => {
  try {
    const pre = await playPreamble(req.body ?? {}, req.user!.id);
    if (!pre.ok) {
      res.status(pre.status).json({ error: pre.error });
      return;
    }
    const { session, wager, serverSeed, clientSeed, nonce } = pre;

    const r = startRocket(serverSeed, clientSeed, nonce);

    const id = crypto.randomUUID();
    const now = new Date();
    const details = JSON.stringify({ growthK: r.growthK });

    await db.insert(gameRounds).values({
      id,
      sessionId: session.id,
      userId: session.userId,
      game: 'ROCKET',
      wager,
      multiplier: 0,
      matchAmount: 0,
      outcome: 'PENDING',
      crashPoint: r.crashPoint,
      startedAt: now,
      serverSeed,
      serverSeedHash: hashSeed(serverSeed),
      clientSeed,
      nonce,
      details,
      settled: false,
      createdAt: now,
      updatedAt: now,
    });

    // The wager is always donated — even before cash-out (the match fires later).
    settleImmediate(id).catch((err) => console.error('[settle]', err));

    const remaining = await remainingForSession(session.id);

    res.json({
      roundId: id,
      startedAt: now.getTime(),
      growthK: r.growthK,
      // The client drives a live crash at this point (and never displays it),
      // so the rocket visibly explodes instead of climbing to silly numbers.
      crashPoint: r.crashPoint,
      serverSeedHash: r.fairness.serverSeedHash,
      clientSeed,
      nonce,
      remaining,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /rocket/:id/cashout ──────────────────────────────────────────────────
// Resolve a PENDING rocket round against the secret crash point and the server
// clock. On a WIN, fire the sponsor match in the background. Reveals serverSeed.
gamesRouter.post('/rocket/:id/cashout', requireAuth, async (req, res, next) => {
  try {
    const roundId = req.params.id;
    const body = (req.body ?? {}) as { multiplier?: unknown };

    const [round] = await db.select().from(gameRounds).where(eq(gameRounds.id, roundId));
    if (!round) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }

    // Ownership via the round's session.
    const [session] = await db.select().from(playSessions).where(eq(playSessions.id, round.sessionId));
    if (!session || session.userId !== req.user!.id) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }

    if (round.game !== 'ROCKET' || round.outcome !== 'PENDING' || !round.startedAt || round.crashPoint == null) {
      res.status(409).json({ error: 'Round is not a cashable rocket' });
      return;
    }

    const requested = typeof body.multiplier === 'number' ? body.multiplier : 1;
    const res2 = resolveRocket(round.crashPoint, requested);

    const multiplier = res2.outcome === 'WIN' ? res2.multiplier : 0;
    const matchAmount = matchAmountFor(round.wager, multiplier);

    await db
      .update(gameRounds)
      .set({ outcome: res2.outcome, multiplier, matchAmount, updatedAt: new Date() })
      .where(eq(gameRounds.id, round.id));

    // The wager was already donated at play. Fire the sponsor match on a win.
    if (res2.outcome === 'WIN' && matchAmount > 0) {
      const [charity] = await db.select().from(charities).where(eq(charities.id, session.charityId));
      if (charity) {
        settleMatch(
          matchAmount,
          { id: charity.id, walletAddress: charity.walletAddress },
          { sessionId: session.id, roundId: round.id, userId: session.userId },
        ).catch((err) => console.error('[settle]', err));
      }
    }

    res.json({
      outcome: res2.outcome,
      multiplier: res2.outcome === 'WIN' ? res2.multiplier : 0,
      crashPoint: round.crashPoint,
      matchAmount,
      serverSeed: round.serverSeed,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /pachinko/drop ───────────────────────────────────────────────────────
// Outcome known immediately, but settlement is DEFERRED — drops are parked and
// donated as one aggregated batch at cash-out (the "outgoing only on game end"
// rule). No settlement fires here.
gamesRouter.post('/pachinko/drop', requireAuth, async (req, res, next) => {
  try {
    const pre = await playPreamble(req.body ?? {}, req.user!.id);
    if (!pre.ok) {
      res.status(pre.status).json({ error: pre.error });
      return;
    }
    const { session, wager, serverSeed, clientSeed, nonce } = pre;

    const o = playPachinko(serverSeed, clientSeed, nonce);
    const matchAmount = matchAmountFor(wager, o.multiplier);

    const id = crypto.randomUUID();
    const now = new Date();
    const details = JSON.stringify({ bucket: o.bucket, path: o.path });

    await db.insert(gameRounds).values({
      id,
      sessionId: session.id,
      userId: session.userId,
      game: 'PACHINKO',
      wager,
      multiplier: o.multiplier,
      matchAmount,
      outcome: o.outcome,
      serverSeed,
      serverSeedHash: hashSeed(serverSeed),
      clientSeed,
      nonce,
      details,
      settled: false,
      createdAt: now,
      updatedAt: now,
    });

    const [round] = await db.select().from(gameRounds).where(eq(gameRounds.id, id));
    const remaining = await remainingForSession(session.id);

    // Count parked (unsettled) Pachinko drops in this session.
    const [parkedRow] = await db
      .select({ c: count() })
      .from(gameRounds)
      .where(and(
        eq(gameRounds.sessionId, session.id),
        eq(gameRounds.game, 'PACHINKO'),
        eq(gameRounds.settled, false),
      ));
    const parked = parkedRow ? Number(parkedRow.c) : 0;

    res.json({
      round: roundView(round!),
      animation: {
        bucket: o.bucket,
        path: o.path,
        multipliers: PACHINKO_MULTIPLIERS,
      },
      remaining,
      parked,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /pachinko/cashout ────────────────────────────────────────────────────
// Settle all parked drops as one batch. This one we DO await — it returns the
// settlement summary.
gamesRouter.post('/pachinko/cashout', requireAuth, async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { sessionId?: unknown };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const session = await loadActiveSession(sessionId, req.user!.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.status !== 'ACTIVE') {
      res.status(409).json({ error: 'Session is not active' });
      return;
    }

    const s = await settlePachinko(sessionId);
    const remaining = await remainingForSession(sessionId);

    res.json({
      settlement: { totalWager: s.totalWager, drops: s.drops, totalMatched: s.totalMatched },
      remaining,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /rounds/:id ───────────────────────────────────────────────────────────
// Receipt poll: the round plus its donations (PENDING → COMPLETED). Ownership via
// the round's session.
gamesRouter.get('/rounds/:id', requireAuth, async (req, res, next) => {
  try {
    const roundId = req.params.id;
    const [round] = await db.select().from(gameRounds).where(eq(gameRounds.id, roundId));
    if (!round) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }

    const [session] = await db.select().from(playSessions).where(eq(playSessions.id, round.sessionId));
    if (!session || session.userId !== req.user!.id) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }

    const rows = await db
      .select()
      .from(donations)
      .where(eq(donations.roundId, roundId))
      .orderBy(desc(donations.createdAt));

    res.json({
      round: roundView(round),
      donations: rows.map(donationView),
    });
  } catch (err) {
    next(err);
  }
});
