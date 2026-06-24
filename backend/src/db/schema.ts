import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

// ─────────────────────────────────────────────────────────────────────────────
// GoodWager — charity gambling on Open Payments.
//
// Money model in one paragraph: a PLAYER opens a play_session by authorising a
// bankroll (one interactive outgoing-payment grant whose debitAmount limit IS
// the bankroll). Every wager they make is donated to a charity, drawing down the
// bankroll under that single pre-approved grant — no further redirects. When they
// WIN, a SPONSOR's pledge (an identical pre-approved grant) donates the winnings
// over the wager to the same charity. `donations` is the ledger of real money
// moved. All money columns are INTEGERS in the smallest asset unit (e.g. cents) —
// exact integer arithmetic, so we can do atomic "reserve if budget remains"
// updates in SQL.
// ─────────────────────────────────────────────────────────────────────────────

export const users = sqliteTable('users', {
  id:           text('id').primaryKey(),
  displayName:  text('display_name').notNull(),
  email:        text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  avatar:       text('avatar'),                              // base64 data URL
  walletAddress: text('wallet_address'),                     // set after signup
  // PLAYER lands in the arcade; SPONSOR lands in the sponsor dashboard. One
  // account can do both (a player can open a pledge and vice-versa) — this only
  // drives the default onboarding experience.
  role:         text('role').notNull().default('PLAYER'),    // 'PLAYER' | 'SPONSOR'
  createdAt:    integer('created_at', { mode: 'timestamp' }).notNull(),
});

export type User    = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// A cause the player donates to and the sponsor matches. Seeded on first boot
// (see lib/seedCharities.ts). `walletAddress` is the receiver for every donation
// — defaults to OP_WALLET_ADDRESS so money moves out of the box; paste distinct
// test wallets in the seed to make charities truly separate receivers.
export const charities = sqliteTable('charities', {
  id:            text('id').primaryKey(),
  name:          text('name').notNull(),
  blurb:         text('blurb').notNull(),
  category:      text('category').notNull(),
  walletAddress: text('wallet_address').notNull(),           // canonical https URL
  accentColor:   text('accent_color').notNull(),             // hex, for the pixel card
  createdAt:     integer('created_at', { mode: 'timestamp' }).notNull(),
});

export type Charity    = typeof charities.$inferSelect;
export type NewCharity = typeof charities.$inferInsert;

