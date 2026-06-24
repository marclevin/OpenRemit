import { api, User, Charity, PledgesResponse, PledgeView } from '../api';
import { createLedger, toast } from '../lib/arcade';
import { formatMoney, formatAmount } from '../money';
import { escapeHtml } from '../escape';

// Sponsor pledges and matches are tracked in testnet 2-dp units.
const SCALE = 2;

/**
 * SPONSOR dashboard. "BACK A CAUSE" — authorise a matching budget at your wallet,
 * see aggregate impact stats, and manage existing pledges (with their live
 * match ledgers and an END control).
 */
export async function renderSponsorView(container: HTMLElement, user: User): Promise<void> {
  container.innerHTML = `<div class="panel"><p class="muted">Loading sponsor dashboard…</p></div>`;

  let data: PledgesResponse;
  try {
    data = await api.pledges.list();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    container.innerHTML = `<div class="panel"><p class="muted">Couldn't load your pledges.</p></div>`;
    toast(msg, 'err');
    return;
  }

  container.innerHTML = `
    <section class="sponsor">
      <h2 class="pixel-h1 sponsor__title">SPONSOR DASHBOARD</h2>
      <div id="sponsor-create"></div>
      ${statsHtml(data)}
      <h3 class="pixel-h2 sponsor__subtitle">YOUR PLEDGES</h3>
      <div id="sponsor-pledges">${pledgesHtml(data.pledges)}</div>
    </section>
  `;

  // ── SECTION A — create-pledge panel (async charity load) ──
  const createEl = container.querySelector<HTMLElement>('#sponsor-create')!;
  await renderCreatePanel(createEl, user, container);

  // ── SECTION C wiring — match ledgers + END buttons ──
  wirePledges(container, user, data.pledges);
}

// ─── SECTION A: BACK A CAUSE ─────────────────────────────────────────────────────

async function renderCreatePanel(
  el: HTMLElement,
  user: User,
  container: HTMLElement,
): Promise<void> {
  if (!user.walletAddress) {
    el.innerHTML = `
      <div class="panel sponsor__nowallet">
        <p>You need a wallet address to sponsor.</p>
        <button class="btn btn--cyan btn--block" type="button" id="go-profile">SET WALLET ADDRESS</button>
      </div>
    `;
    el.querySelector<HTMLButtonElement>('#go-profile')!.addEventListener('click', () => {
      window.location.hash = '#/profile';
    });
    return;
  }

  let charities: Charity[];
  try {
    charities = await api.charities.list();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    el.innerHTML = `<div class="panel"><p class="muted">Couldn't load charities.</p></div>`;
    toast(msg, 'err');
    return;
  }

  const options = [
    '<option value="">Any charity</option>',
    ...charities.map(
      (ch) => `<option value="${escapeHtml(ch.id)}">${escapeHtml(ch.name)}</option>`,
    ),
  ].join('');

  el.innerHTML = `
    <div class="panel sponsor__create">
      <h3 class="pixel-h2">💚 BACK A CAUSE</h3>

      <div class="field">
        <label class="pixel-label" for="pledge-charity">CHARITY</label>
        <select class="coin-input" id="pledge-charity">${options}</select>
      </div>

      <div class="field">
        <label class="pixel-label" for="pledge-pool">MATCHING POOL (coins)</label>
        <input class="coin-input" id="pledge-pool" type="number" inputmode="numeric"
               min="1" step="1" value="100" />
        <span class="sponsor__hint muted">1 coin = 1.00 of your wallet currency</span>
      </div>

      <button class="btn btn--green btn--lg btn--block" type="button" id="pledge-go">
        💚 PLEDGE &amp; AUTHORISE
      </button>

      <p class="sponsor__note muted">
        You approve a one-time matching budget at your wallet. When a player wins on
        your cause, we donate the winnings-over-wager from it automatically.
      </p>
    </div>
  `;

  const charitySel = el.querySelector<HTMLSelectElement>('#pledge-charity')!;
  const poolInput = el.querySelector<HTMLInputElement>('#pledge-pool')!;
  const goBtn = el.querySelector<HTMLButtonElement>('#pledge-go')!;

  goBtn.addEventListener('click', async () => {
    // Send the pool in MAJOR units (coins) — the backend converts to the wallet's
    // smallest unit once it has resolved the real assetScale.
    const pool = Number(poolInput.value);
    if (!Number.isFinite(pool) || pool < 1) {
      toast('Matching pool must be at least 1 coin', 'err');
      return;
    }

    goBtn.disabled = true;
    const originalLabel = goBtn.textContent;
    goBtn.textContent = 'Opening your wallet…';
    try {
      const charityId = charitySel.value || null;
      const { interactUrl } = await api.pledges.create({ charityId, pool });
      window.location.href = interactUrl;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(msg, 'err');
      goBtn.disabled = false;
      goBtn.textContent = originalLabel;
    }
  });

  // container is referenced so callers keep a stable signature; no re-render needed here.
  void container;
}

