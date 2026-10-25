import type { HttpFetch } from './github.js';

export interface CommitStatusPermission {
  state: 'ready' | 'app_update_required' | 'approval_required' | 'unknown';
  url?: string;
}

/** Only GitHub settings links may cross the API boundary into browser actions. */
function settingsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (
      url.origin === 'https://github.com' &&
      url.pathname.includes('/settings/') &&
      !url.username &&
      !url.password
    )
      return url.href;
  } catch {
    /* Invalid upstream metadata is not a navigation target. */
  }
  return undefined;
}

export async function checkCommitStatusPermission(
  doFetch: HttpFetch,
  apiBaseUrl: string,
  jwt: string,
  installationId: string,
  timeoutMs: number,
): Promise<CommitStatusPermission> {
  try {
    const read = async (path: string) => {
      const response = await doFetch(`${apiBaseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'User-Agent': 'verity',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error('permission metadata unavailable');
      return (await response.json()) as {
        permissions?: { statuses?: unknown };
        slug?: unknown;
        owner?: { type?: unknown; login?: unknown };
        html_url?: unknown;
      };
    };
    const app = await read('/app');
    const installation = await read(`/app/installations/${encodeURIComponent(installationId)}`);
    if (!app.permissions || !installation.permissions) return { state: 'unknown' };
    const granted = (value: unknown) => value === 'read' || value === 'write';
    if (granted(installation.permissions.statuses)) return { state: 'ready' };
    if (granted(app.permissions.statuses)) {
      const url = settingsUrl(installation.html_url);
      return { state: 'approval_required', ...(url ? { url } : {}) };
    }
    const slug = typeof app.slug === 'string' && /^[\w-]+$/.test(app.slug) ? app.slug : undefined;
    const owner = app.owner;
    const login =
      typeof owner?.login === 'string' && /^[\w-]+$/.test(owner.login) ? owner.login : undefined;
    const url =
      slug && owner?.type === 'User'
        ? `https://github.com/settings/apps/${slug}/permissions`
        : slug && owner?.type === 'Organization' && login
          ? `https://github.com/organizations/${login}/settings/apps/${slug}/permissions`
          : undefined;
    return { state: 'app_update_required', ...(url ? { url } : {}) };
  } catch {
    return { state: 'unknown' };
  }
}
