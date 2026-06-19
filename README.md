# OpenRemit

> A bare-bones, Open Payments remittance template for hackers.

A minimal, fully-functional monorepo that implements the complete Open Payments Send → Receive flow using the [`@interledger/open-payments`](https://github.com/interledger/open-payments) SDK. Built as a hackathon launchpad.

---

## Quick Start

### Prerequisites

- **Node.js 20+**
- An account at [wallet.interledger-test.dev](https://wallet.interledger-test.dev) with a key pair generated and uploaded

### 1. Clone & install

```bash
git clone https://github.com/marclevin/OpenRemit.git openremit && cd openremit
npm install
```

### 2. Get your wallet credentials

You can obtain test wallet credentials from the [Interledger Test Wallet](https://wallet.interledger-test.dev):

1. Create an account in the **Interledger Test Wallet**
   (<https://wallet.interledger-test.dev>) and create one or more **wallet addresses**. For a
   peer-to-peer payment you need a sending and a receiving wallet address; the client wallet
   address can be the sending one.
2. Generate a **key pair** for your account (**Settings → Developer Keys → Add Key**). You'll get a **Key ID** and a **private key
   file** (e.g. `private.key`). Keep the private key on the machine that runs the backend.

### 3. Configure

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env`:

| Variable            | Description                                                    |
|---------------------|----------------------------------------------------------------|
| `OP_WALLET_ADDRESS` | Your wallet URL, e.g. `https://ilp.interledger-test.dev/alice` |
| `OP_KEY_ID`         | The UUID of the key you uploaded                               |
| `OP_PRIVATE_KEY_PATH` | Path to the `.key` file — e.g. `./private.key`               |

### 4. Initialise the database

```bash
npm run db:push
```

### 5. Start

```bash
npm run dev      # backend :3001 + frontend :5173
```

Open [http://localhost:5173](http://localhost:5173).

---

## The Open Payments Flow

```
  Frontend                 Backend                   Open Payments Network
  ──────────────────────   ──────────────────────── ────────────────────────
  1. Fill in form          POST /api/remit/quote
     (wallets + amount)    ├─ walletAddress.get()   ──► Resolve both wallets
                           ├─ grant.request()       ──► Incoming-payment grant
                           ├─ incomingPayment.create()► Create incoming payment
                           ├─ grant.request()       ──► Quote grant
                           └─ quote.create()        ──► Get quote & fee

  2. Review quote          POST /api/remit/consent
     → click Authorise     ├─ grant.request()       ──► Interactive outgoing grant
                           └─ returns interactUrl

  3. Browser redirected ──────────────────────────────► Auth server consent page
     to auth server                                      (user approves)

  4. Auth server       ──► GET /api/callback
     redirects back        ├─ grant.continue()      ──► Exchange interact_ref
                           ├─ outgoingPayment.create()► Execute payment
                           └─ redirect to frontend

  5. Status view polls     GET /api/remit/status/:id
     until COMPLETED
```

**Summary:**

- `POST /api/remit/quote` — resolve wallets, create incoming payment + quote
- `POST /api/remit/consent` — request interactive outgoing grant, get interact URL
- `GET /api/callback` — continue grant, create outgoing payment
- `GET /api/remit/status/:id` — poll current transaction state
- `GET /api/remit/history` — the current user's sent payments
- `GET /api/remit/wallet-info?url=…` — resolve a wallet's currency before quoting

**Accounts & users** (all remit routes except `/status/:id` require a `Bearer` token):

- `POST /api/auth/signup`, `POST /api/auth/login` — issue a 7-day JWT
- `GET /api/auth/me`, `PATCH /api/auth/me` — read / update the profile (display name, email, password, wallet address, avatar)
- `GET /api/users/search?q=…` — find recipients by display name
- `GET /api/users/:id` — public profile + transactions shared with the current user

**Payment requests ("asks")** — the pull side of payments (all require a `Bearer` token):

- `POST /api/requests` — ask another user to send you money (`FIXED_SEND` = they send exactly X in *their* currency; `FIXED_RECEIVE` = you receive exactly X in *yours*). No Open Payments resources are created yet — quotes and incoming payments expire, so the OP flow runs fresh at fulfilment.
- `GET /api/requests` — `{ incoming, outgoing }` asks for the current user
- `POST /api/requests/:id/fulfill` — payer accepts: runs the shared quote flow (`backend/src/lib/quoteFlow.ts`) and returns the same shape as `/api/remit/quote`, so the frontend continues into the normal consent → callback pipeline; `/api/callback` marks the ask COMPLETED when the payment succeeds
- `POST /api/requests/:id/decline` (payer), `POST /api/requests/:id/cancel` (requester)

**News ("The Ledger")** — a [Web Monetization](https://webmonetization.org/specification/) demo (all require a `Bearer` token). Seeded articles by a fictional journalist; the reader is the payer, `OP_WALLET_ADDRESS` is the monetization receiver.

- `GET /api/news/posts` — list articles with a per-reader `unlocked` flag (never returns the paywalled body)
- `GET /api/news/posts/:id` — one article; body returned when unlocked or the post is `freeToRead`, plus a `MonetizationEvent`-style receipt
- `POST /api/news/posts/:id/wm-unlock` — **primary path**: the browser streams payments via `<link rel="monetization">`; this records (and best-effort verifies) the unlock. No grant/consent runs.
- `POST /api/news/posts/:id/unlock` — **fallback** for browsers without a Web Monetization provider: returns a `QuoteResponse` that feeds the normal consent → callback flow

> **Heads-up for the demo:** real Web Monetization needs a provider in the browser — install the [Web Monetization extension](https://webmonetization.org/) with a funded testnet wallet. Without one, articles show a notice and offer the one-off Open Payments fallback (so nothing looks broken). One article (`streaming: true` in `backend/src/lib/seedNews.ts`) is free to read and streams live up to a cap instead of unlocking.

---

## Architecture at a Glance

```
OpenRemit/
├── package.json               ← workspace root, `npm run dev` starts everything
│
├── backend/
│   ├── src/
│   │   ├── index.ts           ← Express entry point — mount routes here
│   │   ├── config.ts          ← All env vars in one place
│   │   ├── lib/
│   │   │   ├── openPayments.ts← SDK client singleton (start here for OP changes)
│   │   │   ├── quoteFlow.ts   ← shared resolve → incoming payment → quote flow
│   │   │   └── seedNews.ts    ← seeds the demo News articles on first boot
│   │   ├── db/
│   │   │   ├── schema.ts      ← Database tables (users, transactions, payment_requests, posts, post_unlocks)
│   │   │   └── index.ts       ← Drizzle + libsql (SQLite file) instance
│   │   ├── routes/
│   │   │   ├── remit.ts       ← wallet-info / quote / consent / status / history
│   │   │   ├── callback.ts    ← GNAP redirect handler
│   │   │   ├── auth.ts        ← signup / login / profile (JWT)
│   │   │   ├── users.ts       ← user search + public profiles
│   │   │   ├── requests.ts    ← payment requests ("asks")
│   │   │   └── news.ts        ← Web Monetization news demo (list / unlock / wm-unlock)
│   │   └── middleware/
│   │       ├── requireAuth.ts ← Bearer-token guard, sets req.user
│   │       └── errorHandler.ts
│   └── drizzle.config.ts
│
└── frontend/
    ├── index.html             ← Header + nav shell; views render into #view
    └── src/
        ├── main.ts            ← Hash router (#/login, #/remit, …) — boot here
        ├── api.ts             ← Typed fetch wrappers for every backend route
        ├── auth.ts            ← JWT storage helpers (localStorage)
        ├── escape.ts          ← escapeHtml() — use for anything user-entered
        ├── styles.css         ← Edit :root vars to rebrand
        └── views/
            ├── homeView.ts          ← Landing page (public + logged-in)
            ├── loginView.ts / signupView.ts
            ├── profileView.ts       ← Edit profile, wallet address, avatar
            ├── publicProfileView.ts ← Other users + shared transactions
            ├── quoteView.ts         ← Step 1: pick recipient + amount
            ├── consentView.ts       ← Step 2: confirm quote, redirect to wallet
            ├── statusView.ts        ← Step 3: poll & display result
            ├── historyView.ts       ← Past payments table
            ├── receiveView.ts       ← Request money (create asks)
            ├── newsView.ts          ← News article grid
            └── newsArticleView.ts   ← Article + Web Monetization streaming / paywall
```

---

## Context for AI Assistants

> Paste this section into Claude, ChatGPT, or Cursor when extending the template.

**Project:** OpenRemit — TypeScript monorepo. Backend: Node.js + Express + Drizzle ORM + SQLite. Frontend: Vite + vanilla TypeScript (no framework). Core SDK: `@interledger/open-payments`.

**SDK Client:** Singleton in `backend/src/lib/openPayments.ts`. `getClient()` returns an authenticated client. `privateKey` is a file path — the SDK reads the `.pem` itself. All payment/quote `create` calls use the wallet's `resourceServer` URL (from `walletAddress.get()`), not the wallet address URL.

**Key SDK patterns (confirmed from working code):**

```typescript
const client = await createAuthenticatedClient({ walletAddressUrl, keyId, privateKey: './path.key' });
const wallet = await client.walletAddress.get({ url: 'https://...' });
// wallet.authServer  → use for grant.request()
// wallet.resourceServer → use for incomingPayment/quote/outgoingPayment create()
// wallet.id          → use as walletAddress in create() bodies

// Non-interactive grant (incoming payment, quote):
const grant = await client.grant.request({ url: wallet.authServer }, { access_token: { access: [...] } });

// Interactive grant (outgoing payment) — requires user redirect:
const pending = await client.grant.request({ url: ... }, { access_token: {...}, interact: { start: ['redirect'], finish: { method: 'redirect', uri: callbackUrl, nonce } } });
// isPendingGrant(pending) === true; pending.interact.redirect → send user there

// After callback:
const final = await client.grant.continue({ url: pending.continue.uri, accessToken: pending.continue.access_token.value }, { interact_ref });

// Outgoing payment uses quote.id (full URL):
await client.outgoingPayment.create({ url: sendingWallet.resourceServer, accessToken: final.access_token.value }, { walletAddress: sendingWallet.id, quoteId: quote.id });
```

**Database:** Three tables in `backend/src/db/schema.ts`: `users` (JWT auth via bcrypt password hash, optional wallet address + avatar), `transactions`, and `payment_requests` (asks: `PENDING → COMPLETED | DECLINED | CANCELLED`; a failed payment leaves the ask PENDING for retry). Transaction statuses: `PENDING → AWAITING_GRANT → COMPLETED | FAILED`. The `grantContinueUri`, `grantContinueToken`, and `grantInteractNonce` columns persist the GNAP continuation details between the `/consent` and `/callback` requests.

**Auth:** `POST /api/auth/signup` / `login` return `{ token, user }`. The frontend stores the JWT in localStorage (`frontend/src/auth.ts`) and sends it as a `Bearer` header (`frontend/src/api.ts`). Protected routes use the `requireAuth` middleware, which sets `req.user`.

**Frontend routing:** `main.ts` is a hash router — `#/login`, `#/remit`, `#/history`, `#/profile`, `#/user/:id` — that renders one view at a time into `#view`. Each view module exports a single `render…View(container, …)` function that sets `container.innerHTML` and wires events. User-entered values must be passed through `escapeHtml()` (`frontend/src/escape.ts`) before interpolation. After the GNAP redirect the backend sends the browser to `FRONTEND_URL?status=...&id=<uuid>` — `main.ts` detects the `id` param and goes directly to the status view.

**To add a new API route:** add a handler in `backend/src/routes/`, wire it in `backend/src/index.ts`, and add a typed wrapper in `frontend/src/api.ts`.
**To add a DB field:** edit `backend/src/db/schema.ts`, run `npm run db:push`.
**To change the UI:** edit `frontend/src/views/*.ts` — `api.ts` types stay stable.

---

## Available Scripts

| Command           | Description                                               |
| ----------------- | --------------------------------------------------------- |
| `npm run dev`     | Start backend (:3001) + frontend (:5173)                  |
| `npm run build`   | Build both packages                                       |
| `npm run db:push` | Push schema changes to SQLite (no migration files needed) |

---

## Extending the Template

### Add a contacts / favourites list

1. Add a `contacts` table to `backend/src/db/schema.ts` (`userId`, `contactUserId`)
2. Add `GET/POST /api/users/contacts` routes guarded by `requireAuth`
3. Run `npm run db:push`, then surface the list in `quoteView.ts` next to search

### Add recurring payments

In `POST /api/remit/consent`, add an `interval` to the outgoing grant limits:

```typescript
limits: {
  debitAmount: { ... },
  interval: 'R/2024-01-01T00:00:00Z/P1M', // 12 monthly payments
}
```

### Swap in a React frontend

Replace `frontend/src/views/*.ts` with React components. The `api.ts` module (typed fetch wrappers) stays unchanged — just import and call `api.quote()`, `api.consent()`, `api.status()` from your components.

### Deploy to production

1. Set `BACKEND_URL` to your public backend URL so the GNAP callback reaches the internet
2. Set `FRONTEND_URL` to your public frontend URL
3. Point `OP_PRIVATE_KEY_PATH` to the key file on your server (or use a secrets manager)

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Missing required environment variable: OP_WALLET_ADDRESS` | Copy `backend/.env.example` → `backend/.env` and fill in credentials |
| `Grant continuation did not return an access token` | Consent was denied, expired, or already used — try again from the quote step |
| `Expected non-interactive incoming-payment grant` | The receiver's wallet requires interactive consent for incoming payments (rare on testnet) |
| Frontend can't reach backend | Check `VITE_BACKEND_URL` in `frontend/.env` (default: `http://localhost:3001`) and that CORS allows your frontend origin |