// ─── SECTION B: stats ────────────────────────────────────────────────────────────

function statsHtml(data: PledgesResponse): string {
  const s = data.stats;
  return `
    <div class="stat-grid sponsor__stats">
      <div class="stat">
        <span class="stat__num">${escapeHtml(formatAmount(s.totalMatched, SCALE))}</span>
        <span class="stat__label">TOTAL MATCHED</span>
      </div>
      <div class="stat">
        <span class="stat__num">${escapeHtml(String(s.matchesCount))}</span>
        <span class="stat__label">MATCHES</span>
      </div>
      <div class="stat">
        <span class="stat__num">${escapeHtml(String(s.charitiesHelped))}</span>
        <span class="stat__label">CHARITIES HELPED</span>
      </div>
    </div>
  `;
}

// ─── SECTION C: YOUR PLEDGES ─────────────────────────────────────────────────────

const STATUS_CHIP: Record<PledgeView['status'], string> = {
  ACTIVE:         '<span class="chip chip--green">ACTIVE</span>',
  DEPLETED:       '<span class="chip chip--gold">DEPLETED</span>',
  ENDED:          '<span class="chip chip--muted">ENDED</span>',
  AWAITING_GRANT: '<span class="chip chip--muted">AWAITING GRANT</span>',
};

function pledgesHtml(pledges: PledgeView[]): string {
  if (!pledges.length) {
    return `<div class="panel sponsor__empty"><p class="muted">No pledges yet — back a cause above.</p></div>`;
  }

  // Newest first.
  const ordered = [...pledges].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return ordered.map((p) => pledgeCardHtml(p)).join('');
}

function pledgeCardHtml(p: PledgeView): string {
  const limit = p.poolLimit || 1;
  const pct = clampPct((p.poolSpent / limit) * 100);
  const canEnd = p.status === 'ACTIVE' || p.status === 'DEPLETED';

  const endBtn = canEnd
    ? `<button class="btn btn--pink btn--block" type="button" data-end="${escapeHtml(p.id)}">END</button>`
    : '';

  return `
    <div class="panel sponsor__pledge" data-pledge="${escapeHtml(p.id)}">
      <div class="sponsor__pledge-head">
        <span class="chip chip--muted">${escapeHtml(p.charityName)}</span>
        ${STATUS_CHIP[p.status]}
      </div>

      <div class="meter">
        <div class="meter__fill" style="width:${pct.toFixed(1)}%"></div>
      </div>

      <p class="sponsor__pledge-amounts muted">
        matched ${escapeHtml(formatMoney(p.poolSpent, 'USD', SCALE))}
        of ${escapeHtml(formatMoney(p.poolLimit, 'USD', SCALE))}
        · remaining ${escapeHtml(formatMoney(p.remaining, 'USD', SCALE))}
      </p>

      <div class="sponsor__pledge-ledger" data-ledger="${escapeHtml(p.id)}"></div>
      ${endBtn}
    </div>
  `;
}

function wirePledges(container: HTMLElement, user: User, pledges: PledgeView[]): void {
  // Fill each pledge's recent-match ledger.
  pledges.forEach((p) => {
    const host = container.querySelector<HTMLElement>(`[data-ledger="${cssEscape(p.id)}"]`);
    if (!host) return;
    const first = p.recentMatches[0];
    const assetCode = first ? first.assetCode : 'USD';
    const assetScale = first ? first.assetScale : SCALE;
    createLedger(host).show(p.recentMatches, assetCode, assetScale);
  });

  // END buttons.
  container.querySelectorAll<HTMLButtonElement>('[data-end]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.end!;
      btn.disabled = true;
      btn.textContent = 'Ending…';
      try {
        await api.pledges.end(id);
        toast('Pledge ended', 'info');
        await renderSponsorView(container, user);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        toast(msg, 'err');
        btn.disabled = false;
        btn.textContent = 'END';
      }
    });
  });
}

// ─── utils ───────────────────────────────────────────────────────────────────────

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

// Escape a value for safe use inside a CSS attribute selector. Pledge ids are
// server-generated, but stay defensive.
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
