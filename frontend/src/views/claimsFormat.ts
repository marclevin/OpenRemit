import { escapeHtml } from '../escape';

// Shared claim formatters used by both the Relief Fund (claimsView) and the
// All Claims list (allClaimsView).

export function formatZAR(value: string, assetScale: number): string {
  const num = Number(value) / Math.pow(10, assetScale);
  return `R${num.toFixed(2)}`;
}

export function statusBadge(status: string): string {
  const cls: Record<string, string> = {
    PENDING:  'pending',
    VERIFIED: 'awaiting',
    PAID:     'completed',
    REJECTED: 'failed',
  };
  return `<span class="status-badge status-${cls[status] ?? 'pending'}">${escapeHtml(status)}</span>`;
}

export function sourceBadge(source: string | null): string {
  if (!source) return '';
  const cls = source === 'BACKSTOP' ? 'failed' : 'completed';
  const label = source === 'BACKSTOP' ? 'BACKSTOP (outside tranche)' : 'POOL (member fund)';
  return `<span class="status-badge status-${cls}">${escapeHtml(label)}</span>`;
}

export function classificationBadge(cls: string | undefined): string {
  if (!cls) return '';
  const badgeCls = cls === 'COVARIATE' ? 'failed' : 'completed';
  const title    = cls === 'COVARIATE'
    ? 'Multiple simultaneous claims — backstop activated'
    : 'Single incident — within normal pool capacity';
  return `<span class="status-badge status-${badgeCls}" title="${title}">${escapeHtml(cls)}</span>`;
}
