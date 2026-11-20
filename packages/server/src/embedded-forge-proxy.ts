import type { EventStore } from '@verity/store';
import { createGhcrForgeAdapter } from './brokered-forge-ghcr.js';
import { loadForgePackageMap } from './brokered-forge-package-map.js';
import { createBrokeredForgeProxy } from './brokered-http-tool.js';
import { createForgejoForgeAdapter } from './brokered-forge-forgejo.js';
import { createGitHubForgeAdapter } from './brokered-forge-github.js';
import { brokeredHttpStreamTransport } from './brokered-http-stream.js';
import { issueGatewayServerCertificate } from './claude-egress-ca.js';
import { loadForgeProxyIdentity } from './brokered-forge-identity.js';
import { resolveForgeRepositoryBinding } from './forge-repository-binding.js';
import { personlessWorkAllowed } from './personless-credential.js';
import {
  createCachedProjectTokenMint,
  createGitHubAppProjectTokenMint,
  createGitHubAppInstallationTokenMint,
  REGISTRY_GITHUB_TOKEN_PERMISSIONS,
} from './github-app-token.js';
import type { createEmbeddedGitHub } from './embedded-github.js';
import type { GhTokenCapabilityRegistry } from './github-token-broker.js';
import type { GitHubUserAuthorization } from './github-user-authorization.js';
import type { TurnCredentials } from './turn-credentials.js';

type EmbeddedForgeProxyContext = Pick<
  ReturnType<typeof createEmbeddedGitHub>,
  'baseMintOpts' | 'githubAppAuthorityKey' | 'cachedProjectTokenMint'
> & {
  projectRelayEnabled: boolean;
  secretRoot: string;
  eventStore: EventStore;
  githubUserAuthorization: GitHubUserAuthorization;
  ghTokenCapabilities: GhTokenCapabilityRegistry;
  turnCredentials: TurnCredentials;
};

export async function createEmbeddedForgeProxy({
  projectRelayEnabled,
  secretRoot,
  eventStore,
  baseMintOpts,
  githubAppAuthorityKey,
  cachedProjectTokenMint,
  githubUserAuthorization,
  ghTokenCapabilities,
  turnCredentials,
}: EmbeddedForgeProxyContext) {
  const forgeIdentity = projectRelayEnabled ? await loadForgeProxyIdentity(secretRoot) : undefined;
  // Under the project fence, Git and gh reach forges only through this brokered route;
  // direct grants for forge hosts are refused as broker-only destinations.
  const forgeProxyEnabled = (): boolean => projectRelayEnabled;
  const forgeCertificates = new Map<
    string,
    { expires: number; certificate: ReturnType<typeof issueGatewayServerCertificate> }
  >();
  const forgePackageMap = projectRelayEnabled
    ? await loadForgePackageMap(secretRoot)
    : new Map<string, readonly string[]>();
  // Separate caches prevent optional diagnostic permissions from breaking Git access.
  const diagnosticMints = Object.fromEntries(
    (['statuses', 'administration', 'contents'] as const).map((permission) => [
      permission,
      createCachedProjectTokenMint(
        createGitHubAppProjectTokenMint({ ...baseMintOpts, permissions: { [permission]: 'read' } }),
        { authorityKey: githubAppAuthorityKey },
      ),
    ]),
  );
  const githubForgeAdapter = createGitHubForgeAdapter({
    mint: cachedProjectTokenMint,
    mintForUser: (userId) => githubUserAuthorization.accessToken(userId),
    mayUseInstallationToken: (userId) => eventStore.isActiveAdministrator(userId),
    mintDiagnostic: (binding, permission) => diagnosticMints[permission]!(binding),
    transport: brokeredHttpStreamTransport,
  });
  const ghcrForgeAdapter = createGhcrForgeAdapter({
    packages: (projectId) => Promise.resolve(forgePackageMap.get(projectId) ?? []),
    mint: createGitHubAppInstallationTokenMint({
      ...baseMintOpts,
      permissions: REGISTRY_GITHUB_TOKEN_PERMISSIONS,
    }),
    transport: brokeredHttpStreamTransport,
  });
  const forgeProxy =
    forgeIdentity === undefined
      ? undefined
      : createBrokeredForgeProxy({
          certificate: forgeIdentity.certificate,
          capabilities: ghTokenCapabilities,
          turnCredentials,
          personlessAllowed: (projectId) => personlessWorkAllowed(eventStore, projectId),
          resolveRepository: (binding, hostname, path) =>
            resolveForgeRepositoryBinding(eventStore, binding, hostname, path),
          allowsHost: async (authority) =>
            githubForgeAdapter.hosts.has(authority) ||
            ghcrForgeAdapter.hosts.has(authority) ||
            (await eventStore.forgeConnections.list()).some(
              (connection) =>
                connection.provider === 'forgejo' && new URL(connection.baseUrl).host === authority,
            ),
          certificateFor: async (authority) => {
            if (githubForgeAdapter.hosts.has(authority) || ghcrForgeAdapter.hosts.has(authority))
              return forgeIdentity.certificate;
            const hostname = new URL(`https://${authority}`).hostname.replace(/^\[|\]$/gu, '');
            const cached = forgeCertificates.get(hostname);
            if (cached && cached.expires > Date.now()) return cached.certificate;
            const certificate = issueGatewayServerCertificate(forgeIdentity.ca, {
              serverName: hostname,
            }).catch((error) => {
              forgeCertificates.delete(hostname);
              throw error;
            });
            forgeCertificates.set(hostname, {
              expires: Date.now() + 24 * 60 * 60_000,
              certificate,
            });
            return certificate;
          },
          adapter: {
            hosts: new Set([...githubForgeAdapter.hosts, ...ghcrForgeAdapter.hosts]),
            streams: (request) =>
              githubForgeAdapter.hosts.has(request.hostname) ||
              ghcrForgeAdapter.hosts.has(request.hostname)
                ? githubForgeAdapter.streams(request)
                : !request.path.includes('/api/v1/'),
            authorize: async (request, binding, actions, signal) => {
              const project = (await eventStore.listProjectRepositories(binding.projectId)).find(
                (repository) =>
                  repository.removedAt === null &&
                  repository.owner === binding.owner &&
                  repository.repo === binding.repo &&
                  (repository.forgeConnectionId ?? 'legacy-github') ===
                    (binding.forgeConnectionId ?? 'legacy-github'),
              );
              if (!project) throw new Error('forge binding changed');
              if (project.kind !== 'forgejo')
                return (
                  request.hostname === 'ghcr.io' ? ghcrForgeAdapter : githubForgeAdapter
                ).authorize(request, binding, actions, signal);
              if (!binding.forgeConnectionId) throw new Error('forge binding missing');
              const connection = await eventStore.forgeConnections.get(binding.forgeConnectionId);
              if (!connection || connection.provider !== 'forgejo')
                throw new Error('forge connection unavailable');
              return createForgejoForgeAdapter({
                connectionId: connection.id,
                baseUrl: connection.baseUrl,
                customCaPem: connection.customCaPem ?? null,
                credentials: async () => {
                  const token = (await eventStore.forgeConnections.credentials(connection.id))
                    ?.personalToken;
                  if (!token) return undefined;
                  return { token, login: 'oauth2' };
                },
              }).authorize(request, binding, actions, signal);
            },
          },
          enabled: forgeProxyEnabled,
        });
  return { forgeIdentity, forgeProxyEnabled, forgeProxy };
}
