import './styles.css';
import { isLoggedIn } from './auth';
import { api, User } from './api';
import { toast } from './lib/arcade';
import { renderHomeView }     from './views/homeView';
import { renderLoginView }    from './views/loginView';
import { renderSignupView }   from './views/signupView';
import { renderProfileView }  from './views/profileView';
import { renderLobbyView }    from './views/lobbyView';
import { renderRocketView }   from './views/gameRocketView';
import { renderPlaneView }    from './views/gamePlaneView';
import { renderPachinkoView } from './views/gamePachinkoView';
import { renderSponsorView }  from './views/sponsorView';
import { renderImpactView }   from './views/impactView';

const view     = document.getElementById('view')!;
const nav      = document.getElementById('main-nav')!;
const navLinks = nav.querySelectorAll<HTMLAnchorElement>('.nav-link');

let cachedUser: User | null = null;

function updateNav(route: string): void {
  nav.hidden = !isLoggedIn();
  navLinks.forEach((a) => a.classList.toggle('active', a.dataset.route === route));
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function route(): Promise<void> {
  // GNAP callback return: ?grant=session|pledge&status=active|declined&id=...
  // Takes priority over the hash, then strips itself so it can't re-fire.
  const params = new URLSearchParams(window.location.search);
  const grant  = params.get('grant');
  if (grant) {
    const status = params.get('status');
    const dest   = grant === 'pledge' ? '#/sponsor' : '#/play';
    history.replaceState({}, '', window.location.pathname + dest);
    if (status === 'active')        toast('Run funded — good luck! 🎮', 'win');
    else if (status === 'declined') toast('Authorisation cancelled', 'err');
    // Fall through to render the destination hash below.
  }

  const hash    = window.location.hash || '#/';
  const path    = hash.slice(1);               // e.g. '/play/rocket'
  const segment = path.split('/')[1] ?? '';    // e.g. 'play'
  updateNav(segment);

  // Public routes
  if (path === '/' || path === '') {
    // Home is public but auth-aware: hydrate the cached user so logged-in
    // visitors get the simplified board (no login/signup CTAs). A stale token
    // just falls back to the logged-out splash.
    if (isLoggedIn() && !cachedUser) {
      try { cachedUser = await api.auth.me(); } catch { cachedUser = null; }
    }
    renderHomeView(view, isLoggedIn() ? cachedUser : null);
    return;
  }
  if (path === '/login')  { renderLoginView(view);  return; }
  if (path === '/signup') { renderSignupView(view); return; }

  // Protected routes
  if (!isLoggedIn()) { window.location.hash = '#/login'; return; }

  if (!cachedUser) {
    try {
      cachedUser = await api.auth.me();
    } catch {
      window.location.hash = '#/login';
      return;
    }
  }

  switch (path) {
    case '/play':           return void renderLobbyView(view, cachedUser);
    case '/play/rocket':    return void renderRocketView(view, cachedUser);
    case '/play/plane':     return void renderPlaneView(view, cachedUser);
    case '/play/pachinko':  return void renderPachinkoView(view, cachedUser);
    case '/sponsor':        return void renderSponsorView(view, cachedUser);
    case '/impact':         return void renderImpactView(view, cachedUser);
    case '/profile':        return void renderProfileView(view, cachedUser);
    default:                window.location.hash = '#/'; return;
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

window.addEventListener('hashchange', () => {
  cachedUser = null; // re-fetch on navigation so profile/role/wallet edits reflect
  route();
});

route();
