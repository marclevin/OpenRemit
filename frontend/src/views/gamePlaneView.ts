import { api, User, SessionView, PlanePlayResponse } from '../api';
import {
  mountCanvas,
  loop,
  toast,
  winBurst,
  screenShake,
  renderBankroll,
  createLedger,
  fmtX,
  drawStarfield,
  drawPlane,
  drawExplosion,
  drawCoin,
  drawRocket,
} from '../lib/arcade';
import { refreshSessionReceipt, pollSessionReceipt } from '../lib/receipt';
import { toMinor } from '../money';
import { escapeHtml } from '../escape';

// Logical canvas size (CSS px). The stage scales it responsively.
const STAGE_W = 560;
const STAGE_H = 340;
const PLANE_SCALE = 5;

interface CoinSpark { x: number; y: number; vx: number; vy: number; born: number }

/**
 * PLANE CRASH — a side-scrolling run. The plane flies on its own through a world
 * that scrolls past; objects approach from the right, shrouded until the last
 * moment. Each one turns out to be a multiplier COIN (collected → fly on) or a
 * ROCKET (crash → loss, ends the run); survive to the end and a landing PAD
 * appears (win). The server decides the whole sequence at play time; this view
 * reveals it step by step over ~10–15s, then polls the donation receipt.
 */
