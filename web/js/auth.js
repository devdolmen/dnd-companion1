// Full-screen sign-in / create-account panel. Resolves with the user once signed in.
import { h, clear, button, icon } from './ui.js';
import { post, get } from './api.js';

export function authScreen({ allowSignup = true } = {}) {
  return new Promise((resolve) => {
    let mode = 'login';
    const overlay = h('div', { class: 'auth-screen', id: 'auth-screen' });
    const card = h('div', { class: 'auth-card' });
    overlay.append(card);
    document.body.append(overlay);

    const draw = () => {
      clear(card);
      const user = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', placeholder: 'Username', 'aria-label': 'Username', maxlength: 32 });
      const pass = h('input', { type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', placeholder: 'Password', 'aria-label': 'Password' });
      const pass2 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Repeat password', 'aria-label': 'Repeat password' });
      const err = h('div', { class: 'auth-error', role: 'alert' });
      const submit = button(mode === 'login' ? 'Sign in' : 'Create account', { class: 'btn primary auth-submit', type: 'submit' });
      const form = h('form', { class: 'auth-form', onSubmit: async (e) => {
        e.preventDefault(); err.textContent = '';
        const username = user.value.trim(); const password = pass.value;
        if (!username || !password) { err.textContent = 'Enter a username and password.'; return; }
        if (mode === 'signup') {
          if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) { err.textContent = 'Username: 3–32 letters, digits, dots, dashes or underscores.'; return; }
          if (password.length < 8) { err.textContent = 'Password must be at least 8 characters.'; return; }
          if (password !== pass2.value) { err.textContent = 'Passwords do not match.'; return; }
        }
        submit.disabled = true;
        try {
          const res = await post(mode === 'login' ? '/api/auth/login' : '/api/auth/signup', { username, password });
          overlay.remove(); resolve(res.user);
        } catch (ex) {
          err.textContent = ex.status === 401 ? 'Wrong username or password.' : ex.status === 409 ? 'That username is taken.' : ex.status === 429 ? 'Too many attempts. Wait a minute and try again.' : ex.message;
          submit.disabled = false;
        }
      } },
        h('label', { class: 'field' }, h('span', {}, 'Username'), user),
        h('label', { class: 'field' }, h('span', {}, 'Password'), pass),
        mode === 'signup' ? h('label', { class: 'field' }, h('span', {}, 'Repeat password'), pass2) : null,
        err, submit);
      card.append(
        h('div', { class: 'auth-logo' }, icon('book', 28), h('h1', {}, 'Tome & Table')),
        h('p', { class: 'muted' }, mode === 'login' ? 'Sign in to open your characters and notes.' : 'Create an account. Your data stays on this server.'),
        form,
        allowSignup ? h('p', { class: 'auth-switch' }, mode === 'login' ? 'New here? ' : 'Already have an account? ',
          h('a', { href: '#', onClick: (e) => { e.preventDefault(); mode = mode === 'login' ? 'signup' : 'login'; draw(); } }, mode === 'login' ? 'Create an account' : 'Sign in')) : null,
      );
      setTimeout(() => user.focus(), 30);
    };
    draw();
  });
}

// Returns the current user or null (401) without throwing on unauthenticated.
export async function whoAmI() {
  try { const r = await get('/api/auth/me'); return r.user; } catch (e) { if (e.status === 401) return null; throw e; }
}
