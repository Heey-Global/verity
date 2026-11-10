import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { VerityHeader } from '../../components/home/HomeInbox';
import { HomeTabBar } from '../../components/home/HomeTabBar';
import {
  Button,
  Card,
  FilterChips,
  Group,
  IconButton,
  Row,
  SectionHeader,
  StatusTag,
  Text,
  TileMark,
} from '../../components/ui';
const ignore = () => undefined;

/** Sample compositions only. Production classification and screens are unchanged. */
function Sections({ home = false, selected = false }: { home?: boolean; selected?: boolean }) {
  const context = (value: string) => (home ? `verity · ${value}` : value);
  return (
    <>
      <SectionHeader title="Needs you · 1" variant="eyebrow" flush />
      <Group>
        <Row
          title="Project status indicators"
          subtitle={context('Which grouping should we use?')}
          leading={{ dot: 'needsSetup' }}
          tag={<StatusTag intent="needsSetup" label="Question" />}
          navigates
          onPress={ignore}
          answers={
            <View style={styles.actions}>
              <Button label="By next action" size="small" onPress={ignore} />
              <Button label="Own answer" variant="secondary" size="small" onPress={ignore} />
            </View>
          }
        />
      </Group>
      <SectionHeader title="In progress · 2" variant="eyebrow" flush />
      <Group>
        <Row
          title="Agent startup"
          subtitle={context('PR #2432 · CI running')}
          leading={{
            icon: 'git-pull-request',
            quiet: true,
            marks: { bottom: <TileMark tone="action" glyph="loader" /> },
          }}
          onPress={ignore}
        />
        <Row
          title="Docker network analysis"
          subtitle={context('Agent working · CI failed')}
          leading={{
            icon: 'message-square',
            quiet: true,
            marks: {
              top: <TileMark tone="signature" pulsing />,
              bottom: <TileMark tone="attention" glyph="x" />,
            },
          }}
          onPress={ignore}
        />
      </Group>
      <SectionHeader title="Results · 2" variant="eyebrow" flush />
      <Group>
        <Row
          title="Clarify causes"
          subtitle={context('Analysis ready')}
          leading={{
            icon: 'message-square',
            quiet: true,
          }}
          active={selected}
          onPress={ignore}
        />
        <Row
          title="Release notes"
          subtitle={context('Draft ready · Unread')}
          leading={{
            icon: 'message-square',
            quiet: true,
            marks: { top: <TileMark tone="action" /> },
          }}
          onPress={ignore}
        />
      </Group>
    </>
  );
}
function WorkHeader() {
  return (
    <>
      <View style={styles.header}>
        <Text variant="title">verity</Text>
        <IconButton icon="settings" accessibilityLabel="Project settings" onPress={ignore} />
      </View>
      <View style={styles.filters}>
        <FilterChips
          compact
          options={[
            { value: 'now', label: 'Now · 5' },
            { value: 'all', label: 'All' },
            { value: 'favorites', label: 'Favorites', icon: 'star' },
          ]}
          value="now"
          onChange={ignore}
          accessibilityLabel="Filter sessions"
        />
        <IconButton icon="plus" accessibilityLabel="New session" onPress={ignore} />
      </View>
    </>
  );
}
export function HomeGroups() {
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <VerityHeader summary="1 needs you · 2 in progress · 1 new result" />
        <Sections home />
      </ScrollView>
      <HomeTabBar tab="home" onChange={ignore} count={1} bottomInset={0} />
    </View>
  );
}
export function ProjectGroups() {
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <WorkHeader />
        <Sections />
        <SectionHeader title="Content" variant="eyebrow" />
        <Group>
          <Row title="Wiki" leading={{ icon: 'book-open' }} navigates />
          <Row title="Sources" leading={{ icon: 'folder' }} navigates />
        </Group>
      </ScrollView>
      <HomeTabBar tab="projects" onChange={ignore} count={1} bottomInset={0} />
    </View>
  );
}
export function DesktopGroups() {
  return (
    <View style={styles.desktop}>
      <View style={styles.sidebar}>
        <ScrollView contentContainerStyle={styles.content}>
          <VerityHeader summary="1 needs you · 2 in progress · 1 new result" />
          <Sections home selected />
        </ScrollView>
        <HomeTabBar tab="home" onChange={ignore} count={1} bottomInset={0} />
      </View>
      <View style={styles.transcript}>
        <View style={styles.sessionHead}>
          <Text variant="title">Clarify causes</Text>
          <Text variant="bodySmall" tone="muted">
            Codex gpt-6.1-sol · Completed
          </Text>
        </View>
        <ScrollView contentContainerStyle={styles.messages}>
          <Card stacked>
            <Text variant="body">
              Find the cause of the registry timeout and explain how to fix it.
            </Text>
          </Card>
          <Text variant="body">
            The registry is reachable. The timeout came from a stale DNS entry in the sandbox;
            renewing it restored the connection.
          </Text>
          <Row
            title="Diagnostics complete"
            subtitle="DNS renewed · Registry reachable"
            leading={{ icon: 'terminal', intent: 'ready' }}
          />
          <Text variant="body">
            The cause and verification are documented. No further action is needed.
          </Text>
        </ScrollView>
        <View style={styles.composer}>
          <Text variant="body" tone="faint">
            Message this agent…
          </Text>
          <View style={styles.composeActions}>
            <IconButton icon="plus" accessibilityLabel="Add attachment" onPress={ignore} />
            <Text variant="bodySmall" tone="muted">
              Codex gpt-6.1-sol
            </Text>
            <View style={styles.spacer} />
            <IconButton icon="arrow-up" accessibilityLabel="Send message" onPress={ignore} />
          </View>
        </View>
      </View>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  actions: { flexDirection: 'row', gap: theme.spacing.sm, paddingTop: theme.spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  filters: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  desktop: { flex: 1, flexDirection: 'row', backgroundColor: theme.colors.background },
  sidebar: { width: 430, borderRightWidth: 1, borderRightColor: theme.colors.border },
  transcript: { flex: 1 },
  sessionHead: {
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
  composeActions: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
  spacer: { flex: 1 },
}));
