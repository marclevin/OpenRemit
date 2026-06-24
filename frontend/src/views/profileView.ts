import { api, Role, User } from '../api';
import { clearToken } from '../auth';
import { escapeHtml } from '../escape';
import { avatarHtml } from '../avatar';
import { toPointer } from '../pointer';
import { toast } from '../lib/arcade';

// Avatar payloads are sent inline as base64 data URLs. Keep them small so the
// JSON body stays reasonable — warn the user past ~200KB.
const AVATAR_MAX_BYTES = 200 * 1024;

type UpdateBody = Partial<{
  displayName: string;
  email: string;
  password: string;
  walletAddress: string;
  avatar: string | null;
  role: Role;
}>;

export function renderProfileView(container: HTMLElement, user: User): void {
  const walletPointer = user.walletAddress ? toPointer(user.walletAddress) : '';
  const walletMissing = !user.walletAddress;

  container.innerHTML = `
    <div class="panel profile-panel">
      <div class="profile-head">
        <div id="avatar-preview" class="profile-avatar-wrap">
          ${avatarHtml(user, 'profile-avatar')}
        </div>
        <div>
          <h1 class="pixel-h2 profile-name">${escapeHtml(user.displayName)}</h1>
          <span class="muted">${escapeHtml(user.email)}</span>
        </div>
      </div>

      ${walletMissing ? `
        <div class="panel panel--inset wallet-warning">
          <span class="chip chip--pink">NO WALLET</span>
          <p>Set your wallet address below — <b>required to play or sponsor</b>.</p>
        </div>` : ''}

      <form id="profile-form" class="profile-form" novalidate>
        <div class="field">
          <label class="pixel-label" for="p-name">Display name</label>
          <input id="p-name" name="displayName" type="text" class="coin-input"
            value="${escapeHtml(user.displayName)}" autocomplete="name" />
        </div>
        <div class="field">
          <label class="pixel-label" for="p-email">Email</label>
          <input id="p-email" name="email" type="email" class="coin-input"
            value="${escapeHtml(user.email)}" autocomplete="email" />
        </div>
        <div class="field">
          <label class="pixel-label" for="p-password">New password <span class="muted">(blank = unchanged)</span></label>
          <input id="p-password" name="password" type="password" class="coin-input" autocomplete="new-password" />
        </div>
        <div class="field">
          <label class="pixel-label" for="p-wallet">Wallet address <span class="muted">(required to play or sponsor)</span></label>
          <input id="p-wallet" name="walletAddress" type="text" class="coin-input"
            placeholder="$ilp.interledger-test.dev/your-handle"
            value="${escapeHtml(walletPointer)}" />
        </div>
        <div class="field">
          <label class="pixel-label" for="p-avatar">Avatar</label>
          <input id="p-avatar" name="avatar" type="file" accept="image/*" class="coin-input" />
        </div>

        <div class="field">
          <label class="pixel-label">Role</label>
          <div class="role-toggle" role="radiogroup" aria-label="Account role">
            <button type="button" class="btn btn--ghost role-option" data-role="PLAYER" aria-pressed="false">
              <span class="role-option__icon" aria-hidden="true">🎮</span>
              <span class="role-option__label">PLAYER</span>
            </button>
            <button type="button" class="btn btn--ghost role-option" data-role="SPONSOR" aria-pressed="false">
              <span class="role-option__icon" aria-hidden="true">💚</span>
              <span class="role-option__label">SPONSOR</span>
            </button>
          </div>
        </div>

        <div id="profile-error" class="chip chip--pink auth-error" hidden></div>

        <button type="submit" class="btn btn--green btn--lg btn--block" id="profile-btn">SAVE</button>
      </form>

      <hr class="profile-divider" />

      <button id="logout-btn" class="btn btn--pink btn--block">LOG OUT 🚪</button>
    </div>
  `;

  // ── Role toggle (default to the user's current role) ──
  let role: Role = user.role;
  const options = Array.from(container.querySelectorAll<HTMLButtonElement>('.role-option'));
  const paintRole = (): void => {
    for (const o of options) {
      const selected = o.dataset.role === role;
      o.classList.toggle('is-selected', selected);
      o.setAttribute('aria-pressed', String(selected));
    }
  };
  for (const option of options) {
    option.addEventListener('click', () => {
      role = (option.dataset.role as Role) ?? user.role;
      paintRole();
    });
  }
  paintRole();

  // ── Avatar preview + capture ──
  const avatarInput = container.querySelector<HTMLInputElement>('#p-avatar')!;
  const avatarWrap  = container.querySelector<HTMLDivElement>('#avatar-preview')!;
  let avatarData: string | null = null;
  let avatarTooLarge = false;

  avatarInput.addEventListener('change', () => {
    const file = avatarInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const src = e.target?.result as string;
      avatarData = src;
      avatarTooLarge = src.length > AVATAR_MAX_BYTES;
      if (avatarTooLarge) toast('Image is large (>200KB) — it may be rejected', 'err');
      avatarWrap.innerHTML = `<img class="profile-avatar" src="${escapeHtml(src)}" alt="avatar preview" />`;
    };
    reader.readAsDataURL(file);
  });

  // ── Save ──
  const form   = container.querySelector<HTMLFormElement>('#profile-form')!;
  const btn    = container.querySelector<HTMLButtonElement>('#profile-btn')!;
  const errDiv = container.querySelector<HTMLDivElement>('#profile-error')!;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled    = true;
    btn.textContent = 'SAVING…';
    errDiv.hidden   = true;

    const displayName = (form.querySelector<HTMLInputElement>('#p-name')!.value).trim();
    const email       = (form.querySelector<HTMLInputElement>('#p-email')!.value).trim();
    const password    =  form.querySelector<HTMLInputElement>('#p-password')!.value;
    const wallet      = (form.querySelector<HTMLInputElement>('#p-wallet')!.value).trim();

    // Build the body explicitly (no conditional spreads) — only send changed
    // or meaningful fields. Wallet is always sent as the raw value entered.
    const body: UpdateBody = {};
    if (displayName && displayName !== user.displayName) body.displayName = displayName;
    if (email && email !== user.email)                   body.email = email;
    if (password)                                        body.password = password;
    body.walletAddress = wallet;
    if (role !== user.role)                              body.role = role;
    if (avatarData)                                      body.avatar = avatarData;

    try {
      const updated = await api.auth.update(body);
      container.querySelector<HTMLElement>('.profile-name')!.textContent = updated.displayName;
      toast('Profile saved', 'win');
    } catch (err: unknown) {
      const msg          = err instanceof Error ? err.message : String(err);
      errDiv.textContent = msg;
      errDiv.hidden      = false;
    } finally {
      btn.disabled    = false;
      btn.textContent = 'SAVE';
    }
  });

  // ── Logout ──
  container.querySelector<HTMLButtonElement>('#logout-btn')!.addEventListener('click', () => {
    clearToken();
    window.location.hash = '#/';
  });
}
