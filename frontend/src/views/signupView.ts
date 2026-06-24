import { api, Role } from '../api';
import { setToken } from '../auth';
import { toast } from '../lib/arcade';

export function renderSignupView(container: HTMLElement): void {
  container.innerHTML = `
    <div class="panel signup-panel">
      <h1 class="pixel-h2 auth-title">NEW PLAYER</h1>
      <p class="auth-sub">Pick your side and join the arcade.</p>

      <form id="signup-form" novalidate>
        <div class="field">
          <label class="pixel-label" for="signup-name">Display name</label>
          <input id="signup-name" name="displayName" type="text" class="coin-input" required autocomplete="name" />
        </div>
        <div class="field">
          <label class="pixel-label" for="signup-email">Email</label>
          <input id="signup-email" name="email" type="email" class="coin-input" required autocomplete="email" />
        </div>
        <div class="field">
          <label class="pixel-label" for="signup-password">Password</label>
          <input id="signup-password" name="password" type="password" class="coin-input" required autocomplete="new-password" />
        </div>

        <div class="field">
          <label class="pixel-label">Choose your role</label>
          <div class="role-toggle" role="radiogroup" aria-label="Account role">
            <button type="button" class="btn btn--ghost role-option is-selected" data-role="PLAYER" aria-pressed="true">
              <span class="role-option__icon" aria-hidden="true">🎮</span>
              <span class="role-option__label">PLAYER</span>
            </button>
            <button type="button" class="btn btn--ghost role-option" data-role="SPONSOR" aria-pressed="false">
              <span class="role-option__icon" aria-hidden="true">💚</span>
              <span class="role-option__label">SPONSOR</span>
            </button>
          </div>
        </div>

        <div id="signup-error" class="chip chip--pink auth-error" hidden></div>

        <button type="submit" class="btn btn--green btn--lg btn--block" id="signup-btn">INSERT COIN ▸ SIGN UP</button>
      </form>

      <p class="auth-switch">Already have an account? <a href="#/login">Log in ▸</a></p>
    </div>
  `;

  const form    = container.querySelector<HTMLFormElement>('#signup-form')!;
  const btn     = container.querySelector<HTMLButtonElement>('#signup-btn')!;
  const errDiv  = container.querySelector<HTMLDivElement>('#signup-error')!;
  const options = Array.from(container.querySelectorAll<HTMLButtonElement>('.role-option'));

  let role: Role = 'PLAYER';

  for (const option of options) {
    option.addEventListener('click', () => {
      role = (option.dataset.role as Role) ?? 'PLAYER';
      for (const o of options) {
        const selected = o === option;
        o.classList.toggle('is-selected', selected);
        o.setAttribute('aria-pressed', String(selected));
      }
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled    = true;
    btn.textContent = 'LOADING…';
    errDiv.hidden   = true;

    try {
      const data = new FormData(form);
      const { token, user } = await api.auth.signup({
        displayName: (data.get('displayName') as string).trim(),
        email:       (data.get('email')       as string).trim(),
        password:     data.get('password')    as string,
        role,
      });
      setToken(token);
      toast('Set your wallet address in Profile to start', 'info');
      window.location.hash = user.role === 'SPONSOR' ? '#/sponsor' : '#/play';
    } catch (err: unknown) {
      const msg          = err instanceof Error ? err.message : String(err);
      errDiv.textContent = msg;
      errDiv.hidden      = false;
    } finally {
      btn.disabled    = false;
      btn.textContent = 'INSERT COIN ▸ SIGN UP';
    }
  });
}
