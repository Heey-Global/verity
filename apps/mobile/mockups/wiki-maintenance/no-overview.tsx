import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Card, CardHead, Group, Row, SectionHeader, Text } from '../../components/ui';
import { ignore, InfoHeader } from './parts';
import { AllFiles, Decisions } from './shared';

const PAGES = [
  'Authorization framework audit',
  'Build storage management',
  'Home screen information architecture',
  'Live meeting analysis',
  'Mobile native release recovery',
  'Session loading performance',
];

/**
 * A Wiki with pages but no index.md: the start page is offered above the page
 * list the app shows today, never written on its own.
 */
export default function NoOverviewMockup() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <InfoHeader />
      <Card stacked>
        <CardHead title="99 pages, no overview yet" />
        <Text variant="bodySmall" tone="muted">
          A start page explains the project and groups these pages into topics. Verity asks two
          questions first, reads the pages and names gaps instead of filling them.
        </Text>
        <View style={styles.action}>
          <Button label="Create overview" onPress={ignore} fullWidth />
          <Text variant="footnote" tone="muted" style={styles.center}>
            Opens a session · nothing is written until you confirm
          </Text>
        </View>
      </Card>

      <SectionHeader title="Pages · 99" />
      <Group>
        {PAGES.map((title) => (
          <Row
            key={title}
            leading={{ icon: 'file-text' }}
            title={title}
            subtitle="Engineering report"
            navigates
            onPress={ignore}
          />
        ))}
      </Group>

      <Decisions />
      <AllFiles />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
  action: { gap: theme.spacing.sm, marginTop: theme.spacing.sm },
  center: { textAlign: 'center' },
}));
