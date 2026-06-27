import { api, Group } from '../api';
import { escapeHtml } from '../escape';

// Report-a-Fire lives on its own tab (#/report) to keep the Relief Fund page
// uncluttered. On success it routes back to the fund, where the new fire shows
// up in the village.
export async function renderReportFireView(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="card"><p class="muted">Loading…</p></div>`;

  let group: Group | undefined;
  try {
    const groups = await api.claims.groups();
    group = groups[0];
  } catch (err) {
    container.innerHTML = `<div class="card"><p class="error-msg">Failed to load: ${escapeHtml(String(err))}</p></div>`;
    return;
  }
  if (!group) {
    container.innerHTML = `<div class="card"><p class="muted">No mutual group configured.</p></div>`;
    return;
  }

  const now      = new Date();
  const localNow = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  container.innerHTML = `
    <h2 style="margin-bottom:1rem">Report a Fire</h2>
    <div class="card">
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
    <p class="auth-switch" style="margin-top:1rem"><a href="#/claims">← Back to Relief Fund</a></p>
  `;

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
        groupId:    group!.id,
        location,
        occurredAt: new Date(occurredAt).toISOString(),
        claimantWallet,
      });
      window.location.hash = '#/claims'; // back to the fund — the new fire shows in the village
    } catch (err) {
      errEl.textContent   = String(err);
      errEl.style.display = 'inline';
      submitBtn.disabled  = false;
      submitBtn.textContent = 'File Claim';
    }
  });
}
