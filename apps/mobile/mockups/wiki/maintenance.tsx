import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { InboxCard } from '../../components/home/HomeInbox';
import { Button, Card, CardHead, Group, Row, SectionHeader, Text } from '../../components/ui';
import { Recommendation } from '../factory-spec/parts';

const ignore = () => undefined;

/**
 * The project page after a maintenance run: the contradiction it could not
 * settle waits for the operator, who discusses it in the maintenance session;
 * the pages it updated are reported below. Design-system gap: the Wiki report
 * needs an inbox item kind of its own; this sample borrows project health.
 */
export default function MaintenanceMockup() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <SectionHeader title="Needs you · 1" />
      <Card stacked>
        <CardHead title="Meeting contradicts the Wiki" subtitle="Wiki maintenance · today 10:42" />
        <View style={styles.compare}>
          <Text variant="footnote" tone="muted">
            Navigation concept says
          </Text>
          <Text variant="bodySmall">Knowledge is one entry under Content.</Text>
          <Text variant="footnote" tone="muted">
            Live meeting 7 Nov says
          </Text>
          <Text variant="bodySmall">Wiki and Sources are listed directly under Content.</Text>
        </View>
        <Recommendation>The meeting is newer and matches the current decision.</Recommendation>
        <View style={styles.actions}>
          <Button label="Discuss with Verity" size="compact" onPress={ignore} />
          <Button label="Open page" size="compact" variant="secondary" onPress={ignore} />
        </View>
      </Card>

      <SectionHeader title="Updates · 1" />
      <InboxCard
        item={{
          key: 'wiki-maintenance',
          kind: 'project_health',
          tag: 'Wiki',
          tone: 'success',
          title: '3 pages updated from Live meeting 7 Nov',
          context: 'Wiki maintenance · today 10:42',
          message:
            'Navigation concept, Live meeting intake and the start page. 1 contradiction to review.',
          actions: [{ kind: 'open_session', label: 'Show changes', sessionId: 'mockup' }],
          at: 0,
        }}
        selected={false}
        pending={false}
        disabled={false}
        onAction={ignore}
      />

      <SectionHeader title="Content" variant="eyebrow" />
      <Group>
        <Row
          leading={{ icon: 'book-open' }}
          title="Wiki"
          subtitle="Maintained knowledge and decisions"
          trailing={
            <Text variant="footnote" tone="muted">
              3 to review
            </Text>
          }
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'paperclip' }}
          title="Sources"
          subtitle="Documents, meeting transcripts and attachments"
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'check-square' }}
          title="Tasks"
          subtitle="4 open"
          navigates
          onPress={ignore}
        />
      </Group>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
  compare: { gap: theme.spacing.xs },
  actions: { flexDirection: 'row', gap: theme.spacing.sm },
}));