export async function renderPlaneView(container: HTMLElement, user: User): Promise<void> {
  container.innerHTML = `<div class="panel"><p class="muted">Loading run…</p></div>`;

  let session: SessionView | null;
  try {
    session = await api.sessions.active();
  } catch (err: unknown) {
    container.innerHTML = `<div class="panel"><p class="muted">Couldn't load your run.</p></div>`;
    toast(err instanceof Error ? err.message : String(err), 'err');
    return;
  }

  if (!session || session.status !== 'ACTIVE') {
    container.innerHTML = `
      <section class="game game--plane">
        <div class="panel">
          <h2 class="pixel-h2">No active run</h2>
          <p class="muted">Start a run in the lobby to fly the plane.</p>
          <button class="btn btn--cyan btn--block" type="button" id="go-play">▸ GO TO LOBBY</button>
        </div>
      </section>`;
    container.querySelector<HTMLButtonElement>('#go-play')!
      .addEventListener('click', () => { window.location.hash = '#/play'; });
    return;
  }

  const hello = escapeHtml(user.displayName);

  container.innerHTML = `
    <section class="game game--plane">
      <button class="btn btn--ghost rocket-back" type="button" id="back-play">◂ BACK</button>

      <div class="hud" id="plane-hud"></div>

      <div class="game-stage" id="plane-stage">
        <div class="plane-readout" id="plane-readout" aria-live="polite">
          <span class="plane-readout__x" id="plane-mult">1.00×</span>
          <span class="plane-readout__status" id="plane-status">READY TO FLY</span>
        </div>
      </div>

      <div class="panel panel--inset plane-bet">
        <div class="field">
          <label class="pixel-label" for="plane-wager">WAGER (coins)</label>
          <input class="coin-input" id="plane-wager" type="number" inputmode="numeric"
                 min="1" step="1" value="5" />
        </div>
        <button class="btn btn--cyan btn--lg btn--block" type="button" id="plane-fly">✈️ FLY</button>
        <p class="plane-bet__hint muted" id="plane-hint">Buckle up, ${hello}. Grab the gold coins — dodge nothing, hope for no rockets!</p>
      </div>

      <h3 class="pixel-label plane-receipt-title">RECEIPT</h3>
      <div class="ledger" id="plane-ledger"></div>
    </section>`;

  const stage      = container.querySelector<HTMLElement>('#plane-stage')!;
  const hudEl      = container.querySelector<HTMLElement>('#plane-hud')!;
  const multEl     = container.querySelector<HTMLElement>('#plane-mult')!;
  const statusEl   = container.querySelector<HTMLElement>('#plane-status')!;
  const wagerInput = container.querySelector<HTMLInputElement>('#plane-wager')!;
  const flyBtn     = container.querySelector<HTMLButtonElement>('#plane-fly')!;
  const hintEl     = container.querySelector<HTMLElement>('#plane-hint')!;
  const ledgerHost = container.querySelector<HTMLElement>('#plane-ledger')!;

  container.querySelector<HTMLButtonElement>('#back-play')!
    .addEventListener('click', () => { window.location.hash = '#/play'; });

  const { ctx } = mountCanvas(stage, STAGE_W, STAGE_H);
  const ledger = createLedger(ledgerHost);

  renderBankroll(hudEl, session);
  // Show wagers/matches from earlier rounds straight away (persists across nav).
  void refreshSessionReceipt(session, ledger, hudEl).catch(() => {});

  let cancelLoop: (() => void) | null = loop((_dt, elapsed) => { drawIdle(ctx, elapsed); return true; });
  let cancelReceipt: (() => void) | null = null;
  let flying = false;

  function setReadout(text: string, color: string): void {
    multEl.textContent = text;
    multEl.style.color = color;
  }

  function syncFlyEnabled(): void {
    const minWager = toMinor('1', session!.assetScale);
    if (session!.remaining < minWager) {
      flyBtn.disabled = true;
      wagerInput.disabled = true;
      hintEl.textContent = 'Bankroll spent — end this run from the lobby.';
    } else {
      flyBtn.disabled = flying;
      wagerInput.disabled = flying;
    }
  }

  // ── FLY ─────────────────────────────────────────────────────────────────────
  async function fly(): Promise<void> {
    if (flying) return;

    const wager = toMinor(wagerInput.value, session!.assetScale);
    const minWager = toMinor('1', session!.assetScale);
    if (!Number.isFinite(wager) || wager < minWager) { toast('Wager must be at least 1 coin', 'err'); return; }
    if (wager > session!.remaining) { toast('Wager exceeds your remaining bankroll', 'err'); return; }

    flying = true;
    cancelReceipt?.();
    flyBtn.disabled = true;
    wagerInput.disabled = true;
    flyBtn.textContent = 'IN FLIGHT…';
    setReadout('1.00×', 'var(--neon-gold)');
    statusEl.textContent = 'TAKING OFF…';

    let res: PlanePlayResponse;
    try {
      res = await api.games.plane({ sessionId: session!.id, wager });
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : String(err), 'err');
      flying = false;
      flyBtn.textContent = '✈️ FLY';
      statusEl.textContent = 'READY TO FLY';
      syncFlyEnabled();
      return;
    }

    session!.remaining = res.remaining;
    session!.bankrollReserved += wager;
    renderBankroll(hudEl, session!);

    await animateFlight(res.animation);

    // Show this round's wager + (on a land) sponsor match, accumulated into the
    // full session receipt; keep polling until the match row appears and settles.
    cancelReceipt?.();
    cancelReceipt = pollSessionReceipt(
      session!, ledger, hudEl, res.round.id,
      res.round.outcome === 'WIN' && res.round.matchAmount > 0,
    );
    flying = false;
    flyBtn.textContent = '✈️ FLY';
    syncFlyEnabled();
    if (session!.remaining < minWager) toast('Bankroll spent — end this run from the lobby.', 'info');
  }

  // ── Side-scrolling flight: objects approach the plane, one per step ──────────
  function animateFlight(anim: PlanePlayResponse['animation']): Promise<void> {
    return new Promise((resolve) => {
      cancelLoop?.();
      cancelLoop = null;

      const steps = anim.steps;
      const N = Math.max(1, steps.length);
      // Pace ~1s per step, total ~10–15s; slower per object when there are few.
      const STEP_TIME = Math.min(1.6, Math.max(0.9, 13 / N));
      const CROSS = STEP_TIME * 1.7;          // seconds for an object to reach the plane
      const planeX = STAGE_W * 0.30;
      const baseY = STAGE_H * 0.52;
      const SPAWN_DX = STAGE_W + 50 - planeX;  // where objects enter, relative to the plane
      const REVEAL_DX = 130;                   // shrouded until this close to the plane

      const processed = new Array<boolean>(N).fill(false);
      const popAt = new Array<number>(N).fill(-1);
      const coins: CoinSpark[] = [];

      let resolved = false;
      let resolveType: 'ROCKET' | 'PAD' | null = null;
      let resolveElapsed = 0;
      let resolveIndex = -1;
      let shownMult = 1;
      let targetMult = 1;

      cancelLoop = loop((dt, elapsed) => {
        const py = baseY + Math.sin(elapsed * 2.3) * 9;   // the plane bobs as it flies

        // Arrivals: object i reaches the plane at t = (i+1)·STEP_TIME.
        for (let i = 0; i < N; i++) {
          if (processed[i]) continue;
          if (resolved) break;
          if (elapsed >= (i + 1) * STEP_TIME) {
            processed[i] = true;
            const s = steps[i];
            if (s.type === 'COIN') { targetMult = s.mult; popAt[i] = elapsed; }
            else if (s.type === 'ROCKET') { resolved = true; resolveType = 'ROCKET'; resolveElapsed = elapsed; resolveIndex = i; screenShake(stage); }
            else { resolved = true; resolveType = 'PAD'; resolveElapsed = elapsed; resolveIndex = i; targetMult = s.mult; winBurst(stage); spawnCoins(coins, planeX, py, elapsed); }
          }
        }
        shownMult += (targetMult - shownMult) * Math.min(1, dt * 9);

        // ── Render ──
        drawScrollingSky(ctx, elapsed);

        for (let i = 0; i < N; i++) {
          if (resolved && i > resolveIndex) continue;                 // hide objects past the fatal one
          if (processed[i] && steps[i].type === 'COIN') {             // collected-coin pop
            const age = elapsed - popAt[i];
            if (age >= 0 && age < 0.45) drawBoostPop(ctx, planeX, py, age / 0.45, steps[i].mult);
            continue;
          }
          if (processed[i]) continue;                                 // resolved rocket/pad drawn below
          const dtTo = (i + 1) * STEP_TIME - elapsed;
          if (dtTo > CROSS || dtTo < 0) continue;                     // not on screen yet
          const ox = planeX + (dtTo / CROSS) * SPAWN_DX;
          const oy = baseY + Math.sin(elapsed * 3 + i * 1.4) * 8;
          if (ox - planeX > REVEAL_DX) drawMysteryCloud(ctx, ox, oy, elapsed);   // shrouded — coin or rocket?
          else if (steps[i].type === 'COIN') drawBoost(ctx, ox, oy, steps[i].mult, elapsed);
          else if (steps[i].type === 'ROCKET') drawMissile(ctx, ox, oy, elapsed);
          else drawLandingPad(ctx, ox, oy);
        }

        if (!resolved) {
          drawTrail(ctx, planeX, py, elapsed);
          drawPlane(ctx, planeX, py, PLANE_SCALE);
        } else if (resolveType === 'ROCKET') {
          const e = Math.min(1, (elapsed - resolveElapsed) / 0.8);
          drawExplosion(ctx, planeX + 6, py, 9, e);
        } else {
          drawLandingPad(ctx, planeX + 26, py + 8);
          drawPlane(ctx, planeX, py - 4, PLANE_SCALE);
          updateCoins(ctx, coins, elapsed);
        }

        // ── Readout ──
        if (resolved && resolveType === 'ROCKET') {
          setReadout(fmtX(anim.finalMultiplier), 'var(--neon-pink)');
          statusEl.textContent = '✈️💥 CRASHED';
        } else if (resolved) {
          setReadout(fmtX(anim.finalMultiplier), 'var(--neon-green)');
          statusEl.textContent = '🛬 LANDED';
        } else {
          setReadout(fmtX(shownMult), 'var(--neon-gold)');
          statusEl.textContent = 'FLYING…';
        }

        const finished = resolved && (elapsed - resolveElapsed) >= 1.1;
        if (finished) {
          if (resolveType === 'ROCKET') {
            toast('Crashed! ✈️💥', 'err');
            hintEl.textContent = `Down at ${fmtX(anim.finalMultiplier)} — your wager still funds the charity.`;
          } else {
            toast(`Landed at ${fmtX(anim.finalMultiplier)}! 🛬`, 'win');
            hintEl.textContent = `Landed at ${fmtX(anim.finalMultiplier)} — sponsor match incoming.`;
          }
          cancelLoop = loop((_d, e2) => { drawIdle(ctx, e2); return true; });
          resolve();
          return false;
        }
        return true;
      });
    });
  }

  flyBtn.addEventListener('click', () => { void fly(); });
  wagerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !flyBtn.disabled) void fly(); });

  syncFlyEnabled();
}

