import { api, QuoteResponse, User, UserSearchResult, WalletInfo, PaymentRequestEntry } from '../api';
import { escapeHtml } from '../escape';
import { toPointer } from '../pointer';
import { avatarHtml } from '../avatar';
import { formatMoney } from '../money';

// One row in the "Requests for you" card. The counterpart is the requester
// (who gets paid); the current user is the payer.
function incomingAskHtml(ask: PaymentRequestEntry): string {
  const amount = formatMoney(ask.amount, ask.assetCode, ask.assetScale);
  const line = ask.paymentType === 'FIXED_SEND'
    ? `<strong>${escapeHtml(ask.counterpartName)}</strong> asks you to send <strong>${amount}</strong>`
    : `<strong>${escapeHtml(ask.counterpartName)}</strong> asks for enough that they receive <strong>${amount}</strong>`;

  return `
    <li class="request-item">
      ${avatarHtml({ displayName: ask.counterpartName, avatar: ask.counterpartAvatar }, 'request-avatar')}
      <div class="request-info">
        <span class="request-line">${line}</span>
        ${ask.note ? `<span class="request-note">"${escapeHtml(ask.note)}"</span>` : ''}
      </div>
      <div class="request-actions">
        <button class="btn btn-africa-primary btn-small" data-pay="${ask.id}">Pay</button>
        <button class="btn btn-secondary btn-small" data-decline="${ask.id}">Decline</button>
      </div>
    </li>
  `;
}

// Module state: survives view re-renders, so the chosen recipient is still
// selected when the user comes back from a profile page via Back / Send Money.
let selectedRecipient: UserSearchResult | null = null;

// Pre-select (or clear, with null) the recipient for the next Send view.
export function presetRecipient(user: UserSearchResult | null): void {
  selectedRecipient = user;
}

