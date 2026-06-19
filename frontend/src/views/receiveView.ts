import { api, User, UserSearchResult, WalletInfo, PaymentRequestEntry, PaymentType } from '../api';
import { escapeHtml } from '../escape';
import { toPointer } from '../pointer';
import { avatarHtml } from '../avatar';
import { formatMoney } from '../money';

function formatDate(ts: string): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const STATUS_LABELS: Record<string, string> = {
  PENDING:   'Pending',
  COMPLETED: 'Completed',
  DECLINED:  'Declined',
  CANCELLED: 'Cancelled',
};

// One row in the "Asks you've sent" list. The counterpart is the payer.
function outgoingAskHtml(ask: PaymentRequestEntry): string {
  const amount = formatMoney(ask.amount, ask.assetCode, ask.assetScale);
  const line = ask.paymentType === 'FIXED_SEND'
    ? `You asked <strong>${escapeHtml(ask.counterpartName)}</strong> to send <strong>${amount}</strong>`
    : `You asked <strong>${escapeHtml(ask.counterpartName)}</strong> for <strong>${amount}</strong>`;

  return `
    <li class="request-item">
      ${avatarHtml({ displayName: ask.counterpartName, avatar: ask.counterpartAvatar }, 'request-avatar')}
      <div class="request-info">
        <span class="request-line">${line}</span>
        ${ask.note ? `<span class="request-note">"${escapeHtml(ask.note)}"</span>` : ''}
        <span class="request-meta">${formatDate(ask.createdAt)}</span>
      </div>
      <div class="request-actions">
        <span class="status-badge status-${ask.status.toLowerCase()}">${STATUS_LABELS[ask.status] ?? ask.status}</span>
        ${ask.status === 'PENDING' ? `<button class="btn btn-secondary btn-small" data-cancel="${ask.id}">Cancel</button>` : ''}
      </div>
    </li>
  `;
}

