// Which services a project can use and which it does, as the connector rows of
// the project settings show them.
import {
  forgejoConnection,
  githubRepositoryAccessReady,
  type ForgeConnection,
  type ProjectDopplerBinding,
  type VerityClient,
} from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

/**
 * Loads on every focus. Each source settles on its own, so one unreachable
 * service leaves the others shown rather than blanking the list.
 */
export function useProjectConnections(client: VerityClient, projectId: string) {
  const [connectionRefresh, setConnectionRefresh] = useState(0);
  const [usage, setUsage] = useState({ google: 0, mcp: 0, matrix: 0 });
  /** The project's Doppler bindings, default first (ADR 0031); null until read. */
  const [dopplerBindings, setDopplerBindings] = useState<ProjectDopplerBinding[] | null>(null);
  const [forgeConnections, setForgeConnections] = useState<ForgeConnection[] | null>(null);
  const [available, setAvailable] = useState({
    github: false,
    forgejo: false,
    doppler: false,
    drive: false,
    google: false,
    mcp: false,
    matrix: false,
  });
  const [driveFolderNames, setDriveFolderNames] = useState<string[] | null>(null);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void Promise.allSettled([
        Promise.resolve().then(() => client.getVeritySettings()),
        Promise.resolve().then(() => client.getGoogleDriveConnection()),
        Promise.resolve().then(() => client.getProjectGoogleConnection(projectId, 'gmail')),
        Promise.resolve().then(() => client.getProjectGoogleConnection(projectId, 'calendar')),
        Promise.resolve().then(() => client.getProjectGoogleConnection(projectId, 'contacts')),
        Promise.resolve().then(() => client.listHttpMcpConnections()),
        Promise.resolve().then(() => client.listIntegrations()),
        Promise.resolve().then(() => client.listProjectMcpBindings(projectId)),
        Promise.resolve().then(() => client.listProjectDriveFolders(projectId)),
        Promise.resolve().then(() => client.listConnections()),
        Promise.resolve().then(() => client.doppler.listConnections()),
        Promise.resolve().then(() => client.doppler.listBindings(projectId)),
      ]).then((results) => {
        if (!active) return;
        const [
          settings,
          drive,
          gmail,
          calendar,
          contacts,
          mcp,
          integrations,
          bindings,
          folders,
          forge,
          dopplerConnections,
          dopplerBound,
        ] = results;
        setDopplerBindings(dopplerBound.status === 'fulfilled' ? dopplerBound.value : null);
        const forgeList = forge.status === 'fulfilled' ? forge.value : null;
        setForgeConnections(forgeList?.connections ?? null);
        setDriveFolderNames(
          folders.status === 'fulfilled' ? folders.value.map((folder) => folder.name) : null,
        );
        setUsage({
          google: [gmail, calendar, contacts].filter(
            (item) => item.status === 'fulfilled' && item.value.enabled,
          ).length,
          mcp:
            bindings.status === 'fulfilled'
              ? bindings.value.filter((binding) => binding.enabled).length
              : 0,
          matrix:
            integrations.status === 'fulfilled'
              ? integrations.value.sources.filter((source) => source.projectId === projectId).length
              : 0,
        });
        setAvailable({
          github: settings.status === 'fulfilled' && githubRepositoryAccessReady(settings.value),
          forgejo:
            forgeList?.forgejoProjectsAvailable === true &&
            forgejoConnection(forgeList) !== undefined,
          // Members cannot list the instance's connections, but see what is bound.
          doppler:
            (dopplerConnections.status === 'fulfilled' && dopplerConnections.value.length > 0) ||
            (dopplerBound.status === 'fulfilled' && dopplerBound.value.length > 0),
          drive: drive.status === 'fulfilled' && drive.value.connected,
          google: [gmail, calendar, contacts].some(
            (item) => item.status === 'fulfilled' && item.value.connected,
          ),
          mcp: mcp.status === 'fulfilled' && mcp.value.length > 0,
          matrix:
            integrations.status === 'fulfilled' &&
            integrations.value.accounts.some((account) => account.provider === 'matrix'),
        });
      });
      return () => {
        active = false;
      };
    }, [client, connectionRefresh, projectId]),
  );
  return {
    available,
    usage,
    dopplerBindings,
    driveFolderNames,
    forgeConnections,
    refresh: useCallback(() => setConnectionRefresh((value) => value + 1), []),
  };
}
