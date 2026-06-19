import { api, NewsPost } from '../api';
import { escapeHtml } from '../escape';
import { avatarHtml } from '../avatar';
import { formatPrice } from '../money';

function priceLabel(post: NewsPost): string {
  return formatPrice(post.price, post.priceAssetCode, post.priceAssetScale);
}

function tagHtml(post: NewsPost): string {
  if (post.streaming) return '<span class="live-chip">⌁ Live · Free</span>';
  if (post.unlocked)  return '<span class="status-badge status-completed news-unlocked-badge">Unlocked ✓</span>';
  return `<span class="price-tag">${escapeHtml(priceLabel(post))}</span>`;
}

function ctaLabel(post: NewsPost): string {
  if (post.streaming) return 'Read & stream →';
  return post.unlocked ? 'Read →' : 'Unlock →';
}

function postCardHtml(post: NewsPost): string {
  return `
    <a class="news-card${post.streaming ? ' news-card-live' : ''}" href="#/news/${encodeURIComponent(post.id)}">
      <div class="news-card-top">
        ${post.category ? `<span class="category-chip">${escapeHtml(post.category)}</span>` : ''}
        ${tagHtml(post)}
      </div>
      <h3 class="news-card-title">${escapeHtml(post.title)}</h3>
      <p class="news-card-excerpt">${escapeHtml(post.excerpt)}</p>
      <div class="news-card-author">
        ${avatarHtml({ displayName: post.authorName, avatar: post.authorAvatar }, 'news-author-avatar')}
        <span class="news-author-name">${escapeHtml(post.authorName)}</span>
        <span class="news-card-cta">${ctaLabel(post)}</span>
      </div>
    </a>
  `;
}

export async function renderNewsView(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="news-page">
      <div class="card wm-banner">
        <div class="wm-banner-mark">⌁</div>
        <div class="wm-banner-text">
          <h2 class="wm-banner-title">The Ledger</h2>
          <p class="wm-banner-sub">
            Independent reporting, funded by <strong>Web Monetization</strong>.
            </br>Pay as you read.
          </p>
        </div>
      </div>

      <div id="news-list" class="news-grid">
        <p class="muted">Loading articles…</p>
      </div>
    </div>
  `;

  const list = container.querySelector<HTMLDivElement>('#news-list')!;

  try {
    const posts = await api.news.list();
    if (posts.length === 0) {
      list.innerHTML = '<p class="muted">No articles published yet.</p>';
      return;
    }
    list.innerHTML = posts.map(postCardHtml).join('');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    list.innerHTML = `<p class="error-msg">Failed to load articles: ${escapeHtml(msg)}</p>`;
  }
}
