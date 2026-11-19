import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { HomeTabBar } from '../../components/home/HomeTabBar';
import { Card, Group, IconButton, Row, SectionHeader, Text, TileMark } from '../../components/ui';
import { VerityMark } from '../../components/VerityMark';

const ignore = () => undefined;

const working = {
  icon: 'message-square' as const,
  quiet: true,
  marks: { top: <TileMark tone="signature" pulsing /> },
};

/** Home without Verity's header: the list starts with the work. Sample data only. */
export function HomeList({ selected = false }: { selected?: boolean }) {
  return (
    // Room under the last row, so it scrolls clear of the floating V.
    <ScrollView contentContainerStyle={[styles.content, styles.clearOfV]}>
      <SectionHeader title="In progress · 5" variant="eyebrow" flush />
      <Group>
        <Row
          title="Bug: dependency install fails with masked ENOENT path"
          subtitle="Verity · PR #2718 · CI running"
          leading={{
            icon: 'git-pull-request',
            quiet: true,
            marks: { bottom: <TileMark tone="action" glyph="loader" /> },
          }}
          onPress={ignore}
        />
        <Row
          title="Session 9afce35b"
          subtitle="Verity · Agent working"
          leading={working}
          onPress={ignore}
        />
        <Row
          title="Home: Liste der zuletzt genutzten Sessions"
          subtitle="Verity · Agent working"
          leading={working}
          onPress={ignore}
        />
        <Row
          title="Push Blockiert Lint"
          subtitle="Verity · Agent working"
          leading={working}
          onPress={ignore}
        />
        <Row
          title="Cluster Sicherheitsreview"
          subtitle="K8s · Agent working"
          leading={working}
          active={selected}
          onPress={ignore}
        />
      </Group>
      <SectionHeader title="Results · 4" variant="eyebrow" flush />
      <Group>
        <Row
          title="KI Dokumentenmanagement"
          subtitle="Heey Docs · Claude Opus 5.5"
          leading={{
            icon: 'message-square',
            quiet: true,
            marks: { top: <TileMark tone="action" /> },
          }}
          onPress={ignore}
        />
        <Row
          title="MCP-Server Fehler"
          subtitle="Verity · Analysis ready"
          leading={{ icon: 'message-square', quiet: true }}
          onPress={ignore}
        />
        <Row
          title="Release notes"
          subtitle="Website · Draft ready"
          leading={{ icon: 'message-square', quiet: true }}
          onPress={ignore}
        />
      </Group>
      <View style={styles.knowledge}>
        <Group>
          <Row
            title="Shared knowledge"
            subtitle="Reference pages every project reads"
            leading={{ icon: 'globe', quiet: true }}
            navigates
            onPress={ignore}
          />
        </Group>
      </View>
    </ScrollView>
  );
}

/** The floating V as VerityBubble draws it, at its resting place. */
export function FloatingV() {
  return (
    <View style={styles.bubble} pointerEvents="none">
      <VerityMark size={40} glow={false} />
    </View>
  );
}

export function PhoneHome() {
  return (
    <View style={styles.root}>
      <HomeList />
      <HomeTabBar tab="home" onChange={ignore} count={0} bottomInset={0} />
      <FloatingV />
    </View>
  );
}

export function SplitHome() {
  return (
    <View style={styles.root}>
      <View style={styles.desktop}>
        <View style={styles.sidebar}>
          <HomeList selected />
          <HomeTabBar tab="home" onChange={ignore} count={0} bottomInset={0} />
        </View>
        <View style={styles.transcript}>
          <View style={styles.sessionHead}>
            <Text variant="title">Cluster Sicherheitsreview</Text>
            <Text variant="bodySmall" tone="muted">
              Claude Fable 5.2 · Agent working
            </Text>
          </View>
          <ScrollView contentContainerStyle={styles.messages}>
            <Card stacked>
              <Text variant="body">merged</Text>
            </Card>
            <Text variant="body">
              Ich prüfe den Merge und ob das Release mit der Datei schon gebaut ist.
            </Text>
            <Row
              title="Ran"
              subtitle="gh pr view · gh run list"
              leading={{ icon: 'terminal', intent: 'ready' }}
            />
            <Text variant="body">
              Gemergt um 21:46 UTC, das API-Release läuft gerade. Während es baut, bereite ich Teil
              2 im k8s-Repo vor.
            </Text>
          </ScrollView>
          <View style={styles.composer}>
            <Text variant="body" tone="faint">
              Message this agent…
            </Text>
            <View style={styles.composeActions}>
              <IconButton icon="plus" accessibilityLabel="Add attachment" onPress={ignore} />
              <Text variant="bodySmall" tone="muted">
                Claude Fable 5.2
              </Text>
              <View style={styles.spacer} />
              <IconButton icon="square" accessibilityLabel="Stop agent" onPress={ignore} />
            </View>
          </View>
        </View>
      </View>
      <FloatingV />
    </View>
  );
}

const BUBBLE = 52;

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
  knowledge: { paddingTop: theme.spacing.xl },
  clearOfV: { paddingBottom: 96 },
  desktop: { flex: 1, flexDirection: 'row' },
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
  bubble: {
    position: 'absolute',
    right: theme.spacing.lg,
    bottom: 96,
    width: BUBBLE,
    height: BUBBLE,
    borderRadius: BUBBLE / 2,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    justifyContent: 'center',
    alignItems: 'center',
    ...theme.elevation.floating,
  },
}));
