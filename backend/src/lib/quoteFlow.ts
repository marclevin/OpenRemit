import crypto from 'node:crypto';
import type { WalletAddress } from '@interledger/open-payments';
import { db } from '../db';
import { transactions } from '../db/schema';
import { getClient, normaliseWalletAddress, isFinalizedGrant } from './openPayments';

// The first half of every payment: resolve wallets, create the incoming
// payment on the receiver's wallet, quote it on the sender's wallet, and
// persist a PENDING transaction. Used by POST /api/remit/quote (direct sends)
// and POST /api/requests/:id/fulfill (paying a payment request). The second
// half — interactive consent + outgoing payment — lives in /consent and
// /api/callback.

export interface QuoteFlowInput {
  senderWalletAddress:   string; // "$pointer" or https URL — normalised here
  receiverWalletAddress: string;
  /** Amount in smallest asset unit (FIXED_SEND: sender's; FIXED_RECEIVE: receiver's) */
  amount:      string;
  paymentType: 'FIXED_SEND' | 'FIXED_RECEIVE';
  userId:      string;
  /**
   * Runs after both wallets are resolved but BEFORE any Open Payments resource
   * is created. Throw to abort — e.g. a payment request whose denominating
   * wallet currency changed since the ask was made.
   */
  validateWallets?: (sendingWallet: WalletAddress, receivingWallet: WalletAddress) => void;
}

export interface QuoteFlowResult {
  transactionId: string;
  paymentType:   'FIXED_SEND' | 'FIXED_RECEIVE';
  quote: {
    debitAmount:   { value: string; assetCode: string; assetScale: number };
    receiveAmount: { value: string; assetCode: string; assetScale: number };
    expiresAt?:    string;
  };
}

export async function createQuoteTransaction(input: QuoteFlowInput): Promise<QuoteFlowResult> {
  const senderUrl   = normaliseWalletAddress(input.senderWalletAddress);
  const receiverUrl = normaliseWalletAddress(input.receiverWalletAddress);
  const client      = await getClient();
  const fixedSend   = input.paymentType === 'FIXED_SEND';

  // Step 1: Resolve both wallet addresses in parallel
  const [sendingWallet, receivingWallet] = await Promise.all([
    client.walletAddress.get({ url: senderUrl }),
    client.walletAddress.get({ url: receiverUrl }),
  ]);

  input.validateWallets?.(sendingWallet, receivingWallet);

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
            value:      input.amount,
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
            value:      input.amount,
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
    paymentType:           input.paymentType,
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
    quoteExpiresAt:        quote.expiresAt ? new Date(quote.expiresAt) : null,
    userId:                input.userId,
    createdAt:             now,
    updatedAt:             now,
  });

  return {
    transactionId: id,
    paymentType:   input.paymentType,
    quote: {
      debitAmount:   quote.debitAmount,
      receiveAmount: quote.receiveAmount,
      expiresAt:     quote.expiresAt,
    },
  };
}
