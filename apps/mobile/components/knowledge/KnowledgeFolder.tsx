import type { SessionDirectory, SessionFileEntry, VerityClient } from '@verity/mobile';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { fileEntryMeta } from '../../lib/sessionFileUi';
import { FileTabs } from '../files/FileRootTabs';
import { FileSheetHeader, HeaderIconButton, HeaderTextButton } from '../files/FileSheetHeader';
import { SelectionBar } from '../files/explorer/ExplorerBar';
import { ExplorerRow } from '../files/explorer/ExplorerRow';
import { Button, Group, Row, Text } from '../ui';
import { KnowledgeEntryContext } from './KnowledgeEntryActions';
import {
  DECISIONS,
  folderIcon,
  folderSubtitle,
  folderTitle,
  listKnowledge,
  pushKnowledge,
  WIKI,
  wikiFolder,
  wikiView,
  type KnowledgeScope,
} from './knowledgeScope';
import { useKnowledgeExplorer } from './useKnowledgeExplorer';
import { useWikiCatalog } from './useWikiCatalog';
import { useWikiProposals } from './useWikiProposals';
import { startWikiSetup, type WikiSetupMode } from './WikiGuide';
import { WikiDecisions, WikiHome, WikiTopicPages } from './WikiViews';

const PROJECT_AREAS = ['insights', 'sources'] as const;

/** Shared's two areas, as tabs at its top like a session's Code and Drive. */
const SHARED_TABS = [
  { folder: 'insights', label: 'Wiki', icon: 'book-open' },
  { folder: 'sources', label: 'Sources', icon: 'paperclip' },
] as const;

const DESCRIPTION =
  'The Wiki with its decisions, and the original sources of this project. Wiki edits and file changes require project management access.';

/**
 * One folder of a knowledge library. A project's top level is its two areas,
 * Wiki and Sources; the Wiki opens on its start page, with decisions, topics
 * and their pages drawn from its catalog. Every folder of files is the same
 * explorer as a session's Files — rows with "⋯", swipe, selecting, the + menu
 * and Move… — and Shared opens on its Wiki and Sources as tabs. Where the next
 * level appears is the caller's choice, so this draws no navigation of its own.
 *
 * `header` says where the + and the selection's Select All/Done go: into the
 * screen's navigation header (`stack`), or above the list (`inline`).
 */
