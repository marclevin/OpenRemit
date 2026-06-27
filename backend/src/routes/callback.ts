import { Router } from 'express';
import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { transactions, paymentRequests, postUnlocks, claims, groups, memberships } from '../db/schema';
import { getClient, getClientForSource, isFinalizedGrant } from '../lib/openPayments';
import { activateMembership } from '../lib/debitOrder';
import { config } from '../config';

export const callbackRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/callback
//
// GNAP redirect endpoint — the auth server redirects the user's browser here
// after they complete (or deny) consent.
//
// Query params supplied by the auth server:
//   interact_ref   — exchange token used to continue the grant
//   hash           — GNAP hash for verifying the callback (optional verification)
//
// Query param we added to the callback URL in /consent:
//   transactionId  — our DB row to update
//
// Steps:
//   1. Load the transaction and validate state
//   2. Continue the grant with interact_ref → receive access token
//   3. Create the outgoing payment
//   4. Mark the transaction COMPLETED and redirect the browser to the frontend
// ─────────────────────────────────────────────────────────────────────────────
callbackRouter.get('/', async (req, res) => {
  // On success the auth server sends `interact_ref`. On rejection it sends
  // `result=grant_rejected` (and no interact_ref) — that's the user clicking
  // "Decline" at their wallet's consent page.
  const { interact_ref, transactionId, membershipId, result } = req.query as Record<string, string>;

  // Recurring debit-order enrollment finishes here too. Handle it separately
  // from one-off payment callbacks: finalize the grant, store the recurring
  // token, mark the membership ACTIVE, and run the first month's charge.
  if (membershipId) {
    if (!interact_ref || result === 'grant_rejected') {
      await db
        .update(memberships)
        .set({ status: 'CANCELLED', lastError: 'Enrollment declined at wallet.', updatedAt: new Date() })
        .where(eq(memberships.id, membershipId));
      return res.redirect(`${config.frontendUrl}/?enroll=declined#/claims`);
    }
    try {
      await activateMembership(membershipId, interact_ref);
      return res.redirect(`${config.frontendUrl}/?enroll=active#/claims`);
    } catch (err) {
      const message = (err as any)?.description ?? (err instanceof Error ? err.message : String(err));
      console.error('[callback] Enrollment failed: %s', message);
      await db
        .update(memberships)
        .set({ status: 'FAILED', lastError: message, updatedAt: new Date() })
        .where(eq(memberships.id, membershipId));
      return res.redirect(`${config.frontendUrl}/?enroll=failed#/claims`);
    }
  }

  if (!transactionId) {
    return res.status(400).send('Missing transactionId in callback query');
  }

  const [tx] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, transactionId));

  // Bug 4: double-fire guard — if browser retries the callback after the payment
  // already completed, redirect to success instead of attempting grant.continue again
  // (which would 403 because the interact_ref was already consumed).
  if (tx?.status === 'COMPLETED') {
    return res.redirect(`${config.frontendUrl}?status=completed&id=${transactionId}`);
  }
  if (!tx || tx.status !== 'AWAITING_GRANT') {
    return res.redirect(`${config.frontendUrl}?status=failed&id=${transactionId}&reason=invalid_state`);
  }

  // If this transaction unlocks a News post, send the reader back to that
  // article on return (on either outcome) instead of the generic status view.
  const [unlock] = await db
    .select({ postId: postUnlocks.postId })
    .from(postUnlocks)
    .where(and(eq(postUnlocks.transactionId, transactionId), eq(postUnlocks.status, 'PENDING')));
  const postSuffix = unlock ? `&post=${unlock.postId}` : '';

  // User declined consent (or the auth server returned no interact_ref): the
  // grant was rejected, so there's nothing to continue. Mark the payment failed
  // with a friendly reason and send them back to the app. Any linked ask/unlock
  // stays PENDING (handled like every other failure), so a retry is possible.
  if (!interact_ref || result === 'grant_rejected') {
    await db
      .update(transactions)
      .set({
        status:       'FAILED',
        errorMessage: result === 'grant_rejected'
          ? 'Payment declined — you cancelled the authorisation at your wallet.'
          : 'Authorisation did not complete. Please try the payment again.',
        updatedAt:    new Date(),
      })
      .where(eq(transactions.id, transactionId));

    return res.redirect(`${config.frontendUrl}?status=failed&id=${transactionId}${postSuffix}`);
  }

  try {
    // For claim payouts, the sender wallet may be the backstop wallet. Detect
    // this by checking if the sender matches the configured backstop address.
    const isBackstopPayout =
      config.backstop.walletAddress &&
      tx.senderWalletAddress === config.backstop.walletAddress;
    const client = isBackstopPayout ? await getClientForSource('BACKSTOP') : await getClient();

    // Continue the grant — exchanges interact_ref for an outgoing-payment access token
    console.log('[op:grant-continue] txId=%s continueUri=%s interactRef=%s isBackstop=%s',
      transactionId, tx.grantContinueUri, interact_ref, isBackstopPayout);

    let finalizedGrant: Awaited<ReturnType<typeof client.grant.continue>>;
    try {
      finalizedGrant = await client.grant.continue(
        {
          url:         tx.grantContinueUri!,
          accessToken: tx.grantContinueToken!,
        },
        { interact_ref }
      );
      console.log('[op:grant-continue:ok] txId=%s hasAccessToken=%s',
        transactionId, isFinalizedGrant(finalizedGrant));
    } catch (contErr) {
      const status      = (contErr as any)?.status      ?? 'unknown';
      const description = (contErr as any)?.description ?? (contErr as any)?.message ?? String(contErr);
      console.error('[op:grant-continue:fail] txId=%s continueUri=%s HTTP=%s body=%j',
        transactionId, tx.grantContinueUri, status, description);
      throw contErr;
    }

    if (!isFinalizedGrant(finalizedGrant)) {
      console.error('[op:grant-continue:no-token] txId=%s grant=%j', transactionId, finalizedGrant);
      throw new Error('Grant continuation did not return an access token. Consent may have been denied or expired.');
    }

    // Bug 5: GNAP rotates the continuation token on every successful continue call.
    // Persist the new tokens so any cancel/retry scenario uses the current ones.
    const rotatedContinue = (finalizedGrant as any).continue;
    if (rotatedContinue?.uri) {
      await db
        .update(transactions)
        .set({
          grantContinueUri:   rotatedContinue.uri,
          grantContinueToken: rotatedContinue.access_token?.value ?? null,
          updatedAt:          new Date(),
        })
        .where(eq(transactions.id, transactionId));
    }

    // Bug 3: quote expiry guard — the quote URL is useless once it expires, and
    // the resource server will reject the outgoing payment with a cryptic error.
    if (tx.quoteExpiresAt && new Date() > tx.quoteExpiresAt) {
      throw new Error('Quote expired before consent completed — please start a new payment.');
    }

    // Resolve the sender's resource server URL to create the outgoing payment
    const sendingWallet = await client.walletAddress.get({ url: tx.senderWalletAddress });

    // Create the outgoing payment using the previously created quote
    console.log('[op:outgoing-payment-create] txId=%s resourceServer=%s walletId=%s quoteId=%s tokenPrefix=%s',
      transactionId, sendingWallet.resourceServer, sendingWallet.id, tx.quoteUrl,
      finalizedGrant.access_token.value.slice(0, 8) + '…');

    let outgoingPayment: Awaited<ReturnType<typeof client.outgoingPayment.create>>;
    try {
      outgoingPayment = await client.outgoingPayment.create(
        {
          url:         sendingWallet.resourceServer,
          accessToken: finalizedGrant.access_token.value,
        },
        {
          walletAddress: sendingWallet.id,
          quoteId:       tx.quoteUrl!,       // quoteId = full quote URL from Step 5 of /quote
          metadata:      { description: 'OpenRemit payment' },
        }
      );
      console.log('[op:outgoing-payment-create:ok] txId=%s outgoingPaymentId=%s',
        transactionId, outgoingPayment.id);
    } catch (opErr) {
      const status      = (opErr as any)?.status      ?? 'unknown';
      const description = (opErr as any)?.description ?? (opErr as any)?.message ?? String(opErr);
      console.error('[op:outgoing-payment-create:fail] txId=%s resourceServer=%s walletId=%s quoteId=%s HTTP=%s body=%j',
        transactionId, sendingWallet.resourceServer, sendingWallet.id, tx.quoteUrl, status, description);
      throw opErr;
    }

    await db
      .update(transactions)
      .set({
        status:             'COMPLETED',
        outgoingPaymentUrl: outgoingPayment.id,
        updatedAt:          new Date(),
      })
      .where(eq(transactions.id, transactionId));

    // If this payment fulfils a payment request, close the request too.
    // (On failure the request stays PENDING so the payer can retry.)
    await db
      .update(paymentRequests)
      .set({ status: 'COMPLETED', updatedAt: new Date() })
      .where(and(
        eq(paymentRequests.transactionId, transactionId),
        eq(paymentRequests.status, 'PENDING'),
      ));

    // If this payment unlocks a News post, grant access.
    await db
      .update(postUnlocks)
      .set({ status: 'COMPLETED', updatedAt: new Date() })
      .where(and(
        eq(postUnlocks.transactionId, transactionId),
        eq(postUnlocks.status, 'PENDING'),
      ));

    // If this payment fulfils a claim payout, mark the claim PAID and update
    // the pool balance when the source was the member pool.
    const [linkedClaim] = await db
      .select()
      .from(claims)
      .where(and(eq(claims.transactionId, transactionId), eq(claims.status, 'VERIFIED')));

    // Marker so the frontend can play the payout "money-shot" on return.
    let payoutSuffix = '';

    if (linkedClaim) {
      await db
        .update(claims)
        .set({ status: 'PAID', updatedAt: new Date() })
        .where(eq(claims.id, linkedClaim.id));

      payoutSuffix = `&payout=${linkedClaim.payoutSource ?? 'POOL'}&claim=${linkedClaim.id}`;

      if (linkedClaim.payoutSource === 'POOL' && linkedClaim.payoutAmount) {
        const [grp] = await db.select().from(groups).where(eq(groups.id, linkedClaim.groupId));
        if (grp) {
          const newBalance = String(BigInt(grp.poolBalance) - BigInt(linkedClaim.payoutAmount));
          await db
            .update(groups)
            .set({ poolBalance: newBalance, updatedAt: new Date() })
            .where(eq(groups.id, linkedClaim.groupId));
        }
      }

      console.log(
        `[callback] Claim ${linkedClaim.id} marked PAID from ${linkedClaim.payoutSource ?? 'unknown'} source.`
      );
    }

    // If this completed payment landed in a group's pool wallet, treat it as a
    // member contribution and credit the pool balance. This is what makes the
    // "homes the pool can rebuild" visualization tick upward after a top-up.
    // (Claim payouts send *from* the pool wallet, so they never match here.)
    const [fundedGroup] = await db
      .select()
      .from(groups)
      .where(eq(groups.poolWalletAddress, tx.receiverWalletAddress));

    if (fundedGroup && tx.receiveAmount) {
      const credited = String(BigInt(fundedGroup.poolBalance) + BigInt(tx.receiveAmount));
      await db
        .update(groups)
        .set({ poolBalance: credited, updatedAt: new Date() })
        .where(eq(groups.id, fundedGroup.id));
      console.log(
        `[callback] Pool contribution: credited ${tx.receiveAmount} to ${fundedGroup.name} → balance ${credited}`
      );
    }

    res.redirect(`${config.frontendUrl}?status=completed&id=${transactionId}${postSuffix}${payoutSuffix}`);
  } catch (err) {
    const message = (err as any)?.description ?? (err instanceof Error ? err.message : String(err));
    console.error('[callback] Payment failed: HTTP=%s body=%j', (err as any)?.status ?? 'n/a', message);

    await db
      .update(transactions)
      .set({
        status:       'FAILED',
        errorMessage: message,
        updatedAt:    new Date(),
      })
      .where(eq(transactions.id, transactionId));

    res.redirect(`${config.frontendUrl}?status=failed&id=${transactionId}${postSuffix}`);
  }
});
