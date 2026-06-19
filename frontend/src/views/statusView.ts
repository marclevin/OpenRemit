import { api, Transaction } from '../api';
import { escapeHtml } from '../escape';
import { formatMoney } from '../money';
import { isQuoteExpired } from '../txStatus';

function txDetails(id: string, paymentUrl: string | null): string {
  return `
    <details class="tx-details">
      <summary class="tx-details-toggle">Transaction details</summary>
      <div class="tx-details-body">
        <div class="tx-detail-row">
          <span class="tx-detail-label">Transaction ID</span>
          <code class="tx-code">${id}</code>
        </div>
        ${paymentUrl ? `
          <div class="tx-detail-row">
            <span class="tx-detail-label">Payment URL</span>
            <code class="tx-code">${paymentUrl}</code>
          </div>
        ` : ''}
      </div>
    </details>
  `;
}

export function renderStatusView(container: HTMLElement, transactionId: string): void {
  container.innerHTML = `
    <div class="card send-card">
      <div class="send-header">
        <h2 class="send-title">Payment Status</h2>
      </div>
      <div id="status-content" class="status-content">
        <div class="spinner"></div>
        <p class="muted">Checking status…</p>
      </div>
    </div>
  `;

  const content = container.querySelector<HTMLDivElement>('#status-content')!;
  let attempts  = 0;
  const MAX     = 30; // 30 × 2 s = 60 s timeout

  async function poll() {
    try {
      const tx = await api.status(transactionId);
      render(tx);
      // Stop on a terminal state, or once the quote has expired (it can no longer complete).
      if (tx.status === 'COMPLETED' || tx.status === 'FAILED' || isQuoteExpired(tx)) return;
    } catch {
      // keep polling on transient network errors
    }
    if (++attempts < MAX) {
      setTimeout(poll, 2000);
    } else {
      content.innerHTML = `
        <div class="status-terminal">
          <div class="badge badge-danger">Timed out</div>
          <p class="muted">Could not confirm payment after 60 seconds.</p>
          ${txDetails(transactionId, null)}
          <a href="#/remit" class="btn btn-secondary">Start Over</a>
        </div>
      `;
    }
  }

  function render(tx: Transaction) {
    // The receiver's currency may differ from the sender's (cross-currency payment)
    const receiveCode  = tx.receiveAssetCode  ?? tx.assetCode;
    const receiveScale = tx.receiveAssetScale ?? tx.assetScale;

    if (tx.status === 'COMPLETED') {
      content.innerHTML = `
        <div class="status-terminal">
          <div class="status-success-row">
            <div class="status-success-icon">✓</div>
            <h3 class="status-complete-title">Transfer complete!</h3>
          </div>
          <div class="quote-summary">
            ${tx.recipientName ? `
              <div class="summary-row">
                <span class="label">Recipient</span>
                <span class="value">${escapeHtml(tx.recipientName)}</span>
              </div>
            ` : ''}
            <div class="summary-row">
              <span class="label">You sent</span>
              <span class="value">${formatMoney(tx.debitAmount, tx.assetCode, tx.assetScale)}</span>
            </div>
            <div class="summary-row">
              <span class="label">They received</span>
              <span class="value">${formatMoney(tx.receiveAmount, receiveCode, receiveScale)}</span>
            </div>
          </div>
          ${txDetails(tx.id, tx.outgoingPaymentUrl)}
          <a href="#/remit" class="btn btn-africa-primary">New Payment</a>
        </div>
      `;
    } else if (tx.status === 'FAILED') {
      content.innerHTML = `
        <div class="status-terminal">
          <div class="badge badge-danger">Failed</div>
          <div class="error-msg">${escapeHtml(tx.errorMessage ?? 'An unknown error occurred.')}</div>
          ${txDetails(tx.id, null)}
          <a href="#/remit" class="btn btn-secondary">Try Again</a>
        </div>
      `;
    } else if (isQuoteExpired(tx)) {
      content.innerHTML = `
        <div class="status-terminal">
          <div class="badge badge-muted">Expired</div>
          <p class="muted">This quote expired before the payment was authorised. Quotes are valid only briefly — start a new payment to get a fresh one.</p>
          ${txDetails(tx.id, null)}
          <a href="#/remit" class="btn btn-secondary">Start Over</a>
        </div>
      `;
    } else {
      content.innerHTML = `
        <div class="spinner"></div>
        <p class="muted">Status: <strong>${tx.status}</strong> — waiting for confirmation…</p>
      `;
    }
  }

  poll();
}
