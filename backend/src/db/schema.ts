import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id:           text('id').primaryKey(),
  displayName:  text('display_name').notNull(),
  email:        text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  avatar:       text('avatar'),              // base64 data URL
  walletAddress: text('wallet_address'),     // set after signup
  role:         text('role').notNull().default('MEMBER'), // 'ADMIN' | 'MEMBER'
  createdAt:    integer('created_at', { mode: 'timestamp' }).notNull(),
});

export type User    = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export const transactions = sqliteTable('transactions', {
  id:                    text('id').primaryKey(),         // crypto.randomUUID()

  // PENDING → AWAITING_GRANT → COMPLETED | FAILED
  status:                text('status').notNull(),

  // FIXED_SEND: sender specifies debitAmount
  // FIXED_RECEIVE: receiver specifies incomingAmount
  paymentType:           text('payment_type').notNull(),

  // Canonical https:// wallet address URLs
  senderWalletAddress:   text('sender_wallet_address').notNull(),
  receiverWalletAddress: text('receiver_wallet_address').notNull(),

  // Amounts in smallest asset unit (e.g. cents for USD); strings to avoid float drift
  debitAmount:           text('debit_amount'),            // what the sender pays
  receiveAmount:         text('receive_amount'),          // what the receiver gets
  assetCode:             text('asset_code').notNull(),    // sender's currency, e.g. USD
  assetScale:            integer('asset_scale').notNull(),// sender's scale, e.g. 2 (cents)
  receiveAssetCode:      text('receive_asset_code'),      // receiver's currency (may differ)
  receiveAssetScale:     integer('receive_asset_scale'),  // receiver's scale

  // Open Payments resource URLs — full canonical URLs returned by the SDK
  incomingPaymentUrl:    text('incoming_payment_url'),
  quoteUrl:              text('quote_url'),
  outgoingPaymentUrl:    text('outgoing_payment_url'),

  // When the quote stops being usable. The outgoing payment at /callback needs a
  // live quote, so a still-PENDING/AWAITING_GRANT row past this is effectively
  // dead — the frontend surfaces it as "Expired". Nullable: quotes may omit it.
  quoteExpiresAt:        integer('quote_expires_at', { mode: 'timestamp' }),

  // GNAP grant continuation — persisted so the /api/callback handler can resume
  grantContinueUri:      text('grant_continue_uri'),
  grantContinueToken:    text('grant_continue_token'),
  grantInteractNonce:    text('grant_interact_nonce'),

  userId:                text('user_id').references(() => users.id),

  errorMessage:          text('error_message'),
  createdAt:             integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt:             integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export type Transaction      = typeof transactions.$inferSelect;
export type NewTransaction   = typeof transactions.$inferInsert;

// A payment request ("ask"): the requester asks the payer to send them money.
// Pure DB record — no Open Payments resources exist until the payer fulfils it
// (quotes and incoming payments expire; an ask can sit for days).
export const paymentRequests = sqliteTable('payment_requests', {
  id:            text('id').primaryKey(),               // crypto.randomUUID()

  requesterId:   text('requester_id').notNull().references(() => users.id), // who gets paid
  payerId:       text('payer_id').notNull().references(() => users.id),     // who is asked to pay

  // FIXED_SEND:    payer sends exactly `amount` (denominated in the payer's currency)
  // FIXED_RECEIVE: requester receives exactly `amount` (denominated in the requester's currency)
  paymentType:   text('payment_type').notNull(),

  amount:        text('amount').notNull(),               // smallest asset unit, string
  assetCode:     text('asset_code').notNull(),           // currency the amount is denominated in
  assetScale:    integer('asset_scale').notNull(),

  note:          text('note'),                           // optional message to the payer

  // PENDING → COMPLETED | DECLINED | CANCELLED.
  // A failed payment leaves the ask PENDING so the payer can retry.
  status:        text('status').notNull(),

  // Set when the payer starts fulfilment; the /api/callback handler marks the
  // ask COMPLETED when this transaction's outgoing payment succeeds.
  transactionId: text('transaction_id').references(() => transactions.id),

  createdAt:     integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt:     integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export type PaymentRequest    = typeof paymentRequests.$inferSelect;
export type NewPaymentRequest = typeof paymentRequests.$inferInsert;

// A monetized news post by a seeded journalist. The excerpt is always visible;
// the body is paywalled. Readers pay a one-off Web Monetization payment — the
// reader is the payer, the app's configured wallet (OP_WALLET_ADDRESS) is the
// "monetization receiver" (the journalist's payout) — to unlock the body.
export const posts = sqliteTable('posts', {
  id:           text('id').primaryKey(),

  authorName:   text('author_name').notNull(),
  authorAvatar: text('author_avatar'),            // base64 data URL, or null for an initials placeholder
  title:        text('title').notNull(),
  excerpt:      text('excerpt').notNull(),         // free preview, always returned
  body:         text('body').notNull(),            // paywalled — only returned once unlocked
  category:     text('category'),

  // Price in MAJOR units (e.g. "0.10"). The unlock route resolves the receiver
  // wallet's live currency/scale and converts — so seeds don't hard-code a currency.
  price:        text('price').notNull(),

  // The "special" continuously-streaming article: payments stream live while the
  // reader is on the page, up to `streamLimit` (MAJOR units), then the session
  // stops. `freeToRead` posts return their body without an unlock. Nullable
  // (treated as false) so the column add is a plain, non-interactive migration.
  streaming:    integer('streaming', { mode: 'boolean' }),
  freeToRead:   integer('free_to_read', { mode: 'boolean' }),
  streamLimit:  text('stream_limit'),

  createdAt:    integer('created_at', { mode: 'timestamp' }).notNull(),
});

export type Post    = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;

// One reader's unlock of one post. Mirrors payment_requests: a PENDING row is
// created when the reader starts the unlock and linked to a transaction; the
// /api/callback handler flips it to COMPLETED when the outgoing payment lands.
// One row per (postId, userId) — reused across retries.
export const postUnlocks = sqliteTable('post_unlocks', {
  id:            text('id').primaryKey(),

  postId:        text('post_id').notNull().references(() => posts.id),
  userId:        text('user_id').notNull().references(() => users.id),

  // How the unlock was paid for:
  //   WEB_MONETIZATION — streamed via the browser's <link rel="monetization"> provider
  //   OPEN_PAYMENTS    — one-off fallback payment (grant → consent → outgoing)
  method:        text('method'),

  // OPEN_PAYMENTS only: set when the reader starts the unlock; /api/callback marks
  // the unlock COMPLETED when this transaction's outgoing payment succeeds.
  transactionId: text('transaction_id').references(() => transactions.id),

  // WEB_MONETIZATION only: the incoming-payment URL from the MonetizationEvent and
  // the amount the receiver confirmed (smallest unit), for the on-page receipt.
  wmIncomingPayment: text('wm_incoming_payment'),
  wmAmountValue:     text('wm_amount_value'),
  wmAssetCode:       text('wm_asset_code'),
  wmAssetScale:      integer('wm_asset_scale'),

  // PENDING → COMPLETED. A failed/cancelled payment leaves it PENDING for a retry.
  status:        text('status').notNull(),

  createdAt:     integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt:     integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export type PostUnlock    = typeof postUnlocks.$inferSelect;
export type NewPostUnlock = typeof postUnlocks.$inferInsert;

// ─── Fireline: Community Fire-Relief Mutual ───────────────────────────────────

// A mutual group's configuration. One row per community (e.g. one church
// congregation). Pool balance is tracked here and decremented on each POOL
// payout so the reserve-floor check can happen without querying the wallet.
export const groups = sqliteTable('groups', {
  id:                     text('id').primaryKey(),
  name:                   text('name').notNull(),

  // Wallet addresses for the two source wallets
  poolWalletAddress:      text('pool_wallet_address').notNull(),
  backstopWalletAddress:  text('backstop_wallet_address').notNull(),

  // Fixed payout per verified claim (smallest asset unit)
  fixedPayoutAmount:      text('fixed_payout_amount').notNull(),
  // Pool must stay above this floor; a claim that would breach it draws backstop
  reserveFloor:           text('reserve_floor').notNull(),
  // How many near-simultaneous claims classify an event as COVARIATE
  covariateThreshold:     integer('covariate_threshold').notNull(),
  // fixedPayoutAmount × max claims per event — the one number we defend in pitch
  designCapacity:         text('design_capacity').notNull(),

  // Tracked pool balance (simulated — decremented on each POOL payout)
  poolBalance:            text('pool_balance').notNull(),

  assetCode:              text('asset_code').notNull(),
  assetScale:             integer('asset_scale').notNull(),

  createdAt:              integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt:              integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export type Group    = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;

// One fire event (one fire incident at a location). Multiple claims can share
// an event (e.g. several households hit in the same blaze). Classification is
// set/re-checked each time a claim is filed or triggered.
export const fireEvents = sqliteTable('fire_events', {
  id:             text('id').primaryKey(),
  groupId:        text('group_id').notNull().references(() => groups.id),
  location:       text('location').notNull(),
  occurredAt:     integer('occurred_at', { mode: 'timestamp' }).notNull(),
  reportedAt:     integer('reported_at', { mode: 'timestamp' }).notNull(),
  // SINGLE: within normal pool capacity | COVARIATE: threshold breached → backstop
  classification: text('classification').notNull(),
  claimCount:     integer('claim_count').notNull().default(0),
  createdAt:      integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt:      integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export type FireEvent    = typeof fireEvents.$inferSelect;
export type NewFireEvent = typeof fireEvents.$inferInsert;

// One household's relief claim against a group for an event.
// Status: PENDING → VERIFIED → PAID | REJECTED
// The claimant wallet is bound at enrolment (verified via the community);
// payout only ever goes to this wallet.
export const claims = sqliteTable('claims', {
  id:             text('id').primaryKey(),
  groupId:        text('group_id').notNull().references(() => groups.id),
  eventId:        text('event_id').notNull().references(() => fireEvents.id),

  // Enrolment-bound wallet address for this household — payout destination
  claimantWallet: text('claimant_wallet').notNull(),

  // Who filed this claim (may be the affected household or a community member on their behalf)
  filedByUserId:  text('filed_by_user_id').references(() => users.id),

  // PENDING | VERIFIED | PAID | REJECTED
  status:         text('status').notNull(),

  // Set at payout time
  payoutAmount:   text('payout_amount'),
  // POOL | BACKSTOP — which source wallet funded this payout
  payoutSource:   text('payout_source'),

  // The transactions row created for this payout
  transactionId:  text('transaction_id').references(() => transactions.id),

  createdAt:      integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt:      integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export type Claim    = typeof claims.$inferSelect;
export type NewClaim = typeof claims.$inferInsert;

// A member's recurring R30/month debit order into the pool, backed by a real
// Open Payments recurring outgoing-payment grant. The member consents ONCE
// (interactive) to a grant whose limit carries an ISO-8601 `interval` (P1M) and
// a per-interval `debitAmount`. The finalized access token + its management URL
// are stored so the backend can charge each month WITHOUT re-consent (rotating
// the token before each charge).
// Status: PENDING_CONSENT → ACTIVE → CANCELLED | FAILED
export const memberships = sqliteTable('memberships', {
  id:              text('id').primaryKey(),
  groupId:         text('group_id').notNull().references(() => groups.id),
  userId:          text('user_id').notNull().references(() => users.id),

  // The wallet the monthly debit is pulled from (member's own wallet)
  memberWalletAddress: text('member_wallet_address').notNull(),

  // Per-interval debit (smallest asset unit, e.g. "3000" = R30 at scale 2)
  monthlyAmount:   text('monthly_amount').notNull(),
  // ISO-8601 repeating interval sent as the grant limit, e.g. R/2026-07-01T00:00:00Z/P1M
  interval:        text('interval').notNull(),

  // PENDING_CONSENT | ACTIVE | CANCELLED | FAILED
  status:          text('status').notNull(),

  // GNAP continuation details for the enrollment consent (until finalized)
  grantContinueUri:   text('grant_continue_uri'),
  grantContinueToken: text('grant_continue_token'),
  grantInteractNonce: text('grant_interact_nonce'),

  // The finalized recurring grant's access token + management URL. Rotated and
  // reused to create each monthly outgoing payment without further consent.
  accessToken:        text('access_token'),
  accessTokenManageUrl: text('access_token_manage_url'),

  // Scheduling
  nextChargeAt:    integer('next_charge_at', { mode: 'timestamp' }),
  lastChargeAt:    integer('last_charge_at', { mode: 'timestamp' }),
  chargesMade:     integer('charges_made').notNull().default(0),
  lastError:       text('last_error'),

  createdAt:       integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt:       integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export type Membership    = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
