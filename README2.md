# OpenRemit → Community Fire-Relief Mutual — Project & Agent Briefing

> **For AI assistants (including future Claude sessions) picking up this project:** This file
> is your source of truth for *intent, history, and scope*. The **code** is the source of truth
> for *how the SDK is actually used* — when this file and the code disagree, the code wins, and
> you tell me. Several decisions below were arrived at by deliberately rejecting simpler
> alternatives (Section 3). Don't reintroduce a rejected approach without understanding why it
> was dropped.

---

## 0. Operating rules (follow these on every change)

1. **Analyze first.** Think step-by-step before generating code. If you are unsure about an
   Open Payments API, an SDK method, or a library, **verify against the repo's own example
   and/or official docs before writing** — do not guess SDK shapes.
2. **Surgical changes.** Provide targeted snippets and edit the specific files. Do not rewrite
   whole files unless asked. Prioritise simplicity, readability, separation of concerns. No
   premature optimisation, no speculative abstractions.
3. **Verification & testing.** Every change ships with how to verify it: a build/run command,
   a concrete test path through the app, and the expected output (DB rows, balances, status).
4. **Transparency.** If you detect a mistake, say **"Let me correct myself,"** state the
   mistake, give the corrected answer. Never speculate when you don't know — read the code or
   the docs instead.

---

## 1. The event & constraints

UCT Financial Innovation Hub Bootcamp hackathon. Team of 3. Scored out of 20 across: Quality of
idea (5) / Potential strategic impact (5) / Implementation incl. **Open Payments use is
mandatory** (5) / UX & presentation (5).

Framing course is financial inclusion. Recurring rubric: *what problem
does it solve, who is excluded and why, access vs. use, who gains and who loses, what is the
role of the state.* Inclusion ladder: access → use → quality → welfare.

Starter template: **OpenRemit**, an existing TypeScript monorepo / Open Payments remittance app.
We are extending it, not building from scratch.

---

## 2. The pitch

**Persona:** Nomsa, a member of a church congregation in an informal settlement (e.g.
Khayelitsha). Exposed to shack fires, excluded from formal insurance, no fast source of cash in
the immediate aftermath.

**Problem statement:** When a shack fire destroys a household's belongings in an informal
settlement, residents have no access to formal insurance and no fast source of cash in the
critical first 48 hours — for shelter, food, transport, or replacing lost documents. Existing
help from NGOs and the municipality is vital but arrives days later.

**Solution statement:** A two-layer community relief fund on Open Payments: members of an
existing trusted group (a church congregation) pre-fund a pool held by a licensed custodian
that pays a fixed relief amount directly to a verified fire-affected member's wallet within
hours, backed by an externally funded backstop tranche sized to absorb settlement-wide events the
member pool alone cannot. We control that verified victims receive flexible cash in their own
account, and deliberately leave how it's spent to the household.

**Honest scope:** This is **capped bridging relief, not insurance.** It does not make anyone
whole. It is fast, small, dignified, first-response cash — a bridge until NGOs/municipal
disaster relief arrive.

---

## 3. Why this design (history — don't relitigate these)

The team went through several iterations before landing here. Context for *why* alternatives
were rejected, so they aren't quietly re-suggested:

- **Generic stokvel/rotating-savings pooling** — considered, deprioritised as too common a
  hackathon idea; doesn't showcase anything distinctive about Open Payments beyond a basic
  recurring payment.
- **A wallet-holding product** — explicitly **ruled out by the team's tutor** (custody / e-money
  licensing risk for a hackathon project). Working principle adopted: **the app holds authority
  (grants), never funds.** Value rests in a participant's own existing wallet until the instant
  of transfer.
- **Standby grant mesh** (members hold dormant pull-grants on each other, fired peer-to-peer at
  trigger time, no pooling) — seriously explored and rejected for this specific peril. It fails
  because shack fires are a **covariate risk**: many households are hit simultaneously, so the
  pledgers and the claimants are the same population at the moment it matters. Also fails
  because low-income members are unlikely to have a pullable balance sitting idle at a random
  trigger moment, and because revocable standing pledges create a bank-run dynamic (people
  revoke when they sense the mesh is being tapped heavily). The mesh mechanic is actuarially
  sound for *idiosyncratic* shocks (death, job loss, medical emergency) — just not for
  fire/flood.
