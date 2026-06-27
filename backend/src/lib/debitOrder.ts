import crypto from 'node:crypto';
import { eq, and, lte } from 'drizzle-orm';
import { isPendingGrant } from '@interledger/open-payments';
import { db } from '../db';
import { memberships, groups, transactions } from '../db/schema';
import type { Group } from '../db/schema';
import { getClient, normaliseWalletAddress, isFinalizedGrant } from './openPayments';
import { createQuoteTransaction } from './quoteFlow';
import { config } from '../config';

// ─────────────────────────────────────────────────────────────────────────────
// Recurring R30/month debit order, backed by a real Open Payments recurring
// outgoing-payment grant. The member consents ONCE to a grant whose limit
// carries an ISO-8601 `interval` (P1M) and a per-interval `debitAmount`. We
// persist the finalized access token + its management URL, then charge each
// month WITHOUT re-consent — rotating the token before each charge.
// ─────────────────────────────────────────────────────────────────────────────

function addMonths(d: Date, n: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

// ISO-8601 repeating interval used as the grant limit, e.g. R/2026-07-01T…Z/P1M.
function monthlyInterval(start: Date): string {
  return `R/${start.toISOString()}/P1M`;
}

export interface EnrollInput {
  group:               Group;
  userId:              string;
  memberWalletAddress: string;
  monthlyAmount:       string; // smallest asset unit, e.g. "3000" = R30 at scale 2
}

// Request the interactive recurring grant and persist a PENDING_CONSENT
// membership. Returns the wallet consent redirect URL the browser must visit.
export async function createEnrollment(
  input: EnrollInput
): Promise<{ membershipId: string; interactUrl: string }> {
  const client       = await getClient();
  const memberUrl    = normaliseWalletAddress(input.memberWalletAddress);
  const memberWallet = await client.walletAddress.get({ url: memberUrl });

  const membershipId = crypto.randomUUID();
  const now          = new Date();
  const interval     = monthlyInterval(now);
  const nonce        = crypto.randomUUID();
  const callbackUrl  = `${config.backendUrl}/api/callback?membershipId=${membershipId}`;

  console.log('[debit:enroll-grant-request] member=%s authServer=%s amount=%s interval=%s',
    memberWallet.id, memberWallet.authServer, input.monthlyAmount, interval);

  const grant = await client.grant.request(
    { url: memberWallet.authServer },
    {
      access_token: {
        access: [
          {
            type:       'outgoing-payment',
            actions:    ['create', 'read'],
            identifier: memberWallet.id,
            limits: {
              debitAmount: {
                value:      input.monthlyAmount,
                assetCode:  memberWallet.assetCode,
                assetScale: memberWallet.assetScale,
              },
              // The ISO-8601 repeating interval is what makes this a *recurring*
              // mandate: the auth server allows up to debitAmount per P1M window.
              interval,
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

  if (!isPendingGrant(grant) || !grant.interact?.redirect) {
    throw new Error('Expected an interactive recurring outgoing-payment grant with a redirect URL.');
  }

  await db.insert(memberships).values({
    id:                  membershipId,
    groupId:             input.group.id,
    userId:              input.userId,
    memberWalletAddress: memberUrl,
    monthlyAmount:       input.monthlyAmount,
    interval,
    status:              'PENDING_CONSENT',
    grantContinueUri:    grant.continue.uri,
    grantContinueToken:  grant.continue.access_token.value,
    grantInteractNonce:  nonce,
    chargesMade:         0,
    createdAt:           now,
    updatedAt:           now,
  });

  return { membershipId, interactUrl: grant.interact.redirect };
}

// Finalize the enrollment grant from the consent callback: store the recurring
// access token + its management URL, mark ACTIVE, and run the first charge.
export async function activateMembership(membershipId: string, interactRef: string): Promise<void> {
  const [m] = await db.select().from(memberships).where(eq(memberships.id, membershipId));
  if (!m) throw new Error('Membership not found');

  const client    = await getClient();
  const finalized = await client.grant.continue(
    { url: m.grantContinueUri!, accessToken: m.grantContinueToken! },
    { interact_ref: interactRef }
  );
  if (!isFinalizedGrant(finalized)) {
    throw new Error('Enrollment grant did not finalize with an access token (consent denied or expired).');
  }

  const now = new Date();
  await db
    .update(memberships)
    .set({
      status:               'ACTIVE',
      accessToken:          finalized.access_token.value,
      accessTokenManageUrl: finalized.access_token.manage,
      grantContinueUri:     (finalized as any).continue?.uri                  ?? m.grantContinueUri,
      grantContinueToken:   (finalized as any).continue?.access_token?.value  ?? m.grantContinueToken,
      nextChargeAt:         now, // first month's premium is due immediately
      updatedAt:            now,
    })
    .where(eq(memberships.id, m.id));

  console.log('[debit:activated] membershipId=%s — running first charge', m.id);

  // First charge uses the freshly-issued token directly (no rotation needed).
  // Wrapped so a charge failure never breaks the consent redirect.
  try {
    await chargeMembership(m.id, { skipRotate: true });
  } catch (err) {
    console.error('[debit:first-charge-failed] membershipId=%s err=%s', m.id, String(err));
  }
}

// Charge one month's premium for a membership, authorized by its recurring grant
// token (rotated first, unless skipRotate). Builds a fresh incoming payment +
// quote (member → pool), creates the outgoing payment, credits the pool, and
// advances the schedule by one month.
export async function chargeMembership(
  membershipId: string,
  opts: { skipRotate?: boolean } = {}
): Promise<{ ok: boolean; transactionId?: string; received?: string; error?: string }> {
  const [m] = await db.select().from(memberships).where(eq(memberships.id, membershipId));
  if (!m)                                              return { ok: false, error: 'Membership not found' };
  if (m.status !== 'ACTIVE')                           return { ok: false, error: `Membership is ${m.status}` };
  if (!m.accessToken || !m.accessTokenManageUrl)       return { ok: false, error: 'Membership has no stored grant token' };

  const [group] = await db.select().from(groups).where(eq(groups.id, m.groupId));
  if (!group) return { ok: false, error: 'Group not found' };

  const client = await getClient();

  try {
    // 1. Get a usable token. Tokens are short-lived, so for any charge after the
    //    first we rotate the stored token to obtain a fresh one.
    let token     = m.accessToken;
    let manageUrl = m.accessTokenManageUrl;
    if (!opts.skipRotate) {
      const rotated = await client.token.rotate({ url: manageUrl, accessToken: token });
      token     = rotated.access_token.value;
      manageUrl = rotated.access_token.manage;
    }

    // 2. Build this month's incoming payment + quote (member → pool).
    const flow = await createQuoteTransaction({
      senderWalletAddress:   m.memberWalletAddress,
      receiverWalletAddress: group.poolWalletAddress,
      amount:                m.monthlyAmount,
      paymentType:           'FIXED_SEND',
      userId:                m.userId,
    });

    const [tx]       = await db.select().from(transactions).where(eq(transactions.id, flow.transactionId));
    const memberWallet = await client.walletAddress.get({ url: m.memberWalletAddress });

    // 3. Create the outgoing payment — authorized by the RECURRING grant token,
    //    no fresh consent. The auth server enforces the per-interval limit.
    const outgoing = await client.outgoingPayment.create(
      { url: memberWallet.resourceServer, accessToken: token },
      { walletAddress: memberWallet.id, quoteId: tx.quoteUrl!, metadata: { description: 'Fireline monthly debit order' } }
    );

    // 4. Settle the transaction and credit the pool balance.
    const received = tx.receiveAmount ?? '0';
    const now      = new Date();
    await db.update(transactions)
      .set({ status: 'COMPLETED', outgoingPaymentUrl: outgoing.id, updatedAt: now })
      .where(eq(transactions.id, tx.id));

    const credited = String(BigInt(group.poolBalance) + BigInt(received));
    await db.update(groups)
      .set({ poolBalance: credited, updatedAt: now })
      .where(eq(groups.id, group.id));

    // 5. Advance the schedule + persist the (possibly rotated) token.
    await db.update(memberships)
      .set({
        accessToken:          token,
        accessTokenManageUrl: manageUrl,
        lastChargeAt:         now,
        nextChargeAt:         addMonths(m.nextChargeAt ?? now, 1),
        chargesMade:          m.chargesMade + 1,
        lastError:            null,
        updatedAt:            now,
      })
      .where(eq(memberships.id, m.id));

    console.log('[debit:charged] membershipId=%s received=%s pool→%s', m.id, received, credited);
    return { ok: true, transactionId: tx.id, received };
  } catch (err) {
    const msg = (err as any)?.description ?? (err instanceof Error ? err.message : String(err));
    await db.update(memberships).set({ lastError: msg, updatedAt: new Date() }).where(eq(memberships.id, m.id));
    console.error('[debit:charge-failed] membershipId=%s err=%s', m.id, msg);
    return { ok: false, error: msg };
  }
}

// Charge every ACTIVE membership whose next charge is due (cron entrypoint).
// A scheduler can call this monthly; an admin can also trigger it on demand.
export async function runDueDebits(
  opts: { groupId?: string } = {}
): Promise<{ due: number; charged: number; failed: number; results: Array<{ membershipId: string; ok: boolean; error?: string }> }> {
  const now   = new Date();
  const conds = [eq(memberships.status, 'ACTIVE'), lte(memberships.nextChargeAt, now)];
  if (opts.groupId) conds.push(eq(memberships.groupId, opts.groupId));

  const due = await db.select().from(memberships).where(and(...conds));

  const results: Array<{ membershipId: string; ok: boolean; error?: string }> = [];
  for (const m of due) {
    const r = await chargeMembership(m.id);
    results.push({ membershipId: m.id, ok: r.ok, error: r.error });
  }

  return {
    due:     due.length,
    charged: results.filter(r => r.ok).length,
    failed:  results.filter(r => !r.ok).length,
    results,
  };
}
