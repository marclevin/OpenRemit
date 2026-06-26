import { api } from '../api';
import { setToken } from '../auth';

export function renderLoginView(container: HTMLElement): void {
  container.innerHTML = `
    <div class="card">
      <h2>Log in</h2>
      <form id="login-form" novalidate>
        <div class="field">
          <label for="login-email">Email</label>
          <input id="login-email" name="email" type="email" class="input" required autocomplete="email" />
        </div>
        <div class="field">
          <label for="login-password">Password</label>
          <input id="login-password" name="password" type="password" class="input" required autocomplete="current-password" />
        </div>
        <div id="login-error" class="error-msg" hidden></div>
        <button type="submit" class="btn btn-primary" id="login-btn">Log in</button>
      </form>
      <p class="auth-switch">No account? <a href="#/signup">Sign up</a></p>
    </div>
  `;

  const form   = container.querySelector<HTMLFormElement>('#login-form')!;
  const btn    = container.querySelector<HTMLButtonElement>('#login-btn')!;
  const errDiv = container.querySelector<HTMLDivElement>('#login-error')!;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled    = true;
    btn.textContent = 'Logging in…';
    errDiv.hidden   = true;

    try {
      const data   = new FormData(form);
      const result = await api.auth.login({
        email:    (data.get('email')    as string).trim(),
        password:  data.get('password') as string,
      });
      setToken(result.token);
      window.location.hash = '#/claims';
    } catch (err: unknown) {
      const msg          = err instanceof Error ? err.message : String(err);
      errDiv.textContent = msg;
      errDiv.hidden      = false;
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Log in';
    }
  });
}