- **Conclusion:** moved to a **pre-funded mutual model** (escrow/custodian-held pool)
  specifically because it solves the standby mesh's two fatal flaws — fund availability at
  trigger time, and the bank-run dynamic — at the cost of reintroducing custody (mitigated by
  using a licensed custodian, not building a wallet ourselves).

**Open question still to resolve with the tutor:** does a custodian-held pre-funded pool satisfy
the "no wallet" instruction, given the team builds no wallet and holds no float, but a
third-party custodian does hold funds on members' behalf? Flag this explicitly — don't assume
it's settled.

---

## 4. Architecture — the two-layer model

This is the core of the design and the answer to the hardest objection the idea faces ("fires
hit many houses at once, so a pool can't cover that").

- **Layer 1 — member pool (speed):** funded by member contributions, held by a licensed
  custodian. Covers everyday single-shack fires in full. On a large event, fires the first
  capped response before hitting its limit.
- **Layer 2 — backstop tranche (scale):** a separate, outside-funded wallet (NGO / municipal /
  CSR). Guarantees the fixed payout up to a **design capacity** and absorbs settlement-wide
  (covariate) events, because the capital isn't inside the settlement and isn't wiped out with
  it.

**Why two layers, not one:** each layer is matched to the risk it can actually bear. Member pool
= uncorrelated capital for the common case. Backstop = capital uncorrelated with the local
peril, for the tail case. This maps onto the standard insurance "reserves + reinsurance"
pattern — not naively reinventing insurance, but explicitly assigning risk types to the layer
built for them.

**Covariate classification:** the number of verified claims from one location within the
reporting window is the signal. One claim → `SINGLE` → member pool. Several near-simultaneous
claims from the same location → `COVARIATE` → backstop unlocks too.

---

## 5. Design decisions that constrain the code — do not "helpfully" change these

- **Fixed payout per verified claim.** Equal amount for everyone. **Not pro-rata, not
  first-come-first-served.** Do not add allocation logic. (Sequencing: build the
  guaranteed-fixed version now; a documented step-down tier past design capacity is future
  work — see §9.)
- **No spend control.** Funds go to the victim's wallet; the system never restricts or tracks
  how they are spent. Do not add categories, vouchers, or merchant restrictions. This is
  deliberate, not a gap — backed by cash-transfer evidence (e.g. GiveDirectly RCTs) that
  unconditional cash to low-income recipients is well-spent, and by the principle that
  restricting spend would slow relief and reintroduce closed-loop-voucher exclusion. Stated
  design principle: *"We control that verified victims receive the funds in their own account.
  We deliberately do not control how it's spent."* If a backstop funder demands accountability,
  the answer is light-touch aggregate reporting (who received relief, that events were
  verified real) — never per-purchase tracking.
- **Recipient integrity instead of spend control.** The victim's wallet is **bound at
  enrolment** (calm, pre-crisis, verified via the church — not invented at claim time). Payout
  only ever goes to that bound wallet. Community attestation also implicitly confirms *which*
  household was affected.
- **Reserve floor.** The pool is never drawn below a configured floor `X`. A claim that would
  breach the floor, or that the pool can't cover, draws from the **backstop** instead.
- **48-hour reporting window.** A claim must be filed within 48 hours of the fire (clock starts
  at the confirmed fire event time, not report time). The victim *or* a member of the trusted
  group can file on their behalf — realistic, and avoids penalising someone who lost their
  phone/ID in the fire.
- **Verification posture.** Community **M-of-N attestation**, leaning on fire being a public,
  hard-to-fake event. Rigour is deliberately proportional to the small capped payout, not
  maximal — fraud is bounded by the fixed-amount cap, made costly by the repeated social game
  within a small trusted group, and made detectable via pattern flags. Stated position: fraud
  is *managed*, not eliminated.
- **Contribution incentive (future/roadmap, not Friday's build).** Social obligation within the
  church + conditional eligibility (only paid-up members can claim — also the adverse-selection
  defence) + a visible growing reserve + optional matched funding from the backstop funder.
  Avoid: interest/returns on contributions, penalties for non-payment, lottery mechanics.

**Open Payments boundary (state it, don't cross it):** Open Payments moves money **in**
(contributions) and **out** (payouts) and proves settlement. The **holding** in between is the
custodian's (bank) function — we build **no wallet** and hold **no funds**. The backend holds
*authority* (grants), not money. Do not claim Open Payments "does escrow."

---

## 6. Read before you write (anti-hallucination guard)

Before proposing **any** change, read these files and report back what you found, because the
change map in §8 was derived from the project README, not the source — treat it as a hypothesis
to confirm or correct:

- `backend/examples/p2p-open-payments-walkthrough.ts` — the canonical, web-server-free SDK flow.
  **This is your reference for the exact grant → incoming payment → quote → outgoing payment
  calls.**
- `backend/src/lib/openPayments.ts` — the authenticated-client singleton (one wallet today).
- `backend/src/lib/quoteFlow.ts` — the shared resolve → incoming payment → quote flow to reuse.
- `backend/src/routes/remit.ts` and `backend/src/routes/callback.ts` — the existing
  quote → consent → callback → status pipeline.
- `backend/src/db/schema.ts` and `backend/src/config.ts`.

**Two things to verify explicitly and report before coding:**

- **Recurring-grant execution semantics.** Confirm how a recurring/repeated outgoing grant is
  authorised and *executed* in this SDK version (the auth server authorises up to limits, but
  the client still triggers each cycle). Contributions are a *stretch* goal, so this only
  blocks the stretch path — but confirm it so we don't design around a false assumption.
- **Outgoing-payment grant type.** Determine whether the test wallet
  (`wallet.interledger-test.dev`) requires an **interactive** grant (consent redirect) for
  outgoing payments, or supports a **pre-authorised / reusable** grant with a `debitAmount`
  limit. This decides the payout mechanism (see §7). Report what the walkthrough does.

---

## 7. The one real decision: how the payout is authorised

The payout is an **outgoing payment from the pool/backstop wallet**. How it's authorised
depends on what you found in §6. Default to (A); fall back to (B) only if the test wallet
forces it — and report which.

- **(A) Pre-authorised, capped, reusable grant (preferred).** Once, the wallet operator
  completes an outgoing-payment grant with a `debitAmount` limit sized to the demo. Store the
  grant continuation (the template already persists `grantContinueUri` / `grantContinueToken`
  for the callback — reuse that pattern), then the trigger fires the payout **with no human in
  the loop at trigger time**. The grant's cap **is** our per-event design-capacity limit —
  that's the "bounded, revocable authority" story, enforced at the protocol layer. Slickest
  demo.
- **(B) Interactive consent per payout (fallback).** If reusable outgoing grants aren't
  workable on the test wallet in time, route the trigger through the template's existing
  consent → callback flow, and treat **operator approval at consent as the verification gate**.
  Uses existing plumbing; less automated.

Either way: one grant can authorise the whole event's payouts as long as the total stays under
the cap (limits are a total over an interval, not per-payment).

---

## 8. Friday build scope (be disciplined)

**In scope — the demo thread:**
A verified trigger → pay a **fixed amount** from the **member-pool wallet** to a **victim
wallet** → **if the pool is short or the event is covariate, draw from the backstop wallet** →
demonstrated across **two funded test wallets** (pool + backstop) and **one victim wallet**,
with the **covariate branch visibly logged**.

**Explicitly OUT of scope for Friday (do not build unless told otherwise):**
- Full recurring-contribution execution / scheduler (stretch).
- A live M-of-N attestation UI. For Friday, **simulate** verification: accept the attestation
  threshold as already met (e.g. a seeded count or a request flag). Build the *gate*, not the
  UI.
- Member enrolment UX, matched funding, eligibility/good-standing logic, step-down tiers.
  Leave room in the schema, build none of it now.
- Keep the news / Web Monetization demo untouched (delete it later; not now).

### Change map (confirm against the real files first — see §6)

**`config.ts` + `.env`** — the template has one wallet (`OP_WALLET_ADDRESS` / `OP_KEY_ID` /
`OP_PRIVATE_KEY_PATH`). Reuse those as the **pool** identity; add a parallel
**`BACKSTOP_WALLET_ADDRESS` / `BACKSTOP_KEY_ID` / `BACKSTOP_PRIVATE_KEY_PATH`**. Validate both
at boot the way the template already validates the first.

**`lib/openPayments.ts`** — currently a single-wallet client singleton. The demo needs to send
**from two source wallets** (pool, backstop), so this must become a small factory/map keyed by
source ("pool" | "backstop") returning the right authenticated client — **or** instantiate a
second client for the backstop. Pick the smaller diff once the file's read; report which.

**`lib/quoteFlow.ts`** — reuse as-is for the payout's resolve → incoming-payment-on-victim →
quote step. The payout's outgoing-payment leg is the same primitive as a P2P send, just sourced
from the pool/backstop wallet instead of a user wallet. **Reuse, don't reinvent.**

**`db/schema.ts`** — add the **minimum** for the demo (run `npm run db:push` after):
- `groups` — the mutual's config: `name`, `poolWalletRef`, `backstopWalletRef`,
  `fixedPayoutAmount`, `reserveFloor`, `covariateThreshold` (claim count that flips to
  backstop), `designCapacity` (`fixedPayoutAmount × maxClaimsPerEvent` — the one number we
  defend).
- `events` — `groupId`, `location`, `occurredAt`, `reportedAt`, `classification`
  (`SINGLE | COVARIATE`), `claimCount`. Classification is computed from claim count vs threshold.
- `claims` — `groupId`, `eventId`, `claimantWallet` (the enrolment-bound wallet),
  `status` (`PENDING → VERIFIED → PAID | REJECTED`), `payoutAmount`, `payoutSource`
  (`POOL | BACKSTOP`), and a reference to the payout transaction.
- **Reuse `transactions`** for the payout record. Reuse `payment_requests` ("asks") only as a
  *structural reference* — a claim is against the pool and gated by attestation, not a peer.
- Leave `members` / `contributions` for later; for Friday a claim just carries a bound wallet.

**`routes/` (new `claims.ts` or similar)** — endpoints for the demo:
- file a claim (creates `claims` row + associates/creates an `event`),
- mark verified (the simulated attestation gate),
- **trigger payout**: classify the event, choose source per §9, run quote + outgoing payment,
  write the `transactions` + `claims` rows, return status. Wire it in `backend/src/index.ts`.

**`frontend/`** — minimal: a trigger/claim view and a status view. **Reuse** the existing
`statusView.ts` polling pattern and `api.ts` typed-wrapper convention. Pass any user-entered
value through `escapeHtml()`. Don't build enrolment or attestation UI for Friday.

---

## 9. Payout decision logic (the core of the demo)

On **trigger** for a verified claim:

1. Classify the event: `claimCount >= covariateThreshold` ⇒ `COVARIATE`, else `SINGLE`.
2. Choose source:
   - `SINGLE` **and** pool balance − `fixedPayoutAmount` ≥ `reserveFloor` ⇒ **POOL**.
   - otherwise (covariate, or paying would breach the floor / exceed pool) ⇒ **BACKSTOP**.
3. Run `quoteFlow` against the **victim** wallet, then create the outgoing payment from the
   chosen source wallet for **exactly `fixedPayoutAmount`**.
4. Record `transactions` + update `claims` (`status = PAID`, `payoutSource`, tx ref).
5. Log the branch taken so the **covariate path is visible** in the demo.

Keep this as one readable function. No allocation math — the amount is fixed.

**Future work, not Friday:** past design capacity (`designCapacity` exceeded), step down to a
lower fixed tier so all claimants in that event remain equal to each other — still fixed and
equal, just lower. Do not build pro-rata splitting or queueing.

---

## 10. Verification (how changes get checked)

Setup: `npm install` → `npm run db:push` → `npm run dev` (backend :3001, frontend :5173).
Fund three test wallets at `wallet.interledger-test.dev`: **pool**, **backstop**, **victim**.
Seed one `group` with a fixed payout (e.g. R500-equivalent), a reserve floor, and a covariate
threshold.

**Test 1 — single claim, paid from pool.** File + verify one claim; trigger.
*Expected:* outgoing payment **pool → victim**; `transactions` row with `payoutSource = POOL`;
victim balance up by the fixed amount; pool down by it; claim `status = PAID`.

**Test 2 — pool floor breach → backstop fallback.** Set the pool low enough that paying would
breach the floor; trigger a single claim.
*Expected:* payout sourced from **backstop**; `payoutSource = BACKSTOP`; pool untouched below
floor; claim `PAID`.

**Test 3 — covariate event → backstop.** Create an event with `claimCount >=
covariateThreshold`; trigger.
*Expected:* `classification = COVARIATE`; payout from **backstop**; covariate branch logged;
each claim gets the **same fixed amount**.

Every PR-sized change should state which of these it makes pass, plus the build command and the
exact expected DB rows / balance deltas.

---

## 11. Do-not list

- Do **not** build or simulate a wallet, or hold a float. The backend holds grants (authority),
  not funds.
- Do **not** add pro-rata, first-come-first-served, or spend-control logic.
- Do **not** make the outgoing grant irrevocable to "simplify" — revocability is a feature.
- Do **not** gold-plate beyond §8. Confirm scope before building the stretch items.
- Do **not** trust this file over the code. Read §6 first; if reality differs, say so and stop.

---

## 12. Anticipated hard questions (have answers ready, don't improvise — for pitch, not code)

- *"Fires hit many houses at once — your pool can't cover that."* → Correct; that's why there
  are two layers. Member pool = speed for the common case, backstop = scale for the tail case,
  because outside capital isn't wiped out with the settlement.
- *"Isn't this insurance? Are you licensed?"* → No money is held by the team; a licensed
  custodian holds it. The team builds the coordination/claims layer, not the financial
  institution.
- *"How do you stop fraud/collusion?"* → Community attestation in a pre-existing trust group,
  proportional to a small capped payout; bounded, costly in a repeated social game, detectable
  in patterns — managed, not eliminated.
- *"How do you ensure money is spent correctly?"* → Deliberately don't (§5). Stated design
  principle, not a gap.
- *"Sized to guarantee against what?"* → Up to a stated design capacity (fixed amount × max
  claims covered, derived from a costed relief basket and a realistic event-size assumption);
  past that, a documented step-down tier (future work).
- *"Why would people keep contributing?"* → Social obligation + conditional eligibility +
  visible reserve + optional matched funding (§5).

---

## 13. Team split (we can change this)

- **Backend Person 1:** core payment path — wallet discovery, grant/redirect/continue flow,
  quote + outgoing payment, wrapped as a single `payFixedAmount(wallet, amount)` function.
- **Backend Person 2:** claim intake, attestation tracking, covariate detection, balance-check/
  fallback routing logic on top of Person 1's payment function.
- **Frontend:** two-wallet display, report-a-fire flow, mock attestation buttons, payout-routing
  visualisation (the demo's money-shot moment), a way to simulate multiple claims to trigger the
  covariate branch live.
- **Pitch/Q&A:** all three, together — drafted early (persona/problem/solution), drilled
  mid-build (round-robin judge questions using §12), rehearsed at the end.

---

## 14. Open items

- [ ] Confirm with tutor: does custodian-held pre-funding satisfy the "no wallet" guidance?
- [ ] Name a plausible custodian for the pitch (sponsoring bank / registered co-op or mutual /
  existing administrator).
- [ ] Read §6's files and confirm/correct the change map in §8 against the real source.
- [ ] Resolve §7's grant-type question against the actual test wallet behaviour.
- [ ] Derive and write down the actual fixed amount and design-capacity numbers from a costed
  relief basket.