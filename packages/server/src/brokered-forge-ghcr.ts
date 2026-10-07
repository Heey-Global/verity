import type { IncomingMessage } from 'node:http';
import { ForgePolicyError, type BrokeredForgeAdapter } from './brokered-forge-github.js';
import type { BrokeredHttpStreamTransport } from './brokered-http-stream.js';

/** Explicit server-owned package mappings; organization ownership alone is not a grant. */
export function createGhcrForgeAdapter(options: {
  packages(projectId: string): Promise<readonly string[]>;
  mint(): Promise<string | undefined>;
  transport: BrokeredHttpStreamTransport;
}): BrokeredForgeAdapter {
  return {
    hosts: new Set(['ghcr.io']),
    streams: () => false,
    async authorize(request, binding, actions, signal) {
      const deny = (): never => {
        throw new ForgePolicyError('registry request rejected');
      };
      if (
        request.hostname !== 'ghcr.io' ||
        !['GET', 'HEAD'].includes(request.method) ||
        !actions.has('packages-read') ||
        !request.path.startsWith('/') ||
        request.path.includes('\\') ||
        request.path.split('?')[0]!.includes('%')
      )
        deny();
      const url = new URL(request.path, 'https://ghcr.io');
      if (url.origin !== 'https://ghcr.io' || url.hash) deny();
      const packages = await options.packages(binding.projectId);
      let name: string;
      if (url.pathname === '/token') {
        const scope = url.searchParams.get('scope') ?? '';
        const match = /^repository:([^:]+):pull$/.exec(scope);
        if (
          !match ||
          url.searchParams.get('service') !== 'ghcr.io' ||
          [...url.searchParams.keys()].some(
            (key) => !['service', 'scope', 'account', 'client_id', 'offline_token'].includes(key),
          ) ||
          url.searchParams.getAll('scope').length !== 1
        )
          deny();
        name = match![1]!;
      } else {
        const match =
          /^\/v2\/(.+)\/(?:tags\/list|manifests\/[^/]+|blobs\/sha256:[a-f0-9]{64}|referrers\/sha256:[a-f0-9]{64})$/.exec(
            url.pathname,
          );
        if (!match) deny();
        name = match![1]!;
        if (
          [...url.searchParams.keys()].some((key) => !['n', 'last', 'artifactType'].includes(key))
        )
          deny();
      }
      if (
        !/^[a-z0-9][a-z0-9._/-]*$/.test(name!) ||
        name!.split('/').some((p) => !p || p === '.' || p === '..') ||
        !packages.includes(name!)
      )
        deny();
      // The token endpoint returns a local capability, never the upstream bearer.
      if (url.pathname === '/token')
        return {
          action: 'packages-read',
          authorization: '',
          credentials: [],
          registryTokenResponse: true,
        };
      const token = await options.mint();
      const headers: Record<string, string> = {
        'user-agent': 'verity-forge-broker',
        'accept-encoding': 'identity',
      };
      if (token)
        headers.authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
      const issued: IncomingMessage = await options.transport({
        hostname: 'ghcr.io',
        path: '/token?service=ghcr.io&scope=' + encodeURIComponent(`repository:${name!}:pull`),
        method: 'GET',
        headers,
        body: Buffer.alloc(0),
        signal,
      });
      let body = '';
      for await (const chunk of issued) {
        body += Buffer.from(chunk as Uint8Array).toString('utf8');
        if (Buffer.byteLength(body) > 65_536) {
          issued.destroy();
          deny();
        }
      }
      if (issued.statusCode !== 200) deny();
      const result = JSON.parse(body) as { token?: unknown };
      if (
        typeof result.token !== 'string' ||
        !result.token ||
        result.token.length > 16_384 ||
        /[\r\n]/.test(result.token)
      )
        deny();
      return {
        action: 'packages-read',
        authorization: `Bearer ${result.token as string}`,
        credentials: [
          ...(token ? [{ value: token, alias: 'REGISTRY_SOURCE' }] : []),
          { value: result.token as string, alias: 'REGISTRY_TOKEN' },
        ],
      };
    },
  };
}
