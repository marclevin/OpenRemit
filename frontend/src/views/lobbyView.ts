import { api, User, Charity, SessionView } from '../api';
import { renderBankroll, toast } from '../lib/arcade';
import { formatMoney } from '../money';
import { escapeHtml } from '../escape';

// Only allow short hex colors into inline styles — never raw user text.
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
function safeColor(value: string): string {
  return HEX_RE.test(value) ? value : '#21e6c1';
}

interface Cabinet {
  game: string;
  marquee: string;
  desc: string;
}

const CABINETS: Cabinet[] = [
  { game: 'rocket',   marquee: '🚀 ROCKET',      desc: 'Cash out before it blows' },
  { game: 'plane',    marquee: '✈️ PLANE CRASH', desc: 'Auto-fly, hope it lands' },
  { game: 'pachinko', marquee: '🎰 PACHINKO',    desc: 'Drop balls, settle on stop' },
];

/**
 * Arcade LOBBY. With an ACTIVE run, shows the bankroll HUD + three game
 * cabinets + an END RUN control. Otherwise shows the START A RUN flow:
 * pick a charity, set a bankroll, and INSERT COIN to authorise at the wallet.
 */
export async function renderLobbyView(container: HTMLElement, user: User): Promise<void> {
  container.innerHTML = `<div class="panel"><p class="muted">Loading lobby…</p></div>`;

  let session: SessionView | null;
  try {
    session = await api.sessions.active();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    container.innerHTML = `<div class="panel"><p class="muted">Couldn't load the lobby.</p></div>`;
    toast(msg, 'err');
    return;
  }

  if (session && session.status === 'ACTIVE') {
    renderRunActive(container, user, session);
  } else {
    await renderStartRun(container, user);
  }
}

// ─── RUN ACTIVE ─────────────────────────────────────────────────────────────────

function renderRunActive(container: HTMLElement, user: User, session: SessionView): void {
  const cabinetsHtml = CABINETS.map(
    (c) => `
      <button class="panel cabinet-card" type="button" data-game="${escapeHtml(c.game)}">
        <span class="cabinet-card__marquee pixel-h2">${escapeHtml(c.marquee)}</span>
        <span class="cabinet-card__desc">${escapeHtml(c.desc)}</span>
        <span class="cabinet-card__play">PLAY ▸</span>
      </button>`,
  ).join('');

  container.innerHTML = `
    <section class="lobby lobby--active">
      <div class="hud" id="lobby-hud"></div>

      <h2 class="pixel-h1 lobby__title">PICK A CABINET</h2>
      <div class="cabinet-grid">
        ${cabinetsHtml}
      </div>

      <p class="lobby__remaining muted">
        Remaining: <b>${escapeHtml(formatMoney(session.remaining, session.assetCode, session.assetScale))}</b>
      </p>

      <button class="btn btn--pink btn--block" type="button" id="end-run">END RUN</button>
    </section>
  `;

  const hudEl = container.querySelector<HTMLElement>('#lobby-hud')!;
  renderBankroll(hudEl, session);

  container.querySelectorAll<HTMLButtonElement>('.cabinet-card').forEach((card) => {
    card.addEventListener('click', () => {
      window.location.hash = `#/play/${card.dataset.game}`;
    });
  });

  const endBtn = container.querySelector<HTMLButtonElement>('#end-run')!;
  endBtn.addEventListener('click', async () => {
    endBtn.disabled = true;
    endBtn.textContent = 'Ending…';
    try {
      await api.sessions.end(session.id);
      toast('Run ended', 'info');
      await renderLobbyView(container, user);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(msg, 'err');
      endBtn.disabled = false;
      endBtn.textContent = 'END RUN';
    }
  });
}

// ─── START A RUN ────────────────────────────────────────────────────────────────

