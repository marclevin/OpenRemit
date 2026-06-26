import { isLoggedIn } from '../auth';

const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const icons = {
  flame:  `<svg ${SVG_ATTRS}><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`,
  shield: `<svg ${SVG_ATTRS}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  users:  `<svg ${SVG_ATTRS}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  zap:    `<svg ${SVG_ATTRS}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
};

export function renderHomeView(container: HTMLElement): void {
  if (isLoggedIn()) {
    renderDashboard(container);
  } else {
    renderPublic(container);
  }
}

function renderDashboard(container: HTMLElement): void {
  container.innerHTML = `
    <div class="home-logged-in">
      <div class="home-hero-band">
        <h1 class="home-hero-title">Fast relief when</h1>
        <h1 class="home-hero-title home-hero-title-warm">it matters most.</h1>
        <p class="home-hero-body">
          Fireline is a community fire-relief mutual for informal settlements.<br />
          Members verify claims together. Payouts reach affected households within hours.
        </p>
        <div class="home-hero-cta-row">
          <a href="#/claims" class="btn btn-africa-primary">Relief Fund →</a>
          <a href="#/history" class="btn btn-secondary">View history</a>
        </div>
      </div>

      <div class="home-pillars">
        <div class="home-pillar">
          <span class="home-pillar-icon">${icons.zap}</span>
          <div>
            <div class="home-pillar-label">Hours, not days</div>
            <div class="home-pillar-text">Fixed R800 payout lands in the affected household's wallet the same day the community verifies the claim.</div>
          </div>
        </div>
        <div class="home-pillar">
          <span class="home-pillar-icon">${icons.users}</span>
          <div>
            <div class="home-pillar-label">Community attestation</div>
            <div class="home-pillar-text">Members verify each other's claims. No single person — especially not the claimant — can approve their own payout.</div>
          </div>
        </div>
        <div class="home-pillar">
          <span class="home-pillar-icon">${icons.shield}</span>
          <div>
            <div class="home-pillar-label">Two-layer protection</div>
            <div class="home-pillar-text">Member pool covers everyday fires. An external backstop tranche absorbs settlement-wide events the pool alone cannot.</div>
          </div>
        </div>
      </div>

      <div class="home-proverb-band">
        <p class="home-proverb">"Ubuntu: I am because we are."</p>
      </div>
    </div>
  `;
}

function renderPublic(container: HTMLElement): void {
  container.innerHTML = `
    <div class="card hero">
      <div class="hero-africa-tag">${icons.flame} Community fire relief · Khayelitsha</div>
      <h1>Fireline</h1>
      <p class="hero-sub">
        Fast, dignified first-response cash for fire-affected households in informal settlements.<br />
        Built on the Interledger Open Payments standard.
      </p>
      <div class="hero-actions">
        <a href="#/signup" class="btn btn-primary">Join the mutual</a>
        <a href="#/login"  class="btn btn-secondary">Log in</a>
      </div>
      <div class="hero-features">
        <div class="feature">
          <span class="feature-icon">${icons.zap}</span>
          <span>Hours, not days</span>
        </div>
        <div class="feature">
          <span class="feature-icon">${icons.users}</span>
          <span>Community verified</span>
        </div>
        <div class="feature">
          <span class="feature-icon">${icons.shield}</span>
          <span>Two-layer safety net</span>
        </div>
      </div>
    </div>
  `;
}
