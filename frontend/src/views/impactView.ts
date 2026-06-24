import { api, User, ImpactResponse, Game } from '../api';
import { toast } from '../lib/arcade';
import { barsH, stackBar, areaChart, donut, NEON, ChartRow } from '../lib/charts';
import { formatAmount } from '../money';
import { escapeHtml } from '../escape';

// Impact amounts are mixed-asset totals shown in coin units (testnet 2-dp).
const SCALE = 2;
const coins = (n: number): string => formatAmount(n, SCALE);

// Each cabinet gets its own neon hue on the plays chart.
const GAME_COLOR: Record<Game, string> = {
  ROCKET: NEON.pink,
  PLANE: NEON.cyan,
  PACHINKO: NEON.gold,
};

/**
 * IMPACT board — an arcade "HIGH SCORES" screen. A hero give-back number up top,
 * then a wall of neon charts (giving over time, where it went, top charities,
 * plays by cabinet) and finally personal stats, with PLAY / SPONSOR CTAs.
 */
export async function renderImpactView(container: HTMLElement, user: User): Promise<void> {
  void user;
  container.innerHTML = `<div class="panel"><p class="muted">Loading impact board…</p></div>`;

  let d: ImpactResponse;
  try {
    d = await api.impact.get();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    container.innerHTML = `<div class="panel"><p class="muted">Couldn't load the impact board.</p></div>`;
    toast(msg, 'err');
    return;
  }

  const givenTotal = d.global.totalDonated + d.global.totalMatched;
  const winRate = d.personal.plays ? Math.round((100 * d.personal.wins) / d.personal.plays) : 0;
  const youGiven = d.personal.totalDonated + d.personal.totalMatched;
  const yourShare = givenTotal ? Math.round((100 * youGiven) / givenTotal) : 0;

  // Cumulative giving for the always-up-and-to-the-right area chart.
  let running = 0;
  const cumulative = d.timeline.map((t) => (running += t.total));

  // Where the money came from: player wagers vs sponsor matches.
  const splitRows: ChartRow[] = [
    { label: 'PLAYER WAGERS', value: d.global.totalDonated, color: NEON.green },
    { label: 'SPONSOR MATCH', value: d.global.totalMatched, color: NEON.cyan },
  ];

  const charityRows: ChartRow[] = d.topCharities.map((c) => ({
    label: c.name,
    value: c.total,
    color: c.accentColor,
  }));

  const gameRows: ChartRow[] = d.byGame.map((g) => ({
    label: g.game,
    value: g.plays,
    color: GAME_COLOR[g.game] ?? NEON.violet,
  }));

  container.innerHTML = `
    <section class="impact">
      <h2 class="pixel-h1 impact__title">HIGH SCORES</h2>

      <div class="impact__hero">
        <p class="impact__hero-label pixel-label">TOGETHER WE'VE GIVEN</p>
        <span class="impact__headline-num">${escapeHtml(coins(givenTotal))}</span>
        <p class="impact__hero-label pixel-label">TO CHARITY · ${escapeHtml(String(d.global.charitiesHelped))} CAUSES · ${escapeHtml(String(d.global.plays))} PLAYS</p>
      </div>

      <div class="impact__charts">
        <div class="chart-card chart-card--wide">
          <h3 class="chart-card__title">GIVING OVER TIME</h3>
          ${areaChart(cumulative, { id: 'impact-spark', stroke: NEON.green })}
          <p class="chart-card__foot">Cumulative donated + matched · last ${escapeHtml(String(d.timeline.length))} days</p>
        </div>

        <div class="chart-card">
          <h3 class="chart-card__title">WHERE IT CAME FROM</h3>
          ${stackBar(splitRows, coins)}
        </div>

        <div class="chart-card">
          <h3 class="chart-card__title">PLAYS BY CABINET</h3>
          ${barsH(gameRows)}
        </div>

        <div class="chart-card chart-card--wide">
          <h3 class="chart-card__title">TOP CHARITIES</h3>
          ${barsH(charityRows, coins)}
        </div>
      </div>

      <h3 class="pixel-h2 impact__subtitle">YOU</h3>
      <div class="impact__you">
        ${donut(winRate, { caption: 'WIN RATE', color: NEON.green })}
        <div class="stat-grid impact__personal">
          <div class="stat">
            <span class="stat__num">${escapeHtml(coins(youGiven))}</span>
            <span class="stat__label">YOU'VE GIVEN</span>
          </div>
          <div class="stat">
            <span class="stat__num">${escapeHtml(String(d.personal.plays))}</span>
            <span class="stat__label">YOUR PLAYS</span>
          </div>
          <div class="stat">
            <span class="stat__num">${escapeHtml(String(d.personal.wins))}</span>
            <span class="stat__label">YOUR WINS</span>
          </div>
          <div class="stat">
            <span class="stat__num">${yourShare}%</span>
            <span class="stat__label">OF ALL GIVING</span>
          </div>
        </div>
      </div>

      <div class="impact__cta">
        <button class="btn btn--green btn--lg btn--block" type="button" id="impact-play">PLAY</button>
        <button class="btn btn--cyan btn--lg btn--block" type="button" id="impact-sponsor">SPONSOR</button>
      </div>
    </section>
  `;

  container.querySelector<HTMLButtonElement>('#impact-play')!.addEventListener('click', () => {
    window.location.hash = '#/play';
  });
  container.querySelector<HTMLButtonElement>('#impact-sponsor')!.addEventListener('click', () => {
    window.location.hash = '#/sponsor';
  });
}
