import { api, Group, Claim, User, MembershipSummary } from '../api';
import { escapeHtml } from '../escape';
import { formatZAR, statusBadge } from './claimsFormat';

// ─── Pending-claims carousel ──────────────────────────────────────────────────

// Short household handle from a wallet address: the last path segment, e.g.
// https://ilp.interledger-test.dev/victim → "victim".
function householdHandle(wallet: string): string {
  const seg = wallet.replace(/\/+$/, '').split('/').pop();
  return seg || wallet;
}

// A clickable, swiping carousel of houses with open (PENDING/VERIFIED) claims —
// one card per household showing its name (wallet handle) and address. Click the
// card to swipe to the next; dots jump directly.
function renderPendingCarousel(openClaims: Claim[]): string {
  if (!openClaims.length) {
    return `
      <div class="card" style="margin-bottom:1.5rem">
        <p class="muted" style="margin:0">
          No pending claims — the village is calm. <a href="#/report">Report a fire →</a>
        </p>
      </div>`;
  }

  const slides = openClaims
    .map((c) => {
      const name  = escapeHtml(householdHandle(c.claimantWallet));
      const addr  = escapeHtml(c.event?.location ?? 'Unknown location');
      const when  = c.event?.occurredAt ? new Date(c.event.occurredAt).toLocaleString() : '—';
      const count = c.event?.claimCount ?? 1;
      return `
        <div class="carousel-slide">
          <div class="cs-icon">🏠</div>
          <div class="cs-body">
            <div class="cs-name">${name}</div>
            <div class="cs-addr">${addr}</div>
            <div class="cs-meta">
              ${statusBadge(c.status)}
              <span class="muted">· ${count} on this event · ${escapeHtml(when)}</span>
            </div>
          </div>
        </div>`;
    })
    .join('');

  const multi = openClaims.length > 1;
  const dots = openClaims
    .map((_, i) => `<button class="carousel-dot${i === 0 ? ' active' : ''}" data-i="${i}" aria-label="Go to claim ${i + 1}"></button>`)
    .join('');

  const controls = multi
    ? `<div class="carousel-controls">
         <button class="carousel-arrow" id="carousel-prev" aria-label="Previous claim">‹</button>
         <div class="carousel-dots">${dots}</div>
         <button class="carousel-arrow" id="carousel-next" aria-label="Next claim">›</button>
       </div>`
    : `<div class="carousel-dots">${dots}</div>`;

  return `
    <div class="card claims-carousel" id="pending-carousel" style="margin-bottom:1.5rem">
      <div class="carousel-head">
        <h3 style="margin:0">Houses with pending claims</h3>
        <a href="#/report" class="report-link">+ Report a fire</a>
      </div>
      <div class="carousel-viewport" id="carousel-viewport">
        <div class="carousel-track" id="carousel-track">${slides}</div>
      </div>
      <div class="carousel-foot">
        ${controls}
        <span class="muted" style="font-size:.78rem"><span id="carousel-pos">1</span>/${openClaims.length}${multi ? ' · tap to cycle' : ''}</span>
      </div>
    </div>`;
}

// ─── Pool status banner ───────────────────────────────────────────────────────

// A single home (roof + body + door) — fill follows the parent's `color`.
const HOUSE_SVG =
  `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5 1.5 11H5v10.5h5.2v-6h3.6v6H19V11h3.5z"/></svg>`;

// A flame + a few embers, layered over a burning house.
const FIRE_OVERLAY =
  `<span class="flame"></span><span class="ember"></span><span class="ember"></span><span class="ember"></span>`;

export interface VillageCtx {
  memberCount:  number;  // enrolled member households
  fireCount:    number;  // households with an open (PENDING/VERIFIED) claim
  justEnrolled: boolean; // came back from a successful enrollment → drop the newest home in
  welcome:      boolean; // newly signed-up member's first visit → drop *their* home in
  coinRain:     boolean; // the monthly debit cycle just ran → rain coins into the pool
  payout:       string | null; // 'POOL' | 'BACKSTOP' — a claim was just paid → money-shot
  payoutHandle: string | null; // the paid claimant's household handle (labels the rebuilt home)
}