export function renderQuoteView(
  container: HTMLElement,
  user: User,
  onQuote: (res: QuoteResponse) => void
): void {
  const noWallet = !user.walletAddress;

  container.innerHTML = `
    <div id="incoming-requests"></div>
    <div class="card send-card">
      <div class="send-header">
        <h2 class="send-title">Send Money</h2>
        <p class="send-subtitle">Live exchange rates, no hidden fees.</p>
      </div>

      ${noWallet ? `
        <div class="warning-msg">
          You haven't set a wallet address yet.
          <a href="#/profile">Go to Profile</a> to add one before sending.
        </div>
      ` : ''}

      <form id="quote-form" class="send-form" novalidate>
        <div class="field">
          <label>Your Payment Pointer 🔒</label>
          <input type="text" class="input" value="${escapeHtml(user.walletAddress ? toPointer(user.walletAddress) : '')}" placeholder="No wallet set yet" readonly disabled aria-readonly="true" />
          <span class="field-hint">This is your own wallet — change it on your <a href="#/profile">Profile</a> page.</span>
        </div>

        <hr class="divider" />

        <div class="field">
          <label for="receiver-search">Recipient</label>
          <div class="search-row">
            <input
              id="receiver-search" type="text" class="input"
              placeholder="Search by name…"
              autocomplete="off"
            />
            <button type="button" class="btn btn-secondary" id="search-btn">Search</button>
          </div>
          <ul id="search-results" class="search-results" hidden></ul>
          <input id="receiver-wallet" type="hidden" name="receiver" />
          <div id="receiver-display" class="recipient-card" hidden></div>
        </div>

        <hr class="divider" />

        <div class="field">
          <label for="amount">Amount</label>
          <div class="amount-wrap">
            <input
              id="amount" name="amount" type="number" min="0.01" step="any" class="input"
              placeholder="0.00"
              required
            />
            <span id="amount-currency" class="amount-currency">—</span>
          </div>
        </div>

        <div class="field">
          <label>Payment Type</label>
          <div class="radio-group">
            <label>
              <input type="radio" name="paymentType" value="FIXED_SEND" checked />
              <span>
                <strong>Fixed Send</strong>
                <span class="muted"> — you specify exactly what you pay</span>
              </span>
            </label>
            <label>
              <input type="radio" name="paymentType" value="FIXED_RECEIVE" />
              <span>
                <strong>Fixed Receive</strong>
                <span class="muted"> — recipient gets an exact amount</span>
              </span>
            </label>
          </div>
        </div>

        <div id="quote-error" class="error-msg" hidden></div>
        <button type="submit" class="btn btn-africa-primary" id="quote-btn" ${noWallet ? 'disabled' : ''}>
          Get Quote →
        </button>
      </form>
    </div>
  `;

  const form            = container.querySelector<HTMLFormElement>('#quote-form')!;
  const btn             = container.querySelector<HTMLButtonElement>('#quote-btn')!;
  const errDiv          = container.querySelector<HTMLDivElement>('#quote-error')!;
  const searchInput     = container.querySelector<HTMLInputElement>('#receiver-search')!;
  const searchBtn       = container.querySelector<HTMLButtonElement>('#search-btn')!;
  const resultsList     = container.querySelector<HTMLUListElement>('#search-results')!;
  const receiverInput   = container.querySelector<HTMLInputElement>('#receiver-wallet')!;
  const receiverDisplay = container.querySelector<HTMLDivElement>('#receiver-display')!;
  const amountInput     = container.querySelector<HTMLInputElement>('#amount')!;
  const amountCurrency  = container.querySelector<HTMLSpanElement>('#amount-currency')!;

  let senderWalletInfo: WalletInfo | null    = null;
  let recipientWalletInfo: WalletInfo | null = null;
  let currentPaymentType: 'FIXED_SEND' | 'FIXED_RECEIVE' = 'FIXED_SEND';

  function updateAmountCurrency(): void {
    const info = currentPaymentType === 'FIXED_SEND' ? senderWalletInfo : recipientWalletInfo;
    amountCurrency.textContent = info?.assetCode ?? '—';
  }

  // Resolve sender wallet currency on load
  if (user.walletAddress) {
    api.walletInfo(user.walletAddress)
      .then(info => { senderWalletInfo = info; updateAmountCurrency(); })
      .catch(() => {});
  }

  function renderRecipientCard(result: UserSearchResult, currency: string | null): void {
    receiverDisplay.innerHTML = `
      ${avatarHtml(result, 'recipient-avatar')}
      <div class="recipient-info">
        <span class="recipient-name">${escapeHtml(result.displayName)}</span>
        <span class="recipient-wallet">${escapeHtml(result.walletAddress ? toPointer(result.walletAddress) : 'no wallet')}</span>
      </div>
      <span class="currency-tag" id="recipient-currency-tag">${escapeHtml(currency ?? '…')}</span>
      <a class="recipient-profile-link" href="#/user/${result.id}" title="View profile">Profile</a>
    `;
    receiverDisplay.hidden = false;
  }

  async function selectUser(result: UserSearchResult): Promise<void> {
    selectedRecipient   = result;
    receiverInput.value = result.walletAddress ?? '';
    resultsList.hidden  = true;
    searchInput.value   = result.displayName;
    recipientWalletInfo = null;

    renderRecipientCard(result, null);

    if (result.walletAddress) {
      try {
        recipientWalletInfo = await api.walletInfo(result.walletAddress);
      } catch {
        recipientWalletInfo = null;
      }
      const tag = receiverDisplay.querySelector<HTMLSpanElement>('#recipient-currency-tag');
      if (tag) tag.textContent = recipientWalletInfo?.assetCode ?? '?';
      if (currentPaymentType === 'FIXED_RECEIVE') updateAmountCurrency();
    }
  }

  // Swap currency and clear amount on payment type change
  form.querySelectorAll<HTMLInputElement>('input[name="paymentType"]').forEach(radio => {
    radio.addEventListener('change', () => {
      currentPaymentType = radio.value as 'FIXED_SEND' | 'FIXED_RECEIVE';
      amountInput.value  = '';
      updateAmountCurrency();
    });
  });

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
        results.forEach((r: UserSearchResult) => {
          const li = document.createElement('li');
          li.className = 'search-result-item';
          li.innerHTML = `
            ${avatarHtml(r, 'search-result-avatar')}
            <span class="search-result-main">
              <span class="search-result-name">${escapeHtml(r.displayName)}</span>
              <span class="search-result-pointer">${r.walletAddress ? escapeHtml(toPointer(r.walletAddress)) : 'no wallet'}</span>
            </span>
            <a class="search-result-profile" href="#/user/${encodeURIComponent(r.id)}">Profile</a>
          `;
          li.addEventListener('click', (e) => {
            if ((e.target as Element).closest('.search-result-profile')) return; // let the link navigate
            selectUser(r);
          });
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

  // Restore the recipient chosen before navigating away (e.g. to their profile)
  if (selectedRecipient) void selectUser(selectedRecipient);

  // ─── Requests for you ───────────────────────────────────────────────────────
  // Pending asks where the current user is the payer. "Pay" fulfils the ask:
  // the backend quotes it and returns the same shape as a direct send, so the
  // normal consent → callback flow takes over via onQuote.

  const requestsHost = container.querySelector<HTMLDivElement>('#incoming-requests')!;

  async function loadIncomingRequests(): Promise<void> {
    let pending: PaymentRequestEntry[];
    try {
      const { incoming } = await api.requests.list();
      pending = incoming.filter(r => r.status === 'PENDING');
    } catch {
      return; // non-critical — the send form still works
    }
    if (pending.length === 0) {
      requestsHost.innerHTML = '';
      return;
    }

    requestsHost.innerHTML = `
      <div class="card requests-card">
        <h3 class="requests-title">Requests for you</h3>
        <div id="requests-error" class="error-msg" hidden></div>
        <ul class="request-list">
          ${pending.map(incomingAskHtml).join('')}
        </ul>
      </div>
    `;

    const reqErr     = requestsHost.querySelector<HTMLDivElement>('#requests-error')!;
    const allButtons = () => requestsHost.querySelectorAll<HTMLButtonElement>('button');

    requestsHost.querySelectorAll<HTMLButtonElement>('[data-pay]').forEach(payBtn => {
      payBtn.addEventListener('click', async () => {
        allButtons().forEach(b => { b.disabled = true; });
        payBtn.textContent = 'Quoting…';
        reqErr.hidden      = true;
        try {
          const result = await api.requests.fulfill(payBtn.dataset.pay!);
          onQuote(result); // → consent view, then the GNAP redirect flow
        } catch (err: unknown) {
          reqErr.textContent = err instanceof Error ? err.message : String(err);
          reqErr.hidden      = false;
          allButtons().forEach(b => { b.disabled = false; });
          payBtn.textContent = 'Pay';
        }
      });
    });

    requestsHost.querySelectorAll<HTMLButtonElement>('[data-decline]').forEach(declineBtn => {
      declineBtn.addEventListener('click', async () => {
        declineBtn.disabled = true;
        try {
          await api.requests.decline(declineBtn.dataset.decline!);
        } catch {
          declineBtn.disabled = false;
          return;
        }
        loadIncomingRequests();
      });
    });
  }

  void loadIncomingRequests();

  // Close the dropdown when clicking outside. The listener removes itself once
  // this view has been replaced, so re-renders don't pile up stale handlers.
  function onDocumentClick(e: MouseEvent): void {
    if (!document.body.contains(resultsList)) {
      document.removeEventListener('click', onDocumentClick);
      return;
    }
    if (!container.contains(e.target as Node)) resultsList.hidden = true;
  }
  document.addEventListener('click', onDocumentClick);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const receiverWallet = receiverInput.value.trim();
    if (!receiverWallet) {
      errDiv.textContent = 'Please search for and select a recipient first.';
      errDiv.hidden      = false;
      return;
    }

    const data        = new FormData(form);
    const paymentType = data.get('paymentType') as 'FIXED_SEND' | 'FIXED_RECEIVE';
    const activeInfo  = paymentType === 'FIXED_SEND' ? senderWalletInfo : recipientWalletInfo;

    if (!activeInfo) {
      errDiv.textContent = 'Currency info not yet loaded — please wait a moment and try again.';
      errDiv.hidden      = false;
      return;
    }

    const rawAmount = parseFloat(data.get('amount') as string);
    if (isNaN(rawAmount) || rawAmount <= 0) {
      errDiv.textContent = 'Please enter a valid amount greater than 0.';
      errDiv.hidden      = false;
      return;
    }

    const smallestUnit = Math.round(rawAmount * 10 ** activeInfo.assetScale).toString();

    btn.disabled    = true;
    btn.textContent = 'Fetching quote…';
    errDiv.hidden   = true;

    try {
      const result = await api.quote({
        senderWalletAddress:   user.walletAddress!,
        receiverWalletAddress: receiverWallet,
        amount:                smallestUnit,
        paymentType,
      });
      onQuote(result);
    } catch (err: unknown) {
      const msg      = err instanceof Error ? err.message : String(err);
      errDiv.textContent = msg;
      errDiv.hidden  = false;
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Get Quote →';
    }
  });
}
