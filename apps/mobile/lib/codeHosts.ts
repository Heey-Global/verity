// Which code hosts this server is connected to — GitHub, Forgejo instances,
// both, or none — shared by Connections, New project and project linking.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  VerityApiError,
  connectedCodeHosts,
  githubRepositoryAccessReady,
  type CodeHost,
  type ProjectRecord,
  type VerityClient,
} from '@verity/mobile';

const LAST_CODE_HOST_KEY = 'verity.newProject.codeHost';

export interface LoadedCodeHosts {
  hosts: CodeHost[];
  /** GitHub repositories the installation can reach, for the GitHub picker. */
  githubRepositories: ProjectRecord[];
}

/**
 * Load the code hosts this server is connected to. Each source may fail on its
 * own (older server, non-admin user, sealed store); a failure only removes that
 * host, so the screen still offers what does work — down to a local project.
 *
 * GitHub counts as connected when Settings say so or the installation already
 * lists repositories, which also covers users who cannot read Settings.
 */
export async function loadCodeHosts(
  client: VerityClient,
  options: { forProjects?: boolean } = {},
): Promise<LoadedCodeHosts> {
  const [settings, connections, repositories] = await Promise.allSettled([
    Promise.resolve().then(() => client.getVeritySettings()),
    Promise.resolve().then(() => client.listConnections()),
    Promise.resolve().then(() => client.listAvailableRepositories()),
  ]);
  const githubRepositories = repositories.status === 'fulfilled' ? repositories.value : [];
  const githubConnected =
    (settings.status === 'fulfilled' && githubRepositoryAccessReady(settings.value)) ||
    githubRepositories.length > 0;
  return {
    hosts: connectedCodeHosts(
      {
        githubConnected,
        connections: connections.status === 'fulfilled' ? connections.value : null,
      },
      options,
    ),
    githubRepositories,
  };
}

export async function readLastCodeHost(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(LAST_CODE_HOST_KEY);
  } catch {
    return null;
  }
}

export function rememberCodeHost(id: string): void {
  void AsyncStorage.setItem(LAST_CODE_HOST_KEY, id).catch(() => {
    // Only a preselection hint; losing it falls back to the first host.
  });
}

/** The server answers every failed check with one message, so the app names the
 *  likely causes instead of guessing which one it was. */
export function forgejoConnectionError(caught: unknown): { title: string; message: string } {
  if (caught instanceof VerityApiError && caught.status === 403)
    return {
      title: 'Administrator required',
      message: 'Only a Verity administrator can add code hosts.',
    };
  if (caught instanceof VerityApiError && caught.status === 503)
    return { title: 'Secret store locked', message: 'Unlock the secret store and try again.' };
  return {
    title: 'Could not connect',
    message:
      'Check that the server URL uses HTTPS, the token is valid and the certificate is trusted.',
  };
}