// ── Ambient overlay generators ────────────────────────────────────────────────

// Diagonal rain streaks for the covariate "backstop downpour".
function rainStreaks(): string {
  let s = '';
  for (let i = 0; i < 18; i++) {
    const left  = Math.round((i / 18) * 100 + (i % 3) * 3);
    const delay = (i * 0.06).toFixed(2);
    const dur   = (0.7 + (i % 4) * 0.12).toFixed(2);
    s += `<span class="rain" style="left:${left}%;animation-delay:${delay}s;animation-duration:${dur}s"></span>`;
  }
  return s;
}

// Gold coins raining into the pool when the monthly debit cycle runs.
function coinDrops(): string {
  let s = '';
  for (let i = 0; i < 20; i++) {
    const left  = (i * 47) % 100;
    const delay = ((i % 10) * 0.11).toFixed(2);
    const dur   = (1.1 + (i % 5) * 0.13).toFixed(2);
    s += `<span class="coin" style="left:${left}%;animation-delay:${delay}s;animation-duration:${dur}s"></span>`;
  }
  return s;
}


// The village: one house per enrolled member. Gold = the fund can currently
// rebuild it, bare = member but not yet covered, on fire = open claim. Before
// anyone enrolls, a faint "potential" village shows the pool's coverage.
function renderVillage(group: Group, ctx: VillageCtx): string {
  const scale       = group.assetScale;
  const balance     = Number(group.poolBalance);
  const capacity    = Number(group.designCapacity);
  const costPerHome = Math.max(1, Number(group.fixedPayoutAmount));

  const coverable = Math.max(0, Math.floor(balance / costPerHome)); // homes the pool can fund now
  const ghost     = ctx.memberCount === 0;

  const baseTotal = ghost
    ? Math.max(coverable, Math.ceil(capacity / costPerHome))
    : ctx.memberCount;
  // The village must be big enough to show every open claim as a burning home —
  // claims are independent of enrollment, so fires show even in a ghost village.
  const rawTotal = Math.max(1, baseTotal, ctx.fireCount);

  const MAX_ICONS = 48;
  const perIcon   = Math.max(1, Math.ceil(rawTotal / MAX_ICONS));
  const total     = Math.max(1, Math.ceil(rawTotal / perIcon));

  const protectedHomes = ghost ? coverable : Math.min(ctx.memberCount, coverable);
  const fireHomes      = Math.min(ctx.fireCount, rawTotal);

  const iconsFire = Math.min(total, Math.round(fireHomes / perIcon));
  const iconsGold = Math.min(total - iconsFire, Math.round(protectedHomes / perIcon));

  // The last house in the grid drops in when either: a brand-new member just
  // signed up (their own home joins the village), or a member just enrolled.
  const dropInLast = ctx.welcome || (ctx.justEnrolled && !ghost);
  // The just-paid claimant's home — placed at the first slot after the fires so
  // surviving fires stay visible and the rebuilt home glows gold among the
  // protected. The money-shot coins land here.
  const rebuildIdx = ctx.payout ? Math.min(iconsFire, total - 1) : -1;

  let icons = '';
  for (let i = 0; i < total; i++) {
    const isLast = i === total - 1;
    let cls: string;
    let inner = HOUSE_SVG;
    if (i < iconsFire) {
      cls    = 'house is-fire';
      inner += FIRE_OVERLAY;
    } else if (i < iconsFire + iconsGold) {
      cls = 'house is-protected';
    } else {
      cls = ghost ? 'house is-ghost' : 'house is-bare';
    }
    // On a welcome, the user's home is the one that drops in — make it a solid
    // home (not a faint "potential" one) and ring it so they can spot it.
    if (ctx.welcome && isLast) {
      cls = cls.replace('is-ghost', 'is-bare') + ' is-you';
    }
    if (dropInLast && isLast) cls += ' is-dropin';

    let extra = ` style="animation-delay:${i * 24}ms"`;
    if (i === rebuildIdx) {
      cls = 'house is-protected is-rebuilding';
      extra = ` id="payout-house"${ctx.payoutHandle ? ` title="${escapeHtml(ctx.payoutHandle)} — rebuilt"` : ''}`;
    }
    icons += `<span class="${cls}"${extra}>${inner}</span>`;
  }

  const headlineNum   = ghost ? coverable : protectedHomes;
  const headlineLabel = ctx.welcome
    ? `your home just joined the village — enroll to protect it`
    : ghost
      ? `home${coverable === 1 ? '' : 's'} currently coverable by the fund`
      : `of ${ctx.memberCount} member home${ctx.memberCount === 1 ? '' : 's'} protected by the fund right now`;

  const scaleNote  = perIcon > 1 ? `<span class="muted">each 🏠 ≈ ${perIcon} homes</span>` : '';
  const fireLegend = fireHomes > 0 ? `<span><i class="dot fire"></i>Ablaze (${fireHomes})</span>` : '';

  // ── Ambient state ────────────────────────────────────────────────────────────
  // Resilience weather: amber when the pool can cover the next payout, smoky red
  // when it can't (or a covariate event is underway).
  const canCover    = balance - costPerHome >= Number(group.reserveFloor);
  const isCovariate = group.covariateThreshold > 0 && ctx.fireCount >= group.covariateThreshold;
  const weather     = isCovariate || !canCover ? 'critical' : ctx.fireCount > 0 ? 'strained' : 'calm';

  const vizCls = `houses-viz weather-${weather}`
    + (isCovariate ? ' is-covariate' : '')
    + (ctx.coinRain ? ' coin-rain' : '')
    + (ctx.payout ? ' payout-shot' : '');

  const downpour    = isCovariate ? `<div class="downpour" aria-hidden="true">${rainStreaks()}</div>` : '';
  const coinLayer   = ctx.coinRain ? `<div class="coin-layer" aria-hidden="true">${coinDrops()}</div>` : '';
  const covFlag     = isCovariate
    ? `<div class="covariate-flag">⛈ Covariate event — backstop engaged</div>`
    : '';
  // Payout money-shot: coins stream from the source tranche across to a rebuilt home.
  const moneyShot = ctx.payout
    ? `<div class="moneyshot" aria-hidden="true">
         <span class="ms-label">${ctx.payout === 'BACKSTOP' ? 'Backstop' : 'Pool'} → home</span>
         <span class="ms-coin"></span>
         <span class="ms-coin" style="animation-delay:.15s"></span>
         <span class="ms-coin" style="animation-delay:.30s"></span>
         <span class="ms-coin" style="animation-delay:.45s"></span>
         <span class="ms-burst"></span>
       </div>`
    : '';

  return `
    <div class="${vizCls}">
      ${downpour}
      ${coinLayer}
      ${moneyShot}
      ${covFlag}
      <div class="houses-headline">
        <span class="houses-count">${headlineNum}</span>
        <span class="houses-label">${headlineLabel}</span>
      </div>
      <div class="houses-grid">${icons}</div>
      <div class="houses-legend">
        ${ghost
          ? `<span><i class="dot filled"></i>Coverable (${coverable})</span>
             <span><i class="dot empty"></i>Potential (${total * perIcon})</span>`
          : `<span><i class="dot filled"></i>Protected (${protectedHomes})</span>
             <span><i class="dot bare"></i>Members (${ctx.memberCount})</span>`}
        ${fireLegend}
        <span class="muted">${formatZAR(group.fixedPayoutAmount, scale)} per home</span>
        ${scaleNote}
      </div>
    </div>
  `;
}

