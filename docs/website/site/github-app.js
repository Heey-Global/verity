/* global URL, document, window, history */
const HOME = 'https://verity.build';
const PERMISSIONS = /* manifest-permissions */ {"actions":"write","checks":"read","contents":"write","issues":"write","metadata":"read","organization_projects":"write","packages":"read","pull_requests":"write","workflows":"write"};

function validCallback(value, phase) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && url.hostname === 'verity.build' &&
    url.pathname === '/github/app/callback' && url.searchParams.get('phase') === phase &&
    ['/github-connect', '/onboarding/github'].includes(url.searchParams.get('returnTo')) &&
    url.searchParams.size === 2;
}

function validAction(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.hash !== '') return false;
  const personal = url.pathname === '/settings/apps/new';
  const organization = /^\/organizations\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/settings\/apps\/new$/.test(url.pathname);
  return (personal || organization) && url.searchParams.size === 1 && Boolean(url.searchParams.get('state'));
}

function validManifest(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value;
  return /^Verity-[a-z0-9]{8}$/.test(manifest.name) &&
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
  if (payload === null || typeof payload !== 'object' || !validAction(payload.action) || !validManifest(payload.manifest)) {
    throw new Error('invalid launch request');
  }
  return payload;
}

if (typeof document !== 'undefined') {
  const status = document.querySelector('#status');
  const form = document.querySelector('#github-form');
  const input = document.querySelector('#manifest');
  try {
    const payload = parseLaunchFragment(window.location.hash);
    history.replaceState(null, '', window.location.pathname);
    form.action = payload.action;
    input.value = JSON.stringify(payload.manifest);
    form.hidden = false;
    status.textContent = 'Your request is ready. Continue to GitHub to choose the account and repositories.';
    form.requestSubmit();
  } catch {
    status.textContent = 'This link is invalid or expired. Return to the Verity app and try again.';
  }
}
