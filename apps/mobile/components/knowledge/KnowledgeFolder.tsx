import type { SessionDirectory, VerityClient } from '@verity/mobile';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { FileNameDialog } from '../files/FileNameDialog';
import { Button, Group, Row, Text, useConfirm } from '../ui';
import {
  DECISIONS,
  folderIcon,
  folderSubtitle,
  folderTitle,
  listKnowledge,
  pushKnowledge,
  WIKI,
  wikiView,
  type KnowledgeScope,
} from './knowledgeScope';
import { KnowledgeEntryActions, KnowledgeEntryContext } from './KnowledgeEntryActions';
import { useKnowledgePane } from './KnowledgePane';
import { invalidateWikiCatalog, useWikiCatalog } from './useWikiCatalog';
import { useWikiProposals } from './useWikiProposals';
import { startWikiSetup, type WikiSetupMode } from './WikiGuide';
import { WikiDecisions, WikiHome, WikiTopicPages } from './WikiViews';

const PROJECT_AREAS = ['insights', 'sources'] as const;

const DESCRIPTION: Record<KnowledgeScope['kind'], string> = {
  shared:
    'Reference material shared across projects. Agents can read it from every project. Administrators can edit supported text files; original sources remain protected.',
  project:
    'The Wiki with its decisions, and the original sources of this project. Wiki edits and file deletion require project management access.',
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
  const [confirm, confirmSheet] = useConfirm();
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState<{ path: string; directory: boolean } | null>(null);
  const pane = useKnowledgePane();
  const areas = scope.kind === 'project' && folder === '';
  // Folders take their area names only where the areas are: a project's tree,
  // or the top of a library. Below that, a Shared folder named `sources` is just that.
  const known = scope.kind === 'project' || folder === '';
  const view = wikiView(scope, folder);
  const inWiki = folder === WIKI || folder.startsWith(`${WIKI}/`);
  const wiki = useWikiCatalog(client, scope.kind === 'project' && inWiki ? scope.projectId : null);
  // The start page, the decisions and a topic come from the catalog. A server
  // without one, or a catalog that cannot be read, lists their folder instead,
  // so the Wiki is never less reachable than its files.
  const fromCatalog = view !== null && view.kind !== 'files';
  const catalogFailed = fromCatalog && wiki.error !== undefined;
  const listing = !areas && (!fromCatalog || wiki.catalog === null || catalogFailed);
  const titles = new Map((wiki.catalog?.pages ?? []).map((page) => [page.path, page]));
  const proposals = useWikiProposals(
    client,
    scope.kind === 'project' && folder === WIKI ? scope.projectId : null,
  );
  const open = {
    folder: onOpenFolder,
    file: onOpenFile,
    ...(scope.kind === 'project'
      ? { proposal: (id: string) => pushKnowledge(scope, { proposal: id }) }
      : {}),
  };
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

  const remove =
    scope.kind === 'project'
      ? (path: string, directory: boolean) => {
          if (deleting) return;
          const area = path.startsWith('sources/') ? 'the project Sources' : 'the project Wiki';
          confirm({
            title: directory ? 'Delete folder?' : 'Delete file?',
            message: directory
              ? `Permanently delete “${path.split('/').at(-1) ?? path}” and everything inside it from ${area}?`
              : `Permanently delete “${path.split('/').at(-1) ?? path}” from ${area}?`,
            confirmLabel: 'Delete',
            destructive: true,
            onConfirm: async () => {
              setDeleting(true);
              try {
                await client.deleteProjectKnowledgeFile(scope.projectId, path);
                invalidateWikiCatalog(scope.projectId);
                retry();
              } catch (failure) {
                Alert.alert(
                  'Could not delete',
                  failure instanceof Error ? failure.message : 'Could not delete this entry.',
                );
                throw failure;
              } finally {
                setDeleting(false);
              }
            },
          });
        }
      : undefined;

  const rename =
    scope.kind === 'project'
      ? (path: string, directory: boolean) => setRenaming({ path, directory })
      : undefined;
  const submitRename = async (name: string) => {
    if (!renaming || scope.kind !== 'project') return;
    const renamed = await client.renameProjectKnowledgeFile(scope.projectId, renaming.path, name);
    setRenaming(null);
    retry();
    pane?.moved?.(scope, renaming.path, renamed.path);
    if (renamed.warning) Alert.alert('Renamed', renamed.warning);
  };

  return (
    <KnowledgeEntryContext.Provider
      value={deleting ? {} : { remove, rename: renaming ? undefined : rename }}
    >
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
            <WikiHome
              catalog={wiki.catalog}
              open={open}
              proposals={(proposals ?? []).filter((proposal) =>
                proposal.changes.some((change) => change.status === 'pending'),
              )}
              {...(scope.kind === 'project'
                ? { setup: (mode: WikiSetupMode) => startWikiSetup(scope.projectId, mode) }
                : {})}
            />
          ) : view.kind === 'decisions' ? (
            <WikiDecisions catalog={wiki.catalog} open={open} />
          ) : view.kind === 'topic' ? (
            <WikiTopicPages catalog={wiki.catalog} title={view.title} open={open} />
          ) : null
        ) : fromCatalog && wiki.catalog === undefined && !catalogFailed ? (
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
                <KnowledgeEntryActions
                  key={entry.path}
                  path={entry.path}
                  label={entry.name}
                  directory
                >
                  <Row
                    leading={{ icon: known ? folderIcon(entry.path) : 'folder' }}
                    title={known ? folderTitle(scope, entry.path) : entry.name}
                    subtitle={known ? folderSubtitle(scope, entry.path) : undefined}
                    navigates
                    onPress={() => onOpenFolder(entry.path)}
                  />
                </KnowledgeEntryActions>
              ) : (
                <KnowledgeEntryActions key={entry.path} path={entry.path} label={entry.name}>
                  <Row
                    leading={{ icon: 'file-text' }}
                    title={titles.get(entry.path)?.title ?? entry.name}
                    subtitle={titles.get(entry.path)?.summary || undefined}
                    navigates
                    onPress={() => onOpenFile(entry.path)}
                  />
                </KnowledgeEntryActions>
              ),
            )}
          </Group>
        )}
        {catalogFailed ? (
          <View style={styles.message}>
            <Text variant="subtitle" tone="muted">
              {`This Wiki view could not be loaded (${wiki.error ?? ''}), so its files are listed instead.`}
            </Text>
            <Button label="Retry" variant="secondary" size="compact" onPress={wiki.retry} />
          </View>
        ) : null}
        {listing && directory?.truncated ? (
          <Text variant="subtitle" tone="muted">
            This folder has more files than can be shown. Organize it into smaller folders.
          </Text>
        ) : null}
        {confirmSheet}
        {renaming ? (
          <FileNameDialog
            title={renaming.directory ? 'Rename folder' : 'Rename file'}
            subtitle={
              renaming.directory
                ? 'Wiki pages that cite sources in this folder keep pointing to the old name.'
                : 'Wiki pages that cite this source keep pointing to the old name.'
            }
            initialName={renaming.path.split('/').at(-1) ?? renaming.path}
            confirmLabel="Rename"
            validate={validateSourceName}
            onSubmit={submitRename}
            onCancel={() => setRenaming(null)}
          />
        ) : null}
      </View>
    </KnowledgeEntryContext.Provider>
  );
}

/** What the server would refuse anyway, said before the request. */
export function validateSourceName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'Enter a name.';
  if (trimmed !== name) return 'Remove the spaces at the start or end.';
  if (/[\\/\0]/.test(name)) return 'Use a name without slashes.';
  if (name === '.' || name === '..' || name === '.text') return 'This name is reserved.';
  // The app addresses its own virtual sections with a leading colon.
  if (name.startsWith(':')) return 'Use a name that does not start with “:”.';
  return null;
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
