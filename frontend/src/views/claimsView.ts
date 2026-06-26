import { api, Group, Claim, User } from '../api';
import { escapeHtml } from '../escape';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatZAR(value: string, assetScale: number): string {
  const num = Number(value) / Math.pow(10, assetScale);
  return `R${num.toFixed(2)}`;
}

function statusBadge(status: string): string {
  const cls: Record<string, string> = {
    PENDING:  'pending',
    VERIFIED: 'awaiting',
    PAID:     'completed',
    REJECTED: 'failed',
  };
  return `<span class="status-badge status-${cls[status] ?? 'pending'}">${escapeHtml(status)}</span>`;
}

function sourceBadge(source: string | null): string {
  if (!source) return '';
  const cls = source === 'BACKSTOP' ? 'failed' : 'completed';
  const label = source === 'BACKSTOP' ? 'BACKSTOP (outside tranche)' : 'POOL (member fund)';
  return `<span class="status-badge status-${cls}">${escapeHtml(label)}</span>`;
}

function classificationBadge(cls: string | undefined): string {
  if (!cls) return '';
  const badgeCls = cls === 'COVARIATE' ? 'failed' : 'completed';
  const title    = cls === 'COVARIATE'
    ? 'Multiple simultaneous claims — backstop activated'
    : 'Single incident — within normal pool capacity';
  return `<span class="status-badge status-${badgeCls}" title="${title}">${escapeHtml(cls)}</span>`;
}

// ─── Report-fire form ─────────────────────────────────────────────────────────

function renderForm(_group: Group): string {
  const now = new Date();
  const localNow = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);

  return `
    <div class="card" style="margin-bottom:1.5rem">
      <h3 style="margin-top:0">Report a Fire</h3>
      <p class="muted" style="font-size:.85rem;margin-bottom:1rem">
        Anyone in the group can report a fire on behalf of an affected household.
        Claims must be filed within 48 hours of the fire.
      </p>
      <form id="claim-form">
        <div class="form-group">
          <label for="claim-location">Location / street</label>
          <input id="claim-location" type="text" placeholder="e.g. 4 Blueberry Lane, Khayelitsha" required />
        </div>
        <div class="form-group">
          <label for="claim-occurred">When did the fire occur?</label>
          <input id="claim-occurred" type="datetime-local" value="${localNow}" required />
        </div>
        <div class="form-group">
          <label for="claim-wallet">Affected household's wallet address</label>
          <input id="claim-wallet" type="text" placeholder="$ilp.interledger-test.dev/victim" required />
        </div>
        <p class="muted" style="font-size:.85rem">
          The wallet address must be the one registered at enrolment for this household.
          Payout only ever goes to this address.
        </p>
        <button type="submit" class="btn btn-primary">File Claim</button>
        <span id="claim-error" class="error-msg" style="display:none;margin-left:.75rem"></span>
      </form>
    </div>
  `;
}

// ─── Claim card ───────────────────────────────────────────────────────────────

