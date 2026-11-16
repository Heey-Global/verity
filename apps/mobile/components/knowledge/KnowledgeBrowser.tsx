import type { VerityClient } from '@verity/mobile';
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { createVerityClient } from '../../lib/client';
import { SettingsMessage, SettingsScaffold } from '../settings/SettingsChrome';
import { Button, Text } from '../ui';
import { Icon } from '../Icon';
import { KnowledgeFileView } from './KnowledgeFileView';
import { KnowledgeFolder } from './KnowledgeFolder';
import { useKnowledgePane } from './KnowledgePane';
import {
  folderTitle,
  pushKnowledge,
  scopeTitle,
  WIKI,
  type KnowledgeScope,
} from './knowledgeScope';
import { WikiInfoButton } from './WikiGuide';
import { WikiProposalScreen } from './WikiProposal';

/**
 * A knowledge route: one folder or one file per screen, so the header's back
 * arrow and the swipe go up exactly one level, and the header names where the
 * operator is.
 */
export function KnowledgeScreen({
  scope,
  folder = '',
  file,
  proposal,
}: {
  scope: KnowledgeScope;
  folder?: string | undefined;
  file?: string | undefined;
  /** A proposed Wiki change to review, by id. */
  proposal?: string | undefined;
}) {
  const client = useMemo(() => createVerityClient(), []);
  if (!client)
    return (
      <SettingsMessage
        screenTitle={scopeTitle(scope)}
        title="Server unavailable"
        subtitle={`Connect to your Verity server to browse ${scopeTitle(scope)}.`}
      />
    );
  if (proposal && scope.kind === 'project')
    return <WikiProposalScreen client={client} projectId={scope.projectId} proposalId={proposal} />;
  if (file !== undefined && file !== '')
    return <KnowledgeFileView client={client} scope={scope} file={file} chrome="stack" />;
  return (
    <SettingsScaffold
      title={folderTitle(scope, folder)}
      detail
      state={NO_STATE}
      headerAction={
        scope.kind === 'project' && folder === WIKI ? (
          <WikiInfoButton
            client={client}
            projectId={scope.projectId}
            onOpenFile={(next) => pushKnowledge(scope, { file: next })}
          />
        ) : undefined
      }
    >
      <KnowledgeFolder
        client={client}
        scope={scope}
        folder={folder}
        onOpenFolder={(next) => pushKnowledge(scope, { folder: next })}
        onOpenFile={(next) => pushKnowledge(scope, { file: next })}
      />
    </SettingsScaffold>
  );
}

// The folder list reports its own load failure in place, with Retry beside it.
const NO_STATE = { error: undefined, saving: false };

/**
 * A knowledge library inside another page — a project's Knowledge tab, Verity's
 * page. In the wide layout's left column a folder opens in place with a
 * "‹ parent" line above it, and a file opens in the right column. On a phone
 * the first tap leaves for the route screens above, so every level after the
 * first is a screen of its own.
 */
export function EmbeddedKnowledge({
  client,
  scope,
  start = '',
  exit,
}: {
  client: VerityClient;
  scope: KnowledgeScope;
  /** The folder the library opens at and never leaves upwards, such as a
   *  project's Wiki opened from its page. */
  start?: string;
  /** Where "‹" at the top level leads, when the library is not the page's root. */
  exit?: { label: string; onPress: () => void };
}) {
  const { theme } = useUnistyles();
  const pane = useKnowledgePane();
  const [folder, setFolder] = useState(start);
  const open = {
    folder: (next: string) => (pane ? setFolder(next) : pushKnowledge(scope, { folder: next })),
    file: (next: string) =>
      pane ? pane.openFile(scope, next) : pushKnowledge(scope, { file: next }),
  };
  const levels = [{ path: start, label: folderTitle(scope, start) }];
  if (folder !== start) {
    const parts = folder
      .slice(start ? start.length + 1 : 0)
      .split('/')
      .filter(Boolean);
    parts.forEach((_part, index) => {
      const path = [start, ...parts.slice(0, index + 1)].filter(Boolean).join('/');
      levels.push({ path, label: folderTitle(scope, path) });
    });
  }
  return (
    <View style={styles.root} testID="embedded-knowledge">
      <View style={styles.pathRow}>
        <ScrollView
          horizontal
          style={styles.pathScroll}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.breadcrumb}
        >
          {exit ? (
            <>
              <Button
                label={exit.label}
                icon="chevron-left"
                variant="text"
                size="compact"
                onPress={exit.onPress}
              />
              <Icon name="chevron-right" size={14} color={theme.colors.textFaint} />
            </>
          ) : null}
          {levels.map((level, index) => (
            <View key={level.path} style={styles.breadcrumb}>
              {index > 0 ? (
                <Icon name="chevron-right" size={14} color={theme.colors.textFaint} />
              ) : null}
              {index === levels.length - 1 ? (
                <Text variant="subtitle" numberOfLines={1}>
                  {level.label}
                </Text>
              ) : (
                <Button
                  label={level.label}
                  variant="text"
                  size="compact"
                  onPress={() => setFolder(level.path)}
                />
              )}
            </View>
          ))}
        </ScrollView>
        {scope.kind === 'project' && folder === WIKI ? (
          <WikiInfoButton client={client} projectId={scope.projectId} onOpenFile={open.file} />
        ) : null}
      </View>
      <KnowledgeFolder
        key={folder}
        client={client}
        scope={scope}
        folder={folder}
        onOpenFolder={open.folder}
        onOpenFile={open.file}
      />
    </View>
  );
}

/** {@link EmbeddedKnowledge} as a whole column, scrolling on its own. */
export function KnowledgeColumn(props: Parameters<typeof EmbeddedKnowledge>[0]) {
  return (
    <ScrollView contentContainerStyle={styles.column}>
      <EmbeddedKnowledge {...props} />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.spacing.sm },
  pathRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  pathScroll: { flexGrow: 1, flexShrink: 1 },
  breadcrumb: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs },
  column: { padding: theme.spacing.lg },
}));
