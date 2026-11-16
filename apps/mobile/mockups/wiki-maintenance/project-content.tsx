import { ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Group, Row, SectionHeader, StatusTag } from '../../components/ui';
import { CountBadge, ignore } from './parts';

/**
 * The project page's Content: the Wiki row counts the proposals waiting for
 * you. The count is the only signal; there is no push and no Home item.
 */
export default function ProjectContentMockup() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <SectionHeader title="Content" variant="eyebrow" />
      <Group>
        <Row
          leading={{ icon: 'book-open' }}
          title="Wiki"
          subtitle="Maintained knowledge and decisions"
          trailing={<CountBadge count={3} label="proposals to review" />}
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
        <Row
          leading={{ icon: 'shield' }}
          title="Security"
          subtitle="No open findings"
          trailing={<StatusTag intent="ready" label="OK" />}
          navigates
          onPress={ignore}
        />
      </Group>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
}));
