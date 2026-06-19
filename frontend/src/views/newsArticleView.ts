import { api, NewsPost } from '../api';
import { escapeHtml } from '../escape';
import { toPointer } from '../pointer';
import { avatarHtml } from '../avatar';
import { formatMoney, formatPrice } from '../money';
import { renderConsentView } from './consentView';

/** Outcome carried back from the GNAP callback after the Open Payments fallback. */
export type UnlockOutcome = 'completed' | 'failed' | null;

// Minimal shape of the Web Monetization `monetization` event (see the spec's
// MonetizationEvent interface). amountSent.value is a decimal string in MAJOR
// units; currency is an asset code like "USD".
interface MonetizationCurrencyAmount { value: string; currency: string }
interface MonetizationEvent extends Event {
  amountSent?:      MonetizationCurrencyAmount;
  incomingPayment?: string;
  paymentPointer?:  string;
}

// True when the user agent recognises the "monetization" link relation — i.e. a
// Web Monetization provider (a supporting browser or the extension) is present.
function webMonetizationSupported(): boolean {
  try {
    return document.createElement('link').relList.supports('monetization');
  } catch {
    return false;
  }
}

/** Stop any active payment session by removing its <link> (spec: removing the
 *  link ends the session). */
function removeMonetizationLinks(): void {
  document.querySelectorAll('link[rel="monetization"]').forEach((l) => l.remove());
}

function priceLabel(post: NewsPost): string {
  return formatPrice(post.price, post.priceAssetCode, post.priceAssetScale);
}

function bodyHtml(body: string): string {
  return body
    .split(/\n\n+/)
    .map((para) => `<p>${escapeHtml(para)}</p>`)
    .join('');
}

// A MonetizationEvent-style receipt: how it was paid, the amount, and the
// incoming-payment URL at the monetization receiver (spec §1.4).
function receiptHtml(post: NewsPost): string {
  if (!post.receipt) return '';
  const { method, amountSent, incomingPayment } = post.receipt;
  const label = method === 'WEB_MONETIZATION' ? 'Streamed via Web Monetization' : 'Paid via Open Payments (fallback)';
  return `
    <div class="monetization-receipt">
      <div class="receipt-header">
        <span class="receipt-mark">⌁</span>
        <span>${escapeHtml(label)}</span>
      </div>
      <div class="receipt-row">
        <span class="receipt-label">amountSent</span>
        <span class="receipt-value">${escapeHtml(formatMoney(amountSent.value, amountSent.assetCode, amountSent.assetScale))}</span>
      </div>
      <div class="receipt-row">
        <span class="receipt-label">paymentPointer</span>
        <code class="receipt-value">${escapeHtml(toPointer(post.receiverWallet))}</code>
      </div>
      ${incomingPayment ? `
        <div class="receipt-row">
          <span class="receipt-label">incomingPayment</span>
          <code class="receipt-value receipt-url">${escapeHtml(incomingPayment)}</code>
        </div>
      ` : ''}
    </div>
  `;
}

