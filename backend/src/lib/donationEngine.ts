import crypto from 'node:crypto';
import type { WalletAddress, Quote } from '@interledger/open-payments';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { donations } from '../db/schema';
import type { Donation } from '../db/schema';
import { getClient, isFinalizedGrant, describeOpError, isStaleTokenError } from './openPayments';

// ─────────────────────────────────────────────────────────────────────────────
// donationEngine — move money to a charity. THE one place a real Open Payments
// outgoing payment is created in GoodWager.
//
// Every donation is a FIXED_SEND: the sender (player or sponsor) debits exactly
// `amount`, the charity receives whatever arrives. Three OP steps:
//
//   1. incoming payment on the CHARITY wallet      (non-interactive grant — auto)
//   2. quote on the SENDER wallet (debitAmount)    (non-interactive grant — auto)
//   3. outgoing payment on the SENDER wallet  ← uses the PRE-APPROVED pool token,
//                                                so NO redirect happens here.
//
// Step 3 is the whole trick: `accessToken` is the finalised token from the
// player's bankroll grant or the sponsor's pledge grant (see grantFlow.ts). We
// write a `donations` row up front (PENDING) so the attempt is always logged,
// then flip it COMPLETED/FAILED. Caller handles ledger accounting (reserve/spend).
// ─────────────────────────────────────────────────────────────────────────────

export interface DonationRequest {
  /** The pre-approved pool access token (session bankroll or pledge pool). */
  accessToken:      string;
  /** Sender = player (USER_WAGER) or sponsor (SPONSOR_MATCH). */
  senderWalletUrl:  string;
  /** Optional pre-resolved sender wallet to skip a lookup (it's constant per pool). */
  senderWallet?:    WalletAddress;
  /** Receiver = the charity's wallet. */
  charityWalletUrl: string;
  /** Amount in the sender's smallest unit. */
  amount:           number;
  kind:             'USER_WAGER' | 'SPONSOR_MATCH';
  links: {
    sessionId?: string;
    pledgeId?:  string;
    roundId?:   string;
    userId?:    string;
    charityId?: string;
  };
  /** Token management URL for the pool — lets us rotate the token if it's inactive. */
  manageUrl?:      string | null;
  /** Persist a rotated token + new manage URL back to the pool row (session/pledge). */
  onTokenRotated?: (accessToken: string, manageUrl: string) => Promise<void>;
}

export interface DonationResult {
  ok:       boolean;
  donation: Donation;
}