function renderPoolStatus(group: Group, village: VillageCtx): string {
  const balance = Number(group.poolBalance);
  const floor   = Number(group.reserveFloor);
  const payout  = Number(group.fixedPayoutAmount);

  const canCover  = balance - payout >= floor;
  const statusCls = canCover ? 'completed' : 'failed';
  const statusLabel = canCover
    ? `Pool can cover next payout (${formatZAR(String(Math.max(0, balance - floor - payout)), group.assetScale)} above floor)`
    : 'Pool below floor — next payout will draw from backstop';

  return `
    <div class="card pool-card" style="margin-bottom:1.5rem">
      <h3 style="margin-top:0">${escapeHtml(group.name)}</h3>

      ${renderVillage(group, village)}

      <div class="pool-stats">
        <div>
          <div class="muted" style="font-size:.8rem">Pool balance</div>
          <strong>${formatZAR(group.poolBalance, group.assetScale)}</strong>
        </div>
        <div>
          <div class="muted" style="font-size:.8rem">Reserve floor</div>
          <strong>${formatZAR(group.reserveFloor, group.assetScale)}</strong>
        </div>
        <div>
          <div class="muted" style="font-size:.8rem">Fixed payout</div>
          <strong>${formatZAR(group.fixedPayoutAmount, group.assetScale)}</strong>
        </div>
        <div>
          <div class="muted" style="font-size:.8rem">Covariate threshold</div>
          <strong>${group.covariateThreshold} claims</strong>
        </div>
      </div>

      <span class="status-badge status-${statusCls}" style="font-size:.8rem">${statusLabel}</span>
    </div>
  `;
}

