import { Stack } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { HeaderTextButton } from '../../components/files/FileSheetHeader';
import { Group, Row, SectionHeader, StatusTag, Text } from '../../components/ui';
import { Link, SessionComposer } from './parts';

const ignore = () => undefined;

/**
 * One Wiki page as reading text: links open pages, decisions and sources in the
 * app. Decisions, Sources and Linked from come from the links between pages and
 * are left out when a page has none. Edit (managers) opens the Markdown as
 * today; the session's composer below asks Verity to make the change across
 * the Wiki.
 */
export default function PageMockup() {
  return (
    <View style={styles.root}>
      <Stack.Screen
        options={{ headerRight: () => <HeaderTextButton label="Edit" onPress={ignore} /> }}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.head}>
          <Text variant="title">Navigation concept</Text>
          <Text variant="footnote" tone="muted">
            Topic · Product concept · updated today
          </Text>
        </View>

        <Text variant="body">
          A project page shows what is happening first and its content below. Content lists the{' '}
          <Link>Wiki</Link>, <Link>Sources</Link>, Tasks and Security; repository, connectors and
          the sandbox live in project settings.
        </Text>
        <Text variant="row">Wiki and Sources</Text>
        <Text variant="body">
          The Wiki holds maintained knowledge; decisions are its first section (
          <Link>Content lists Wiki and Sources directly</Link>). Sources are the originals it is
          built from, such as the <Link>live meeting of 7 November</Link>.
        </Text>
        <Text variant="row">Maintenance</Text>
        <Text variant="body">
          Verity works every new source into the pages it affects and records the change in the{' '}
          <Link>change log</Link>. Contradictions wait under To review.
        </Text>

        <SectionHeader title="Decisions" />
        <Group>
          <Row
            leading={{ icon: 'check-circle' }}
            title="Content lists Wiki and Sources directly"
            subtitle="7 Nov"
            trailing={<StatusTag intent="ready" label="Current" />}
            navigates
            onPress={ignore}
          />
        </Group>

        <SectionHeader title="Sources" />
        <Group>
          <Row
            leading={{ icon: 'mic' }}
            title="Live meeting 7 Nov 2026"
            subtitle="Meeting transcript"
            navigates
            onPress={ignore}
          />
        </Group>

        <SectionHeader title="Linked from · 3" />
        <Group>
          <Row
            leading={{ icon: 'file-text' }}
            title="Assistant and roles concept"
            subtitle="Product concept"
            navigates
            onPress={ignore}
          />
          <Row
            leading={{ icon: 'file-text' }}
            title="Live meeting intake"
            subtitle="Meetings"
            navigates
            onPress={ignore}
          />
          <Row
            leading={{ icon: 'file-text' }}
            title="Design system audit"
            subtitle="Mobile app"
            navigates
            onPress={ignore}
          />
        </Group>
      </ScrollView>
      <View style={styles.composer}>
        <SessionComposer placeholder="Change this page with Verity…" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  composer: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
    backgroundColor: theme.colors.background,
  },
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
  head: { gap: theme.spacing.xs },
}));
