import { Router } from 'express';
import crypto from 'node:crypto';
import { eq, ne, and, desc } from 'drizzle-orm';
import { isPendingGrant } from '@interledger/open-payments';
import { db } from '../db';
import { transactions, users } from '../db/schema';
import { getClient, getClientForSource, normaliseWalletAddress } from '../lib/openPayments';
import { createQuoteTransaction } from '../lib/quoteFlow';
import { config } from '../config';
import { requireAuth } from '../middleware/requireAuth';

export const remitRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/remit/wallet-info?url=<wallet-address>
//
// Resolves a wallet address and returns its asset code and scale.
// Used by the frontend to display currency info before submitting a quote.
// ─────────────────────────────────────────────────────────────────────────────
remitRouter.get('/wallet-info', requireAuth, async (req, res, next) => {
  try {
    const url = ((req.query.url as string) ?? '').trim();
    if (!url) return res.status(400).json({ error: 'Missing url parameter' });

    const client = await getClient();
    const wallet = await client.walletAddress.get({ url: normaliseWalletAddress(url) });

    res.json({ assetCode: wallet.assetCode, assetScale: wallet.assetScale });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/remit/quote
//
// Validates input, then runs the shared quote flow (lib/quoteFlow.ts):
//   resolve wallets → incoming-payment grant → incoming payment →
//   quote grant → quote → persist transaction (status=PENDING)
// ─────────────────────────────────────────────────────────────────────────────
remitRouter.post('/quote', requireAuth, async (req, res, next) => {
  try {
    const { senderWalletAddress, receiverWalletAddress, amount, paymentType } = req.body as {
      senderWalletAddress:   string;
      receiverWalletAddress: string;
      amount:      string;
      paymentType: 'FIXED_SEND' | 'FIXED_RECEIVE';
    };

    if (!senderWalletAddress || !receiverWalletAddress || !amount || !paymentType) {
      return res.status(400).json({ error: 'Missing required fields: senderWalletAddress, receiverWalletAddress, amount, paymentType' });
    }
    if (!['FIXED_SEND', 'FIXED_RECEIVE'].includes(paymentType)) {
      return res.status(400).json({ error: 'paymentType must be FIXED_SEND or FIXED_RECEIVE' });
    }

    const result = await createQuoteTransaction({
      senderWalletAddress,
      receiverWalletAddress,
      amount,
      paymentType,
      userId: req.user!.id,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/remit/consent
//
// Requests an interactive outgoing-payment grant.
// The auth server returns an interact.redirect URL — the frontend must redirect
// the user's browser there to complete consent.
// ─────────────────────────────────────────────────────────────────────────────
remitRouter.post('/consent', requireAuth, async (req, res, next) => {
  try {
    const { transactionId } = req.body as { transactionId: string };
    if (!transactionId) {
      return res.status(400).json({ error: 'Missing transactionId' });
    }

    const [tx] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
    // 404 for both missing and foreign transactions, so ids can't be probed
    if (!tx || tx.userId !== req.user!.id) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    if (tx.status !== 'PENDING') return res.status(400).json({ error: `Transaction is ${tx.status}, expected PENDING` });

    // Use the same client that will continue the grant in /callback.
    // GNAP binds a grant to the signing key used at request time — mismatching
    // keys between request and continuation returns 403 Forbidden.
    const isBackstopPayout =
      !!config.backstop.walletAddress &&
      tx.senderWalletAddress === config.backstop.walletAddress;
    const client        = isBackstopPayout ? await getClientForSource('BACKSTOP') : await getClient();
    const sendingWallet = await client.walletAddress.get({ url: tx.senderWalletAddress });

    // The nonce is required by the GNAP spec for the interact.finish hash. We store it
    // with the continuation details; verifying the callback hash is left as an exercise.
    const nonce       = crypto.randomUUID();
    const callbackUrl = `${config.backendUrl}/api/callback?transactionId=${transactionId}`;

    console.log('[op:outgoing-grant-request] txId=%s isBackstop=%s walletId=%s authServer=%s debitAmount=%s %s/%s',
      transactionId, isBackstopPayout, sendingWallet.id, sendingWallet.authServer,
      tx.debitAmount, tx.assetCode, tx.assetScale);

    let outgoingGrant: Awaited<ReturnType<typeof client.grant.request>>;
    try {
      outgoingGrant = await client.grant.request(
        { url: sendingWallet.authServer },
        {
          access_token: {
            access: [
              {
                type:       'outgoing-payment',
                actions:    ['create', 'read'],
                identifier: sendingWallet.id,
                limits: {
                  debitAmount: {
                    value:      tx.debitAmount!,
                    assetCode:  tx.assetCode,
                    assetScale: tx.assetScale,
                  },
                  // To enable recurring payments, add an ISO 8601 interval here:
                  // interval: 'R/2024-01-01T00:00:00Z/P1M'
                },
              },
            ],
          },
          interact: {
            start: ['redirect'],
            finish: {
              method: 'redirect',
              uri:    callbackUrl,
              nonce,
            },
          },
        }
      );
      console.log('[op:outgoing-grant-request:ok] txId=%s continueUri=%s interactUrl=%s',
        transactionId, (outgoingGrant as any).continue?.uri, (outgoingGrant as any).interact?.redirect);
    } catch (grantErr) {
      const status      = (grantErr as any)?.status      ?? 'unknown';
      const description = (grantErr as any)?.description ?? (grantErr as any)?.message ?? String(grantErr);
      console.error('[op:outgoing-grant-request:fail] txId=%s isBackstop=%s authServer=%s HTTP=%s body=%j',
        transactionId, isBackstopPayout, sendingWallet.authServer, status, description);
      throw grantErr;
    }

    if (!isPendingGrant(outgoingGrant) || !outgoingGrant.interact?.redirect) {
      console.error('[op:outgoing-grant-request:unexpected] txId=%s grant=%j', transactionId, outgoingGrant);
      throw new Error('Expected interactive outgoing-payment grant with interact.redirect');
    }

    await db
      .update(transactions)
      .set({
        status:             'AWAITING_GRANT',
        grantContinueUri:   outgoingGrant.continue.uri,
        grantContinueToken: outgoingGrant.continue.access_token.value,
        grantInteractNonce: nonce,
        updatedAt:          new Date(),
      })
      .where(eq(transactions.id, transactionId));

    console.log('[op:consent:stored] txId=%s status=AWAITING_GRANT interactUrl=%s',
      transactionId, outgoingGrant.interact.redirect);
    res.json({ interactUrl: outgoingGrant.interact.redirect });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/remit/status/:id
//
// Returns the current state of a transaction.
// Polled by the frontend status view every 2 s.
//
// Deliberately unauthenticated: the browser lands here straight from the wallet's
// consent redirect, and the random UUID acts as a capability. Because of that we
// only return display fields — never the GNAP continuation secrets.
// ─────────────────────────────────────────────────────────────────────────────
remitRouter.get('/status/:id', async (req, res, next) => {
  try {
    const [tx] = await db
      .select({
        id:                    transactions.id,
        status:                transactions.status,
        paymentType:           transactions.paymentType,
        senderWalletAddress:   transactions.senderWalletAddress,
        receiverWalletAddress: transactions.receiverWalletAddress,
        debitAmount:           transactions.debitAmount,
        receiveAmount:         transactions.receiveAmount,
        assetCode:             transactions.assetCode,
        assetScale:            transactions.assetScale,
        receiveAssetCode:      transactions.receiveAssetCode,
        receiveAssetScale:     transactions.receiveAssetScale,
        outgoingPaymentUrl:    transactions.outgoingPaymentUrl,
        quoteExpiresAt:        transactions.quoteExpiresAt,
        errorMessage:          transactions.errorMessage,
        createdAt:             transactions.createdAt,
        recipientName:         users.displayName,
        recipientId:           users.id,
      })
      .from(transactions)
      .leftJoin(users, eq(users.walletAddress, transactions.receiverWalletAddress))
      .where(eq(transactions.id, req.params.id));

    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    res.json(tx);
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/remit/history
//
// Bi-directional: payments the user sent, plus payments other OpenRemit users
// sent to the user's wallet address. Each row carries a `direction` and the
// counterparty (the other side of the payment), so the frontend can render
// sent amounts in the sender's currency and received amounts in the receiver's.
// ─────────────────────────────────────────────────────────────────────────────
remitRouter.get('/history', requireAuth, async (req, res, next) => {
  try {
    const me = req.user!.id;

    const txFields = {
      id:                    transactions.id,
      status:                transactions.status,
      paymentType:           transactions.paymentType,
      senderWalletAddress:   transactions.senderWalletAddress,
      receiverWalletAddress: transactions.receiverWalletAddress,
      debitAmount:           transactions.debitAmount,
      receiveAmount:         transactions.receiveAmount,
      assetCode:             transactions.assetCode,
      assetScale:            transactions.assetScale,
      receiveAssetCode:      transactions.receiveAssetCode,
      receiveAssetScale:     transactions.receiveAssetScale,
      outgoingPaymentUrl:    transactions.outgoingPaymentUrl,
      quoteExpiresAt:        transactions.quoteExpiresAt,
      errorMessage:          transactions.errorMessage,
      createdAt:             transactions.createdAt,
      counterpartyName:      users.displayName,
      counterpartyId:        users.id,
    };

    // Payments I sent — counterparty is whoever owns the receiving wallet (if known)
    const sent = await db
      .select(txFields)
      .from(transactions)
      .leftJoin(users, eq(users.walletAddress, transactions.receiverWalletAddress))
      .where(eq(transactions.userId, me))
      .orderBy(desc(transactions.createdAt))
      .limit(20)
      .all();

    // Payments other users sent to my wallet address — counterparty is the sender
    const [meRow] = await db
      .select({ walletAddress: users.walletAddress })
      .from(users)
      .where(eq(users.id, me));

    const received = meRow?.walletAddress
      ? await db
          .select(txFields)
          .from(transactions)
          .leftJoin(users, eq(users.id, transactions.userId))
          .where(and(
            eq(transactions.receiverWalletAddress, meRow.walletAddress),
            ne(transactions.userId, me),
          ))
          .orderBy(desc(transactions.createdAt))
          .limit(20)
          .all()
      : [];

    const rows = [
      ...sent.map(r => ({ ...r, direction: 'sent' as const, counterpartyWallet: r.receiverWalletAddress })),
      ...received.map(r => ({ ...r, direction: 'received' as const, counterpartyWallet: r.senderWalletAddress })),
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 20);

    res.json(rows);
  } catch (err) {
    next(err);
  }
});