// ─── Two-layer tranche reservoir ──────────────────────────────────────────────
// Visualizes the reserves+reinsurance structure: Layer 1 (member pool) as a
// liquid tank filling toward design capacity with the reserve-floor line, and
// Layer 2 (outside-funded backstop) beneath, which lights up when the pool can
// no longer cover the next payout.
function renderReservoir(group: Group): string {
  const scale  = group.assetScale;
  const cap    = Math.max(1, Number(group.designCapacity));
  const bal    = Number(group.poolBalance);
  const floor  = Number(group.reserveFloor);
  const payout = Number(group.fixedPayoutAmount);

  const poolPct  = Math.max(0, Math.min(100, (bal / cap) * 100));
  const floorPct = Math.max(0, Math.min(100, (floor / cap) * 100));
  const headroom = Math.max(0, bal - floor);
  const engaged  = bal - payout < floor; // backstop covers the shortfall

  return `
    <div class="card reservoir-card" style="margin-bottom:1.5rem">
      <h3 style="margin-top:0">Fund reserves</h3>
      <div class="reservoir">
        <div class="tank">
          <span class="tank-cap-label">capacity</span>
          <div class="tank-fill" style="height:${poolPct}%"></div>
          <div class="tank-floor" style="bottom:${floorPct}%"><span>floor</span></div>
        </div>
        <div class="reservoir-legend">
          <div class="rl-row"><span class="rl-dot pool"></span><span>Layer 1 · Pool</span><strong>${formatZAR(group.poolBalance, scale)}</strong></div>
          <div class="rl-row"><span class="rl-dot head"></span><span>Coverable above floor</span><strong>${formatZAR(String(headroom), scale)}</strong></div>
          <div class="rl-row"><span class="rl-dot floor"></span><span>Reserve floor</span><strong>${formatZAR(group.reserveFloor, scale)}</strong></div>
          <div class="rl-row"><span class="rl-dot cap"></span><span>Design capacity</span><strong>${formatZAR(group.designCapacity, scale)}</strong></div>
        </div>
      </div>
      <div class="backstop-band${engaged ? ' engaged' : ''}">
        <strong>Layer 2 · Backstop tranche ${engaged ? '⚡' : ''}</strong>
        <span class="muted" style="font-size:.82rem">${engaged
          ? 'Engaged — covering the shortfall beyond the pool.'
          : 'On standby — guarantees payouts beyond the pool, up to design capacity.'}</span>
      </div>
    </div>
  `;
}

// ─── Membership & premiums card ───────────────────────────────────────────────
// The fund is financed by a flat R30/month debit order from every member, backed
// by a real Open Payments recurring grant (one consent authorises monthly
// charges). This card shows the member base + monthly inflow, lets a member
// enroll, and lets an admin run the monthly debit cycle on demand.

