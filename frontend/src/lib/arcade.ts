// GoodWager shared arcade toolkit. Game views import these; signatures are fixed
// by FRONTEND_CONTRACT.md. Pure DOM + canvas, no framework, no external assets.
// Sprites are tiny pixel art drawn with filled rects. All "juice" is CSS-driven.

import type { DonationView } from '../api';
import { formatMoney } from '../money';
import { escapeHtml } from '../escape';

// ─── Neon palette (mirror of styles.css :root) ────────────────────────────────
const C = {
  bg:     '#0d0b1f',
  ink:    '#e9e6ff',
  muted:  '#9b93c8',
  green:  '#39ff14',
  gold:   '#ffd23f',
  pink:   '#ff2e88',
  cyan:   '#21e6c1',
  violet: '#a463ff',
  white:  '#ffffff',
} as const;

// ─── Canvas ────────────────────────────────────────────────────────────────────

/**
 * Create a pixel canvas mounted into `parent`, logical size w×h CSS px, scaled
 * for device pixel ratio, with smoothing off and image-rendering pixelated.
 */
export function mountCanvas(
  parent: HTMLElement,
  w: number,
  h: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  const canvas = document.createElement('canvas');
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  // Display responsively: fill the host's width and let height follow the buffer's
  // aspect ratio. Fixed px here would override the .game-stage CSS and strand the
  // canvas at a small fixed size inside a wider column — the "squish". The drawing
  // still uses logical w×h coordinates regardless of the on-screen size.
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  canvas.style.imageRendering = 'pixelated';

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = false;

  parent.appendChild(canvas);
  return { canvas, ctx };
}

/**
 * requestAnimationFrame loop. `step(dt, elapsed)` receives seconds since the last
 * frame and since start; return false to stop. Returns a cancel() function.
 * Also stops automatically if the host canvas leaves the document.
 */
export function loop(step: (dt: number, elapsed: number) => boolean): () => void {
  let raf = 0;
  let stopped = false;
  let last = performance.now();
  const start = last;

  const frame = (now: number): void => {
    if (stopped) return;
    const dt = (now - last) / 1000;
    const elapsed = (now - start) / 1000;
    last = now;
    const keepGoing = step(dt, elapsed);
    if (keepGoing === false) {
      stopped = true;
      return;
    }
    raf = requestAnimationFrame(frame);
  };

  raf = requestAnimationFrame(frame);

  return (): void => {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
  };
}

// ─── Toasts ────────────────────────────────────────────────────────────────────