// ─── Canvas drawing helpers ─────────────────────────────────────────────────

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** A fast-scrolling sky that sells forward motion. */
function drawScrollingSky(ctx: CanvasRenderingContext2D, elapsed: number): void {
  drawStarfield(ctx, STAGE_W, STAGE_H, elapsed * 3.2);
  drawClouds(ctx, elapsed);
}

function drawIdle(ctx: CanvasRenderingContext2D, elapsed: number): void {
  drawStarfield(ctx, STAGE_W, STAGE_H, elapsed * 1.5);
  drawClouds(ctx, elapsed);
  const x = STAGE_W * 0.30;
  const y = STAGE_H * 0.52 + Math.sin(elapsed * 2) * 12;
  drawTrail(ctx, x, y, elapsed);
  drawPlane(ctx, x, y, PLANE_SCALE);
}

function drawClouds(ctx: CanvasRenderingContext2D, elapsed: number): void {
  const bands = [
    { y: 64,  speed: 26, w: 70,  alpha: 0.10 },
    { y: 150, speed: 44, w: 96,  alpha: 0.08 },
    { y: 250, speed: 66, w: 120, alpha: 0.07 },
  ];
  for (const band of bands) {
    ctx.fillStyle = `rgba(164,99,255,${band.alpha})`;
    for (let i = 0; i < 5; i++) {
      const span = STAGE_W + band.w;
      const x = ((i * span) / 5 - elapsed * band.speed) % span;
      const px = x < 0 ? x + span : x;
      ctx.fillRect(Math.round(px - band.w), band.y, band.w, 10);
      ctx.fillRect(Math.round(px - band.w + 14), band.y - 6, band.w - 28, 8);
    }
  }
}