export function KnowledgeFolder({
  client,
  scope,
  folder: requested,
  onOpenFolder,
  onOpenFile,
  header = 'inline',
}: {
  client: VerityClient;
  scope: KnowledgeScope;
  folder: string;
  onOpenFolder: (folder: string) => void;
  onOpenFile: (file: string) => void;
  header?: 'stack' | 'inline';
}) {
  const [tab, setTab] = useState<'insights' | 'sources'>('insights');
  const sharedTop = scope.kind === 'shared' && requested === '';
  const folder = sharedTop ? tab : requested;
  const areas = scope.kind === 'project' && folder === '';
  const view = wikiView(scope, folder);
  const inWiki = folder === WIKI || folder.startsWith(`${WIKI}/`);
  const wiki = useWikiCatalog(client, scope.kind === 'project' && inWiki ? scope.projectId : null);
  // The start page, the decisions and a topic come from the catalog. A server
  // without one, or a catalog that cannot be read, lists their folder instead,
  // so the Wiki is never less reachable than its files.
  const fromCatalog = view !== null && view.kind !== 'files';
  const catalogFailed = fromCatalog && wiki.error !== undefined;
  const listing = !areas && (!fromCatalog || wiki.catalog === null || catalogFailed);
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
  // Whether this screen's header ever carried the explorer's controls.
  const listed = useRef(false);
  if (listing) listed.current = true;
  // A Wiki page reads by its title and summary from the catalog, as everywhere
  // the Wiki is shown; a file without one keeps its name and size.
  const titles = new Map((wiki.catalog?.pages ?? []).map((page) => [page.path, page]));
  const entries = useMemo(() => sectionsFirst(scope, directory?.entries ?? []), [scope, directory]);
  const explorer = useKnowledgeExplorer({
    client,
    scope,
    // A Wiki view lists the folder behind it; what is added or moved lands there.
    folder: wikiFolder(scope, folder),
    entries,
    reload: retry,
    onOpenFolder,
    onOpenFile,
  });

  // The catalog's own rows (a topic's pages) open the same menu, and swipe to
  // the same More and Delete, as the rows of a folder.
  const catalogActions = useMemo(
    () => ({
      menu: (path: string, label: string) => explorer.openMenu(catalogEntry(path, label)),
      remove: (path: string) => explorer.remove([path]),
    }),
    [explorer],
  );

  const add =
    listing && explorer.canAdd && !explorer.selecting ? (
      <HeaderIconButton
        icon="plus"
        tint
        busy={explorer.busy}
        accessibilityLabel="New or upload files"
        onPress={explorer.openAdd}
      />
    ) : null;
  const selectAll = (
    <HeaderTextButton
      label={
        explorer.selected.length === explorer.selectableCount && explorer.selectableCount > 0
          ? 'Select None'
          : 'Select All'
      }
      onPress={explorer.selectAll}
    />
  );
  const done = <HeaderTextButton label="Done" emphasis="strong" onPress={explorer.endSelection} />;
  const selectionTitle = `${explorer.selected.length} selected`;

  return (
    <KnowledgeEntryContext.Provider value={explorer.busy ? {} : catalogActions}>
      {header === 'stack' && (listing || listed.current) ? (
        <Stack.Screen
          options={
            !listing
              ? // A folder that turned into a Wiki view (its catalog arrived) gives
                // the + and the selection's controls back.
                {
                  title: folderTitle(scope, requested),
                  headerLeft: undefined,
                  headerRight: undefined,
                }
              : explorer.selecting
                ? {
                    // Selecting takes over the page's header, as it does the Files sheet's.
                    title: selectionTitle,
                    headerLeft: () => selectAll,
                    headerRight: () => done,
                  }
                : {
                    title: folderTitle(scope, requested),
                    headerLeft: undefined,
                    headerRight: add ? () => add : undefined,
                  }
          }
        />
      ) : null}
      <View style={styles.root} testID="knowledge-folder">
        {header === 'inline' && listing ? (
          explorer.selecting ? (
            <FileSheetHeader leading={selectAll} title={selectionTitle} trailing={done} />
          ) : add ? (
            <View style={styles.inlineAdd}>{add}</View>
          ) : null
        ) : null}
        {areas ? (
          <>
            <Text variant="subtitle" tone="muted">
              {DESCRIPTION}
            </Text>
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
          </>
        ) : null}
        {sharedTop ? (
          <FileTabs
            disabled={explorer.selecting}
            tabs={SHARED_TABS.map((candidate) => ({
              key: candidate.folder,
              icon: candidate.icon,
              label: candidate.label,
              active: tab === candidate.folder,
              onPress: () => setTab(candidate.folder),
            }))}
          />
        ) : null}
        {areas ? null : fromCatalog && wiki.catalog ? (
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
        ) : entries.length === 0 ? (
          <Text variant="body" tone="muted" style={styles.message}>
            No documents in this folder.
          </Text>
        ) : (
          <View>
            {entries.map((entry) => {
              const row = explorer.rowProps(entry);
              const directoryEntry = entry.kind === 'directory';
              return (
                <ExplorerRow
                  key={entry.path}
                  name={
                    directoryEntry
                      ? folderTitle(scope, entry.path)
                      : (titles.get(entry.path)?.title ?? entry.name)
                  }
                  icon={directoryEntry ? folderIcon(entry.path) : 'file-text'}
                  meta={
                    directoryEntry
                      ? folderSubtitle(scope, entry.path)
                      : titles.get(entry.path)?.summary || fileEntryMeta(entry) || undefined
                  }
                  selecting={row.selecting}
                  picked={row.picked}
                  inert={row.inert}
                  disabled={row.disabled}
                  onPress={
                    row.press ??
                    (() => (directoryEntry ? onOpenFolder(entry.path) : onOpenFile(entry.path)))
                  }
                  onLongPress={row.onLongPress}
                  onMenu={row.onMenu}
                  onDelete={row.onDelete}
                />
              );
            })}
          </View>
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
        {explorer.selecting ? (
          <SelectionBar
            count={explorer.selected.length}
            disabled={explorer.busy || !explorer.canChangeSelected}
            onMove={explorer.moveSelected}
            onDelete={explorer.deleteSelected}
          />
        ) : null}
        {explorer.overlays}
      </View>
    </KnowledgeEntryContext.Provider>
  );
}

/** A catalog page as the explorer's entry, for its menu. */
function catalogEntry(path: string, label: string): SessionFileEntry {
  return { path, name: label, kind: 'file', size: null, modifiedAt: null };
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
  inlineAdd: { flexDirection: 'row', justifyContent: 'flex-end' },
  message: { gap: theme.spacing.sm, alignItems: 'flex-start' },
  loading: { paddingVertical: theme.spacing.lg },
}));