// A player's funded run. The bankroll is the debitAmount limit on the interactive
// outgoing-payment grant the player approves once. `bankrollReserved` is committed
// but not-yet-donated value (a wager mid-settlement, or a Pachinko drop awaiting
// cash-out); `bankrollSpent` is value actually donated. Remaining playable =
// bankrollLimit - bankrollSpent - bankrollReserved.
export const playSessions = sqliteTable('play_sessions', {
  id:               text('id').primaryKey(),
  userId:           text('user_id').notNull().references(() => users.id),
  charityId:        text('charity_id').notNull().references(() => charities.id),
  walletAddress:    text('wallet_address').notNull(),        // player's sending wallet

  bankrollLimit:    integer('bankroll_limit').notNull(),     // smallest unit
  bankrollSpent:    integer('bankroll_spent').notNull().default(0),
  bankrollReserved: integer('bankroll_reserved').notNull().default(0),
  assetCode:        text('asset_code').notNull(),
  assetScale:       integer('asset_scale').notNull(),

  // AWAITING_GRANT → ACTIVE → ENDED
  status:           text('status').notNull(),

  // GNAP continuation (persisted between POST /sessions and /api/callback) and
  // the finalised access token we reuse for every round's outgoing payment.
  grantContinueUri:   text('grant_continue_uri'),
  grantContinueToken: text('grant_continue_token'),
  grantInteractNonce: text('grant_interact_nonce'),
  grantAccessToken:   text('grant_access_token'),
  // Token management URL — lets us ROTATE the access token when it goes inactive
  // (the pool's grant outlives any single access token), so donations keep firing.
  grantManageUrl:     text('grant_manage_url'),

  createdAt:        integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt:        integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export type PlaySession    = typeof playSessions.$inferSelect;
export type NewPlaySession = typeof playSessions.$inferInsert;

// One bet. Outcome is rolled server-side (provably fair) at play time; the
// animation just visualises it. `multiplier` is the achieved win multiplier
// (>1 on a win); `matchAmount` is the sponsor money a win is worth
// (wager × (multiplier−1)). `settled` flips true once the user-wager donation
// has been created (immediately for Rocket/Plane, at cash-out for Pachinko).
export const gameRounds = sqliteTable('game_rounds', {
  id:            text('id').primaryKey(),
  sessionId:     text('session_id').notNull().references(() => playSessions.id),
  userId:        text('user_id').notNull().references(() => users.id),

  game:          text('game').notNull(),                     // 'ROCKET' | 'PLANE' | 'PACHINKO'
  wager:         integer('wager').notNull(),                 // smallest unit
  multiplier:    real('multiplier').notNull().default(0),    // achieved (0 until resolved)
  matchAmount:   integer('match_amount').notNull().default(0),
  outcome:       text('outcome').notNull().default('PENDING'),// 'PENDING' | 'WIN' | 'LOSS'

  // Rocket only: secret crash point + server start time for authoritative timing.
  crashPoint:    real('crash_point'),
  startedAt:     integer('started_at', { mode: 'timestamp' }),

  // Provable fairness: outcome = HMAC_SHA256(serverSeed, `${clientSeed}:${nonce}`).
  serverSeed:     text('server_seed').notNull(),
  serverSeedHash: text('server_seed_hash').notNull(),
  clientSeed:     text('client_seed').notNull(),
  nonce:          integer('nonce').notNull(),

  // JSON animation params (flight path / peg bounces) for replay & audit.
  details:       text('details'),

  settled:       integer('settled', { mode: 'boolean' }).notNull().default(false),
  createdAt:     integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt:     integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export type GameRound    = typeof gameRounds.$inferSelect;
export type NewGameRound = typeof gameRounds.$inferInsert;

// A sponsor's matching pool. poolLimit is the debitAmount limit on the sponsor's
// pre-approved outgoing grant; poolSpent is matched-so-far. charityId NULL means
// "match any charity". Remaining pool = poolLimit - poolSpent.
export const pledges = sqliteTable('pledges', {
  id:            text('id').primaryKey(),
  sponsorId:     text('sponsor_id').notNull().references(() => users.id),
  walletAddress: text('wallet_address').notNull(),           // sponsor's sending wallet
  charityId:     text('charity_id').references(() => charities.id), // NULL = any charity

  poolLimit:     integer('pool_limit').notNull(),
  poolSpent:     integer('pool_spent').notNull().default(0),
  assetCode:     text('asset_code').notNull(),
  assetScale:    integer('asset_scale').notNull(),

  // AWAITING_GRANT → ACTIVE → DEPLETED | ENDED
  status:        text('status').notNull(),

  grantContinueUri:   text('grant_continue_uri'),
  grantContinueToken: text('grant_continue_token'),
  grantInteractNonce: text('grant_interact_nonce'),
  grantAccessToken:   text('grant_access_token'),
  // Token management URL — lets us ROTATE the access token when it goes inactive
  // (the pool's grant outlives any single access token), so donations keep firing.
  grantManageUrl:     text('grant_manage_url'),

  createdAt:     integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt:     integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export type Pledge    = typeof pledges.$inferSelect;
export type NewPledge = typeof pledges.$inferInsert;

// The money ledger: one row per real Open Payments outgoing payment. USER_WAGER
// is drawn from a play_session's grant; SPONSOR_MATCH from a pledge's grant. This
// is what the receipt UI reads and what proves the payment flow worked.
export const donations = sqliteTable('donations', {
  id:            text('id').primaryKey(),
  kind:          text('kind').notNull(),                     // 'USER_WAGER' | 'SPONSOR_MATCH'

  sessionId:     text('session_id').references(() => playSessions.id),
  pledgeId:      text('pledge_id').references(() => pledges.id),
  roundId:       text('round_id').references(() => gameRounds.id),
  userId:        text('user_id').references(() => users.id), // the player whose play caused it

  senderWalletAddress:   text('sender_wallet_address').notNull(),
  charityId:             text('charity_id').references(() => charities.id),
  receiverWalletAddress: text('receiver_wallet_address').notNull(),

  amount:        integer('amount').notNull(),                // smallest unit, sender currency
  assetCode:     text('asset_code').notNull(),
  assetScale:    integer('asset_scale').notNull(),

  incomingPaymentUrl: text('incoming_payment_url'),
  quoteUrl:           text('quote_url'),
  outgoingPaymentUrl: text('outgoing_payment_url'),

  // PENDING → COMPLETED | FAILED
  status:        text('status').notNull(),
  errorMessage:  text('error_message'),

  createdAt:     integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt:     integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export type Donation    = typeof donations.$inferSelect;
export type NewDonation = typeof donations.$inferInsert;