/** A shrouded "?" cloud — could be a coin OR a rocket until it's close. */
function drawMysteryCloud(ctx: CanvasRenderingContext2D, x: number, y: number, elapsed: number): void {
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = '#3a2f7a';
  circle(ctx, x - 12, y + 2, 15);
  circle(ctx, x + 12, y + 2, 15);
  circle(ctx, x, y - 8, 17);
  ctx.fillStyle = '#221b4d';
  circle(ctx, x, y + 5, 17);
  ctx.globalAlpha = 0.6 + 0.4 * Math.sin(elapsed * 5);
  ctx.fillStyle = '#c9b6ff';
  ctx.font = "24px 'VT323', monospace";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('?', x, y);
  ctx.restore();
}

/** A bright gold multiplier coin the plane flies through. */
function drawBoost(ctx: CanvasRenderingContext2D, x: number, y: number, mult: number, elapsed: number): void {
  const r = 18 * (1 + Math.sin(elapsed * 5 + x * 0.05) * 0.07);
  ctx.save();
  ctx.shadowColor = 'rgba(255,210,63,0.9)';
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#ffd23f';
  circle(ctx, x, y, r);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#1a1330';
  circle(ctx, x, y, r - 4);
  ctx.fillStyle = '#ffe98a';
  ctx.font = "17px 'VT323', monospace";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(fmtX(mult), x, y + 1);
  ctx.restore();
}

/** Collected-coin burst at the plane. */
function drawBoostPop(ctx: CanvasRenderingContext2D, x: number, y: number, p: number, mult: number): void {
  ctx.save();
  ctx.globalAlpha = 1 - p;
  ctx.strokeStyle = '#39ff14';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, 16 + p * 26, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#39ff14';
  ctx.font = "18px 'VT323', monospace";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(fmtX(mult), x, y - 24 - p * 14);
  ctx.restore();
}

/** A pulsing red MISSILE — the obvious threat that ends the run. */
function drawMissile(ctx: CanvasRenderingContext2D, x: number, y: number, elapsed: number): void {
  const pulse = 0.5 + 0.5 * Math.sin(elapsed * 9);
  ctx.save();
  ctx.globalAlpha = 0.18 + pulse * 0.3;
  ctx.fillStyle = '#ff2e88';
  circle(ctx, x, y, 30);
  ctx.globalAlpha = 1;
  ctx.restore();
  drawRocket(ctx, x, y, 4, true);
  ctx.save();
  ctx.fillStyle = '#ff7ab3';
  ctx.font = "14px 'VT323', monospace";
  ctx.textAlign = 'center';
  ctx.fillText('DANGER', x, y - 34);
  ctx.restore();
}

/** A bright green landing pad the plane touches down on. */
function drawLandingPad(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  ctx.shadowColor = 'rgba(57,255,20,0.85)';
  ctx.shadowBlur = 14;
  ctx.fillStyle = '#39ff14';
  ctx.fillRect(Math.round(x - 34), Math.round(y + 16), 80, 6);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#0d0b1f';
  for (let i = 0; i < 4; i++) ctx.fillRect(Math.round(x - 28 + i * 20), Math.round(y + 17), 8, 4);
  ctx.fillStyle = '#39ff14';
  ctx.font = "15px 'VT323', monospace";
  ctx.textAlign = 'center';
  ctx.fillText('LAND', x + 6, y + 36);
  ctx.restore();
}

function drawTrail(ctx: CanvasRenderingContext2D, x: number, y: number, elapsed: number): void {
  for (let i = 1; i <= 7; i++) {
    const tx = x - i * 10;
    const ty = y + 12 + Math.sin(elapsed * 6 + i) * 1.5;
    ctx.globalAlpha = 0.32 - i * 0.04;
    ctx.fillStyle = '#9b93c8';
    const s = Math.max(1, 4 - i);
    ctx.fillRect(Math.round(tx), Math.round(ty), s, s);
  }
  ctx.globalAlpha = 1;
}

function spawnCoins(coins: CoinSpark[], x: number, y: number, elapsed: number): void {
  for (let i = 0; i < 14; i++) {
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
    const speed = 70 + Math.random() * 120;
    coins.push({ x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, born: elapsed });
  }
}

function updateCoins(ctx: CanvasRenderingContext2D, coins: CoinSpark[], elapsed: number): void {
  const g = 220;
  for (const c of coins) {
    const age = elapsed - c.born;
    const cx = c.x + c.vx * age;
    const cy = c.y + c.vy * age + 0.5 * g * age * age;
    if (cy > STAGE_H + 20) continue;
    drawCoin(ctx, cx, cy, 3);
  }
}
