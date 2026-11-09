import { type CodeHost, type ProjectRecord, type VerityClient } from '@verity/mobile';
import { useCallback, useEffect, useState } from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { loadCodeHosts } from '../../lib/codeHosts';
import { repositoryModuleName } from '../../lib/projectRepositories';
import { useScanResource } from '../../lib/useScanResource';
import { CodeHostIcon } from '../CodeHostIcon';
import { AddRepositorySheet } from '../RepositoryPicker';
import { SettingsGroup } from '../settings/SettingsChrome';
import { Group, IconButton, Row, StatusTag, Text, useConfirm } from '../ui';

export function ProjectRepositories({
  client,
  projectId,
}: {
  client: VerityClient;
  projectId: string;
}) {
  const resource = useScanResource(
    useCallback(() => client.listProjectRepositories(projectId), [client, projectId]),
  );
  const setResourceError = resource.setError;
  const [hosts, setHosts] = useState<CodeHost[]>([]);
  const [githubRepositories, setGithubRepositories] = useState<ProjectRecord[]>([]);
  const { theme } = useUnistyles();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirm, sheet] = useConfirm();
  useEffect(() => {
    let active = true;
    void loadCodeHosts(client, { forProjects: true })
      .then((result) => {
        if (!active) return;
        setHosts(result.hosts);
        setGithubRepositories(result.githubRepositories);
      })
      .catch((error: unknown) => {
        if (active)
          setResourceError(error instanceof Error ? error.message : 'Could not load code hosts.');
      });
    return () => {
      active = false;
    };
  }, [client, setResourceError]);
  const connected = (resource.data ?? []).filter((item) => item.removedAt === null);
  // Repositories already in this project are not offered again; repositories
  // that other projects use stay available.
  const exclude = (host: CodeHost) =>
    connected
      .filter(
        (item) =>
          item.kind === host.provider &&
          (host.provider !== 'forgejo' || item.forgeConnectionId === host.id),
      )
      .map((item) => `${item.owner}/${item.repo}`);
  const add = async (host: CodeHost, repository: string) => {
    const [owner, repo] = repository.split('/');
    if (!owner || !repo) return;
    const name = repositoryModuleName(
      (resource.data ?? []).map((item) => item.name),
      owner,
      repo,
    );
    setBusy(true);
    try {
      await client.addProjectRepository(projectId, {
        name,
        kind: host.provider,
        owner,
        repo,
        ...(host.provider === 'forgejo' ? { forgeConnectionId: host.id } : {}),
      });
      setAdding(false);
      resource.reload();
    } catch (error) {
      setAdding(false);
      resource.setError(error instanceof Error ? error.message : 'Could not connect repository.');
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setBusy(true);
    try {
      await client.removeProjectRepository(projectId, id);
      resource.reload();
    } catch (error) {
      resource.setError(
        error instanceof Error ? error.message : 'Could not disconnect repository.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsGroup
      title="Project repositories"
      description="Each repository has its own branches and pull requests."
    >
      {resource.error ? <Text tone="attention">{resource.error}</Text> : null}
      <Group>
        {connected.map((item) => (
          <Row
            key={item.id}
            leading={
              item.kind === 'github' || item.kind === 'forgejo'
                ? {
                    element: <CodeHostIcon provider={item.kind} color={theme.colors.textMuted} />,
                  }
                : { icon: 'folder', quiet: true }
            }
            title={item.name}
            subtitle={`${item.owner}/${item.repo}`}
            trailing={
              item.isDefault ? (
                <StatusTag intent="optional" label="Default" />
              ) : (
                <IconButton
                  icon="trash-2"
                  accessibilityLabel={`Remove ${item.name}`}
                  disabled={busy}
                  onPress={() =>
                    confirm({
                      title: 'Remove repository?',
                      message:
                        'Existing code and history stay available. New remote actions for this repository will be blocked.',
                      confirmLabel: 'Remove',
                      destructive: true,
                      onConfirm: () => void remove(item.id),
                    })
                  }
                />
              )
            }
          />
        ))}
        <Row
          leading={{ icon: 'plus' }}
          title="Add repository"
          navigates
          disabled={busy || hosts.length === 0}
          onPress={() => setAdding(true)}
        />
      </Group>
      {hosts.length === 0 && resource.data !== undefined ? (
        <Text variant="footnote" tone="faint">
          Connect a code host in Connectors first.
        </Text>
      ) : null}
      <AddRepositorySheet
        client={client}
        visible={adding}
        hosts={hosts}
        githubRepositories={githubRepositories}
        exclude={exclude}
        disabled={busy}
        onAdd={(host, repository) => void add(host, repository)}
        onClose={() => setAdding(false)}
      />
      {sheet}
    </SettingsGroup>
  );
}
