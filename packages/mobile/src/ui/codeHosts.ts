import type { ForgeConnection, ForgeConnectionList, ProjectRecord } from '../api.js';

/** The GitHub connection id the server uses for the Settings-managed GitHub App. */
export const LEGACY_GITHUB_CONNECTION_ID = 'legacy-github';
const GITHUB_BASE_URL = 'https://github.com';

export type CodeHostProvider = 'github' | 'forgejo';

/** One code host the app can show or create projects on. GitHub and Forgejo
 *  share this shape so screens render them with equal weight. */
export interface CodeHost {
  /** Connection id; `legacy-github` for the GitHub connection. */
  id: string;
  provider: CodeHostProvider;
  /** Row title: `GitHub` or `Forgejo`. */
  title: string;
  /** Host plus path prefix without the scheme, e.g. `git.example.org`. */
  host: string;
  baseUrl: string;
}

export interface CodeHostState {
  /** Settings report a usable GitHub connection. */
  githubConnected: boolean;
  /** `GET /connections`, or null when unavailable (older server, non-admin). */
  connections: ForgeConnectionList | null;
}

export function providerName(provider: CodeHostProvider): string {
  return provider === 'github' ? 'GitHub' : 'Forgejo';
}

function displayHost(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.host}${url.pathname.replace(/\/$/u, '')}`;
  } catch {
    return baseUrl;
  }
}

export function codeHostFromConnection(connection: ForgeConnection): CodeHost {
  return {
    id: connection.id,
    provider: connection.provider,
    title: providerName(connection.provider),
    host: displayHost(connection.baseUrl),
    baseUrl: connection.baseUrl.replace(/\/$/u, ''),
  };
}

const githubHost: CodeHost = {
  id: LEGACY_GITHUB_CONNECTION_ID,
  provider: 'github',
  title: 'GitHub',
  host: 'github.com',
  baseUrl: GITHUB_BASE_URL,
};

/**
 * The Forgejo instance the app works with. The server can store several; the app
 * offers one, like GitHub, and takes the first in server order.
 */
export function forgejoConnection(
  list: ForgeConnectionList | null | undefined,
): ForgeConnection | undefined {
  return list?.connections.find((connection) => connection.provider === 'forgejo');
}

/**
 * Every connected code host: GitHub, then Forgejo. Covers all four setups —
 * GitHub only, Forgejo only, both, none (empty list).
 *
 * `forProjects` drops Forgejo instances the server cannot run projects for, so a
 * picker never offers a choice that would fail with 503 after the user commits.
 */
export function connectedCodeHosts(
  state: CodeHostState,
  options: { forProjects?: boolean } = {},
): CodeHost[] {
  const hosts: CodeHost[] = state.githubConnected ? [githubHost] : [];
  const list = state.connections;
  if (list === null) return hosts;
  if (options.forProjects === true && !list.forgejoProjectsAvailable) return hosts;
  const forgejo = forgejoConnection(list);
  if (forgejo) hosts.push(codeHostFromConnection(forgejo));
  return hosts;
}

/** The host to preselect: the remembered one if it is still connected, else the first. */
export function preferredCodeHost(
  hosts: readonly CodeHost[],
  rememberedId: string | null | undefined,
): CodeHost | undefined {
  return hosts.find((host) => host.id === rememberedId) ?? hosts[0];
}

/** The code host a repository project lives on; undefined for local projects or
 *  a Forgejo connection the app cannot see. */
export function codeHostForProject(
  project: Pick<ProjectRecord, 'kind' | 'forgeConnectionId'>,
  connections: readonly ForgeConnection[] | null | undefined,
): CodeHost | undefined {
  if (project.kind === 'github') return githubHost;
  if (project.kind !== 'forgejo') return undefined;
  const connection = connections?.find((entry) => entry.id === project.forgeConnectionId);
  return connection ? codeHostFromConnection(connection) : undefined;
}

/** Web URL of a repository on its code host. */
export function repositoryWebUrl(
  host: Pick<CodeHost, 'baseUrl'>,
  owner: string,
  repo: string,
): string {
  return `${host.baseUrl.replace(/\/$/u, '')}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}
