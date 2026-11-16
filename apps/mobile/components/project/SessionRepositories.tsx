import { type VerityClient } from '@verity/mobile';
import { useCallback, useState } from 'react';
import { Linking } from 'react-native';
import { useScanResource } from '../../lib/useScanResource';
import { Button, Card, CardHead, Text } from '../ui';

/** Open module workspaces without changing the session's default branch. */
export function SessionRepositories({
  client,
  sessionId,
}: {
  client: VerityClient;
  sessionId: string;
}) {
  const resource = useScanResource(
    useCallback(() => client.listSessionRepositories(sessionId), [client, sessionId]),
  );
  const [busy, setBusy] = useState<string>();
  const open = async (id: string) => {
    setBusy(id);
    try {
      await client.openSessionRepository(sessionId, id);
      resource.reload();
    } catch (error) {
      resource.setError(error instanceof Error ? error.message : 'Could not open repository.');
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <>
      <Text variant="label">Repositories</Text>
      {resource.error ? <Text tone="attention">{resource.error}</Text> : null}
      {resource.data?.map((item) => (
        <Card stacked key={item.id}>
          <CardHead
            title={item.name}
            subtitle={`${item.owner}/${item.repo}${item.isDefault ? ' · Default' : ''}`}
          />
          {item.workspace ? (
            <>
              <Text variant="code" selectable>
                {item.workspace.worktree}
              </Text>
              {item.workspace.branch ? (
                <Text variant="subtitle">{item.workspace.branch}</Text>
              ) : null}
              {item.workspace.pullRequest ? (
                <Button
                  label={`PR #${String(item.workspace.pullRequest.number)} · ${item.workspace.pullRequest.state}`}
                  variant="text"
                  onPress={() => void Linking.openURL(item.workspace!.pullRequest!.url)}
                />
              ) : null}
              {item.workspace.pullRequest?.dependsOn?.map((url) => (
                <Button
                  key={url}
                  label={`Depends on: ${url}`}
                  variant="text"
                  onPress={() => void Linking.openURL(url)}
                />
              ))}
            </>
          ) : (
            <Button
              label={`Open ${item.name}`}
              disabled={busy !== undefined || item.removedAt !== null}
              loading={busy === item.id}
              onPress={() => void open(item.id)}
            />
          )}
        </Card>
      ))}
    </>
  );
}
