import './styles.css';
import { isLoggedIn } from './auth';
import { api, User } from './api';
import { renderHomeView }    from './views/homeView';
import { renderLoginView }   from './views/loginView';
import { renderSignupView }  from './views/signupView';
import { renderProfileView } from './views/profileView';
import { renderHistoryView } from './views/historyView';
import { renderStatusView }        from './views/statusView';
import { renderPublicProfileView } from './views/publicProfileView';
import { renderNewsView }          from './views/newsView';
import { renderNewsArticleView }   from './views/newsArticleView';
import type { UnlockOutcome }      from './views/newsArticleView';
import { renderClaimsView }        from './views/claimsView';
import { renderReportFireView }    from './views/reportFireView';
import { renderAllClaimsView }     from './views/allClaimsView';

const view    = document.getElementById('view')!;
const nav     = document.getElementById('main-nav')!;
const navLinks = nav.querySelectorAll<HTMLAnchorElement>('.nav-link');

// ─── State ────────────────────────────────────────────────────────────────────

let cachedUser: User | null = null;

// ─── Nav helpers ──────────────────────────────────────────────────────────────

function updateNav(route: string): void {
  nav.hidden = !isLoggedIn();
  navLinks.forEach((a) => {
    a.classList.toggle('active', a.dataset.route === route);
  });
}

async function updatePendingBadge(): Promise<void> {
  const badge = document.getElementById('nav-pending-badge');
  if (!badge || !isLoggedIn() || !cachedUser) return;
  try {
    const allClaims = await api.claims.list();
    // Count PENDING claims not filed by the current user (i.e. they can verify these)
    const verifiable = allClaims.filter(
      (c) => c.status === 'PENDING' && c.filedByUserId !== cachedUser!.id
    );
    if (verifiable.length > 0) {
      badge.textContent = String(verifiable.length);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  } catch {
    badge.hidden = true;
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function route(): Promise<void> {
  document.querySelectorAll('link[rel="monetization"]').forEach((l) => l.remove());

  // GNAP callback: ?id=<uuid> takes priority over hash.
  const params   = new URLSearchParams(window.location.search);
  const returnId = params.get('id');
  if (returnId) {
    const returnPost = params.get('post');
    if (returnPost && isLoggedIn()) {
      const outcome = params.get('status') as UnlockOutcome;
      history.replaceState({}, '', window.location.pathname + '#/news/' + returnPost);
      updateNav('news');
      renderNewsArticleView(view, returnPost, outcome);
      return;
    }
    // Claim payout: land back on the Relief Fund and play the money-shot,
    // rather than the generic status view.
    const payout = params.get('payout');
    if (payout && isLoggedIn()) {
      localStorage.setItem('fireline:payout', payout);
      const paidClaim = params.get('claim');
      if (paidClaim) localStorage.setItem('fireline:payoutClaim', paidClaim);
      history.replaceState({}, '', window.location.pathname + '#/claims');
      // fall through to the hash router below, which renders the Relief Fund.
    } else {
      history.replaceState({}, '', window.location.pathname + '#/status');
      updateNav('');
      renderStatusView(view, returnId);
      return;
    }
  }

  const hash  = window.location.hash || '#/';
  const path  = hash.slice(1);

  const segment = path.split('/')[1] ?? '';
  updateNav(segment);

  // Public routes
  if (path === '/' || path === '') {
    renderHomeView(view);
    return;
  }
  if (path === '/login') {
    renderLoginView(view);
    return;
  }
  if (path === '/signup') {
    renderSignupView(view);
    return;
  }

  // Protected routes
  if (!isLoggedIn()) {
    window.location.hash = '#/login';
    return;
  }

  if (!cachedUser) {
    try {
      cachedUser = await api.auth.me();
    } catch {
      window.location.hash = '#/login';
      return;
    }
  }

  if (path === '/status') {
    window.location.hash = '#/';
    return;
  }

  if (path === '/news') {
    await renderNewsView(view);
    return;
  }
  if (path.startsWith('/news/')) {
    const postId = path.slice('/news/'.length);
    await renderNewsArticleView(view, postId, null);
    return;
  }
  if (path === '/history') {
    await renderHistoryView(view);
    return;
  }
  if (path === '/claims') {
    await renderClaimsView(view, cachedUser);
    return;
  }
  if (path === '/report') {
    await renderReportFireView(view);
    return;
  }
  if (path === '/all-claims') {
    await renderAllClaimsView(view, cachedUser);
    return;
  }
  if (path === '/profile') {
    await renderProfileView(view);
    return;
  }
  if (path.startsWith('/user/')) {
    const userId = path.slice('/user/'.length);
    await renderPublicProfileView(view, userId);
    return;
  }

  // Fallback
  window.location.hash = '#/';
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

window.addEventListener('hashchange', () => {
  cachedUser = null;
  route();
});

route().then(() => updatePendingBadge());
