import type { VerityClient } from '@verity/mobile';
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { createVerityClient } from '../../lib/client';
import { SettingsMessage, SettingsScaffold } from '../settings/SettingsChrome';
import { Button } from '../ui';
import { KnowledgeFileView } from './KnowledgeFileView';
import { KnowledgeFolder } from './KnowledgeFolder';
import { useKnowledgePane } from './KnowledgePane';
import {
  folderTitle,
  parentFolder,
  pushKnowledge,
  scopeTitle,
  type KnowledgeScope,
} from './knowledgeScope';

/**
 * A knowledge route: one folder or one file per screen, so the header's back
 * arrow and the swipe go up exactly one level, and the header names where the
 * operator is.
 */
export function KnowledgeScreen({
  scope,
  folder = '',
  file,
}: {
  scope: KnowledgeScope;
  folder?: string | undefined;
  file?: string | undefined;
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
  if (file !== undefined && file !== '')
    return <KnowledgeFileView client={client} scope={scope} file={file} chrome="stack" />;
  return (
    <SettingsScaffold title={folderTitle(scope, folder)} detail state={NO_STATE}>
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
  const pane = useKnowledgePane();
  const [folder, setFolder] = useState(start);
  const open = {
    folder: (next: string) => (pane ? setFolder(next) : pushKnowledge(scope, { folder: next })),
    file: (next: string) =>
      pane ? pane.openFile(scope, next) : pushKnowledge(scope, { file: next }),
  };
  const up = parentFolder(folder);
  const back =
    folder !== start ? { label: folderTitle(scope, up), onPress: () => setFolder(up) } : exit;
  return (
    <View style={styles.root} testID="embedded-knowledge">
      {back ? (
        <View style={styles.back}>
          <Button
            label={back.label}
            icon="chevron-left"
            variant="text"
            size="compact"
            onPress={back.onPress}
          />
        </View>
      ) : null}
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
  back: { alignItems: 'flex-start', marginLeft: -theme.spacing.sm },
  column: { padding: theme.spacing.lg },
}));