function renderEnrollCard(group: Group, user: User, summary: MembershipSummary): string {
  const scale   = summary.assetScale ?? group.assetScale;
  const premium = formatZAR(summary.premiumMinor, scale);
  const inflow  = formatZAR(summary.monthlyInflowMinor, scale);
  const isAdmin = user.role === 'ADMIN';

  const stats = `
    <div class="pool-stats" style="margin-bottom:1rem">
      <div>
        <div class="muted" style="font-size:.8rem">Members enrolled</div>
        <strong>${summary.memberCount}</strong>
      </div>
      <div>
        <div class="muted" style="font-size:.8rem">Monthly inflow</div>
        <strong>${inflow}</strong>
      </div>
      <div>
        <div class="muted" style="font-size:.8rem">Premium</div>
        <strong>${premium}/mo</strong>
      </div>
    </div>
  `;

  let body: string;
  if (!user.walletAddress) {
    body = `<p class="muted" style="font-size:.85rem;margin:0">
              Add a wallet address in your <a href="#/profile">Profile</a> to set up your ${premium}/month debit order.
            </p>`;
  } else if (summary.mine && summary.mine.status === 'ACTIVE') {
    const next = summary.mine.nextChargeAt ? new Date(summary.mine.nextChargeAt).toLocaleDateString() : '—';
    body = `
      <div>
        <span class="status-badge status-completed">Debit order active</span>
        <p class="muted" style="font-size:.85rem;margin:.6rem 0 0">
          ${premium} is debited from your wallet each month —
          ${summary.mine.chargesMade} payment${summary.mine.chargesMade === 1 ? '' : 's'} made so far · next on ${escapeHtml(next)}.
        </p>
      </div>`;
  } else {
    const retryNote = summary.mine && (summary.mine.status === 'CANCELLED' || summary.mine.status === 'FAILED')
      ? `<p class="muted" style="font-size:.8rem;margin:.25rem 0 .75rem">Your last enrollment didn't complete — you can try again.</p>`
      : '';
    body = `
      <p class="muted" style="font-size:.85rem;margin-bottom:.75rem">
        Join the mutual: a flat <strong>${premium}/month</strong> debit order from your wallet keeps the fund ready to rebuild homes after a fire. You authorise it once.
      </p>
      ${retryNote}
      <button id="enroll-btn" class="btn btn-primary">Enroll — ${premium}/month</button>
      <span id="enroll-error" class="error-msg" style="display:none;margin-top:.75rem"></span>`;
  }

  const adminBtn = isAdmin
    ? `<button id="run-debits-btn" class="btn btn-secondary" style="margin-top:1rem;width:100%">Run this month's debit orders</button>
       <span id="run-debits-result" class="muted" style="display:block;font-size:.8rem;margin-top:.5rem"></span>`
    : '';

  return `
    <div class="card" style="margin-bottom:1.5rem">
      <h3 style="margin-top:0">Membership &amp; premiums</h3>
      ${stats}
      ${body}
      ${adminBtn}
    </div>
  `;
}

// ─── Main render ─────────────────────────────────────────────────────────────

