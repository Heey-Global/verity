import { ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { WikiOverview, WikiStatus } from './sections';

/**
 * The Wiki's start page: the overview Verity maintains in index.md, its topics,
 * and the sections the app fills itself (decisions, recent changes, review).
 */
export default function HomeMockup() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <WikiOverview />
      <WikiStatus />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
}));
