// Logins of the identities allowed to author generated release and promotion
// pull requests. Release Please, the OTA proposal and the production proposer
// authenticate as the release GitHub App, so their PRs carry its `<slug>[bot]`
// login; the PRs merged before that app existed carry `github-actions[bot]`,
// and the scripts below still read that history. Every place that treats a
// bot-authored PR as a trusted release identity compares against this list,
// so a human branch under a release name stays untrusted.
import process from 'node:process';

export const releaseBotLoginsVariable = 'RELEASE_BOT_LOGINS';
const defaultLogins = ['github-actions[bot]'];
const loginPattern = /^[\w.-]+\[bot\]$/u;

/**
 * GitHub Actions plus every `<slug>[bot]` login named in the comma-separated
 * RELEASE_BOT_LOGINS variable. Workflows pass the app slug they minted their
 * token for; the default stays included because merged history predates it.
 * @param {string | undefined} [value]
 * @returns {string[]}
 */
export function releaseBotLogins(value = process.env[releaseBotLoginsVariable]) {
  const configured = (value ?? '')
    .split(',')
    .map((login) => login.trim())
    .filter(Boolean);
  for (const login of configured)
    if (!loginPattern.test(login)) throw new Error(`Invalid release bot login: ${login}`);
  return [...new Set([...defaultLogins, ...configured])];
}

/**
 * Accepts the REST `user.login` form (`<slug>[bot]`) and the `app/<slug>` form
 * that `gh --json author` reports for the same identity.
 * @param {string | null | undefined} login
 * @param {string[]} [logins]
 */
export function isReleaseBotLogin(login, logins = releaseBotLogins()) {
  if (!login) return false;
  const normalized = login.startsWith('app/') ? `${login.slice('app/'.length)}[bot]` : login;
  return logins.includes(normalized);
}
