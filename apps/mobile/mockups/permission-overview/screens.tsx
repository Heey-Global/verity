import { permissionSummary, type InboxItem } from '@verity/mobile';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { HomeTabBar } from '../../components/home/HomeTabBar';
import { InboxCard } from '../../components/inbox/InboxFeed';
import {
  Card,
  FilterChips,
  Group,
  IconButton,
  Row,
  SectionHeader,
  Text,
} from '../../components/ui';

const ignore = () => undefined;
const fetchSummary = permissionSummary('WebFetch', { url: 'https://example.org/status' });

// Proposed view models only: production permission classification stays unchanged.
const requests: InboxItem[] = [
  {
    key: 'repair-review',
    kind: 'permission',
    tag: 'Permission',
    tone: 'attention',
    title: 'Review request',
    context: 'Verity · Firewall Test',
    message:
      'The investigation found why both builds fail. The proposed repair changes the DNS helper and needs your approval. Review the full request in the session.',
    actions: [{ kind: 'open_session', label: 'Review', sessionId: 'firewall' }],
    at: 0,
  },
  {
    key: 'short-request',
    kind: 'permission',
    tag: 'Permission',
    tone: 'attention',
    title: fetchSummary.title,
    context: 'Verity · Check service status',
    lines: fetchSummary.lines,
    actions: [
      { kind: 'allow', label: 'Allow once', sessionId: 'overview', toolUseId: 'list' },
      { kind: 'deny', label: 'Deny', sessionId: 'overview', toolUseId: 'list' },
      { kind: 'open_session', label: 'Open', sessionId: 'overview' },
    ],
    at: 0,
  },
];

function Sections({ project = false }: { project?: boolean }) {
  return (
    <>
      <SectionHeader title="Needs you · 2" variant="eyebrow" flush />
      <Group>
        {requests.map((item) => (
          <InboxCard
            key={item.key}
            item={project ? { ...item, context: item.context.replace('Verity · ', '') } : item}
            selected={false}
            pending={false}
            disabled={false}
            grouped
            leading={{ icon: 'git-branch', quiet: true }}
            onAction={ignore}
            onDismiss={ignore}
          />
        ))}
      </Group>
      <SectionHeader title="In progress · 2" variant="eyebrow" flush />
      <Group>
        <Row
          title="Release Checker"
          subtitle={project ? 'Agent working' : 'Verity · Agent working'}
          leading={{ icon: 'message-square', quiet: true }}
          navigates
          onPress={ignore}
        />
        <Row
          title="Check storage"
          subtitle={project ? 'Agent working' : 'Verity · Agent working'}
          leading={{ icon: 'message-square', quiet: true }}
          navigates
          onPress={ignore}
        />
      </Group>
    </>
  );
}

export function HomeOverview() {
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Sections />
        <Row title="Shared knowledge" leading={{ icon: 'book-open' }} navigates onPress={ignore} />
      </ScrollView>
      <HomeTabBar tab="home" onChange={ignore} count={2} bottomInset={0} />
    </View>
  );
}

export function ProjectOverview() {
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text variant="title">Verity</Text>
          <IconButton icon="settings" accessibilityLabel="Project settings" onPress={ignore} />
        </View>
        <FilterChips
          compact
          options={[
            { value: 'now', label: 'Now · 4' },
            { value: 'all', label: 'All' },
            { value: 'favorites', label: 'Favorites', icon: 'star' },
          ]}
          value="now"
          onChange={ignore}
          accessibilityLabel="Filter sessions"
        />
        <Sections project />
        <SectionHeader title="Content" variant="eyebrow" flush />
        <Group>
          <Row title="Wiki" leading={{ icon: 'book-open' }} navigates onPress={ignore} />
          <Row title="Sources" leading={{ icon: 'folder' }} navigates onPress={ignore} />
        </Group>
      </ScrollView>
      <HomeTabBar tab="projects" onChange={ignore} count={2} bottomInset={0} />
    </View>
  );
}

export function DesktopOverview() {
  return (
    <View style={styles.desktop}>
      <View style={styles.sidebar}>
        <HomeOverview />
      </View>
      <View style={styles.session}>
        <View style={styles.sessionHeader}>
          <Text variant="title">Release Checker</Text>
          <Text variant="bodySmall" tone="muted">
            Verity · Agent working
          </Text>
        </View>
        <ScrollView contentContainerStyle={styles.messages}>
          <Card stacked>
            <Text variant="body">Check whether the latest release is available on staging.</Text>
          </Card>
          <Text variant="body">
            The latest release is available on staging. The deployment checks passed.
          </Text>
          <Group>
            <Row
              title="Staging deployment"
              subtitle="All checks passed"
              leading={{ icon: 'check-circle', intent: 'ready' }}
              navigates
              onPress={ignore}
            />
          </Group>
        </ScrollView>
        <View style={styles.composer}>
          <Text variant="body" tone="faint">
            Message this agent…
          </Text>
          <View style={styles.header}>
            <IconButton icon="plus" accessibilityLabel="Add attachment" onPress={ignore} />
            <Text variant="bodySmall" tone="muted">
              Codex gpt-6.1-sol
            </Text>
            <IconButton icon="mic" accessibilityLabel="Voice message" onPress={ignore} />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  desktop: { flex: 1, flexDirection: 'row', backgroundColor: theme.colors.background },
  sidebar: { width: 450, borderRightWidth: 1, borderRightColor: theme.colors.border },
  session: { flex: 1 },
  sessionHeader: {
    padding: theme.spacing.xl,
    gap: theme.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  messages: { padding: theme.spacing.xl, gap: theme.spacing.xl },
  composer: {
    margin: theme.spacing.lg,
    padding: theme.spacing.lg,
    gap: theme.spacing.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.card,
    backgroundColor: theme.colors.surfaceAlt,
  },
}));
