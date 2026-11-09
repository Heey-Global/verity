import type { ProjectRecord, RecentSharedKnowledge, VerityClient } from '@verity/mobile';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { VerityIdentity } from '../home/HomeInbox';
import { KnowledgeColumn } from '../knowledge/KnowledgeBrowser';
import { useKnowledgePane } from '../knowledge/KnowledgePane';
import { SHARED, pushKnowledge } from '../knowledge/knowledgeScope';
import { Button, Group, Row, SectionHeader, Text, TextField } from '../ui';

const AREA: Record<RecentSharedKnowledge['area'], string> = {
  decisions: 'Decision',
  wiki: 'Wiki',
  sources: 'Raw Source',
};

/** "5 min ago", "3 h ago", "2 d ago", or the date for anything older than a week. */
export function changedAgo(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} h ago`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${String(days)} d ago`;
  return new Date(at).toISOString().slice(0, 10);
}

/** The line under a recently changed page: its area, when, and where it came from. */
export function recentLine(entry: RecentSharedKnowledge, now: number): string {
  return [
    AREA[entry.area],
    changedAgo(entry.modifiedAt, now),
    entry.decision ? 'from a confirmed decision' : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Verity's own page in the new design (Settings › This app): what applies across
 * every project. An ask field that starts a session with Verity, the Shared pages
 * that changed last, and the three places that hold cross-project context —
 * personal Instructions, personal Memory and Shared knowledge
 * (decisions 0d0e5a4e and a3c1afa). It is reached by tapping Verity on Home.
 */
export function VerityPage({
  client,
  onBack,
}: {
  client: VerityClient;
  /** Draws the page inside the wide layout's left column, with "Home" to go back. */
  onBack?: (() => void) | undefined;
}) {
  const [recent, setRecent] = useState<RecentSharedKnowledge[] | null>(null);
  const [recentFailed, setRecentFailed] = useState(false);
  const [recentPartial, setRecentPartial] = useState(false);
  // `undefined` while unknown, `null` when the server has none, `'unknown'` when
  // the project list could not be read: only a confirmed absence says it is missing.
  const [control, setControl] = useState<ProjectRecord | null | 'unknown' | undefined>(undefined);
  const [question, setQuestion] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pane = useKnowledgePane();
  // In the wide layout's left column the library opens in the column itself.
  const [browsing, setBrowsing] = useState(false);

  const load = useCallback(async () => {
    setNow(Date.now());
    await Promise.allSettled([
      Promise.resolve()
        .then(() => client.listRecentSharedKnowledge(8))
        .then(
          (list) => {
            setRecent(list.entries);
            setRecentPartial(list.truncated);
            setRecentFailed(false);
          },
          () => setRecentFailed(true),
        ),
      Promise.resolve()
        .then(() => client.listProjects())
        .then(
          (projects) =>
            setControl(projects.find((project) => project.kind === 'control_plane') ?? null),
          () => setControl('unknown'),
        ),
    ]);
  }, [client]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const ask = () => {
    const prompt = question.trim();
    if (!prompt || !control || control === 'unknown') return;
    setQuestion('');
    router.push({ pathname: '/new', params: { projectId: control.id, prompt } });
  };

  const page = (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void load().finally(() => setRefreshing(false));
          }}
        />
      }
      testID="verity-page"
    >
      <View style={styles.identity}>
        <VerityIdentity summary="Knowledge and context across all projects" />
      </View>

      <View style={styles.ask}>
        <TextField
          label="Ask Verity about your knowledge"
          value={question}
          onChangeText={setQuestion}
          onSubmitEditing={ask}
          placeholder="What did we decide about…"
          disabled={!control || control === 'unknown'}
          error={
            control === null
              ? {
                  title: 'Verity Control is not set up',
                  message: 'Questions start a session in Verity Control, which this server lacks.',
                }
              : control === 'unknown'
                ? {
                    title: 'Verity could not be reached',
                    message: 'Pull to refresh to ask again.',
                  }
                : undefined
          }
        />
        <View style={styles.askAction}>
          <Button
            label="Ask"
            size="compact"
            disabled={!control || control === 'unknown' || question.trim().length === 0}
            onPress={ask}
          />
        </View>
      </View>

      <SectionHeader title="Recently changed" />
      {recentFailed ? (
        <Text variant="body" tone="muted">
          Shared knowledge could not be read right now.
        </Text>
      ) : recent === null ? null : recent.length === 0 ? (
        <Text variant="body" tone="muted">
          Nothing in Shared knowledge yet.
        </Text>
      ) : (
        <Group>
          {recent.map((entry) => (
            <Row
              key={entry.path}
              title={entry.title}
              subtitle={recentLine(entry, now)}
              navigates
              onPress={() =>
                // Beside the session in the wide layout; its own screen on a phone.
                pane
                  ? pane.openFile(SHARED, entry.path)
                  : pushKnowledge(SHARED, { file: entry.path })
              }
            />
          ))}
        </Group>
      )}

      {recentPartial && !recentFailed ? (
        <Text variant="footnote" tone="muted" testID="verity-recent-partial">
          Shared knowledge is large; this list covers part of it. Browse it for everything.
        </Text>
      ) : null}

      <SectionHeader title="Across all projects" />
      <Group>
        <Row
          leading={{ icon: 'file-text' }}
          title="Instructions"
          subtitle="Your rules across projects"
          navigates
          onPress={() =>
            router.push({ pathname: '/settings/context', params: { kind: 'instructions' } })
          }
        />
        <Row
          leading={{ icon: 'book-open' }}
          title="Memory"
          subtitle="Review and edit learned facts"
          navigates
          onPress={() => router.push({ pathname: '/settings/context', params: { kind: 'memory' } })}
        />
        <Row
          leading={{ icon: 'globe' }}
          title="Shared knowledge"
          subtitle="Reference material available to agents across projects"
          navigates
          onPress={() =>
            pane && onBack ? setBrowsing(true) : router.push('/settings/shared-knowledge')
          }
        />
      </Group>
    </ScrollView>
  );
  if (!onBack) return page;
  if (browsing)
    return (
      <KnowledgeColumn
        client={client}
        scope={SHARED}
        exit={{ label: 'Verity', onPress: () => setBrowsing(false) }}
      />
    );
  return (
    <View style={styles.flex}>
      <View style={styles.topBar}>
        <Button label="Home" icon="chevron-left" variant="text" size="compact" onPress={onBack} />
      </View>
      {page}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  flex: { flex: 1 },
  topBar: { paddingHorizontal: theme.spacing.sm, paddingTop: theme.spacing.sm },
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    paddingBottom: theme.spacing.md,
  },
  ask: { gap: theme.spacing.sm },
  askAction: { alignItems: 'flex-end' },
}));
