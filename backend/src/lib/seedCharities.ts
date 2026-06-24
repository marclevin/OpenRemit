import crypto from 'node:crypto';
import { db } from '../db';
import { charities } from '../db/schema';
import { config } from '../config';
import { normaliseWalletAddress } from './openPayments';

// Seeds the causes players donate to and sponsors match. Idempotent: a no-op once
// any charity exists, so it's safe on every boot. Mirrors the old seedNews.ts.
//
// Every charity receives at `config.charityWalletAddress`, which defaults to your
// OP_WALLET_ADDRESS — so donations actually move on the testnet out of the box.
// To make charities truly distinct receivers, create separate test wallets at
// wallet.interledger-test.dev and paste each into its `wallet` field below.

const SEED: ReadonlyArray<{ name: string; blurb: string; category: string; accentColor: string; wallet?: string }> = [
  {
    name:        'Hope Foundation',
    blurb:       'Emergency shelter and warm meals for families who lost everything.',
    category:    'Humanitarian',
    accentColor: '#ff5a5f',
  },
  {
    name:        'CleanWater Collective',
    blurb:       'Wells and filtration so every village drinks safe water.',
    category:    'Environment',
    accentColor: '#23c0e6',
  },
  {
    name:        'BrightFutures Schools',
    blurb:       'Books, laptops and teachers for kids the system forgot.',
    category:    'Education',
    accentColor: '#ffce3a',
  },
  {
    name:        'PawsRescue',
    blurb:       'Vet care and forever homes for abandoned animals.',
    category:    'Animals',
    accentColor: '#8be04e',
  },
];

export async function seedCharities(): Promise<void> {
  const existing = await db.select({ id: charities.id }).from(charities).limit(1);
  if (existing.length > 0) return;

  const fallback = normaliseWalletAddress(config.charityWalletAddress);
  const now = Date.now();

  await db.insert(charities).values(
    SEED.map((c, i) => ({
      id:            crypto.randomUUID(),
      name:          c.name,
      blurb:         c.blurb,
      category:      c.category,
      walletAddress: c.wallet ? normaliseWalletAddress(c.wallet) : fallback,
      accentColor:   c.accentColor,
      createdAt:     new Date(now - i * 1000),
    })),
  );
  console.log(`[seed] Inserted ${SEED.length} charities`);
}
