import crypto from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// gameEngine — pure, deterministic, provably-fair outcome generation.
//
// No database, no Open Payments, no Express. Every outcome is derived from
// HMAC_SHA256(serverSeed, `${clientSeed}:${nonce}`), so a player can verify it
// after the fact once the serverSeed is revealed. The server commits to the
// serverSeed up front by publishing its SHA-256 hash; the real seed is only
// revealed when the round resolves.
//
// House edge note: there is no "house" taking money — the player's wager is
// always donated. The edge here only bounds how much SPONSOR money a win is
// worth, keeping pledge pools sustainable. With the crash formula below, the
// expected sponsor payout per wager is ≤ (1 − HOUSE_EDGE), regardless of how the
// player plays. So a sponsor's pool roughly tracks total wagers over time.
// ─────────────────────────────────────────────────────────────────────────────

export const HOUSE_EDGE = 0.06;

// Rocket multiplier grows as exp(ROCKET_GROWTH_K · seconds). Tuned slow so the
// climb is readable and tense: 2× at ~7s. Combined with the steep crash curve
// (median ~1.37×), most rounds blow up early at a low multiplier.
export const ROCKET_GROWTH_K = Math.log(2) / 7; // ≈ 0.099 / s

// Pachinko: 12 peg rows → 13 buckets. Multipliers are symmetric — the centre
// (most likely, binomial) pays nothing, the rare edges pay big. A bucket with
// multiplier > 1 is a WIN (sponsor matches wager × (m − 1)); ≤ 1 is a LOSS (the
// wager is still donated, just unmatched).
export const PACHINKO_ROWS = 12;
export const PACHINKO_MULTIPLIERS: readonly number[] =
  [50, 12, 4, 2, 1.2, 0.5, 0, 0.5, 1.2, 2, 4, 12, 50];

export interface Fairness {
  serverSeed:     string; // revealed at resolution
  serverSeedHash: string; // committed up front
  clientSeed:     string;
  nonce:          number;
}

// Plane plays as a step-by-step run: at each step the plane either collects a
// multiplier COIN (and flies on) or hits a ROCKET (crash → loss, ends the run).
// Survive all PLANE_MAX_STEPS and it reaches the landing PAD (win). The first
// PLANE_SAFE_STEPS steps never crash, so every flight lasts a while and the
// tension builds; each later step crashes with probability PLANE_STEP_CRASH_Q.
// Tuned so a typical run is ~10–15s of play (the frontend paces ~1s per step).
export const PLANE_MAX_STEPS    = 12;
export const PLANE_SAFE_STEPS   = 3;
export const PLANE_STEP_CRASH_Q = 0.08;
const PLANE_BOOST_MIN = 1.04;
const PLANE_BOOST_MAX = 1.11;

export interface PlaneStep { type: 'COIN' | 'ROCKET' | 'PAD'; mult: number }
export interface PlaneOutcome {
  outcome:    'WIN' | 'LOSS';
  multiplier: number;      // landing multiplier on WIN; accumulated-at-crash on LOSS
  steps:      PlaneStep[]; // the sequence the plane flies through (drives the animation)
  fairness:   Fairness;
}

export interface PachinkoOutcome {
  outcome:        'WIN' | 'LOSS';
  bucket:         number;          // 0..PACHINKO_ROWS
  multiplier:     number;          // PACHINKO_MULTIPLIERS[bucket]
  path:           number[];        // per-peg bounce: 0 = left, 1 = right (animation)
  fairness:       Fairness;
}

export interface RocketStart {
  crashPoint:     number;          // SECRET — do not send to the client
  growthK:        number;
  fairness:       Fairness;        // serverSeed withheld until resolution
}

// ── Seed helpers ────────────────────────────────────────────────────────────

export function randomSeed(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function hashSeed(seed: string): string {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

// A uniform float in [0, 1) derived from the seeds. Uses the first 52 bits of the
// HMAC so every bit of mantissa is covered (no modulo bias worth caring about).
export function uniform(serverSeed: string, clientSeed: string, nonce: number): number {
  const hmac = crypto.createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}`)
    .digest('hex');
  const slice = hmac.slice(0, 13);            // 13 hex chars = 52 bits
  return parseInt(slice, 16) / 2 ** 52;
}

// Independent extra uniforms from the same commitment (salted nonce) so one round
// can derive several values (e.g. crash point AND landing pad) without correlation.
function uniformSalted(serverSeed: string, clientSeed: string, nonce: number, salt: string): number {
  const hmac = crypto.createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}:${salt}`)
    .digest('hex');
  return parseInt(hmac.slice(0, 13), 16) / 2 ** 52;
}

// ── Crash distribution ──────────────────────────────────────────────────────
// crash = sqrt((1 − edge) / (1 − u)), floored to 2dp, clamped ≥ 1.00.
// Survival P(crash ≥ x) = (1 − edge) / x² — a much STEEPER tail than the classic
// 1/x. Consequences: median crash ≈ 1.4×, P(≥2×) ≈ 24%, P(≥5×) ≈ 3.8%,
// P(≥10×) ≈ 0.95%. So the rocket crashes early most of the time and almost never
// runs away to silly numbers, while an instant 1.00× (loss) still happens ≈ edge
// of the time. This keeps sponsor pools sustainable too (expected match per wager
// ≤ ~0.25× regardless of how the player cashes out).
function crashFromUniform(u: number, cap = Infinity): number {
  const raw = Math.sqrt((1 - HOUSE_EDGE) / (1 - Math.min(u, 0.999999)));
  const clamped = Math.max(1, Math.min(raw, cap));
  return Math.floor(clamped * 100) / 100;
}

