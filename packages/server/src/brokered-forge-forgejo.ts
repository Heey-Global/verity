import type { BrokeredForgeAdapter, ForgeAction } from './brokered-forge-github.js';
import { ForgePolicyError } from './brokered-forge-github.js';
import { normalizeForgejoUrl } from './forgejo-transport.js';

/** The connection and repository come from durable server bindings, never request data. */
export function createForgejoForgeAdapter(options: {
  connectionId: string;
  baseUrl: string;
  customCaPem?: string | null;
  credentials(): Promise<{ token: string; login: string } | undefined>;
}): BrokeredForgeAdapter {
  const base = new URL(normalizeForgejoUrl(options.baseUrl));
  const prefix = base.pathname.replace(/\/$/u, '');
  function reject(): never {
    throw new ForgePolicyError('forge request rejected');
  }
  return {
    hosts: new Set([base.host]),
    streams: (request) => !request.path.startsWith(`${prefix}/api/v1/`),
    async authorize(request, binding, actions) {
      if (binding.forgeConnectionId !== options.connectionId || request.hostname !== base.host)
        reject();
      if (
        ![binding.owner, binding.repo].every(
          (value) => /^[a-zA-Z0-9_.-]+$/u.test(value) && value !== '.' && value !== '..',
        )
      )
        reject();
      const rawPath = request.path.split('?')[0]!;
      if (
        !rawPath.startsWith('/') ||
        rawPath.split('/').some((segment) => {
          try {
            const decoded = decodeURIComponent(segment);
            return (
              decoded === '.' ||
              decoded === '..' ||
              /[\\/%]/u.test(decoded) ||
              Array.from(decoded).some(
                (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
              )
            );
          } catch {
            return true;
          }
        })
      )
        reject();
      const url = new URL(request.path, base.origin);
      if (
        url.origin !== base.origin ||
        [...url.searchParams.keys()].some((key) =>
          ['sudo', 'token', 'access_token'].includes(key.toLowerCase()),
        )
      )
        reject();
      const repo = `${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.repo)}`;
      const api = `${prefix}/api/v1/repos/${repo}`;
      const git = `${prefix}/${repo}`;
      let action: ForgeAction | undefined;
      let gitRequest = false;
      const read = ['GET', 'HEAD'].includes(request.method);
      if (url.pathname === `${git}.git/info/refs` || url.pathname === `${git}/info/refs`) {
        const service = url.searchParams.get('service');
        if (read && [...url.searchParams.keys()].every((key) => key === 'service'))
          action =
            service === 'git-upload-pack'
              ? 'git-read'
              : service === 'git-receive-pack'
                ? 'git-write'
                : undefined;
        gitRequest = true;
      } else if (
        url.pathname === `${git}.git/git-upload-pack` ||
        url.pathname === `${git}/git-upload-pack`
      ) {
        if (request.method === 'POST' && !url.search) action = 'git-read';
        gitRequest = true;
      } else if (
        url.pathname === `${git}.git/git-receive-pack` ||
        url.pathname === `${git}/git-receive-pack`
      ) {
        if (request.method === 'POST' && !url.search) action = 'git-write';
        gitRequest = true;
      } else if (url.pathname === api || url.pathname.startsWith(`${api}/`)) {
        const suffix = url.pathname.slice(api.length);
        if (read && (suffix === '' || /^\/(?:branches|commits)(?:\/[^/]+)?$/u.test(suffix)))
          action = 'git-read';
        else if (read && /^\/(?:statuses\/[^/]+|commits\/[^/]+\/status)$/u.test(suffix))
          action = 'checks-read';
        else if (read && /^\/actions\/runs(?:\/\d+(?:\/jobs)?)?$/u.test(suffix))
          action = 'actions-read';
        else if (/^\/issues(?:\/\d+(?:\/(?:comments|labels))?)?$/u.test(suffix))
          action = read
            ? 'issues-read'
            : ['POST', 'PATCH'].includes(request.method)
              ? 'issues-write'
              : undefined;
        else if (/^\/pulls(?:\/\d+(?:\/(?:merge|commits|files))?)?$/u.test(suffix))
          action = read
            ? 'pulls-read'
            : ['POST', 'PATCH'].includes(request.method)
              ? 'pulls-write'
              : undefined;
      }
      if (!action || !actions.has(action)) reject();
      const credentials = await options.credentials();
      if (
        !credentials ||
        !credentials.token ||
        !credentials.login ||
        /[\r\n:]/u.test(credentials.login) ||
        /[\r\n]/u.test(credentials.token)
      )
        reject();
      const authorization = gitRequest
        ? `Basic ${Buffer.from(`${credentials.login}:${credentials.token}`).toString('base64')}`
        : `token ${credentials.token}`;
      return {
        action,
        authorization,
        credentials: [
          { value: credentials.token, alias: 'forge-token' },
          { value: `${credentials.login}:${credentials.token}`, alias: 'forge-git-credential' },
          { value: authorization, alias: 'forge-authorization' },
        ],
        upstream: {
          hostname: base.hostname.replace(/^\[|\]$/gu, ''),
          port: Number(base.port || 443),
          ...(options.customCaPem ? { ca: options.customCaPem } : {}),
          allowPrivateAddress: true,
        },
      };
    },
  };
}
