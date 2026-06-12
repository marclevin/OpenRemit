import { Router } from 'express';
import crypto from 'node:crypto';
import { eq, ne, and, desc } from 'drizzle-orm';
import { isPendingGrant } from '@interledger/open-payments';
import { db } from '../db';
import { transactions, users } from '../db/schema';
import { getClient, normaliseWalletAddress, isFinalizedGrant } from '../lib/openPayments';
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
// Steps:
//   1. Resolve both wallet addresses → authServer / resourceServer URLs
//   2. Non-interactive incoming-payment grant on receiver's auth server
//   3. Create incoming payment on receiver's wallet
//   4. Non-interactive quote grant on sender's auth server
//   5. Create quote on sender's wallet
//   6. Persist transaction row (status=PENDING)
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

    const senderUrl   = normaliseWalletAddress(senderWalletAddress);
    const receiverUrl = normaliseWalletAddress(receiverWalletAddress);
    const client      = await getClient();
    const fixedSend   = paymentType === 'FIXED_SEND';

    // Step 1: Resolve both wallet addresses in parallel
    const [sendingWallet, receivingWallet] = await Promise.all([
      client.walletAddress.get({ url: senderUrl }),
      client.walletAddress.get({ url: receiverUrl }),
    ]);

    // Step 2: Non-interactive incoming-payment grant (receiver's auth server)
    const incomingPaymentGrant = await client.grant.request(
      { url: receivingWallet.authServer },
      {
        access_token: {
          access: [{ type: 'incoming-payment', actions: ['create', 'read', 'complete'] }],
        },
      }
    );
    if (!isFinalizedGrant(incomingPaymentGrant)) {
      throw new Error('Expected non-interactive incoming-payment grant');
    }

    // Step 3: Create incoming payment on receiver's wallet
    //   FIXED_RECEIVE → set incomingAmount so the receiver gets exactly `amount`
    //   FIXED_SEND    → open-ended (no incomingAmount); quote drives the final receive amount
    const incomingPayment = fixedSend
      ? await client.incomingPayment.create(
          { url: receivingWallet.resourceServer, accessToken: incomingPaymentGrant.access_token.value },
          { walletAddress: receivingWallet.id }
        )
      : await client.incomingPayment.create(
          { url: receivingWallet.resourceServer, accessToken: incomingPaymentGrant.access_token.value },
          {
            walletAddress:  receivingWallet.id,
            incomingAmount: {
              value:      amount,
              assetCode:  receivingWallet.assetCode,
              assetScale: receivingWallet.assetScale,
            },
          }
        );

    // Step 4: Non-interactive quote grant (sender's auth server)
    const quoteGrant = await client.grant.request(
      { url: sendingWallet.authServer },
      {
        access_token: {
          access: [{ type: 'quote', actions: ['create', 'read'] }],
        },
      }
    );
    if (!isFinalizedGrant(quoteGrant)) {
      throw new Error('Expected non-interactive quote grant');
    }

    // Step 5: Create quote on sender's wallet
    //   receiver = incomingPayment.id (the full incoming payment URL)
    //   FIXED_SEND → set debitAmount; FIXED_RECEIVE → omit (incomingAmount drives it)
    const quote = fixedSend
      ? await client.quote.create(
          { url: sendingWallet.resourceServer, accessToken: quoteGrant.access_token.value },
          {
            walletAddress: sendingWallet.id,
            receiver:      incomingPayment.id,
            method:        'ilp',
            debitAmount: {
              value:      amount,
              assetCode:  sendingWallet.assetCode,
              assetScale: sendingWallet.assetScale,
            },
          }
        )
      : await client.quote.create(
          { url: sendingWallet.resourceServer, accessToken: quoteGrant.access_token.value },
          {
            walletAddress: sendingWallet.id,
            receiver:      incomingPayment.id,
            method:        'ilp',
          }
        );

    // Step 6: Persist transaction
    const id  = crypto.randomUUID();
    const now = new Date();

    await db.insert(transactions).values({
      id,
      status:                'PENDING',
      paymentType,
      senderWalletAddress:   senderUrl,
      receiverWalletAddress: receiverUrl,
      debitAmount:           quote.debitAmount.value,
      receiveAmount:         quote.receiveAmount.value,
      assetCode:             quote.debitAmount.assetCode,
      assetScale:            quote.debitAmount.assetScale,
      receiveAssetCode:      quote.receiveAmount.assetCode,
      receiveAssetScale:     quote.receiveAmount.assetScale,
      incomingPaymentUrl:    incomingPayment.id,
      quoteUrl:              quote.id,
      userId:                req.user!.id,
      createdAt:             now,
      updatedAt:             now,
    });

    res.json({
      transactionId: id,
      paymentType,
      quote: {
        debitAmount:   quote.debitAmount,
        receiveAmount: quote.receiveAmount,
        expiresAt:     quote.expiresAt,
      },
    });
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

    const client        = await getClient();
    const sendingWallet = await client.walletAddress.get({ url: tx.senderWalletAddress });

    // The nonce is required by the GNAP spec for the interact.finish hash. We store it
    // with the continuation details; verifying the callback hash is left as an exercise.
    const nonce       = crypto.randomUUID();
    const callbackUrl = `${config.backendUrl}/api/callback?transactionId=${transactionId}`;

    const outgoingGrant = await client.grant.request(
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

    if (!isPendingGrant(outgoingGrant) || !outgoingGrant.interact?.redirect) {
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
