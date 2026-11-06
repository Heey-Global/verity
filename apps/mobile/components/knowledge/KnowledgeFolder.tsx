import type { SessionDirectory, VerityClient } from '@verity/mobile';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Group, Row, Text } from '../ui';
import { folderTitle, listKnowledge, type KnowledgeScope } from './knowledgeScope';

const PROJECT_AREAS = ['insights/decisions', 'insights', 'sources'] as const;

const DESCRIPTION: Record<KnowledgeScope['kind'], string> = {
  shared:
    'Reference material shared across projects. Agents can read it from every project. Administrators can edit supported text files; original sources remain protected.',
  project:
    'Decisions, Wiki and original sources for this project. Wiki edits require project management access.',
};

/**
 * One folder of a knowledge library as a list: folders first as the server
 * orders them, each row opening the next level. Where that level appears is the
 * caller's choice — its own screen on a phone, the same column in the wide
 * layout — so this draws no navigation of its own.
 *
 * A project's top level is its three areas rather than the raw tree, which
 * would show Decisions only inside the Wiki.
 */
export function KnowledgeFolder({
  client,
  scope,
  folder,
  onOpenFolder,
  onOpenFile,
}: {
  client: VerityClient;
  scope: KnowledgeScope;
  folder: string;
  onOpenFolder: (folder: string) => void;
  onOpenFile: (file: string) => void;
}) {
  const areas = scope.kind === 'project' && folder === '';
  const [directory, setDirectory] = useState<SessionDirectory>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (areas) return;
    let active = true;
    setDirectory(undefined);
    setError(undefined);
    listKnowledge(client, scope, folder).then(
      (next) => {
        if (active) setDirectory(next);
      },
      (failure: unknown) => {
        if (active)
          setError(failure instanceof Error ? failure.message : 'Could not load this folder');
      },
    );
    return () => {
      active = false;
    };
    // `scope` is compared by what it names, so a fresh object does not reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, scope.kind, scope.kind === 'project' ? scope.projectId : '', folder, areas, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return (
    <View style={styles.root} testID="knowledge-folder">
      {folder === '' ? (
        <Text variant="subtitle" tone="muted">
          {DESCRIPTION[scope.kind]}
        </Text>
      ) : null}
      {areas ? (
        <Group>
          {PROJECT_AREAS.map((area) => (
            <Row
              key={area}
              leading={{ icon: 'folder' }}
              title={folderTitle(scope, area)}
              navigates
              onPress={() => onOpenFolder(area)}
            />
          ))}
        </Group>
      ) : error !== undefined ? (
        <View style={styles.message}>
          <Text variant="body" tone="muted">
            {error}
          </Text>
          <Button label="Retry" variant="secondary" size="compact" onPress={retry} />
        </View>
      ) : directory === undefined ? (
        <ActivityIndicator style={styles.loading} />
      ) : directory.entries.length === 0 ? (
        <Text variant="body" tone="muted" style={styles.message}>
          No documents in this folder.
        </Text>
      ) : (
        <Group>
          {directory.entries.map((entry) =>
            entry.kind === 'directory' ? (
              <Row
                key={entry.path}
                leading={{ icon: 'folder' }}
                title={folder === '' ? folderTitle(scope, entry.path) : entry.name}
                navigates
                onPress={() => onOpenFolder(entry.path)}
              />
            ) : (
              <Row
                key={entry.path}
                leading={{ icon: 'file-text' }}
                title={entry.name}
                navigates
                onPress={() => onOpenFile(entry.path)}
              />
            ),
          )}
        </Group>
      )}
      {directory?.truncated ? (
        <Text variant="subtitle" tone="muted">
          This folder has more files than can be shown. Organize it into smaller folders.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.spacing.md },
  message: { gap: theme.spacing.sm, alignItems: 'flex-start' },
  loading: { paddingVertical: theme.spacing.lg },
}));
