import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Card, Group, Row, SectionHeader, Text } from '../../components/ui';
import { Link, SessionComposer } from '../wiki/parts';
import { ignore, InfoHeader } from './parts';
import { AllFiles, Decisions } from './shared';

/**
 * The start page after setup, in today's order with one change: To review moves
 * up under the overview, since proposals are what the badge leads to. Recently
 * updated names where a change came from (log.md). The composer asks the Wiki.
 */
export function StartPage() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Card stacked>
        <Text variant="body">
          Verity is a self-hosted assistant for small teams. Start with{' '}
          <Link>Verity at a glance</Link>; current choices are under Decisions.
        </Text>
        <Text variant="footnote" tone="muted">
          Start page · updated today
        </Text>
      </Card>

      <SectionHeader title="To review · 3" />
      <Group>
        <Row
          leading={{ icon: 'mic' }}
          title="Update from Live meeting 7 Nov"
          subtitle="3 changes on 2 pages · prepared today"
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'message-circle' }}
          title="Finding from “Fix session crash”"
          subtitle="1 change · from a session card you left open"
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'link-2', intent: 'needsSetup' }}
          title="2 broken links"
          subtitle="Weekly check · Mobile reliability"
          navigates
          onPress={ignore}
        />
      </Group>

      <SectionHeader title="Topics" />
      <Group>
        <Row
          leading={{ icon: 'layers' }}
          title="Verity at a glance"
          subtitle="Idea, users, direction · 3 pages"
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'layers' }}
          title="Home and navigation"
          subtitle="Home, projects, content · 12 pages"
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'layers' }}
          title="Meetings"
          subtitle="Before, during, after · 9 pages"
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'layers' }}
          title="Knowledge and Wiki"
          subtitle="Sources, proposals, decisions · 6 pages"
          navigates
          onPress={ignore}
        />
      </Group>

      <Decisions />

      <SectionHeader title="Recently updated" />
      <Group>
        <Row
          leading={{ icon: 'file-text' }}
          title="Navigation concept"
          subtitle="Today · from Live meeting 7 Nov"
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'file-text' }}
          title="Meetings"
          subtitle="Yesterday · from session “Wiki concept”"
          navigates
          onPress={ignore}
        />
      </Group>

      <AllFiles />
    </ScrollView>
  );
}

export default function StartMockup() {
  return (
    <View style={styles.root}>
      <InfoHeader />
      <StartPage />
      <View style={styles.composer}>
        <SessionComposer placeholder="Ask the Wiki…" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
  composer: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
    backgroundColor: theme.colors.background,
  },
}));