function toastHost(): HTMLElement {
  let host = document.querySelector<HTMLElement>('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  return host;
}

/** Floating arcade toast that auto-dismisses after ~3s. */
export function toast(message: string, kind: 'win' | 'info' | 'err' = 'info'): void {
  const host = toastHost();
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  host.appendChild(el);

  window.setTimeout(() => {
    el.classList.add('toast--leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    // Fallback removal in case the animationend never fires.
    window.setTimeout(() => el.remove(), 400);
  }, 3000);
}

// ─── Juice (CSS-class-driven, no audio) ────────────────────────────────────────

/** Flash a win burst over a game stage. */
export function winBurst(stage: HTMLElement): void {
  const flash = document.createElement('div');
  flash.className = 'win-flash';
  stage.appendChild(flash);
  flash.addEventListener('animationend', () => flash.remove(), { once: true });
  window.setTimeout(() => flash.remove(), 1000);
}

/** Briefly shake an element (e.g. on a crash/loss). */
export function screenShake(el: HTMLElement, ms = 400): void {
  el.classList.add('is-shaking');
  window.setTimeout(() => el.classList.remove('is-shaking'), ms);
}

// ─── Bankroll HUD ──────────────────────────────────────────────────────────────

/** Render the standard bankroll meter + charity name + remaining into `el`. */
export function renderBankroll(
  el: HTMLElement,
  session: {
    bankrollLimit: number;
    bankrollSpent: number;
    bankrollReserved: number;
    remaining: number;
    assetCode: string;
    assetScale: number;
    charity: { name: string; accentColor: string };
  },
): void {
  const limit = session.bankrollLimit || 1;
  const spentPct = clampPct((session.bankrollSpent / limit) * 100);
  const reservedPct = clampPct((session.bankrollReserved / limit) * 100);

  el.classList.add('hud');
  el.innerHTML = `
    <div class="hud__top">
      <span class="hud__charity">
        <span class="hud__dot" style="background:${cssColor(session.charity.accentColor)};color:${cssColor(session.charity.accentColor)}"></span>
        ${escapeHtml(session.charity.name)}
      </span>
      <span class="hud__remaining">REMAINING: <b>${escapeHtml(formatMoney(session.remaining, session.assetCode, session.assetScale))}</b></span>
    </div>
    <div class="meter">
      <div class="meter__fill" style="width:${spentPct.toFixed(1)}%"></div>
      <div class="meter__reserved" style="left:${spentPct.toFixed(1)}%;width:${reservedPct.toFixed(1)}%"></div>
    </div>
  `;
}

// ─── Donation receipt ledger ───────────────────────────────────────────────────

export interface Ledger {
  show(donations: DonationView[], assetCode: string, assetScale: number): void;
  el: HTMLElement;
}

const KIND_LABEL: Record<DonationView['kind'], string> = {
  USER_WAGER:   'YOU WAGERED',
  SPONSOR_MATCH: 'SPONSOR MATCH',
};

function statusChip(status: DonationView['status']): string {
  if (status === 'COMPLETED') return '<span class="chip chip--green">COMPLETED</span>';
  if (status === 'FAILED')    return '<span class="chip chip--pink">FAILED</span>';
  return '<span class="chip chip--gold">PENDING</span>';
}

function rowModifier(status: DonationView['status']): string {
  if (status === 'COMPLETED') return 'ledger__row--done';
  if (status === 'FAILED')    return 'ledger__row--failed';
  return 'ledger__row--pending';
}

/** Donation receipt ledger controller. Renders rows newest-first. */
export function createLedger(host: HTMLElement): Ledger {
  host.classList.add('ledger');

  const ledger: Ledger = {
    el: host,
    show(donations: DonationView[], assetCode: string, assetScale: number): void {
      if (!donations.length) {
        host.innerHTML = '<div class="ledger__empty">No donations yet — make a play.</div>';
        return;
      }

      // Newest-first by createdAt (stable for equal timestamps).
      const rows = [...donations].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

      const rowsHtml = rows
        .map((d) => {
          const label = KIND_LABEL[d.kind] ?? escapeHtml(d.kind);
          const sign = d.kind === 'SPONSOR_MATCH' ? '+' : '';
          return `
            <div class="ledger__row ${rowModifier(d.status)}">
              <div class="ledger__main">
                <span class="ledger__kind">${escapeHtml(label)}</span>
                <span class="ledger__amt">${sign}${escapeHtml(formatMoney(d.amount, assetCode, assetScale))}</span>
              </div>
              ${statusChip(d.status)}
            </div>`;
        })
        .join('');

      // Session-wide summary: everything that has actually reached the charity so
      // far — all completed wagers plus all completed sponsor matches.
      const sum = (kind: DonationView['kind']): number =>
        donations.filter((d) => d.kind === kind && d.status === 'COMPLETED').reduce((s, d) => s + d.amount, 0);
      const wagerTotal = sum('USER_WAGER');
      const matchTotal = sum('SPONSOR_MATCH');
      let summaryHtml = '';
      if (wagerTotal + matchTotal > 0) {
        const total = formatMoney(wagerTotal + matchTotal, assetCode, assetScale);
        const breakdown = matchTotal > 0
          ? ` · you ${formatMoney(wagerTotal, assetCode, assetScale)} + sponsors ${formatMoney(matchTotal, assetCode, assetScale)}`
          : '';
        summaryHtml = `<div class="ledger__summary">🎯 charity received ${escapeHtml(total + breakdown)}</div>`;
      }

      // Rows live in their own capped, internally-scrolling box so the receipt
      // can't grow the page without bound; the charity-received summary sits
      // below it and stays put.
      host.innerHTML = `<div class="ledger__scroll">${rowsHtml}</div>${summaryHtml}`;
    },
  };

  return ledger;
}

// ─── Formatting ────────────────────────────────────────────────────────────────

/** 2.5 -> "2.50×" */
export function fmtX(multiplier: number): string {
  return `${multiplier.toFixed(2)}×`;
}

// ─── Sprite helpers ────────────────────────────────────────────────────────────

/** Draw a sprite grid: each truthy cell maps to a palette color via `map`. */
function sprite(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  scale: number,
  grid: string[],
  map: Record<string, string>,
): void {
  for (let row = 0; row < grid.length; row++) {
    const line = grid[row];
    for (let col = 0; col < line.length; col++) {
      const key = line[col];
      const color = map[key];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(
        Math.round(ox + col * scale),
        Math.round(oy + row * scale),
        Math.ceil(scale),
        Math.ceil(scale),
      );
    }
  }
}

/** Parallax starfield drifting downward with `elapsed`. Deterministic layout. */
export function drawStarfield(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  elapsed: number,
): void {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);

  const layers = [
    { count: 28, speed: 8,  size: 1, color: 'rgba(155,147,200,0.55)' },
    { count: 18, speed: 18, size: 1, color: 'rgba(33,230,193,0.55)' },
    { count: 10, speed: 34, size: 2, color: 'rgba(255,255,255,0.85)' },
  ];

  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    ctx.fillStyle = layer.color;
    for (let i = 0; i < layer.count; i++) {
      // Deterministic pseudo-random positions from index + layer.
      const seed = (i * 73 + li * 131) % 997;
      const x = (seed * 37) % w;
      const baseY = (seed * 53) % h;
      const y = (baseY + elapsed * layer.speed) % h;
      ctx.fillRect(Math.round(x), Math.round(y), layer.size, layer.size);
    }
  }
}

