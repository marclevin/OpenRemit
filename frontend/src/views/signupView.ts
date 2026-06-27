import { api } from '../api';
import { setToken } from '../auth';

export function renderSignupView(container: HTMLElement): void {
  container.innerHTML = `
    <div class="card">
      <h2>Create account</h2>
      <form id="signup-form" novalidate>
        <div class="field">
          <label for="signup-name">Display name</label>
          <input id="signup-name" name="displayName" type="text" class="input" required autocomplete="name" />
        </div>
        <div class="field">
          <label for="signup-email">Email</label>
          <input id="signup-email" name="email" type="email" class="input" required autocomplete="email" />
        </div>
        <div class="field">
          <label for="signup-password">Password</label>
          <input id="signup-password" name="password" type="password" class="input" required autocomplete="new-password" />
        </div>
        <div id="signup-error" class="error-msg" hidden></div>
        <button type="submit" class="btn btn-primary" id="signup-btn">Create account</button>
      </form>
      <p class="auth-switch">Already have an account? <a href="#/login">Log in</a></p>
    </div>
  `;

  const form   = container.querySelector<HTMLFormElement>('#signup-form')!;
  const btn    = container.querySelector<HTMLButtonElement>('#signup-btn')!;
  const errDiv = container.querySelector<HTMLDivElement>('#signup-error')!;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled    = true;
    btn.textContent = 'Creating account…';
    errDiv.hidden   = true;

    try {
      const data   = new FormData(form);
      const result = await api.auth.signup({
        displayName: (data.get('displayName') as string).trim(),
        email:       (data.get('email')       as string).trim(),
        password:     data.get('password')    as string,
      });
      setToken(result.token);
      // One-time flag: the first time this new member opens the Relief Fund,
      // their home drops into the village as a welcome. Cleared on first view.
      localStorage.setItem('fireline:welcome', '1');
      window.location.hash = '#/claims';
    } catch (err: unknown) {
      const msg          = err instanceof Error ? err.message : String(err);
      errDiv.textContent = msg;
      errDiv.hidden      = false;
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Create account';
    }
  });
}
