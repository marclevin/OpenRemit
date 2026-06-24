import { api, User, SessionView } from '../api';
import {
  mountCanvas,
  loop,
  drawCoin,
  renderBankroll,
  createLedger,
  toast,
  winBurst,
  screenShake,
  fmtX,
} from '../lib/arcade';
import { refreshSessionReceipt } from '../lib/receipt';
import { toMinor, formatMoney } from '../money';
import { escapeHtml } from '../escape';

// ─── Board geometry (matches backend gameEngine PACHINKO_ROWS = 12) ──────────────
const ROWS = 12;                 // peg rows → ROWS + 1 buckets
const BUCKETS = ROWS + 1;        // 13 buckets
const CANVAS_W = 360;
const CANVAS_H = 460;

// Known multiplier set, used to draw labels BEFORE the first drop reveals them.
const DEFAULT_MULTIPLIERS: readonly number[] =
  [50, 12, 4, 2, 1.2, 0.5, 0, 0.5, 1.2, 2, 4, 12, 50];

// Palette (mirror of styles.css :root — arcade.ts keeps these private).
const COL = {
  bg:     '#0d0b1f',
  panel:  '#171334',
  inset:  '#221b4d',
  ink:    '#e9e6ff',
  muted:  '#9b93c8',
  green:  '#39ff14',
  gold:   '#ffd23f',
  pink:   '#ff2e88',
  cyan:   '#21e6c1',
  violet: '#a463ff',
  border: '#3a2f7a',
} as const;

// Board layout constants (in logical canvas px).
const TOP_Y = 46;                       // y of the apex peg
const ROW_GAP = 26;                     // vertical spacing between peg rows
const COL_GAP = 24;                     // horizontal spacing between peg columns
const PEG_R = 2.5;
const COIN_SCALE = 2;                   // drawCoin sprite is 6px wide → 12px
const BUCKET_TOP = TOP_Y + ROWS * ROW_GAP + 14;
const BUCKET_H = CANVAS_H - BUCKET_TOP - 6;

interface DropRecord {
  wager:      number;
  multiplier: number;
}

/**
 * PACHINKO — drop balls through a Galton board of 12 peg rows into one of 13
 * buckets. Centre buckets pay 0× (loss); rare edges pay big (win → sponsor
 * match). CRUCIAL: money only settles on CASH OUT — each drop merely accumulates
 * (reserved bankroll), and the aggregated donation receipt is revealed at the end.
 */