export async function renderNewsArticleView(
  container: HTMLElement,
  postId: string,
  outcome: UnlockOutcome = null,
): Promise<void> {
  removeMonetizationLinks(); // stop any session from a previously-viewed article

  container.innerHTML = `
    <div class="card send-card">
      <div class="status-content"><div class="spinner"></div><p class="muted">Loading article…</p></div>
    </div>
  `;

  let post: NewsPost;
  let hasWallet = true;
  try {
    post = await api.news.get(postId);
    try {
      const me = await api.auth.me();
      hasWallet = !!me.walletAddress;
    } catch {
      hasWallet = false;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    container.innerHTML = `
      <div class="card send-card">
        <a class="news-back" href="#/news">← Back to The Ledger</a>
        <div class="error-msg">Failed to load article: ${escapeHtml(msg)}</div>
      </div>
    `;
    return;
  }

  const supported   = webMonetizationSupported();
  const isStreaming = post.streaming;
  // Target the stream settles to: the cap for the special article, the price otherwise.
  const target = isStreaming ? Number(post.streamLimit ?? '0') : Number(post.price);

  let streamed     = 0;        // running total of amountSent.value (MAJOR units)
  let lastIncoming = '';
  let settled      = post.unlocked; // true → show the body + receipt, no streaming
  let finalizing   = false;
  let revealing    = false;
  let linkStarted  = false;

  function targetLabel(): string {
    return `${target.toFixed(post.priceAssetScale)} ${post.priceAssetCode}`;
  }

  function meterHtml(headline: string): string {
    return `
      <div class="wm-stream">
        <div class="wm-stream-head"><span class="receipt-mark">⌁</span> ${escapeHtml(headline)}</div>
        <p class="wm-stream-sub">
          Streaming micropayments to <code>${escapeHtml(toPointer(post.receiverWallet))}</code>
          via your Web Monetization provider.
        </p>
        <div class="wm-progress"><div class="wm-progress-bar" id="wm-bar"></div></div>
        <div class="wm-stream-stats">
          <span><strong id="wm-streamed">${(0).toFixed(post.priceAssetScale)}</strong> streamed</span>
          <span class="muted">of ${escapeHtml(targetLabel())}</span>
        </div>
        <p class="muted wm-waiting" id="wm-waiting">Waiting for the first payment from your provider…</p>
      </div>
    `;
  }

  function gateHtml(): string {
    // Done: full body + the MonetizationEvent receipt.
    if (settled) {
      return `<div class="article-body">${bodyHtml(post.body ?? '')}</div>${receiptHtml(post)}`;
    }

    if (supported) {
      // Special article: body is free; stream live support up to the cap.
      if (isStreaming) {
        return `
          <div class="article-body">${bodyHtml(post.body ?? '')}</div>
          ${meterHtml('Streaming live — supporting this article as you read')}
          <div id="wm-error" class="error-msg" hidden></div>
        `;
      }
      // Normal article, body already revealed: settle the price in the background.
      if (post.body) {
        return `
          <div class="article-body">${bodyHtml(post.body)}</div>
          ${meterHtml('Settling your payment')}
          <div id="wm-error" class="error-msg" hidden></div>
        `;
      }
      // Normal article, not yet active: unlocks the instant streaming begins.
      return `
        <div class="paywall">
          <div class="paywall-lock">🔒</div>
          <h3 class="paywall-title">Continue reading for ${escapeHtml(priceLabel(post))}</h3>
          ${meterHtml('Web Monetization starting…')}
          <p class="muted">The article opens the instant your provider sends its first payment.</p>
          <div id="wm-error" class="error-msg" hidden></div>
        </div>
      `;
    }

    // No Web Monetization provider.
    if (post.body) {
      // Free article: still readable, but no live streaming.
      return `
        <div class="article-body">${bodyHtml(post.body)}</div>
        <div class="wm-unsupported">
          No <strong>Web Monetization</strong> provider detected, so live support is off. Install the
          <a href="https://webmonetization.org/" target="_blank" rel="noopener">Web Monetization extension</a>
          to stream payments to the journalist while you read.
        </div>
      `;
    }
    // Paywalled article with no provider: offer the one-off fallback.
    return `
      <div class="paywall">
        <div class="paywall-lock">🔒</div>
        <h3 class="paywall-title">Continue reading for ${escapeHtml(priceLabel(post))}</h3>
        <div class="wm-unsupported">
          This browser has no <strong>Web Monetization</strong> provider, so it can't stream payments.
          Install the
          <a href="https://webmonetization.org/" target="_blank" rel="noopener">Web Monetization extension</a>
          to pay by streaming — or use the one-off fallback below.
        </div>
        <div id="wm-error" class="error-msg" hidden></div>
        <div class="paywall-fallback">
          ${hasWallet
            ? '<button class="btn btn-secondary btn-small" id="fallback-btn">Pay once with Open Payments</button>'
            : '<span class="muted">No wallet set — <a href="#/profile">add one</a> to use the one-off fallback.</span>'}
        </div>
      </div>
    `;
  }

  function paint(): void {
    const banner =
      outcome === 'completed'
        ? '<div class="success-msg">Payment received — the article is unlocked. Thanks for supporting independent journalism.</div>'
        : outcome === 'failed'
          ? '<div class="error-msg">The fallback payment was cancelled or failed. You can try again below.</div>'
          : '';

    container.innerHTML = `
      <article class="card send-card news-article">
        <a class="news-back" href="#/news">← Back to The Ledger</a>
        ${banner}
        <div class="article-head">
          ${post.category ? `<span class="category-chip">${escapeHtml(post.category)}</span>` : ''}
          ${isStreaming ? '<span class="live-chip">⌁ Live stream</span>' : ''}
          <h1 class="article-title">${escapeHtml(post.title)}</h1>
          <div class="article-byline">
            ${avatarHtml({ displayName: post.authorName, avatar: post.authorAvatar }, 'news-author-avatar')}
            <span class="news-author-name">${escapeHtml(post.authorName)}</span>
          </div>
        </div>
        <p class="article-excerpt">${escapeHtml(post.excerpt)}</p>
        <hr class="divider" />
        ${gateHtml()}
      </article>
    `;

    if (!settled && supported) {
      startStreaming();
      updateMeter();
    } else if (!settled && !supported) {
      const fb = container.querySelector<HTMLButtonElement>('#fallback-btn');
      if (fb) fb.addEventListener('click', startFallback);
    }
  }

  function updateMeter(): void {
    const bar     = container.querySelector<HTMLDivElement>('#wm-bar');
    const sent    = container.querySelector<HTMLElement>('#wm-streamed');
    const waiting = container.querySelector<HTMLElement>('#wm-waiting');
    if (sent) sent.textContent = streamed.toFixed(post.priceAssetScale);
    if (bar)  bar.style.width = `${Math.min(100, target > 0 ? (streamed / target) * 100 : 100)}%`;
    if (waiting && streamed > 0) waiting.hidden = true;
  }

  function startStreaming(): void {
    if (linkStarted) return;
    linkStarted = true;

    const link = document.createElement('link');
    link.rel  = 'monetization';
    link.href = post.receiverWallet;
    link.addEventListener('monetization', onMonetization);
    document.head.appendChild(link);

    // If nothing arrives, the provider may be disabled or unfunded — nudge.
    window.setTimeout(() => {
      const waiting = container.querySelector<HTMLElement>('#wm-waiting');
      if (streamed === 0 && waiting && !settled) {
        waiting.textContent = 'No payments yet — ensure your Web Monetization extension is enabled and funded.';
      }
    }, 8000);
  }

  function onMonetization(ev: Event): void {
    const e = ev as MonetizationEvent;
    const value = Number(e.amountSent?.value ?? 0);
    if (value > 0) streamed += value;
    if (e.incomingPayment) lastIncoming = e.incomingPayment;

    updateMeter();

    // Normal article: reveal the body the instant monetization is active.
    if (!isStreaming && !post.body && !revealing) {
      revealBody();
      return;
    }
    // Either mode: once the target is reached, record it and stop the session.
    if (streamed >= target && !finalizing) {
      finalize();
    }
  }

  // Normal articles only: unlock + show the body on first payment, then keep
  // streaming to settle the price.
  async function revealBody(): Promise<void> {
    revealing = true;
    try {
      await api.news.wmUnlock(post.id, {
        ...(lastIncoming ? { incomingPayment: lastIncoming } : {}),
        streamedValue: String(streamed),
      });
      post = await api.news.get(post.id); // now includes the body (unlocked)
      paint();                            // re-render with the body + settling meter
    } catch (err) {
      revealing = false;
      showError(err);
    }
  }

  // Target reached: stop the session, persist the final amount, show the receipt.
  async function finalize(): Promise<void> {
    finalizing = true;
    removeMonetizationLinks();
    try {
      await api.news.wmUnlock(post.id, {
        ...(lastIncoming ? { incomingPayment: lastIncoming } : {}),
        streamedValue: String(streamed),
      });
      post = await api.news.get(post.id);
    } catch (err) {
      showError(err);
    }
    settled = true;
    paint();
  }

  async function startFallback(): Promise<void> {
    const btn = container.querySelector<HTMLButtonElement>('#fallback-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Preparing payment…'; }
    try {
      const quoteRes = await api.news.unlock(post.id);
      removeMonetizationLinks(); // stop streaming before leaving for the wallet
      renderConsentView(container, quoteRes, () => { outcome = null; paint(); });
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Pay once with Open Payments'; }
      showError(err);
    }
  }

  function showError(err: unknown): void {
    const errDiv = container.querySelector<HTMLDivElement>('#wm-error');
    if (errDiv) {
      errDiv.textContent = err instanceof Error ? err.message : String(err);
      errDiv.hidden = false;
    }
  }

  paint();
}