function makeFairness(serverSeed: string, clientSeed: string, nonce: number): Fairness {
  return { serverSeed, serverSeedHash: hashSeed(serverSeed), clientSeed, nonce };
}

// ── ROCKET — climb & cash out before the crash (player-timed) ────────────────

export function startRocket(serverSeed: string, clientSeed: string, nonce: number): RocketStart {
  const crashPoint = crashFromUniform(uniform(serverSeed, clientSeed, nonce));
  return { crashPoint, growthK: ROCKET_GROWTH_K, fairness: makeFairness(serverSeed, clientSeed, nonce) };
}

// The multiplier the rocket is showing `seconds` after launch.
export function rocketMultiplierAt(seconds: number): number {
  return Math.exp(ROCKET_GROWTH_K * Math.max(0, seconds));
}

export interface RocketResolution { outcome: 'WIN' | 'LOSS'; multiplier: number }

// Resolve a cash-out. The client is given the crash point and stops the rocket
// there, so a cash-out only ever arrives with requestedMultiplier < crashPoint —
// a genuine WIN at exactly the multiplier the player saw. A request at or above
// the crash point means the rocket already blew up → LOSS. Resolving purely
// against the crash point (no server-clock ceiling) means the credited win
// multiplier always equals what was on screen — no "reset below the display".
export function resolveRocket(
  crashPoint: number,
  requestedMultiplier: number,
): RocketResolution {
  const claimed = Math.max(1, requestedMultiplier);
  if (claimed < crashPoint) {
    return { outcome: 'WIN', multiplier: Math.floor(claimed * 100) / 100 };
  }
  return { outcome: 'LOSS', multiplier: crashPoint };
}

// ── PLANE CRASH — auto-fly, fate reveal (no player input) ────────────────────
// The plane aims for a landing pad (landTarget) and the round has a secret crash
// point. If it would crash before reaching the pad → CRASH (loss); otherwise it
// LANDS at the pad (win at landTarget). Outcome is fully known at play time; the
// animation just reveals it.
export function playPlane(serverSeed: string, clientSeed: string, nonce: number): PlaneOutcome {
  const steps: PlaneStep[] = [];
  let multiplier = 1;
  let crashed = false;

  for (let i = 0; i < PLANE_MAX_STEPS; i++) {
    const risky = i >= PLANE_SAFE_STEPS;
    const uCrash = uniformSalted(serverSeed, clientSeed, nonce, `c${i}`);
    if (risky && uCrash < PLANE_STEP_CRASH_Q) {
      crashed = true;
      steps.push({ type: 'ROCKET', mult: round2(multiplier) });
      break;
    }
    const uBoost = uniformSalted(serverSeed, clientSeed, nonce, `b${i}`);
    multiplier *= PLANE_BOOST_MIN + (PLANE_BOOST_MAX - PLANE_BOOST_MIN) * uBoost;
    steps.push({ type: 'COIN', mult: round2(multiplier) });
  }

  if (!crashed) {
    const m = round2(multiplier);
    steps.push({ type: 'PAD', mult: m });
    return { outcome: 'WIN', multiplier: m, steps, fairness: makeFairness(serverSeed, clientSeed, nonce) };
  }
  return { outcome: 'LOSS', multiplier: round2(multiplier), steps, fairness: makeFairness(serverSeed, clientSeed, nonce) };
}

function round2(n: number): number { return Math.floor(n * 100) / 100; }

// ── PACHINKO — drop a ball, watch it bounce into a bucket ─────────────────────
// Each peg bounce is one bit of the HMAC: 0 = left, 1 = right. The bucket is the
// number of rights, which is binomial (centre most likely) — the authentic
// Galton-board distribution, fully reproducible from the seeds.
export function playPachinko(serverSeed: string, clientSeed: string, nonce: number): PachinkoOutcome {
  const bits = crypto.createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}`)
    .digest();

  const path: number[] = [];
  let bucket = 0;
  for (let i = 0; i < PACHINKO_ROWS; i++) {
    const right = (bits[i] & 1) === 1;
    path.push(right ? 1 : 0);
    if (right) bucket++;
  }

  const multiplier = PACHINKO_MULTIPLIERS[bucket];
  return {
    outcome:    multiplier > 1 ? 'WIN' : 'LOSS',
    bucket,
    multiplier,
    path,
    fairness:   makeFairness(serverSeed, clientSeed, nonce),
  };
}

// ── Sponsor match sizing ──────────────────────────────────────────────────────
// A win at multiplier m on a wager is worth wager × (m − 1) of sponsor money to
// the charity (the "winnings over the wager"). Rounds to the nearest smallest
// unit. Returns 0 for non-wins.
export function matchAmountFor(wager: number, multiplier: number): number {
  if (multiplier <= 1) return 0;
  return Math.round(wager * (multiplier - 1));
}
