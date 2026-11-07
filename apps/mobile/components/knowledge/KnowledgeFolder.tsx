import type { SessionDirectory, VerityClient } from '@verity/mobile';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Group, Row, Text } from '../ui';
import {
  DECISIONS,
  folderIcon,
  folderSubtitle,
  folderTitle,
  listKnowledge,
  WIKI,
  wikiView,
  type KnowledgeScope,
} from './knowledgeScope';
import { useWikiCatalog } from './useWikiCatalog';
import { WikiDecisions, WikiHome, WikiTopicPages } from './WikiViews';

const PROJECT_AREAS = ['insights', 'sources'] as const;

const DESCRIPTION: Record<KnowledgeScope['kind'], string> = {
  shared:
    'Reference material shared across projects. Agents can read it from every project. Administrators can edit supported text files; original sources remain protected.',
  project:
    'The Wiki with its decisions, and the original sources of this project. Wiki edits require project management access.',
};

/**
 * One folder of a knowledge library as a list: folders first as the server
 * orders them, each row opening the next level. Where that level appears is the
 * caller's choice — its own screen on a phone, the same column in the wide
 * layout — so this draws no navigation of its own.
 *
 * A project's top level is its two areas, Wiki and Sources. The Wiki opens on
 * its start page, with decisions, topics and their pages drawn from the Wiki's
 * catalog, and its files listed by title; a server without a catalog shows the
 * Wiki as a folder, Decisions first: it is the Wiki's own section, not one
 * folder among many.
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
  // Folders take their area names only where the areas are: a project's tree,
  // or the top of a library. Below that, a Shared folder named `sources` is just that.
  const known = scope.kind === 'project' || folder === '';
  const view = wikiView(scope, folder);
  const inWiki = folder === WIKI || folder.startsWith(`${WIKI}/`);
  const wiki = useWikiCatalog(client, scope.kind === 'project' && inWiki ? scope.projectId : null);
  // The start page, the decisions and a topic come from the catalog; only a
  // server without one lists their folders instead.
  const fromCatalog = view !== null && view.kind !== 'files';
  const listing = !areas && (!fromCatalog || wiki.catalog === null);
  const titles = new Map((wiki.catalog?.pages ?? []).map((page) => [page.path, page]));
  const open = { folder: onOpenFolder, file: onOpenFile };
  const [directory, setDirectory] = useState<SessionDirectory>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!listing) return;
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
  }, [
    client,
    scope.kind,
    scope.kind === 'project' ? scope.projectId : '',
    folder,
    listing,
    attempt,
  ]);
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
              leading={{ icon: folderIcon(area) }}
              title={folderTitle(scope, area)}
              subtitle={folderSubtitle(scope, area)}
              navigates
              onPress={() => onOpenFolder(area)}
            />
          ))}
        </Group>
      ) : fromCatalog && wiki.catalog ? (
        view.kind === 'home' ? (
          <WikiHome catalog={wiki.catalog} open={open} />
        ) : view.kind === 'decisions' ? (
          <WikiDecisions catalog={wiki.catalog} open={open} />
        ) : view.kind === 'topic' ? (
          <WikiTopicPages catalog={wiki.catalog} title={view.title} open={open} />
        ) : null
      ) : fromCatalog && wiki.error !== undefined ? (
        <View style={styles.message}>
          <Text variant="body" tone="muted">
            {wiki.error}
          </Text>
          <Button label="Retry" variant="secondary" size="compact" onPress={wiki.retry} />
        </View>
      ) : fromCatalog && wiki.catalog === undefined ? (
        <ActivityIndicator style={styles.loading} />
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
          {sectionsFirst(scope, directory.entries).map((entry) =>
            entry.kind === 'directory' ? (
              <Row
                key={entry.path}
                leading={{ icon: known ? folderIcon(entry.path) : 'folder' }}
                title={known ? folderTitle(scope, entry.path) : entry.name}
                subtitle={known ? folderSubtitle(scope, entry.path) : undefined}
                navigates
                onPress={() => onOpenFolder(entry.path)}
              />
            ) : (
              <Row
                key={entry.path}
                leading={{ icon: 'file-text' }}
                title={titles.get(entry.path)?.title ?? entry.name}
                subtitle={titles.get(entry.path)?.summary || undefined}
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

/** A project's Decisions ahead of the Wiki's other entries; the rest keep the
 *  server's order. */
function sectionsFirst(
  scope: KnowledgeScope,
  entries: SessionDirectory['entries'],
): SessionDirectory['entries'] {
  if (scope.kind !== 'project') return entries;
  return [
    ...entries.filter((entry) => entry.path === DECISIONS),
    ...entries.filter((entry) => entry.path !== DECISIONS),
  ];
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.spacing.md },
  message: { gap: theme.spacing.sm, alignItems: 'flex-start' },
  loading: { paddingVertical: theme.spacing.lg },
}));
