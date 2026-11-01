/* global URLSearchParams, window, document */
// This bridge never contacts an API or chooses a destination supplied by the caller.
export function mcpAppReturnUrl(search) {
  const input = new URLSearchParams(search);
  const state = input.get('state');
  const code = input.get('code');
  const error = input.get('error');
  if (!state || !/^(?:staging\.)?[A-Za-z0-9_-]{43}$/.test(state)) return null;
  if ((!code && !error) || (code && code.length > 8192) || (error && error.length > 256)) return null;
  const scheme = state.startsWith('staging.') ? 'verity-staging' : 'verity';
  const query = new URLSearchParams({ state });
  if (code) query.set('code', code);
  else query.set('error', error);
  return `${scheme}://mcp/oauth/callback?${query}`;
}

if (typeof window !== 'undefined') {
  const target = mcpAppReturnUrl(window.location.search);
  // Keep the code out of browser history after constructing the fixed app link.
  window.history.replaceState(null, '', window.location.pathname);
  const link = document.getElementById('open-verity');
  if (target && link) {
    link.href = target;
    link.hidden = false;
    window.location.replace(target);
  }
}
