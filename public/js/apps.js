// Settings → Platform apps: paste each platform's developer-app credentials (stored encrypted).
import { h, mount, api, toast, confirmDialog, PROVIDER_META } from './core.js';
import { relTime } from './composer.js';

const BADGE = {
  configured: ['Configured', 's-published'],
  configured_env: ['Configured via .env', 's-scheduled'],
  not_configured: ['Not configured', 's-failed'],
};
const COLORS = { meta: PROVIDER_META.facebook.color, instagram: PROVIDER_META['instagram-standalone'].color, google: PROVIDER_META.youtube.color };

function copyBtn(text) {
  return h('button', { class: 'btn small ghost', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(text); toast('Copied', 'success'); } catch { toast('Copy failed — select the text manually', 'error'); }
  } }, 'Copy');
}

function testLine(t) {
  if (!t) return null;
  const cls = t.ok ? (t.verified ? 'ok' : 'warn') : 'err';
  return h('div', { class: `small ${cls} app-test` }, `${t.ok ? (t.verified ? '✔' : '•') : '✖'} ${t.message}`, t.at ? h('span', { class: 'muted' }, ` · tested ${relTime(t.at)}`) : null);
}

function appCard(a, refresh) {
  const [badgeText, badgeCls] = BADGE[a.status];
  const idIn = h('input', { class: 'input', autocomplete: 'off', spellcheck: 'false', placeholder: a.id_hint });
  idIn.value = a.saved_in_app ? a.client_id : '';
  const secretIn = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', spellcheck: 'false',
    placeholder: a.saved_in_app ? `saved • ${a.secret_hint} (leave empty to keep)` : a.status === 'configured_env' ? `from .env • ${a.secret_hint}` : 'paste secret' });
  const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (e) { toast(e.message, 'error', 7000); } finally { btn.disabled = false; } };

  return h('div', { class: 'card app-card', id: `app-${a.app}`, style: { '--pc': COLORS[a.app] } },
    h('div', { class: 'row between wrap' }, h('h3', {}, a.label), h('span', { class: `status ${badgeCls}` }, badgeText)),
    a.status === 'configured_env' ? h('p', { class: 'muted small' }, `Using ${a.env_vars.join(' / ')} from .env (${a.client_id}). Saving here overrides .env; Clear returns to it.`) : null,
    a.saved_in_app && a.env_fallback ? h('p', { class: 'muted small' }, 'Overrides the .env values. Clear to fall back to .env.') : null,
    h('div', { class: 'app-form' },
      h('label', { class: 'field' }, h('span', {}, a.id_label), idIn),
      h('label', { class: 'field' }, h('span', {}, a.secret_label), secretIn,
        a.secret_saved ? h('span', { class: 'muted small' }, `${a.saved_in_app ? 'saved' : '.env'} • ${a.secret_hint}`) : null),
      h('div', { class: 'row gap wrap' },
        h('button', { class: 'btn primary', onclick: (e) => busy(e.target, async () => {
          const body = { client_id: idIn.value.trim() };
          if (secretIn.value.trim()) body.client_secret = secretIn.value.trim();
          await api('POST', `/platform-apps/${a.app}`, body);
          secretIn.value = '';
          toast('Saved — active immediately', 'success');
          refresh(a.app);
        }) }, 'Save'),
        h('button', { class: 'btn', disabled: !a.configured, onclick: (e) => busy(e.target, async () => {
          const r = await api('POST', `/platform-apps/${a.app}/test`, {});
          toast(r.result.message, r.result.ok ? 'success' : 'error', 7000);
          refresh(a.app);
        }) }, 'Test'),
        a.saved_in_app ? h('button', { class: 'btn ghost danger', onclick: (e) => busy(e.target, async () => {
          if (!(await confirmDialog(`Remove the ${a.label} credentials saved in postlite?${a.env_fallback ? ' The .env values will be used again.' : ' Connecting and token refresh will stop working until new credentials are saved.'}`, { ok: 'Clear', danger: true }))) return;
          await api('DELETE', `/platform-apps/${a.app}`);
          toast('Cleared');
          refresh(a.app);
        }) }, 'Clear') : null,
        h('a', { class: 'btn ghost', href: a.guide, target: '_blank', rel: 'noopener' }, 'Full guide ↗')),
      testLine(a.last_test)),
    h('div', { class: 'label' }, a.redirect_uris.length > 1 ? 'Redirect URIs (register all)' : 'Redirect URI'),
    a.redirect_uris.map((u) => h('div', { class: 'copy-row' }, h('code', { class: 'block select' }, u.uri), copyBtn(u.uri), h('span', { class: 'muted small' }, u.label))),
    h('details', { class: 'small app-details', open: a.status === 'not_configured' },
      h('summary', {}, 'Setup checklist, products, APIs & scopes'),
      h('ol', { class: 'steps' }, a.steps.map((s) => h('li', {}, s))),
      h('div', { class: 'label' }, 'Products / configuration'), h('ul', {}, a.products.map((p) => h('li', {}, p))),
      h('div', { class: 'label' }, 'APIs'), h('ul', {}, a.apis.map((p) => h('li', {}, p))),
      h('div', { class: 'label' }, 'Scopes / permissions'), h('div', { class: 'scope-chips' }, a.scopes.map((s) => h('code', { class: 'scope-chip' }, s))),
      h('div', { class: 'label' }, 'Links'), h('ul', {}, Object.entries(a.links).map(([t, u]) => h('li', {}, h('a', { href: u, target: '_blank', rel: 'noopener' }, t, ' ↗'))),
        h('li', {}, h('a', { href: a.guide, target: '_blank', rel: 'noopener' }, 'Full step-by-step guide ↗')))));
}

export async function renderPlatformApps(root, focus = null) {
  const { platform_apps: apps } = await api('GET', '/platform-apps');
  const refresh = (f) => renderPlatformApps(root, f);
  mount(root,
    h('p', { class: 'muted' }, 'Paste the credentials of your own developer apps. Secrets are encrypted with TOKEN_ENC_KEY, never shown again, and take effect immediately — no restart. Values saved here override .env. ',
      h('a', { href: '/docs/setup/', target: '_blank', rel: 'noopener' }, 'Setup guides ↗')),
    h('div', { class: 'apps-grid' }, apps.map((a) => appCard(a, refresh))));
  if (focus) {
    const el = root.querySelector(`#app-${CSS.escape(focus)}`);
    if (el) { el.classList.add('focus'); requestAnimationFrame(() => el.scrollIntoView({ block: 'start' })); }
  }
}
