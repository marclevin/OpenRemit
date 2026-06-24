# 🕹️ GoodWager

> A retro arcade where every wager funds charity — built on Open Payments.

Play simple gambling games. **Your wager is always donated to a charity** — win or lose. When you **win**, a **sponsor** who pledged a matching pool donates the *winnings over your wager* to the same cause. You can't lose money to a house; the only question is how much good you do.

> Bet $5 on Plane Crash, hit 2× and land → the charity gets **$10** ($5 from you + $5 from a sponsor). Crash → your $5 is donated anyway.

Three games ship: **🚀 Rocket** (climb and cash out before it blows), **✈️ Plane Crash** (auto-fly, hope it lands), **🎰 Pachinko** (drop balls, settle when you stop).

Built on the [`@interledger/open-payments`](https://github.com/interledger/open-payments) SDK.

---

## The idea that makes it work

Real-money games need to feel instant — you can't pop up a wallet consent screen on every round. Open Payments makes this possible:

**Interactive consent happens ONCE per pool, not per play.** An outgoing-payment grant with a `debitAmount` limit lets the backend create *many* outgoing payments under one finalised access token until the limit is reached — with no further redirects.

- A **player** authorises a session **bankroll** (one interactive grant, limit = bankroll). The backend holds the token and fires each round's donation silently.
- A **sponsor** authorises a **pledge pool** the same way. The backend draws matches from it silently.

Per donation it's the standard three Open Payments steps — incoming payment (auto grant) → quote (auto grant) → **outgoing payment under the pre-held token**. Games stay snappy because the outcome is rolled server-side instantly; the donation settles in the background and its receipt is shown live in the game's ledger.

---

## Quick Start

### Prerequisites

- **Node.js 20+**
- An account at [wallet.interledger-test.dev](https://wallet.interledger-test.dev) with a key pair generated and uploaded. For a full demo you want **two** funded test wallets (one to play, one to sponsor) and optionally more to act as distinct charities.

### 1. Install

```bash
npm install
```

### 2. Configure

```bash
cp backend/.env.example backend/.env
```

| Variable                | Description                                                                 |
|-------------------------|-----------------------------------------------------------------------------|
| `OP_WALLET_ADDRESS`     | The app's wallet URL, e.g. `https://ilp.interledger-test.dev/usdtest`        |
| `OP_KEY_ID`             | The UUID of the key you uploaded                                             |
| `OP_PRIVATE_KEY_PATH`   | Path to the `.key` file — e.g. `./private.key`                               |
| `CHARITY_WALLET_ADDRESS`| *(optional)* default receiver for all charities — defaults to `OP_WALLET_ADDRESS` |

> The app's key signs every Open Payments request; money only moves from a wallet after that wallet's owner approves the grant in their browser. Charities default to receiving at `OP_WALLET_ADDRESS` — edit `backend/src/lib/seedCharities.ts` to give each charity its own test wallet.

### 3. Initialise the database

```bash
npm run db:push
```

### 4. Start

```bash
npm run dev      # backend :3001 + frontend :5173
```

Open [http://localhost:5173](http://localhost:5173).

---

## How to play (end to end)

1. **Sign up as a Player**, then set your **wallet address** in Profile.
2. Go to **Play**, pick a charity, set a bankroll, and **Insert Coin** → approve the one-time spending limit at your wallet.
3. Back in the arcade, play **Rocket / Plane / Pachinko**. Each wager is donated to your charity from the bankroll — no more pop-ups. Watch the **receipt ledger** show each donation go `PENDING → COMPLETED`.
4. **Sign up as a Sponsor** (or switch role in Profile), open a **pledge** backing a charity → approve the matching pool at your wallet.
5. Now when a player **wins** on that charity, the sponsor's pool automatically donates the winnings-over-wager. The **Sponsor** dashboard and **Impact** board update live.

---

## The Open Payments flow

```
  Funding a pool (player bankroll OR sponsor pledge) — ONE interactive consent
  ───────────────────────────────────────────────────────────────────────────
  POST /api/sessions  (or /api/pledges)
    ├─ walletAddress.get()        ──► resolve the player/sponsor wallet
    └─ grant.request(interactive) ──► outgoing-payment grant, limit = pool size
                                       returns an interactUrl
  Browser → auth server consent → GET /api/callback?grantType=session|pledge&id=…
    └─ grant.continue()           ──► finalised access token, stored on the row
                                       pool is now ACTIVE

  Each donation (per round, drawing on the pre-approved pool token) — NO redirect
  ───────────────────────────────────────────────────────────────────────────
  lib/donationEngine.ts
    ├─ incomingPayment.create()   ──► on the charity wallet (auto grant)
    ├─ quote.create()             ──► on the sender wallet, debit = amount (auto grant)
    └─ outgoingPayment.create()   ──► under the held pool token → money moves
```

**Key endpoints** (all under `/api`, `Bearer` token required unless noted):

- `POST /auth/signup` `{…, role: 'PLAYER'|'SPONSOR'}`, `POST /auth/login`, `GET/PATCH /auth/me`
- `GET /charities`
- `POST /sessions` → bankroll grant · `GET /sessions/active` · `GET /sessions/:id` · `POST /sessions/:id/end`
- `POST /games/plane/play` · `POST /games/rocket/play` + `/rocket/:id/cashout` · `POST /games/pachinko/drop` + `/pachinko/cashout` · `GET /games/rounds/:id` (receipt poll)
- `POST /pledges` → pool grant · `GET /pledges` (dashboard) · `POST /pledges/:id/end`
- `GET /callback` (GNAP redirect) · `GET /impact` (global + personal totals)

---

## Architecture

```
GoodWager/
├── backend/
│   └── src/
│       ├── index.ts            ← Express entry — mounts routes, seeds charities
│       ├── config.ts           ← env vars (+ CHARITY_WALLET_ADDRESS)
│       ├── lib/
│       │   ├── openPayments.ts ← SDK client singleton
│       │   ├── grantFlow.ts    ← request/continue the ONE interactive pool grant
│       │   ├── donationEngine.ts ← THE payment path: incoming→quote→outgoing, logs a donation
│       │   ├── matchingEngine.ts ← on a win, find a sponsor pledge & draw the match
│       │   ├── playEngine.ts   ← bankroll reservation + settlement (immediate vs deferred)
│       │   ├── gameEngine.ts   ← provably-fair RNG + per-game outcomes (no DB)
│       │   └── seedCharities.ts
│       ├── db/schema.ts        ← users, charities, play_sessions, game_rounds, pledges, donations
│       └── routes/             ← auth, charities, sessions, games, pledges, impact, callback
│
└── frontend/                   ← Vite + vanilla TS, retro-arcade theme (pixel/CRT)
    └── src/
        ├── main.ts             ← hash router (#/play, #/sponsor, #/impact, …)
        ├── api.ts              ← typed fetch wrappers for every route
        ├── lib/arcade.ts       ← shared canvas toolkit: pixel sprites, bankroll HUD, receipt ledger
        └── views/              ← home, login, signup, profile, lobby, gameRocket/Plane/Pachinko, sponsor, impact
```

**Provably fair:** every outcome is `HMAC_SHA256(serverSeed, "{clientSeed}:{nonce}")`. The server commits to the seed via its SHA-256 hash up front and reveals the seed when the round resolves. Rocket's crash point is sent to the client only to drive the live crash animation and is never shown to the player; the win is whatever multiplier was on screen at cash-out.

**Settlement timing:** Rocket and Plane donate the wager the moment you play (the sponsor match fires on a win). Pachinko *parks* each drop and donates them as one batch when you **cash out** — "the outgoing only happens when you stop playing."

---

## Available Scripts

| Command           | Description                                               |
| ----------------- | --------------------------------------------------------- |
| `npm run dev`     | Start backend (:3001) + frontend (:5173)                  |
| `npm run build`   | Type-check + build both packages                          |
| `npm run db:push` | Push the schema to SQLite (no migration files needed)     |

---

## Notes & assumptions

- **Testnet money only.** Everything runs against the Interledger test network — no real funds move, and nothing moves at all until a wallet owner approves their grant.
- **Pool reuse is the linchpin:** many outgoing payments under one pre-approved grant. This is standard Rafiki/testnet behaviour, proven the moment a session's second round settles with no new redirect.
- **Currency:** play assumes a single asset (testnet wallets are typically USD, scale 2). Bankroll/pool inputs are entered in major "coins" and converted to the wallet's smallest unit server-side once the wallet is resolved.
- **Sustainability:** the crash/Pachinko multiplier distributions carry a small edge so a sponsor's pool roughly tracks total wagers over time rather than draining instantly.