export async function renderPachinkoView(container: HTMLElement, _user: User): Promise<void> {
  container.innerHTML = `<div class="panel"><p class="muted">Loading run…</p></div>`;

  // ── SESSION GATE ───────────────────────────────────────────────────────────
  let session: SessionView | null;
  try {
    session = await api.sessions.active();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    container.innerHTML = `<div class="panel"><p class="muted">Couldn't load your run.</p></div>`;
    toast(msg, 'err');
    return;
  }

  if (!session || session.status !== 'ACTIVE') {
    container.innerHTML = `
      <section class="game game--pachinko">
        <a class="btn btn--ghost" href="#/play">◂ BACK</a>
        <div class="panel">
          <h2 class="pixel-h2">No active run</h2>
          <p class="muted">Start a run from the lobby to drop some balls.</p>
          <button class="btn btn--green btn--block" type="button" id="go-play">▸ GO TO LOBBY</button>
        </div>
      </section>`;
    container.querySelector<HTMLButtonElement>('#go-play')!
      .addEventListener('click', () => { window.location.hash = '#/play'; });
    return;
  }

  const run = session; // non-null, ACTIVE

  // ── Layout ─────────────────────────────────────────────────────────────────
  container.innerHTML = `
    <section class="game game--pachinko">
      <a class="btn btn--ghost" href="#/play">◂ BACK</a>

      <div class="hud" id="pk-hud"></div>

      <div class="pk-layout">
        <div class="pk-board">
          <div class="game-stage" id="pk-stage"></div>
          <p class="pk-tally muted" id="pk-tally">Drops: 0 · Parked: ${escapeHtml(formatMoney(0, run.assetCode, run.assetScale))} · Best: —</p>
        </div>

        <div class="pk-side">
          <p class="pk-explain muted">
            🎰 Drops accumulate — your wagers are only donated when you <b>CASH OUT</b>.
          </p>

          <div class="panel panel--inset pk-bet">
            <div class="field">
              <label class="pixel-label" for="pk-wager">WAGER PER DROP (coins)</label>
              <input class="coin-input" id="pk-wager" type="number" inputmode="decimal"
                     min="0" step="1" value="5" />
            </div>
            <button class="btn btn--gold btn--block" type="button" id="pk-drop">🎰 DROP BALL</button>
            <button class="btn btn--green btn--block" type="button" id="pk-cashout" disabled>💰 CASH OUT</button>
          </div>

          <h3 class="pixel-label pk-receipt-h">RECEIPT</h3>
          <div class="panel panel--inset" id="pk-ledger"></div>
        </div>
      </div>
    </section>`;

  const hudEl     = container.querySelector<HTMLElement>('#pk-hud')!;
  const stageEl   = container.querySelector<HTMLElement>('#pk-stage')!;
  const tallyEl   = container.querySelector<HTMLElement>('#pk-tally')!;
  const wagerInput = container.querySelector<HTMLInputElement>('#pk-wager')!;
  const dropBtn   = container.querySelector<HTMLButtonElement>('#pk-drop')!;
  const cashoutBtn = container.querySelector<HTMLButtonElement>('#pk-cashout')!;
  const ledgerHost = container.querySelector<HTMLElement>('#pk-ledger')!;

  renderBankroll(hudEl, run);
  const ledger = createLedger(ledgerHost);
  // Show wagers/matches from earlier rounds straight away (persists across nav).
  void refreshSessionReceipt(run, ledger, hudEl).catch(() => {});

  const { ctx } = mountCanvas(stageEl, CANVAS_W, CANVAS_H);

  // ── State ──────────────────────────────────────────────────────────────────
  let multipliers: number[] = [...DEFAULT_MULTIPLIERS]; // replaced by server's set
  let drops: DropRecord[] = [];
  let animating = false;
  let litBucket = -1;            // bucket to keep highlighted after a landing
  let litUntil = 0;              // performance.now() ms — when the highlight fades

  // ── Static board render (re-drawn every frame for clean compositing) ─────────
  function pegX(row: number, col: number): number {
    // Row `row` (0..ROWS) has `row + 1` pegs, centred horizontally.
    const centre = CANVAS_W / 2;
    return centre + (col - row / 2) * COL_GAP;
  }

  function bucketBounds(i: number): { x0: number; x1: number; cx: number } {
    const w = CANVAS_W / BUCKETS;
    const x0 = i * w;
    return { x0, x1: x0 + w, cx: x0 + w / 2 };
  }

  function isWinBucket(i: number): boolean {
    return (multipliers[i] ?? 0) > 1;
  }

  function drawBoard(now: number): void {
    // Backdrop.
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = COL.panel;
    ctx.fillRect(0, 0, CANVAS_W, BUCKET_TOP - 2);

    // Pegs.
    for (let row = 0; row <= ROWS; row++) {
      for (let col = 0; col <= row; col++) {
        const x = pegX(row, col);
        const y = TOP_Y + row * ROW_GAP;
        ctx.beginPath();
        ctx.arc(x, y, PEG_R, 0, Math.PI * 2);
        ctx.fillStyle = COL.violet;
        ctx.fill();
        ctx.fillStyle = COL.ink;
        ctx.fillRect(Math.round(x - 0.5), Math.round(y - 0.5), 1, 1);
      }
    }

    // Buckets with multiplier labels.
    const lit = now < litUntil ? litBucket : -1;
    ctx.textAlign = 'center';
    for (let i = 0; i < BUCKETS; i++) {
      const { x0, x1, cx } = bucketBounds(i);
      const m = multipliers[i] ?? 0;
      const win = isWinBucket(i);
      const isLit = i === lit;

      // Slot well.
      ctx.fillStyle = COL.inset;
      ctx.fillRect(x0 + 1, BUCKET_TOP, (x1 - x0) - 2, BUCKET_H);

      // Glow / fill: wins gold-green, losses muted-pink.
      if (isLit) {
        ctx.fillStyle = win ? COL.green : COL.pink;
      } else if (win) {
        ctx.fillStyle = m >= 12 ? COL.gold : 'rgba(57,255,20,0.30)';
      } else {
        ctx.fillStyle = 'rgba(255,46,136,0.14)';
      }
      ctx.fillRect(x0 + 1, BUCKET_TOP, (x1 - x0) - 2, BUCKET_H);

      // Divider walls.
      ctx.fillStyle = COL.border;
      ctx.fillRect(x0, BUCKET_TOP, 1, BUCKET_H);
      if (i === BUCKETS - 1) ctx.fillRect(x1 - 1, BUCKET_TOP, 1, BUCKET_H);

      // Label.
      ctx.fillStyle = isLit
        ? COL.bg
        : win ? COL.gold : COL.muted;
      ctx.font = '9px "VT323", monospace';
      const label = m >= 1 ? `${trimX(m)}×` : `${trimX(m)}×`;
      ctx.fillText(label, cx, BUCKET_TOP + BUCKET_H / 2 + 3);
    }
    ctx.textAlign = 'start';
  }

  // ── Idle render: keeps the board visible (and highlight fading) ──────────────
  const stopIdle = loop((_dt, _elapsed) => {
    if (animating) return true;       // animation owns the canvas while running
    drawBoard(performance.now());
    return true;
  });

  // ── Animate one drop ─────────────────────────────────────────────────────────
  function animateDrop(path: number[], bucket: number): Promise<void> {
    return new Promise<void>((resolve) => {
      animating = true;
      const TOTAL_ROWS = path.length;          // == ROWS
      const SECS_PER_ROW = 0.16;               // fall speed
      const landCx = bucketBounds(bucket).cx;

      const stop = loop((_dt, elapsed) => {
        // Which peg-gap segment are we in?
        const segF = elapsed / SECS_PER_ROW;
        const seg = Math.floor(segF);
        const t = segF - seg;                  // 0..1 within this segment

        drawBoard(performance.now());

        let x: number;
        let y: number;

        if (seg >= TOTAL_ROWS) {
          // Drop into the landed bucket.
          const fallT = Math.min(1, (elapsed - TOTAL_ROWS * SECS_PER_ROW) / 0.18);
          const fromY = TOP_Y + TOTAL_ROWS * ROW_GAP;
          x = landCx;
          y = fromY + (BUCKET_TOP + BUCKET_H * 0.55 - fromY) * easeOut(fallT);
          drawBall(x, y);
          if (fallT >= 1) {
            stop();
            animating = false;
            resolve();
            return false;
          }
          return true;
        }

        // Position between peg row `seg` and `seg + 1`.
        const rightsSoFar = path.slice(0, seg).reduce((a, b) => a + b, 0);
        const fromCol = rightsSoFar;
        const toCol = rightsSoFar + (path[seg] ?? 0); // 0 = stay col (left), 1 = +1 (right)

        const fromX = pegX(seg, fromCol);
        const fromYr = TOP_Y + seg * ROW_GAP;
        const toX = pegX(seg + 1, toCol);
        const toYr = TOP_Y + (seg + 1) * ROW_GAP;

        const e = easeInOut(t);
        x = fromX + (toX - fromX) * e;
        // Parabolic bounce hop between pegs for arcade feel.
        const bounce = Math.sin(t * Math.PI) * 5;
        y = fromYr + (toYr - fromYr) * e - bounce;

        drawBall(x, y);
        return true;
      });
    });
  }

  function drawBall(x: number, y: number): void {
    // drawCoin sprite is 6 cells; offset so (x,y) is roughly its centre.
    const off = (6 * COIN_SCALE) / 2;
    drawCoin(ctx, Math.round(x - off), Math.round(y - off), COIN_SCALE);
  }

  // ── Tally line ───────────────────────────────────────────────────────────────
  function updateTally(): void {
    const totalWagered = drops.reduce((sum, d) => sum + d.wager, 0);
    const best = drops.reduce((m, d) => Math.max(m, d.multiplier), 0);
    const bestLabel = drops.length ? fmtX(best) : '—';
    tallyEl.textContent =
      `Drops: ${drops.length} · Parked: ${formatMoney(totalWagered, run.assetCode, run.assetScale)} · Best: ${bestLabel}`;
  }

  // ── DROP BALL ─────────────────────────────────────────────────────────────────
  dropBtn.addEventListener('click', async () => {
    if (animating) return;

    const wager = toMinor(wagerInput.value, run.assetScale);
    if (!Number.isFinite(wager) || wager <= 0) {
      toast('Enter a wager of at least 1 coin', 'err');
      return;
    }
    if (wager > run.remaining) {
      toast('Out of coins — CASH OUT to settle', 'info');
      return;
    }

    dropBtn.disabled = true;
    cashoutBtn.disabled = true;

    let res;
    try {
      res = await api.games.pachinkoDrop({ sessionId: run.id, wager });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(msg, 'err');
      dropBtn.disabled = false;
      cashoutBtn.disabled = drops.length === 0;
      return;
    }

    // Server is the source of truth for the multiplier labels.
    multipliers = res.animation.multipliers;

    // Reserve the wager against the bankroll (settles only on cash out).
    run.remaining = res.remaining;
    run.bankrollReserved = (run.bankrollReserved ?? 0) + wager;
    renderBankroll(hudEl, run);

    // Animate the fall, then resolve the outcome.
    await animateDrop(res.animation.path, res.animation.bucket);

    const mult = res.round.multiplier;
    drops.push({ wager, multiplier: mult });

    litBucket = res.animation.bucket;
    litUntil = performance.now() + 1400;

    if (mult > 1) {
      winBurst(stageEl);
      toast(`${fmtX(mult)} bucket!`, 'win');
    } else {
      screenShake(stageEl, 200);
    }

    updateTally();

    // Re-enable controls based on remaining bankroll.
    cashoutBtn.disabled = false;
    const next = toMinor(wagerInput.value, run.assetScale);
    if (!Number.isFinite(next) || next <= 0 || next > run.remaining) {
      dropBtn.disabled = true;
      if (run.remaining <= 0 || (Number.isFinite(next) && next > run.remaining)) {
        toast('Out of coins — CASH OUT to settle', 'info');
      }
    } else {
      dropBtn.disabled = false;
    }
  });

  // Re-evaluate the DROP button when the wager changes (e.g. after running low).
  wagerInput.addEventListener('input', () => {
    if (animating) return;
    const w = toMinor(wagerInput.value, run.assetScale);
    dropBtn.disabled = !Number.isFinite(w) || w <= 0 || w > run.remaining;
  });

  // ── CASH OUT — the ONLY moment money settles ────────────────────────────────
  cashoutBtn.addEventListener('click', async () => {
    if (animating || drops.length === 0) return;

    dropBtn.disabled = true;
    cashoutBtn.disabled = true;
    const origLabel = cashoutBtn.textContent;
    cashoutBtn.textContent = 'Settling…';

    let out;
    try {
      out = await api.games.pachinkoCashout(run.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(msg, 'err');
      cashoutBtn.textContent = origLabel;
      cashoutBtn.disabled = false;
      dropBtn.disabled = false;
      return;
    }

    // Reveal the aggregated receipt (one USER_WAGER + per-win matches) accumulated
    // into the full session list, and sync the bankroll from the authoritative
    // session (reserved has now drained into spent).
    await refreshSessionReceipt(run, ledger, hudEl).catch(() => {});

    toast(
      `Settled ${formatMoney(out.settlement.totalWager, run.assetCode, run.assetScale)} donated, ` +
      `${formatMoney(out.settlement.totalMatched, run.assetCode, run.assetScale)} matched 💚`,
      'win',
    );

    // Reset for a fresh batch of drops.
    drops = [];
    litBucket = -1;
    litUntil = 0;
    updateTally();

    cashoutBtn.textContent = origLabel;
    cashoutBtn.disabled = true;            // 0 parked again
    const w = toMinor(wagerInput.value, run.assetScale);
    dropBtn.disabled = !Number.isFinite(w) || w <= 0 || w > run.remaining;
  });

  // Restore parked (unsettled) drops from the server, so returning to the board
  // after navigating away still reflects them and lets you CASH OUT (which is
  // what kicks off their donations). Otherwise they only settle on END RUN.
  void (async () => {
    try {
      const detail = await api.sessions.get(run.id);
      const parked = detail.rounds.filter((r) => r.game === 'PACHINKO' && !r.settled);
      if (parked.length) {
        drops = parked.map((r) => ({ wager: r.wager, multiplier: r.multiplier }));
        updateTally();
        cashoutBtn.disabled = false;
        const w = toMinor(wagerInput.value, run.assetScale);
        dropBtn.disabled = !Number.isFinite(w) || w <= 0 || w > run.remaining;
      }
    } catch { /* non-fatal */ }
  })();

  // Stop the idle loop if the view is torn down (loop also self-stops on detach).
  void stopIdle;
}

// ─── easing & format helpers ─────────────────────────────────────────────────────

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 2);
}

/** Compact multiplier for bucket labels: "50", "1.2", "0.5", "0". */
function trimX(m: number): string {
  if (Number.isInteger(m)) return String(m);
  return String(Number(m.toFixed(2)));
}
