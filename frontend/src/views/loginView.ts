import { api } from '../api';
import { setToken } from '../auth';

export function renderLoginView(container: HTMLElement): void {
  container.innerHTML = `
    <div class="panel login-panel">
      <h1 class="pixel-h2 auth-title">LOG IN</h1>
      <p class="auth-sub">Insert your credentials to continue.</p>

      <form id="login-form" novalidate>
        <div class="field">
          <label class="pixel-label" for="login-email">Email</label>
          <input id="login-email" name="email" type="email" class="coin-input" required autocomplete="email" />
        </div>
        <div class="field">
          <label class="pixel-label" for="login-password">Password</label>
          <input id="login-password" name="password" type="password" class="coin-input" required autocomplete="current-password" />
        </div>

        <div id="login-error" class="chip chip--pink auth-error" hidden></div>

        <button type="submit" class="btn btn--green btn--lg btn--block" id="login-btn">LOG IN</button>
      </form>

      <p class="auth-switch">No account? <a href="#/signup">Sign up ▸</a></p>
    </div>
  `;

  const form   = container.querySelector<HTMLFormElement>('#login-form')!;
  const btn    = container.querySelector<HTMLButtonElement>('#login-btn')!;
  const errDiv = container.querySelector<HTMLDivElement>('#login-error')!;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled    = true;
    btn.textContent = 'LOADING…';
    errDiv.hidden   = true;

    try {
      const data = new FormData(form);
      const { token, user } = await api.auth.login({
        email:    (data.get('email')    as string).trim(),
        password:  data.get('password') as string,
      });
      setToken(token);
      window.location.hash = user.role === 'SPONSOR' ? '#/sponsor' : '#/play';
    } catch (err: unknown) {
      const msg          = err instanceof Error ? err.message : String(err);
      errDiv.textContent = msg;
      errDiv.hidden      = false;
    } finally {
      btn.disabled    = false;
      btn.textContent = 'LOG IN';
    }
  });
}
