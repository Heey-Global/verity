/* global URL, document, window, history */
const HOME = 'https://verity.build';
const PERMISSIONS = /* manifest-permissions */ {"actions":"write","checks":"read","contents":"write","issues":"write","metadata":"read","organization_projects":"write","packages":"read","pull_requests":"write","workflows":"write"};

function hasExactKeys(value, keys) {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validCallback(value, phase) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && url.hostname === 'verity.build' &&
    url.pathname === '/github/app/callback' && url.searchParams.get('phase') === phase &&
    ['/github-connect', '/onboarding/github'].includes(url.searchParams.get('returnTo')) &&
    Array.from(url.searchParams).length === 2;
}

function validState(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(value);
}

function validManifest(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value;
  return hasExactKeys(manifest, ['name', 'url', 'hook_attributes', 'redirect_url', 'setup_url', 'setup_on_update', 'public', 'default_permissions', 'default_events']) &&
    manifest.hook_attributes !== null && typeof manifest.hook_attributes === 'object' &&
    hasExactKeys(manifest.hook_attributes, ['url', 'active']) &&
    /^Verity-[a-z0-9]{8}$/.test(manifest.name) &&
    manifest.url === HOME && validCallback(manifest.redirect_url, 'created') &&
    validCallback(manifest.setup_url, 'installed') &&
    manifest.public === false && manifest.setup_on_update === false &&
    Array.isArray(manifest.default_events) && manifest.default_events.length === 0 &&
    manifest.hook_attributes?.url === `${HOME}/github/webhook` &&
    manifest.hook_attributes?.active === false &&
    JSON.stringify(Object.fromEntries(Object.entries(manifest.default_permissions ?? {}).sort())) ===
      JSON.stringify(PERMISSIONS);
}

export function parseLaunchFragment(hash) {
  if (!hash.startsWith('#') || hash.length > 12_000) throw new Error('invalid launch request');
  let payload;
  try { payload = JSON.parse(decodeURIComponent(hash.slice(1))); } catch { throw new Error('invalid launch request'); }
  if (payload === null || typeof payload !== 'object' || !validState(payload.state) || !validManifest(payload.manifest)) {
    throw new Error('invalid launch request');
  }
  return payload;
}

if (typeof document !== 'undefined') {
  const status = document.querySelector('#status');
  const form = document.querySelector('#github-form');
  const state = document.querySelector('#state');
  const input = document.querySelector('#manifest');
  try {
    const payload = parseLaunchFragment(window.location.hash);
    history.replaceState(null, '', window.location.pathname);
    state.value = payload.state;
    input.value = JSON.stringify(payload.manifest);
    form.hidden = false;
    status.textContent = 'Your request is ready. Continue to GitHub to choose the account and repositories.';
    form.requestSubmit();
  } catch {
    status.textContent = 'This link is invalid or expired. Return to the Verity app and try again.';
  }
}