async function renderStartRun(container: HTMLElement, user: User): Promise<void> {
  if (!user.walletAddress) {
    container.innerHTML = `
      <section class="lobby lobby--start">
        <h2 class="pixel-h1 lobby__title">START A RUN</h2>
        <div class="panel lobby__nowallet">
          <p>You need a wallet address to play.</p>
          <button class="btn btn--cyan btn--block" type="button" id="go-profile">SET WALLET ADDRESS</button>
        </div>
      </section>
    `;
    container.querySelector<HTMLButtonElement>('#go-profile')!.addEventListener('click', () => {
      window.location.hash = '#/profile';
    });
    return;
  }

  let charities: Charity[];
  try {
    charities = await api.charities.list();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    container.innerHTML = `<div class="panel"><p class="muted">Couldn't load charities.</p></div>`;
    toast(msg, 'err');
    return;
  }

  if (!charities.length) {
    container.innerHTML = `
      <section class="lobby lobby--start">
        <h2 class="pixel-h1 lobby__title">START A RUN</h2>
        <div class="panel"><p>No charities available right now. Check back soon.</p></div>
      </section>
    `;
    return;
  }

  let selectedId = charities[0].id;

  const charityCardsHtml = charities
    .map(
      (ch) => `
      <button class="panel charity-card${ch.id === selectedId ? ' is-selected' : ''}" type="button"
              data-charity="${escapeHtml(ch.id)}">
        <span class="charity-card__head">
          <span class="charity-card__dot" style="background:${safeColor(ch.accentColor)}"></span>
          <span class="charity-card__name">${escapeHtml(ch.name)}</span>
          <span class="chip chip--muted">${escapeHtml(ch.category)}</span>
        </span>
        <span class="charity-card__blurb">${escapeHtml(ch.blurb)}</span>
      </button>`,
    )
    .join('');

  container.innerHTML = `
    <section class="lobby lobby--start">
      <h2 class="pixel-h1 lobby__title">START A RUN</h2>

      <p class="pixel-label">PICK YOUR CHARITY</p>
      <div class="charity-grid">
        ${charityCardsHtml}
      </div>

      <div class="field lobby__bankroll">
        <label class="pixel-label" for="bankroll-input">BANKROLL (coins)</label>
        <input class="coin-input" id="bankroll-input" type="number" inputmode="numeric"
               min="1" step="1" value="20" />
        <span class="lobby__hint muted">1 coin = 1.00 of your wallet currency</span>
      </div>

      <button class="btn btn--green btn--lg btn--block" type="button" id="insert-coin">
        🪙 INSERT COIN — START RUN
      </button>

      <p class="lobby__note muted">
        You'll approve a one-time spending limit at your wallet. Each wager is donated
        to your charity from it — no more pop-ups while you play.
      </p>
    </section>
  `;

  const cards = container.querySelectorAll<HTMLButtonElement>('.charity-card');
  cards.forEach((card) => {
    card.addEventListener('click', () => {
      selectedId = card.dataset.charity ?? selectedId;
      cards.forEach((c) => c.classList.toggle('is-selected', c === card));
    });
  });

  const bankrollInput = container.querySelector<HTMLInputElement>('#bankroll-input')!;
  const startBtn = container.querySelector<HTMLButtonElement>('#insert-coin')!;

  startBtn.addEventListener('click', async () => {
    if (!selectedId) {
      toast('Pick a charity first', 'err');
      return;
    }
    // Send the bankroll in MAJOR units (coins) — the backend converts to the
    // wallet's smallest unit once it has resolved the real assetScale.
    const bankroll = Number(bankrollInput.value);
    if (!Number.isFinite(bankroll) || bankroll < 1) {
      toast('Bankroll must be at least 1 coin', 'err');
      return;
    }

    startBtn.disabled = true;
    const originalLabel = startBtn.textContent;
    startBtn.textContent = 'Opening your wallet…';
    try {
      const { interactUrl } = await api.sessions.create({ charityId: selectedId, bankroll });
      window.location.href = interactUrl;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(msg, 'err');
      startBtn.disabled = false;
      startBtn.textContent = originalLabel;
    }
  });
}
