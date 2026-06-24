import type { User } from '../api';
import { escapeHtml } from '../escape';

// Splash / onboarding for GoodWager. Pure markup — no API calls. The router
// passes the cached user (or null when logged out) so we can flip the whole
// screen: a returning player gets a stripped-down board, a visitor gets the
// full pitch with sign-up / log-in CTAs.
export function renderHomeView(container: HTMLElement, user: User | null): void {
  // ── Logged in: keep it simple — welcome + jump-straight-in CTAs. ──
  if (user) {
    container.innerHTML = `
      <div class="home-splash home-splash--auth">
        <div class="home-marquee">
          <h1 class="pixel-h1 home-title">GOODWAGER</h1>
        </div>
        <p class="home-greeting">Welcome back, <b>${escapeHtml(user.displayName)}</b>.</p>

        <div class="home-cta">
          <a href="#/play"    class="btn btn--green btn--lg btn--block">ENTER ARCADE 🎮</a>
          <a href="#/sponsor" class="btn btn--cyan btn--lg btn--block">Sponsor a cause 💚</a>
          <a href="#/impact"  class="btn btn--ghost btn--block">View impact</a>
        </div>
      </div>
    `;
    return;
  }

  // ── Logged out: full pitch + onboarding explainers. ──
  container.innerHTML = `
    <div class="home-splash">
      <div class="home-marquee">
        <h1 class="pixel-h1 home-title">GOODWAGER</h1>
        <p class="home-tagline">Play games. Fund charity. When you win, a sponsor matches it.</p>
      </div>

      <div class="home-explainers">
        <div class="panel home-explainer">
          <span class="home-explainer__icon" aria-hidden="true">🎯</span>
          <h2 class="pixel-h2">Your wager is ALWAYS donated</h2>
          <p>Every coin you stake goes straight to the cause — win or lose, the charity gets paid.</p>
        </div>
        <div class="panel home-explainer">
          <span class="home-explainer__icon" aria-hidden="true">🏆</span>
          <h2 class="pixel-h2">WIN → a sponsor matches it</h2>
          <p>Land a win and a sponsor matches your winnings to the very same charity. Double the good.</p>
        </div>
        <div class="panel home-explainer">
          <span class="home-explainer__icon" aria-hidden="true">💚</span>
          <h2 class="pixel-h2">Pick the cause you play for</h2>
          <p>Choose the charity behind your run, then watch the donation receipts roll in live.</p>
        </div>
      </div>

      <div class="home-cta">
        <a href="#/signup" class="btn btn--gold btn--lg btn--block">INSERT COIN ▸ SIGN UP</a>
        <a href="#/login"  class="btn btn--ghost btn--block">Log in</a>
      </div>
    </div>
  `;
}
