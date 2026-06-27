import crypto from 'node:crypto';
import { db } from '../db';
import { groups, users } from '../db/schema';
import { config } from '../config';
import { sql, eq } from 'drizzle-orm';

export async function seedGroup(): Promise<void> {
  // If no admin exists yet (e.g. after a schema migration that added the role column),
  // promote the earliest registered user to ADMIN so the app is usable immediately.
  const [{ adminCount }] = await db
    .select({ adminCount: sql<number>`count(*)` })
    .from(users)
    .where(eq(users.role, 'ADMIN'));

  if (adminCount === 0) {
    const [firstUser] = await db.select().from(users).orderBy(users.createdAt).limit(1);
    if (firstUser) {
      await db.update(users).set({ role: 'ADMIN' }).where(eq(users.id, firstUser.id));
      console.log(`[seed] Promoted to ADMIN: ${firstUser.email}`);
    }
  }

  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(groups);

  if (count > 0) {
    // Fix any group that was seeded with USD before the ZAR change
    await db
      .update(groups)
      .set({
        assetCode:         'ZAR',
        fixedPayoutAmount: '80000',  // R800
        reserveFloor:      '20000',  // R200
        designCapacity:    '800000', // R8000 (10 × R800)
        updatedAt:         new Date(),
      })
      .where(eq(groups.assetCode, 'USD'));
    return;
  }

  if (!config.backstop.walletAddress) {
    console.warn('[seed] Skipping group seed — BACKSTOP_WALLET_ADDRESS not set. Set it in backend/.env to enable the claims demo.');
    return;
  }

  const now = new Date();
  await db.insert(groups).values({
    id:                    crypto.randomUUID(),
    name:                  'Mutual Fund',
    poolWalletAddress:     config.op.walletAddress,
    backstopWalletAddress: config.backstop.walletAddress,
    fixedPayoutAmount:     '80000',  // R800 at scale 2 (ZAR cents)
    reserveFloor:          '20000',  // R200
    covariateThreshold:    3,
    designCapacity:        '800000', // R8000 = 10 × R800
    poolBalance:           '200000', // R2000 starting balance
    assetCode:             'ZAR',
    assetScale:            2,
    createdAt:             now,
    updatedAt:             now,
  });

  console.log('[seed] Seeded demo group: Khayelitsha Church Mutual (R800 ZAR payout)');
}