function renderClaimCard(claim: Claim, group: Group, currentUser: User): string {
  const location   = escapeHtml(claim.event?.location ?? 'Unknown');
  const wallet     = escapeHtml(claim.claimantWallet);
  const occurred   = claim.event?.occurredAt
    ? new Date(claim.event.occurredAt).toLocaleString()
    : '—';
  const cls        = claim.event?.classification;
  const claimCount = claim.event?.claimCount ?? 0;
  const isFiler    = claim.filedByUserId === currentUser.id;
  const isAdmin    = currentUser.role === 'ADMIN';

  // Verification notice for own claims
  const selfNote = isFiler && claim.status === 'PENDING'
    ? `<div class="muted" style="font-size:.8rem;margin-top:.25rem">
        You filed this claim — another member must verify it.
       </div>`
    : '';

  // Action buttons — visible to everyone except the filer can't verify their own
  let actionButtons = '';
  if (claim.status === 'PENDING') {
    if (!isFiler) {
      actionButtons += `<button class="btn btn-primary btn-sm js-verify" data-id="${escapeHtml(claim.id)}">Verify</button>`;
    }
    if (isAdmin) {
      actionButtons += `<button class="btn btn-sm js-reject" style="margin-left:.5rem" data-id="${escapeHtml(claim.id)}">Reject</button>`;
    }
  } else if (claim.status === 'VERIFIED' && isAdmin) {
    actionButtons = `<button class="btn btn-primary btn-sm js-payout" data-id="${escapeHtml(claim.id)}">Trigger Payout</button>`;
  }

  const payoutInfo = claim.status === 'PAID'
    ? `<div style="margin-top:.5rem;font-size:.85rem">
        Paid ${formatZAR(claim.payoutAmount ?? '0', group.assetScale)}
        from ${sourceBadge(claim.payoutSource)}
       </div>`
    : '';

  const filedBy = isFiler
    ? `<span class="muted" style="font-size:.8rem"> · Filed by you</span>`
    : '';

  return `
    <div class="card" style="margin-bottom:1rem" id="claim-${escapeHtml(claim.id)}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:.5rem">
        <div>
          <strong>${location}</strong>
          ${classificationBadge(cls)}
          <span class="muted" style="font-size:.85rem;margin-left:.5rem">${claimCount} claim${claimCount !== 1 ? 's' : ''} on this event</span>
          ${filedBy}
          <div class="muted" style="font-size:.85rem">${occurred}</div>
          <div style="font-size:.85rem;margin-top:.25rem">Wallet: <code>${wallet}</code></div>
          ${selfNote}
        </div>
        <div style="text-align:right">
          ${statusBadge(claim.status)}
          ${payoutInfo}
          <div style="margin-top:.5rem">${actionButtons}</div>
          <span class="error-msg js-row-error" data-id="${escapeHtml(claim.id)}" style="display:none;font-size:.85rem"></span>
        </div>
      </div>
    </div>
  `;
}

// ─── Pool status banner ───────────────────────────────────────────────────────