/** Rocket: body + nose + window, animated flame when `flame` is true. */
export function drawRocket(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  flame: boolean,
): void {
  const map: Record<string, string> = {
    W: C.white,    // hull
    G: '#c9c4ec',  // shading
    C: C.cyan,     // window
    R: C.pink,     // fins
  };
  const grid = [
    '..W..',
    '.WWW.',
    '.WCW.',
    '.WWW.',
    'RWWWR',
    'R.W.R',
  ];
  sprite(ctx, x, y, scale, grid, map);
  // subtle shading on the right edge
  ctx.fillStyle = map.G;
  ctx.fillRect(Math.round(x + 3 * scale), Math.round(y + 1 * scale), Math.ceil(scale), Math.ceil(scale * 4));

  if (flame) {
    const flicker = (Math.floor(performance.now() / 80) % 2) === 0;
    const flameMap: Record<string, string> = { O: C.gold, P: C.pink };
    const flameGrid = flicker
      ? ['.O.', 'OPO', '.O.']
      : ['.O.', 'OPO', 'OPO', '.O.'];
    sprite(ctx, x + scale, y + 6 * scale, scale, flameGrid, flameMap);
  }
}

/** Plane: fuselage + wings + tail (side view). */
export function drawPlane(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
): void {
  const map: Record<string, string> = {
    B: C.cyan,     // body
    L: '#1aa890',  // body shade
    W: C.white,    // wing
    R: C.pink,     // tail
    C: C.gold,     // cockpit
  };
  const grid = [
    '....R..',
    '...BBR.',
    'WWWWWW.',
    '.BBBBBB',
    '.LCBBB.',
    '..WWW..',
  ];
  sprite(ctx, x, y, scale, grid, map);
}

/** Expanding pixel explosion ring/cluster driven by t (0..1). */
export function drawExplosion(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  t: number,
): void {
  const tt = Math.max(0, Math.min(1, t));
  const radius = tt * scale * 6;
  const colors = [C.gold, C.pink, C.white];
  const points = 14;

  for (let i = 0; i < points; i++) {
    const ang = (i / points) * Math.PI * 2;
    const r = radius * (0.55 + ((i * 17) % 10) / 22);
    const cx = x + Math.cos(ang) * r;
    const cy = y + Math.sin(ang) * r;
    const size = Math.max(1, Math.round(scale * (1 - tt) * 1.6) + 1);
    ctx.fillStyle = colors[i % colors.length];
    ctx.globalAlpha = 1 - tt;
    ctx.fillRect(Math.round(cx - size / 2), Math.round(cy - size / 2), size, size);
  }

  // bright fading core
  const core = Math.max(1, Math.round(scale * (1 - tt) * 2.4));
  ctx.fillStyle = C.white;
  ctx.globalAlpha = (1 - tt) * 0.9;
  ctx.fillRect(Math.round(x - core / 2), Math.round(y - core / 2), core, core);
  ctx.globalAlpha = 1;
}

/** Gold coin with a shine highlight. */
export function drawCoin(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
): void {
  const map: Record<string, string> = {
    G: C.gold,
    D: '#c79a16',  // rim shade
    H: '#fff6c2',  // shine
    S: '#e0a91f',  // center stamp
  };
  const grid = [
    '.DGGD.',
    'DGHGGD',
    'GHGGSG',
    'GGGSGG',
    'DGGGGD',
    '.DGGD.',
  ];
  sprite(ctx, x, y, scale, grid, map);
}

// ─── internal utils ────────────────────────────────────────────────────────────

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/** Sanitize an accent color so it can't break out of the inline style attribute. */
function cssColor(value: string): string {
  return /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : C.cyan;
}
