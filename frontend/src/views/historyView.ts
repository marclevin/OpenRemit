import { api, HistoryEntry } from '../api';
import { escapeHtml } from '../escape';
import { toPointer } from '../pointer';
import { formatMoney } from '../money';
import { isQuoteExpired } from '../txStatus';

// Sent payments show what left the wallet (debit, in the sender's currency);
// received payments show what arrived (receive amount, in the receiver's currency).
function formatAmount(tx: HistoryEntry): string {
  if (tx.direction === 'received') {
    const code  = tx.receiveAssetCode  ?? tx.assetCode;
    const scale = tx.receiveAssetScale ?? tx.assetScale;
    return `+${formatMoney(tx.receiveAmount ?? '0', code, scale)}`;
  }
  return `−${formatMoney(tx.debitAmount ?? '0', tx.assetCode, tx.assetScale)}`;
}

function formatDate(ts: string): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatStatus(status: string): string {
  const labels: Record<string, string> = {
    COMPLETED:      'Completed',
    FAILED:         'Failed',
    PENDING:        'Pending',
    AWAITING_GRANT: 'Awaiting',
  };
  return labels[status] ?? status;
}

// A PENDING/AWAITING_GRANT row whose quote has expired can never complete, so we
// show it as "Expired" instead of a forever-pending badge (see txStatus.ts).
function statusBadge(tx: HistoryEntry): string {
  const expired = isQuoteExpired(tx);
  const cls     = expired ? 'expired' : tx.status.toLowerCase();
  const label   = expired ? 'Expired' : formatStatus(tx.status);
  const title   = expired ? 'The quote expired before this payment was authorised' : '';
  return `<span class="status-badge status-${cls}" title="${title}">${label}</span>`;
}

export async function renderHistoryView(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="card"><p class="muted">Loading history…</p></div>`;

  let history: HistoryEntry[];
  try {
    history = await api.history();
  } catch {
    container.innerHTML = `<div class="card"><p class="error-msg">Failed to load transaction history.</p></div>`;
    return;
  }

  const tableHtml = history.length === 0
    ? `<div class="card">
         <p class="muted history-empty">
           No transactions yet.
           <a href="#/remit" class="history-empty-link">Send your first payment →</a>
         </p>
       </div>`
    : `<div class="card history-card">
         <div class="history-table-wrap">
           <table class="history-table">
             <colgroup>
               <col class="col-date" />
               <col class="col-amount" />
               <col class="col-recip" />
               <col class="col-status" />
             </colgroup>
             <thead>
               <tr>
                 <th>Date</th>
                 <th>Amount</th>
                 <th>To / From</th>
                 <th>Status</th>
               </tr>
             </thead>
             <tbody>
               ${history.map(tx => `
                 <tr>
                   <td class="history-date-cell">${formatDate(tx.createdAt)}</td>
                   <td class="history-amount-cell amount-${tx.direction}">${formatAmount(tx)}</td>
                   <td>
                     ${tx.counterpartyId
                       ? `<a class="history-recip-link" href="#/user/${encodeURIComponent(tx.counterpartyId)}">
                            <div class="history-recip-name">${escapeHtml(tx.counterpartyName ?? '—')}</div>
                            <div class="history-recip-pointer">${escapeHtml(toPointer(tx.counterpartyWallet))}</div>
                          </a>`
                       : `<div>
                            <div class="history-recip-name">${escapeHtml(tx.counterpartyName ?? '—')}</div>
                            <div class="history-recip-pointer">${escapeHtml(toPointer(tx.counterpartyWallet))}</div>
                          </div>`
                     }
                   </td>
                   <td>
                     ${statusBadge(tx)}
                   </td>
                 </tr>
               `).join('')}
             </tbody>
           </table>
         </div>
       </div>`;

  container.innerHTML = `
    <div class="history-page">
      <div class="history-page-header">
        <h2 class="history-page-title">Transaction history</h2>
        <p class="history-page-sub">Payments you've sent and received, most recent first.</p>
      </div>
      ${tableHtml}
    </div>
  `;
}
