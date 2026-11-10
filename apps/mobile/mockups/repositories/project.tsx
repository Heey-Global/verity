import { ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Group, Row, SectionHeader, StatusTag } from '../../components/ui';
import { ProjectHeroSample } from './parts';

const ignore = () => undefined;

/**
 * The project page: the description under the name instead of code host and a
 * PR count, and a Repositories row in Content that sums every connected
 * repository's open pull requests as the code host reports them.
 */
export default function ProjectMockup() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <ProjectHeroSample line="Self-hosted AI agent workspace with mobile app" />
      <SectionHeader title="Needs you" variant="eyebrow" />
      <Group>
        <Row
          leading={{ icon: 'message-square' }}
          title="Aufgabenliste Reduzieren"
          subtitle="Claude Opus 5.5 · waiting for your answer"
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'message-square' }}
          title="Stabile Session Sortierung"
          subtitle="Codex gpt-6.1-sol · PR #2394 failing"
          navigates
          onPress={ignore}
        />
      </Group>
      <SectionHeader title="Content" variant="eyebrow" />
      <Group>
        <Row
          leading={{ icon: 'book-open' }}
          title="Wiki"
          subtitle="Maintained knowledge and decisions"
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
          subtitle="4 open · 2 issues"
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'git-pull-request', intent: 'needsSetup' }}
          title="Repositories"
          subtitle="3 repositories · 7 open PRs · 2 failing · 1 conflict"
          trailing={<StatusTag intent="needsSetup" label="3 need you" />}
          navigates
          onPress={ignore}
        />
        <Row
          leading={{ icon: 'shield' }}
          title="Vulnerabilities"
          subtitle="2 packages to update"
          trailing={<StatusTag intent="optional" label="Review" />}
          navigates
          onPress={ignore}
        />
      </Group>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
}));