export async function createDonation(req: DonationRequest): Promise<DonationResult> {
  const client = await getClient();

  // Resolve the sender wallet (for currency + resource server). Charity wallet too.
  const senderWallet = req.senderWallet
    ?? (await client.walletAddress.get({ url: req.senderWalletUrl }));
  const charityWallet = await client.walletAddress.get({ url: req.charityWalletUrl });

  const id  = crypto.randomUUID();
  const now = new Date();

  // Log the attempt before touching the network, so a failure is never silent.
  await db.insert(donations).values({
    id,
    kind:                  req.kind,
    sessionId:             req.links.sessionId ?? null,
    pledgeId:              req.links.pledgeId  ?? null,
    roundId:               req.links.roundId   ?? null,
    userId:                req.links.userId    ?? null,
    senderWalletAddress:   senderWallet.id,
    charityId:             req.links.charityId ?? null,
    receiverWalletAddress: charityWallet.id,
    amount:                req.amount,
    assetCode:             senderWallet.assetCode,
    assetScale:            senderWallet.assetScale,
    status:                'PENDING',
    createdAt:             now,
    updatedAt:             now,
  });

  // Track which OP step we're on so a failure says exactly where it broke.
  let step = 'resolve wallets';
  let quote: Quote | undefined;
  try {
    // 1. Incoming payment on the charity (open-ended → FIXED_SEND).
    step = 'incoming-payment grant (charity auth server)';
    const incomingGrant = await client.grant.request(
      { url: charityWallet.authServer },
      { access_token: { access: [{ type: 'incoming-payment', actions: ['create', 'read', 'complete'] }] } },
    );
    if (!isFinalizedGrant(incomingGrant)) {
      throw new Error('Expected non-interactive incoming-payment grant');
    }
    step = 'incoming-payment create (charity resource server)';
    const incomingPayment = await client.incomingPayment.create(
      { url: charityWallet.resourceServer, accessToken: incomingGrant.access_token.value },
      { walletAddress: charityWallet.id },
    );

    // 2. Quote on the sender — debit exactly `amount`.
    step = 'quote grant (sender auth server)';
    const quoteGrant = await client.grant.request(
      { url: senderWallet.authServer },
      { access_token: { access: [{ type: 'quote', actions: ['create', 'read'] }] } },
    );
    if (!isFinalizedGrant(quoteGrant)) {
      throw new Error('Expected non-interactive quote grant');
    }
    step = 'quote create (sender resource server)';
    quote = await client.quote.create(
      { url: senderWallet.resourceServer, accessToken: quoteGrant.access_token.value },
      {
        walletAddress: senderWallet.id,
        receiver:      incomingPayment.id,
        method:        'ilp',
        debitAmount: {
          value:      String(req.amount),
          assetCode:  senderWallet.assetCode,
          assetScale: senderWallet.assetScale,
        },
      },
    );

    // 3. Outgoing payment under the PRE-APPROVED pool token — no consent needed.
    // THIS is the step that exercises the pool grant + its debitAmount limit. If
    // the token has gone inactive (the grant outlives any single token), rotate it
    // once via its management URL and retry — persisting the fresh token so future
    // donations from this pool use it directly.
    step = 'outgoing-payment create (under pre-approved pool grant)';
    const outgoingBody = {
      walletAddress: senderWallet.id,
      quoteId:       quote.id,
      metadata:      { description: req.kind === 'USER_WAGER' ? 'GoodWager donation' : 'GoodWager sponsor match' },
    };
    let outgoing: Awaited<ReturnType<typeof client.outgoingPayment.create>>;
    try {
      outgoing = await client.outgoingPayment.create(
        { url: senderWallet.resourceServer, accessToken: req.accessToken },
        outgoingBody,
      );
    } catch (err) {
      if (!(req.manageUrl && req.onTokenRotated && isStaleTokenError(err))) throw err;
      step = 'rotate pool token + retry outgoing payment';
      console.warn(`[donation] ${req.kind} pool token inactive — rotating it and retrying once.`);
      const rotated = await client.token.rotate({ url: req.manageUrl, accessToken: req.accessToken });
      await req.onTokenRotated(rotated.access_token.value, rotated.access_token.manage);
      outgoing = await client.outgoingPayment.create(
        { url: senderWallet.resourceServer, accessToken: rotated.access_token.value },
        outgoingBody,
      );
    }

    const [donation] = await db
      .update(donations)
      .set({
        status:             'COMPLETED',
        incomingPaymentUrl: incomingPayment.id,
        quoteUrl:           quote.id,
        outgoingPaymentUrl: outgoing.id,
        updatedAt:          new Date(),
      })
      .where(eq(donations.id, id))
      .returning();

    return { ok: true, donation };
  } catch (err) {
    const message = describeOpError(err);

    // Rich, single failure block — everything needed to diagnose a bad grant
    // shape, currency/scale mismatch, exhausted limit, or an expired pool token.
    console.error(
      `[donation] ${req.kind} FAILED at step "${step}"\n` +
      `           error:   ${message}\n` +
      `           sender:  ${senderWallet.id} (${senderWallet.assetCode} · scale ${senderWallet.assetScale})\n` +
      `           charity: ${charityWallet.id} (${charityWallet.assetCode} · scale ${charityWallet.assetScale})\n` +
      `           debit:   value=${req.amount} assetCode=${senderWallet.assetCode} assetScale=${senderWallet.assetScale}\n` +
      `           pool token: ${req.accessToken ? req.accessToken.slice(0, 10) + '…' : 'MISSING'}` +
      (quote
        ? `\n           quote.debitAmount:   ${JSON.stringify(quote.debitAmount)}` +
          `\n           quote.receiveAmount: ${JSON.stringify(quote.receiveAmount)}`
        : ''),
    );

    const [donation] = await db
      .update(donations)
      .set({ status: 'FAILED', errorMessage: message, updatedAt: new Date() })
      .where(eq(donations.id, id))
      .returning();

    return { ok: false, donation };
  }
}
