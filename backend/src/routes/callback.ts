import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { playSessions, pledges } from '../db/schema';
import { continuePoolGrant } from '../lib/grantFlow';
import { config } from '../config';

export const callbackRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/callback
//
// GNAP redirect endpoint — the wallet's auth server redirects the user's browser
// here after they approve (or decline) the one interactive grant that funds a
// pool. A pool is either a player's play_session bankroll (grantType=session) or
// a sponsor's pledge (grantType=pledge).
//
// Query params:
//   grantType    — 'session' | 'pledge' (which table the row lives in)
//   id           — our DB row id to finalise
//   interact_ref — exchange token to continue the grant (present on approval)
//   result       — 'grant_rejected' when the user declined consent
//
// Steps:
//   1. Validate grantType + id, load the AWAITING_GRANT row.
//   2. Decline path (no interact_ref / grant_rejected): mark ENDED, redirect.
//   3. Success: continue the grant → access token, mark ACTIVE, redirect.
// ─────────────────────────────────────────────────────────────────────────────
callbackRouter.get('/', async (req, res) => {
  const { grantType, id, interact_ref, result } = req.query as Record<string, string>;

  if (grantType !== 'session' && grantType !== 'pledge') {
    return res.status(400).send('Missing or invalid grantType in callback query');
  }
  if (!id) {
    return res.status(400).send('Missing id in callback query');
  }

  const declinedRedirect = `${config.frontendUrl}?grant=${grantType}&status=declined&id=${id}`;
  const activeRedirect   = `${config.frontendUrl}?grant=${grantType}&status=active&id=${id}`;

  // Load the row from the table the grantType points at.
  const row = grantType === 'session'
    ? await db.select().from(playSessions).where(eq(playSessions.id, id)).get()
    : await db.select().from(pledges).where(eq(pledges.id, id)).get();

  if (!row || row.status !== 'AWAITING_GRANT') {
    return res.redirect(declinedRedirect);
  }

  // Helper: flip the right table's row status (keeps the success/decline/error
  // branches table-agnostic).
  const setStatus = async (status: 'ENDED' | 'ACTIVE', token?: { accessToken: string; manageUrl: string }) => {
    const updates = token !== undefined
      ? { status, grantAccessToken: token.accessToken, grantManageUrl: token.manageUrl, updatedAt: new Date() }
      : { status, updatedAt: new Date() };
    if (grantType === 'session') {
      await db.update(playSessions).set(updates).where(eq(playSessions.id, id));
    } else {
      await db.update(pledges).set(updates).where(eq(pledges.id, id));
    }
  };

  // User declined consent (or the auth server returned no interact_ref): there's
  // nothing to continue. Mark the dangling row ENDED so it isn't stuck
  // AWAITING_GRANT, and send them back so they can start a new run/pledge.
  if (!interact_ref || result === 'grant_rejected') {
    await setStatus('ENDED');
    return res.redirect(declinedRedirect);
  }

  try {
    const token = await continuePoolGrant(row.grantContinueUri!, row.grantContinueToken!, interact_ref);
    await setStatus('ACTIVE', token);
    res.redirect(activeRedirect);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[callback] Grant continuation failed:', message);
    await setStatus('ENDED');
    res.redirect(declinedRedirect);
  }
});
