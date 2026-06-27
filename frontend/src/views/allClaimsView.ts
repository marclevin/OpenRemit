import { api, Group, Claim, User } from '../api';
import { escapeHtml } from '../escape';
import { formatZAR, statusBadge, sourceBadge, classificationBadge } from './claimsFormat';

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

  const selfNote = isFiler && claim.status === 'PENDING'
    ? `<div class="muted" style="font-size:.8rem;margin-top:.25rem">
        You filed this claim — another member must verify it.
       </div>`
    : '';

  // Action buttons — visible to everyone except the filer can't verify their own.
  let actionButtons = '';
  if (claim.status === 'PENDING') {
    if (!isFiler) {
      actionButtons += `<button class="btn btn-primary btn-small js-verify" data-id="${escapeHtml(claim.id)}">Verify</button>`;
    }
    if (isAdmin) {
      actionButtons += `<button class="btn btn-secondary btn-small js-reject" data-id="${escapeHtml(claim.id)}">Reject</button>`;
    }
  } else if (claim.status === 'VERIFIED' && isAdmin) {
    actionButtons = `<button class="btn btn-primary btn-small js-payout" data-id="${escapeHtml(claim.id)}">Trigger Payout</button>`;
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
          ${actionButtons ? `<div class="claim-actions">${actionButtons}</div>` : ''}
          <span class="error-msg js-row-error" data-id="${escapeHtml(claim.id)}" style="display:none;font-size:.85rem"></span>
        </div>
      </div>
    </div>
  `;
}

function showRowError(container: HTMLElement, claimId: string, msg: string): void {
  const el = container.querySelector<HTMLElement>(`.js-row-error[data-id="${claimId}"]`);
  if (el) {
    el.textContent   = msg;
    el.style.display = 'inline';
  }
}

// ─── Main render ─────────────────────────────────────────────────────────────

export async function renderAllClaimsView(container: HTMLElement, currentUser: User): Promise<void> {
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
    container.innerHTML = `<div class="card"><p class="muted">No mutual group found.</p></div>`;
    return;
  }

  const groupClaims = allClaims
    .filter((c) => c.groupId === group.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const roleNote = currentUser.role === 'ADMIN'
    ? `<div class="muted" style="font-size:.8rem;margin-bottom:1rem">
        You are logged in as <strong>Admin</strong>. You can verify, reject, and trigger payouts.
       </div>`
    : `<div class="muted" style="font-size:.8rem;margin-bottom:1rem">
        You can verify claims filed by other members. You cannot verify claims you filed yourself.
       </div>`;

  const claimRows = groupClaims.length
    ? groupClaims.map((c) => renderClaimCard(c, group, currentUser)).join('')
    : `<div class="card muted">No claims yet — <a href="#/report">report a fire</a> to file the first one.</div>`;

  container.innerHTML = `
    <h2 style="margin-bottom:1rem">All Claims</h2>
    ${roleNote}
    <div id="claims-list">${claimRows}</div>
    <p class="auth-switch" style="margin-top:1rem"><a href="#/claims">← Back to Relief Fund</a></p>
  `;

  // ── Verify / Reject / Payout buttons ─────────────────────────────────────────
  // This view re-renders itself on each action; remove any prior listener so
  // handlers don't accumulate on the (persistent) container element.
  const prevHandler = (container as any)._allClaimsHandler;
  if (prevHandler) container.removeEventListener('click', prevHandler);

  const clickHandler = async (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!(target instanceof HTMLButtonElement)) return;
    const btn = target;

    if (btn.classList.contains('js-verify')) {
      const id = btn.dataset.id!;
      btn.disabled = true; btn.textContent = 'Verifying…';
      try {
        await api.claims.verify(id);
        await renderAllClaimsView(container, currentUser);
      } catch (err) {
        showRowError(container, id, String(err));
        btn.disabled = false; btn.textContent = 'Verify';
      }
    }

    if (btn.classList.contains('js-reject')) {
      const id = btn.dataset.id!;
      btn.disabled = true; btn.textContent = 'Rejecting…';
      try {
        await api.claims.reject(id);
        await renderAllClaimsView(container, currentUser);
      } catch (err) {
        showRowError(container, id, String(err));
        btn.disabled = false; btn.textContent = 'Reject';
      }
    }

    if (btn.classList.contains('js-payout')) {
      const id = btn.dataset.id!;
      btn.disabled = true; btn.textContent = 'Getting quote…';
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
          btn.disabled = false; btn.textContent = 'Trigger Payout';
        }
      } catch (err) {
        showRowError(container, id, String(err));
        btn.disabled = false; btn.textContent = 'Trigger Payout';
      }
    }
  };

  (container as any)._allClaimsHandler = clickHandler;
  container.addEventListener('click', clickHandler);
}