export async function renderClaimsView(container: HTMLElement, currentUser: User): Promise<void> {
  container.innerHTML = `<div class="card"><p class="muted">Loading…</p></div>`;

  let groups: Group[];
  let allClaims: Claim[];

  try {
    [groups, allClaims] = await Promise.all([api.claims.groups(), api.claims.list()]);
  } catch (err) {
    container.innerHTML = `<div class="card"><p class="error-msg">Failed to load claims: ${escapeHtml(String(err))}</p></div>`;
    return;
  }

  // Membership summary drives the enrollment card + member stats. Non-fatal:
  // fall back to an empty summary if it fails so the rest of the page renders.
  let summary: MembershipSummary;
  try {
    summary = await api.memberships.summary();
  } catch {
    summary = { memberCount: 0, monthlyInflowMinor: '0', premiumMinor: '3000', assetScale: 2, mine: null };
  }

  // One-time welcome for a newly signed-up member's first Relief Fund visit —
  // their home drops into the village. Consumed (cleared) on this render.
  const welcome = localStorage.getItem('fireline:welcome') === '1';
  if (welcome) localStorage.removeItem('fireline:welcome');

  // One-shot coin-rain when the monthly debit cycle has just run (set by the
  // run-debits handler before it re-renders). Consumed on this render.
  const coinRain = localStorage.getItem('fireline:debitRain') === '1';
  if (coinRain) localStorage.removeItem('fireline:debitRain');

  // Money-shot after a claim payout returns from the wallet (POOL | BACKSTOP).
  const payoutShot    = localStorage.getItem('fireline:payout');
  const payoutClaimId = localStorage.getItem('fireline:payoutClaim');
  if (payoutShot)    localStorage.removeItem('fireline:payout');
  if (payoutClaimId) localStorage.removeItem('fireline:payoutClaim');
  const welcomeBanner = welcome
    ? `<div class="success-msg" style="margin-bottom:1.5rem">Welcome to the fund — your home has joined the village. Set up your R30/month debit order below to protect it.</div>`
    : '';

  // Banner after returning from the wallet consent redirect (?enroll=…).
  const enrollParam = new URLSearchParams(window.location.search).get('enroll');
  const enrollBanner = enrollParam === 'active'
    ? `<div class="success-msg" style="margin-bottom:1.5rem">Debit order active — your first month's premium is in the pool. Welcome to the fund.</div>`
    : enrollParam === 'declined'
      ? `<div class="warning-msg" style="margin-bottom:1.5rem">Enrollment cancelled — you declined the authorisation at your wallet.</div>`
      : enrollParam === 'failed'
        ? `<div class="error-msg" style="margin-bottom:1.5rem">Enrollment didn't complete. Please try again.</div>`
        : '';
  if (enrollParam) {
    // Clear the query param so a refresh doesn't re-show the banner.
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
  }

  const group = groups[0];
  if (!group) {
    container.innerHTML = `<div class="card"><p class="muted">No mutual group found. Ensure the backend has BACKSTOP_WALLET_ADDRESS configured and has been restarted.</p></div>`;
    return;
  }

  const groupClaims = allClaims
    .filter((c) => c.groupId === group.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // Claims others filed that the current user can verify
  const needsMyVerification = groupClaims.filter(
    (c) => c.status === 'PENDING' && c.filedByUserId !== currentUser.id
  );

  const pendingBanner = needsMyVerification.length > 0
    ? `<div class="card" style="border-left:3px solid var(--color-primary);margin-bottom:1.5rem;padding:.75rem 1rem">
        <strong>${needsMyVerification.length} claim${needsMyVerification.length !== 1 ? 's' : ''} awaiting your verification.</strong>
        <span class="muted" style="font-size:.85rem;margin-left:.5rem">
          Community attestation helps ensure payouts go to genuinely affected households.
        </span>
       </div>`
    : '';

  // Open claims (not yet paid out or rejected) — the burning houses, shown in
  // both the village and the pending-claims carousel.
  const openClaims = groupClaims.filter((c) => c.status === 'PENDING' || c.status === 'VERIFIED');

  // The just-paid claimant's household handle, used to label the rebuilt home
  // and the money-shot banner.
  const paidClaim    = payoutClaimId ? groupClaims.find((c) => c.id === payoutClaimId) : undefined;
  const payoutHandle = paidClaim ? householdHandle(paidClaim.claimantWallet) : null;
  const payoutBanner = payoutShot
    ? `<div class="success-msg" style="margin-bottom:1.5rem">🏠 ${payoutHandle ? escapeHtml(payoutHandle) + "'s home" : 'A home'} rebuilt — payout sent from ${payoutShot === 'BACKSTOP' ? 'the backstop tranche' : 'the member pool'}.</div>`
    : '';

  const village: VillageCtx = {
    memberCount:  summary.memberCount,
    fireCount:    openClaims.length,
    justEnrolled: enrollParam === 'active',
    welcome,
    coinRain,
    payout: payoutShot,
    payoutHandle,
  };

  container.innerHTML = `
    <h2 style="margin-bottom:1rem">Fire Relief Claims</h2>
    ${payoutBanner}
    ${welcomeBanner}
    ${enrollBanner}
    ${pendingBanner}
    ${renderPoolStatus(group, village)}
    ${renderReservoir(group)}
    ${renderPendingCarousel(openClaims)}
    ${renderEnrollCard(group, currentUser, summary)}
    <p class="auth-switch" style="margin-top:.5rem"><a href="#/all-claims">View all claims →</a></p>
  `;

  // ── Money-shot: aim the coins at the rebuilt home's measured position ────────
  if (payoutShot) {
    const viz   = container.querySelector<HTMLElement>('.houses-viz');
    const house = container.querySelector<HTMLElement>('#payout-house');
    const ms    = container.querySelector<HTMLElement>('.moneyshot');
    if (viz && house && ms) {
      const vb = viz.getBoundingClientRect();
      const hb = house.getBoundingClientRect();
      const tx = ((hb.left + hb.width  / 2 - vb.left) / vb.width)  * 100;
      const ty = ((hb.top  + hb.height / 2 - vb.top)  / vb.height) * 100;
      ms.style.setProperty('--ms-tx', `${tx.toFixed(1)}%`);
      ms.style.setProperty('--ms-ty', `${ty.toFixed(1)}%`);
    }
  }

  // ── Pending-claims carousel ──────────────────────────────────────────────────
  const carousel = container.querySelector<HTMLElement>('#pending-carousel');
  if (carousel) {
    const track = carousel.querySelector<HTMLElement>('#carousel-track')!;
    const dots  = Array.from(carousel.querySelectorAll<HTMLButtonElement>('.carousel-dot'));
    const posEl = carousel.querySelector<HTMLElement>('#carousel-pos');
    const n     = dots.length;
    let idx     = 0;

    const go = (to: number) => {
      idx = (to + n) % n;
      track.style.transform = `translateX(-${idx * 100}%)`;
      dots.forEach((d, i) => d.classList.toggle('active', i === idx));
      if (posEl) posEl.textContent = String(idx + 1);
    };

    carousel.querySelector('#carousel-viewport')!.addEventListener('click', () => go(idx + 1));
    dots.forEach((d, i) => d.addEventListener('click', (e) => { e.stopPropagation(); go(i); }));
    carousel.querySelector('#carousel-prev')?.addEventListener('click', (e) => { e.stopPropagation(); go(idx - 1); });
    carousel.querySelector('#carousel-next')?.addEventListener('click', (e) => { e.stopPropagation(); go(idx + 1); });
  }

  // ── Enroll in the R30/month debit order ──────────────────────────────────────
  const enrollBtn = container.querySelector<HTMLButtonElement>('#enroll-btn');
  if (enrollBtn) {
    const eErrEl = container.querySelector<HTMLElement>('#enroll-error')!;
    enrollBtn.addEventListener('click', async () => {
      eErrEl.style.display = 'none';
      enrollBtn.disabled    = true;
      enrollBtn.textContent = 'Preparing…';
      try {
        const { interactUrl } = await api.memberships.enroll();
        enrollBtn.textContent = 'Redirecting to wallet…';
        window.location.href = interactUrl; // approve the recurring grant at the wallet
      } catch (err) {
        eErrEl.textContent   = String(err);
        eErrEl.style.display = 'block';
        enrollBtn.disabled    = false;
        enrollBtn.textContent = 'Enroll';
      }
    });
  }

  // ── Admin: run this month's debit cycle ──────────────────────────────────────
  const runDebitsBtn = container.querySelector<HTMLButtonElement>('#run-debits-btn');
  if (runDebitsBtn) {
    const resEl = container.querySelector<HTMLElement>('#run-debits-result')!;
    runDebitsBtn.addEventListener('click', async () => {
      runDebitsBtn.disabled    = true;
      runDebitsBtn.textContent = 'Running…';
      try {
        const r = await api.memberships.runDebits();
        if (r.charged > 0) {
          // Re-render so the pool balance + homes-covered jump is visible, with
          // a one-shot coin-rain celebrating the premiums landing in the pool.
          localStorage.setItem('fireline:debitRain', '1');
          await renderClaimsView(container, currentUser);
        } else {
          resEl.textContent = r.due === 0
            ? 'No debit orders are due right now.'
            : `0 of ${r.due} charged · ${r.failed} failed. ${r.results.find(x => x.error)?.error ?? ''}`;
          runDebitsBtn.disabled    = false;
          runDebitsBtn.textContent = "Run this month's debit orders";
        }
      } catch (err) {
        resEl.textContent = String(err);
        runDebitsBtn.disabled    = false;
        runDebitsBtn.textContent = "Run this month's debit orders";
      }
    });
  }

}