function renderPoolStatus(group: Group): string {
  const balance  = Number(group.poolBalance);
  const floor    = Number(group.reserveFloor);
  const payout   = Number(group.fixedPayoutAmount);
  const capacity = Number(group.designCapacity);
  const pct      = Math.max(0, Math.min(100, Math.round((balance / capacity) * 100)));

  const canCover  = balance - payout >= floor;
  const statusCls = canCover ? 'completed' : 'failed';
  const statusLabel = canCover
    ? `Pool can cover next payout (${formatZAR(String(balance - floor - payout), group.assetScale)} above floor)`
    : 'Pool below floor — next payout will draw from backstop';

  return `
    <div class="card" style="margin-bottom:1.5rem">
      <h3 style="margin-top:0">${escapeHtml(group.name)}</h3>
      <div style="display:flex;gap:2rem;flex-wrap:wrap;margin-bottom:.75rem">
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
      <div style="background:#e5e7eb;border-radius:4px;height:8px;margin-bottom:.5rem">
        <div style="background:var(--color-primary);height:8px;border-radius:4px;width:${pct}%"></div>
      </div>
      <span class="status-badge status-${statusCls}" style="font-size:.8rem">${statusLabel}</span>
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

  const roleNote = currentUser.role === 'ADMIN'
    ? `<div class="muted" style="font-size:.8rem;margin-bottom:1rem">
        You are logged in as <strong>Admin</strong>. You can verify, reject, and trigger payouts.
       </div>`
    : `<div class="muted" style="font-size:.8rem;margin-bottom:1rem">
        You can verify claims filed by other members. You cannot verify claims you filed yourself.
       </div>`;

  const claimRows = groupClaims.length
    ? groupClaims.map((c) => renderClaimCard(c, group, currentUser)).join('')
    : `<div class="card muted">No claims yet — use the form above to report a fire.</div>`;

  container.innerHTML = `
    <h2 style="margin-bottom:1rem">Fire Relief Claims</h2>
    ${pendingBanner}
    ${renderPoolStatus(group)}
    ${renderForm(group)}
    <h3 style="margin-bottom:.75rem">All Claims</h3>
    ${roleNote}
    <div id="claims-list">${claimRows}</div>
  `;

  // ── Form submit ──────────────────────────────────────────────────────────────
  const form  = container.querySelector<HTMLFormElement>('#claim-form')!;
  const errEl = container.querySelector<HTMLElement>('#claim-error')!;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.style.display = 'none';
    const location       = container.querySelector<HTMLInputElement>('#claim-location')!.value.trim();
    const occurredAt     = container.querySelector<HTMLInputElement>('#claim-occurred')!.value;
    const claimantWallet = container.querySelector<HTMLInputElement>('#claim-wallet')!.value.trim();

    const submitBtn = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
    submitBtn.disabled    = true;
    submitBtn.textContent = 'Filing…';

    try {
      await api.claims.file({
        groupId: group.id,
        location,
        occurredAt: new Date(occurredAt).toISOString(),
        claimantWallet,
      });
      await renderClaimsView(container, currentUser);
    } catch (err) {
      errEl.textContent   = String(err);
      errEl.style.display = 'inline';
      submitBtn.disabled  = false;
      submitBtn.textContent = 'File Claim';
    }
  });

  // ── Verify / Reject / Payout buttons ─────────────────────────────────────────
  const prevClickHandler = (container as any)._claimsClickHandler;
  if (prevClickHandler) container.removeEventListener('click', prevClickHandler);

  const claimsClickHandler = async (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!(target instanceof HTMLButtonElement)) return;
    const btn = target;

    if (btn.classList.contains('js-verify')) {
      const id = btn.dataset.id!;
      btn.disabled    = true;
      btn.textContent = 'Verifying…';
      try {
        await api.claims.verify(id);
        await renderClaimsView(container, currentUser);
      } catch (err) {
        showRowError(container, id, String(err));
        btn.disabled    = false;
        btn.textContent = 'Verify';
      }
    }

    if (btn.classList.contains('js-reject')) {
      const id = btn.dataset.id!;
      btn.disabled    = true;
      btn.textContent = 'Rejecting…';
      try {
        await api.claims.reject(id);
        await renderClaimsView(container, currentUser);
      } catch (err) {
        showRowError(container, id, String(err));
        btn.disabled    = false;
        btn.textContent = 'Reject';
      }
    }

    if (btn.classList.contains('js-payout')) {
      const id = btn.dataset.id!;
      btn.disabled    = true;
      btn.textContent = 'Getting quote…';
      try {
        const result = await api.claims.payout(id);
        const fromLabel = result.payoutSource === 'BACKSTOP'
          ? 'BACKSTOP (covariate event or pool below floor)'
          : 'POOL (standard single-incident payout)';
        const confirmed = window.confirm(
          `Payout approved:\n\n` +
          `Classification: ${result.classification}\n` +
          `Funding source: ${fromLabel}\n\n` +
          `You will be redirected to your wallet to authorise the transfer.\n` +
          `Click OK to continue.`
        );
        if (confirmed) {
          window.location.href = result.interactUrl;
        } else {
          btn.disabled    = false;
          btn.textContent = 'Trigger Payout';
        }
      } catch (err) {
        showRowError(container, id, String(err));
        btn.disabled    = false;
        btn.textContent = 'Trigger Payout';
      }
    }
  };

  (container as any)._claimsClickHandler = claimsClickHandler;
  container.addEventListener('click', claimsClickHandler);
}

function showRowError(container: HTMLElement, claimId: string, msg: string): void {
  const el = container.querySelector<HTMLElement>(`.js-row-error[data-id="${claimId}"]`);
  if (el) {
    el.textContent     = msg;
    el.style.display   = 'inline';
  }
}
