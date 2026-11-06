import { type CodeHost, type ProjectRecord, type VerityClient } from '@verity/mobile';
import { useCallback, useEffect, useState } from 'react';
import { loadCodeHosts } from '../../lib/codeHosts';
import { useScanResource } from '../../lib/useScanResource';
import { CodeHostOption, RepositoryPicker } from '../RepositoryPicker';
import { SettingsGroup } from '../settings/SettingsChrome';
import { Button, Card, CardHead, Group, Text, TextField, useConfirm } from '../ui';

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
  const [hostId, setHostId] = useState<string>();
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
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
        setHostId(result.hosts[0]?.id);
      })
      .catch((error: unknown) => {
        if (active)
          setResourceError(error instanceof Error ? error.message : 'Could not load code hosts.');
      });
    return () => {
      active = false;
    };
  }, [client, setResourceError]);
  const host = hosts.find((item) => item.id === hostId);
  const add = async () => {
    if (!host || !selected) return;
    const [owner, repo] = selected.split('/');
    if (!owner || !repo) return;
    setBusy(true);
    try {
      await client.addProjectRepository(projectId, {
        name: name.trim() || repo,
        kind: host.provider,
        owner,
        repo,
        ...(host.provider === 'forgejo' ? { forgeConnectionId: host.id } : {}),
      });
      setAdding(false);
      setSelected(null);
      setName('');
      resource.reload();
    } catch (error) {
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
      description="Connect modules from any available code host. Each repository has its own branches and pull requests."
    >
      {resource.error ? <Text tone="attention">{resource.error}</Text> : null}
      {resource.data
        ?.filter((item) => item.removedAt === null)
        .map((item) => (
          <Card stacked key={item.id}>
            <CardHead
              title={item.name}
              subtitle={`${item.owner}/${item.repo}${item.isDefault ? ' · Default' : ''}`}
            />
            {!item.isDefault ? (
              <Button
                label={`Disconnect ${item.name}`}
                variant="text"
                disabled={busy}
                onPress={() =>
                  confirm({
                    title: 'Disconnect repository?',
                    message:
                      'Existing code and history stay available. New remote actions for this connection will be blocked.',
                    confirmLabel: 'Disconnect',
                    destructive: true,
                    onConfirm: () => void remove(item.id),
                  })
                }
              />
            ) : null}
          </Card>
        ))}
      <Button
        label={adding ? 'Cancel' : 'Add repository'}
        variant="secondary"
        disabled={busy}
        onPress={() => setAdding(!adding)}
      />
      {adding ? (
        <>
          <Group>
            {hosts.map((candidate) => (
              <CodeHostOption
                key={candidate.id}
                host={candidate}
                selected={candidate.id === hostId}
                disabled={busy}
                onPress={() => {
                  setHostId(candidate.id);
                  setSelected(null);
                }}
              />
            ))}
          </Group>
          {host ? (
            <RepositoryPicker
              client={client}
              host={host}
              initialGithubRepositories={githubRepositories}
              selected={selected}
              onSelect={setSelected}
              disabled={busy}
              autoSelect={false}
            />
          ) : (
            <Text>Connect a code host in Connectors first.</Text>
          )}
          <TextField
            label="Module name"
            value={name}
            onChangeText={setName}
            maxLength={128}
            disabled={busy}
          />
          <Button
            label="Connect repository"
            loading={busy}
            disabled={!selected}
            onPress={() => void add()}
          />
        </>
      ) : null}
      {sheet}
    </SettingsGroup>
  );
}
