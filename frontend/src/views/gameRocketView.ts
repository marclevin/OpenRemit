import { api, User, SessionView } from '../api';
import { toMinor } from '../money';
import { refreshSessionReceipt, pollSessionReceipt } from '../lib/receipt';
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
  drawRocket,
  drawExplosion,
  drawCoin,
} from '../lib/arcade';

// Canvas logical size (CSS px). Pixel art, DPR-scaled inside mountCanvas.
const STAGE_W = 560;
const STAGE_H = 360;

export async function renderRocketView(container: HTMLElement, _user: User): Promise<void> {
  void _user; // user not needed for play; satisfies strict no-unused

  // ─── Session gate ─────────────────────────────────────────────────────────
  const session = await api.sessions.active();
  if (!session || session.status !== 'ACTIVE') {
    container.innerHTML = `
      <div class="panel rocket-gate">
        <h2 class="pixel-h2">NO ACTIVE RUN</h2>
        <p class="muted">Start a run from the lobby to launch the rocket.</p>
        <a class="btn btn--green btn--lg" href="#/play">▸ TO THE LOBBY</a>
      </div>`;
    return;
  }

  // ─── Shell markup ─────────────────────────────────────────────────────────
  container.innerHTML = `
    <div class="rocket-view">
      <a class="btn btn--ghost rocket-back" href="#/play">◂ LOBBY</a>
      <div class="hud" id="rkt-hud"></div>

      <div class="rkt-layout">
        <div class="game-stage" id="rkt-stage">
          <div class="rocket-readout" id="rkt-readout">${fmtX(1)}</div>
        </div>

        <div class="rkt-side">
          <div class="panel panel--inset rocket-bet">
            <div class="field">
              <label class="pixel-label" for="rkt-wager">WAGER (coins)</label>
              <input id="rkt-wager" class="coin-input" type="number" min="1" step="1" value="5" inputmode="numeric" />
            </div>
            <button class="btn btn--green btn--block" id="rkt-launch">🚀 LAUNCH</button>
            <button class="btn btn--gold btn--block" id="rkt-cashout" disabled>💰 CASH OUT</button>
            <p class="rkt-urgency" id="rkt-urgency" hidden>⚠ CASH OUT before it crashes!</p>
          </div>

          <div class="panel rocket-ledger-panel">
            <h3 class="pixel-label rocket-ledger-title">RECEIPT</h3>
            <div id="rkt-ledger"></div>
          </div>
        </div>
      </div>
    </div>`;

  const hudEl     = container.querySelector<HTMLElement>('#rkt-hud')!;
  const stageEl   = container.querySelector<HTMLElement>('#rkt-stage')!;
  const readoutEl = container.querySelector<HTMLElement>('#rkt-readout')!;
  const wagerEl   = container.querySelector<HTMLInputElement>('#rkt-wager')!;
  const launchBtn = container.querySelector<HTMLButtonElement>('#rkt-launch')!;
  const cashBtn   = container.querySelector<HTMLButtonElement>('#rkt-cashout')!;
  const ledgerEl  = container.querySelector<HTMLElement>('#rkt-ledger')!;
  const urgencyEl = container.querySelector<HTMLElement>('#rkt-urgency')!;

  // Live, locally-mutated copy of the session so the HUD stays in sync.
  const live: SessionView = { ...session };
  renderBankroll(hudEl, live);

  const { ctx } = mountCanvas(stageEl, STAGE_W, STAGE_H);
  const ledger = createLedger(ledgerEl);

  // Idle background loop so the stage is alive before the first launch.
  // Stops automatically once the canvas detaches (handled by loop()).
  let inFlight = false;
  loop((_dt, elapsed) => {
    if (inFlight) return false; // hand control to the flight loop
    drawStarfield(ctx, STAGE_W, STAGE_H, elapsed);
    drawRocket(ctx, STAGE_W / 2 - 16, STAGE_H - 96, 6, false);
    return true;
  });

  // Receipt polling handle. The ledger shows the WHOLE session — every wager and
  // sponsor match across all rounds — and persists across navigation.
  let cancelReceipt: (() => void) | null = null;

  // Show donations from earlier rounds straight away.
  void refreshSessionReceipt(live, ledger, hudEl).catch(() => {});

  // ─── Round lifecycle ──────────────────────────────────────────────────────
  let cancelFlight: (() => void) | null = null;

  function setLaunchEnabled(): void {
    // Disabled while a round is live or the bankroll can't cover one coin.
    const minWager = 10 ** live.assetScale; // one whole "coin"
    launchBtn.disabled = inFlight || live.remaining < minWager;
  }

  async function onCashout(roundId: string, displayedM: number): Promise<void> {
    // Guard against double-resolution (manual click + auto-bail racing).
    if (!inFlight) return;
    inFlight = false;
    cashBtn.disabled = true;
    cashBtn.classList.remove('cashout-armed');
    urgencyEl.hidden = true;
    if (cancelFlight) { cancelFlight(); cancelFlight = null; }

    let res;
    try {
      res = await api.games.rocketCashout(roundId, displayedM);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(msg, 'err');
      setLaunchEnabled();
      return;
    }

    if (res.outcome === 'WIN') {
      readoutEl.textContent = fmtX(res.multiplier);
      readoutEl.classList.add('is-win');
      winBurst(stageEl);
      coinSpray();
      toast(`Cashed out at ${fmtX(res.multiplier)}! 🎉`, 'win');
    } else {
      readoutEl.textContent = fmtX(res.crashPoint);
      readoutEl.classList.add('is-loss');
      screenShake(stageEl);
      playExplosion();
      toast('Boom! It crashed 💥', 'err');
    }

    // Settlement nets reserved→spent; remaining is authoritative from play.
    renderBankroll(hudEl, live);
    setLaunchEnabled();
    // Keep polling the session receipt until the wager AND (on a win) the sponsor
    // match have settled — the match row is created a beat after the wager.
    cancelReceipt?.();
    cancelReceipt = pollSessionReceipt(live, ledger, hudEl, roundId, res.outcome === 'WIN' && res.matchAmount > 0);
  }

  // Short loss animation: explosion at the rocket's last position (~0.8s).
  function playExplosion(): void {
    const ex = STAGE_W / 2;
    const ey = STAGE_H / 2 - 20;
    loop((_dt, elapsed) => {
      const t = elapsed / 0.8;
      if (t >= 1) return false;
      drawStarfield(ctx, STAGE_W, STAGE_H, elapsed);
      drawExplosion(ctx, ex, ey, 8, t);
      return true;
    });
  }

  // Win flourish: a brief coin spray rising from the rocket.
  function coinSpray(): void {
    loop((_dt, elapsed) => {
      if (elapsed >= 0.9) return false;
      drawStarfield(ctx, STAGE_W, STAGE_H, elapsed);
      drawRocket(ctx, STAGE_W / 2 - 16, STAGE_H / 2 - 24, 6, true);
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2;
        const r = elapsed * 220;
        const cx = STAGE_W / 2 + Math.cos(ang) * r;
        const cy = STAGE_H / 2 - 24 + Math.sin(ang) * r - elapsed * 60;
        drawCoin(ctx, cx - 9, cy - 9, 3);
      }
      return true;
    });
  }

  async function onLaunch(): Promise<void> {
    if (inFlight) return;

    const wager = toMinor(wagerEl.value, live.assetScale);
    if (!Number.isFinite(wager) || wager < 1) {
      toast('Enter a wager of at least 1 coin', 'err');
      return;
    }
    if (wager > live.remaining) {
      toast('Wager exceeds your remaining bankroll', 'err');
      return;
    }

    cancelReceipt?.();
    readoutEl.classList.remove('is-win', 'is-loss');
    launchBtn.disabled = true;

    let r;
    try {
      r = await api.games.rocketPlay({ sessionId: live.id, wager });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(msg, 'err');
      setLaunchEnabled();
      return;
    }

    // Reflect the play in the HUD: bankroll reserved by the wager, remaining
    // authoritative from the server.
    live.bankrollReserved += wager;
    live.remaining = r.remaining;
    renderBankroll(hudEl, live);

    inFlight = true;
    cashBtn.disabled = false;
    cashBtn.classList.add('cashout-armed');   // pulse + glow: cash out before it blows!
    urgencyEl.hidden = false;
    let currentM = 1;
    let crashed = false;
    const crashPoint = r.crashPoint;   // known to the code, NEVER shown to the player
    const t0 = Date.now();             // LOCAL clock — no server skew, so the credited
                                       // win equals exactly what's on screen

    // ─── The climb ──
    cancelFlight = loop((_dt, _elapsed) => {
      const ageSec = (Date.now() - t0) / 1000;
      const m = Math.exp(r.growthK * ageSec);
      currentM = m;

      // Live crash: the rocket visibly blows up the instant it reaches the hidden
      // crash point. Cash out before then to win; otherwise it's a loss. This caps
      // the readout at the real crash point so it never balloons to silly numbers.
      if (!crashed && m >= crashPoint) {
        crashed = true;
        currentM = crashPoint;
        void onCashout(r.roundId, crashPoint); // server resolves this as a LOSS
        return false;
      }

      // Altitude tracks elapsed time (not the multiplier) so even an early crash
      // shows a real climb. Stars scroll faster the higher it goes.
      drawStarfield(ctx, STAGE_W, STAGE_H, ageSec * 1.6 + m * 0.4);
      const climb = Math.min(1, ageSec / 9);
      const baseY = (STAGE_H - 80) - climb * (STAGE_H - 150);
      const wobble = Math.sin(ageSec * 11) * 3;
      drawRocket(ctx, STAGE_W / 2 - 16 + wobble, baseY, 6, true);

      readoutEl.textContent = fmtX(m);
      return true;
    });

    // Wire cash-out to the live multiplier for this round.
    cashBtn.onclick = () => void onCashout(r.roundId, currentM);
  }

  launchBtn.addEventListener('click', () => void onLaunch());

  // Initial state: can we afford a launch?
  setLaunchEnabled();
  if (launchBtn.disabled && !inFlight) {
    toast('Bankroll empty — END RUN in the lobby', 'info');
  }

  // Note: the animation loops self-cancel when the canvas detaches (handled by
  // arcade.loop). The poll interval is cleared on settlement / before each new
  // round; clearPoll on the final settled poll prevents a leak after nav.
}
