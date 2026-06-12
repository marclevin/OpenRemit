import { api, User } from '../api';
import { clearToken } from '../auth';
import { escapeHtml } from '../escape';
import { presetRecipient } from './quoteView';

export async function renderProfileView(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="card"><p class="muted">Loading profile…</p></div>`;

  let user: User;

  try {
    user = await api.auth.me();
  } catch {
    container.innerHTML = `<div class="card"><p class="error-msg">Failed to load profile.</p></div>`;
    return;
  }

  container.innerHTML = `
    <div class="card profile-card">
      <div class="profile-header">
        <div class="avatar-wrap">
          <img id="avatar-preview" class="profile-avatar"
            src="${escapeHtml(user.avatar ?? '')}"
            alt="avatar"
            style="${user.avatar ? '' : 'display:none'}"
          />
          <div id="avatar-placeholder" class="avatar-placeholder" style="${user.avatar ? 'display:none' : ''}">
            ${escapeHtml(user.displayName.charAt(0).toUpperCase())}
          </div>
        </div>
        <div>
          <h2 id="profile-name-display">${escapeHtml(user.displayName)}</h2>
          <span class="muted">${escapeHtml(user.email)}</span>
        </div>
      </div>

      <form id="profile-form" novalidate>
        <div class="field">
          <label for="p-name">Display name</label>
          <input id="p-name" name="displayName" type="text" class="input" value="${escapeHtml(user.displayName)}" />
        </div>
        <div class="field">
          <label for="p-email">Email</label>
          <input id="p-email" name="email" type="email" class="input" value="${escapeHtml(user.email)}" />
        </div>
        <div class="field">
          <label for="p-wallet">Wallet address</label>
          <input id="p-wallet" name="walletAddress" type="text" class="input"
            placeholder="$ilp.interledger-test.dev/your-handle"
            value="${escapeHtml(user.walletAddress ?? '')}" />
        </div>
        <div class="field">
          <label for="p-password">New password <span class="muted">(leave blank to keep current)</span></label>
          <input id="p-password" name="password" type="password" class="input" autocomplete="new-password" />
        </div>
        <div class="field">
          <label for="p-avatar">Profile picture</label>
          <input id="p-avatar" name="avatar" type="file" accept="image/*" class="input" />
        </div>
        <div id="profile-error"   class="error-msg"     hidden></div>
        <div id="profile-success" class="success-msg"   hidden>Saved!</div>
        <button type="submit" class="btn btn-primary" id="profile-btn">Save changes</button>
      </form>

      <hr class="divider" />

      <button id="logout-btn" class="btn-logout">Log out</button>
    </div>
  `;

  // Avatar preview
  const avatarInput   = container.querySelector<HTMLInputElement>('#p-avatar')!;
  const avatarPreview = container.querySelector<HTMLImageElement>('#avatar-preview')!;
  const avatarPH      = container.querySelector<HTMLDivElement>('#avatar-placeholder')!;

  avatarInput.addEventListener('change', () => {
    const file = avatarInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const src = e.target?.result as string;
      avatarPreview.src          = src;
      avatarPreview.style.display = '';
      avatarPH.style.display      = 'none';
    };
    reader.readAsDataURL(file);
  });

  // Profile form
  const form       = container.querySelector<HTMLFormElement>('#profile-form')!;
  const btn        = container.querySelector<HTMLButtonElement>('#profile-btn')!;
  const errDiv     = container.querySelector<HTMLDivElement>('#profile-error')!;
  const successDiv = container.querySelector<HTMLDivElement>('#profile-success')!;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled    = true;
    btn.textContent = 'Saving…';
    errDiv.hidden   = true;
    successDiv.hidden = true;

    try {
      const data: Record<string, string | undefined> = {
        displayName:   (form.querySelector<HTMLInputElement>('#p-name')!.value).trim()   || undefined,
        email:         (form.querySelector<HTMLInputElement>('#p-email')!.value).trim()  || undefined,
        walletAddress: (form.querySelector<HTMLInputElement>('#p-wallet')!.value).trim() || '',
        password:       form.querySelector<HTMLInputElement>('#p-password')!.value       || undefined,
      };

      const file = avatarInput.files?.[0];
      if (file) {
        const b64 = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload  = () => resolve(r.result as string);
          r.onerror = reject;
          r.readAsDataURL(file);
        });
        (data as Record<string, string | undefined>)['avatar'] = b64;
      }

      const updated = await api.auth.update(data as Parameters<typeof api.auth.update>[0]);
      container.querySelector<HTMLElement>('#profile-name-display')!.textContent = updated.displayName;
      successDiv.hidden = false;
    } catch (err: unknown) {
      const msg          = err instanceof Error ? err.message : String(err);
      errDiv.textContent = msg;
      errDiv.hidden      = false;
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Save changes';
    }
  });

  // Logout
  container.querySelector('#logout-btn')!.addEventListener('click', () => {
    clearToken();
    presetRecipient(null); // don't leak the selection into the next session
    window.location.hash = '#/';
  });
}