export function renderReceiveView(container: HTMLElement, user: User): void {
  const noWallet = !user.walletAddress;

  container.innerHTML = `
    <div class="receive-page">
      <div class="card send-card">
        <div class="send-header">
          <h2 class="send-title">Request Money</h2>
          <p class="send-subtitle">Ask someone to send you money — they confirm and pay from their Send page.</p>
        </div>

        ${noWallet ? `
          <div class="warning-msg">
            You haven't set a wallet address yet.
            <a href="#/profile">Go to Profile</a> to add one before requesting.
          </div>
        ` : ''}

        <form id="ask-form" class="send-form" novalidate>
          <div class="field">
            <label>Your Payment Pointer 🔒</label>
            <input type="text" class="input" value="${escapeHtml(user.walletAddress ? toPointer(user.walletAddress) : '')}" placeholder="No wallet set yet" readonly disabled aria-readonly="true" />
            <span class="field-hint">This is your own wallet — change it on your <a href="#/profile">Profile</a> page.</span>
          </div>

          <hr class="divider" />

          <div class="field">
            <label for="payer-search">Who are you asking?</label>
            <div class="search-row">
              <input id="payer-search" type="text" class="input" placeholder="Search by name…" autocomplete="off" />
              <button type="button" class="btn btn-secondary" id="payer-search-btn">Search</button>
            </div>
            <ul id="payer-results" class="search-results" hidden></ul>
            <div id="payer-display" class="recipient-card" hidden></div>
          </div>

          <hr class="divider" />

          <div class="field">
            <label>Request Type</label>
            <div class="radio-group">
              <label>
                <input type="radio" name="askType" value="FIXED_RECEIVE" checked />
                <span>
                  <strong>I receive exactly</strong>
                  <span class="muted"> — the amount lands in your currency</span>
                </span>
              </label>
              <label>
                <input type="radio" name="askType" value="FIXED_SEND" />
                <span>
                  <strong>They send exactly</strong>
                  <span class="muted"> — the amount is in their currency</span>
                </span>
              </label>
            </div>
          </div>

          <div class="field">
            <label for="ask-amount">Amount</label>
            <div class="amount-wrap">
              <input id="ask-amount" type="number" min="0.01" step="any" class="input" placeholder="0.00" required />
              <span id="ask-currency" class="amount-currency">—</span>
            </div>
          </div>

          <div class="field">
            <label for="ask-note">Note <span class="muted">(optional)</span></label>
            <input id="ask-note" type="text" class="input" maxlength="280" placeholder="What's it for?" />
          </div>

          <div id="ask-error" class="error-msg" hidden></div>
          <div id="ask-success" class="success-msg" hidden>Request sent!</div>
          <button type="submit" class="btn btn-africa-primary" id="ask-btn" ${noWallet ? 'disabled' : ''}>
            Request →
          </button>
        </form>
      </div>

      <div class="card">
        <h3 class="requests-title">Asks you've sent</h3>
        <div id="outgoing-asks"><p class="muted">Loading…</p></div>
      </div>
    </div>
  `;

  const form          = container.querySelector<HTMLFormElement>('#ask-form')!;
  const btn           = container.querySelector<HTMLButtonElement>('#ask-btn')!;
  const errDiv        = container.querySelector<HTMLDivElement>('#ask-error')!;
  const successDiv    = container.querySelector<HTMLDivElement>('#ask-success')!;
  const searchInput   = container.querySelector<HTMLInputElement>('#payer-search')!;
  const searchBtn     = container.querySelector<HTMLButtonElement>('#payer-search-btn')!;
  const resultsList   = container.querySelector<HTMLUListElement>('#payer-results')!;
  const payerDisplay  = container.querySelector<HTMLDivElement>('#payer-display')!;
  const amountInput   = container.querySelector<HTMLInputElement>('#ask-amount')!;
  const noteInput     = container.querySelector<HTMLInputElement>('#ask-note')!;
  const currencySpan  = container.querySelector<HTMLSpanElement>('#ask-currency')!;
  const outgoingList  = container.querySelector<HTMLDivElement>('#outgoing-asks')!;

  let selectedPayer: UserSearchResult | null = null;
  let myWalletInfo: WalletInfo | null        = null;
  let payerWalletInfo: WalletInfo | null     = null;
  let askType: PaymentType                   = 'FIXED_RECEIVE';

  // The amount is denominated in MY currency for FIXED_RECEIVE,
  // and in the PAYER's currency for FIXED_SEND.
  function denominatingInfo(): WalletInfo | null {
    return askType === 'FIXED_RECEIVE' ? myWalletInfo : payerWalletInfo;
  }

  function updateCurrency(): void {
    currencySpan.textContent = denominatingInfo()?.assetCode ?? '—';
  }

  if (user.walletAddress) {
    api.walletInfo(user.walletAddress)
      .then(info => { myWalletInfo = info; updateCurrency(); })
      .catch(() => {});
  }

  form.querySelectorAll<HTMLInputElement>('input[name="askType"]').forEach(radio => {
    radio.addEventListener('change', () => {
      askType = radio.value as PaymentType;
      amountInput.value = '';
      updateCurrency();
    });
  });

  async function selectPayer(result: UserSearchResult): Promise<void> {
    selectedPayer      = result;
    resultsList.hidden = true;
    searchInput.value  = result.displayName;
    payerWalletInfo    = null;

    payerDisplay.innerHTML = `
      ${avatarHtml(result, 'recipient-avatar')}
      <div class="recipient-info">
        <span class="recipient-name">${escapeHtml(result.displayName)}</span>
        <span class="recipient-wallet">${escapeHtml(result.walletAddress ? toPointer(result.walletAddress) : 'no wallet')}</span>
      </div>
      <span class="currency-tag" id="payer-currency-tag">…</span>
    `;
    payerDisplay.hidden = false;

    if (result.walletAddress) {
      try {
        payerWalletInfo = await api.walletInfo(result.walletAddress);
      } catch {
        payerWalletInfo = null;
      }
      const tag = payerDisplay.querySelector<HTMLSpanElement>('#payer-currency-tag');
      if (tag) tag.textContent = payerWalletInfo?.assetCode ?? '?';
      if (askType === 'FIXED_SEND') updateCurrency();
    }
  }

  async function doSearch(): Promise<void> {
    const q = searchInput.value.trim();
    if (!q) return;

    searchBtn.disabled    = true;
    searchBtn.textContent = '…';
    resultsList.hidden    = true;

    try {
      const results = await api.users.search(q);
      resultsList.innerHTML = '';
      if (results.length === 0) {
        resultsList.innerHTML = '<li class="search-empty">No users found</li>';
      } else {
        results.forEach((r) => {
          const li = document.createElement('li');
          li.className = 'search-result-item';
          li.innerHTML = `
            ${avatarHtml(r, 'search-result-avatar')}
            <span class="search-result-main">
              <span class="search-result-name">${escapeHtml(r.displayName)}</span>
              <span class="search-result-pointer">${r.walletAddress ? escapeHtml(toPointer(r.walletAddress)) : 'no wallet'}</span>
            </span>
          `;
          li.addEventListener('click', () => selectPayer(r));
          resultsList.appendChild(li);
        });
      }
      resultsList.hidden = false;
    } catch {
      resultsList.innerHTML = '<li class="search-empty">Search failed</li>';
      resultsList.hidden    = false;
    } finally {
      searchBtn.disabled    = false;
      searchBtn.textContent = 'Search';
    }
  }

  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

  // ─── Outgoing asks list ─────────────────────────────────────────────────────

  async function loadOutgoing(): Promise<void> {
    try {
      const { outgoing } = await api.requests.list();
      if (outgoing.length === 0) {
        outgoingList.innerHTML = '<p class="muted">No requests yet — ask someone above.</p>';
        return;
      }
      outgoingList.innerHTML = `<ul class="request-list">${outgoing.map(outgoingAskHtml).join('')}</ul>`;

      outgoingList.querySelectorAll<HTMLButtonElement>('[data-cancel]').forEach(cancelBtn => {
        cancelBtn.addEventListener('click', async () => {
          cancelBtn.disabled = true;
          try {
            await api.requests.cancel(cancelBtn.dataset.cancel!);
          } catch {
            cancelBtn.disabled = false;
            return;
          }
          loadOutgoing();
        });
      });
    } catch {
      outgoingList.innerHTML = '<p class="error-msg">Failed to load your requests.</p>';
    }
  }

  loadOutgoing();

  // ─── Submit ─────────────────────────────────────────────────────────────────

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errDiv.hidden     = true;
    successDiv.hidden = true;

    if (!selectedPayer) {
      errDiv.textContent = 'Please search for and select who you are asking.';
      errDiv.hidden      = false;
      return;
    }
    if (!selectedPayer.walletAddress) {
      errDiv.textContent = 'That user has no wallet address yet — they cannot pay.';
      errDiv.hidden      = false;
      return;
    }

    const info = denominatingInfo();
    if (!info) {
      errDiv.textContent = 'Currency info not yet loaded — please wait a moment and try again.';
      errDiv.hidden      = false;
      return;
    }

    const rawAmount = parseFloat(amountInput.value);
    if (isNaN(rawAmount) || rawAmount <= 0) {
      errDiv.textContent = 'Please enter a valid amount greater than 0.';
      errDiv.hidden      = false;
      return;
    }
    const smallestUnit = Math.round(rawAmount * 10 ** info.assetScale).toString();

    btn.disabled    = true;
    btn.textContent = 'Sending request…';

    try {
      await api.requests.create({
        payerId:     selectedPayer.id,
        paymentType: askType,
        amount:      smallestUnit,
        note:        noteInput.value.trim() || undefined,
      });
      successDiv.hidden  = false;
      amountInput.value  = '';
      noteInput.value    = '';
      loadOutgoing();
    } catch (err: unknown) {
      errDiv.textContent = err instanceof Error ? err.message : String(err);
      errDiv.hidden      = false;
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Request →';
    }
  });
}
